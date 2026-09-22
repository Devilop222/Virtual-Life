import { GameEventType, PrismaClient, TransactionType } from '@prisma/client'
import type { NotificationType } from '@prisma/client'
import type { NotificationLevel } from '../notification/push'
import { money } from '../../utils/format'
import { ConflictError, NotFoundError, ValidationError } from '../../utils/classes/errors'
import { EventService } from '../events/event.service'
import { weekIndex, stableHash } from '../../utils/game-time'
import { RegionFundService } from '../economy/tax.service'

export interface AuctionBlueprint {
  key: string
  name: string
  emoji: string
  baseBid: number
}

/** آیتم‌های اسطوره‌ای حراجی؛ برنده به انبار اضافه می‌کند. */
export const AUCTION_ITEMS: readonly AuctionBlueprint[] = [
  { key: 'golden_statue', name: 'مجسمهٔ طلایی شهر', emoji: '🗿', baseBid: 5_000_000 },
  { key: 'ancient_coin', name: 'سکهٔ باستانی نادر', emoji: '🪙', baseBid: 3_000_000 },
  { key: 'royal_crown', name: 'تاج افتخار منطقه', emoji: '👑', baseBid: 8_000_000 }
]

/** حداقل پلهٔ پیشنهاد بالاتر از رکورد فعلی. */
const MIN_BID_STEP_RATIO = 0.05

export interface AuctionView {
  id: string
  itemName: string
  emoji: string
  startingBid: number
  currentBid: number
  minNextBid: number
  bidsCount: number
  leaderName: string | null
  amILeader: boolean
  isClosed: boolean
}

/**
 * حراجی هفتگی منطقه.
 *
 * الگوی Escrow اتمیک:
 *  • مبلغ هر پیشنهاد بلافاصله از مزایده‌گر کسر و «نگه داشته» می‌شود.
 *  • با پیشنهاد جدیدتر، مبلغ پیشنهاددهندهٔ قبلی بی‌درنگ برگردانده می‌شود؛
 *    پس در هر لحظه حداکثر یک نفر پول قفل‌شده دارد.
 *  • شرط `currentBid: oldValue` روی update تضمین می‌کند دو کلیک همزمان فقط
 *    یکی را جلو ببرد و پول دیگری همان تراکنش پس داده شود.
 *  • تسویهٔ تحویل آیتم Lazy است: اولین بازدید بعد از هفتهٔ جدید.
 */
export class AuctionService {
  /** فروشندهٔ حراجی شهر است؛ پولِ فروش به همان صندوق منطقه می‌رسد. */
  private readonly regionFund = new RegionFundService()

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

  /** آیتم این هفته برای این منطقه (انتخاب قطعی). */
  private blueprintFor(groupId: string, week: number): AuctionBlueprint {
    const index = stableHash(`auction:${groupId}:${week}`) % AUCTION_ITEMS.length
    return AUCTION_ITEMS[index]!
  }

  /** حراجی جاری منطقه را می‌سازد اگر نباشد؛ حراجی‌های گذشته را می‌بندد. */
  async getOrCreateWeekly(groupId: string): Promise<string> {
    await this.closeDue(groupId)

    const week = weekIndex()
    const existing = await this.db.auction.findFirst({
      where: { groupId, weekKey: week }
    })
    if (existing) {
      return existing.id
    }

    const blueprint = this.blueprintFor(groupId, week)
    const created = await this.db.auction.create({
      data: {
        groupId,
        itemKey: blueprint.key,
        itemName: blueprint.name,
        weekKey: week,
        startingBid: blueprint.baseBid,
        currentBid: blueprint.baseBid
      }
    })
    return created.id
  }

  /** تحویل آیتم به برندگان حراجی‌های تمام‌شده (Lazy). */
  async closeDue(groupId: string): Promise<number> {
    const due = await this.db.auction.findMany({
      where: {
        groupId,
        isClosed: false,
        weekKey: { lt: weekIndex() },
        highestBidderId: { not: null }
      },
      take: 5
    })

    let closed = 0
    for (const auction of due) {
      const winnerId = auction.highestBidderId!
      const item = AUCTION_ITEMS.find((i) => i.key === auction.itemKey)
      const itemName = item?.name ?? auction.itemName
      const itemId = await this.ensureItemId(auction.itemKey, itemName)

      // قفل + تحویل + دفتر در یک تراکنش: اگر ربات همین وسط ریستارت شود،
      // یا همه‌چیز ثبت می‌شود یا حراجی باز می‌ماند و دور بعد تحویل می‌شود.
      const delivered = await this.db.$transaction(async (tx) => {
        const locked = await tx.auction.updateMany({
          where: { id: auction.id, isClosed: false },
          data: { isClosed: true, closedAt: new Date() }
        })
        if (locked.count !== 1) return false

        await tx.playerInventory.upsert({
          where: { playerId_itemId: { playerId: winnerId, itemId } },
          create: { playerId: winnerId, itemId, quantity: 1 },
          update: { quantity: { increment: 1 } }
        })
        // پولِ برنده از لحظهٔ پیشنهاد کسر و در دفترش ثبت شده است؛ پس اینجا
        // هیچ ردیفِ خروجِ دومی ساخته نمی‌شود. پیش‌تر یک `AUCTION_WIN` با
        // `sourcePlayerId = winner` ساخته می‌شد و کیف بازیکن برای همان آیتم
        // دو بار خروج نشان می‌داد، در حالی که فقط یک بار کم شده بود.
        // کاری که اینجا باقی می‌ماند بستنِ مسیر پول است: برنده (خریدار) پرداخت
        // کرده و شهر (فروشنده) باید دریافتش را ببیند — همان صندوق منطقه‌ای که
        // حراجیِ بدون برنده و بازگشتِ ودیه هم به آن می‌ریزد.
        await this.regionFund.credit(tx, auction.groupId, Number(auction.currentBid))
        return true
      })
      if (!delivered) continue

      await this.eventService
        .recordRegionEvent({
          groupId,
          type: GameEventType.AUCTION_WON,
          priority: 4,
          title: `${item?.emoji ?? '🏆'} ${itemName} به حراج گذاشته شد و فروش رفت!`,
          detail: 'برندهٔ حراجی هفتهٔ گذشته آیتم را دریافت کرد.',
          amount: Number(auction.currentBid),
          dedupeKey: `auction-win:${auction.id}`
        })
        .catch(() => undefined)

      // تحویل Lazy است: حراجی وقتی بسته می‌شود که کسی پنل را باز کند، پس
      // برنده ممکن است هفته‌ها نفهمد برده است. خبرِ شخصی لازم است.
      await this.notificationService
        ?.notifyPlayerById(
          winnerId,
          `${item?.emoji ?? '🏆'} برندهٔ حراجی شدی`,
          `حراجیِ «${itemName}» به پایان رسید و تو با پیشنهاد ${money(
            Number(auction.currentBid)
          )} برنده شدی. آیتم به انبارت اضافه شد؛ از پنل «انبار» ببینش.`,
          undefined,
          `auction-won:${auction.id}`,
          'IMPORTANT'
        )
        .catch(() => undefined)

      closed++
    }

    return closed
  }

  /** ثبت یا بازیابی ردیف ShopItem آیتم‌های حراجی. */
  private async ensureItemId(itemKey: string, itemName: string): Promise<string> {
    const existing = await this.db.shopItem.findUnique({
      where: { key: itemKey },
      select: { id: true }
    })
    if (existing) return existing.id

    const created = await this.db.shopItem.create({
      data: {
        key: itemKey,
        name: itemName,
        description: 'آیتم اسطوره‌ای به‌دست‌آمده از حراجی شهر.',
        category: 'ویژه',
        price: 0,
        rarity: 'legendary',
        stock: -1,
        effects: {}
      },
      select: { id: true }
    })
    return created.id
  }

  /**
   * ثبت پیشنهاد جدید با قفل شدن مبلغ.
   * مبلغ مزایده‌گر قبلی داخل همان تراکنش برگردانده می‌شود.
   */
  async placeBid(
    telegramUserId: bigint,
    auctionId: string,
    amount: number
  ): Promise<{ amount: number; itemName: string }> {
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw new ValidationError('Invalid bid', 'مبلغ پیشنهاد پذیرفته نشد. حداقل پیشنهاد پنل را بخوان و یک مبلغ صحیح وارد کن.')
    }

    const bidder = await this.db.player.findUnique({
      where: { telegramUserId },
      select: { id: true }
    })
    if (!bidder) {
      throw new NotFoundError('Player not found')
    }

    const auction = await this.db.auction.findUnique({ where: { id: auctionId } })
    if (!auction) {
      throw new NotFoundError('Auction not found', 'این حراجی یافت نشد. در گروه «حراجی» را بفرست تا دورهٔ جاری باز شود.')
    }
    if (auction.isClosed || auction.weekKey < weekIndex()) {
      throw new ConflictError('Auction closed', 'زمان این حراجی تمام شده است.')
    }

    const minNext = Math.max(
      Number(auction.startingBid),
      Math.round(Number(auction.currentBid) * (1 + MIN_BID_STEP_RATIO))
    )
    if (amount < minNext) {
      throw new ValidationError(
        'Bid too low',
        `حداقل پیشنهاد بعدی ${minNext.toLocaleString('fa-IR')} تومان است.`
      )
    }

    // رقیبی که پولش برمی‌گردد بیرونِ تراکنش خبردار می‌شود؛ داخل تراکنش
    // نباید به تلگرام دست بزنیم (پیام ناموفق نباید پول را عقب بیندازد).
    // خروجی تراکنش، خودِ همین واقعیت است تا متغیر بیرونیِ دستکاری‌شده در
    // Closure لازم نشود.
    const outbid = await this.db.$transaction(async (tx) => {
      let returned: { playerId: string; amount: number } | null = null

      // وضعیت حراجی در لحظهٔ نوشتن (نه با خواندن پیش از تراکنش) بازمش دید:
      //  ۱. پیشنهاد به خود: رهبر فعلی نمی‌تواند روی پیشنهاد خودش بالا بزند.
      //     اگر فقط روی دکمهٔ UI اعتماد می‌کردیم، آیتم اسطوره‌ای را با ۵٪
      //     اختلاف «از خود برای خود» می‌خرید (آیتم از هیچ + پولِ کمتر).
      //  ۲. حداقل پیشنهاد از رکورد تازه حساب می‌شود تا پیشنهادِ روی دادهٔ
      //     کهنه رد نشود.
      const fresh = await tx.auction.findUnique({
        where: { id: auction.id },
        select: { currentBid: true, highestBidderId: true, isClosed: true, weekKey: true }
      })
      if (!fresh || fresh.isClosed || fresh.weekKey !== weekIndex()) {
        throw new ConflictError('Auction closed', 'زمان این حراجی تمام شده است.')
      }
      if (fresh.highestBidderId === bidder.id) {
        throw new ConflictError(
          'Self bid',
          'روی پیشنهاد خودت نمی‌توانی بالا بزنی؛ باید منتظر یک مزایده‌گر دیگر باشی.'
        )
      }

      const freshMinNext = Math.max(
        Number(auction.startingBid),
        Math.round(Number(fresh.currentBid) * (1 + MIN_BID_STEP_RATIO))
      )
      if (amount < freshMinNext) {
        throw new ValidationError(
          'Bid too low',
          `حداقل پیشنهاد بعدی ${freshMinNext.toLocaleString('fa-IR')} تومان است.`
        )
      }

      // قفل مبلغ پیشنهاد جدید
      const debited = await tx.player.updateMany({
        where: { id: bidder.id, balance: { gte: amount } },
        data: { balance: { decrement: amount } }
      })
      if (debited.count !== 1) {
        throw new ConflictError(
          'Insufficient balance',
          `مبلغ ${amount.toLocaleString('fa-IR')} تومان از کیف تو کسر نشد؛ موجودی کافی نیست.`
        )
      }

      // پیشنهاد به‌صورت امانی از کیف کسر می‌شود؛ ردیف دفتر کلش همین‌جاست
      // تا هیچ‌وقت «کسر پول بدون ثبت» رخ ندهد.
      await tx.financialTransaction.create({
        data: {
          amount,
          type: TransactionType.AUCTION_BID,
          sourcePlayerId: bidder.id,
          reference: `پیشنهاد امانی حراجی — ${auction.itemName}`
        }
      })

      // شرط مقدار فعلی: فقط یکی از دو پیشنهاد همزمان عبور می‌کند.
      // اگر بازندهٔ مسابقه شدیم، throw باعث rollback کل تراکنش می‌شود —
      // یعنی مبلغ کسرشده خودبه‌خود برمی‌گردد؛ اینجا به جبران دستی نیازی نیست.
      const updated = await tx.auction.updateMany({
        where: { id: auction.id, currentBid: fresh.currentBid, isClosed: false },
        data: { currentBid: amount, highestBidderId: bidder.id }
      })
      if (updated.count !== 1) {
        throw new ConflictError('Outbid concurrently', 'رکورد همین حالا جابه‌جا شد؛ دوباره تلاش کن.')
      }

      // آزادسازی مبلغ پیشنهاددهندهٔ قبلی
      if (fresh.highestBidderId) {
        const refund = Math.round(Number(fresh.currentBid))
        await tx.player.update({
          where: { id: fresh.highestBidderId },
          data: { balance: { increment: refund } }
        })
        await tx.financialTransaction.create({
          data: {
            amount: refund,
            type: TransactionType.AUCTION_BID,
            destinationPlayerId: fresh.highestBidderId,
            reference: `بازگشت پیشنهاد امانی (رکورد خورد) — ${auction.itemName}`
          }
        })
        returned = { playerId: fresh.highestBidderId, amount: refund }
      }

      await tx.auctionBid.create({
        data: { auctionId: auction.id, bidderId: bidder.id, amount }
      })

      return returned
    })

    // پولِ امانیِ رقیب برگشت ولی پیش از این هیچ‌کس به او نمی‌گفت. در حراجی،
    // پول تا آخر هفته قفل می‌ماند؛ پس «پیشنهادت پس داده شد» خبرِ لازم است،
    // نه اطلاعِ تشریفاتی. کلید ضدتکرار شامل شناسهٔ بازیکن است چون کلید جدول
    // یکتای جهانی است و چند نفر در یک حراجی می‌توانند رکورد بخورند.
    if (outbid) {
      await this.notificationService
        ?.notifyPlayerById(
          outbid.playerId,
          '💰 پیشنهادت در حراجی پس داده شد',
          `یک مزایده‌گر دیگر پیشنهاد بالاتری گذاشت و رکوردِ «${auction.itemName}» از دستت رفت.\n` +
            `مبلغ ${money(outbid.amount)} تومان که امانت قفل شده بود به کیفت برگشت.\n` +
            `اگر آیتم را می‌خواهی، در گروه «حراجی» را بفرست و دوباره پیشنهاد بده.`,
          undefined,
          `auction-outbid:${auction.id}:${outbid.playerId}`,
          'IMPORTANT'
        )
        .catch(() => undefined)
    }

    return { amount, itemName: auction.itemName }
  }

  /**
   * نمای حراجی جاری منطقه.
   *
   * `viewerTelegramUserId` برای محاسبهٔ درست `amILeader` لازم است: دکمهٔ
   * «پیشنهاد» برای رهبرِ فعلی (روی پیشنهاد خودش) بسته می‌ماند تا آیتم
   * اسطوره‌ای را با ۵٪ اختلاف از خودش برای خودش نخرید.
   */
  async getView(
    groupId: string,
    viewerTelegramUserId?: bigint
  ): Promise<AuctionView> {
    const auctionId = await this.getOrCreateWeekly(groupId)
    const auction = await this.db.auction.findUniqueOrThrow({
      where: { id: auctionId },
      include: { _count: { select: { bids: true } } }
    })

    let amILeader = false
    if (viewerTelegramUserId !== undefined && auction.highestBidderId) {
      const viewer = await this.db.player.findUnique({
        where: { telegramUserId: viewerTelegramUserId },
        select: { id: true }
      })
      amILeader = viewer?.id === auction.highestBidderId
    }

    const item =
      AUCTION_ITEMS.find((i) => i.key === auction.itemKey) ??
      ({ emoji: '🏆' } as AuctionBlueprint)

    const leader = auction.highestBidderId
      ? await this.db.player.findUnique({
          where: { id: auction.highestBidderId },
          select: { firstName: true, lastName: true }
        })
      : null

    const minNext = Math.max(
      Number(auction.startingBid),
      Math.round(Number(auction.currentBid) * (1 + MIN_BID_STEP_RATIO))
    )

    return {
      id: auction.id,
      itemName: auction.itemName,
      emoji: item.emoji,
      startingBid: Number(auction.startingBid),
      currentBid: Number(auction.currentBid),
      minNextBid: minNext,
      bidsCount: auction._count.bids,
      leaderName: leader
        ? `${leader.firstName} ${leader.lastName ?? ''}`.trim()
        : null,
      amILeader,
      isClosed: auction.isClosed
    }
  }
}

export const AUCTION_INFO = { minStepRatio: MIN_BID_STEP_RATIO, items: AUCTION_ITEMS } as const
