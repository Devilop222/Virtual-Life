/**
 * اجرای میراث — انتقال دارایی و بدهیِ شخصیت فوت‌شده به وارث.
 *
 * ## چرا مرحله‌ای است؟
 *
 * انتقالِ میراث آخرین عملیات مالیِ یک شخصیت است و بدترین جای ممکن برای
 * «نیمه‌کاره ماندن»: پولِ کسرشده اما نرسیده، ملکِ واگذارنشده و کسب‌وکارِ
 * بی‌مالک، همگی حالت‌هایی هستند که بعداً از روی داده نمی‌شود فهمید چه شد.
 * پس پرونده (`InheritanceCase`) سه مرحلهٔ صریح دارد و هر مرحله فقط با یک
 * **نوشتار شرطی** جلو می‌رود:
 *
 *   PENDING ─▶ SETTLED_DEBTS ─▶ TRANSFERRED ─▶ COMPLETED
 *
 * هر گذر `updateMany({ where: { id, status: <قبلی> }, data: { status: <بعدی> } })`
 * است. پس:
 *   • دو اجرای هم‌زمان (مرگ از دو مسیر، یا کلیک دوبارهٔ ادمین) فقط یک بار
 *     هر مرحله را می‌برند؛ بازندهٔ رقابت `count === 0` می‌گیرد و برمی‌گردد.
 *   • Restart سرور وسط کار، پرونده را از همان مرحله ادامه می‌دهد.
 *   • خطا در مرحله، پرونده را در همان نقطه نگه می‌دارد (پول جابه‌جا نمی‌شود،
 *     چون هر مرحله یک تراکنش است) و `lastError` برای بررسی ثبت می‌شود.
 *
 * ## منابع مالی
 *
 * پول هرگز «ساخته» یا «سوزانده» نمی‌شود؛ فقط جابه‌جا می‌شود و هر جابه‌جایی
 * ردیفِ دفتری دارد:
 *   • بدهی بانکی از پولِ نقدی متوفی پرداخت و به صندوق بانک واریز می‌شود
 *     (`LOAN_REPAYMENT` + `LOAN_INTEREST` + `BankPoolService.creditRepayment`).
 *   • بدهی بازیکنی از پولِ نقدی متوفی به وام‌دهنده می‌رسد (`P2P_LOAN_REPAY`).
 *   • باقیِ پول (کیف + حساب بانکی) به وارث می‌رسد (`INHERITANCE_TRANSFER`).
 *
 * بدهی‌ای که پول کافی برایش نبود **حذف نمی‌شود**؛ در پرونده به‌عنوان
 * `debtUnpaid` ثبت می‌ماند تا نه بدهی بی‌دلیل ناپدید شود و نه کسی ادعا کند
 * همه‌چیز تسویه شد.
 */
import {
  InheritanceStatus,
  Prisma,
  PrismaClient,
  TransactionType
} from '@prisma/client'
import { logger } from '../../utils/logger'
import { BankPoolService } from '../banking/bank-pool.service'
import { RegionFundService } from '../economy/tax.service'
import type { NotificationLevel } from '../notification/push'
import { EventService } from '../events/event.service'
import { GameEventType, NotificationType } from '@prisma/client'
import { displayName, validateHeir } from './will-core'

/** چارچوب عکسِ لحظه‌ای دارایی‌ها — در پرونده ذخیره می‌شود. */
export interface EstateSnapshot {
  /** مرحله‌ای که اجرای پرونده در آن متوقف شد (برای ادامه پس از خطا). */
  phase?: 'PENDING' | 'SETTLED_DEBTS' | 'TRANSFERRED'
  wallet: number
  bank: number
  properties: number
  businesses: number
  deposits: number
  inventory: number
  loanDebt: number
  playerLoanDebt: number
  playerLoanReceivable: number
}

export interface InheritanceSummary {
  caseId: string
  status: InheritanceStatus
  heirId: string | null
  heirName: string | null
  cashTransferred: number
  debtSettled: number
  debtUnpaid: number
  propertiesCount: number
  businessesCount: number
  holdingsCount: number
}

/**
 * نمای پروندهٔ گیرکرده برای اپراتور.
 *
 * چرا جدا از `InheritanceSummary`؟ این نما باید به سه پرسشِ ادمین جواب بدهد
 * که در خلاصهٔ دامنه وجود ندارند: *این پروندهٔ کیست*، *چرا گیر کرده* و
 * *چند بار تلاش شده*.
 */
export interface StalledInheritanceView {
  caseId: string
  status: InheritanceStatus
  attempts: number
  lastError: string | null
  openedAt: Date
  deceasedName: string
  heirName: string | null
  cashTransferred: number
  debtUnpaid: number
  propertiesCount: number
  businessesCount: number
}

interface NotificationPort {
  notifyPlayerById: (
    playerId: string,
    title: string,
    message: string,
    type?: NotificationType,
    dedupeKey?: string,
    level?: NotificationLevel
  ) => Promise<boolean>
}

/**
 * چرا درصدِ تفکیک سود وام این‌جا دوباره حساب می‌شود؟ همان فرمولِ
 * `BankingRepository.splitRepayment` است. اگر عملیات بازپرداخت را از خودِ آن
 * ریپازیتوری می‌گرفتیم، این سرویس مجبور می‌شد `BankingRepository` را با کل
 * وابستگی‌هایش بسازد. فرمول کوچک است ولی **باید** یکسان بماند؛ اختلاف در
 * آن یعنی صندوق بانک و دفتر کل با هم نمی‌خوانند. آزمونِ این سرویس هر دو
 * حالت (اصل + سود) را می‌سنجد.
 */
function splitRepayment(
  loan: { principalAmount: Prisma.Decimal; totalRepaymentAmount: Prisma.Decimal },
  payment: number
): { principal: number; interest: number } {
  const total = Math.max(0, Math.round(Number(loan.totalRepaymentAmount)))
  const principal = Math.max(0, Math.round(Number(loan.principalAmount)))
  const interestShare = total > 0 ? Math.max(0, (total - principal) / total) : 0
  const interest = Math.min(payment, Math.round(payment * interestShare))
  return { principal: payment - interest, interest }
}

const money = (value: Prisma.Decimal | number | null | undefined): number =>
  Math.max(0, Math.round(Number(value ?? 0)))

export class InheritanceService {
  /** همان صندوق منطقه‌ای که مالیات و داراییِ بی‌وارث به آن می‌رسند. */
  private readonly regionFund = new RegionFundService()

  constructor(
    private readonly db: PrismaClient,
    private readonly eventService: EventService,
    private readonly pool: BankPoolService = new BankPoolService(),
    private readonly notificationService?: NotificationPort
  ) {}

  /**
   * بازکردن پرونده و اجرای کاملِ میراث برای یک متوفی.
   * اگر پروندهٔ کاملی وجود نداشته باشد، هیچ کاری نمی‌کند (idempotent).
   */
  async runForDeceased(deceasedId: string): Promise<InheritanceSummary | null> {
    // آخرین زندگی، نه زندگیِ اول: با «زندگی تازه» یک بازیکن می‌تواند چند
    // پرونده داشته باشد و همیشه فقط بالاترین شماره در جریان است.
    const start = await this.db.inheritanceCase.findFirst({
      where: { deceasedId },
      orderBy: { lifeIndex: 'desc' },
      select: { id: true, status: true }
    })
    if (!start) return null
    if (start.status === InheritanceStatus.COMPLETED || start.status === InheritanceStatus.NO_HEIR) {
      return this.summaryOf(start.id)
    }

    try {
      await this.settleDebts(start.id)
      await this.transferAssets(start.id)
      await this.closeCase(start.id)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown_error'
      logger.error({ err: error, caseId: start.id }, 'inheritance run failed')
      await this.db.inheritanceCase
        .update({
          where: { id: start.id },
          data: { lastError: message.slice(0, 500), attempts: { increment: 1 } }
        })
        .catch(() => undefined)
    }
    return this.summaryOf(start.id)
  }

  /**
   * سقفِ تلاشِ خودکارِ ترمیم.
   *
   * چرا سقف؟ اگر علتِ خطا پایدار باشد (مثلاً تعارضِ داده‌ای که فقط با تصمیم
   * انسانی حل می‌شود)، تلاشِ بی‌نهایت فقط لاگ را پر می‌کند. با سقف، پرونده از
   * چرخهٔ خودکار بیرون می‌رود و مثلِ یک موردِ «نیاز به بررسی» می‌ماند — و چون
   * وضعیت و خطایش ثبت شده، انسان می‌تواند تصمیم بگیرد.
   */
  static readonly MAX_RECOVERY_ATTEMPTS = 5

  /**
   * مهلتی که پیش از آن، یک پروندهٔ «هرگز پردازش‌نشده» دست‌نخورده می‌ماند.
   *
   * چرا لازم است؟ پرونده در یک تراکنش ساخته می‌شود و پرازش آن چند خط بعد،
   * پس از اعلان و ثبت رخداد، آغاز می‌شود. اگر پروسه در همین فاصله سقوط کند،
   * ردیفی می‌ماند با `attempts = 0` و `lastError = null`. فیلترِ خودکار به
   * `lastError` نگاه می‌کرد، پس آن پرونده هرگز برداشته نمی‌شد و داراییِ متوفی
   * برای همیشه یخ می‌زد. این مهلت مطمئن می‌کند پردازشِ زندهٔ همین حالا با
   * ترمیم اشتباه گرفته نشود (پرازش واقعی میلی‌ثانیه‌ای است).
   */
  static readonly NEVER_ATTEMPTED_GRACE_MS = 60 * 60 * 1000

  /**
   * ترمیم خودکار پرونده‌هایی که وسط انتقال متوقف شده‌اند.
   *
   * هر مرحله یک تراکنش با گذرِ شرطی است، پس فراخوانی دوباره هرگز پولی را
   * دوبار منتقل نمی‌کند؛ فقط مرحلهٔ نیمه‌کاره را تمام می‌کند. این تابع از
   * چرخهٔ دوره‌ای سرور صدا زده می‌شود تا یک خطای گذرا (قطع اتصال، restart)
   * داراییِ یک متوفی را برای همیشه بلاتکلیف نگذارد.
   */
  async recoverStalled(limit = 3): Promise<number> {
    const neverAttemptedBefore = new Date(Date.now() - InheritanceService.NEVER_ATTEMPTED_GRACE_MS)
    const stalled = await this.db.inheritanceCase.findMany({
      where: {
        status: {
          in: [
            InheritanceStatus.PENDING,
            InheritanceStatus.SETTLED_DEBTS,
            InheritanceStatus.TRANSFERRED
          ]
        },
        attempts: { lt: InheritanceService.MAX_RECOVERY_ATTEMPTS },
        // دو شکلِ «گیرکرده»: یا تلاش کرده و شکست خورده، یا هرگز حتی یک بار
        // پردازش نشده (سقوطِ پروسه بین ساخت پرونده و اجرای آن).
        OR: [{ lastError: { not: null } }, { attempts: 0, openedAt: { lt: neverAttemptedBefore } }]
      },
      take: Math.max(1, limit),
      select: { deceasedId: true }
    })

    let recovered = 0
    for (const row of stalled) {
      await this.runForDeceased(row.deceasedId).catch((error) => {
        logger.warn({ err: error, deceasedId: row.deceasedId }, 'inheritance recovery failed')
      })
      recovered += 1
    }
    if (recovered > 0) {
      logger.info({ recovered }, 'inheritance recovery cycle completed')
    }
    return recovered
  }

  /** اجرای دوبارهٔ یک پروندهٔ نیمه‌کاره (تلاش دستی مدیر). */
  async retry(caseId: string): Promise<InheritanceSummary | null> {
    const row = await this.db.inheritanceCase.findUnique({
      where: { id: caseId },
      select: { deceasedId: true }
    })
    if (!row) return null
    return this.runForDeceased(row.deceasedId)
  }

  // ───────────────────────────────────────────────────────────────────────────
  //  مرحلهٔ ۱: بدهی‌ها
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * بدهی‌های متوفی از دارایی نقدی او تسویه می‌شود، سپس وارث قطعی می‌شود.
   *
   * ترتیب داخلی عمدی است: اول وام بانکی (وثیقه‌دار و سنگین)، بعد قرض
   * بازیکنی. اگر پول کافی نباشد، اولویت با بانک است — همان چیزی که در
   * دنیای واقعی هم وثیقه‌دار مقدم است.
   */
  private async settleDebts(caseId: string): Promise<void> {
    const row = await this.db.inheritanceCase.findUnique({
      where: { id: caseId },
      include: {
        deceased: {
          select: { id: true, firstName: true, lastName: true, balance: true }
        }
      }
    })
    if (!row || row.status !== InheritanceStatus.PENDING) return

    const heir = await this.resolveHeir(row.deceasedId)

    // ── بدون وارث: دارایی محفوظ می‌ماند و پرونده باز می‌ماند ──
    if (!heir) {
      const claimed = await this.db.inheritanceCase.updateMany({
        where: { id: caseId, status: InheritanceStatus.PENDING },
        data: {
          status: InheritanceStatus.NO_HEIR,
          snapshot: (await this.estateSnapshot(row.deceasedId)) as unknown as Prisma.InputJsonValue,
          lastError: 'no_valid_heir'
        }
      })
      if (claimed.count === 1) {
        await this.notificationService
          ?.notifyPlayerById(
            row.deceasedId,
            '⚰️ پروندهٔ میراث بدون وارث',
            'شخصیتت از دنیا رفت و وصیتِ معتبری برای انتقال دارایی‌ها ثبت نشده بود. دارایی‌ها محفوظ مانده‌اند تا تعیین تکلیف شوند. اگر هنوز می‌توانی بازی کنی، از پنل «وصیت» یک وارث انتخاب کن.',
            undefined,
            `inheritance-noheir:${caseId}`,
            'INTERNAL'
          )
          .catch(() => undefined)
      }
      return
    }

    const debitPlan = await this.planDebtSettlement(row.deceasedId)

    await this.db.$transaction(async (tx) => {
      const claimed = await tx.inheritanceCase.updateMany({
        where: { id: caseId, status: InheritanceStatus.PENDING },
        data: {
          status: InheritanceStatus.SETTLED_DEBTS,
          heirId: heir.id,
          attempts: { increment: 1 }
        }
      })
      // رقابت: مسیر دیگری همین حالا مرحله را جلو برده است
      if (claimed.count !== 1) return

      let cash = money(row.deceased.balance)
      let settled = 0
      let unpaid = 0

      for (const loan of debitPlan.bankLoans) {
        const remaining = money(loan.remainingAmount)
        const payment = Math.min(cash, remaining)
        if (payment <= 0) {
          unpaid += remaining
          continue
        }
        const debited = await tx.player.updateMany({
          where: { id: row.deceasedId, balance: { gte: payment } },
          data: { balance: { decrement: payment } }
        })
        if (debited.count !== 1) {
          unpaid += remaining
          continue
        }
        cash -= payment
        settled += payment

        const split = splitRepayment(loan, payment)
        await this.pool.creditRepayment(tx, split.principal, split.interest)
        const closed = remaining - payment
        await tx.loan.updateMany({
          where: { id: loan.id, status: 'ACTIVE', remainingAmount: loan.remainingAmount },
          data: {
            remainingAmount: closed,
            status: closed <= 0 ? 'PAID' : 'ACTIVE'
          }
        })
        if (split.principal > 0) {
          await tx.financialTransaction.create({
            data: {
              amount: split.principal,
              type: TransactionType.LOAN_REPAYMENT,
              sourcePlayerId: row.deceasedId,
              reference: 'تسویهٔ وام بانکی از میراث (اصل)'
            }
          })
        }
        if (split.interest > 0) {
          await tx.financialTransaction.create({
            data: {
              amount: split.interest,
              type: TransactionType.LOAN_INTEREST,
              sourcePlayerId: row.deceasedId,
              reference: 'سود وام — تسویه از میراث (درآمد بانک)'
            }
          })
        }
        unpaid += closed
      }

      for (const loan of debitPlan.borrowedFromPlayers) {
        const totalRepay = money(loan.totalRepay)
        const principal = money(loan.principal)
        const lenderShare = Math.round(principal * (1 + Number(loan.feeRate ?? 0)))
        const payment = Math.min(cash, totalRepay)
        if (payment <= 0) {
          unpaid += totalRepay
          continue
        }
        const debited = await tx.player.updateMany({
          where: { id: row.deceasedId, balance: { gte: payment } },
          data: { balance: { decrement: payment } }
        })
        if (debited.count !== 1) {
          unpaid += totalRepay
          continue
        }
        cash -= payment
        settled += payment

        // همان تقسیمِ `PlayerLoanService`: اول سهم وام‌دهنده، باقی کارمزد سیستم
        const lenderPart = Math.min(payment, lenderShare)
        const feePart = payment - lenderPart
        if (lenderPart > 0) {
          await tx.player.update({
            where: { id: loan.lenderId },
            data: { balance: { increment: lenderPart } }
          })
          await tx.financialTransaction.create({
            data: {
              amount: lenderPart,
              type: TransactionType.P2P_LOAN_REPAY,
              sourcePlayerId: row.deceasedId,
              destinationPlayerId: loan.lenderId,
              reference: 'تسویهٔ قرض بازیکنی از میراث'
            }
          })
        }
        if (feePart > 0) {
          await tx.financialTransaction.create({
            data: {
              amount: feePart,
              type: TransactionType.P2P_LOAN_REPAY,
              sourcePlayerId: row.deceasedId,
              reference: 'کارمزد سیستم قرض بازیکنی (تسویه از میراث)'
            }
          })
        }

        const remaining = totalRepay - payment
        await tx.playerLoan.updateMany({
          where: { id: loan.id, status: 'ACTIVE' },
          data: remaining <= 0 ? { status: 'PAID', paidAt: new Date() } : { status: 'DEFAULTED' }
        })
        unpaid += remaining
      }

      // درخواست‌های قرضِ باز که بدهکارشان می‌توانست متوفی باشد: اگر وام‌دهنده
      // تأیید کند، پول به کیفِ یک شخصیت مرده می‌رود و برای همیشه گیر می‌کند.
      await tx.playerLoan.updateMany({
        where: { borrowerId: row.deceasedId, status: 'PENDING' },
        data: { status: 'REJECTED' }
      })

      const snapshot = await this.estateSnapshot(row.deceasedId, tx)
      await tx.inheritanceCase.update({
        where: { id: caseId },
        data: {
          debtSettled: settled,
          debtUnpaid: unpaid,
          snapshot: {
            ...snapshot,
            phase: 'SETTLED_DEBTS'
          } as unknown as Prisma.InputJsonValue
        }
      })
    })
  }

  // ───────────────────────────────────────────────────────────────────────────
  //  مرحلهٔ ۲: دارایی‌ها
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * انتقال دارایی‌های متوفی به وارث.
   *
   * نکته‌های طراحی:
   *   • موجودی حساب بانکی به **کیف پول وارث** می‌رود، نه حسابِ او: حساب
   *     بانکی شمارهٔ کارتِ یکتا دارد و ساختنِ حسابِ تازه برای وارث یعنی
   *     اختراع شمارهٔ کارت. انتقال به کیف پول همان پول است بدون هیچ داده‌ی ساختگی.
   *   • سپرده‌های مدت‌دار، انبار و کسب‌وکار «قرارداد» هستند و منتقل می‌شوند
   *     (نه نقد). انبار با `upsert` جمع می‌شود تا با قیدِ یگانگیِ هر ردیف
   *     تعارضی پیش نیاید.
   *   • ملکِ اجاره‌داده‌شده با مستأجرش دست‌نخورده منتقل می‌شود؛ اجاره‌بها از
   *     این لحظه به مالکِ تازه می‌رسد.
   */
  private async transferAssets(caseId: string): Promise<void> {
    const row = await this.db.inheritanceCase.findUnique({ where: { id: caseId } })
    if (!row || row.status !== InheritanceStatus.SETTLED_DEBTS || !row.heirId) return
    const deceasedId = row.deceasedId
    const heirId = row.heirId

    await this.db.$transaction(async (tx) => {
      const claimed = await tx.inheritanceCase.updateMany({
        where: { id: caseId, status: InheritanceStatus.SETTLED_DEBTS },
        data: { status: InheritanceStatus.TRANSFERRED }
      })
      if (claimed.count !== 1) return

      let cashTransferred = 0
      let holdings = 0

      // ── نقد: نصف به وارث، نصف به صندوق منطقه ──
      //
      // دارایی نقدی برخلاف ملک و کسب‌وکار «قرارداد» نیست و نمی‌توان همان را
      // دست‌نخورده تحویل داد: بازیکن با داشتنِ یک وارث، تمام موجودیِ زندگیِ
      // قبلی را یک‌جا به زندگیِ بعدی نمی‌برد. نصف به وارث می‌رسد و نصف از
      // دستِ خصوصی بیرون می‌رود.
      //
      // مقصد همان تنها Sink رسمیِ اقتصاد است: صندوق منطقه
      // (`RegionFundService` + ردیف `UNCLAIMED_ESTATE`) — همان مسیری که
      // داراییِ بی‌وارث هم از آن می‌رود. بدونِ این مقصد، پول بی‌ردیف نابود
      // می‌شد و ممیزیِ اقتصاد آن را «پول گم‌شده» می‌دید.
      const deceased = await tx.player.findUnique({
        where: { id: deceasedId },
        select: { balance: true, homeGroupId: true, currentRegionId: true }
      })
      const wallet = money(deceased?.balance)
      const account = await tx.bankAccount.findUnique({
        where: { playerId: deceasedId },
        select: { balance: true }
      })
      const bank = money(account?.balance)
      const totalCash = wallet + bank
      // نیمهٔ کوچک‌تر به صندوق می‌رود و باقی‌اش به وارث؛ جمعِ دو نیمه دقیقاً کل
      // است، پس هیچ تومانی نه ساخته و نه گم می‌شود (مبلغِ فرد: یک تومان به وارث).
      const estateShare = Math.floor(totalCash / 2)
      const heirShare = totalCash - estateShare

      const drainedWallet =
        wallet > 0
          ? await tx.player.updateMany({
              where: { id: deceasedId, balance: { gte: wallet } },
              data: { balance: { decrement: wallet } }
            })
          : { count: 1 }
      const drainedBank =
        bank > 0
          ? await tx.bankAccount.updateMany({
              where: { playerId: deceasedId, balance: { gte: bank } },
              data: { balance: { decrement: bank } }
            })
          : { count: 1 }

      // تخلیهٔ کامل نقد، شرطِ تقسیم است: اگر یک منبعِ نقد در همین لحظه عوض شده
      // باشد، هیچ نیمه‌ای جابه‌جا نمی‌شود (نه نیمهٔ وارث، نه نیمهٔ صندوق).
      const drained = drainedWallet.count === 1 && drainedBank.count === 1

      if (drained && totalCash > 0) {
        if (heirShare > 0) {
          await tx.player.update({
            where: { id: heirId },
            data: { balance: { increment: heirShare } }
          })
          await tx.financialTransaction.create({
            data: {
              amount: heirShare,
              type: TransactionType.INHERITANCE_TRANSFER,
              sourcePlayerId: deceasedId,
              destinationPlayerId: heirId,
              reference: 'انتقال میراث — نیمهٔ وارث از دارایی نقدی'
            }
          })
          cashTransferred += heirShare
        }

        if (estateShare > 0) {
          const groupId = deceased?.homeGroupId ?? deceased?.currentRegionId ?? null
          if (groupId) {
            await this.regionFund.credit(tx, groupId, estateShare)
          }
          await tx.financialTransaction.create({
            data: {
              amount: estateShare,
              type: TransactionType.UNCLAIMED_ESTATE,
              sourcePlayerId: deceasedId,
              reference: groupId
                ? 'میراث — نیمهٔ صندوق منطقه'
                : 'میراث — نیمهٔ بی‌وارث (بدون منطقهٔ ثبت‌شده)'
            }
          })
        }
      }

      // ── سپرده‌های مدت‌دار: قرارداد دست‌نخورده، فقط صاحبش عوض می‌شود ──
      const deposits = await tx.termDeposit.updateMany({
        where: { playerId: deceasedId, status: 'ACTIVE' },
        data: { playerId: heirId }
      })
      holdings += deposits.count

      // ── ملک ──
      const properties = await tx.property.updateMany({
        where: { ownerId: deceasedId },
        data: { ownerId: heirId }
      })

      // ── کسب‌وکار ──
      const businesses = await tx.business.updateMany({
        where: { ownerId: deceasedId },
        data: { ownerId: heirId }
      })

      // ── انبار: ادغام با انبار وارث ──
      const inventory = await tx.playerInventory.findMany({ where: { playerId: deceasedId } })
      for (const row2 of inventory) {
        if (row2.quantity <= 0) {
          await tx.playerInventory.delete({ where: { id: row2.id } })
          continue
        }
        await tx.playerInventory.upsert({
          where: { playerId_itemId: { playerId: heirId, itemId: row2.itemId } },
          create: { playerId: heirId, itemId: row2.itemId, quantity: row2.quantity },
          update: { quantity: { increment: row2.quantity } }
        })
        await tx.playerInventory.delete({ where: { id: row2.id } })
        holdings += 1
      }

      // ── حیوان خانگی: قیدِ «هر بازیکن یک حیوان» اجازهٔ انتقال بی‌قید نمی‌دهد ──
      const heirPet = await tx.pet.findUnique({ where: { playerId: heirId } })
      if (!heirPet) {
        const pet = await tx.pet.updateMany({
          where: { playerId: deceasedId },
          data: { playerId: heirId }
        })
        holdings += pet.count
      }

      // ── طلب‌های متوفی (قرض‌هایی که او داده بود) به وارث می‌رسد ──
      const receivables = await tx.playerLoan.updateMany({
        where: { lenderId: deceasedId, status: 'ACTIVE' },
        data: { lenderId: heirId }
      })
      holdings += receivables.count

      await tx.inheritanceCase.update({
        where: { id: caseId },
        data: {
          cashTransferred,
          propertiesCount: properties.count,
          businessesCount: businesses.count,
          holdingsCount: holdings,
          snapshot: {
            ...((row.snapshot as unknown as EstateSnapshot) ?? {}),
            phase: 'TRANSFERRED'
          } as unknown as Prisma.InputJsonValue
        }
      })
    })
  }

  // ───────────────────────────────────────────────────────────────────────────
  //  مرحلهٔ ۳: بستن پرونده و اعلان‌ها
  // ───────────────────────────────────────────────────────────────────────────

  private async closeCase(caseId: string): Promise<void> {
    const row = await this.db.inheritanceCase.findUnique({
      where: { id: caseId },
      include: {
        heir: { select: { id: true, firstName: true, lastName: true } },
        deceased: { select: { id: true, firstName: true, lastName: true } }
      }
    })
    if (!row || row.status !== InheritanceStatus.TRANSFERRED || !row.heir) return

    const claimed = await this.db.inheritanceCase.updateMany({
      where: { id: caseId, status: InheritanceStatus.TRANSFERRED },
      data: { status: InheritanceStatus.COMPLETED, completedAt: new Date() }
    })
    // اعلان فقط اگر همین فراخوانی پرونده را بست (ضدتکرار ساختاری، نه فقط کلید)
    if (claimed.count !== 1) return

    const heirName = displayName(row.heir)
    const deceasedName = displayName(row.deceased)
    const cash = money(row.cashTransferred)

    await this.notificationService
      ?.notifyPlayerById(
        row.heir.id,
        '🕯️ میراث به تو رسید',
        `${deceasedName} از دنیا رفت و دارایی‌هایش طبق وصیت به تو رسید.\n` +
          `💰 سهم تو از پول نقد و بانکی: ${cash.toLocaleString('fa-IR')} تومان\n` +
          // نیمهٔ دیگر پنهان نمی‌ماند؛ وگرنه وارث فکر می‌کند پولش گم شده.
          (money(row.cashTransferred) > 0
            ? 'نیمهٔ دیگرِ دارایی نقدی به صندوق منطقه رسید.\n'
            : '') +
          `🏠 ملک: ${row.propertiesCount.toLocaleString('fa-IR')} — 🏢 کسب‌وکار: ${row.businessesCount.toLocaleString('fa-IR')}\n` +
          (money(row.debtSettled) > 0
            ? `💳 از دارایی، ${money(row.debtSettled).toLocaleString('fa-IR')} تومان بدهی او هم تسویه شد.\n`
            : '') +
          (money(row.debtUnpaid) > 0
            ? `⚠️ ${money(row.debtUnpaid).toLocaleString('fa-IR')} تومان از بدهی‌هایش پوشش داده نشد.\n`
            : '') +
          'پنل «وصیت و میراث» را باز کن تا جزئیات پرونده را ببینی.',
        undefined,
        `inheritance-completed:${caseId}`,
        'CRITICAL'
      )
      .catch(() => undefined)

    await this.notificationService
      ?.notifyPlayerById(
        row.deceased.id,
        '⚰️ پروندهٔ میراث بسته شد',
        `دارایی‌هایت به وارثت ${heirName} منتقل شد. اگر بازیکنِ تازه‌ای می‌سازی، از پنل «وصیت» برایش وارث تعیین کن.`,
        undefined,
        `inheritance-self:${caseId}`,
        'INFORMATIONAL'
      )
      .catch(() => undefined)

    await this.eventService
      .recordPlayerEvent({
        playerId: row.heir.id,
        type: GameEventType.INHERITANCE_SETTLED,
        title: 'میراث دریافت شد',
        detail: `دارایی‌های ${deceasedName} طبق وصیت به تو رسید.`,
        amount: cash,
        dedupeKey: `inheritance-event:${caseId}`
      })
      .catch(() => undefined)
  }

  // ───────────────────────────────────────────────────────────────────────────
  //  کمکی‌ها
  // ───────────────────────────────────────────────────────────────────────────

  /** وارثِ معتبر از آخرین وصیت — یا `null` اگر وصیتی نبود/نامعتبر شد. */
  private async resolveHeir(
    ownerId: string
  ): Promise<{ id: string; firstName: string; lastName: string | null } | null> {
    const will = await this.db.will.findUnique({
      where: { ownerId },
      include: {
        heir: { select: { id: true, firstName: true, lastName: true, status: true } }
      }
    })
    if (!will) return null
    const rejection = validateHeir(ownerId, will.heir)
    if (rejection) {
      logger.info({ ownerId, reason: rejection }, 'inheritance heir rejected')
      return null
    }
    return { id: will.heir.id, firstName: will.heir.firstName, lastName: will.heir.lastName }
  }

  /**
   * عکسِ لحظه‌ای دارایی/بدهیِ یک بازیکن.
   *
   * عمداً `public` است: پنل وصیت باید **همان** عددی را به بازیکن نشان دهد که
   * لحظهٔ مرگ استفاده می‌شود. دو فرمول جدا یعنی بازیکن چیزی می‌بیند که ارث
   * نمی‌برد — کلاس باگی که این پروژه قبلاً در دستمزد هم تجربه کرده بود.
   */
  async estateSnapshot(
    playerId: string,
    tx?: Prisma.TransactionClient
  ): Promise<EstateSnapshot> {
    const db = (tx ?? this.db) as PrismaClient
    const [player, account, properties, businesses, deposits, inventory, loans, playerLoans] =
      await Promise.all([
        db.player.findUnique({ where: { id: playerId }, select: { balance: true } }),
        db.bankAccount.findUnique({ where: { playerId }, select: { balance: true } }),
        db.property.count({ where: { ownerId: playerId } }),
        db.business.count({ where: { ownerId: playerId } }),
        db.termDeposit.count({ where: { playerId, status: 'ACTIVE' } }),
        db.playerInventory.count({ where: { playerId, quantity: { gt: 0 } } }),
        db.loan.findMany({ where: { playerId, status: 'ACTIVE' }, select: { remainingAmount: true } }),
        db.playerLoan.findMany({
          where: {
            status: { in: ['ACTIVE', 'PENDING'] },
            OR: [{ borrowerId: playerId }, { lenderId: playerId }]
          },
          select: { borrowerId: true, totalRepay: true, principal: true }
        })
      ])

    const loanDebt = loans.reduce((sum, loan) => sum + money(loan.remainingAmount), 0)
    const playerLoanDebt = playerLoans
      .filter((loan) => loan.borrowerId === playerId)
      .reduce((sum, loan) => sum + money(loan.totalRepay), 0)
    const playerLoanReceivable = playerLoans
      .filter((loan) => loan.borrowerId !== playerId)
      .reduce((sum, loan) => sum + money(loan.totalRepay), 0)

    return {
      wallet: money(player?.balance),
      bank: money(account?.balance),
      properties,
      businesses,
      deposits,
      inventory,
      loanDebt,
      playerLoanDebt,
      playerLoanReceivable
    }
  }

  /** برنامهٔ تسویه: کدام وام‌ها از پولِ متوفی پرداخت می‌شوند. */
  private async planDebtSettlement(playerId: string): Promise<{
    bankLoans: Array<{
      id: string
      remainingAmount: Prisma.Decimal
      principalAmount: Prisma.Decimal
      totalRepaymentAmount: Prisma.Decimal
    }>
    borrowedFromPlayers: Array<{
      id: string
      lenderId: string
      principal: Prisma.Decimal
      totalRepay: Prisma.Decimal
      feeRate: Prisma.Decimal
    }>
  }> {
    const [bankLoans, borrowed] = await Promise.all([
      this.db.loan.findMany({
        where: { playerId, status: 'ACTIVE' },
        orderBy: { dueAt: 'asc' },
        select: {
          id: true,
          remainingAmount: true,
          principalAmount: true,
          totalRepaymentAmount: true
        }
      }),
      this.db.playerLoan.findMany({
        where: { borrowerId: playerId, status: 'ACTIVE' },
        select: {
          id: true,
          lenderId: true,
          principal: true,
          totalRepay: true,
          feeRate: true
        }
      })
    ])
    return { bankLoans, borrowedFromPlayers: borrowed }
  }

  private async summaryOf(caseId: string): Promise<InheritanceSummary | null> {
    const row = await this.db.inheritanceCase.findUnique({
      where: { id: caseId },
      include: { heir: { select: { firstName: true, lastName: true } } }
    })
    if (!row) return null
    return {
      caseId: row.id,
      status: row.status,
      heirId: row.heirId,
      heirName: row.heir ? displayName(row.heir) : null,
      cashTransferred: money(row.cashTransferred),
      debtSettled: money(row.debtSettled),
      debtUnpaid: money(row.debtUnpaid),
      propertiesCount: row.propertiesCount,
      businessesCount: row.businessesCount,
      holdingsCount: row.holdingsCount
    }
  }

  /** پروندهٔ میراثی که این بازیکن وارث آن است (برای پنل). */
  async caseAsHeir(playerId: string): Promise<InheritanceSummary | null> {
    const row = await this.db.inheritanceCase.findFirst({
      where: { heirId: playerId },
      orderBy: { openedAt: 'desc' },
      select: { id: true }
    })
    if (!row) return null
    return this.summaryOf(row.id)
  }

  /**
   * پرونده‌هایی که چرخهٔ خودکار از آن‌ها گذشته است و به تصمیم یا تلاشِ دستیِ
   * ادمین نیاز دارند.
   *
   * دامنه عمداً «آن‌هایی که ترمیم خودکار رهایشان کرده» است، نه هر پروندهٔ باز:
   * پرونده‌ای که قرار است در چرخهٔ بعدی خودش حل شود، در صفِ اپراتور فقط نویز
   * است. دو شرط باقی می‌ماند:
   *  • `NO_HEIR` — ترمیم خودکار هرگز این حالت را برنمی‌دارد؛ به تصمیم انسان
   *    نیاز دارد (وصیت تعیین وارث نکرده).
   *  • `attempts >= MAX` — سقف تلاش پر شده و از چرخه بیرون افتاده.
   *
   * چرا `FAILED` در این فهرست نیست؟ عمداً هیچ‌جا نوشته نمی‌شود: وقتی یک مرحله
   * خطا می‌دهد، پرونده در همان **وضعیت میانیِ** خود می‌ماند (PENDING یا
   * SETTLED_DEBTS یا TRANSFERRED) و همین است که ادامهٔ کار را ممکن می‌کند —
   * اگر پرونده را `FAILED` می‌کردیم، معلوم نمی‌شد کدام مرحله تمام شده و
   * انتقال باید از کجا ادامه پیدا کند. پس «گیرکردن» را `attempts` نشان
   * می‌دهد، نه یک وضعیتِ پایانی.
   *
   * هیچ دارایی‌ای در این حالت جابه‌جا نمی‌شود؛ فقط گزارش می‌شود.
   */
  async stalledCases(limit = 5): Promise<StalledInheritanceView[]> {
    const rows = await this.db.inheritanceCase.findMany({
      where: {
        status: { not: InheritanceStatus.COMPLETED },
        OR: [
          { status: InheritanceStatus.NO_HEIR },
          { attempts: { gte: InheritanceService.MAX_RECOVERY_ATTEMPTS } }
        ]
      },
      orderBy: { openedAt: 'asc' },
      take: Math.max(1, Math.min(20, limit)),
      select: {
        id: true,
        status: true,
        attempts: true,
        lastError: true,
        openedAt: true,
        cashTransferred: true,
        debtUnpaid: true,
        propertiesCount: true,
        businessesCount: true,
        deceased: { select: { firstName: true, lastName: true } },
        heir: { select: { firstName: true, lastName: true } }
      }
    })

    return rows.map((row) => ({
      caseId: row.id,
      status: row.status,
      attempts: row.attempts,
      lastError: row.lastError,
      openedAt: row.openedAt,
      deceasedName: displayName(row.deceased),
      heirName: row.heir ? displayName(row.heir) : null,
      cashTransferred: money(row.cashTransferred),
      debtUnpaid: money(row.debtUnpaid),
      propertiesCount: row.propertiesCount,
      businessesCount: row.businessesCount
    }))
  }
}
