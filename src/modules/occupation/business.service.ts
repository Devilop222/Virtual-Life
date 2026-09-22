import { BusinessRepository } from '../../database/repositories/business.repository'
import { PlayerRepository } from '../../database/repositories/player.repository'
import {
  BUSINESS_BLUEPRINTS,
  BusinessBlueprint,
  MAX_ACTIVE_BUSINESSES_PER_OWNER
} from './work-blueprints'
import { ConflictError, NotFoundError, ValidationError } from '../../utils/classes/errors'
import { PayrollService } from './payroll.service'
import { PlayerStateMachine } from '../identity/player-state-machine'
import { degreeOrder, DegreeLevel, educationRankOf } from '../education/education-blueprints'
import { effectiveAge } from '../lifecycle/game-calendar'
import {
  MAX_CONTRACT_GAME_HOURS_PER_MONTH,
  MIN_CONTRACT_GAME_HOURS_PER_MONTH,
  contractMinutesFromGameHours,
  contractValue,
  minutesSince,
  remainingContractMinutes,
  salaryAnchorAt,
  salaryMinutes
} from './payroll-math'
import { ratePerGameHour, ratePerGameMinute } from '../../utils/game-time'
import { JobPostingStatus } from '@prisma/client'
import type { NotificationType } from '@prisma/client'
import type { NotificationLevel } from '../notification/push'
import { money } from '../../utils/format'

/** بندهای آگهی استخدام (تومان در دقیقهٔ رسمی، هم‌راستا با ساعت کاری ۸ ساعته). */
export const POST_SALARY_MIN = 100
export const POST_SALARY_MAX = 3_000
export const POST_CAPACITY_MAX = 20
const DEGREE_NAMES: readonly string[] = [
  DegreeLevel.DIPLOMA,
  DegreeLevel.ASSOCIATE,
  DegreeLevel.BACHELOR,
  DegreeLevel.MASTER,
  DegreeLevel.DOCTORATE
]

/** فارسیِ نامقابل‌درجه برای پیام‌ها. */
const DEGREE_FA: Record<string, string> = {
  DIPLOMA: 'دیپلم',
  ASSOCIATE: 'کاردانی',
  BACHELOR: 'کارشناسی',
  MASTER: 'کارشناسی ارشد',
  DOCTORATE: 'دکتری'
}

export interface PostJobInput {
  title: string
  salaryPerMinute: number
  capacity: number
  minExperience: number
  minAge: number | null
  maxAge: number | null
  requiredDegree: string | null
  requiredSkill: string | null
  /** حجمِ قراردادِ ماهانه، در واحدی که کارفرما می‌فهمد: ساعت بازی در ماه. */
  contractGameHoursPerMonth?: number
}

export class BusinessService {
  constructor(
    private readonly businessRepository: BusinessRepository,
    private readonly playerRepository: PlayerRepository,
    private readonly payrollService: PayrollService,
    private readonly notificationService?: {
      notifyPlayerById: (
        playerId: string,
        title: string,
        message: string,
        type?: NotificationType,
        dedupeKey?: string,
        level?: NotificationLevel
      ) => Promise<boolean>
    }
  ) {}

  /**
   * اعلانِ نتیجهٔ درخواستِ کار.
   *
   * پیش از این هیچ خبری به متقاضی نمی‌رسید: استخدام می‌شد یا رد، و فقط با
   * باز کردنِ پنل می‌فهمید. نتیجهٔ درخواست یکی از رخدادهایی است که بازیکن
   * منتظرش است، پس به چت خصوصی‌اش می‌رود.
   */
  private async notifyApplicationOutcome(
    applicationId: string,
    outcome: 'hired' | 'rejected',
    reason?: string,
    dedupeSuffix = ''
  ): Promise<void> {
    if (!this.notificationService) return
    let notice: Awaited<ReturnType<BusinessRepository['findApplicationNotice']>>
    try {
      notice = await this.businessRepository.findApplicationNotice(applicationId)
    } catch {
      // اعلان یک اثرِ جانبی است: هرگز نباید عملیاتِ اصلی را بشکند.
      return
    }
    if (!notice) return
    const title =
      outcome === 'hired' ? '🎉 درخواستِ کارت پذیرفته شد' : '📕 درخواستِ کارت رد شد'
    const message =
      outcome === 'hired'
        ? `«${notice.businessName}» تو را برای «${notice.title}» با حقوق ${money(
            ratePerGameHour(Number(notice.salaryPerMinute ?? 0))
          )} در ساعت بازی استخدام کرد. از پنل «کار» وضعیت شغلت را ببین.`
        : reason
          ? `«${notice.businessName}» درخواستِ تو برای «${notice.title}» را رد کرد — ${reason}`
          : `«${notice.businessName}» درخواستِ تو برای «${notice.title}» را رد کرد. از «جست‌وجوی شغل» آگهی‌های باز دیگر را ببین.`
    await this.notificationService
      .notifyPlayerById(
        notice.applicantPlayerId,
        title,
        message,
        undefined,
        `job-${outcome}:${notice.applicantPlayerId}:${notice.businessName}:${notice.title}${dedupeSuffix}`,
        outcome === 'hired' ? 'CRITICAL' : 'IMPORTANT'
      )
      .catch(() => undefined)
  }

  getBlueprints(): readonly BusinessBlueprint[] {
    return BUSINESS_BLUEPRINTS
  }

  async createBusiness(telegramUserId: bigint, modelType: string, name: string) {
    const player = await this.playerRepository.findByTelegramUserId(telegramUserId)
    if (!player) {
      throw new NotFoundError('Player not found')
    }

    if (player.status === 'DEAD') {
      throw new ConflictError('Player is dead', 'شخصیت فوت‌شده امکان تأسیس شرکت را ندارد.')
    }

    const blueprint = BUSINESS_BLUEPRINTS.find((b) => b.modelType === modelType)
    if (!blueprint) {
      throw new NotFoundError('Business blueprint not found', 'مدل کسب‌وکار موردنظر یافت نشد.')
    }

    if (Number(player.balance) < blueprint.startupCost) {
      throw new ValidationError(
        'Insufficient capital',
        `سرمایه‌ات برای راه‌اندازی این کسب‌وکار کافی نیست. نیاز به ${blueprint.startupCost.toLocaleString('fa-IR')} تومان داری.`
      )
    }

    if (player.experience < blueprint.requiredExperience) {
      throw new ValidationError(
        'Insufficient experience',
        `تجربهٔ کاری‌ات برای این کسب‌وکار کافی نیست. حداقل سابقه: ${blueprint.requiredExperience}`
      )
    }

    if (blueprint.requiredSocialLevel) {
      const rankOf = (l: string | null): number => {
        const order: Record<string, number> = { LOW: 1, MIDDLE: 2, HIGH: 3, ELITE: 4 }
        return order[l ?? 'LOW'] ?? 1
      }
      const need = rankOf(blueprint.requiredSocialLevel)
      const have = rankOf(player.socialLevel as string | null)
      if (have < need) {
        throw new ValidationError(
          'Social level too low',
          `برای تأسیس «${blueprint.title}» باید سطح اجتماعی «${blueprint.requiredSocialLevel}» داشته باشی.`
        )
      }
    }

    // یک بازیکن همزمان حداکثر ۳ کسب‌وکارِ فعال می‌تواند داشته باشد (جلوی انحصار).
    // گارد نهایی و اتمیک در مخزن و داخل همان تراکنش تأسیس است؛ این بررسی
    // فقط برای دادن پیام زودتر و واضح‌تر است.
    const activeCount = await this.businessRepository.countActiveByOwner(player.id)
    if (activeCount >= MAX_ACTIVE_BUSINESSES_PER_OWNER) {
      throw new ConflictError(
        'Business limit reached',
        `هر بازیکن فقط تا ${MAX_ACTIVE_BUSINESSES_PER_OWNER} کسب‌وکارِ فعال می‌تواند داشته باشد؛ یکی را تعطیل کن.`
      )
    }

    const business = await this.businessRepository.createBusinessWithStartupCost({
      ownerId: player.id,
      name,
      category: blueprint.category,
      modelType: blueprint.modelType,
      startupCost: blueprint.startupCost,
      employeeCapacity: blueprint.baseCapacity,
      baseRevenuePerMinute: blueprint.baseRevenuePerMinute,
      operatingCostPerMinute: blueprint.operatingCostPerMinute
    })

    // موجودی پس از تأسیس برای پنل نتیجه؛ بازیکن نباید برای دیدنِ مانده‌اش
    // پنل دیگری باز کند.
    const balanceAfter = Number(player.balance) - blueprint.startupCost
    return { business, balanceAfter, startupCost: blueprint.startupCost }
  }

  async listOwnerBusinesses(telegramUserId: bigint) {
    const player = await this.playerRepository.findByTelegramUserId(telegramUserId)
    if (!player) {
      throw new NotFoundError('Player not found')
    }

    return this.businessRepository.listByOwner(player.id)
  }

  /** مالکیت + فعال‌بودن کسب‌وکار (شرط مشترک همه عملیات مدیریتی). */
  private async requireOwnedActiveBusiness(telegramUserId: bigint, businessId: string) {
    const player = await this.playerRepository.findByTelegramUserId(telegramUserId)
    if (!player) {
      throw new NotFoundError('Player not found')
    }
    const business = await this.businessRepository.findById(businessId)
    if (!business || business.ownerId !== player.id) {
      throw new ConflictError('Access denied to business', 'این کسب‌وکار متعلق به تو نیست. از «کسب‌وکار» شرکت خودت را انتخاب کن.')
    }
    if (business.status !== 'ACTIVE') {
      throw new ConflictError('Business not active', 'این کسب‌وکار فعال نیست.')
    }
    return { player, business }
  }

  /**
   * ثبت آگهی استخدام با اعتبارسنجی کامل شرایط — همهٔ محدودیت‌ها سمت سرور.
   */
  async postJob(telegramUserId: bigint, businessId: string, input: PostJobInput) {
    const { business } = await this.requireOwnedActiveBusiness(telegramUserId, businessId)

    const title = (input.title ?? '').trim()
    if (title.length < 3 || title.length > 40) {
      throw new ValidationError('Invalid title', 'عنوان شغل باید بین ۳ تا ۴۰ نویسه باشد.')
    }
    if (
      !Number.isSafeInteger(input.salaryPerMinute) ||
      input.salaryPerMinute < POST_SALARY_MIN ||
      input.salaryPerMinute > POST_SALARY_MAX
    ) {
      throw new ValidationError(
        'Invalid salary',
        `حقوق باید عددی بین ${money(ratePerGameHour(POST_SALARY_MIN))} تا ${money(ratePerGameHour(POST_SALARY_MAX))} تومان در ساعت بازی باشد.`
      )
    }
    if (
      !Number.isSafeInteger(input.capacity) ||
      input.capacity < 1 ||
      input.capacity > POST_CAPACITY_MAX ||
      input.capacity > business.employeeCapacity
    ) {
      throw new ValidationError(
        'Invalid capacity',
        `ظرفیت آگهی باید بین ۱ و ${Math.min(POST_CAPACITY_MAX, business.employeeCapacity)} (ظرفیت کسب‌وکار) باشد.`
      )
    }
    if (
      !Number.isSafeInteger(input.minExperience) ||
      input.minExperience < 0 ||
      input.minExperience > 5_000
    ) {
      throw new ValidationError(
        'Invalid experience',
        'حداقل سابقه باید بین ۰ تا ۵۰۰۰ باشد.'
      )
    }
    let minAge: number | null = null
    let maxAge: number | null = null
    if (input.minAge !== null || input.maxAge !== null) {
      minAge = input.minAge ?? 18
      maxAge = input.maxAge ?? 100
      if (!Number.isSafeInteger(minAge) || !Number.isSafeInteger(maxAge)) {
        throw new ValidationError('Invalid age bounds', 'محدوده سنی باید عدد صحیح باشد.')
      }
      if (minAge < 18 || maxAge > 100 || minAge > maxAge) {
        throw new ValidationError(
          'Invalid age bounds',
          'محدوده سنی باید در بازه ۱۸ تا ۱۰۰ باشد و کفِ سن از سقف بیشتر نباشد.'
        )
      }
    }
    if (input.requiredDegree !== null && !DEGREE_NAMES.includes(input.requiredDegree)) {
      throw new ValidationError('Invalid degree', 'مدرک خواسته‌شده در فهرست تحصیلات نیست.')
    }
    const requiredSkill = (input.requiredSkill ?? '').trim()
    if (requiredSkill.length > 30) {
      throw new ValidationError('Invalid skill text', 'نام مهارت خیلی بلند است.')
    }
    // حجمِ قرارداد: کارفرما برحسب «ساعت بازی در ماهِ بازی» می‌نویسد و آگهی
    // همان را به استخدامی که از آن می‌آید منتقل می‌کند. سقف پایین و بالا گارد
    // است؛ قرارداد نه می‌تواند تشریفاتی باشد و نه بیش از توانِ یک انسان.
    const contractGameHours =
      input.contractGameHoursPerMonth ?? MAX_CONTRACT_GAME_HOURS_PER_MONTH
    if (
      !Number.isSafeInteger(contractGameHours) ||
      contractGameHours < MIN_CONTRACT_GAME_HOURS_PER_MONTH ||
      contractGameHours > MAX_CONTRACT_GAME_HOURS_PER_MONTH
    ) {
      throw new ValidationError(
        'Invalid contract volume',
        `حجم کار باید بین ${MIN_CONTRACT_GAME_HOURS_PER_MONTH} تا ${MAX_CONTRACT_GAME_HOURS_PER_MONTH} ساعت بازی در ماه باشد.`
      )
    }

    return this.businessRepository.createJobPosting({
      businessId,
      title,
      salaryPerMinute: input.salaryPerMinute,
      capacity: input.capacity,
      minExperience: input.minExperience,
      minAge,
      maxAge,
      requiredDegree: (input.requiredDegree as DegreeLevel | null) ?? DegreeLevel.DIPLOMA,
      requiredSkill: requiredSkill.length > 0 ? requiredSkill : null,
      requiredField: null,
      contractMinutesPerMonth: contractMinutesFromGameHours(contractGameHours)
    })
  }

  async listOpenJobs(page = 1) {
    return this.businessRepository.listOpenJobPostings(page, 8)
  }

  async getJobPosting(jobPostingId: string) {
    const posting = await this.businessRepository.getJobPosting(jobPostingId)
    if (!posting) {
      throw new NotFoundError('Posting not found', 'این آگهی دیگر وجود ندارد. فهرست آگهی‌ها را به‌روزرسانی کن.')
    }
    return posting
  }

  /**
   * واجد شرایط بودن برای آگهی — سن، مدرک و سابقه سخت‌گیرانه‌اند؛
   * مهارت فقط نمایش داده می‌شود (بدون قفل مهارتی).
   *
   * سن با تقویم بازی خوانده می‌شود (هر هفتهٔ واقعی یک سال) — همان منبعی که
   * شرط سنی کار پاره‌وقت می‌خواند؛ وگرنه بازیکنی که سال‌ها بازی کرده در
   * آگهی‌ها همیشه همان سنِ ثبت‌نام دیده می‌شد.
   */
  private eligibilityProblems(
    player: { age: number; startedAt: Date | null; experience: number; currentDegree: string | null },
    posting: {
      minAge: number | null
      maxAge: number | null
      minExperience: number
      requiredDegree: string
    }
  ): string[] {
    const gameAge = effectiveAge(player.startedAt, player.age)
    const problems: string[] = []
    if (posting.minAge !== null && gameAge < posting.minAge) {
      problems.push(`حداقل سن این شغل ${posting.minAge} سال است`)
    }
    if (posting.maxAge !== null && gameAge > posting.maxAge) {
      problems.push(`سقف سن این شغل ${posting.maxAge} سال است`)
    }
    if (
      educationRankOf(player.currentDegree) <
      (degreeOrder[posting.requiredDegree as DegreeLevel] ?? 1)
    ) {
      problems.push(`حداقل مدرک: ${DEGREE_FA[posting.requiredDegree] ?? posting.requiredDegree}`)
    }
    if (player.experience < posting.minExperience) {
      problems.push(`حداقل سابقه: ${posting.minExperience}`)
    }
    return problems
  }

  async applyForJob(telegramUserId: bigint, jobPostingId: string) {
    const player = await this.playerRepository.findByTelegramUserId(telegramUserId)
    if (!player) {
      throw new NotFoundError('Player not found')
    }

    if (player.status === 'DEAD') {
      throw new ConflictError('Player is dead', 'شخصیت فوت‌شده امکان ارسال درخواست استخدام ندارد.')
    }

    const posting = await this.businessRepository.getJobPosting(jobPostingId)
    if (!posting || posting.status !== JobPostingStatus.OPEN) {
      throw new ConflictError('Posting closed', 'این آگهی دیگر باز نیست. از بخش «کار» فرصت‌های استخدام فعلی را ببین.')
    }
    if (posting.business.status !== 'ACTIVE') {
      throw new ConflictError('Business not active', 'این کسب‌وکار فعال نیست.')
    }
    if (posting.hiredCount >= posting.capacity) {
      throw new ConflictError('Posting full', 'ظرفیت این آگهی پر شده است.')
    }

    const problems = this.eligibilityProblems(player, posting)
    if (problems.length > 0) {
      throw new ValidationError('Not eligible', `شرایط این آگهی را نداری: ${problems.join('؛ ')}.`)
    }

    return this.businessRepository.applyForJob(jobPostingId, player.id)
  }

  /** شناسهٔ کسب‌وکارِ یک درخواست (برای بازکردن پنل درست پس از پذیرش/رد). */
  async getApplicationBusinessId(applicationId: string): Promise<string> {
    const application = await this.businessRepository.findApplicationWithBusiness(applicationId)
    if (!application) {
      throw new NotFoundError('Application not found', 'درخواست موردنظر یافت نشد. فهرست درخواست‌ها را به‌روزرسانی کن.')
    }
    return application.jobPosting.businessId
  }

  /** درخواست‌های بازِ خودِ بازیکن + وضعیت تک‌اشغالی. */
  async listMyApplications(telegramUserId: bigint) {
    const player = await this.playerRepository.findByTelegramUserId(telegramUserId)
    if (!player) {
      throw new NotFoundError('Player not found')
    }
    return this.businessRepository.listMyOpenApplications(player.id)
  }

  async withdrawApplication(telegramUserId: bigint, applicationId: string) {
    const player = await this.playerRepository.findByTelegramUserId(telegramUserId)
    if (!player) {
      throw new NotFoundError('Player not found')
    }
    return this.businessRepository.withdrawApplication(player.id, applicationId)
  }

  async listApplications(telegramUserId: bigint, businessId: string) {
    await this.requireOwnedActiveBusiness(telegramUserId, businessId)
    return this.businessRepository.listApplicationsForBusiness(businessId)
  }

  /** آگهی‌های بازِ یک کسب‌وکار — مالکیت و وضعیت فعال در گاردِ سرویس. */
  async listOpenPostings(telegramUserId: bigint, businessId: string) {
    await this.requireOwnedActiveBusiness(telegramUserId, businessId)
    return this.businessRepository.listOpenPostingsForBusiness(businessId)
  }

  async closePosting(telegramUserId: bigint, businessId: string, postingId: string) {
    await this.requireOwnedActiveBusiness(telegramUserId, businessId)
    return this.businessRepository.closeJobPosting(businessId, postingId)
  }

  /**
   * پذیرش درخواست — گاردهای ظرفیت و تک‌اشغالی درون تراکنش repository است.
   * واجدی‌سنجی دوباره همین‌جا انجام می‌شود (بین درخواست و پذیرش ممکن است
   * شرایط بازیکن تغییر کرده باشد).
   */
  async hireEmployee(telegramUserId: bigint, applicationId: string) {
    const player = await this.playerRepository.findByTelegramUserId(telegramUserId)
    if (!player) {
      throw new NotFoundError('Player not found')
    }

    const application = await this.businessRepository.findApplicationWithBusiness(applicationId)
    if (!application || application.jobPosting.business.ownerId !== player.id) {
      throw new ConflictError(
        'Access denied to application',
        'برای بررسی این درخواست دسترسی نداری. فقط مالک کسب‌وکار می‌تواند دربارهٔ استخدام تصمیم بگیرد.'
      )
    }

    if (application.status !== 'PENDING') {
      throw new ConflictError('Application handled', 'این درخواست پیش‌تر بررسی شده است.')
    }

    // بازسنجی شرایط متقاضی در لحظهٔ پذیرش (بین درخواست و پذیرش ممکن است
    // شرایط عوض شده باشد — مثلاً به‌یکدیگر‌جا استخدام شده باشد)
    const applicant = await this.businessRepository.findPlayerProfile(application.playerId)
    if (!applicant) {
      throw new NotFoundError('Applicant not found', 'بازیکنِ درخواست‌دهنده یافت نشد.')
    }
    const problems = this.eligibilityProblems(applicant, application.jobPosting)
    if (problems.length > 0) {
      await this.businessRepository.rejectApplication(player.id, applicationId)
      // ردِ خودکار هم برای متقاضی خبر دارد؛ وگرنه بی‌خبر در انتظار می‌ماند.
      void this.notifyApplicationOutcome(
        applicationId,
        'rejected',
        problems.join('؛ '),
        ':auto'
      ).catch(() => undefined)
      throw new ValidationError(
        'Applicant not eligible',
        `این متقاضی دیگر شرایط آگهی را ندارد: ${problems.join('؛ ')}.`
      )
    }

    const employment = await this.businessRepository.hireEmployee(applicationId, player.id)
    void this.notifyApplicationOutcome(applicationId, 'hired').catch(() => undefined)
    return employment
  }

  /** ردّ درخواست توسط مالک. */
  async rejectApplication(telegramUserId: bigint, applicationId: string) {
    const player = await this.playerRepository.findByTelegramUserId(telegramUserId)
    if (!player) {
      throw new NotFoundError('Player not found')
    }
    const result = await this.businessRepository.rejectApplication(player.id, applicationId)
    void this.notifyApplicationOutcome(applicationId, 'rejected').catch(() => undefined)
    return result
  }

  /** استعفای کارمند با تسویهٔ همان‌لحظه‌ای. */
  async resign(telegramUserId: bigint, employmentId: string) {
    const player = await this.playerRepository.findByTelegramUserId(telegramUserId)
    if (!player) {
      throw new NotFoundError('Player not found')
    }
    const result = await this.businessRepository.resignEmployee(player.id, employmentId)
    // کارفرما یک نیرو از دست داده و ظرفیت تیمش آزاد شده؛ باید بداند.
    if (result.ownerPlayerId !== player.id) {
      void this.notificationService
        ?.notifyPlayerById(
          result.ownerPlayerId,
          '👋 یک کارمند استعفا داد',
          `${player.firstName} از «${result.title}» در ${result.businessName} استعفا داد. ` +
            (result.unpaid > 0
              ? `${money(result.unpaid)} حقوقِ معوق به‌عنوان بدهی باقی ماند.`
              : 'حقوقش کامل تسویه شد.'),
          undefined,
          `job-resigned:${employmentId}`,
          'IMPORTANT'
        )
        .catch(() => undefined)
    }
    return result
  }

  /** اخراج توسط مالک با تسویهٔ همان‌لحظه‌ای. */
  async fireEmployee(telegramUserId: bigint, businessId: string, employeePlayerId: string) {
    const player = await this.playerRepository.findByTelegramUserId(telegramUserId)
    if (!player) {
      throw new NotFoundError('Player not found')
    }
    const notice = await this.businessRepository.findEmployeeNotice(businessId, employeePlayerId)
    const result = await this.businessRepository.fireEmployee(
      player.id,
      businessId,
      employeePlayerId
    )
    // اخراج‌شده باید بداند: درآمدش قطع شده و دیگر در آن تیم نیست.
    if (notice) {
      void this.notificationService
        ?.notifyPlayerById(
          employeePlayerId,
          '🚪 همکاری پایان یافت',
          `«${notice.businessName}» همکاریِ تو در «${notice.title}» را پایان داد. ` +
            (result.paid > 0
              ? `${money(result.paid)} حقوقِ معوق به کیف پولت واریز شد`
              : 'حقوقِ معوقی برای تسویه نبود') +
            (result.unpaid > 0
              ? `؛ ${money(result.unpaid)} به‌عنوان بدهیِ حقوقی باقی ماند.`
              : '.'),
          undefined,
          `job-fired:${businessId}:${employeePlayerId}:${Date.now()}`,
          'CRITICAL'
        )
        .catch(() => undefined)
    }
    return result
  }

  /** آگهی + ایراداتِ متقاضی + وضعیت درخواست قبلی‌اش (یکجا برای پنل جزئیات). */
  async getPostingForPlayer(telegramUserId: bigint, jobPostingId: string) {
    const player = await this.playerRepository.findByTelegramUserId(telegramUserId)
    if (!player) {
      throw new NotFoundError('Player not found')
    }
    const posting = await this.businessRepository.getJobPosting(jobPostingId)
    if (!posting) {
      throw new NotFoundError('Posting not found', 'این آگهی دیگر وجود ندارد. فهرست آگهی‌ها را به‌روزرسانی کن.')
    }
    const problems =
      posting.status === JobPostingStatus.OPEN && posting.business.status === 'ACTIVE'
        ? this.eligibilityProblems(player, posting)
        : ['این آگهی باز نیست. فهرست درخواست‌های استخدام را به‌روزرسانی کن.']
    const applicationStatus = await this.businessRepository.findApplicationStatus(
      player.id,
      jobPostingId
    )
    return { posting, problems, applicationStatus }
  }

  /** فهرست کارمندان فعال یک کسب‌وکار برای پنل مالک. */
  async listEmployees(telegramUserId: bigint, businessId: string) {
    const { business } = await this.requireOwnedActiveBusiness(telegramUserId, businessId)
    return business.employees
      .filter((e) => e.isActive)
      .map((e) => ({
        playerId: e.playerId,
        name: `${e.player.firstName} ${e.player.lastName ?? ''}`.trim(),
        title: e.title,
        salaryPerMinute: Number(e.salaryPerMinute),
        unpaidSalary: Number(e.unpaidSalary),
        contractMinutesPerMonth: e.contractMinutesPerMonth,
        // سقفِ ماهانهٔ همین کارمند با همین نرخ — کارفرما باید بداند واقعاً
        // چقدر می‌پردازد، نه اینکه فقط نرخ ساعتی را ببیند.
        monthlyCeiling: contractValue(Number(e.salaryPerMinute), e.contractMinutesPerMonth)
      }))
  }

  /**
   * پنل «شغل من»: شغل‌های فعال + کارکردِ ثبت‌شده از آخرین تسویه + حقوقی که
   * همان کارکرد ساخته (بدون نوشتن در دیتابیس؛ نمایشی است).
   *
   * دو اصلاح در همین عدد: کارکردِ واقعی جای «زمانِ گذشته» را گرفت، و نرخ
   * از `ratePerGameMinute` گذشت — پیش‌تر نرخِ «در دقیقهٔ واقعی» مستقیم در
   * دقیقهٔ بازی ضرب می‌شد و پنل حقوقی ۳۰ برابر واقعیت نشان می‌داد.
   */
  async getMyJobView(telegramUserId: bigint) {
    const player = await this.playerRepository.findByTelegramUserId(telegramUserId)
    if (!player) {
      throw new NotFoundError('Player not found')
    }
    const employments = await this.businessRepository.listActiveEmployments(player.id)
    return Promise.all(
      employments.map(async (row) => {
        const anchor = salaryAnchorAt(row.business.lastPayrollAt, row)
        const workedMinutes = await this.businessRepository.workedMinutesFor(
          row.business.id,
          row.playerId,
          anchor
        )
        // پیشرفتِ قرارداد از مرزِ **ماهِ بازی** شمرده می‌شود، نه از آخرین تسویه؛
        // سقف ماهانه است و همان چیزی که کارمند را از شیفت تازه محروم می‌کند.
        const workedThisMonth = await this.businessRepository.workedMinutesThisMonth(
          row.business.id,
          row.playerId
        )
        // کارکردِ پیش از همین بازه = ماه تا امروز منهای کارکردِ همین بازه؛
        // همان تعریفی که تسویهٔ واقعی دارد، پس پنل و دیتابیس یک عدد می‌دهند.
        const priorMinutes = Math.max(0, workedThisMonth - workedMinutes)
        const paidMinutes = Math.min(
          workedMinutes,
          salaryMinutes(minutesSince(anchor)),
          remainingContractMinutes(row.contractMinutesPerMonth, priorMinutes)
        )
        const accrued = Math.round(
          ratePerGameMinute(Number(row.salaryPerMinute)) * paidMinutes
        )
        const unpaid = Math.round(Number(row.unpaidSalary))
        return {
          id: row.id,
          businessId: row.business.id,
          businessName: row.business.name,
          title: row.title,
          salaryPerMinute: Number(row.salaryPerMinute),
          contractMinutesPerMonth: row.contractMinutesPerMonth,
          workedMinutes,
          workedMinutesThisMonth: workedThisMonth,
          remainingMinutesThisMonth: remainingContractMinutes(
            row.contractMinutesPerMonth,
            workedThisMonth
          ),
          accrued,
          unpaid,
          staffed: row.business.activeEmployees,
          capacity: row.business.employeeCapacity,
          hiredAt: row.hiredAt
        }
      })
    )
  }

  async setEmployeeSalary(
    telegramUserId: bigint,
    businessId: string,
    employeePlayerId: string,
    newSalaryPerMinute: number
  ) {
    const player = await this.playerRepository.findByTelegramUserId(telegramUserId)
    if (!player) {
      throw new NotFoundError('Player not found')
    }

    const business = await this.businessRepository.findById(businessId)
    if (!business || business.ownerId !== player.id) {
      throw new ConflictError('Access denied', 'برای تغییر حقوق دسترسی نداری. حقوق را مالک کسب‌وکار از پنل شرکت تنظیم می‌کند.')
    }

    const currentEmp = business.employees.find((e) => e.playerId === employeePlayerId)
    if (!currentEmp) {
      throw new NotFoundError('Employee not found', 'کارمند موردنظر در این شرکت یافت نشد. فهرست کارکنان را به‌روزرسانی کن.')
    }

    PlayerStateMachine.validateSalaryAdjustment(
      Number(currentEmp.salaryPerMinute),
      newSalaryPerMinute,
      POST_SALARY_MIN,
      POST_SALARY_MAX
    )

    const updated = await this.businessRepository.updateEmployeeSalary(
      businessId,
      employeePlayerId,
      newSalaryPerMinute
    )
    // نتیجهٔ انسانی برای پنل مالک و اعلان کارمند
    return {
      salaryPerMinute: Number(updated.salaryPerMinute),
      employeeName: `${currentEmp.player.firstName} ${currentEmp.player.lastName ?? ''}`.trim(),
      businessName: business.name
    }
  }

  /**
   * تغییر حجمِ قراردادِ یک کارمند (تنها مالک).
   *
   * حجم برحسب «ساعت بازی در ماهِ بازی» گرفته می‌شود — همان واحدی که کارفرما
   * در پنل می‌بیند — و فقط همین‌جا به واحد ذخیره‌سازی ترجمه می‌گردد. کاهش حجم
   * کارکردِ ثبت‌شدهٔ قبلی را پاک نمی‌کند؛ فقط سقفِ پرداختِ پیشِ رو را جمع‌تر
   * می‌کند.
   */
  async setEmployeeContract(
    telegramUserId: bigint,
    businessId: string,
    employeePlayerId: string,
    contractGameHoursPerMonth: number
  ) {
    const { business } = await this.requireOwnedActiveBusiness(telegramUserId, businessId)

    const employee = business.employees.find((e) => e.playerId === employeePlayerId)
    if (!employee || !employee.isActive) {
      throw new NotFoundError(
        'Employee not found',
        'این کارمند در تیم تو فعال نیست. فهرست کارکنان را به‌روزرسانی کن.'
      )
    }
    if (
      !Number.isSafeInteger(contractGameHoursPerMonth) ||
      contractGameHoursPerMonth < MIN_CONTRACT_GAME_HOURS_PER_MONTH ||
      contractGameHoursPerMonth > MAX_CONTRACT_GAME_HOURS_PER_MONTH
    ) {
      throw new ValidationError(
        'Invalid contract volume',
        `حجم کار باید بین ${MIN_CONTRACT_GAME_HOURS_PER_MONTH} تا ${MAX_CONTRACT_GAME_HOURS_PER_MONTH} ساعت بازی در ماه باشد.`
      )
    }

    const contractMinutesPerMonth = contractMinutesFromGameHours(contractGameHoursPerMonth)
    const changed = await this.businessRepository.updateEmployeeContract(
      businessId,
      employeePlayerId,
      contractMinutesPerMonth
    )
    if (changed !== 1) {
      throw new ConflictError(
        'Contract not changed',
        'این کارمند همین حالا تغییر وضعیت داد؛ فهرست را به‌روزرسانی کن.'
      )
    }

    return {
      businessName: business.name,
      employeeName: `${employee.player.firstName} ${employee.player.lastName ?? ''}`.trim(),
      contractMinutesPerMonth,
      contractGameHoursPerMonth: contractGameHoursPerMonth,
      /** بیشترین پرداختِ یک ماهِ کامل در صورت تحویلِ کلِ حجم قرارداد. */
      monthlyPayCeiling: contractValue(
        Number(employee.salaryPerMinute),
        contractMinutesPerMonth
      )
    }
  }

  /**
   * تسویهٔ حقوق و ثبت درآمد کسب‌وکار.
   * منطق مالی در PayrollService پیاده شده تا اتمیک و Idempotent باشد؛
   * این متد فقط مالکیت را بررسی می‌کند و کار را به آن سرویس می‌سپارد.
   */
  async settlePayroll(telegramUserId: bigint, businessId: string) {
    const player = await this.playerRepository.findByTelegramUserId(telegramUserId)
    if (!player) {
      throw new NotFoundError('Player not found')
    }
    return this.payrollService.settle(businessId, player.id)
  }

  /** پیش‌نمایش تسویه بدون اعمال تغییر. */
  async previewPayroll(telegramUserId: bigint, businessId: string) {
    const player = await this.playerRepository.findByTelegramUserId(telegramUserId)
    if (!player) {
      throw new NotFoundError('Player not found')
    }
    return this.payrollService.previewSettlement(businessId, player.id)
  }

  /** برداشت مالک از خزانه (null = کل موجودی خزانه). */
  async withdrawProfit(telegramUserId: bigint, businessId: string, amount: number | null) {
    const { player } = await this.requireOwnedActiveBusiness(telegramUserId, businessId)
    if (amount !== null && (!Number.isSafeInteger(amount) || amount < 1)) {
      throw new ValidationError('Invalid amount', 'مبلغ برداشت نامعتبر است.')
    }
    return this.businessRepository.withdrawBusinessProfit(player.id, businessId, amount)
  }

  async upgradeBusiness(telegramUserId: bigint, businessId: string) {
    const player = await this.playerRepository.findByTelegramUserId(telegramUserId)
    if (!player) {
      throw new NotFoundError('Player not found')
    }

    const business = await this.businessRepository.findById(businessId)
    if (!business || business.ownerId !== player.id) {
      throw new ConflictError('Access denied', 'این کسب‌وکار متعلق به تو نیست. از «کسب‌وکار» شرکت خودت را انتخاب کن.')
    }

    return this.businessRepository.upgradeBusiness(businessId)
  }
}