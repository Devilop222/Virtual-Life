import { NotificationType, PrismaClient, TransactionType } from '@prisma/client'
import { ConflictError, NotFoundError, ValidationError } from '../../utils/classes/errors'
import { insufficientFunds, money } from '../../utils/format'
import { EventService } from '../events/event.service'
import { GameEventType } from '@prisma/client'
import type { NotificationLevel } from '../notification/push'
import { RegionFundService } from '../economy/tax.service'
import { cycleAmount, weekIndex } from '../../utils/game-time'

/**
 * قیمت هر بلیت قرعه‌کشی — برای یک دورهٔ هفتگیِ *بازی* (۵٫۶ ساعت واقعی).
 *
 * چون قرعه‌کشی ۳۰ برابر زودتر از قبل برگزار می‌شود، قیمت بلیت هم با
 * `cycleAmount` هم‌تراز شده تا هزینهٔ هفتگی بازیکن در زمان واقعی ثابت بماند.
 */
export const TICKET_PRICE = cycleAmount(200_000)

/** سهم شهر از فروش بلیت — Money Sink دائمی؛ باقی جایزه می‌شود. */
const CITY_CUT_RATIO = 0.3

/**
 * کلید هفتـهٔ بازی — همان کلیدی که کل بازی برای چرخه‌های هفتگی می‌شناسد
 * (`weekIndex`). هیچ ضریب مستقلی این‌جا تعریف نمی‌شود.
 */
function currentWeekKey(): number {
  return weekIndex()
}

export interface LotteryPanelData {
  weekKey: number
  ticketPrice: number
  participantCount: number
  estimatedPrize: number
  youHaveTicket: boolean
  lastWeek: {
    hasResult: boolean
    winnerName: string | null
    prize: number
  }
}

/**
 * قرعه‌کشی هفتگی منطقه.
 *
 * قواعد اقتصادی:
 *  • هر بازیکن در هر منطقه هفته‌ای فقط «یک» بلیت (Unique Constraint)
 *  • پول بلیت واقعاً از کیف بازیکن کسر و به «صندوق منطقه» ریخته می‌شود
 *  • جایزه = ۷۰٪ فروش هفته و از همان صندوق پرداخت می‌شود (نه از هیچ)؛
 *    ۳۰٪ باقی‌مانده به‌عنوان سهم شهر در صندوق می‌ماند
 *  • قرعه به‌صورت Lazy هنگام اولین بازدید بعد از پایان هفته اجرا می‌شود
 *  • برنده یکنواخت تصادفی بین دارندگان بلیت همان هفته
 */
export class LotteryService {
  private readonly regionFund = new RegionFundService()

  constructor(
    private readonly db: PrismaClient,
    private readonly eventService: EventService,
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

  async buyTicket(telegramUserId: bigint, groupId: string): Promise<{
    weekKey: number
    prizeEstimate: number
    participants: number
  }> {
    const player = await this.db.player.findUnique({
      where: { telegramUserId },
      select: { id: true, balance: true }
    })
    if (!player) {
      throw new NotFoundError('Player not found')
    }

    const weekKey = currentWeekKey()

    const result = await this.db.$transaction(async (tx) => {
      const debited = await tx.player.updateMany({
        where: { id: player.id, balance: { gte: TICKET_PRICE } },
        data: { balance: { decrement: TICKET_PRICE } }
      })
      if (debited.count !== 1) {
        throw new ValidationError(
          'Insufficient balance',
          insufficientFunds(
            TICKET_PRICE,
            Number(player.balance),
            'خرید بلیت قرعه‌کشی',
            'کارت روزانه را بگیر یا یک شیفت کار کن؛ بلیت هر هفته یک بار بیشتر لازم نیست.'
          )
        )
      }

      try {
        await tx.lotteryTicket.create({
          data: { groupId, playerId: player.id, weekKey, price: TICKET_PRICE }
        })
      } catch {
        // نقض Unique یعنی همین هفته قبلاً بلیت گرفته — پول برمی‌گردد (Rollback خودکار)
        throw new ConflictError(
          'Already has ticket',
          'این هفته بلیتت را خریده‌ای! هفتهٔ بعد شانست را امتحان کن 🎰'
        )
      }

      await tx.financialTransaction.create({
        data: {
          amount: TICKET_PRICE,
          type: TransactionType.TRANSFER,
          sourcePlayerId: player.id,
          reference: 'بلیت قرعه‌کشی هفتگی (صندوق منطقه)'
        }
      })

      // پول بلیت در صندوق عمومی منطقه می‌نشیند تا جایزه از همان پول
      // پرداخت شود؛ پیش‌تر بلیت فقط می‌سوخت و جایزه از هیچ ساخته می‌شد.
      await this.regionFund.credit(tx, groupId, TICKET_PRICE)

      const participants = await tx.lotteryTicket.count({ where: { groupId, weekKey } })
      return {
        weekKey,
        participants,
        prizeEstimate: this.prizeOf(participants)
      }
    })

    return result
  }

  /**
   * قرعه‌کشی Lazy هفتهٔ گذشته.
   * Idempotent: با علامت‌گذاری `lotteryLastWeek` روی گروه، هرگز دوبار اجرا نمی‌شود.
   */
  private async settleLastWeek(groupId: string) {
    const lastWeekKey = currentWeekKey() - 1
    const group = await this.db.group.findUnique({
      where: { id: groupId },
      select: { lotteryLastWeek: true }
    })
    if (!group || group.lotteryLastWeek === lastWeekKey) {
      return null
    }

    const tickets = await this.db.lotteryTicket.findMany({
      where: { groupId, weekKey: lastWeekKey },
      select: { playerId: true }
    })

    if (tickets.length === 0) {
      // بدون بلیت هم علامت بزن تا هر بار Query تکراری نزنیم؛
      // شرط «مقدار فعلی ≠ هفتهٔ قبل» این علامت‌گذاری را هم در برابر رقابت امن می‌کند.
      const claimed = await this.db.group.updateMany({
        where: { id: groupId, lotteryLastWeek: { not: lastWeekKey } },
        data: { lotteryLastWeek: lastWeekKey }
      })
      void claimed
      return null
    }

    const pot = tickets.length * TICKET_PRICE
    const prize = Math.floor(pot * (1 - CITY_CUT_RATIO))
    const winnerIndex = Math.floor(Math.random() * tickets.length)
    const winnerPlayerId = tickets[winnerIndex]!.playerId

    const settled = await this.db.$transaction(async (tx) => {
      // ادعای تسویه با شرط مقدار قبلی: اگر دو بازدید همزمان به این هفته برسند،
      // فقط یکی می‌تواند `lotteryLastWeek` را از مقدار پیشین به هفتهٔ قبل ببرد.
      // دومی صفر ردیف می‌گیرد و جایزه دوبار پرداخت نمی‌شود.
      const claimed = await tx.group.updateMany({
        where: { id: groupId, lotteryLastWeek: { not: lastWeekKey } },
        data: {
          lotteryLastWeek: lastWeekKey,
          lotteryLastWinnerId: winnerPlayerId,
          lotteryLastPrize: prize
        }
      })
      if (claimed.count !== 1) {
        throw new ConflictError('Lottery already settled', 'قرعه‌کشی این هفته قبلاً انجام شده است.')
      }

      // جایزه فقط تا سقف موجودی واقعی صندوق پرداخت می‌شود؛ هرگز پول از هیچ
      // ساخته نمی‌شود و صندوق هم منفی نمی‌شود.
      const paid = await this.regionFund.debitUpTo(tx, groupId, prize)
      if (paid <= 0) {
        // صندوق خالی است؛ کل تراکنش (از جمله ادعای تسویه) برمی‌گردد تا
        // تسویه در بازدید بعدی دوباره و کامل انجام شود.
        throw new ConflictError('Prize fund empty', 'صندوق جایزهٔ این هفته آماده نیست.')
      }
      if (paid !== prize) {
        await tx.group.update({
          where: { id: groupId },
          data: { lotteryLastPrize: paid }
        })
      }

      await tx.player.update({
        where: { id: winnerPlayerId },
        data: { balance: { increment: paid } }
      })
      await tx.financialTransaction.create({
        data: {
          amount: paid,
          type: TransactionType.LOTTERY_PRIZE,
          destinationPlayerId: winnerPlayerId,
          reference: '🏆 برندهٔ قرعه‌کشی هفتگی (از صندوق منطقه)'
        }
      })
      const winner = await tx.player.findUniqueOrThrow({
        where: { id: winnerPlayerId },
        select: { firstName: true, lastName: true }
      })
      // مبلغ واقعیِ پرداخت‌شده از صندوق (هرگز بیش از موجودی صندوق).
      return { winner, paid }
    }).catch((error) => {
      // بازندهٔ رقابت تسویه؛ نتیجهٔ برنده از قبل ثبت شده، بی‌صدا رد شو.
      if (error instanceof ConflictError) {
        return null
      }
      throw error
    })

    if (!settled) {
      return null
    }

    const { winner: winnerRow, paid: paidPrize } = settled
    const winnerName =
      `${winnerRow.firstName} ${winnerRow.lastName ?? ''}`.trim()

    await this.eventService
      .recordRegionEvent({
        groupId,
        type: GameEventType.LOTTERY_WON,
        title: `🏆 ${winnerName} برندهٔ قرعه‌کشی هفتگی شد!`,
        amount: paidPrize,
        dedupeKey: `lottery:${groupId}:${lastWeekKey}`,
        priority: 4
      })
      .catch(() => {})

    // جایزه به کیف برنده رفت ولی خبرش فقط رخدادِ گروه بود. تسویه Lazy است
    // (ممکن است روزها بعد از پایان هفته انجام شود)، پس رخدادِ گروه کهنه و
    // گم می‌شود؛ برنده باید خودش بداند پول از کجا آمده.
    await this.notificationService
      ?.announce({
        playerId: winnerPlayerId,
        type: NotificationType.EVENT,
        level: 'CRITICAL',
        dedupeKey: `lottery-won:${groupId}:${lastWeekKey}:${winnerPlayerId}`,
        title: '🏆 برندهٔ قرعه‌کشی هفتگی شدی',
        message: [
          `جایزه: ${money(paidPrize)} تومان`,
          `تعداد شرکت‌کننده‌ها: ${tickets.length.toLocaleString('fa-IR')} نفر`,
          'جایزه از صندوق منطقهٔ تو پرداخت و به کیفت واریز شد.'
        ].join('\n')
      })
      .catch(() => undefined)

    return { winnerPlayerId, winnerName, prize: paidPrize, participants: tickets.length }
  }

  /** دادهٔ پنل قرعه‌کشی (با تسویهٔ خودکار هفتهٔ قبل). */
  async getPanelData(playerId: string, groupId: string): Promise<LotteryPanelData> {
    await this.settleLastWeek(groupId)

    const weekKey = currentWeekKey()
    const lastWeekKey = weekKey - 1
    const [group, participants, yourTicket] = await Promise.all([
      this.db.group.findUniqueOrThrow({
        where: { id: groupId },
        select: {
          lotteryLastWeek: true,
          lotteryLastWinnerId: true,
          lotteryLastPrize: true
        }
      }),
      this.db.lotteryTicket.count({ where: { groupId, weekKey } }),
      this.db.lotteryTicket.findFirst({
        where: { groupId, playerId, weekKey },
        select: { id: true }
      })
    ])

    let winnerName: string | null = null
    if (group.lotteryLastWinnerId) {
      const w = await this.db.player.findUnique({
        where: { id: group.lotteryLastWinnerId },
        select: { firstName: true, lastName: true }
      })
      if (w) winnerName = `${w.firstName} ${w.lastName ?? ''}`.trim()
    }

    return {
      weekKey,
      ticketPrice: TICKET_PRICE,
      participantCount: participants,
      estimatedPrize: this.prizeOf(participants),
      youHaveTicket: Boolean(yourTicket),
      lastWeek: {
        hasResult:
          group.lotteryLastWeek === lastWeekKey && Boolean(group.lotteryLastWinnerId),
        winnerName,
        prize: Number(group.lotteryLastPrize ?? 0)
      }
    }
  }

  /** تعداد بلیت‌ها و جایزهٔ تخمینی هفتهٔ جاری. */
  private prizeOf(participants: number): number {
    return Math.floor(participants * TICKET_PRICE * (1 - CITY_CUT_RATIO))
  }
}
