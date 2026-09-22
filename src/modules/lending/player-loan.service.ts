import {
  GameEventType,
  NotificationType,
  PlayerLoan,
  Prisma,
  PrismaClient,
  TransactionType
} from '@prisma/client'
import { ConflictError, NotFoundError, ValidationError } from '../../utils/classes/errors'
import type { NotificationLevel } from '../notification/push'
import { EventService } from '../events/event.service'
import { cycleRate, gameDays } from '../../utils/game-time'

const MIN_PRINCIPAL = 200_000
const MAX_PRINCIPAL = 20_000_000
/**
 * نرخ سود کل قرارداد (سهم وام‌دهنده + کارمزد سیستم).
 *
 * نرخ با ریتم بازی هم‌تراز شده است: ۱۰٪ قبلی به‌ازای هر دورهٔ ۷ روزِ *واقعی*
 * بود؛ حالا هر دوره ۷ روز *بازی* است (۵٫۶ ساعت واقعی) و نرخ به همان نسبت
 * کوچک‌تر می‌شود تا هزینهٔ قرض در زمان واقعی ثابت بماند.
 */
export const LOAN_FEE_RATE = cycleRate(0.1)
/** سهم وام‌دهنده از سود (۸٪ ÷ ۳۰). */
const LENDER_SHARE_RATE = cycleRate(0.08)
/** مدت پیش‌فرض بازپرداخت: ۷ روز بازی. */
const TERM_DAYS = 7

export interface LoanRequestView {
  id: string
  borrowerName: string
  principal: number
  totalRepay: number
  createdAt: Date
}

export interface ActiveLoanView {
  id: string
  counterpartyName: string
  role: 'lender' | 'borrower'
  principal: number
  totalRepay: number
  dueAt: Date | null
  isOverdue: boolean
}

/**
 * قرض بین بازیکنان.
 *
 * جریان مالی اتمیک:
 *  • پذیرش: مبلغ شرطی از وام‌دهنده کسر، به وام‌گیرنده پرداخت می‌شود.
 *  • بازپرداخت: کل (اصل + ۱۰٪) از وام‌گیرنده کشر؛ ۱۰۸٪ به وام‌دهنده می‌رسد
 *    و ۲٪ کارمزد سیستم است (ضد توطئن دو حساب برای انتقال رایگان).
 *  • نکول Lazy: اولین بازدید پنل بعد از سررسید، اگر موجودی کافی نباشد قرارداد
 *    را «نکول» ثبت می‌کند؛ اعتبار اجتماعی خواسته می‌شود، نه موجودی منفی.
 */
export class PlayerLoanService {
  constructor(
    private readonly db: PrismaClient,
    private readonly eventService: EventService,
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

  private totalRepayOf(principal: number): number {
    return Math.round(principal * (1 + LOAN_FEE_RATE))
  }

  private lenderShareOf(principal: number): number {
    return Math.round(principal * (1 + LENDER_SHARE_RATE))
  }

  /**
   * ردیف‌های دفتر کلِ بازپرداخت — تنها نقطهٔ ثبت این رویداد.
   *
   * وام‌گیرنده کلِ قرارداد (اصل + ۱۰٪) می‌پردازد ولی وام‌دهنده فقط ۱۰۸٪
   * می‌گیرد؛ ۲٪ کارمزد سیستم است و به هیچ حسابی واریز نمی‌شود. اگر هر دو
   * مبلغ در یک ردیف «وام‌گیرنده ← وام‌دهنده» نوشته شود، درآمد وام‌دهنده
   * در دفتر کل بیشتر از واریزی واقعی‌اش دیده می‌شود و آشتیِ دفتر با موجودی
   * می‌شکند. پس انتقال واقعی و کارمزدِ سوخته دو ردیف جدا هستند؛ جمعِ
   * خروجیِ وام‌گیرنده همان کلِ قرارداد می‌ماند و ورودیِ وام‌دهنده دقیقاً
   * برابرِ واریزی‌اش است.
   */
  private async recordRepayLedger(
    tx: Prisma.TransactionClient,
    loan: Pick<PlayerLoan, 'principal' | 'totalRepay' | 'borrowerId' | 'lenderId'>,
    reference: string
  ): Promise<void> {
    const totalRepay = Number(loan.totalRepay)
    const lenderShare = this.lenderShareOf(Number(loan.principal))
    const fee = Math.max(0, totalRepay - lenderShare)

    await tx.financialTransaction.create({
      data: {
        amount: lenderShare,
        type: TransactionType.P2P_LOAN_REPAY,
        sourcePlayerId: loan.borrowerId,
        destinationPlayerId: loan.lenderId,
        reference
      }
    })
    if (fee > 0) {
      await tx.financialTransaction.create({
        data: {
          amount: fee,
          type: TransactionType.P2P_LOAN_REPAY,
          sourcePlayerId: loan.borrowerId,
          reference: 'کارمزد سیستم قرض بازیکنی (۲٪)'
        }
      })
    }
  }

  /** درخواست وام از یک بازیکن مشخص. */
  async request(
    borrowerTgId: bigint,
    lenderPlayerId: string,
    principal: number
  ): Promise<{ lenderName: string; totalRepay: number }> {
    if (!Number.isSafeInteger(principal) || principal < MIN_PRINCIPAL || principal > MAX_PRINCIPAL) {
      throw new ValidationError(
        'Amount out of range',
        `مبلغ قرض باید بین ${MIN_PRINCIPAL.toLocaleString('fa-IR')} و ${MAX_PRINCIPAL.toLocaleString('fa-IR')} تومان باشد.`
      )
    }

    const borrower = await this.db.player.findUnique({
      where: { telegramUserId: borrowerTgId },
      select: { id: true, firstName: true, lastName: true }
    })
    if (!borrower) {
      throw new NotFoundError('Player not found')
    }
    if (borrower.id === lenderPlayerId) {
      throw new ValidationError('Self loan', 'طرف قرض نمی‌تواند خودت باشی. روی پیام بازیکن موردنظر ریپلای کن.')
    }

    const lender = await this.db.player.findUnique({
      where: { id: lenderPlayerId },
      select: { id: true, firstName: true, lastName: true }
    })
    if (!lender) {
      throw new NotFoundError('Lender not found', 'این بازیکن یافت نشد. روی پیام خودِ بازیکن ریپلای کن؛ او باید ثبت‌نام کرده باشد.')
    }

    const openBetween = await this.db.playerLoan.count({
      where: {
        lenderId: lender.id,
        borrowerId: borrower.id,
        status: { in: ['PENDING', 'ACTIVE'] }
      }
    })
    if (openBetween > 0) {
      throw new ConflictError(
        'Open loan exists',
        'بین تو و این بازیکن یک قرض باز یا در انتظار پاسخ هست.'
      )
    }

    const loan = await this.db.playerLoan.create({
      data: {
        lenderId: lender.id,
        borrowerId: borrower.id,
        principal,
        feeRate: LOAN_FEE_RATE,
        totalRepay: this.totalRepayOf(principal)
      }
    })

    await this.notificationService
      ?.notifyPlayerById(
        lender.id,
        '📨 درخواست قرض',
        `${borrower.firstName} ${borrower.lastName ?? ''}`.trim() +
          ` درخواست قرض ${principal.toLocaleString('fa-IR')} تومانی داده است. با کلمهٔ «قرض» پنل قرض را باز کن و پاسخ بده؛ بازپرداختِ سررسید ${this.totalRepayOf(principal).toLocaleString('fa-IR')} تومان است.`,
        undefined,
        // کلید ضدتکرار باید برای هر درخواست یکتا ولی در ارسالِ مجددِ همان
        // درخواست یکسان باشد؛ شناسهٔ قرارداد هر دو شرط را دارد ولی
        // `Date.now()` هرگز تکرار نمی‌شد و ضدتکرار را بی‌اثر می‌کرد.
        `ploan-req:${loan.id}`,
        'CRITICAL'
      )
      .catch(() => undefined)

    return {
      lenderName: `${lender.firstName} ${lender.lastName ?? ''}`.trim(),
      totalRepay: this.totalRepayOf(principal)
    }
  }

  /** پذیرش توسط وام‌دهنده؛ انتقال اتمیک وجه. */
  async accept(
    lenderTgId: bigint,
    loanId: string
  ): Promise<{ borrowerName: string; principal: number }> {
    const lender = await this.db.player.findUnique({
      where: { telegramUserId: lenderTgId },
      select: { id: true }
    })
    if (!lender) {
      throw new NotFoundError('Player not found')
    }

    const loan = await this.db.playerLoan.findUnique({
      where: { id: loanId },
      include: {
        borrower: { select: { firstName: true, lastName: true } },
        lender: { select: { firstName: true, lastName: true } }
      }
    })
    if (!loan || loan.lenderId !== lender.id) {
      throw new NotFoundError('Loan not found', 'این درخواست متعلق به تو نیست. از پنل خودت، درخواست مربوط را انتخاب کن.')
    }
    if (loan.status !== 'PENDING') {
      throw new ConflictError('Not pending', 'این درخواست قبلاً پاسخ داده شده است.')
    }

    const dueAt = new Date(Date.now() + gameDays(TERM_DAYS))

    await this.db.$transaction(async (tx) => {
      const locked = await tx.playerLoan.updateMany({
        where: { id: loan.id, status: 'PENDING' },
        data: { status: 'ACTIVE', disbursedAt: new Date(), dueAt }
      })
      if (locked.count !== 1) {
        throw new ConflictError('Concurrent answer', 'این درخواست همین حالا پاسخ گرفت.')
      }

      const debited = await tx.player.updateMany({
        where: { id: lender.id, balance: { gte: Number(loan.principal) } },
        data: { balance: { decrement: Number(loan.principal) } }
      })
      if (debited.count !== 1) {
        throw new ConflictError(
          'Insufficient balance',
          'موجودی تو برای این قرض کافی نیست.'
        )
      }

      await tx.player.update({
        where: { id: loan.borrowerId },
        data: { balance: { increment: Number(loan.principal) } }
      })

      await tx.financialTransaction.create({
        data: {
          amount: Number(loan.principal),
          type: TransactionType.P2P_LOAN_DISBURSE,
          sourcePlayerId: lender.id,
          destinationPlayerId: loan.borrowerId,
          reference: 'پرداخت قرض بازیکنی'
        }
      })
    })

    // اعلان به وام‌گیرنده: پول واقعاً به کیفش رسیده
    const lenderName = `${loan.lender.firstName} ${loan.lender.lastName ?? ''}`.trim()
    await this.notificationService
      ?.notifyPlayerById(
        loan.borrowerId,
        '🤝 قرض پرداخت شد',
        `قرض ${Number(loan.principal).toLocaleString('fa-IR')} تومانی از ${lenderName} به کیفت واریز شد. کلِ بازپرداخت ${Number(loan.totalRepay).toLocaleString('fa-IR')} تومان است (به‌موقع یا زودتر).`,
        undefined,
        `ploan-disbursed:${loan.id}`,
        'CRITICAL'
      )
      .catch(() => undefined)

    return {
      borrowerName:
        `${loan.borrower.firstName} ${loan.borrower.lastName ?? ''}`.trim(),
      principal: Number(loan.principal)
    }
  }

  /** رد درخواست توسط وام‌دهنده. */
  async reject(lenderTgId: bigint, loanId: string): Promise<void> {
    const lender = await this.db.player.findUnique({
      where: { telegramUserId: lenderTgId },
      select: { id: true }
    })
    if (!lender) {
      throw new NotFoundError('Player not found')
    }

    const pending = await this.db.playerLoan.findUnique({
      where: { id: loanId },
      select: { borrowerId: true }
    })

    const updated = await this.db.playerLoan.updateMany({
      where: { id: loanId, lenderId: lender.id, status: 'PENDING' },
      data: { status: 'REJECTED' }
    })
    if (updated.count !== 1) {
      throw new ConflictError('Not pending', 'این درخواست قابل رد شدن نیست.')
    }

    if (pending) {
      await this.notificationService
        ?.notifyPlayerById(
          pending.borrowerId,
          '⚠️ رد درخواست قرض',
          'درخواست قرض تو رد شد؛ می‌توانی از بازیکنِ دیگری درخواست بدهی.',
          undefined,
          `ploan-rejected:${loanId}`,
          'IMPORTANT'
        )
        .catch(() => undefined)
    }
  }

  /** بازپرداخت زودهنگام یا سررسید توسط وام‌گیرنده. */
  async repay(
    borrowerTgId: bigint,
    loanId: string
  ): Promise<{ paid: number }> {
    const borrower = await this.db.player.findUnique({
      where: { telegramUserId: borrowerTgId },
      select: { id: true }
    })
    if (!borrower) {
      throw new NotFoundError('Player not found')
    }

    const loan = await this.db.playerLoan.findUnique({ where: { id: loanId } })
    if (!loan || loan.borrowerId !== borrower.id) {
      throw new NotFoundError('Loan not found', 'این قرض متعلق به تو نیست. «قرض» را بفرست و قرارداد خودت را انتخاب کن.')
    }
    if (loan.status === 'PAID') {
      throw new ConflictError('Already paid', 'این قرض تسویه شده است.')
    }
    if (loan.status !== 'ACTIVE') {
      throw new ConflictError('Not active', 'این قرض در وضعیت قابل پرداخت نیست؛ ممکن است قبلاً تسویه شده باشد. پنل «قرض» را به‌روزرسانی کن.')
    }

    await this.db.$transaction(async (tx) => {
      const locked = await tx.playerLoan.updateMany({
        where: { id: loan.id, status: 'ACTIVE' },
        data: { status: 'PAID', paidAt: new Date() }
      })
      if (locked.count !== 1) {
        throw new ConflictError('Concurrent repay', 'تسویه همین حالا ثبت شد.')
      }

      const debited = await tx.player.updateMany({
        where: { id: borrower.id, balance: { gte: Number(loan.totalRepay) } },
        data: { balance: { decrement: Number(loan.totalRepay) } }
      })
      if (debited.count !== 1) {
        throw new ConflictError(
          'Insufficient balance',
          `پرداخت ${Number(loan.totalRepay).toLocaleString('fa-IR')} تومان ممکن نشد؛ موجودی کافی نیست.`
        )
      }

      // سهم وام‌دهنده؛ باقی کارمزد سیستم است
      const lenderShare = this.lenderShareOf(Number(loan.principal))
      await tx.player.update({
        where: { id: loan.lenderId },
        data: { balance: { increment: lenderShare } }
      })

      await this.recordRepayLedger(tx, loan, 'بازپرداخت قرض بازیکنی')
    })

    await this.eventService
      .recordPlayerEvent({
        playerId: borrower.id,
        type: GameEventType.P2P_LOAN_SETTLED,
        title: 'قرض بازیکنی تسویه شد',
        amount: Number(loan.totalRepay),
        dedupeKey: `ploan-repaid:${loan.id}`
      })
      .catch(() => undefined)

    // اعلان به وام‌دهنده: سهمش واقعاً به کیفش رسیده
    const lenderShare = this.lenderShareOf(Number(loan.principal))
    await this.notificationService
      ?.notifyPlayerById(
        loan.lenderId,
        '💰 بازپرداخت قرض',
        `قرض ${Number(loan.principal).toLocaleString('fa-IR')} تومانی تسویه شد؛ ${lenderShare.toLocaleString('fa-IR')} تومان به کیفت واریز شد.`,
        undefined,
        `ploan-repaid-lender:${loan.id}`,
        'IMPORTANT'
      )
      .catch(() => undefined)

    return { paid: Number(loan.totalRepay) }
  }

  /**
   * بررسی Lazy سررسیدها برای وام‌گیرنده.
   * اگر موجودی کافی باشد خودکار پرداخت می‌شود؛ وگرنه «نکول» ثبت می‌گردد و
   * تا سقف موجودی، مبلغ قرارداد به‌صورت مجبورانه وصول می‌شود.
   *
   * چرا وصول اجباری؟ بدون آن، نکول پاداشی رایگان بود: قرض ۲۰ میلیونی بگیر،
   * سررسید نده و پول را برای همیشه داشته باش — یک ماشین پول‌سازی. با وصول
   * (و جریمهٔ امتیاز اعتباری در `CreditService`)، نکول هزینه دارد و وام‌دهنده
   * هم چیزی از وجهش را از دست نمی‌دهد تا جایی که موجودی وام‌گیرنده برسد.
   */
  /**
   * بررسی Lazy سررسیدها برای یک بازیکن.
   *
   * هر طرفِ قرارداد می‌تواند این چرخه را راه بیندازد: بدهکار با بازکردن پنل،
   * وام‌دهنده هم با بازکردن پنل خودش (پیش‌تر فقط بدهکار این چرخه را راه
   * می‌انداخت و اگر او هرگز پنل را باز نمی‌کرد، قرض برای همیشه ACTIVE
   * می‌ماند و وام‌دهنده تنها «از سررسید گذشته» را می‌دید بی‌آنکه بتواند
   * کاری کند). `playerId` یعنی «به نفع چه کسی چرخه را اجرا کن»؛ جست‌وجو
   * همیشه روی طرفِ بدهکارِ قرارداد است.
   */
  async settleDueLoans(playerId: string): Promise<{ repaid: number; defaulted: number }> {
    const due = await this.db.playerLoan.findMany({
      where: {
        status: 'ACTIVE',
        dueAt: { lte: new Date() },
        OR: [{ borrowerId: playerId }, { lenderId: playerId }]
      }
    })

    let repaid = 0
    let defaulted = 0

    for (const loan of due) {
      // همیشه توانِ مالیِ بدهکار ملاک است، نه کسی که چرخه را راه انداخته
      const affordable = await this.db.player.count({
        where: { id: loan.borrowerId, balance: { gte: Number(loan.totalRepay) } }
      })

      if (affordable === 1) {
        try {
          await this.repayByPlayerId(loan.id)
          repaid++
          continue
        } catch {
          // رقابت احتمالی؛ در چرخهٔ بعدی دوباره بررسی می‌شود
        }
      }

      const recovered = await this.markDefaulted(loan)
      if (recovered !== null) {
        defaulted++
        // هر دو طرف از نکول باخبر شوند: وام‌دهنده می‌خواهد بداند چقدر برگشته،
        // بدهکار باید بداند کیفش به‌صورت مجبورانه وصول شده — پیش‌تر فقط
        // وام‌دهنده اعلان می‌گرفت و برداشتِ پولِ بی‌خبر، حس کلاهبرداری می‌داد.
        await this.notificationService
          ?.notifyPlayerById(
            loan.borrowerId,
            '⚠️ قرض نکول شد',
            recovered > 0
              ? `قرض تو تا سررسید تسویه نشد؛ ${recovered.toLocaleString('fa-IR')} تومان به‌صورت مجبورانه از کیف تو وصول شد. اعتبارت آسیب دید.`
              : 'قرض تو تا سررسید تسویه نشد و موجودی‌ات برای وصول کافی نبود. اعتبارت آسیب دید.',
            undefined,
            `ploan-default-borrower:${loan.id}`,
            'CRITICAL'
          )
          .catch(() => undefined)
        await this.notificationService
          ?.notifyPlayerById(
            loan.lenderId,
            '⚠️ نکول قرض',
            recovered > 0
              ? `وام‌گیرنده تا سررسید تسویه نکرد؛ ${recovered.toLocaleString('fa-IR')} تومان از قرارداد به‌صورت مجبورانه وصول شد.`
              : 'وام‌گیرنده تا سررسید تسویه نکرد و موجودی‌اش برای وصول کافی نبود.',
            undefined,
            `ploan-default:${loan.id}`,
            'CRITICAL'
          )
          .catch(() => undefined)
      }
    }

    return { repaid, defaulted }
  }

  /**
   * ثبت نکول + وصول مجبورانه در یک تراکنش.
   *
   * @returns مبلغی که واقعاً از کیف وام‌گیرنده وصول شد؛ `null` یعنی رکورد
   *         را رقابتِ دیگری (تسویهٔ همزمان) برد و اینجا کاری نشد.
   */
  private async markDefaulted(loan: {
    id: string
    borrowerId: string
    lenderId: string
    principal: Prisma.Decimal | number | bigint
    totalRepay: Prisma.Decimal | number | bigint
  }): Promise<number | null> {
    return this.db.$transaction(async (tx) => {
      const marked = await tx.playerLoan.updateMany({
        where: { id: loan.id, status: 'ACTIVE' },
        data: { status: 'DEFAULTED' }
      })
      if (marked.count !== 1) {
        return null
      }

      const totalRepay = Number(loan.totalRepay)
      const lenderShare = this.lenderShareOf(Number(loan.principal))

      const borrower = await tx.player.findUnique({
        where: { id: loan.borrowerId },
        select: { balance: true }
      })
      const confiscated = Math.max(
        0,
        Math.min(borrower ? Number(borrower.balance) : 0, totalRepay)
      )
      if (confiscated <= 0) {
        return 0
      }

      const debited = await tx.player.updateMany({
        where: { id: loan.borrowerId, balance: { gte: confiscated } },
        data: { balance: { decrement: confiscated } }
      })
      if (debited.count !== 1) {
        // موجودی در لحظهٔ نوشتن عوض شد؛ چون نکول ثبت شده، دور بعد چیزی نمی‌ماند
        return 0
      }

      // همان تقسیمِ بازپرداخت معمول: اول سهم وام‌دهنده، باقی کارمزد سیستم
      const lenderPart = Math.min(confiscated, lenderShare)
      const feePart = confiscated - lenderPart
      if (lenderPart > 0) {
        await tx.player.update({
          where: { id: loan.lenderId },
          data: { balance: { increment: lenderPart } }
        })
      }

      if (lenderPart > 0) {
        await tx.financialTransaction.create({
          data: {
            amount: lenderPart,
            type: TransactionType.P2P_LOAN_REPAY,
            sourcePlayerId: loan.borrowerId,
            destinationPlayerId: loan.lenderId,
            reference: 'وصول پس از نکول قرض بازیکنی'
          }
        })
      }
      if (feePart > 0) {
        await tx.financialTransaction.create({
          data: {
            amount: feePart,
            type: TransactionType.P2P_LOAN_REPAY,
            sourcePlayerId: loan.borrowerId,
            reference: 'کارمزد سیستم قرض بازیکنی (پس از نکول)'
          }
        })
      }

      return confiscated
    })
  }

  /** نسخهٔ داخلی repay بر اساس شناسهٔ قرض (بدون نیاز به tg). */
  private async repayByPlayerId(loanId: string): Promise<void> {
    const loan = await this.db.playerLoan.findUniqueOrThrow({ where: { id: loanId } })

    let lenderShare = 0
    await this.db.$transaction(async (tx) => {
      const locked = await tx.playerLoan.updateMany({
        where: { id: loan.id, status: 'ACTIVE' },
        data: { status: 'PAID', paidAt: new Date() }
      })
      if (locked.count !== 1) throw new Error('locked')

      const debited = await tx.player.updateMany({
        where: { id: loan.borrowerId, balance: { gte: Number(loan.totalRepay) } },
        data: { balance: { decrement: Number(loan.totalRepay) } }
      })
      if (debited.count !== 1) throw new Error('funds')

      lenderShare = this.lenderShareOf(Number(loan.principal))
      await tx.player.update({
        where: { id: loan.lenderId },
        data: { balance: { increment: lenderShare } }
      })
      await this.recordRepayLedger(tx, loan, 'بازپرداخت خودکار قرض')
    })

    // کلید ضدتکرارِ مشترک با بازپرداخت دستی: اگر دستی تسویه شده، تکرار نمی‌شود
    await this.notificationService
      ?.notifyPlayerById(
        loan.lenderId,
        '💰 بازپرداخت خودکار قرض',
        `قرض ${Number(loan.principal).toLocaleString('fa-IR')} تومانی تا سررسید تسویه شد؛ ${lenderShare.toLocaleString('fa-IR')} تومان به کیفت واریز شد.`,
        undefined,
        `ploan-repaid-lender:${loan.id}`,
        'IMPORTANT'
      )
      .catch(() => undefined)
    // بدهکار هم باخبر شود: کلِ قرارداد از کیفش کسر شده و باید بداند بدهی‌اش
    // بسته است — پیش‌تر این کسر بی‌اعلان بود.
    await this.notificationService
      ?.notifyPlayerById(
        loan.borrowerId,
        '✅ قرض به‌موقع تسویه شد',
        `کلِ بازپرداخت ${Number(loan.totalRepay).toLocaleString('fa-IR')} تومانی از کیف تو پرداخت و قرض بسته شد. اعتبارت حفظ شد.`,
        undefined,
        `ploan-repaid-borrower:${loan.id}`,
        'IMPORTANT'
      )
      .catch(() => undefined)
  }

  /** نمای کامل پنل قرض. */
  async getView(
    telegramUserId: bigint
  ): Promise<{
    incomingRequests: LoanRequestView[]
    active: ActiveLoanView[]
    defaultsCount: number
    minPrincipal: number
    maxPrincipal: number
    feePercent: number
  }> {
    const me = await this.db.player.findUnique({
      where: { telegramUserId },
      select: { id: true }
    })
    if (!me) {
      throw new NotFoundError('Player not found')
    }

    await this.settleDueLoans(me.id)

    const [incoming, activeRows] = await Promise.all([
      this.db.playerLoan.findMany({
        where: { lenderId: me.id, status: 'PENDING' },
        orderBy: { createdAt: 'desc' },
        take: 5,
        include: { borrower: { select: { firstName: true, lastName: true } } }
      }),
      this.db.playerLoan.findMany({
        where: {
          status: 'ACTIVE',
          OR: [{ lenderId: me.id }, { borrowerId: me.id }]
        },
        orderBy: { dueAt: 'asc' },
        take: 8,
        include: {
          borrower: { select: { firstName: true, lastName: true } },
          lender: { select: { firstName: true, lastName: true } }
        }
      })
    ])

    const nameOf = (p: { firstName: string; lastName: string | null }) =>
      `${p.firstName} ${p.lastName ?? ''}`.trim()

    const defaultsCount = await this.db.playerLoan.count({
      where: { borrowerId: me.id, status: 'DEFAULTED' }
    })

    return {
      incomingRequests: incoming.map((loan) => ({
        id: loan.id,
        borrowerName: nameOf(loan.borrower),
        principal: Number(loan.principal),
        totalRepay: Number(loan.totalRepay),
        createdAt: loan.createdAt
      })),
      active: activeRows.map((loan) => ({
        id: loan.id,
        counterpartyName: nameOf(loan.borrowerId === me.id ? loan.lender : loan.borrower),
        role: loan.borrowerId === me.id ? ('borrower' as const) : ('lender' as const),
        principal: Number(loan.principal),
        totalRepay: Number(loan.totalRepay),
        dueAt: loan.dueAt,
        isOverdue: Boolean(loan.dueAt && loan.dueAt.getTime() <= Date.now())
      })),
      defaultsCount,
      minPrincipal: MIN_PRINCIPAL,
      maxPrincipal: MAX_PRINCIPAL,
      feePercent: Math.round(LOAN_FEE_RATE * 100 * 100) / 100
    }
  }
}

export const PLAYER_LOAN_INFO = {
  minPrincipal: MIN_PRINCIPAL,
  maxPrincipal: MAX_PRINCIPAL,
  feeRate: LOAN_FEE_RATE,
  lenderShareRate: LENDER_SHARE_RATE,
  termDays: TERM_DAYS
} as const
