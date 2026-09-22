import { GameEventType, NotificationType, PrismaClient, TermDepositStatus, TransactionType } from '@prisma/client'
import { ConflictError, NotFoundError, ValidationError } from '../../utils/classes/errors'
import { EventService } from '../events/event.service'
import { BankPoolService } from './bank-pool.service'
import { GAME_DAYS_PER_YEAR, cycleRate, daysUntil, gameDaysSince, gameDays } from '../../utils/game-time'
import type { NotificationLevel } from '../notification/push'

/**
 * نشانهٔ داخلیِ «این سپرده را درخواستِ دیگری هم‌زمان تسویه کرد».
 *
 * فقط برای آن است که تراکنشِ بازنده برگردد (با بازگشتِ کسرِ صندوق) و شمارندهٔ
 * «تسویهٔ معوق» بی‌دلیل بالا نرود؛ هرگز به بازیکن نشان داده نمی‌شود.
 */
class SettledElsewhere extends Error {}

export interface DepositPlan {
  key: string
  label: string
  termDays: number
  rateAnnual: number
}

/**
 * پلن‌های سپرده.
 * نرخ‌ها سالانه‌اند و به‌نسبت مدت محاسبه می‌شوند؛ مدت بلندتر نرخ بهتری دارد
 * چون پول برای مدت بیشتری از گردش خارج می‌شود (ضدتورم).
 */
export const DEPOSIT_PLANS: readonly DepositPlan[] = [
  // نرخ‌ها «سالانهٔ بازی» هستند و با `cycleRate` هم‌تراز شده‌اند تا سود سپرده
  // در زمان واقعی همان چیزی بماند که بود (دوره‌ها ۳۰ برابر کوتاه‌تر شده‌اند).
  { key: 'w1', label: 'یک‌هفته‌ای (۷ روز بازی)', termDays: 7, rateAnnual: cycleRate(0.2) },
  { key: 'w2', label: 'دوهفته‌ای (۱۴ روز بازی)', termDays: 14, rateAnnual: cycleRate(0.28) },
  { key: 'm1', label: 'یک‌ماهه (۳۰ روز بازی)', termDays: 30, rateAnnual: cycleRate(0.4) }
]

const MIN_PRINCIPAL = 500_000
/** سقف مجموع اصل سپرده‌های فعال هر بازیکن. */
const MAX_TOTAL_ACTIVE = 50_000_000
/** جریمهٔ شکست زودهنگام: این نسبت از سود متعلقه کسر می‌شود. */
const BREAK_PENALTY_RATE = 0.25

export interface DepositView {
  id: string
  planLabel: string
  principal: number
  termDays: number
  rateAnnual: number
  maturesAt: Date
  daysLeft: number
  matured: boolean
  projectedPayout: number
  accruedNow: number
}

export interface DepositBoard {
  plans: DepositPlan[]
  active: DepositView[]
  totalActive: number
  capacityLeft: number
  minPrincipal: number
  maturedCount: number
  /** سپرده‌های سررسیده‌ای که نقدینگی بانک برای پرداختشان کافی نبود. */
  pendingLiquidity: number
}

/**
 * سپردهٔ مدت‌دار.
 *
 * قواعد کلیدی:
 *  • اصل پول در لحظهٔ افتتاح از کیف کسر می‌شود (کسر شرطی اتمیک) — پس Sink
 *    واقعی است و پول تا سررسید از گردش خارج می‌ماند.
 *  • سررسید Lazy تسویه می‌شود: اولین بازدید بانک بعد از موعد، همهٔ سپرده‌های
 *    رسیده را یک‌جا پرداخت می‌کند. هیچ تایمری وجود ندارد.
 *  • سود هرگز از پیش پرداخت نمی‌شود و شکست زودهنگام جریمه دارد، پس چرخهٔ
 *    «افتتاح و بستن فوری» سودآور نیست.
 *  • پاداش جهانگردی: هر ۵ مُهر سفر، ۱٪ سود اضافه در سررسید (تا حداکثر ۲٪).
 */
export class DepositService {
  private readonly pool = new BankPoolService()

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

  /** پاداش مُهرهای سفر: هر ۵ مُهر = ۱٪ اضافه (سقف ۲٪). */
  private async stampBonusRateOf(playerId: string): Promise<number> {
    try {
      const stamps = await this.db.travelStamp.count({ where: { playerId } })
      return Math.min(2, Math.floor(stamps / 5)) * 0.01
    } catch {
      return 0
    }
  }

  /** سود متعلقه برای مدت سپری‌شده (به‌نسبت روز بازی؛ سال بازی ۳۶۰ روز است). */
  private accrued(principal: number, rateAnnual: number, days: number): number {
    return Math.round((principal * rateAnnual * days) / GAME_DAYS_PER_YEAR)
  }

  /** سود کامل دوره در صورت نگه‌داشتن تا سررسید. */
  private fullInterest(principal: number, rateAnnual: number, termDays: number): number {
    return this.accrued(principal, rateAnnual, termDays)
  }

  /**
   * پنل سپرده‌ها. پیش از ساخت نما، سپرده‌های سررسیدشده تسویه می‌شوند
   * تا بازیکن هیچ‌وقت «سررسیدشده اما پرداخت‌نشده» نبیند.
   */
  async getBoard(telegramUserId: bigint): Promise<DepositBoard> {
    const player = await this.requirePlayer(telegramUserId)
    const { settled, deferred } = await this.settleMatured(player.id)

    const rows = await this.db.termDeposit.findMany({
      where: { playerId: player.id, status: TermDepositStatus.ACTIVE },
      orderBy: { maturesAt: 'asc' }
    })

    const active: DepositView[] = rows.map((row) => {
      const principal = Number(row.principal)
      const rate = Number(row.rateAnnual)
      const elapsedDays = gameDaysSince(row.openedAt)
      const plan = DEPOSIT_PLANS.find((p) => p.termDays === row.termDays)

      return {
        id: row.id,
        planLabel: plan?.label ?? `${row.termDays} روزهٔ بازی`,
        principal,
        termDays: row.termDays,
        rateAnnual: rate,
        maturesAt: row.maturesAt,
        daysLeft: daysUntil(row.maturesAt),
        matured: row.maturesAt.getTime() <= Date.now(),
        projectedPayout: principal + this.fullInterest(principal, rate, row.termDays),
        accruedNow: this.accrued(principal, rate, Math.min(elapsedDays, row.termDays))
      }
    })

    const totalActive = active.reduce((sum, d) => sum + d.principal, 0)

    return {
      plans: [...DEPOSIT_PLANS],
      active,
      totalActive,
      capacityLeft: Math.max(0, MAX_TOTAL_ACTIVE - totalActive),
      minPrincipal: MIN_PRINCIPAL,
      maturedCount: settled,
      pendingLiquidity: deferred
    }
  }

  /** افتتاح سپردهٔ تازه. */
  async open(
    telegramUserId: bigint,
    planKey: string,
    principal: number
  ): Promise<{ planLabel: string; principal: number; payout: number; maturesAt: Date }> {
    const plan = DEPOSIT_PLANS.find((p) => p.key === planKey)
    if (!plan) {
      throw new NotFoundError('Plan not found', 'این پلن سپرده وجود ندارد.')
    }
    if (!Number.isSafeInteger(principal) || principal < MIN_PRINCIPAL) {
      throw new ValidationError(
        'Principal too small',
        `حداقل مبلغ سپرده ${MIN_PRINCIPAL.toLocaleString('fa-IR')} تومان است.`
      )
    }

    const player = await this.requirePlayer(telegramUserId)

    const activeAgg = await this.db.termDeposit.aggregate({
      where: { playerId: player.id, status: TermDepositStatus.ACTIVE },
      _sum: { principal: true }
    })
    const currentTotal = Number(activeAgg._sum.principal ?? 0)
    if (currentTotal + principal > MAX_TOTAL_ACTIVE) {
      throw new ValidationError(
        'Deposit cap reached',
        `سقف مجموع سپرده‌ها ${MAX_TOTAL_ACTIVE.toLocaleString('fa-IR')} تومان است؛ ` +
          `ظرفیت باقی‌ماندهٔ تو ${(MAX_TOTAL_ACTIVE - currentTotal).toLocaleString('fa-IR')} تومان است.`
      )
    }

    const maturesAt = new Date(Date.now() + gameDays(plan.termDays))

    return this.db.$transaction(async (tx) => {
      // کسر شرطی اصل پول: محافظت از Double-Spend
      const debited = await tx.player.updateMany({
        where: { id: player.id, balance: { gte: principal } },
        data: { balance: { decrement: principal } }
      })
      if (debited.count !== 1) {
        throw new ValidationError(
          'Insufficient balance',
          'موجودی کیف پولت برای این سپرده کافی نیست. مبلغ کمتری وارد کن یا ابتدا از بانک برداشت کن.'
        )
      }

      await tx.termDeposit.create({
        data: {
          playerId: player.id,
          principal,
          rateAnnual: plan.rateAnnual,
          termDays: plan.termDays,
          maturesAt
        }
      })

      await tx.financialTransaction.create({
        data: {
          amount: principal,
          // `DEPOSIT` نه `BANK_DEPOSIT`: این پول از بخش خصوصی بیرون می‌رود و در
          // ترازنامهٔ بانک می‌نشیند، ولی `BANK_DEPOSIT` یعنی «کیف پول ↔ حسابِ
          // بانکیِ خودِ بازیکن» که جابه‌جاییِ داخلیِ بخش خصوصی است. یکی بودنِ
          // این دو نوع باعث می‌شد هیچ ممیزیِ مالی نتواند بگوید کدام ردیف پول را
          // از گردش خارج کرده و کدام فقط جایش را در حسابِ خودِ بازیکن عوض کرده.
          type: TransactionType.DEPOSIT,
          sourcePlayerId: player.id,
          reference: `افتتاح سپردهٔ ${plan.label}`
        }
      })

      // پول سپرده در ترازنامهٔ بانک می‌نشیند (نه اینکه از گردش ناپدید شود)؛
      // همین پول است که وام‌ها از آن پرداخت می‌شود.
      await this.pool.creditDeposit(tx, principal)

      return {
        planLabel: plan.label,
        principal,
        payout: principal + this.fullInterest(principal, plan.rateAnnual, plan.termDays),
        maturesAt
      }
    })
  }

  /** شکست زودهنگام سپرده با جریمه روی سود. */
  async breakEarly(
    telegramUserId: bigint,
    depositId: string
  ): Promise<{ principal: number; interest: number; penalty: number; payout: number }> {
    const player = await this.requirePlayer(telegramUserId)

    const deposit = await this.db.termDeposit.findUnique({ where: { id: depositId } })
    if (!deposit || deposit.playerId !== player.id) {
      throw new NotFoundError(
        'Deposit not found',
        'این سپرده متعلق به تو نیست. در «سپرده» حساب خودت را انتخاب کن.'
      )
    }
    if (deposit.status !== TermDepositStatus.ACTIVE) {
      throw new ConflictError('Deposit closed', 'این سپرده قبلاً تسویه شده است.')
    }
    if (deposit.maturesAt.getTime() <= Date.now()) {
      throw new ConflictError(
        'Already matured',
        'این سپرده سررسید شده است؛ از دکمهٔ دریافت استفاده کن.'
      )
    }

    const principal = Number(deposit.principal)
    const rate = Number(deposit.rateAnnual)
    const elapsedDays = gameDaysSince(deposit.openedAt)
    const grossInterest = this.accrued(principal, rate, elapsedDays)
    const penalty = Math.round(grossInterest * BREAK_PENALTY_RATE)
    const interest = grossInterest - penalty
    const payout = principal + interest

    return this.db.$transaction(async (tx) => {
      // پول پرداخت از صندوق بانک بیرون می‌آید؛ بدون نقدینگی، سپرده باز می‌ماند
      const funded = await this.pool.debit(tx, payout)
      if (!funded) {
        throw new ConflictError(
          'Bank liquidity',
          'نقدینگی بانک در این لحظه کافی نیست؛ چند ساعت دیگر دوباره تلاش کن.'
        )
      }

      // شرط status: فقط یک درخواست می‌تواند سپرده را ببندد
      const closed = await tx.termDeposit.updateMany({
        where: { id: deposit.id, status: TermDepositStatus.ACTIVE },
        data: {
          status: TermDepositStatus.BROKEN,
          payout,
          settledAt: new Date()
        }
      })
      if (closed.count !== 1) {
        throw new ConflictError('Concurrent settle', 'این سپرده همین حالا تسویه شد.')
      }

      await tx.player.update({
        where: { id: player.id },
        data: { balance: { increment: payout } }
      })
      // اصل پول و سود دو ردیف جدا دارند تا دفتر کل بگوید چقدر سود بانک بوده
      await tx.financialTransaction.create({
        data: {
          amount: principal,
          type: TransactionType.DEPOSIT_PAYOUT,
          destinationPlayerId: player.id,
          reference: 'بازگشت اصل سپرده (شکست زودهنگام)'
        }
      })
      if (interest > 0) {
        await tx.financialTransaction.create({
          data: {
            amount: interest,
            type: TransactionType.DEPOSIT_INTEREST,
            destinationPlayerId: player.id,
            reference: 'سود سپرده (پس از کسر جریمهٔ شکست زودهنگام)'
          }
        })
      }

      return { principal, interest, penalty, payout }
    })
  }

  /**
   * تسویهٔ همهٔ سپرده‌های سررسیدشده.
   * هر سپرده جداگانه و اتمیک بسته می‌شود تا خطای یکی مانع بقیه نشود.
   */
  async settleMatured(playerId: string): Promise<{ settled: number; deferred: number }> {
    const matured = await this.db.termDeposit.findMany({
      where: {
        playerId,
        status: TermDepositStatus.ACTIVE,
        maturesAt: { lte: new Date() }
      }
    })
    if (matured.length === 0) {
      return { settled: 0, deferred: 0 }
    }

    const stampBonusRate = await this.stampBonusRateOf(playerId)

    let settled = 0
    let deferred = 0
    for (const deposit of matured) {
      const principal = Number(deposit.principal)
      const baseInterest = this.fullInterest(
        principal,
        Number(deposit.rateAnnual),
        deposit.termDays
      )
      const stampBonus = Math.round(principal * stampBonusRate)
      const payout = principal + baseInterest + stampBonus

      let settledHere = false
      try {
        settledHere = await this.db.$transaction(async (tx) => {
          // پرداخت از صندوق بانک: اگر نقدینگی نباشد، سپرده باز می‌ماند و در
          // بازدید بعدی (پس از بازگشت وام‌ها) تسویه می‌شود — نه پولی از هیچ
          // ساخته می‌شود و نه سپرده‌ای بی‌صاحب می‌ماند.
          const funded = await this.pool.debit(tx, payout)
          if (!funded) {
            return false
          }

          // بستن سپرده و پرداخت در یک تراکنش: اگر فرایند وسط کار بمیرد،
          // نه سپرده «بسته اما بی‌پول» می‌ماند و نه پول بدون بستن سپرده پرداخت می‌شود.
          const closed = await tx.termDeposit.updateMany({
            where: { id: deposit.id, status: TermDepositStatus.ACTIVE },
            data: {
              status: TermDepositStatus.PAID,
              payout,
              settledAt: new Date()
            }
          })
          if (closed.count !== 1) {
            // سپرده را درخواستِ دیگری هم‌زمان تسویه کرده است. چون پولِ صندوق
            // *پیش از* این قفل کسر شده، باید با پرتاب کردن کل تراکنش (از جمله
            // کسر صندوق) برگردد؛ وگرنه پول از صندوق کم می‌شود بدون آنکه به کسی
            // برسد — همان نشتیِ نقدینگی که بانک را به‌تدریج بی‌پول می‌کند.
            throw new SettledElsewhere()
          }

          await tx.player.update({
            where: { id: playerId },
            data: { balance: { increment: payout } }
          })
          await tx.financialTransaction.create({
            data: {
              amount: principal,
              type: TransactionType.DEPOSIT_PAYOUT,
              destinationPlayerId: playerId,
              reference: `بازگشت اصل سپردهٔ ${deposit.termDays} روزه`
            }
          })
          if (baseInterest + stampBonus > 0) {
            await tx.financialTransaction.create({
              data: {
                amount: baseInterest + stampBonus,
                type: TransactionType.DEPOSIT_INTEREST,
                destinationPlayerId: playerId,
                reference:
                  stampBonus > 0
                    ? `سود سپردهٔ ${deposit.termDays} روزه + پاداش مُهر سفر`
                    : `سود سپردهٔ ${deposit.termDays} روزه`
              }
            })
          }
          return true
        })
      } catch (error) {
        if (!(error instanceof SettledElsewhere)) {
          throw error
        }
        // درخواستِ دیگر تسویه کرده است: نه پولی سوخته (تراکنش برگشت) و نه
        // سپرده‌ای معوق مانده؛ پس هیچ شمارنده‌ای عوض نمی‌شود.
        continue
      }

      if (!settledHere) {
        deferred += 1
        continue
      }

      await this.eventService
        .recordPlayerEvent({
          playerId,
          type: GameEventType.DEPOSIT_MATURED,
          title: `سپردهٔ ${deposit.termDays} روزه سررسید شد`,
          amount: payout,
          dedupeKey: `deposit:${deposit.id}`
        })
        .catch(() => undefined)

      // اعلان مستقیم: بازیکن باید بداند پولش (اصل + سود) واریز شده
      await this.notificationService
        ?.notifyPlayerById(
          playerId,
          '⏳ سپرده سررسید شد',
          `سپردهٔ ${deposit.termDays} روزهٔ ${principal.toLocaleString('fa-IR')} تومانی تسویه شد؛ ${payout.toLocaleString('fa-IR')} تومان (اصل + سود) به کیفت واریز شد.`,
          undefined,
          `deposit-matured-notify:${deposit.id}`,
          'IMPORTANT'
        )
        .catch(() => undefined)

      settled++
    }

    // صندوق خالی = تسویهٔ معوق؛ تعدادش با همین خروجی به پنل می‌رود تا
    // بازیکن بی‌دلیل منتظر نماند. عمداً در فیلد نمونه نگه داشته نمی‌شود:
    // نمونهٔ سرویس در سطح کل فرایند مشترک است و فیلدِ اشتراکی، عددِ معوقِ
    // بازیکنِ دیگر را در پنلِ این بازیکن نشان می‌داد.
    return { settled, deferred }
  }

  private async requirePlayer(telegramUserId: bigint) {
    const player = await this.db.player.findUnique({
      where: { telegramUserId },
      select: { id: true }
    })
    if (!player) {
      throw new NotFoundError('Player not found')
    }
    return player
  }
}

export const DEPOSIT_LIMITS = {
  minPrincipal: MIN_PRINCIPAL,
  maxTotalActive: MAX_TOTAL_ACTIVE,
  breakPenaltyRate: BREAK_PENALTY_RATE
} as const
