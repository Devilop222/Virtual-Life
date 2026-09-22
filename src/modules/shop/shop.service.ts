import { PrismaClient, TransactionType } from '@prisma/client'
import { ConflictError, NotFoundError, ValidationError } from '../../utils/classes/errors'
import { SHOP_ITEMS, ShopItemDefinition } from './shop-catalog'
import { MARKET_CONFIG, computePriceMultiplier, priceTrendOf } from '../../config/market.config'
import { ProjectsService } from '../city/projects.service'
import { resolveMaxHealth } from '../health/max-health'
import { weekIndex, stableHash } from '../../utils/game-time'

const PAGE_SIZE = 12

/**
 * استخر کالاهای فصلی؛ هر هفته دو مورد با انتخاب قطعی فعال می‌شوند.
 * موجودی محدود واقعی دارند و پس از اتمام تا فصل بعد برنمی‌گردند.
 */
const SEASONAL_POOL: readonly (ShopItemDefinition & { key: string })[] = [
  {
    key: 'season_picnic_basket',
    name: 'سبد پیک‌نیک بهاری',
    description: 'پیک‌نیک کامل؛ خستگی را به‌شدت کم می‌کند',
    category: 'فصلی',
    price: 260_000,
    rarity: 'rare',
    stock: -1,
    effects: { fatigue: -45, health: 8 }
  },
  {
    key: 'season_sunscreen',
    name: 'ضدآفتاب تابستانی',
    description: 'محافظ تابستان؛ سلامت پایدار',
    category: 'فصلی',
    price: 180_000,
    rarity: 'uncommon',
    stock: -1,
    effects: { health: 18 }
  },
  {
    key: 'season_raincoat',
    name: 'بارانی پاییزی',
    description: 'همراه روزهای بارانی؛ کمی تجربهٔ آرامش',
    category: 'فصلی',
    price: 320_000,
    rarity: 'rare',
    stock: -1,
    effects: { health: 10, experience: 40 }
  },
  {
    key: 'season_winter_tea',
    name: 'چای زنجبیلی زمستانی',
    description: 'گرمای زمستان؛ رفع عمیق خستگی',
    category: 'فصلی',
    price: 140_000,
    rarity: 'uncommon',
    stock: -1,
    effects: { fatigue: -30, health: 5 }
  },
  {
    key: 'season_fireworks',
    name: 'مهر شب‌نشینی',
    description: 'جشن کوچک؛ تجربهٔ قابل توجه',
    category: 'فصلی',
    price: 520_000,
    rarity: 'epic',
    stock: -1,
    effects: { experience: 120 }
  },
  {
    key: 'season_herbal_mix',
    name: 'دمنوش کوهستانی',
    description: 'ترکیب گیاهان کوهستان؛ تعادل کامل',
    category: 'فصلی',
    price: 240_000,
    rarity: 'rare',
    stock: -1,
    effects: { health: 12, fatigue: -22 }
  }
]

/** تعداد کالاهای فعال در هر فصل. */
const SEASONAL_ACTIVE_COUNT = 2
/** موجودی هر کالای فصلی. */
const SEASONAL_STOCK = 25
/** کلید همهٔ کالاهای فصلی برای فیلترها. */
const SEASONAL_ALL_KEYS = SEASONAL_POOL.map((item) => item.key)

/** کلیدهای فعال این هفته — انتخاب قطعی و بدون تصادف. */
function seasonalKeysOfWeek(week = weekIndex()): string[] {
  const shuffled = [...SEASONAL_ALL_KEYS].sort(
    (a, b) =>
      (stableHash(`season:${week}:${a}`) % 10000) -
      (stableHash(`season:${week}:${b}`) % 10000)
  )
  return shuffled.slice(0, SEASONAL_ACTIVE_COUNT)
}
/** بازهٔ اعتبار Seed تا در هر درخواست دوباره upsert اجرا نشود. */
const SEED_TTL_MS = 30 * 60 * 1000

let lastSeedAt = 0

export interface PricedItem {
  id: string
  key: string
  name: string
  description: string
  category: string
  rarity: string
  stock: number
  effects: unknown
  basePrice: number
  currentPrice: number
  trend: 'up' | 'down' | 'stable'
}

/**
 * فروشگاه با قیمت‌گذاری پویا.
 *
 * قیمت هر کالا از قیمت پایه × ضریب بازار محاسبه می‌شود.
 * ضریب بازار فقط هر ۱۵ دقیقه یک‌بار بازمحاسبه می‌شود (نه در هر کلیک) و
 * در هر مرحله حداکثر ۵٪ تغییر می‌کند تا نوسان انفجاری رخ ندهد.
 */
export class ShopService {
  constructor(
    private readonly db: PrismaClient,
    private readonly projectsService?: ProjectsService
  ) {}

  /** تخفیف بازارچهٔ منطقهٔ اقامت بازیکن؛ نبود سرویس پروژه‌ها یعنی بدون تخفیف. */
  private async regionDiscount(homeGroupId: string | null): Promise<number> {
    if (!this.projectsService || !homeGroupId) {
      return 0
    }
    const buffs = await this.projectsService.getRegionBuffs(homeGroupId).catch(() => null)
    return buffs?.shopDiscount ?? 0
  }

  /**
   * Seed کاتالوگ با TTL؛ قیمت پایه و متادیتا به‌روزرسانی می‌شوند اما
   * ضریب بازار و *موجودی* دست‌نخورده می‌مانند.
   *
   * موجودی عمداً بازنویسی نمی‌شود: کالاهای محدود (اکسیر، کریستال دانش)
   * با خرید کم می‌شوند و اگر هر ۳۰ دقیقه به مقدار اولیه برمی‌گشتند،
   * «موجودی محدود» دیگر محدود نبود (تأمین بی‌پایان کالای اسطوره‌ای).
   */
  async ensureSeeded(force = false): Promise<void> {
    if (!force && Date.now() - lastSeedAt < SEED_TTL_MS) {
      return
    }
    lastSeedAt = Date.now()

    for (const item of SHOP_ITEMS) {
      await this.db.shopItem.upsert({
        where: { key: item.key },
        create: this.toCreate(item),
        update: {
          name: item.name,
          description: item.description,
          category: item.category,
          price: item.price,
          rarity: item.rarity,
          effects: item.effects as never,
          active: true
        }
      })
    }
  }

  private toCreate(item: ShopItemDefinition) {
    return {
      key: item.key,
      name: item.name,
      description: item.description,
      category: item.category,
      price: item.price,
      rarity: item.rarity,
      stock: item.stock,
      effects: item.effects as never,
      active: true
    }
  }

  /** قیمت نهایی یک کالا با اعمال ضریب بازار و تخفیف منطقه. */
  private priceOf(basePrice: number, multiplier: number, discount = 0): number {
    const market = basePrice * multiplier
    return Math.max(1, Math.round(market * (1 - discount)))
  }

  /**
   * بازمحاسبهٔ قیمت‌های بازار.
   * برای صرفه‌جویی، فقط کالاهایی که بازهٔ بازمحاسبه‌شان گذشته است پردازش می‌شوند.
   * شاخص اقتصادی میانگین مناطق به‌عنوان عامل رونق استفاده می‌شود.
   */
  async refreshPrices(): Promise<number> {
    const cutoff = new Date(Date.now() - MARKET_CONFIG.recalcIntervalMs)
    const stale = await this.db.shopItem.findMany({
      where: { active: true, lastPriceUpdateAt: { lt: cutoff } },
      select: {
        id: true,
        stock: true,
        priceMultiplier: true,
        recentPurchases: true
      },
      take: 50
    })

    if (stale.length === 0) {
      return 0
    }

    const economyAgg = await this.db.regionStat.aggregate({ _avg: { economicIndex: true } })
    const economicIndex = Math.round(Number(economyAgg._avg.economicIndex ?? 50))

    let updated = 0
    for (const item of stale) {
      const currentMultiplier = Number(item.priceMultiplier)
      const nextMultiplier = computePriceMultiplier({
        currentMultiplier,
        recentPurchases: item.recentPurchases,
        stock: item.stock,
        economicIndex
      })

      await this.db.shopItem.updateMany({
        where: { id: item.id, lastPriceUpdateAt: { lt: cutoff } },
        data: {
          previousMultiplier: currentMultiplier,
          priceMultiplier: nextMultiplier,
          // شمارندهٔ تقاضا پس از هر بازمحاسبه صفر می‌شود
          recentPurchases: 0,
          lastPriceUpdateAt: new Date()
        }
      })
      updated += 1
    }

    return updated
  }

  /**
   * کاتالوگ با قیمت‌های جاری بازار.
   * اگر شناسهٔ بازیکن داده شود، تخفیف بازارچهٔ منطقه‌اش در قیمت‌ها اعمال می‌شود
   * تا قیمت نمایش‌داده‌شده با قیمت لحظهٔ خرید یکی باشد.
   */
  async getCatalog(category?: string, telegramUserId?: bigint): Promise<PricedItem[]> {
    await this.ensureSeeded()
    await this.refreshPrices().catch(() => 0)
    if (!category) {
      await this.ensureSeasonalItems().catch(() => undefined)
    }

    // دستهٔ «فصلی» فقط ردیف‌های همین هفته را نشان می‌دهد
    const where =
      category === 'فصلی'
        ? { active: true, key: { in: seasonalKeysOfWeek() } }
        : {
            active: true,
            ...(category ? { category } : { key: { notIn: SEASONAL_ALL_KEYS } })
          }

    const [rows, discount] = await Promise.all([
      this.db.shopItem.findMany({
        where,
        orderBy: [{ category: 'asc' }, { price: 'asc' }]
      }),
      telegramUserId === undefined ? Promise.resolve(0) : this.discountFor(telegramUserId)
    ])

    return rows.map((row) => {
      const basePrice = Number(row.price)
      const multiplier = Number(row.priceMultiplier)
      return {
        id: row.id,
        key: row.key,
        name: row.name,
        description: row.description,
        category: row.category,
        rarity: row.rarity,
        stock: row.stock,
        effects: row.effects,
        basePrice,
        currentPrice: this.priceOf(basePrice, multiplier, discount),
        trend: priceTrendOf(multiplier, Number(row.previousMultiplier))
      }
    })
  }

  /**
   * تضمین ردیف‌های کالاهای فصل جاری.
   *
   * هر هفته دو کالا از استخر فصلی با انتخاب قطعی (hash هفته) فعال می‌شوند؛
   * ردیف‌ها با createMany و skipDuplicates ساخته می‌شوند تا هم Idempotent باشد
   * و هم هیچ Query اضافه‌ای در مسیر داغ نزند.
   */
  private async ensureSeasonalItems(): Promise<void> {
    const keys = seasonalKeysOfWeek()
    const definitions = SEASONAL_POOL.filter((item) => keys.includes(item.key))
    if (definitions.length === 0) {
      return
    }

    await this.db.shopItem
      .createMany({
        data: definitions.map((item) => ({
          key: item.key,
          name: item.name,
          description: item.description,
          category: 'فصلی',
          price: item.price,
          rarity: item.rarity,
          stock: SEASONAL_STOCK,
          effects: (item.effects ?? {}) as Record<string, number>
        })),
        skipDuplicates: true
      })
      .catch(() => undefined)

    // غیرفعال‌کردن نسخه‌های فصول گذشته تا در دستهٔ فصلی دیده نشوند
    await this.db.shopItem.updateMany({
      where: { category: 'فصلی', key: { notIn: keys } },
      data: { active: false }
    })
    await this.db.shopItem.updateMany({
      where: { category: 'فصلی', key: { in: keys }, active: false },
      data: { active: true }
    })
  }

  /** تخفیف منطقهٔ اقامت یک بازیکن بر اساس شناسهٔ تلگرام. */
  private async discountFor(telegramUserId: bigint): Promise<number> {
    if (!this.projectsService) {
      return 0
    }
    const player = await this.db.player.findUnique({
      where: { telegramUserId },
      select: { homeGroupId: true }
    })
    return this.regionDiscount(player?.homeGroupId ?? null)
  }

  /**
   * خرید کالا با قیمت جاری بازار.
   * کسر موجودی و موجودی انبار هر دو شرطی و اتمیک هستند.
   * تخفیف پروژهٔ بازارچه پیش از تراکنش محاسبه می‌شود تا تراکنش کوتاه بماند.
   */
  async buyItem(telegramUserId: bigint, itemKey: string) {
    await this.ensureSeeded()
    const discount = await this.discountFor(telegramUserId)

    return this.db.$transaction(async (tx) => {
      const item = await tx.shopItem.findUnique({ where: { key: itemKey } })
      if (!item || !item.active) {
        throw new NotFoundError('Item not found', 'کالای موردنظر در فروشگاه موجود نیست. فهرست را به‌روزرسانی کن و کالای دیگری انتخاب کن.')
      }

      const player = await tx.player.findUnique({
        where: { telegramUserId },
        select: { id: true, balance: true }
      })
      if (!player) {
        throw new NotFoundError('Player not found')
      }

      const price = this.priceOf(Number(item.price), Number(item.priceMultiplier), discount)

      // ابتدا موجودی انبار رزرو می‌شود؛ خطا کل تراکنش را برمی‌گرداند
      if (item.stock !== -1) {
        const stockResult = await tx.shopItem.updateMany({
          where: { id: item.id, stock: { gt: 0 } },
          data: { stock: { decrement: 1 } }
        })
        if (stockResult.count !== 1) {
          throw new ConflictError('Item out of stock', 'موجودی این کالا تمام شده است.')
        }
      }

      const moneyResult = await tx.player.updateMany({
        where: { id: player.id, balance: { gte: price } },
        data: { balance: { decrement: price } }
      })
      if (moneyResult.count !== 1) {
        throw new ValidationError(
          'Insufficient balance',
          'موجودی کیف پولت برای خرید این کالا کافی نیست. قیمت را بررسی کن یا از بانک برداشت کن.'
        )
      }

      const inventory = await tx.playerInventory.upsert({
        where: { playerId_itemId: { playerId: player.id, itemId: item.id } },
        create: { playerId: player.id, itemId: item.id, quantity: 1 },
        update: { quantity: { increment: 1 } }
      })

      // ثبت تقاضا برای قیمت‌گذاری آینده
      await tx.shopItem.update({
        where: { id: item.id },
        data: {
          purchaseCount: { increment: 1 },
          recentPurchases: { increment: 1 }
        }
      })

      await tx.financialTransaction.create({
        data: {
          amount: price,
          type: TransactionType.SHOP_PURCHASE,
          sourcePlayerId: player.id,
          reference: `خرید از فروشگاه: ${item.name}`
        }
      })

      return { inventory, item: { id: item.id, name: item.name }, price }
    })
  }

  async listInventory(telegramUserId: bigint, page = 0) {
    const player = await this.db.player.findUnique({
      where: { telegramUserId },
      select: { id: true }
    })
    if (!player) {
      throw new NotFoundError('Player not found')
    }

    const where = { playerId: player.id, quantity: { gt: 0 } }
    // ارزش روی **همهٔ** ردیف‌ها حساب می‌شود، نه فقط صفحهٔ جاری: بازیکن باید
    // بداند کل انبارش چقدر می‌ارزد، حتی وقتی صد قلم کالا دارد و ۱۲ تایش را
    // می‌بیند.
    const [total, rows, totalValue] = await Promise.all([
      this.db.playerInventory.count({ where }),
      this.db.playerInventory.findMany({
        where,
        include: {
          item: { select: { id: true, key: true, name: true, rarity: true, effects: true } }
        },
        orderBy: { updatedAt: 'desc' },
        skip: Math.max(0, page) * PAGE_SIZE,
        take: PAGE_SIZE
      }),
      this.getInventoryValue(player.id)
    ])

    return { total, page, pageSize: PAGE_SIZE, rows, totalValue }
  }

  /**
   * ارزش تقریبی انبار به قیمت فروشگاه.
   *
   * چرا لازم است؟ بازیکن پیش از گذاشتن کالا در بازار باید بداند کل انبارش
   * چقدر می‌ارزد؛ بدون این عدد، تصمیم «بفروشم یا نگه دارم» کورکورانه بود.
   * عدد به قیمت فروشگاه است، نه قیمت فروش به بازیکن دیگر — و همین در متن
   * پنل گفته می‌شود تا با واقعیت معامله اشتباه گرفته نشود.
   */
  async getInventoryValue(playerId: string): Promise<number> {
    const rows = await this.db.playerInventory.findMany({
      where: { playerId, quantity: { gt: 0 } },
      select: { quantity: true, item: { select: { price: true, priceMultiplier: true } } }
    })
    return rows.reduce(
      (acc, row) =>
        acc + row.quantity * this.priceOf(Number(row.item.price), Number(row.item.priceMultiplier)),
      0
    )
  }


  async useItem(inventoryId: string, telegramUserId: bigint) {
    return this.db.$transaction(async (tx) => {
      const row = await tx.playerInventory.findUnique({
        where: { id: inventoryId },
        include: {
          item: true,
          player: {
            select: {
              id: true,
              telegramUserId: true,
              health: true,
              fatigue: true,
              experience: true
            }
          }
        }
      })
      if (!row || row.quantity <= 0) {
        throw new NotFoundError('Item not found', 'این کالا در انبارت موجود نیست. «انبار» را به‌روزرسانی کن یا آن را از «فروشگاه» بخر.')
      }

      // بررسی مالکیت سمت سرور: کاربر فقط کالای خودش را می‌تواند استفاده کند
      if (row.player.telegramUserId !== telegramUserId) {
        throw new NotFoundError('Item not found', 'این کالا در انبارت موجود نیست. «انبار» را به‌روزرسانی کن یا آن را از «فروشگاه» بخر.')
      }

      const claimed = await tx.playerInventory.updateMany({
        where: { id: row.id, quantity: { gt: 0 } },
        data: { quantity: { decrement: 1 } }
      })
      if (claimed.count !== 1) {
        throw new ConflictError('Nothing to use', 'این کالا دیگر در انبارت موجود نیست؛ ممکن است مصرف یا فروخته شده باشد. «انبار» را به‌روزرسانی کن.')
      }

      const effects = (row.item.effects as Record<string, number>) ?? {}
      // سقف واقعی سلامت (عضو باشگاه = ۱۲۰)؛ clamp قدیمیِ ۱۰۰ برای عضو باشگاه
      // سلامت را «کم» می‌کرد (۱۱۵ + کالای درمانی → ۱۰۰) و کالا هم سوخته می‌شد.
      const maxHealth = await resolveMaxHealth(tx, row.player.id)
      const health = Math.min(maxHealth, Math.max(0, row.player.health + (effects.health ?? 0)))
      const fatigue = Math.min(100, Math.max(0, row.player.fatigue + (effects.fatigue ?? 0)))
      const experience = Math.max(0, row.player.experience + (effects.experience ?? 0))

      await tx.player.update({
        where: { id: row.player.id },
        data: { health, fatigue, experience }
      })

      return {
        itemName: row.item.name,
        effects,
        health,
        maxHealth,
        fatigue,
        experience
      }
    })
  }
}
