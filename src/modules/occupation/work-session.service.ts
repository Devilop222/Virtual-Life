import { PlayerActivityState, WorkSession, WorkSessionType } from '@prisma/client'
import {
  WorkSessionRepository,
  isActiveSessionConflict
} from '../../database/repositories/work-session.repository'
import { PlayerRepository } from '../../database/repositories/player.repository'
import { PlayerSkillRepository } from '../../database/repositories/player-skill.repository'
import { SkillRepository } from '../../database/repositories/skill.repository'
import { PART_TIME_JOBS, shiftFatigueRatePerRealMinute } from './work-blueprints'
import { CRITICAL_FATIGUE_THRESHOLD, shiftDueDecision, type WorkStopReason } from './work-due'
import { IncomeCalculationService } from './income-calculation.service'
import { JobCapacityService } from './job-market.service'
import { ConflictError, NotFoundError, ValidationError } from '../../utils/classes/errors'
import { PlayerStateMachine } from '../identity/player-state-machine'
import { SALARY_MINUTES_PER_DAY } from './payroll-math'
import { logger } from '../../utils/logger'
import { degreeOrder, educationRankOf } from '../education/education-blueprints'
import { effectiveAge } from '../lifecycle/game-calendar'
import { incomeTaxOf } from '../../config/economy'
import { formatGameMinutes, gameMinutesSince, ratePerGameMinute } from '../../utils/game-time'
import { MAX_FATIGUE, canWorkWithBody, payableShiftMinutes } from '../life/life-core'
import { resolveMaxHealth } from '../health/max-health'
import type { PrismaClient } from '@prisma/client'

/**
 * حداقل داده‌ای که تسویهٔ یک شیفت از بازیکن لازم دارد.
 * همهٔ فیلدها اختیاری‌اند تا مسیرهای سبک/تست‌ها بدون دادهٔ کامل هم عدد
 * منطقی بدهند (نبود داده = وضعیت خنثی، نه جریمه).
 */
interface SessionPlayer {
  id: string
  experience?: number
  fatigue?: number
  health?: number
  currentDegree?: string | null
  graduationField?: string | null
  age?: number
  startedAt?: Date | null
}

/**
 * سقفِ تعداد شیفتی که یک چرخهٔ خودکار تسویه می‌کند.
 *
 * عدد عمداً کوچک است: هر تسویه یک تراکنش است و یک انفجارِ شیفتِ رهاشده (مثلاً
 * بعد از چند روز خاموشی) نباید همهٔ Connection‌های دیتابیس را در یک چرخه بگیرد.
 * چرخهٔ بعدی بقیه را برمی‌دارد و چون تسویه‌ها Idempotent هستند، هیچ شیفتی جا
 * نمی‌ماند — فقط چند تیک طول می‌کشد.
 */
export const WORK_SWEEP_BATCH = 25

/** نتیجهٔ تسویهٔ خودکار یک شیفت — دادهٔ لازم برای اعلان به بازیکن. */
export interface AutoSettledShift {
  /** شناسهٔ شیفت — کلیدِ ضدتکرارِ اعلان از همین ساخته می‌شود. */
  sessionId: string
  playerId: string
  jobTitle: string
  workplaceName: string | null
  reason: WorkStopReason | null
  elapsedGameMinutes: number
  netPaid: number
  fatigueGained: number
}

export class WorkSessionService {
  /** آستانهٔ مشترک در `work-due` تعریف شده تا چرخهٔ خودکار هم همان را ببیند. */
  readonly criticalFatigueThreshold = CRITICAL_FATIGUE_THRESHOLD

  constructor(
    private readonly workSessionRepository: WorkSessionRepository,
    private readonly playerRepository: PlayerRepository,
    private readonly incomeCalculationService: IncomeCalculationService,
    private readonly jobCapacityService: JobCapacityService,
    private readonly playerSkillRepository?: PlayerSkillRepository,
    private readonly skillRepository?: SkillRepository,
    /** برای خواندن سقف واقعی سلامت (عضو باشگاه ۱۲۰) بدون کوئری اضافه. */
    private readonly db?: PrismaClient
  ) {}

  /**
   * محاسبهٔ درآمد نشست، با دو قانون بازدارنده:
   *  • سقف خستگی — فقط دقیقه‌هایی پول داده می‌شود که واقعاً توان body بوده‌اند:
   *    با خستگی f و نرخ r، حداکثر (100−f)/r دقیقهٔ مشمول مزد؛ پس «یک‌شنبه
   *    بازگذاشتنِ شیفت» دیگر ماشین پول‌سازی نیست و پنل باید تمدید/استراحت شود.
   *  • ضریب مهارت — مهارت‌های مرتبطِ ثبت‌شده تا ۱۰٪ به‌ازای هر سطح اضافه می‌کنند.
   */
  private async calculateForSession(
    session: {
      id: string
      playerId: string
      jobKey: string
      payPerMinute: { toString: () => string }
      startedAt: Date
    },
    player: SessionPlayer
  ) {
    const jobDef = PART_TIME_JOBS.find((j) => j.key === session.jobKey)
    // مدت شیفت روی ساعت بازی شمرده می‌شود (هر دقیقهٔ واقعی ۳۰ دقیقهٔ بازی است) و
    // نرخ خستگی هم به «هر دقیقهٔ بازی» ترجمه می‌شود؛ پس خستگی و مزد به‌ازای هر
    // دقیقهٔ واقعیِ کار دقیقاً همان قبلی می‌ماند.
    const elapsedMinutes = gameMinutesSince(session.startedAt)
    // نرخِ **خامِ** دقیقهٔ واقعی (واحدِ Blueprint). تبدیل به دقیقهٔ بازی دقیقاً
    // یک‌بار انجام می‌شود؛ تبدیلِ دوباره خستگیِ ثبت‌شده را بی‌صدا ۳۰ برابر کم
    // می‌کرد («+۱٪» برای یک شیفت سنگین) و هیچ شیفتی به مرز بدنی نمی‌رسید.
    const fatigueRatePerRealMinute = shiftFatigueRatePerRealMinute(session.jobKey)
    const { payableMinutes, bodyCapacityReached } = payableShiftMinutes({
      elapsedGameMinutes: elapsedMinutes,
      fatigue: player.fatigue ?? 0,
      fatiguePerGameMinute: ratePerGameMinute(fatigueRatePerRealMinute)
    })
    const fatigueCapped = bodyCapacityReached

    const skillLevelAverage = await this.playerSkillRepository
      ?.averageLevelForSkillNames(session.playerId, jobDef?.requiredSkills)
      .catch(() => undefined)

    // سقف واقعی سلامت: عضو باشگاه ۱۲۰ است و ضریب سلامت درصدی حساب می‌شود،
    // پس بدون این مقدار عضو باشگاه با ۱۰۰ از ۱۲۰ «کاملاً سالم» شمرده می‌شد.
    const maxHealth = this.db
      ? await resolveMaxHealth(this.db, player.id).catch(() => undefined)
      : undefined

    const calculation = this.incomeCalculationService.calculatePartTimeIncome(
      {
        basePayPerMinute: Number(session.payPerMinute),
        difficulty: jobDef?.difficulty ?? 1,
        skillLevelAverage,
        playerExperience: player.experience ?? 0,
        educationRank: educationRankOf(player.currentDegree),
        // رشتهٔ تحصیلی و دستهٔ شغل هر دو داده می‌شوند تا هم‌حوزه بودنِ رشته
        // واقعاً روی دستمزد اثر بگذارد (پیش‌تر رشته فقط یک برچسب بود).
        graduationField: player.graduationField ?? null,
        jobCategory: jobDef?.category ?? null,
        // سن با تقویم بازی خوانده می‌شود — همان منبعی که شرط سنی شغل می‌خواند.
        age: effectiveAge(player.startedAt ?? null, player.age ?? 18),
        elapsedMinutes: payableMinutes,
        health: player.health ?? 100,
        fatigue: player.fatigue ?? 0,
        maxHealth
      },
      jobDef?.healthDrainPerMinute ?? 0.1,
      fatigueRatePerRealMinute,
      jobDef?.experienceRatePerMinute ?? 0.2
    )

    return { jobDef, elapsedMinutes, payableMinutes, fatigueCapped, calculation }
  }

  async startPartTimeWork(telegramUserId: bigint, jobKey: string) {
    const player = await this.playerRepository.findByTelegramUserId(telegramUserId)
    if (!player) {
      throw new NotFoundError('Player not found')
    }

    PlayerStateMachine.assertCanStartActivity(
      player.status,
      player.activityState,
      PlayerActivityState.WORKING
    )

    const jobDef = PART_TIME_JOBS.find((j) => j.key === jobKey)
    if (!jobDef) {
      throw new NotFoundError('Job definition not found', 'شغل موردنظر یافت نشد. در گروه «کار» را بفرست و از فهرست فعلی انتخاب کن.')
    }

    // شرط سنی با تقویم بازی سنجیده می‌شود (هر هفته یک سال)
    const gameAge = effectiveAge(player.startedAt, player.age)
    if (gameAge < jobDef.minimumAge) {
      throw new ConflictError(
        'Minimum age requirement',
        `حداقل سن برای این شغل ${jobDef.minimumAge} سال است.`
      )
    }

    const playerDegreeRank = educationRankOf(player.currentDegree as string | null)
    if (jobDef.requiredEducation && playerDegreeRank < degreeOrder[jobDef.requiredEducation]) {
      throw new ValidationError(
        'Education requirement not met',
        'این شغل به مدرک بالاتری نیاز دارد؛ اول تحصیلاتت را ارتقا بده.'
      )
    }

    if ((jobDef.minExperience ?? 0) > player.experience) {
      throw new ValidationError(
        'Experience requirement not met',
        `این شغل به حداقل ${jobDef.minExperience} سابقه نیاز دارد؛ اول تجربه جمع کن.`
      )
    }

    if (!canWorkWithBody(player.health, player.fatigue)) {
      if (player.fatigue >= MAX_FATIGUE) {
        throw new ConflictError(
          'Exhausted',
          'خستگی‌ات کامل است؛ اول استراحت کن، بعد سراغ شیفت تازه شو.'
        )
      }
      throw new ConflictError(
        'Health too low',
        'سلامت‌ات خیلی پایین است؛ اول به درمانگاه سر بزن، بعد برگرد سر کار.'
      )
    }

    const slotTaken = await this.jobCapacityService.takeSlot(jobDef.key)
    if (!slotTaken) {
      throw new ConflictError(
        'Job is full',
        'ظرفیت این شغل پر شده؛ کمی بعد دوباره تلاش کن.'
      )
    }

    try {
      return await this.workSessionRepository.startSession({
        playerId: player.id,
        jobKey: jobDef.key,
        jobTitle: jobDef.name,
        sessionType: WorkSessionType.PART_TIME,
        payPerMinute: jobDef.basePayPerMinute
      })
    } catch (error) {
      // ظرفیت باید هر آزاد شود، چه خطای ما باشد چه نقضِ شاخصِ یکتا
      await this.jobCapacityService.releaseSlot(jobDef.key)
      if (isActiveSessionConflict(error)) {
        throw new ConflictError(
          'Already working',
          'همین حالا یک شیفت کاری فعال داری؛ اول آن را تمام کن یا «پایان کار» را بزن.'
        )
      }
      throw error
    }
  }

  /**
   * شروع شیفت در «محل کار»: کسب‌وکار کارفرما، یا کسب‌وکار خودِ بازیکن.
   *
   * تفاوت اساسی با کار پاره‌وقت: این شیفت **پول نمی‌دهد**. کارکردش ثبت
   * می‌شود و حقوق در تسویهٔ کسب‌وکار (PayrollService) بر پایهٔ همان کارکرد
   * پرداخت می‌گردد. اگر اینجا هم مستقیم پول می‌داد، دستمزد دو بار حساب
   * می‌شد: یک‌بار به‌ازای هر دقیقهٔ شیفت و یک‌بار در تسویه.
   *
   * خستگی و فرسودگی و تجربه مثل هر کار دیگری حساب می‌شوند — کارِ واقعی
   * هزینهٔ بدنی دارد، حتی وقتی دستمزدش را کارفرما می‌دهد.
   */
  async startWorkplaceShift(telegramUserId: bigint) {
    const player = await this.playerRepository.findByTelegramUserId(telegramUserId)
    if (!player) {
      throw new NotFoundError('Player not found')
    }

    PlayerStateMachine.assertCanStartActivity(
      player.status,
      player.activityState,
      PlayerActivityState.WORKING
    )

    const workplace = await this.workSessionRepository.findWorkplace(player.id)
    if (!workplace) {
      throw new ConflictError(
        'No workplace',
        'محل کارِ فعالی نداری. اول از آگهی‌ها استخدام شو یا کسب‌وکار خودت را راه بینداز.'
      )
    }

    if (!canWorkWithBody(player.health, player.fatigue)) {
      if (player.fatigue >= MAX_FATIGUE) {
        throw new ConflictError(
          'Exhausted',
          'خستگی‌ات کامل است؛ اول استراحت کن، بعد سراغ شیفت تازه شو.'
        )
      }
      throw new ConflictError(
        'Health too low',
        'سلامت‌ات خیلی پایین است؛ اول به درمانگاه سر بزن، بعد برگرد سر کار.'
      )
    }

    // سقفِ اجباریِ قرارداد: کارمند تا وقتی حجمِ ماهانهٔ توافق‌شده را پر نکرده
    // اجازهٔ شیفت دارد. کارِ فراتر از قرارداد پرداخت نمی‌شود، پس اجازه‌دادن به
    // آن فقط کارِ بی‌مزد است — همان‌جا جلویش گرفته می‌شود. مالک کسب‌وکار قرارداد
    // ندارد و سقفش روی خودِ سودِ کسب‌وکار است، نه حجمِ کار.
    const contract = workplace.contractMinutesPerMonth
    if (!workplace.isOwner && typeof contract === 'number' && Number.isFinite(contract)) {
      const remaining = contract - (workplace.workedMinutesThisMonth ?? 0)
      if (remaining <= 0) {
        throw new ConflictError(
          'Monthly contract volume reached',
          `حجم قراردادِ این ماه را پر کرده‌ای (${formatGameMinutes(contract)}). حقوقت را در تسویهٔ کارفرما بگیر و ماه بعد دوباره سر کار بیا.`
        )
      }
    }

    try {
      const session = await this.workSessionRepository.startSession({
        playerId: player.id,
        jobKey: `business:${workplace.businessId}`,
        jobTitle: workplace.isOwner ? `کسب‌وکار خودم — ${workplace.title}` : workplace.title,
        sessionType: WorkSessionType.FULL_TIME,
        businessId: workplace.businessId,
        payPerMinute: workplace.payPerMinute
      })
      return { session, workplace }
    } catch (error) {
      if (isActiveSessionConflict(error)) {
        throw new ConflictError(
          'Already working',
          'همین حالا یک شیفت کاری فعال داری؛ اول آن را تمام کن یا «پایان کار» را بزن.'
        )
      }
      throw error
    }
  }

  /** محل کارِ فعلی بازیکن — فقط برای تصمیمِ نمایشیِ پنل کار. */
  async getWorkplace(telegramUserId: bigint) {
    const player = await this.playerRepository.findByTelegramUserId(telegramUserId)
    if (!player) {
      return null
    }
    return this.workSessionRepository.findWorkplace(player.id)
  }

  async getActiveSessionStatus(telegramUserId: bigint) {
    const player = await this.playerRepository.findByTelegramUserId(telegramUserId)
    if (!player) {
      throw new NotFoundError('Player not found')
    }

    const session = await this.workSessionRepository.findActiveSession(player.id)
    if (!session) {
      return null
    }

    const { calculation, payableMinutes, fatigueCapped } = await this.calculateForSession(
      session,
      player
    )
    // مالیات بر درآمد «در مبدأ» کسر می‌شود؛ پنل باید همان عددی را نشان دهد
    // که واقعاً به کیف پول می‌رود، پس ناخالص/مالیات/خالص هر سه برمی‌گردند.
    const workplaceShift =
      session.sessionType === WorkSessionType.FULL_TIME && session.businessId !== null
    const tax = workplaceShift ? 0 : incomeTaxOf(calculation.totalEarnedMoney)
    return {
      session,
      calculation,
      payableMinutes,
      fatigueCapped,
      workplaceShift,
      tax,
      net: workplaceShift ? 0 : calculation.totalEarnedMoney - tax
    }
  }

  async stopWork(telegramUserId: bigint) {
    const player = await this.playerRepository.findByTelegramUserId(telegramUserId)
    if (!player) {
      throw new NotFoundError('Player not found')
    }

    const session = await this.workSessionRepository.findActiveSession(player.id)
    if (!session) {
      throw new ConflictError('No active work session', 'الان مشغول به کاری نیستی.')
    }

    return this.settleSession(session, player)
  }

  /**
   * تسویهٔ یک شیفت و ثبت نتیجهٔ آن — تنها مسیرِ پایان کار.
   *
   * چرا یک مسیر؟ پایانِ دستی (`stopWork`)، توقفِ خودکار در پنل و چرخهٔ خودکار
   * سرور (`settleDueSessions`) هر سه باید دقیقاً یک چیز کنند: همان پول، همان
   * خستگی، همان شرطِ سقفِ قرارداد. سه نسخه از این کد یعنی سه اقتصاد.
   *
   * هم‌زمانی با نوشتارِ شرطیِ `endSession` مهار می‌شود: اگر دو مسیر هم‌زمان
   * همین شیفت را بگیرند، فقط یکی واقعاً پول می‌دهد و دیگری خطا می‌گیرد (خطایی
   * که فراخوانِ خودکار بی‌صدا رد می‌کند).
   */
  private async settleSession(session: WorkSession, player: SessionPlayer) {
    const { jobDef, calculation, payableMinutes, fatigueCapped } = await this.calculateForSession(
      session,
      player
    )

    // شیفتِ محل کار پول نقد نمی‌دهد (حقوق در تسویهٔ کسب‌وکار می‌آید) و صندلیِ
    // آگهی هم اشغال نکرده، پس نه پرداختی دارد و نه ظرفیتی برای آزاد کردن.
    const workplaceShift =
      session.sessionType === WorkSessionType.FULL_TIME && session.businessId !== null

    const updatedSession = await this.workSessionRepository.endSession(session.id, {
      earnedMoney: workplaceShift ? 0 : calculation.totalEarnedMoney,
      earnedExp: calculation.earnedExperience,
      healthDrain: calculation.healthDrain,
      fatigueGained: calculation.fatigueGained
    })

    if (!workplaceShift) {
      await this.jobCapacityService.releaseSlot(session.jobKey)
    }

    // تمرین عملی: کارِ مرتبط، مهارت می‌سازد (بهترین‌تلاش؛ خطایش شیفت را نمی‌سوزاند)
    void this.practiceSkills(player.id, jobDef?.requiredSkills, payableMinutes)

    // همان تابع خالصی که مخزن هنگام کسر مالیات استفاده می‌کند (منبع واحد نرخ)
    const tax = incomeTaxOf(calculation.totalEarnedMoney)

    // پنلِ پایان شیفت این عدد را با پول قاطی نکند: در شیفتِ محل کار، دستمزدِ
    // اینجا صفر است و تنها چیزی که «دستاورد» شمرده می‌شود کارکردِ ثبت‌شده است.
    const workedGameMinutes = Math.min(payableMinutes, SALARY_MINUTES_PER_DAY)

    return {
      session: updatedSession,
      workplace: workplaceShift
        ? { businessId: session.businessId!, workedMinutes: workedGameMinutes }
        : null,
      summary: {
        ...calculation,
        totalEarnedMoney: workplaceShift ? 0 : calculation.totalEarnedMoney,
        fatigueCapped,
        tax: workplaceShift ? 0 : tax,
        net: workplaceShift ? 0 : calculation.totalEarnedMoney - tax
      }
    }
  }

  /** رشد مهارت پس از پایان شیفت — شکستش هیچ‌وقت تسویه را عقب نمی‌اندازد. */
  private async practiceSkills(
    playerId: string,
    requiredSkills: string[] | undefined,
    minutes: number
  ): Promise<void> {
    if (!this.playerSkillRepository || !this.skillRepository) {
      return
    }
    if (!requiredSkills || requiredSkills.length === 0) {
      return
    }
    try {
      // یک Query برای همهٔ مهارت‌ها؛ حلقهٔ قبلی به‌ازای هر مهارت یک Query می‌زد
      const idByName = await this.skillRepository.findIdsByNames(requiredSkills)
      const ids = requiredSkills
        .map((name) => idByName.get(name))
        .filter((id): id is string => id !== undefined)
      await this.playerSkillRepository.addPracticePoints(playerId, ids, Math.floor(minutes))
    } catch {
      // بی‌صدا — تمرین اختیاری است
    }
  }

  /**
   * توقف خودکار کار در پاسخ به تعاملِ بازیکن (پنل/فرمان).
   *
   * این مسیر هست چون بازیکنی که خودش سر می‌زند نباید تا تیکِ بعدیِ سرور منتظر
   * بماند؛ ولی **تنها** مسیر توقف نیست: `settleDueSessions` همان قاعده را برای
   * همهٔ شیفت‌های رهاشده اجرا می‌کند. تصمیم از `work-due` می‌آید تا هر دو مسیر
   * یک جواب بدهند.
   */
  async autoStopIfCriticallyFatigued(telegramUserId: bigint) {
    const player = await this.playerRepository.findByTelegramUserId(telegramUserId)
    if (!player || player.activityState !== PlayerActivityState.WORKING) {
      return null
    }

    const session = await this.workSessionRepository.findActiveSession(player.id)
    if (!session) {
      return null
    }

    if (!this.isSessionDue(session, player.fatigue ?? 0)) {
      return null
    }

    return this.settleSession(session, player)
  }

  /** تصمیمِ مشترکِ «باید بایستد؟» روی یک شیفت. */
  private isSessionDue(session: WorkSession, fatigue: number): boolean {
    return shiftDueDecision({
      startedAt: session.startedAt,
      fatigue,
      fatiguePerRealMinute: shiftFatigueRatePerRealMinute(session.jobKey),
      criticalThreshold: this.criticalFatigueThreshold
    }).due
  }

  /**
   * پردازش خودکار شیفت‌های رهاشده — قلبِ «ربات فقط وقتی پنل باز می‌شود
   * نمی‌فهمد اتفاقی افتاده».
   *
   * پیش از این، تنها راهِ پایانِ یک شیفت این بود که خودِ بازیکن کاری بکند یا
   * پنلی را باز کند. یعنی کسی که کار را شروع می‌کرد و می‌رفت، شیفتش ساعت‌ها
   * ACTIVE می‌ماند: خستگی‌اش هرگز به مرز نمی‌رسید، مزدش پرداخت نمی‌شد و شیفتِ
   * باز، شاخصِ یکتای «یک شیفتِ فعال در هر بازیکن» را اشغال می‌کرد و او را از
   * هر کار تازه محروم می‌کرد.
   *
   * سه ویژگی که این حلقه باید داشته باشد و دارد:
   *  • **پایدار برای ری‌استارت:** مدت از `startedAt` و زمانِ الان حساب می‌شود،
   *    نه از تیک‌های سپری‌شده. پس خاموشیِ سرور هیچ کاری را گم نمی‌کند.
   *  • **ضدتکرار:** تسویه از `endSession`ِ شرطی رد می‌شود؛ اجرای دوبارهٔ چرخه
   *    برای همان شیفت، خطا می‌گیرد و چیزی پرداخت نمی‌شود.
   *  • **محدود:** هر بار فقط یک بستهٔ کوچک و قدیمی‌ترین‌ها اول.
   *
   * @returns شیفت‌هایی که همین حالا واقعاً تسویه شدند (برای اعلان).
   */
  async settleDueSessions(limit: number = WORK_SWEEP_BATCH): Promise<AutoSettledShift[]> {
    const candidates = await this.workSessionRepository.findActiveSessionsForSweep(limit)
    const settled: AutoSettledShift[] = []

    for (const { session, player } of candidates) {
      if (!this.isSessionDue(session, player.fatigue ?? 0)) {
        continue
      }
      try {
        const result = await this.settleSession(session, player)
        settled.push({
          sessionId: session.id,
          playerId: session.playerId,
          jobTitle: result.session.jobTitle,
          workplaceName: result.workplace ? result.session.jobTitle : null,
          reason: shiftDueDecision({
            startedAt: session.startedAt,
            fatigue: player.fatigue ?? 0,
            fatiguePerRealMinute: shiftFatigueRatePerRealMinute(session.jobKey),
            criticalThreshold: this.criticalFatigueThreshold
          }).reason,
          elapsedGameMinutes: result.summary.elapsedMinutes,
          netPaid: result.summary.net,
          fatigueGained: result.summary.fatigueGained
        })
      } catch (error) {
        // شیفتِ دیگری (بازیکن یا تیکِ قبلی) آن را تسویه کرده است؛ داده‌اش
        // ممکن است پس از نوشتنِ شیفت خراب باشد. چرخه هرگز نباید با یک ردیفِ
        // بد بشکند و بقیهٔ شیفت‌ها را رها کند.
        logger.warn({ err: error, sessionId: session.id }, 'autonomous work settlement skipped')
      }
    }

    return settled
  }
}
