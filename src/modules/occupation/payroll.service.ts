import { NotificationType, Prisma, PrismaClient, TransactionType } from '@prisma/client'
import { ConflictError, NotFoundError } from '../../utils/classes/errors'
import { money } from '../../utils/format'
import {
  REAL_MS_PER_GAME_DAY,
  dayIndex,
  gameMinutes,
  gameMonthStart,
  monthIndex
} from '../../utils/game-time'
import type { NotificationLevel } from '../notification/push'
import {
  closedGameMonthRange,
  employeeProductivity,
  minutesSince,
  projectPayroll,
  remainingContractMinutes,
  salaryAnchorAt,
  underworkMessage,
  underworkReport,
  type PayrollProjection
} from './payroll-math'
import { creditedMinutesOf, completedShifts, deliveredMinutes, type WorkShift } from './work-minutes'
import { educationRankOf, workMultiplier } from '../life/life-core'
import { effectiveAge } from '../lifecycle/game-calendar'
import { BUSINESS_BLUEPRINTS } from './work-blueprints'
import { TaxService } from '../economy/tax.service'
import { incomeTaxOf } from '../../config/economy'

export interface PayrollLine {
  employeeTitle: string
  playerId: string
  accrued: number
  owed: number
  /** حقوق ناخالصی که از خزانه کسر شد (هزینهٔ واقعی کسب‌وکار). */
  paid: number
  /** مالیات بر درآمدِ کسرشده در مبدأ از همین مبلغ. */
  tax: number
  /** مبلغی که به کیف پول کارمند رسید (`paid - tax`). */
  net: number
  unpaid: number
}

export interface PayrollSettlement {
  businessId: string
  businessName: string
  elapsedMinutes: number
  /** دقیقهٔ کارِ تحویل‌شده‌ای که درآمد را ساخت (نه زمانِ گذشته). */
  deliveredMinutes: number
  /** توان واقعی نیرو (فقط کسانی که در این بازه کار کردند) — نه تعداد سر. */
  staffPower: number
  staffingFactor: number
  activeEmployees: number
  grossRevenue: number
  operatingCost: number
  totalPayroll: number
  /** جمع مالیات بر درآمدِ کسرشده از حقوق کارمندان (واریز به صندوق منطقه). */
  totalTax: number
  netProfit: number
  treasuryBefore: number
  treasuryAfter: number
  paidEmployees: number
  unpaidEmployees: number
  totalUnpaidDebt: number
  lines: PayrollLine[]
  skipped: boolean
  note?: string
}

/**
 * یک پرداخت حقوق که واقعاً پول جابه‌جا کرده — ورودی اعلانِ کارمند.
 *
 * چرا جدا از `PayrollLine`؟ خطِ تسویه برای پنلِ مالک ساخته می‌شود و کارمندِ
 * بدون پرداخت هم در آن هست؛ اعلان فقط باید برای کسی برود که پول گرفته.
 */
interface PaidSalary {
  playerId: string
  title: string
  gross: number
  tax: number
  net: number
}

/** حداقل فاصلهٔ زمانی بین دو تسویهٔ حقوق (جلوگیری از پرداخت مضاعف). */
const MIN_SETTLE_INTERVAL_MS = 60 * 1000

/**
 * سقفِ ایمنیِ پایشِ کم‌کارکردی در هر چرخه.
 *
 * یک چرخه باید سریع تمام شود تا ری‌استارت یا چرخهٔ بعدی را معطل نکند؛ دنیای
 * بزرگ‌تر از این عدد در چرخه‌های بعدی بازبینی می‌شود و چون کلیدِ ضدتکرار
 * ماهانه است، هیچ کارمندی هشدارش را از دست نمی‌دهد.
 */
const UNDERWORK_BATCH_LIMIT = 500

/** کارمندانی که در تسویه حساب می‌شوند: فعال‌ها + بدهی‌دارانِ سابق. */
const EMPLOYEE_SELECT = {
  id: true,
  playerId: true,
  title: true,
  salaryPerMinute: true,
  contractMinutesPerMonth: true,
  unpaidSalary: true,
  hiredAt: true,
  paidUntilAt: true,
  isActive: true
} as const

const EMPLOYEE_INCLUDE = {
  where: { OR: [{ isActive: true }, { unpaidSalary: { gt: 0 } }] },
  select: EMPLOYEE_SELECT,
  orderBy: { playerId: 'asc' as const }
}

type SettlementEmployee = {
  id: string
  playerId: string
  title: string
  salaryPerMinute: Prisma.Decimal
  contractMinutesPerMonth: number
  unpaidSalary: Prisma.Decimal
  hiredAt: Date
  paidUntilAt: Date | null
  isActive: boolean
}

type SettlementBusiness = {
  id: string
  name: string
  ownerId: string
  modelType: string
  status: string
  treasury: Prisma.Decimal
  lastPayrollAt: Date
  activeEmployees: number
  employeeCapacity: number
  baseRevenuePerMinute: Prisma.Decimal
  operatingCostPerMinute: Prisma.Decimal
  employees: SettlementEmployee[]
}

/**
 * حسابداری کسب‌وکار: درآمد وابسته به نیروی انسانی، هزینهٔ عملیاتی و حقوق.
 *
 * تمام محاسبات Timestamp-based هستند (بدون Timer دائمی) و کل تسویه در یک
 * تراکنش اتمیک با شرط روی `lastPayrollAt` انجام می‌شود تا دو درخواست همزمان
 * نتوانند دو بار حقوق بپردازند. فرمول مشترک در `payroll-math` است تا
 * پیش‌نمایش و تسویه هرگز از هم واگرا نشوند.
 */
export class PayrollService {
  private readonly tax = new TaxService()

  constructor(
    private readonly db: PrismaClient,
    private readonly notificationService?: {
      announce: (input: {
        playerId: string
        title: string
        message: string
        type?: NotificationType
        level: NotificationLevel
        dedupeKey?: string
      }) => Promise<boolean>
    }
  ) {}

  /** پیش‌نمایش تسویه بدون اعمال تغییرات. */
  async previewSettlement(businessId: string, ownerPlayerId: string): Promise<PayrollSettlement> {
    const business = await this.db.business.findUnique({
      where: { id: businessId },
      include: { employees: EMPLOYEE_INCLUDE }
    }) as SettlementBusiness | null
    if (!business) {
      throw new NotFoundError('Business not found', 'کسب‌وکار موردنظر یافت نشد. فهرست «کسب‌وکار» را دوباره باز کن.')
    }
    if (business.ownerId !== ownerPlayerId) {
      throw new ConflictError('Access denied', 'این کسب‌وکار متعلق به تو نیست. از «کسب‌وکار» شرکت خودت را انتخاب کن.')
    }

    const elapsedMinutes = minutesSince(business.lastPayrollAt)
    const context = await this.employeeContext(this.db, business)
    const [work, priorMonth] = await Promise.all([
      this.businessWork(
        this.db,
        business,
        business.lastPayrollAt,
        elapsedMinutes,
        context.productivity
      ),
      this.priorMonthWork(this.db, business, business.lastPayrollAt)
    ])
    const projection = projectPayroll({
      baseRevenuePerMinute: Number(business.baseRevenuePerMinute),
      operatingCostPerMinute: Number(business.operatingCostPerMinute),
      activeEmployees: business.activeEmployees,
      capacity: business.employeeCapacity,
      elapsedMinutes,
      treasury: Number(business.treasury),
      deliveredMinutes: work.delivered,
      ownerWorkedMinutes: work.ownerWorkedMinutes,
      lines: this.linesFor(
        business,
        elapsedMinutes,
        context.productivity,
        work.shifts,
        priorMonth
      )
    })

    return this.toSettlement(business, elapsedMinutes, projection, 'پیش‌نمایش', elapsedMinutes <= 0)
  }

  /**
   * تسویهٔ واقعی حقوق و ثبت درآمد.
   *
   * ترتیب: درآمد به خزانه → کسر هزینهٔ عملیاتی → پرداخت حقوق تا سقف خزانه.
   * اگر خزانه کافی نباشد، مانده به‌عنوان بدهی حقوقی ثبت می‌شود (پول از هیچ
   * ساخته نمی‌شود) و در تسویه‌های بعدی پرداخت می‌گردد.
   *
   * اعلان کارمندان **بیرون** از همین تراکنش می‌رود: پول که قطعی شد خبر می‌رود،
   * تا شکست یک پیام تلگرامی حقوقِ پرداخت‌شده را برنگرداند.
   */
  async settle(businessId: string, ownerPlayerId: string): Promise<PayrollSettlement> {
    const outcome = await this.db.$transaction(async (tx) => {
      const paid: PaidSalary[] = []
      const business = await tx.business.findUnique({
        where: { id: businessId },
        include: { employees: EMPLOYEE_INCLUDE }
      }) as SettlementBusiness | null
      if (!business) {
        throw new NotFoundError('Business not found', 'کسب‌وکار موردنظر یافت نشد. فهرست «کسب‌وکار» را دوباره باز کن.')
      }
      if (business.ownerId !== ownerPlayerId) {
        throw new ConflictError('Access denied', 'این کسب‌وکار متعلق به تو نیست. از «کسب‌وکار» شرکت خودت را انتخاب کن.')
      }
      if (business.status !== 'ACTIVE') {
        throw new ConflictError('Business not active', 'این کسب‌وکار فعال نیست.')
      }

      const previousPayrollAt = business.lastPayrollAt
      const elapsedMs = Date.now() - previousPayrollAt.getTime()
      if (elapsedMs < MIN_SETTLE_INTERVAL_MS) {
        return {
          settlement: this.emptySettlement(business, 'کمتر از یک دقیقه از تسویهٔ قبلی گذشته است.'),
          paid
        }
      }

      const elapsedMinutes = minutesSince(previousPayrollAt)
      // `elapsedMinutes` دقیقهٔ بازی است؛ تبدیلش به لحظهٔ واقعی فقط با ساعت مرکزی.
      const settleAt = new Date(previousPayrollAt.getTime() + gameMinutes(elapsedMinutes))

      // قفل خوش‌بینانه روی lastPayrollAt: جلوگیری از تسویهٔ دوباره
      const claimed = await tx.business.updateMany({
        where: { id: business.id, lastPayrollAt: previousPayrollAt, status: 'ACTIVE' },
        data: { lastPayrollAt: settleAt }
      })
      if (claimed.count !== 1) {
        return {
          settlement: this.emptySettlement(business, 'تسویه همین حالا توسط درخواست دیگری انجام شد.'),
          paid
        }
      }

      // بهره‌وری واقعی کارمندان + منطقهٔ هرکدام (برای مالیات حقوق) در یک کوئری
      const context = await this.employeeContext(tx, business)
      // کارکردِ ثبت‌شدهٔ همین بازه: پایهٔ حقوق و پایهٔ درآمد، هر دو از یک کوئری
      const [work, priorMonth] = await Promise.all([
        this.businessWork(
          tx,
          business,
          previousPayrollAt,
          elapsedMinutes,
          context.productivity
        ),
        this.priorMonthWork(tx, business, previousPayrollAt)
      ])
      const projection = projectPayroll({
        baseRevenuePerMinute: Number(business.baseRevenuePerMinute),
        operatingCostPerMinute: Number(business.operatingCostPerMinute),
        activeEmployees: business.activeEmployees,
        capacity: business.employeeCapacity,
        elapsedMinutes,
        treasury: Number(business.treasury),
        deliveredMinutes: work.delivered,
        ownerWorkedMinutes: work.ownerWorkedMinutes,
        lines: this.linesFor(
          business,
          elapsedMinutes,
          context.productivity,
          work.shifts,
          priorMonth
        )
      })

      if (projection.grossRevenue > 0) {
        await tx.financialTransaction.create({
          data: {
            amount: projection.grossRevenue,
            type: TransactionType.BUSINESS_REVENUE,
            destinationBusinessId: business.id,
            reference: `درآمد ${projection.deliveredMinutes} دقیقه کارکرد`
          }
        })
      }

      for (const [index, emp] of business.employees.entries()) {
        const line = projection.lines[index]!
        if (line.paid > 0) {
          const taxed = await this.tax.withholdIncomeTax(tx, {
            playerId: emp.playerId,
            gross: line.paid,
            reference: `حقوق ${emp.title}`,
            groupId: context.regionOf.get(emp.playerId) ?? null
          })

          await tx.player.update({
            where: { id: emp.playerId },
            data: { balance: { increment: taxed.net } }
          })
          await tx.financialTransaction.create({
            data: {
              amount: line.paid,
              type: TransactionType.SALARY_PAYMENT,
              sourceBusinessId: business.id,
              destinationPlayerId: emp.playerId,
              reference: `حقوق ${emp.title}`
            }
          })
          paid.push({
            playerId: emp.playerId,
            title: emp.title,
            gross: taxed.gross,
            tax: taxed.tax,
            net: taxed.net
          })
        }
        const newUnpaid = line.unpaid
        const newAnchor = emp.isActive ? settleAt : (emp.paidUntilAt ?? emp.hiredAt)
        if (newUnpaid !== Number(emp.unpaidSalary) || (emp.isActive && !emp.paidUntilAt)) {
          await tx.businessEmployee.update({
            where: { id: emp.id },
            data: { unpaidSalary: newUnpaid, paidUntilAt: newAnchor }
          })
        }
      }

      // خزانه در یک نوشتار: درآمد، هزینهٔ عملیاتی و حقوق پرداخت‌شده
      // همین‌جا منظور می‌شوند. قفل lastPayrollAt در همین تراکنش، هر
      // تسویهٔ همزمان دیگری را بی‌اثر می‌کند.
      await tx.business.update({
        where: { id: business.id },
        data: {
          treasury: projection.treasuryAfter,
          totalRevenue: { increment: projection.grossRevenue },
          totalOperatingCost: { increment: projection.operatingCost },
          totalPayroll: { increment: projection.totalPayroll }
        }
      })

      return {
        settlement: this.toSettlement(business, elapsedMinutes, projection, undefined, false),
        paid
      }
    })

    await this.announceSalaries(
      { id: businessId, name: outcome.settlement.businessName },
      outcome.paid
    )

    return outcome.settlement
  }

  /**
   * خبرِ واریز حقوق به هر کارمندی که این نوبت پول گرفته است.
   *
   * پیش از این کارمند هیچ‌وقت نمی‌فهمید حقوقش واریز شده؛ فقط موجودی کیف پولش
   * بی‌صدا بالا می‌رفت و اگر مالک تسویه نمی‌کرد، فرقی برایش نداشت. سطح
   * CRITICAL است چون قراردادِ خودِ `push.ts` پولِ قطعی را همین‌طور تعریف کرده.
   * کلید ضدتکرار روزانه است (`salary:<کسب‌وکار>:<کارمند>:<روز>`): مالک می‌تواند
   * در یک روز چند بار تسویه کند و کارمند نباید برای هر بار پیام بگیرد
   * (بندِ «بدون اسپم» در معماری اعلان).
   */
  private async announceSalaries(
    business: { id: string; name: string },
    paid: PaidSalary[]
  ): Promise<void> {
    if (!this.notificationService || paid.length === 0) {
      return
    }
    // یک ردیف دفترِ کل برای اثبات هر پرداخت ثبت شده؛ اینجا فقط خبر است.
    for (const line of paid) {
      await this.notificationService
        .announce({
          playerId: line.playerId,
          type: NotificationType.EVENT,
          level: 'CRITICAL',
          dedupeKey: `salary:${business.id}:${line.playerId}:${dayIndex()}`,
          title: '💵 حقوقت واریز شد',
          message: [
            `کارفرما: ${business.name}`,
            `سمت: ${line.title}`,
            `ناخالص: ${money(line.gross)} تومان`,
            line.tax > 0
              ? `مالیات بر درآمد (کسر از مبدأ): ${money(line.tax)} تومان`
              : 'مالیات بر درآمد: ندارد',
            `واریز به کیف پول: ${money(line.net)} تومان`
          ].join('\n')
        })
        .catch(() => undefined)
    }
  }

  /**
   * پایشِ ماهانهٔ کارکرد — کم‌کارکردیِ هر کارمند را به کارفرمایش خبر می‌دهد.
   *
   * ## چرا یک چرخهٔ مستقل و نه لایِ تسویه؟
   * تسویه وقتی رخ می‌دهد که کارفرما دکمه بزند. اگر کسب‌وکاری روزها تسویه
   * نکند، گزارشِ عملکردش هم روزها دیر می‌شد. این پایش به ساعتِ بازی گره خورده
   * است: به‌محض بسته‌شدن یک ماهِ بازی، بازبینی انجام می‌شود.
   *
   * ## ضدتکرار (بدون حالتِ درون‌حافظه)
   * `dedupeKey` شاملِ شناسهٔ کارمند و شمارهٔ ماهِ بسته‌شده است، پس هر کارمند
   * در هر ماهِ بازی **حداکثر یک بار** هشدار می‌گیرد — حتی اگر چرخه ده بار
   * اجرا شود یا ربات وسطِ کار ری‌استارت شود. هیچ حالتی در حافظه نگه داشته
   * نمی‌شود، چون ری‌استارت آن را پاک می‌کرد و حرکتِ ماه دوباره هشدار می‌داد.
   *
   * ## مرزهای تصمیم
   *  • کارمندِ خودِ مالک بررسی نمی‌شود؛ گزارشِ کم‌کاری به خود بی‌معناست.
   *  • استخدامِ وسطِ ماه به نسبتِ روزهای در دسترس سنجیده می‌شود تا هر تازه‌وارد
   *    «کم‌کار» اعلام نشود.
   *  • سیستم هیچ‌وقت کسی را اخراج یا قراردادی را عوض نمی‌کند؛ فقط خبر می‌دهد.
   *    تصمیم، دستِ کارفرماست.
   *
   * @returns تعداد کارمندهای بازبینی‌شده و هشدارهای تازه‌ای که رفت.
   */
  async notifyUnderworked(now: number = Date.now()): Promise<{ checked: number; warned: number }> {
    if (!this.notificationService) {
      return { checked: 0, warned: 0 }
    }
    const { start: monthStart, end: monthEnd } = closedGameMonthRange(now)
    const monthKey = monthIndex(monthEnd.getTime())

    const employees = await this.db.businessEmployee.findMany({
      where: { isActive: true },
      take: UNDERWORK_BATCH_LIMIT,
      select: {
        id: true,
        playerId: true,
        contractMinutesPerMonth: true,
        hiredAt: true,
        player: { select: { firstName: true, lastName: true } },
        business: { select: { id: true, name: true, ownerId: true } }
      }
    })
    if (employees.length === 0) {
      return { checked: 0, warned: 0 }
    }

    // یک کوئری برای هر کسب‌وکار (نه هر کارمند): تعداد نیرو کوئری اضافه نسازد.
    const byBusiness = new Map<string, typeof employees>()
    for (const emp of employees) {
      const list = byBusiness.get(emp.business.id)
      if (list) {
        list.push(emp)
      } else {
        byBusiness.set(emp.business.id, [emp])
      }
    }

    let warned = 0
    for (const [businessId, list] of byBusiness) {
      const shifts = await completedShifts(this.db, businessId, monthStart, monthEnd)
      for (const emp of list) {
        if (emp.playerId === emp.business.ownerId) {
          continue
        }
        const coveredFrom = Math.max(monthStart.getTime(), emp.hiredAt.getTime())
        const availableDays = Math.floor(
          (monthEnd.getTime() - coveredFrom) / REAL_MS_PER_GAME_DAY
        )
        if (availableDays <= 0) {
          continue
        }
        const report = underworkReport({
          contractMinutes: emp.contractMinutesPerMonth,
          workedMinutes: creditedMinutesOf(shifts, emp.playerId, monthStart),
          availableDays
        })
        if (!report.shouldWarn) {
          continue
        }
        const employeeName = `${emp.player.firstName} ${emp.player.lastName ?? ''}`.trim()
        const delivered = await this.notificationService
          .announce({
            playerId: emp.business.ownerId,
            level: 'IMPORTANT',
            type: NotificationType.WARNING,
            title: `⚠️ عملکردِ این ماه — ${emp.business.name}`,
            message: underworkMessage({ employeeName, report }),
            dedupeKey: `underwork:${emp.id}:${monthKey}`
          })
          .catch(() => false)
        if (delivered) {
          warned += 1
        }
      }
    }
    return { checked: employees.length, warned }
  }

  /**
   * کارکردِ ثبت‌شدهٔ همین بازه در این کسب‌وکار.
   *
   * `windowEnd` همان لحظه‌ای است که `lastPayrollAt` به آن منتقل می‌شود؛ پس
   * شیفتی که بعد از آن تمام شود به تسویهٔ بعدی می‌رود و دو بار شمرده نمی‌شود.
   * پیش‌نمایش و تسویه هر دو از همین تابع رد می‌شوند تا هرگز واگرا نشوند.
   */
  private async businessWork(
    db: Prisma.TransactionClient,
    business: SettlementBusiness,
    previousPayrollAt: Date,
    elapsedMinutes: number,
    productivity: Map<string, number>
  ): Promise<{ shifts: WorkShift[]; delivered: number; ownerWorkedMinutes: number }> {
    const windowEnd = new Date(previousPayrollAt.getTime() + gameMinutes(elapsedMinutes))
    const shifts = await completedShifts(db, business.id, previousPayrollAt, windowEnd)
    return {
      shifts,
      delivered: deliveredMinutes(shifts, (playerId) => productivity.get(playerId) ?? 1),
      ownerWorkedMinutes: creditedMinutesOf(shifts, business.ownerId, previousPayrollAt)
    }
  }

  /**
   * کارکردِ هر کارمند از **آغاز ماهِ بازی** تا آغاز همین بازهٔ تسویه.
   *
   * سقفِ حجم قرارداد ماهانه و تجمعی است، پس تسویه باید بداند پیش از این بازه
   * چه مقدار از قرارداد مصرف شده. یک کوئری برای کل کسب‌وکار و جمع‌زدن در حافظه،
   * پس تعداد کارمندان کوئری اضافه نمی‌سازد. اگر بازهٔ تسویه پیش از آغاز این
   * ماه باشد، کارکردِ پیشینی وجود ندارد و کوئری هم زده نمی‌شود.
   */
  private async priorMonthWork(
    db: Prisma.TransactionClient,
    business: SettlementBusiness,
    windowStart: Date
  ): Promise<Map<string, number>> {
    const monthStart = gameMonthStart()
    const out = new Map<string, number>()
    if (windowStart <= monthStart || business.employees.length === 0) {
      return out
    }
    const shifts = await completedShifts(db, business.id, monthStart, windowStart)
    for (const emp of business.employees) {
      out.set(emp.playerId, creditedMinutesOf(shifts, emp.playerId, monthStart))
    }
    return out
  }

  private linesFor(
    business: SettlementBusiness,
    elapsedMinutes: number,
    productivity: Map<string, number>,
    shifts: ReadonlyArray<WorkShift>,
    /** کارکردِ همین کارمند از آغاز ماهِ بازی تا آغاز همین بازهٔ تسویه. */
    priorMonthMinutes: Map<string, number>
  ) {
    return business.employees.map((emp) => {
      const anchor = salaryAnchorAt(business.lastPayrollAt, emp)
      return {
        salaryPerMinute: Number(emp.salaryPerMinute),
        // سقف ماهانه تجمعی است، پس آنچه در فرمول می‌رود «باقی‌مانده» است، نه کل قرارداد
        contractMinutesRemaining: remainingContractMinutes(
          emp.contractMinutesPerMonth,
          priorMonthMinutes.get(emp.playerId) ?? 0
        ),
        unpaidSalary: Number(emp.unpaidSalary),
        // کارمندِ رفته فقط بدهیِ معوقش را می‌گیرد؛ کارکرد تازه ندارد
        anchorElapsedMinutes: emp.isActive
          ? Math.max(0, Math.min(elapsedMinutes, minutesSince(anchor)))
          : 0,
        workedMinutes: emp.isActive ? creditedMinutesOf(shifts, emp.playerId, anchor) : 0,
        productivity: productivity.get(emp.playerId) ?? 1,
        isActive: emp.isActive
      }
    })
  }

  /**
   * زمینهٔ کارمندان: بهره‌وری واقعی + منطقهٔ اقامت (برای صندوق مالیات).
   *
   * بهره‌وری از همان ضرایب `life-core` می‌آید که دستمزد خودِ بازیکن را
   * می‌سازد (سلامت، خستگی، مهارت‌های موردنیاز این مدل، سابقه، مدرک، سن) و
   * در `payroll-math` در بازهٔ ۰٫۶..۱٫۵ مهار می‌شود. کارمند پیدا نشده =
   * تازه‌کار با بهره‌وری ۱، تا دادهٔ ناقص درآمد شرکت را صفر نکند.
   */
  private async employeeContext(
    db: Prisma.TransactionClient,
    business: SettlementBusiness
  ): Promise<{
    productivity: Map<string, number>
    regionOf: Map<string, string | null>
  }> {
    const productivity = new Map<string, number>()
    const regionOf = new Map<string, string | null>()
    if (business.employees.length === 0) {
      return { productivity, regionOf }
    }

    const playerIds = business.employees.map((emp) => emp.playerId)
    const skillNames =
      BUSINESS_BLUEPRINTS.find((blueprint) => blueprint.modelType === business.modelType)
        ?.requiredSkills ?? []

    const [players, skills] = await Promise.all([
      db.player.findMany({
        where: { id: { in: playerIds } },
        select: {
          id: true,
          health: true,
          fatigue: true,
          experience: true,
          currentDegree: true,
          graduationField: true,
          age: true,
          startedAt: true,
          homeGroupId: true
        }
      }),
      skillNames.length > 0
        ? db.playerSkill.findMany({
            where: { playerId: { in: playerIds }, skill: { name: { in: skillNames } } },
            select: { playerId: true, level: true }
          })
        : Promise.resolve([] as Array<{ playerId: string; level: number }>)
    ])

    for (const emp of business.employees) {
      const row = players.find((player) => player.id === emp.playerId)
      regionOf.set(emp.playerId, row?.homeGroupId ?? null)

      if (!row || !emp.isActive) {
        productivity.set(emp.playerId, 1)
        continue
      }

      const levels = skills.filter((skill) => skill.playerId === emp.playerId)
      const known = Math.min(levels.length, skillNames.length)
      const skillLevelAverage =
        skillNames.length === 0
          ? undefined
          : (levels.reduce((sum, skill) => sum + skill.level, 0) +
              (skillNames.length - known)) /
            skillNames.length

      const multiplier = workMultiplier({
        health: row.health,
        fatigue: row.fatigue,
        skillLevelAverage,
        experience: row.experience,
        educationRank: educationRankOf(row.currentDegree),
        graduationField: row.graduationField,
        jobCategory: null,
        age: effectiveAge(row.startedAt, row.age)
      }).total

      productivity.set(emp.playerId, employeeProductivity(multiplier))
    }

    return { productivity, regionOf }
  }

  private toSettlement(
    business: SettlementBusiness,
    elapsedMinutes: number,
    projection: PayrollProjection,
    note?: string,
    skipped = false
  ): PayrollSettlement {
    return {
      businessId: business.id,
      businessName: business.name,
      elapsedMinutes,
      deliveredMinutes: projection.deliveredMinutes,
      staffPower: projection.staffPower,
      staffingFactor: projection.staffingFactor,
      activeEmployees: business.activeEmployees,
      grossRevenue: projection.grossRevenue,
      operatingCost: projection.operatingCost,
      totalPayroll: projection.totalPayroll,
      totalTax: projection.lines.reduce((sum, line) => sum + incomeTaxOf(line.paid), 0),
      netProfit: projection.netProfit,
      treasuryBefore: projection.treasuryBefore,
      treasuryAfter: projection.treasuryAfter,
      paidEmployees: projection.paidEmployees,
      unpaidEmployees: projection.unpaidEmployees,
      totalUnpaidDebt: projection.totalUnpaidDebt,
      lines: projection.lines.map((line, index) => ({
        employeeTitle: business.employees[index]?.title ?? 'کارمند',
        playerId: business.employees[index]?.playerId ?? '',
        accrued: line.accrued,
        owed: line.owed,
        paid: line.paid,
        tax: incomeTaxOf(line.paid),
        net: line.paid - incomeTaxOf(line.paid),
        unpaid: line.unpaid
      })),
      skipped,
      note
    }
  }

  private emptySettlement(business: SettlementBusiness, note: string): PayrollSettlement {
    const treasury = Number(business.treasury)
    return {
      businessId: business.id,
      businessName: business.name,
      elapsedMinutes: 0,
      deliveredMinutes: 0,
      staffPower: 1,
      staffingFactor: 1,
      activeEmployees: business.activeEmployees,
      grossRevenue: 0,
      operatingCost: 0,
      totalPayroll: 0,
      totalTax: 0,
      netProfit: 0,
      treasuryBefore: treasury,
      treasuryAfter: treasury,
      paidEmployees: 0,
      unpaidEmployees: 0,
      totalUnpaidDebt: 0,
      lines: [],
      skipped: true,
      note
    }
  }
}
