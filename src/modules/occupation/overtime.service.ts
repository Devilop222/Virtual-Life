import { GameEventType, PrismaClient, TransactionType } from '@prisma/client'
import { PART_TIME_JOBS } from './work-blueprints'
import { educationRankOf } from '../education/education-blueprints'
import { PlayerSkillRepository } from '../../database/repositories/player-skill.repository'
import { ConflictError, NotFoundError } from '../../utils/classes/errors'
import { EventService } from '../events/event.service'
import { incomeCalculationService } from './income-calculation.service'
import { MAX_FATIGUE, MIN_HEALTH, canWorkWithBody, conditionFactor } from '../life/life-core'
import { effectiveAge } from '../lifecycle/game-calendar'
import { playtimeMinutes, realMinutesAsGameMinutes } from '../../utils/game-time'
import { resolveMaxHealth } from '../health/max-health'
import { TaxService } from '../economy/tax.service'

/** مدت اضافه‌کاری (دقیقه). */
/**
 * طول هر اضافه‌کاری: ۱۰ دقیقه — و چون مزد روی ساعت بازی حساب می‌شود، همان
 * ۱۰ دقیقه در تقویم بازی ۳۰۰ دقیقه (۵ ساعت بازی) است.
 */
const OVERTIME_MINUTES = 10
/** همان بازه، بیان‌شده در دقیقهٔ بازی (واحد دستمزد و خستگی). */
const OVERTIME_GAME_MINUTES = realMinutesAsGameMinutes(OVERTIME_MINUTES)
/** ضریب دستمزد اضافه‌کاری. */
const OVERTIME_PAY_MULTIPLIER = 1.5
/** ضریب خستگی و فرسودگی اضافه‌کاری. */
const OVERTIME_FATIGUE_MULTIPLIER = 2
const OVERTIME_HEALTH_MULTIPLIER = 2
/**
 * فاصلهٔ حداقلی بین دو اضافه‌کاری (۳۰ دقیقهٔ واقعی).
 * این یک بازهٔ «ریتم بازی‌باز» است — برای کنترل سرعت کار در دنیای واقعی، نه
 * یک رخدادِ تقویم بازی؛ پس از `playtimeMinutes` ساخته می‌شود.
 */
const COOLDOWN_MS = playtimeMinutes(30)

export interface OvertimeResult {
  jobTitle: string
  minutes: number
  /** مبلغ خالصی که به کیف پول واریز شد. */
  earned: number
  /** دستمزد ناخالص پیش از مالیات (برای نمایش صادقانهٔ فیش). */
  grossEarned?: number
  /** مالیات کسرشدهٔ همان پرداخت. */
  tax?: number
  fatigueAdded: number
  healthLost: number
  /** ضریب توان بدنیِ اعمال‌شده — همان چیزی که دستمزد را کم کرد. */
  conditionFactor?: number
  cooldownRemainingMin?: number
  skipped?: boolean
}

/**
 * اضافه‌کاری هوشمند.
 *
 * قواعد:
 *  • فقط با Session کاری فعال
 *  • دستمزد = همان فرمول استاندارد پاره‌وقت (مهارت/تجربه/مدرک/سختی)
 *    از IncomeCalculationService مشترک، با ضریب ۱٫۵ روی مبلغ نهایی
 *  • خستگی و فرسایش سلامت ۲ برابر — ریسک واقعی
 *  • هر ۳۰ دقیقه یک بار؛ Idempotent با شرط روی lastOvertimeAt
 *  • پرداخت فوری به موجودی (بدون دخالت در محاسبهٔ Session اصلی → بدون Double Pay)
 */
export class OvertimeService {
  constructor(
    private readonly db: PrismaClient,
    private readonly eventService: EventService,
    private readonly playerSkillRepository?: PlayerSkillRepository
  ) {}

  async startOvertime(telegramUserId: bigint): Promise<OvertimeResult> {
    const { result, playerId } = await this.db.$transaction(async (tx) => {
      const player = await tx.player.findUnique({
        where: { telegramUserId },
        select: {
          id: true,
          balance: true,
          health: true,
          fatigue: true,
          experience: true,
          currentDegree: true,
          graduationField: true,
          age: true,
          startedAt: true,
          activityState: true,
          lastOvertimeAt: true
        }
      })
      if (!player) {
        throw new NotFoundError('Player not found')
      }
      if (player.activityState !== 'WORKING') {
        throw new ConflictError(
          'Not working',
          'برای اضافه‌کاری اول باید در یک شغل مشغول به کار باشی.'
        )
      }

      // اضافه‌کاری با بدنِ ازکارافتاده ممنوع است — همان قاعدهٔ شروع کار.
      // پیش‌تر این در وجود نداشت و بازیکن با سلامت ۱ هم اضافه‌کاری می‌گرفت.
      if (!canWorkWithBody(player.health, player.fatigue)) {
        throw new ConflictError(
          'Body not ready for overtime',
          player.fatigue >= MAX_FATIGUE
            ? 'خستگی‌ات کامل است؛ اضافه‌کاری فایده‌ای ندارد. اول استراحت کن.'
            : 'سلامت‌ات برای اضافه‌کاری کافی نیست؛ اول به درمانگاه سر بزن.'
        )
      }

      if (player.lastOvertimeAt) {
        const since = Date.now() - player.lastOvertimeAt.getTime()
        if (since < COOLDOWN_MS) {
          const remaining = Math.ceil((COOLDOWN_MS - since) / 60000)
          throw new ConflictError(
            'Overtime cooldown',
            `بین دو اضافه‌کاری باید استراحت کنی. ${remaining.toLocaleString('fa-IR')} دقیقهٔ دیگر آماده می‌شوی.`
          )
        }
      }

      const session = await tx.workSession.findFirst({
        where: { playerId: player.id, status: 'ACTIVE' }
      })
      if (!session) {
        throw new ConflictError(
          'No active session',
          'شیفت کاری فعالی پیدا نشد. اول کار را شروع کن.'
        )
      }

      const jobDef = this.resolveJob(session.jobKey)
      if (!jobDef) {
        // شیفتِ محل کار شغلِ بازار نیست و مزدش فوری نیست؛ اضافه‌کاری اینجا یعنی
        // پرداختِ نقدی بیرون از حساب تسویهٔ کارفرما.
        throw new ConflictError(
          'Overtime unavailable',
          'اضافه‌کاری برای کار پاره‌وقت است. در شیفت محل کار، کارکردت در تسویهٔ کارفرما حساب می‌شود.'
        )
      }

      // قفل خوش‌بینانه روی lastOvertimeAt: جلوگیری از اجرای دوباره همزمان
      const claimed = await tx.player.updateMany({
        where: { id: player.id, lastOvertimeAt: player.lastOvertimeAt },
        data: { lastOvertimeAt: new Date() }
      })
      if (claimed.count !== 1) {
        // قفل را درخواستِ دیگری برده: نه پرداختی بوده و نه رخدادی ثبت می‌شود
        return {
          playerId: null,
          result: {
            jobTitle: session.jobTitle,
            minutes: 0,
            earned: 0,
            fatigueAdded: 0,
            healthLost: 0,
            skipped: true
          }
        }
      }

      // همان فرمول استاندارد درآمد پاره‌وقت — مهارت/تجربه/مدرک/رشته/سن/توان
      // بدنی — از سرویس محاسبهٔ مشترک (منبع واحد فرمول)، و فقط ضریب ۱٫۵ روی
      // مبلغ نهایی. پیش‌تر سلامت و خستگی اینجا پاس داده نمی‌شدند، یعنی
      // اضافه‌کاری تنها مسیر کاری بود که «بهره‌وری» در آن هیچ اثری نداشت.
      const skillLevelAverage = await this.playerSkillRepository
        ?.averageLevelForSkillNames(player.id, jobDef.requiredSkills)
        .catch(() => undefined)
      const maxHealth = await resolveMaxHealth(tx, player.id).catch(() => undefined)
      const { totalEarnedMoney, conditionFactor: appliedCondition } =
        incomeCalculationService.calculatePartTimeIncome(
          {
            basePayPerMinute: Number(session.payPerMinute),
            difficulty: jobDef.difficulty,
            skillLevelAverage,
            playerExperience: player.experience,
            educationRank: educationRankOf(player.currentDegree),
            graduationField: player.graduationField,
            jobCategory: jobDef.category,
            age: effectiveAge(player.startedAt, player.age),
            elapsedMinutes: OVERTIME_GAME_MINUTES,
            health: player.health,
            fatigue: player.fatigue,
            maxHealth
          },
          jobDef.healthDrainPerMinute,
          jobDef.fatigueRatePerMinute,
          jobDef.experienceRatePerMinute
        )
      const earned = Math.round(totalEarnedMoney * OVERTIME_PAY_MULTIPLIER)

      const fatigueRate = jobDef.fatigueRatePerMinute * OVERTIME_FATIGUE_MULTIPLIER
      const fatigueAdded = Math.min(
        MAX_FATIGUE - player.fatigue,
        Math.round(fatigueRate * OVERTIME_MINUTES)
      )
      // کف سلامت همان کفِ تسویهٔ شیفت است؛ اضافه‌کاری بازیکن را به صفر
      // («فوت‌شده» روی پنل) نمی‌رساند.
      const healthLost = Math.min(
        Math.max(0, player.health - MIN_HEALTH),
        Math.round(jobDef.healthDrainPerMinute * OVERTIME_MINUTES * OVERTIME_HEALTH_MULTIPLIER)
      )

      // مالیات بر درآمد اضافه‌کاری هم در مبدأ کسر می‌شود؛ دستمزد ناخالص در
      // دفتر کل می‌ماند و بازیکن خالص را می‌گیرد (همان قاعدهٔ شیفت عادی).
      const taxed = await new TaxService().withholdIncomeTax(tx, {
        playerId: player.id,
        gross: earned,
        reference: `اضافه‌کاری ${jobDef.name}`
      })

      await tx.player.update({
        where: { id: player.id },
        data: {
          balance: { increment: taxed.net },
          experience: { increment: Math.round(jobDef.experienceRatePerMinute * OVERTIME_MINUTES) },
          fatigue: { increment: fatigueAdded },
          health: { decrement: healthLost }
        }
      })

      await tx.financialTransaction.create({
        data: {
          amount: earned,
          type: TransactionType.SALARY_PAYMENT,
          destinationPlayerId: player.id,
          reference: `اضافه‌کاری — ${jobDef.name}`
        }
      })

      const paid: OvertimeResult = {
        jobTitle: session.jobTitle,
        minutes: OVERTIME_MINUTES,
        earned: taxed.net,
        grossEarned: earned,
        tax: taxed.tax,
        fatigueAdded,
        healthLost,
        conditionFactor: appliedCondition
      }

      return { playerId: player.id, result: paid }
    })

    // رخدادِ خوراک بیرون از تراکنشِ پرداخت ثبت می‌شود: پول همین‌جا قطعی شده است،
    // پس یک ردیفِ خبری نباید وسطِ تراکنش با کانکسیونی دیگر نوشته شود (و اگر
    // تراکنش برگشت، ردیفِ بازمانده از آن بیرون نماند).
    if (playerId) {
      this.eventService
        .recordPlayerEvent({
          playerId,
          type: GameEventType.OVERTIME_WORKED,
          title: `اضافه‌کاری در ${result.jobTitle}`,
          detail: `${OVERTIME_MINUTES} دقیقه`,
          amount: result.grossEarned ?? result.earned
        })
        .catch(() => {})
    }

    return result
  }

  /** وضعیت آمادگی اضافه‌کاری برای نمایش در پنل. */
  async getOvertimeStatus(telegramUserId: bigint): Promise<{
    available: boolean
    cooldownRemainingMin: number
    /** ضریب توان بدنیِ فعلی — تا پنل صادقانه بگوید اضافه‌کاری چقدر می‌ارزد. */
    conditionFactor: number
  }> {
    const player = await this.db.player.findUnique({
      where: { telegramUserId },
      select: { activityState: true, lastOvertimeAt: true, health: true, fatigue: true }
    })
    if (!player || player.activityState !== 'WORKING') {
      return { available: false, cooldownRemainingMin: 0, conditionFactor: 1 }
    }

    const condition = conditionFactor(player.health, player.fatigue)
    const ready = canWorkWithBody(player.health, player.fatigue)

    if (player.lastOvertimeAt) {
      const since = Date.now() - player.lastOvertimeAt.getTime()
      if (since < COOLDOWN_MS) {
        return {
          available: false,
          cooldownRemainingMin: Math.ceil((COOLDOWN_MS - since) / 60000),
          conditionFactor: condition
        }
      }
    }
    return { available: ready, cooldownRemainingMin: 0, conditionFactor: condition }
  }

  private resolveJob(jobKey: string) {
    return PART_TIME_JOBS.find((j) => j.key === jobKey) ?? null
  }
}
