import {
  GameEventType,
  NotificationType,
  PrismaClient,
  TransactionType
} from '@prisma/client'
import { ConflictError, NotFoundError, ValidationError } from '../../utils/classes/errors'
import { insufficientFunds, money } from '../../utils/format'
import { EventService } from '../events/event.service'
import { gameMonths } from '../../utils/game-time'
import type { NotificationLevel } from '../notification/push'

/**
 * مدت اعتبار هر آگهی: ۱ ماه بازی (۳۰ روز بازی ≈ ۲۴ ساعت واقعی).
 *
 * قبلاً دو روزِ *واقعی* بود؛ چون هر ماه بازی یک روز واقعی است، اعتبار آگهی
 * هم روی همان تقویم بسته می‌شود تا «یک ماه» در همهٔ بازارها یک معنا داشته باشد.
 */
const LISTING_TTL_MS = gameMonths(1)

/**
 * سقف آگهی‌های فعال هر بازیکن.
 *
 * چرا لازم است؟ هر آگهی کالا را در امانت نگه می‌دارد و صفحهٔ بازار فقط ۶ آگهی
 * نشان می‌دهد؛ بی‌سقف بودن یعنی یک بازیکن می‌تواند کل صفحهٔ بازار را با
 * کالاهای خودش پر کند و دارایی بقیه دیده نشود. سقف هم‌زمان از قفل‌ماندن
 * بی‌حساب دارایی جلوگیری می‌کند.
 */
export const MAX_ACTIVE_LISTINGS = 5

/** محدودیت‌های قیمت واحد برای جلوگیری از Typo و Scam. */
const MIN_UNIT_PRICE = 1_000
const MAX_UNIT_PRICE = 20_000_000

const PAGE_SIZE = 6

/** حداکثر آگهیِ منقضی که در هر بازدید آزاد و به انبار برمیگردد. */
const SWEEP_BATCH = 25

export interface MarketListingView {
  id: string
  itemName: string
  quantity: number
  unitPrice: number
  totalPrice: number
  sellerName: string
}

/**
 * بازار بازیکن‌به‌بازیکن.
 *
 * امنیت و صحت:
 *  • خرید کاملاً Escrow اتمیک است: کسر پول خریدار، انتقال کالا، واریز به فروشنده
 *    در یک `$transaction` — یا همه انجام می‌شود یا هیچ‌کدام
 *  • فروشنده نمی‌تواند آگهی خودش را بخرد
 *  • قبل از انتقال، موجودی انبار فروشنده دوباره شرطاً بررسی می‌شود؛ اگر نبود،
 *    آگهی خودکار لغو و پول خریدار برمی‌گردد (Rollback تراکنش)
 *  • قیمت واحد بین ۱٬۰۰۰ تا ۲۰٬۰۰۰٬۰۰۰ تومان (ضد Typo)
 *  • آگهی پس از ۴۸ ساعت منقضی می‌شود و کالای رزروشدهٔ آن (Lazy، همان‌جا که
 *    بازار نمایش داده می‌شود) به انبار فروشنده برمی‌گردد تا دارایی قفل نماند
 */
export class TradeService {
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

  /**
   * شمار آگهی‌های فعالِ بازیکن.
   *
   * برای «بررسی پیش از ورود به جریان» لازم است: بازیکنی که سقفش پر است نباید
   * اول وارد مرحلهٔ نوشتن قیمت شود و آن‌جا بفهمد نمی‌تواند ثبت کند (همان
   * اشتباه ترتیب اعتبارسنجی که در جریان حیوان خانگی رخ داده بود).
   */
  async activeListingCount(telegramUserId: bigint): Promise<number> {
    const player = await this.db.player.findUnique({
      where: { telegramUserId },
      select: { id: true }
    })
    if (!player) {
      return 0
    }
    return this.db.marketListing.count({
      where: {
        sellerPlayerId: player.id,
        status: 'ACTIVE',
        expiresAt: { gt: new Date() }
      }
    })
  }

  /** ایجاد آگهی فروش از انبار فروشنده. */
  async createListing(
    telegramUserId: bigint,
    inventoryId: string,
    quantity: number,
    unitPrice: number
  ): Promise<{ listingId: string; itemName: string; quantity: number; unitPrice: number }> {
    if (!Number.isSafeInteger(quantity) || quantity <= 0 || quantity > 100) {
      throw new ValidationError('Invalid quantity', 'تعداد باید بین ۱ تا ۱۰۰ باشد.')
    }
    if (
      !Number.isSafeInteger(unitPrice) ||
      unitPrice < MIN_UNIT_PRICE ||
      unitPrice > MAX_UNIT_PRICE
    ) {
      throw new ValidationError(
        'Invalid price',
        `قیمت هر عدد باید بین \`${MIN_UNIT_PRICE.toLocaleString('fa-IR')}\` و \`${MAX_UNIT_PRICE.toLocaleString('fa-IR')}\` تومان باشد.`
      )
    }

    return this.db.$transaction(async (tx) => {
      const seller = await tx.player.findUnique({
        where: { telegramUserId },
        select: { id: true }
      })
      if (!seller) {
        throw new NotFoundError('Player not found')
      }

      const invRow = await tx.playerInventory.findUnique({
        where: { id: inventoryId },
        include: { item: { select: { id: true, name: true } } }
      })
      if (!invRow || invRow.playerId !== seller.id) {
        throw new NotFoundError(
          'Item not found',
          'این کالا در انبار تو نیست. «انبار» را دوباره باز کن و کالای موجود را انتخاب کن.'
        )
      }

      // سقف داخل همین تراکنش دوباره سنجیده می‌شود: پنل ممکن است لحظاتی
      // قدیمی باشد یا بازیکن دو کلیک هم‌زمان بزند. این یک قیدِ محصولی است،
      // نه قید پولی؛ دقت یکتای مطلق برایش خواسته نیست.
      const activeCount = await tx.marketListing.count({
        where: {
          sellerPlayerId: seller.id,
          status: 'ACTIVE',
          expiresAt: { gt: new Date() }
        }
      })
      if (activeCount >= MAX_ACTIVE_LISTINGS) {
        throw new ConflictError(
          'Too many active listings',
          `سقف ${MAX_ACTIVE_LISTINGS.toLocaleString('fa-IR')} آگهی فعال را داری. اول یکی از آگهی‌هایت را لغو کن یا صبر کن منقضی شود، بعد این کالا را بگذار.`
        )
      }
      if (invRow.quantity < quantity) {
        throw new ValidationError(
          'Insufficient quantity',
          `فقط ${invRow.quantity.toLocaleString('fa-IR')} عدد از این کالا داری.`
        )
      }

      // رزرو شرطی از انبار فروشنده
      const reserved = await tx.playerInventory.updateMany({
        where: { id: invRow.id, quantity: { gte: quantity } },
        data: { quantity: { decrement: quantity } }
      })
      if (reserved.count !== 1) {
        throw new ConflictError('Quantity changed', 'موجودی انبار تغییر کرده؛ دوباره تلاش کن.')
      }

      const listing = await tx.marketListing.create({
        data: {
          sellerPlayerId: seller.id,
          itemId: invRow.itemId,
          itemName: invRow.item.name,
          quantity,
          unitPrice,
          status: 'ACTIVE',
          expiresAt: new Date(Date.now() + LISTING_TTL_MS)
        }
      })

      return {
        listingId: listing.id,
        itemName: invRow.item.name,
        quantity,
        unitPrice
      }
    })
  }

  /** خرید یک آگهی (Escrow کامل). */
  async buyListing(
    telegramUserId: bigint,
    listingId: string
  ): Promise<{
    itemName: string
    quantity: number
    totalPrice: number
    sellerName: string
    /** موجودی خریدار بلافاصله پس از خرید — برای پنل نتیجه. */
    buyerBalanceAfter: number
  }> {
    const {
      sellerPlayerId,
      // نام مستعار: پارامتر متد هم `listingId` است و تعریف دوبارهٔ همان نام
      // یک خطای کامپایل بود.
      listingId: soldListingId,
      buyerName,
      buyerBalanceAfter,
      ...sold
    } = await this.db.$transaction(async (tx) => {
      const buyer = await tx.player.findUnique({
        where: { telegramUserId },
        select: { id: true, balance: true, firstName: true }
      })
      if (!buyer) {
        throw new NotFoundError('Player not found')
      }

      const listing = await tx.marketListing.findUnique({ where: { id: listingId } })
      if (!listing || listing.status !== 'ACTIVE' || listing.expiresAt < new Date()) {
        throw new ConflictError('Listing unavailable', 'این آگهی دیگر فعال نیست یا منقضی شده است.')
      }
      if (listing.sellerPlayerId === buyer.id) {
        throw new ValidationError(
          'Own listing',
          'خرید آگهی خودت ممکن نیست. برای برداشتن کالا از بازار، آگهی را لغو کن.'
        )
      }

      // ادعای انحصاری آگهی پیش از هر جابه‌جایی پول: دو خریدار همزمان نمی‌توانند
      // یک آگهی را بخرند (بدون این شرط، خرید دوم پول و کالای اضافی می‌ساخت).
      const claimed = await tx.marketListing.updateMany({
        where: { id: listing.id, status: 'ACTIVE' },
        data: { status: 'SOLD', soldAt: new Date() }
      })
      if (claimed.count !== 1) {
        throw new ConflictError(
          'Listing just sold',
          'این آگهی همین حالا به خریدار دیگری فروخته شد.'
        )
      }

      const totalPrice = Number(listing.unitPrice) * listing.quantity

      const debited = await tx.player.updateMany({
        where: { id: buyer.id, balance: { gte: totalPrice } },
        data: { balance: { decrement: totalPrice } }
      })
      if (debited.count !== 1) {
        throw new ValidationError(
          'Insufficient balance',
          insufficientFunds(
            totalPrice,
            Number(buyer.balance),
            `خرید ${listing.itemName} ×${listing.quantity}`,
            'می‌توانی تعداد کمتری از همین کالا بگیری یا اول پول جور کنی.'
          )
        )
      }
      // موجودی بعد از خرید برای پنل نتیجه: بازیکن باید بداند الان چقدر دارد،
      // نه فقط چقدر رفت (خرید بی‌دنباله، سؤالِ «الان چقدر مونده؟» بی‌پاسخ می‌گذارد).
      const buyerBalanceAfter = Number(buyer.balance) - totalPrice

      // کالا در لحظهٔ ثبت آگهی از انبار فروشنده کسر و نزد آگهی (Escrow) مانده است؛
      // اینجا فقط به خریدار منتقل می‌شود. کسر دوباره از انبار فروشنده یعنی نابودی
      // کالا، پس هیچ کسری در این مرحله وجود ندارد.

      await tx.playerInventory.upsert({
        where: { playerId_itemId: { playerId: buyer.id, itemId: listing.itemId } },
        create: { playerId: buyer.id, itemId: listing.itemId, quantity: listing.quantity },
        update: { quantity: { increment: listing.quantity } }
      })

      await tx.player.update({
        where: { id: listing.sellerPlayerId },
        data: { balance: { increment: totalPrice } }
      })

      await tx.financialTransaction.create({
        data: {
          amount: totalPrice,
          type: TransactionType.MARKET_TRADE,
          sourcePlayerId: buyer.id,
          destinationPlayerId: listing.sellerPlayerId,
          reference: `معاملهٔ بازیکنی — ${listing.itemName} ×${listing.quantity}`
        }
      })

      // حذف صفرشدگی انبار فروشنده (بهینه‌سازی حجم جدول)
      await tx.playerInventory.deleteMany({
        where: { playerId: listing.sellerPlayerId, quantity: { lte: 0 } }
      })

      const seller = await tx.player.findUniqueOrThrow({
        where: { id: listing.sellerPlayerId },
        select: { firstName: true, lastName: true }
      })

      return {
        itemName: listing.itemName,
        quantity: listing.quantity,
        totalPrice,
        sellerName: `${seller.firstName} ${seller.lastName ?? ''}`.trim(),
        sellerPlayerId: listing.sellerPlayerId,
        listingId: listing.id,
        buyerName: buyer.firstName,
        buyerBalanceAfter
      }
    })

    // رخدادِ خوراک بیرون از تراکنشِ پرداخت ثبت می‌شود: پول همین‌جا قطعی شده است،
    // پس یک ردیفِ خبری نباید وسطِ تراکنش با کانکسیونی دیگر نوشته شود (و اگر
    // تراکنش برگشت، ردیفِ بازمانده از آن بیرون نماند).
    this.eventService
      .recordPlayerEvent({
        playerId: sellerPlayerId,
        type: GameEventType.ITEM_SOLD,
        title: `فروش ${sold.itemName} ×${sold.quantity}`,
        amount: sold.totalPrice
      })
      .catch(() => {})

    // فروشنده تا پیش از این هیچ خبری نمی‌گرفت: پول بی‌صدا به موجودیش اضافه
    // می‌شد و فقط رخدادِ گروه می‌ماند. برای یک معاملهٔ پولی، خبرِ شخصی لازم است.
    // کلید ضدتکرار از شناسهٔ آگهی می‌آید (خریدِ یک آگهی فقط یک‌بار قطعی می‌شود).
    if (sellerPlayerId) {
      await this.notificationService
        ?.announce({
          playerId: sellerPlayerId,
          type: NotificationType.EVENT,
          level: 'CRITICAL',
          dedupeKey: `market-sold:${soldListingId}`,
          title: '🤝 کالایت در بازار فروش رفت',
          message: [
            `کالا: ${sold.itemName} ×${sold.quantity}`,
            `مبلغ: ${money(sold.totalPrice)} تومان`,
            `خریدار: ${buyerName}`,
            'مبلغ به کیفت واریز شد.'
          ].join('\n')
        })
        .catch(() => undefined)
    }

    // `buyerBalanceAfter` بخشی از قراردادِ برگشت است (پنل نتیجه موجودی پس از
    // خرید را نشان می‌دهد)؛ پیش‌تر از destructuring بیرون انداخته می‌شد.
    return { ...sold, buyerBalanceAfter }
  }

  /**
   * آزادسازی Lazy آگهی‌های منقضی.
   *
   * کالای هر آگهی در لحظهٔ ثبت از انبار فروشنده کسر و «نزد آگهی» نگه داشته
   * می‌شود. اگر آگهی منقضی شود و کسی آن را لغو نکند، کالا تا ابد قفل می‌ماند و
   * چون فهرست‌ها فقط آگهی‌های فعال را نشان می‌دهند، فروشنده حتی متوجه نمی‌شد.
   * این متد دارایی را به انبار صاحبش برمی‌گرداند؛ هر آگهی در تراکنش خودش
   * پردازش می‌شود و شکست یکی، بقیه را متوقف نمی‌کند.
   *
   * @returns تعداد آگهی‌هایی که آزاد شدند
   */
  async sweepExpired(limit = SWEEP_BATCH): Promise<number> {
    const now = new Date()
    const stale = await this.db.marketListing.findMany({
      where: { status: 'ACTIVE', expiresAt: { lt: now } },
      orderBy: { expiresAt: 'asc' },
      select: { id: true },
      take: Math.max(1, Math.min(100, Math.floor(limit)))
    })

    let swept = 0
    for (const row of stale) {
      const released = await this.db.$transaction(async (tx) => {
        // ادعای انحصاری: فقط یک فراخوان می‌تواند آگهی را منقضی کند، پس کالا
        // هرگز دوبار به انبار اضافه نمی‌شود.
        const claimed = await tx.marketListing.updateMany({
          where: { id: row.id, status: 'ACTIVE', expiresAt: { lt: new Date() } },
          data: { status: 'EXPIRED' }
        })
        if (claimed.count !== 1) {
          return null
        }

        const listing = await tx.marketListing.findUniqueOrThrow({
          where: { id: row.id },
          select: {
            sellerPlayerId: true,
            itemId: true,
            itemName: true,
            quantity: true,
            unitPrice: true
          }
        })

        await tx.playerInventory.upsert({
          where: {
            playerId_itemId: { playerId: listing.sellerPlayerId, itemId: listing.itemId }
          },
          create: {
            playerId: listing.sellerPlayerId,
            itemId: listing.itemId,
            quantity: listing.quantity
          },
          update: { quantity: { increment: listing.quantity } }
        })

        return listing
      })

      if (released) {
        swept += 1

        // کالا بی‌صدا به انبار برمی‌گشت و فروشنده فکر می‌کرد آگهی هنوز باز
        // است (فهرست‌ها فقط آگهی‌های فعال را نشان می‌دهند). این خبر یک حلقهٔ
        // بازِ بازیکن را می‌بندد و می‌گوید زودتر/ارزان‌تر دوباره بگذارد.
        await this.notificationService
          ?.announce({
            playerId: released.sellerPlayerId,
            type: NotificationType.INFO,
            level: 'IMPORTANT',
            dedupeKey: `market-expired:${row.id}`,
            title: '⏱️ آگهیت بدون خریدار تمام شد',
            message: [
              `کالا: ${released.itemName} ×${released.quantity}`,
              `قیمت پیشنهادی: ${money(Number(released.unitPrice))} تومان برای هر عدد`,
              'کالا به انبارت برگشت؛ هنوز قابل فروش است.',
              'می‌توانی قیمت را کمتر کنی و دوباره آگهی بگذاری.'
            ].join('\n')
          })
          .catch(() => undefined)
      }
    }

    return swept
  }

  /** فهرست آگهی‌های فعال (با آزادسازی آگهی‌های منقضی). */
  async listActive(page = 0) {
    await this.sweepExpired()
    const [total, rows] = await Promise.all([
      this.db.marketListing.count({
        where: { status: 'ACTIVE', expiresAt: { gt: new Date() } }
      }),
      this.db.marketListing.findMany({
        where: { status: 'ACTIVE', expiresAt: { gt: new Date() } },
        orderBy: { createdAt: 'desc' },
        skip: Math.max(0, page) * PAGE_SIZE,
        take: PAGE_SIZE,
        include: {
          seller: { select: { firstName: true, lastName: true } }
        }
      })
    ])

    const listings: MarketListingView[] = rows.map((r) => ({
      id: r.id,
      itemName: r.itemName,
      quantity: r.quantity,
      unitPrice: Number(r.unitPrice),
      totalPrice: Number(r.unitPrice) * r.quantity,
      sellerName: `${r.seller.firstName} ${r.seller.lastName ?? ''}`.trim()
    }))

    return { listings, page: Math.max(0, page), pageSize: PAGE_SIZE, total }
  }

  /** آگهی‌های فعال من (برای لغو) — آگهی‌های منقضی هم آزاد می‌شوند. */
  async listMine(telegramUserId: bigint) {
    await this.sweepExpired()
    const player = await this.db.player.findUnique({
      where: { telegramUserId },
      select: { id: true }
    })
    if (!player) {
      throw new NotFoundError('Player not found')
    }

    return this.db.marketListing.findMany({
      where: { sellerPlayerId: player.id, status: 'ACTIVE', expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
      take: 10
    })
  }

  /** لغو آگهی و بازگرداندن کالا به انبار. */
  async cancelListing(telegramUserId: bigint, listingId: string): Promise<void> {
    await this.db.$transaction(async (tx) => {
      const seller = await tx.player.findUnique({
        where: { telegramUserId },
        select: { id: true }
      })
      if (!seller) {
        throw new NotFoundError('Player not found')
      }

      const listing = await tx.marketListing.findUnique({ where: { id: listingId } })
      if (!listing || listing.sellerPlayerId !== seller.id || listing.status !== 'ACTIVE') {
        throw new NotFoundError(
          'Listing not found',
          'آگهی موردنظر فعال نیست. «بازار» را دوباره باز کن و آگهی دیگری انتخاب کن.'
        )
      }

      const claimed = await tx.marketListing.updateMany({
        where: { id: listing.id, status: 'ACTIVE' },
        data: { status: 'CANCELLED' }
      })
      if (claimed.count !== 1) {
        throw new ConflictError('Concurrent cancel', 'این آگهی همین حالا فروخته یا لغو شد.')
      }

      await tx.playerInventory.upsert({
        where: { playerId_itemId: { playerId: seller.id, itemId: listing.itemId } },
        create: { playerId: seller.id, itemId: listing.itemId, quantity: listing.quantity },
        update: { quantity: { increment: listing.quantity } }
      })
    })
  }
}
