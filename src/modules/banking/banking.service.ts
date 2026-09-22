import { BankingRepository } from '../../database/repositories/banking.repository'
import type { LoanDefaultOutcome } from '../../database/repositories/banking.repository'
import { PlayerRepository } from '../../database/repositories/player.repository'
import { HousingRepository } from '../../database/repositories/housing.repository'
import { BusinessRepository } from '../../database/repositories/business.repository'
import { ConflictError, NotFoundError, ValidationError } from '../../utils/classes/errors'
import {
  BankAccount,
  GameEventType,
  Loan,
  LoanStatus,
  NotificationType
} from '@prisma/client'
import { CreditService } from '../finance/credit.service'
import { businessCollateralValue, loanPrincipalCap } from './collateral'
import { LOAN_GRACE_DAYS, loanLifecycle, type LoanLifecycle } from './loan-lifecycle'
import type { NotificationLevel } from '../notification/push'
import { cycleRate, gameDays } from '../../utils/game-time'

export { LOAN_GRACE_DAYS, loanLifecycle }
export type { LoanLifecycle }

const LOAN_DURATION_DAYS = 30
/**
 * نرخ سودِ «یک دورهٔ ۳۰ روزهٔ وام» برای متوسط‌ترین گرید اعتباری.
 * این عدد عمداً «سالانه» نامیده نمی‌شود: کل بازپرداخت با همین نرخِ
 * مقطعی محاسبه می‌شود و وام‌گیرنده دقیقاً یک‌بار بهره می‌دهد.
 */
export const LOAN_PERIOD_INTEREST_PERCENT = 18
export const MIN_LOAN_AMOUNT = 500_000
/** تخفیف تسویهٔ زودهنگام: ۵٪ از ماندهٔ بدهی — منبع واحد نرخ، هم سرویس و هم پنل تأیید از همین می‌خوانند. */
export const EARLY_REPAY_DISCOUNT_RATE = 0.05

/** بهرهٔ دوره بر اساس گرید اعتباری؛ رفتار مالی خوب ارزان‌تر می‌شود. */
const GRADE_INTEREST_PERCENT: Record<string, number> = {
  A: 14,
  B: 16,
  C: 18,
  D: 22
}

/**
 * بهرهٔ وام روی *دورهٔ بازی* حساب می‌شود (۳۰ روز بازی = ۱ روز واقعی)، پس
 * درصدهای قبلی که برای یک ماه واقعی بودند با `cycleRate` هم‌تراز می‌شوند تا
 * هزینهٔ واقعی وام برای بازیکن تغییر نکند.
 */
function interestForGrade(grade: string): number {
  return cycleRate(GRADE_INTEREST_PERCENT[grade] ?? LOAN_PERIOD_INTEREST_PERCENT)
}

export class BankingService {
  constructor(
    private readonly bankingRepository: BankingRepository,
    private readonly playerRepository: PlayerRepository,
    private readonly housingRepository: HousingRepository,
    private readonly businessRepository: BusinessRepository,
    private readonly creditService: CreditService,
    private readonly notificationService?: {
      notifyPlayerById: (
        playerId: string,
        title: string,
        message: string,
        type?: NotificationType,
        dedupeKey?: string,
        level?: NotificationLevel
      ) => Promise<boolean>
    },
    /** فقط برای ثبت رخدادِ سرگذشت؛ اختیاری تا تست‌های سبک نشکنند. */
    private readonly eventService?: {
      recordPlayerEvent: (input: {
        playerId: string
        type: GameEventType
        title: string
        amount?: number
        detail?: string
        dedupeKey?: string
      }) => Promise<unknown>
    }
  ) {}

  generateGameCardNumber(): string {
    const randomDigits = Math.floor(100000000000 + Math.random() * 900000000000).toString()
    return `6037-${randomDigits.slice(0, 4)}-${randomDigits.slice(4, 8)}-${randomDigits.slice(8, 12)}`
  }

  async getOrCreateAccount(telegramUserId: bigint): Promise<BankAccount> {
    const player = await this.playerRepository.findByTelegramUserId(telegramUserId)
    if (!player) {
      throw new NotFoundError('Player not found')
    }

    const existing = await this.bankingRepository.findAccountByPlayerId(player.id)
    if (existing) {
      return existing
    }

    return this.bankingRepository.createAccount(player.id, this.generateGameCardNumber())
  }

  async deposit(telegramUserId: bigint, amount: number) {
    this.assertAmount(amount)

    const player = await this.playerRepository.findByTelegramUserId(telegramUserId)
    if (!player) {
      throw new NotFoundError('Player not found')
    }

    // بررسی نهایی موجودی به‌شکل اتمیک داخل Repository انجام می‌شود
    return this.bankingRepository.deposit(player.id, amount)
  }

  async withdraw(telegramUserId: bigint, amount: number) {
    this.assertAmount(amount)

    const player = await this.playerRepository.findByTelegramUserId(telegramUserId)
    if (!player) {
      throw new NotFoundError('Player not found')
    }

    return this.bankingRepository.withdraw(player.id, amount)
  }

  private assertAmount(amount: number): void {
    if (!Number.isFinite(amount) || !Number.isSafeInteger(amount) || amount <= 0) {
      throw new ValidationError('Invalid amount', 'مبلغ باید یک عدد صحیح و بزرگتر از صفر باشد.')
    }
  }

  async getCreditProfile(telegramUserId: bigint) {
    return this.creditService.getCreditProfile(telegramUserId)
  }

  async requestCollateralLoan(telegramUserId: bigint, propertyId?: string, businessId?: string): Promise<Loan> {
    const player = await this.playerRepository.findByTelegramUserId(telegramUserId)
    if (!player) {
      throw new NotFoundError('Player not found')
    }

    const activeLoans = await this.bankingRepository.listActiveLoans(player.id)
    if (activeLoans.length > 0) {
      throw new ConflictError(
        'Active loan exists',
        'یک وام تسویه‌نشده داری؛ اول آن را تسویه کن تا بتوانی وام تازه بگیری.'
      )
    }

    let collateralValue = 0

    if (propertyId) {
      const property = await this.housingRepository.findById(propertyId)
      if (!property || property.ownerId !== player.id) {
        throw new ValidationError('Invalid collateral', 'ملک انتخاب‌شده مال تو نیست.')
      }
      collateralValue = Number(property.baseAssetValue)
    } else if (businessId) {
      const business = await this.businessRepository.findById(businessId)
      if (!business || business.ownerId !== player.id) {
        throw new ValidationError('Invalid collateral', 'کسب‌وکار انتخاب‌شده مال تو نیست.')
      }
      collateralValue = businessCollateralValue(Number(business.treasury), business.level)
    } else {
      throw new ValidationError(
        'Collateral required',
        'برای دریافت وام، معرفی وثیقهٔ ملکی یا شرکتی الزامی است.'
      )
    }

    // سقف وام = کمینهٔ (۵۰٪ ارزش وثیقه، سقف اعتباری بازیکن)
    const credit = await this.creditService.getCreditProfile(telegramUserId)
    const principal = loanPrincipalCap(collateralValue, credit.maxLoanAmount)

    if (principal < MIN_LOAN_AMOUNT) {
      throw new ValidationError(
        'Credit too low',
        `سقف اعتباری‌ات برای دریافت وام کافی نیست.\nامتیاز اعتباری فعلی: ${credit.score} (${credit.gradeLabel})`
      )
    }

    // بهرهٔ مقطعیِ یک دورهٔ ۳۰ روزه؛ گرید بهتر = نرخ ارزان‌تر
    const interestPercent = interestForGrade(credit.grade)
    const totalRepayment = Math.round(principal * (1 + interestPercent / 100))

    const loan = await this.bankingRepository.disburseLoan(
      player.id,
      principal,
      totalRepayment,
      interestPercent,
      LOAN_DURATION_DAYS,
      propertyId,
      businessId
    )

    // اعلان به وام‌گیرنده: پول واقعاً به کیفش رسیده + شفافیتِ قسط‌ها
    await this.notificationService
      ?.notifyPlayerById(
        player.id,
        '🏦 وام پرداخت شد',
        `وام ${Number(loan.principalAmount).toLocaleString('fa-IR')} تومانی به کیفت واریز شد. کل بازپرداخت ${Number(loan.totalRepaymentAmount).toLocaleString('fa-IR')} تومان است (بهرهٔ دوره ٪${loan.interestRatePercent})؛ سررسید: ${new Date(loan.dueAt).toLocaleDateString('fa-IR')}.`,
        undefined,
        `bank-loan-disbursed:${loan.id}`,
        'CRITICAL'
      )
      .catch(() => undefined)

    return loan
  }

  /**
   * تسویهٔ زودهنگام وام با تخفیف ۵٪ روی مانده.
   * کسر شرطی + قفل وضعیت وام داخل یک تراکنش.
   */
  async repayLoanEarly(
    telegramUserId: bigint,
    loanId: string
  ): Promise<{ paid: number; saved: number; loanTitle: string }> {
    const player = await this.playerRepository.findByTelegramUserId(telegramUserId)
    if (!player) {
      throw new NotFoundError('Player not found')
    }

    const loan = await this.bankingRepository.findLoanById(loanId)
    if (!loan || loan.playerId !== player.id) {
      throw new NotFoundError('Loan not found', 'این وام متعلق به تو نیست. در «بانک» وام خودت را انتخاب کن.')
    }
    if (loan.status !== 'ACTIVE') {
      throw new ConflictError('Loan not active', 'این وام در وضعیت بازپرداخت نیست.')
    }

    const remaining = Math.round(Number(loan.remainingAmount))
    const saved = Math.round(remaining * EARLY_REPAY_DISCOUNT_RATE)
    const paid = remaining - saved

    await this.bankingRepository.settleLoanEarly(loan.id, player.id, paid)

    await this.notificationService
      ?.notifyPlayerById(
        player.id,
        '✅ وام تسویه شد',
        `وام ${Number(loan.principalAmount).toLocaleString('fa-IR')} تومانی با تخفیفِ تسویهٔ زودهنگام کامل شد؛ ${saved.toLocaleString('fa-IR')} تومان بهره کمتر پرداخت کردی.`,
        undefined,
        `bank-loan-settled:${loan.id}`,
        'IMPORTANT'
      )
      .catch(() => undefined)

    return {
      paid,
      saved,
      loanTitle: `وام ${Number(loan.principalAmount).toLocaleString('fa-IR')} تومانی`
    }
  }

  /**
   * تسویهٔ سود سپرده با فشارِ بازیکن (دکمهٔ «دریافت سود»).
   *
   * نرخ از ستونِ خودِ حساب خوانده می‌شود (`interest-rate.ts`)، پس متنِ پنل و
   * عددِ محاسبه نمی‌توانند واگرا شوند.
   */
  async settleAccountInterest(telegramUserId: bigint) {
    const player = await this.playerRepository.findByTelegramUserId(telegramUserId)
    if (!player) {
      throw new NotFoundError('Player not found')
    }

    const account = await this.bankingRepository.findAccountByPlayerId(player.id)
    if (!account) {
      throw new NotFoundError('Bank account not found', 'اول باید حساب بانکی باز کنی.')
    }

    return this.bankingRepository.settleInterest(player.id)
  }

  /**
   * تسویهٔ سودِ **خودکارِ تنبل** — هر بار که بازیکن پنل بانک را باز می‌کند.
   *
   * چرا لازم است؟ سود فقط با کلیک روی دکمه تسویه می‌شد، پس بازیکنی که آن دکمه
   * را نمی‌زد هیچ سودی نمی‌گرفت؛ دارایی‌اش عملاً راکد می‌ماند بدون آنکه بفهمد چرا.
   * این متد همان مسیر را صدا می‌زند (idempotent، با ردیف دفتری و شرط زمانی)،
   * پس نه سود دوباره پرداخت می‌شود و نه Restart چیزی را می‌بُرد.
   *
   * هرگز پرتاب نمی‌کند: باز شدن پنل نباید به سود بانکی گره بخورد.
   */
  async accrueAccountInterest(telegramUserId: bigint) {
    return this.settleAccountInterest(telegramUserId).catch(() => null)
  }

  async repayLoan(telegramUserId: bigint, loanId: string, amount = 1_000_000) {
    if (!loanId) {
      throw new ValidationError('Invalid loan id', 'شناسهٔ وام نامعتبر است.')
    }
    this.assertAmount(amount)

    const player = await this.playerRepository.findByTelegramUserId(telegramUserId)
    if (!player) {
      throw new NotFoundError('Player not found')
    }

    const updated = await this.bankingRepository.repayLoan(loanId, player.id, amount)

    // اگر قسطِ آخر بود و وام کامل شد، اعلانِ تسویهٔ کل
    if (updated.status === LoanStatus.PAID) {
      await this.notificationService
        ?.notifyPlayerById(
          player.id,
          '✅ وام تسویه شد',
          `وام ${Number(updated.principalAmount).toLocaleString('fa-IR')} تومانی کامل شد؛ دیگر بدهی بانکی نداری.`,
          undefined,
          `bank-loan-settled:${updated.id}`,
          'IMPORTANT'
        )
        .catch(() => undefined)
    }

    return updated
  }

  /**
   * نمای عمومی صندوق بانک برای پنل بازیکن.
   *
   * این داده مالِ کسی نیست و به بازیکن خاصی گره نمی‌خورد؛ همان ترازنامهٔ
   * عمومیِ بانک است که توضیح می‌دهد چرا وامی پرداخت می‌شود یا نمی‌شود.
   */
  async getPoolSnapshot() {
    return this.bankingRepository.getPoolSnapshot()
  }

  async listLoans(telegramUserId: bigint): Promise<Loan[]> {
    const player = await this.playerRepository.findByTelegramUserId(telegramUserId)
    if (!player) {
      throw new NotFoundError('Player not found')
    }

    // نکولِ Lazy و مخصوصِ همین بازیکن: اگر وامش از مهلت گذشته باشد، پنل هرگز
    // وامِ «سررسیدگذشتهٔ بی‌عاقبت» نشان نمی‌دهد. سبک است (یک Queryِ فیلترشده) و
    // در تراکنشِ خودش اجرا می‌شود، پس خواندنِ پنل هیچ قفلی روی دیتابیس نمی‌گذارد.
    await this.sweepOverdueLoans(5, player.id).catch(() => undefined)

    return this.bankingRepository.listActiveLoans(player.id)
  }

  /**
   * نمای وامِ فعال همراه با وضعیت واقعیِ چرخهٔ عمر (فعال/نزدیک سررسید/معوق).
   * پنل از همین می‌خواند تا نمایش و واقعیت هرگز واگرا نشوند.
   */
  async getLoanOverview(
    telegramUserId: bigint
  ): Promise<{ loan: Loan; lifecycle: LoanLifecycle } | null> {
    const loans = await this.listLoans(telegramUserId)
    const loan = loans[0]
    if (!loan) {
      return null
    }
    return { loan, lifecycle: loanLifecycle({ status: loan.status, dueAt: loan.dueAt }) }
  }

  /**
   * چرخهٔ نکولِ وام‌های سررسیدگذشته.
   *
   * از دو جا صدا زده می‌شود: تایمر دوره‌ای سرور (چرخهٔ کامل) و پنل بانک
   * (فقط وام‌های خودِ بازیکن). اثرات جانبی (اعلان و سرگذشت) عمداً **بیرون** از
   * تراکنشِ نکول انجام می‌شوند تا یک خطای تلگرامی، تملکِ انجام‌شده را برنگرداند.
   */
  async sweepOverdueLoans(limit = 20, playerId?: string): Promise<LoanDefaultOutcome[]> {
    const outcomes = await this.bankingRepository.defaultOverdueLoans(limit, Date.now(), playerId)
    for (const outcome of outcomes) {
      await this.announceDefault(outcome).catch(() => undefined)
    }
    return outcomes
  }

  /** اعلان و ثبت سرگذشتِ یک نکول — بعد از قطعی‌شدن تراکنش. */
  private async announceDefault(outcome: LoanDefaultOutcome): Promise<void> {
    const graceText = `${LOAN_GRACE_DAYS.toLocaleString('fa-IR')} روز بازی`
    const collateralLine =
      outcome.collateral === 'PROPERTY'
        ? `وثیقهٔ ملکی‌ات (${outcome.collateralTitle ?? 'ملک'}) تملک شد و به بازار شهر برگشت.`
        : outcome.collateral === 'BUSINESS'
          ? `وثیقهٔ شرکتی‌ات (${outcome.collateralTitle ?? 'شرکت'}) تملک شد؛ خزانه‌اش به بانک رسید و شرکت ورشکسته شد.`
          : 'وثیقه‌ای برای تملک نبود و بخشی از بدهی وصول نشد.'
    const recoveredLine =
      outcome.recovered > 0
        ? `از تملک وثیقه ${outcome.recovered.toLocaleString('fa-IR')} تومان به بانک برگشت.`
        : null
    const writtenLine =
      outcome.writtenOff > 0
        ? `${outcome.writtenOff.toLocaleString('fa-IR')} تومان از بدهی وصول نشد و در پروندهٔ وام به‌عنوان ضرر ثبت ماند.`
        : null
    const creditLine =
      'این نکول در سابقهٔ اعتباری‌ات می‌ماند و سقف و بهرهٔ وام‌های بعدی‌ات را بدتر می‌کند.'

    await this.notificationService
      ?.notifyPlayerById(
        outcome.playerId,
        '⚠️ وام تسویه‌نشده نکول شد',
        [
          `وام ${outcome.principal.toLocaleString('fa-IR')} تومانی‌ات ${outcome.daysPastDue.toLocaleString('fa-IR')} روز بازی از سررسید گذشته بود و پس از مهلت ${graceText}، نکول ثبت شد.`,
          collateralLine,
          recoveredLine,
          writtenLine,
          creditLine
        ]
          .filter((line): line is string => Boolean(line))
          .join('\n'),
        undefined,
        `bank-loan-defaulted:${outcome.loanId}`,
        'CRITICAL'
      )
      .catch(() => undefined)

    await this.eventService
      ?.recordPlayerEvent({
        playerId: outcome.playerId,
        type: GameEventType.LOAN_DEFAULTED,
        title: 'نکولِ وام بانکی',
        amount: outcome.principal,
        detail: collateralLine,
        dedupeKey: `loan-defaulted:${outcome.loanId}`
      })
      .catch(() => undefined)
  }

  /**
   * فاصلهٔ زمانیِ تا سررسید یک وام به زبان بازی — برای متن پنل.
   * (تنها منبعِ تبدیل زمان همان `game-time` است.)
   */
  static dueInGameDays(dueAt: Date, now: number = Date.now()): number {
    return Math.max(0, Math.ceil((dueAt.getTime() - now) / (gameDays(1) || 1)))
  }
}