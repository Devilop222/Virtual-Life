import {
  Prisma,
  PrismaClient,
  BankAccount,
  BankAccountStatus,
  BusinessStatus,
  JobPostingStatus,
  Loan,
  LoanStatus,
  PropertyStatus,
  TransactionType,
  WorkSessionStatus
} from '@prisma/client'
import { ConflictError, NotFoundError, ValidationError } from '../../utils/classes/errors'
import { BankPoolService } from '../../modules/banking/bank-pool.service'
import { gameDays, gameDaysSince } from '../../utils/game-time'
import { LOAN_GRACE_DAYS } from '../../modules/banking/loan-lifecycle'
import { gameDayRateFromAnnual } from '../../modules/banking/interest-rate'

export interface BalanceResult {
  walletBalance: number
  bankBalance: number
}

/**
 * نتیجهٔ نکولِ یک وام — برای اعلان، رخدادِ سرگذشت و تست.
 *
 * `recovered` پولی است که واقعاً به صندوق بانک برگشت و `writtenOff` بخشی است که
 * هرگز وصول نشد. `writtenOff` روی خودِ وام می‌ماند (نه صفر می‌شود) تا بدهیِ
 * وصول‌نشده در سابقه باقی بماند و از ممیزی ناپدید نشود.
 */
export interface LoanDefaultOutcome {
  loanId: string
  playerId: string
  principal: number
  /** سررسید چند روز بازی پیش بوده (برای متن اعلان). */
  daysPastDue: number
  recovered: number
  writtenOff: number
  collateral: 'PROPERTY' | 'BUSINESS' | 'NONE'
  collateralTitle: string | null
}

/**
 * نشانهٔ داخلیِ «سود را درخواستِ دیگری هم‌زمان تسویه کرد».
 *
 * فقط برای آن است که تراکنشِ بازنده *برگردد* — چون کسرِ صندوق بانک پیش از قفلِ
 * شرطی انجام می‌شود، `return` کردن یعنی commit شدنِ آن کسر بدونِ هیچ واریزی به
 * بازیکن (پول نابود می‌شود و شمارندهٔ سودِ صندوق هم بی‌دلیل بالا می‌رود).
 * هرگز به بازیکن نشان داده نمی‌شود.
 */
class InterestSettledElsewhere extends Error {}

export class BankingRepository {
  private readonly pool = new BankPoolService()

  constructor(private readonly db: PrismaClient) {}

  /**
   * تفکیک یک قسط به «اصل» و «سود» بر پایهٔ سهم سود همان وام.
   *
   * چرا؟ بانک باید بداند چقدر از بازپرداخت، بازگشت اصلِ پول است و چقدر سود
   * واقعی؛ فقط سود است که می‌تواند سود سپرده‌ها را بپردازد.
   */
  private splitRepayment(
    loan: { principalAmount: Prisma.Decimal; totalRepaymentAmount: Prisma.Decimal },
    payment: number
  ): { principal: number; interest: number } {
    const total = Math.max(0, Math.round(Number(loan.totalRepaymentAmount)))
    const principal = Math.max(0, Math.round(Number(loan.principalAmount)))
    const interestShare = total > 0 ? Math.max(0, (total - principal) / total) : 0
    const interest = Math.min(payment, Math.round(payment * interestShare))
    return { principal: payment - interest, interest }
  }

  async findAccountByPlayerId(playerId: string): Promise<BankAccount | null> {
    // هر بازیکن دقیقاً یک حساب دارد (کلید یکتای `player_id`)؛ پس خواندن با
    // `findUnique` هم قطعی است و هم بی‌نیاز از ترتیب‌دادن دستی.
    return this.db.bankAccount.findUnique({
      where: { playerId }
    })
  }

  /**
   * ساخت حساب — حداکثر یک بار برای هر بازیکن.
   *
   * پیش‌تر «اول بخوان، اگر نبود بساز» بود و دو درخواست همزمان (کلیک دوبله روی
   * «حساب بانکی») دو حساب می‌ساختند؛ از آن به بعد موجودی پس‌انداز بازیکن بی‌صدا
   * دو تکه می‌شد. حالا یکتایی در دیتابیس است و بازندهٔ رقابت همان حسابِ ساخته‌شده
   * را برمی‌گرداند — نه خطا، نه حساب دوم.
   */
  async createAccount(playerId: string, cardNumber: string): Promise<BankAccount> {
    try {
      return await this.db.bankAccount.create({
        data: {
          playerId,
          cardNumber,
          balance: 0,
          status: BankAccountStatus.ACTIVE
        }
      })
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const existing = await this.findAccountByPlayerId(playerId)
        if (existing) {
          return existing
        }
      }
      throw error
    }
  }

  /**
   * واریز اتمیک از کیف پول به بانک.
   * کسر موجودی با شرط `balance >= amount` انجام می‌شود تا دو درخواست همزمان
   * نتوانند موجودی را منفی کنند (محافظت Race Condition).
   */
  async deposit(playerId: string, amount: number): Promise<BalanceResult> {
    return this.db.$transaction(async (tx) => {
      const account = await tx.bankAccount.findUnique({ where: { playerId } })
      if (!account || account.status !== BankAccountStatus.ACTIVE) {
        throw new NotFoundError('Active bank account not found', 'حساب بانکی فعال یافت نشد.')
      }

      // کسر شرطی: تنها در صورتی موفق می‌شود که موجودی کافی باشد
      const debited = await tx.player.updateMany({
        where: { id: playerId, balance: { gte: amount } },
        data: { balance: { decrement: amount } }
      })
      if (debited.count !== 1) {
        throw new ValidationError(
          'Insufficient wallet funds',
          'موجودی کیف پولت برای این واریز کافی نیست.'
        )
      }

      const updatedAccount = await tx.bankAccount.update({
        where: { id: account.id },
        data: { balance: { increment: amount } }
      })

      const updatedPlayer = await tx.player.findUniqueOrThrow({
        where: { id: playerId },
        select: { balance: true }
      })

      await tx.financialTransaction.create({
        data: {
          amount,
          type: TransactionType.BANK_DEPOSIT,
          sourcePlayerId: playerId,
          reference: `واریز به حساب بانکی (${account.cardNumber})`
        }
      })

      return {
        walletBalance: Number(updatedPlayer.balance),
        bankBalance: Number(updatedAccount.balance)
      }
    })
  }

  /**
   * برداشت اتمیک از بانک به کیف پول با شرط `balance >= amount` روی حساب بانکی.
   */
  async withdraw(playerId: string, amount: number): Promise<BalanceResult> {
    return this.db.$transaction(async (tx) => {
      const account = await tx.bankAccount.findUnique({ where: { playerId } })
      if (!account || account.status !== BankAccountStatus.ACTIVE) {
        throw new NotFoundError('Active bank account not found', 'حساب بانکی فعال یافت نشد.')
      }

      const debited = await tx.bankAccount.updateMany({
        where: {
          id: account.id,
          status: BankAccountStatus.ACTIVE,
          balance: { gte: amount }
        },
        data: { balance: { decrement: amount } }
      })
      if (debited.count !== 1) {
        throw new ValidationError(
          'Insufficient bank funds',
          'موجودی حساب بانکیت برای این برداشت کافی نیست.'
        )
      }

      const updatedPlayer = await tx.player.update({
        where: { id: playerId },
        data: { balance: { increment: amount } }
      })

      const updatedAccount = await tx.bankAccount.findUniqueOrThrow({
        where: { id: account.id },
        select: { balance: true }
      })

      await tx.financialTransaction.create({
        data: {
          amount,
          type: TransactionType.BANK_WITHDRAWAL,
          destinationPlayerId: playerId,
          reference: `برداشت از حساب بانکی (${account.cardNumber})`
        }
      })

      return {
        walletBalance: Number(updatedPlayer.balance),
        bankBalance: Number(updatedAccount.balance)
      }
    })
  }

  /**
   * پرداخت وام. بررسی «نداشتن وام فعال» داخل همان تراکنش انجام می‌شود
   * تا دو درخواست همزمان نتوانند دو وام بگیرند.
   */
  async disburseLoan(
    playerId: string,
    principal: number,
    totalRepayment: number,
    interestPercent: number,
    durationDays: number,
    collateralPropertyId?: string,
    collateralBusinessId?: string
  ): Promise<Loan> {
    return this.db.$transaction(async (tx) => {
      const activeLoanCount = await tx.loan.count({
        where: { playerId, status: LoanStatus.ACTIVE }
      })
      if (activeLoanCount > 0) {
        throw new ConflictError('Active loan exists', 'یک وام تسویه‌نشده داری؛ اول آن را تسویه کن.')
      }

      let loan: Loan
      try {
        loan = await tx.loan.create({
          data: {
            playerId,
            principalAmount: principal,
            totalRepaymentAmount: totalRepayment,
            remainingAmount: totalRepayment,
            interestRatePercent: interestPercent,
            collateralPropertyId,
            collateralBusinessId,
            status: LoanStatus.ACTIVE,
            // سررسید روی تقویم بازی بسته می‌شود: هر روز بازی ۴۸ دقیقهٔ واقعی است.
            dueAt: new Date(Date.now() + gameDays(durationDays))
          }
        })
      } catch (error) {
        // قفل نهایی در دیتابیس: یکتای partial روی «یک وام فعال به ازای هر بازیکن»
        // دو درخواست همزمان را می‌شکند (دابل‌کلیک = یک وام، نه دو تا).
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          throw new ConflictError(
            'Active loan exists',
            'یک وام تسویه‌نشده داری؛ اول آن را تسویه کن.'
          )
        }
        throw error
      }

      // پول وام از صندوق واقعی بانک بیرون می‌آید؛ اگر نقدینگی کافی نباشد
      // وام پرداخت نمی‌شود (پیش‌تر اصل وام از هیچ ساخته می‌شد).
      const funded = await this.pool.debit(tx, principal)
      if (!funded) {
        throw new ConflictError(
          'Bank liquidity',
          'نقدینگی بانک برای این مبلغ کافی نیست. مبلغ کمتری درخواست کن یا چند روز دیگر تلاش کن.'
        )
      }

      await tx.player.update({
        where: { id: playerId },
        data: { balance: { increment: principal } }
      })

      await tx.financialTransaction.create({
        data: {
          amount: principal,
          type: TransactionType.LOAN_DISBURSEMENT,
          destinationPlayerId: playerId,
          reference: `پرداخت وام بانکی با سود ${interestPercent}٪`
        }
      })

      return loan
    })
  }

  async listActiveLoans(playerId: string): Promise<Loan[]> {
    return this.db.loan.findMany({
      where: { playerId, status: LoanStatus.ACTIVE },
      orderBy: { disbursedAt: 'asc' }
    })
  }

  /**
   * نمای عمومی صندوق بانک.
   *
   * چرا لازم است؟ سقف واقعیِ وام را نقدینگیِ صندوق تعیین می‌کند، ولی بازیکن
   * هیچ راهی نداشت بفهمد صندوق چقدر پول دارد، پس رد شدنِ وام با پیام
   * «نقدینگی کافی نیست» برایش بی‌دلیل به نظر می‌رسید. این خواندنِ صرفاً
   * خواندنی (بدون تغییر صندوق) همان عدد را قابل دیدن می‌کند.
   */
  async getPoolSnapshot(): Promise<{
    liquidity: number
    totalDeposited: number
    totalDisbursed: number
    totalDepositInterest: number
  }> {
    const snap = await this.pool.snapshot(this.db)
    return {
      liquidity: snap.balance,
      totalDeposited: snap.totalDeposited,
      totalDisbursed: snap.totalDisbursed,
      totalDepositInterest: snap.totalDepositInterest
    }
  }

  /**
   * تسویه سود سپرده به‌صورت idempotent.
   * `lastInterestAt` با شرط زمانی به‌روزرسانی می‌شود تا اجرای همزمان
   * باعث پرداخت دوبارهٔ سود نشود.
   *
   * نرخ از ستونِ خودِ حساب (`interestRateAnnual`) خوانده می‌شود، نه از یک عددِ
   * تکرارشده در سرویس؛ پیش‌تر این ستون نوشته و هرگز خوانده نمی‌شد و نرخ واقعی
   * در دو جای دیگر تکرار شده بود — یعنی یک منبعِ حقیقتِ دروغین.
   */
  async settleInterest(
    playerId: string
  ): Promise<{ interestAccrued: number; newBalance: number }> {
    try {
      return await this.db.$transaction(async (tx) => {
        const account = await tx.bankAccount.findUnique({ where: { playerId } })
        if (!account || account.status !== BankAccountStatus.ACTIVE) {
          throw new NotFoundError('Active bank account not found', 'حساب بانکی فعال یافت نشد.')
        }
        const dailyRate = gameDayRateFromAnnual(Number(account.interestRateAnnual ?? 0))
        if (dailyRate <= 0) {
          return { interestAccrued: 0, newBalance: Number(account.balance) }
        }

        const previousInterestAt = account.lastInterestAt
        // سود روی روزهای *بازی* می‌نشیند؛ همان تقویمی که سررسید وام با آن بسته می‌شود.
        const elapsedDays = gameDaysSince(previousInterestAt)
        if (elapsedDays < 1) {
          return { interestAccrued: 0, newBalance: Number(account.balance) }
        }

        const daysToSettle = Math.floor(elapsedDays)
        const balance = Number(account.balance)
        const accruedRequest = Math.round(balance * dailyRate * daysToSettle)
        // سود از صندوق بانک پرداخت می‌شود؛ اگر صندوق کم باشد فقط تا سقف
        // موجودی‌اش سود می‌دهیم تا پول از هیچ ساخته نشود.
        const interestAccrued =
          accruedRequest > 0 ? await this.pool.debitUpTo(tx, accruedRequest) : 0

        // اگر صندوق فقط بخشی از سود را پوشش داد، همان بخش از دوره تسویه
        // می‌شود و باقی دوره برای تلاش بعدی می‌ماند؛ نه سود بازیکن بی‌دلیل
        // می‌سوزد و نه یک روز دو بار سود می‌گیرد.
        const coveredDays =
          accruedRequest > 0 && interestAccrued < accruedRequest
            ? Math.max(
                1,
                Math.min(
                  daysToSettle,
                  Math.floor((daysToSettle * interestAccrued) / accruedRequest)
                )
              )
            : daysToSettle
        const nextInterestAt = new Date(previousInterestAt.getTime() + gameDays(coveredDays))

        if (interestAccrued <= 0 && accruedRequest > 0) {
          // صندوق خالی است: نه سودی پرداخت می‌شود و نه ساعت جلو می‌رود
          return { interestAccrued: 0, newBalance: balance }
        }

        // شرط روی lastInterestAt = محافظت از پرداخت دوبارهٔ سود
        const claimed = await tx.bankAccount.updateMany({
          where: { id: account.id, lastInterestAt: previousInterestAt },
          data: {
            balance: { increment: interestAccrued },
            lastInterestAt: nextInterestAt
          }
        })
        if (claimed.count !== 1) {
          // سود را درخواستِ دیگری همین حالا تسویه کرده است. چون صندوق بانک پیش از
          // این قفل کسر شده، باید با پرتاب کل تراکنش برگردد؛ وگرنه پول از صندوق کم
          // می‌شود بدونِ آنکه به حسابِ کسی برود.
          throw new InterestSettledElsewhere()
        }

        if (interestAccrued > 0) {
          await tx.financialTransaction.create({
            data: {
              amount: interestAccrued,
              type: TransactionType.DEPOSIT_INTEREST,
              destinationPlayerId: playerId,
              reference: `سود حساب بانکی ${daysToSettle} روزه`
            }
          })
        }

        const updated = await tx.bankAccount.findUniqueOrThrow({
          where: { id: account.id },
          select: { balance: true }
        })

        return { interestAccrued, newBalance: Number(updated.balance) }
      })
    } catch (error) {
      if (!(error instanceof InterestSettledElsewhere)) {
        throw error
      }
      // بازندهٔ رقابت: نه پولی از صندوق سوخت (تراکنش برگشت) و نه سودی دو بار
      // پرداخت شد. موجودیِ تازه خوانده می‌شود تا عددِ کهنهٔ پیش از تراکنش
      // بیرون نرود.
      const fresh = await this.db.bankAccount.findUnique({
        where: { playerId },
        select: { balance: true }
      })
      return { interestAccrued: 0, newBalance: fresh ? Number(fresh.balance) : 0 }
    }
  }

  /**
   * بازپرداخت قسط وام به‌صورت اتمیک.
   * هم کسر موجودی و هم کاهش بدهی شرطی هستند تا کلیک دوباره باعث
   * پرداخت مضاعف یا بدهی منفی نشود.
   */
  async repayLoan(loanId: string, playerId: string, amount: number): Promise<Loan> {
    return this.db.$transaction(async (tx) => {
      const loan = await tx.loan.findUnique({ where: { id: loanId } })
      if (!loan || loan.playerId !== playerId || loan.status !== LoanStatus.ACTIVE) {
        throw new NotFoundError('Active loan not found', 'وام فعالی نداری.')
      }

      const remainingBefore = Number(loan.remainingAmount)
      const payment = Math.min(amount, remainingBefore)

      const debited = await tx.player.updateMany({
        where: { id: playerId, balance: { gte: payment } },
        data: { balance: { decrement: payment } }
      })
      if (debited.count !== 1) {
        throw new ValidationError('Insufficient balance', 'موجودیت برای پرداخت این قسط کافی نیست.')
      }

      const remainingAfter = remainingBefore - payment
      const claimed = await tx.loan.updateMany({
        where: { id: loanId, status: LoanStatus.ACTIVE, remainingAmount: remainingBefore },
        data: {
          remainingAmount: remainingAfter,
          status: remainingAfter <= 0 ? LoanStatus.PAID : LoanStatus.ACTIVE
        }
      })
      if (claimed.count !== 1) {
        // وضعیت وام بین خواندن و نوشتن تغییر کرده: تراکنش را برمی‌گردانیم
        throw new ConflictError('Loan state changed', 'وضعیت وام تغییر کرده است. دوباره تلاش کن.')
      }

      // بازگشت پول به صندوق بانک، با تفکیک اصل و سود
      const split = this.splitRepayment(loan, payment)
      await this.pool.creditRepayment(tx, split.principal, split.interest)

      if (split.principal > 0) {
        await tx.financialTransaction.create({
          data: {
            amount: split.principal,
            type: TransactionType.LOAN_REPAYMENT,
            sourcePlayerId: playerId,
            reference: `بازپرداخت اصل وام`
          }
        })
      }
      if (split.interest > 0) {
        await tx.financialTransaction.create({
          data: {
            amount: split.interest,
            type: TransactionType.LOAN_INTEREST,
            sourcePlayerId: playerId,
            reference: `سود وام (درآمد بانک)`
          }
        })
      }

      return tx.loan.findUniqueOrThrow({ where: { id: loanId } })
    })
  }

  /** خواندن یک وام با شناسه (برای تسویهٔ زودهنگام). */
  async findLoanById(loanId: string): Promise<Loan | null> {
    return this.db.loan.findUnique({ where: { id: loanId } })
  }

  /**
   * نکولِ وام‌های سررسیدگذشته — قلبِ عمر واقعیِ وام.
   *
   * ── چرا لازم است؟ ────────────────────────────────────────────────────────
   * پیش از این `dueAt` نوشته می‌شد و هرگز خوانده نمی‌شد؛ وام می‌توانست تا ابد
   * `ACTIVE` بماند، وثیقه (ملک یا شرکت) هرگز آزاد یا تملک نمی‌شد و بازیکن
   * می‌توانست قسط ندهد بدون هیچ هزینه‌ای. حالا مهلتِ `LOAN_GRACE_DAYS` که
   * گذشت، وام نکول می‌شود.
   *
   * ── قواعد حسابداری ───────────────────────────────────────────────────────
   * • ملک وثیقه: بانک آن را **تملک** می‌کند و به بازار شهر برمی‌گرداند
   *   (`ownerId = null`, `AVAILABLE`). هیچ پولی ساخته نمی‌شود چون ملک هرگز
   *   بخشی از عرضهٔ پول نبوده است؛ قرارداد اجارهٔ فعال هم بسته می‌شود تا مستأجر
   *   در ملکِ تملک‌شده نماند.
   * • شرکت وثیقه: خزانه در خزانهٔ شرکت **پول واقعیِ در گردش** است، پس تملک آن
   *   یک جابه‌جاییِ واقعی است: خزانه تخلیه و به صندوق بانک واریز می‌شود (با
   *   ردیفِ دفتری `LOAN_COLLATERAL_SEIZED`)، شرکت `BANKRUPT` می‌شود، کارمندان
   *   غیرفعال و آگهی‌ها/شعبه‌ها بسته می‌شوند.
   * • هرگز کیف پول بازیکن دست نمی‌خورد؛ پس دفترِ بازیکن و ممیزیِ عرضهٔ پول
   *   دست‌نخورده می‌ماند (نکول فقط داراییِ وثیقه‌ای را می‌گیرد).
   *
   * idempotent و race-safe: ادعای وام با یک نوشتارِ شرطی انجام می‌شود، پس دو
   * Sweep همزمان یا Retry هرگز دو بار تملک نمی‌کنند.
   */
  async defaultLoan(loanId: string, now: number = Date.now()): Promise<LoanDefaultOutcome | null> {
    const cutoff = new Date(now - gameDays(LOAN_GRACE_DAYS))

    return this.db.$transaction(async (tx) => {
      const loan = await tx.loan.findUnique({
        where: { id: loanId },
        include: { collateralProperty: true, collateralBusiness: true }
      })
      if (!loan || loan.status !== LoanStatus.ACTIVE || loan.dueAt.getTime() > cutoff.getTime()) {
        return null
      }

      // ادعای انحصاری: فقط یک اجرا می‌تواند این وام را نکول کند.
      const claimed = await tx.loan.updateMany({
        where: { id: loanId, status: LoanStatus.ACTIVE, dueAt: { lte: cutoff } },
        data: { status: LoanStatus.DEFAULTED }
      })
      if (claimed.count !== 1) {
        return null
      }

      const remainingBefore = Math.max(0, Math.round(Number(loan.remainingAmount)))
      let recovered = 0
      let collateral: LoanDefaultOutcome['collateral'] = 'NONE'
      let collateralTitle: string | null = null

      // ── وثیقهٔ ملکی: تملک و بازگشت به بازار (بدون ساخت پول) ──
      const property = loan.collateralProperty
      if (property) {
        const seized = await tx.property.updateMany({
          where: { id: property.id, ownerId: loan.playerId },
          data: {
            ownerId: null,
            status: PropertyStatus.AVAILABLE,
            isListedForRent: false,
            isFurnished: false
          }
        })
        if (seized.count === 1) {
          collateral = 'PROPERTY'
          collateralTitle = property.title
          // مستأجری که در ملکِ تملک‌شده نشسته باید بیرون بیاید؛ قرارداد بسته می‌شود
          // (پولِ اجارهٔ پرداخت‌شده پس گرفته نمی‌شود — نه ظلم دوطرفه، نه پول تازه).
          await tx.rentalContract.updateMany({
            where: { propertyId: property.id, isActive: true },
            data: { isActive: false }
          })
        }
      }

      // ── وثیقهٔ شرکتی: تخلیهٔ خزانه به صندوق بانک (پول واقعی) ──
      const business = loan.collateralBusiness
      if (business) {
        const treasury = Math.max(0, Math.round(Number(business.treasury)))
        const bankrupted = await tx.business.updateMany({
          where: { id: business.id, ownerId: loan.playerId },
          data: {
            treasury: 0,
            status: BusinessStatus.BANKRUPT,
            activeEmployees: 0
          }
        })
        if (bankrupted.count === 1) {
          collateral = collateral === 'NONE' ? 'BUSINESS' : collateral
          collateralTitle = collateralTitle ?? business.name

          if (treasury > 0) {
            recovered = treasury
            // صندوق بانک: تمام مبلغ به‌عنوان بازگشت اصل ثبت می‌شود (سودی وصول نشده)
            await this.pool.creditRepayment(tx, treasury, 0)
            await tx.financialTransaction.create({
              data: {
                amount: treasury,
                type: TransactionType.LOAN_COLLATERAL_SEIZED,
                sourceBusinessId: business.id,
                reference: `تملک وثیقهٔ وام نکول‌شده — خزانهٔ ${business.name}`
              }
            })
          }

          // بستنِ کاملِ کسب‌وکار: کارمندان، آگهی‌ها، شعبه‌ها و نوبت‌های کاری
          await tx.businessEmployee.updateMany({
            where: { businessId: business.id, isActive: true },
            data: { isActive: false }
          })
          await tx.jobPosting.updateMany({
            where: { businessId: business.id, status: JobPostingStatus.OPEN },
            data: { status: JobPostingStatus.CLOSED }
          })
          await tx.businessBranch.updateMany({
            where: { businessId: business.id },
            data: { status: BusinessStatus.CLOSED }
          })
          // نوبتِ کاریِ بازِ کارمندان روی شرکتِ ورشکسته نباید بی‌نهایت حق‌وقفه بسازد
          await tx.workSession.updateMany({
            where: { businessId: business.id, status: WorkSessionStatus.ACTIVE },
            data: { status: WorkSessionStatus.CANCELLED, endedAt: new Date(now) }
          })
        }
      }

      // بخش وصول‌نشده روی خودِ وام می‌ماند (صفر نمی‌شود) تا بدهی از سابقه ناپدید نشود.
      const writtenOff = Math.max(0, remainingBefore - recovered)
      await tx.loan.update({
        where: { id: loan.id },
        data: { remainingAmount: writtenOff }
      })

      return {
        loanId: loan.id,
        playerId: loan.playerId,
        principal: Math.max(0, Math.round(Number(loan.principalAmount))),
        daysPastDue: gameDaysSince(loan.dueAt, now),
        recovered,
        writtenOff,
        collateral,
        collateralTitle
      } satisfies LoanDefaultOutcome
    })
  }

  /**
   * چرخهٔ نکول روی وام‌های سررسیدگذشته.
   *
   * فقط وام‌هایی را برمی‌دارد که واقعاً از مهلت گذشته‌اند (فیلتر در همان Query)،
   * و هر کدام را در تراکنشِ خودش نکول می‌کند تا خطای یکی، بقیه را نخواباند.
   */
  async defaultOverdueLoans(
    limit = 20,
    now: number = Date.now(),
    /** اگر بدهی داده شود، فقط وام‌های همین بازیکن بررسی می‌شوند (پنل Lazy). */
    playerId?: string
  ): Promise<LoanDefaultOutcome[]> {
    const cutoff = new Date(now - gameDays(LOAN_GRACE_DAYS))
    const candidates = await this.db.loan.findMany({
      where: {
        status: LoanStatus.ACTIVE,
        dueAt: { lte: cutoff },
        ...(playerId ? { playerId } : {})
      },
      select: { id: true },
      orderBy: { dueAt: 'asc' },
      take: Math.max(1, Math.min(200, Math.round(limit)))
    })

    const outcomes: LoanDefaultOutcome[] = []
    for (const candidate of candidates) {
      try {
        const outcome = await this.defaultLoan(candidate.id, now)
        if (outcome) outcomes.push(outcome)
      } catch {
        // خطای یک وام (قطع اتصال، رقابت) کل چرخه را نمی‌خواباند؛ اجرای بعدی
        // همان وام را دوباره برمی‌دارد و چون ادعای وضعیت شرطی است، دوباره‌کاری
        // مالی ناممکن است.
        continue
      }
    }
    return outcomes
  }

  /** تعداد وام‌های نکول‌شدهٔ یک بازیکن — ورودیِ جریمهٔ اعتبار. */
  async countDefaults(playerId: string): Promise<number> {
    return this.db.loan.count({ where: { playerId, status: LoanStatus.DEFAULTED } })
  }

  /**
   * تسویهٔ کامل وام با مبلغ توافقی (تخفیف‌شده).
   * هم کسر موجودی و هم بستن وام شرطی‌اند تا پرداخت مضاعف ناممکن باشد.
   */
  async settleLoanEarly(loanId: string, playerId: string, amount: number): Promise<Loan> {
    return this.db.$transaction(async (tx) => {
      const loan = await tx.loan.findUnique({ where: { id: loanId } })
      if (!loan || loan.playerId !== playerId || loan.status !== LoanStatus.ACTIVE) {
        throw new NotFoundError('Active loan not found', 'وام فعالی نداری.')
      }

      const debited = await tx.player.updateMany({
        where: { id: playerId, balance: { gte: amount } },
        data: { balance: { decrement: amount } }
      })
      if (debited.count !== 1) {
        throw new ValidationError('Insufficient balance', 'موجودیت برای تسویهٔ زودهنگام کافی نیست.')
      }

      const claimed = await tx.loan.updateMany({
        where: { id: loanId, status: LoanStatus.ACTIVE },
        data: {
          remainingAmount: 0,
          status: LoanStatus.PAID
        }
      })
      if (claimed.count !== 1) {
        throw new ConflictError('Loan state changed', 'وضعیت وام تغییر کرده است. دوباره تلاش کن.')
      }

      const split = this.splitRepayment(loan, amount)
      await this.pool.creditRepayment(tx, split.principal, split.interest)

      if (split.principal > 0) {
        await tx.financialTransaction.create({
          data: {
            amount: split.principal,
            type: TransactionType.LOAN_REPAYMENT,
            sourcePlayerId: playerId,
            reference: 'تسویهٔ زودهنگام وام (اصل)'
          }
        })
      }
      if (split.interest > 0) {
        await tx.financialTransaction.create({
          data: {
            amount: split.interest,
            type: TransactionType.LOAN_INTEREST,
            sourcePlayerId: playerId,
            reference: 'سود وام — تسویهٔ زودهنگام (درآمد بانک)'
          }
        })
      }

      return tx.loan.findUniqueOrThrow({ where: { id: loanId } })
    })
  }
}
