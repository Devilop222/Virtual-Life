import { GameEventType, NotificationType, PrismaClient, TransactionType } from '@prisma/client'
import { HousingRepository } from '../../database/repositories/housing.repository'
import { ConflictError, NotFoundError, ValidationError } from '../../utils/classes/errors'
import { EventService } from '../events/event.service'
import { cycleAmount, cycleRate, daysUntil, gameDays } from '../../utils/game-time'
import type { NotificationLevel } from '../notification/push'
import { logger } from '../../utils/logger'

/** بازهٔ مجاز تغییر قیمت اجاره نسبت به قیمت پایهٔ ملک. */
const PRICE_MIN_RATIO = 0.7
const PRICE_MAX_RATIO = 1.3
/** مدت هر قرارداد اجاره: یک ماه بازی (۳۰ روز بازی ≈ ۲۴ ساعت واقعی). */
const CONTRACT_DAYS = 30
/**
 * بازده مرجع اجاره: ۶٪ در ماه — که در تقویم تازه «۶٪ در ماه *واقعی*» است،
 * چون هر ماه بازی یک روز واقعی طول می‌کشد. پس رقمِ ماهِ بازی ۶٪ ÷ ۳۰ = ۰٫۲٪
 * است و اجاره‌بها در زمان واقعی هیچ تغییری نمی‌کند (بدون تورم/ریاضت).
 */
const RENT_REFERENCE_RATE = cycleRate(0.06)
/** کف پایهٔ اجاره، هم‌تراز با ریتم ماهِ بازی. */
const RENT_BASE_FLOOR = cycleAmount(100_000)

/** سطح اعلان‌های اجاره: پول بین دو بازیکن جابه‌جا می‌شود، پس CRITICAL. */
const RENT_LEVEL: NotificationLevel = 'CRITICAL'
const TENANT_LEVEL: NotificationLevel = 'IMPORTANT'

export interface OwnerPropertyView {
  id: string
  title: string
  level: number
  baseRent: number
  minRent: number
  maxRent: number
  listedForRent: boolean
  tenantName: string | null
  activeRentAmount: number | null
  daysLeft: number
  /** مجموعِ اجاره‌های واقعیِ واریز‌شده از قراردادِ فعالِ جاری (نه تخمین). */
  totalRentReceived: number
}

export interface RentableView {
  propertyId: string
  title: string
  level: number
  monthlyRent: number
  ownerName: string
  recoveryBonusPercent: number
}

export interface TenancyView {
  contractId: string
  propertyTitle: string
  monthlyRent: number
  daysLeft: number
  ownerName: string
}

/**
 * بازار اجارهٔ ملک بین بازیکنان با Lifecycle کامل:
 *
 *   Property Owned → Available for Rent → Contract (پول ماه اول)
 *   → Active Rental → Rent Due → Payment (تمدید) → ... → End/Vacated
 *
 * چرا اقتصاد را نمی‌شکند:
 *  • پول در هر پرداخت از یک بازیکن به بازیکن دیگر می‌رود (Zero-sum).
 *  • قیمت در بازهٔ ۷۰٪ تا ۱۳۰٪ قیمت پایه محدود است (ضد پول‌شویی و نجومی).
 *  • هر ملک فقط یک قرارداد فعال، و هر مستأجر فقط یک قرارداد فعال دارد
 *    (Partial Unique Index در دیتابیس).
 *
 * انقضای قرارداد Lazy است (بدون تایمر): اولین بازدیدِ مالک یا مستأجر
 * قراردادِ سررسیدشده را می‌بندد و به هر دو طرف اعلان می‌رود — ملک دوباره
 * خالی می‌شود و مستأجر دیگر خانهٔ استراحت ندارد.
 */
export class RentalService {
  private readonly notificationService: {
    notifyPlayerById: (
      playerId: string,
      title: string,
      message: string,
      type?: NotificationType,
      dedupeKey?: string,
      level?: NotificationLevel
    ) => Promise<boolean>
  } | null

  constructor(
    private readonly db: PrismaClient,
    private readonly housingRepository: HousingRepository,
    private readonly eventService: EventService,
    notificationService?: {
      notifyPlayerById: (
        playerId: string,
        title: string,
        message: string,
        type?: NotificationType,
        dedupeKey?: string,
        level?: NotificationLevel
      ) => Promise<boolean>
    }
  ) {
    this.notificationService = notificationService ?? null
  }

  /** پایهٔ محاسبهٔ بازهٔ مجاز اجاره.
   *
   * از قیمت خرید ملک مشتق می‌شود (۶٪ ماهانه) و نه از مقدار فعلی اجاره‌بها؛
   * در غیر این صورت مالک می‌توانست با تغییرهای پله‌پله‌ای ±۳۰٪ قیمت را تا
   * بی‌نهایت بالا ببرد (باگ نردبان). این پایه ثابت و دست‌کاری‌ناپذیر است.
   */
  private rentBaseOf(purchasePrice: number): number {
    return Math.max(RENT_BASE_FLOOR, Math.round(purchasePrice * RENT_REFERENCE_RATE))
  }

  private notify(playerId: string, title: string, message: string, level: NotificationLevel, dedupeKey?: string): void {
    if (!this.notificationService) return
    this.notificationService
      .notifyPlayerById(playerId, title, message, NotificationType.EVENT, dedupeKey, level)
      .catch(() => undefined)
  }

  /**
   * انقضای Lazy: قراردادهای سررسیدشدهٔ املاکِ این مالک بسته می‌شوند و
   * هر دو طرف اعلان می‌گیرند. خطا پنل را نمی‌شکند.
   */
  private async closeExpiredForOwner(ownerId: string): Promise<void> {
    try {
      const expired = await this.db.rentalContract.findMany({
        where: { isActive: true, expiresAt: { lte: new Date() }, property: { ownerId } },
        take: 10,
        select: {
          id: true,
          tenantId: true,
          tenant: { select: { firstName: true } },
          property: { select: { title: true } }
        }
      })
      for (const contract of expired) {
        const ended = await this.db.rentalContract.updateMany({
          where: { id: contract.id, isActive: true, expiresAt: { lte: new Date() } },
          data: { isActive: false }
        })
        if (ended.count !== 1) continue
        this.expireNotifications(contract.id, contract.tenantId, contract.tenant.firstName, contract.property.title, ownerId)
      }
    } catch (error) {
      logger.debug({ err: error }, 'rental expiry sweep (owner) skipped')
    }
  }

  /** انقضای Lazy برای قراردادهای خودِ مستأجر. */
  private async closeExpiredForTenant(tenantId: string): Promise<void> {
    try {
      const expired = await this.db.rentalContract.findMany({
        where: { isActive: true, expiresAt: { lte: new Date() }, tenantId },
        take: 5,
        select: {
          id: true,
          tenant: { select: { firstName: true } },
          property: { select: { title: true, ownerId: true } }
        }
      })
      for (const contract of expired) {
        const ended = await this.db.rentalContract.updateMany({
          where: { id: contract.id, isActive: true, expiresAt: { lte: new Date() } },
          data: { isActive: false }
        })
        if (ended.count !== 1) continue
        this.expireNotifications(contract.id, tenantId, contract.tenant.firstName, contract.property.title, contract.property.ownerId)
      }
    } catch (error) {
      logger.debug({ err: error }, 'rental expiry sweep (tenant) skipped')
    }
  }

  /** اعلان پایان قرارداد برای هر دو طرف؛ کلید یکتا = یک اعلان برای هر قرارداد. */
  private expireNotifications(
    contractId: string,
    tenantId: string,
    tenantFirstName: string,
    propertyTitle: string,
    ownerId: string | null
  ): void {
    this.notify(
      tenantId,
      'پایان قرارداد اجاره',
      [
        `ملک: ${propertyTitle}`,
        'مدت قرارداد به پایان رسید؛ حالا دیگر ملک استراحت نداری.',
        'برای ادامه، پیش از پایان قرارداد «پرداخت اجاره» بزن یا ملک تازه‌ای اجاره کن.'
      ].join('\n'),
      TENANT_LEVEL,
      `rental-expired-tenant:${contractId}`
    )
    if (ownerId) {
      this.notify(
        ownerId,
        'پایان قرارداد اجاره',
        [
          `ملک: ${propertyTitle}`,
          `مستأجر: ${tenantFirstName}`,
          'قرارداد به پایان رسید و ملک خالی شد؛ حالا می‌توانی دوباره عرضه کنی یا خودت در آن استراحت کنی.'
        ].join('\n'),
        'INFORMATIONAL',
        `rental-expired-owner:${contractId}`
      )
    }
  }

  /** املاک بازیکن با وضعیت عرضه و قرارداد فعال. */
  async getOwnerBoard(telegramUserId: bigint): Promise<OwnerPropertyView[]> {
    const player = await this.requirePlayer(telegramUserId)

    // انقضای Lazy: قبل از نمایش، قراردادهای سررسیدشدهٔ املاکش بسته شوند
    await this.closeExpiredForOwner(player.id)

    const properties = await this.db.property.findMany({
      where: { ownerId: player.id },
      orderBy: { level: 'desc' },
      select: {
        id: true,
        title: true,
        level: true,
        rentalPriceMonthly: true,
        purchasePrice: true,
        isListedForRent: true,
        rentalContracts: {
          where: { isActive: true, expiresAt: { gt: new Date() } },
          take: 1,
          select: {
            monthlyRent: true,
            startedAt: true,
            expiresAt: true,
            tenant: { select: { firstName: true, lastName: true } }
          }
        }
      }
    })

    // مجموعِ دریافتی از قراردادِ فعال: از ردیف‌های واقعیِ PROPERTY_RENT که
    // referenceشان شناسهٔ همین ملک است و پس از امضای قراردادِ جاری ایجاد شده‌اند.
    const rentSums = new Map<string, number>()
    await Promise.all(
      properties
        .filter((p) => p.rentalContracts[0])
        .map(async (p) => {
          const contract = p.rentalContracts[0]!
          const agg = await this.db.financialTransaction.aggregate({
            where: {
              type: TransactionType.PROPERTY_RENT,
              destinationPlayerId: player.id,
              reference: { contains: p.id },
              createdAt: { gte: contract.startedAt }
            },
            _sum: { amount: true }
          })
          rentSums.set(p.id, Number(agg._sum.amount ?? 0))
        })
    )

    return properties.map((property) => {
      // پایهٔ بازه از قیمت خرید مشتق می‌شود تا نردبان افزایش قیمت ناممکن بماند
      const base = this.rentBaseOf(Number(property.purchasePrice))
      const contract = property.rentalContracts[0]
      return {
        id: property.id,
        title: property.title,
        level: property.level,
        baseRent: base,
        minRent: Math.round(base * PRICE_MIN_RATIO),
        maxRent: Math.round(base * PRICE_MAX_RATIO),
        listedForRent: property.isListedForRent,
        tenantName: contract
          ? `${contract.tenant.firstName} ${contract.tenant.lastName ?? ''}`.trim()
          : null,
        activeRentAmount: contract ? Number(contract.monthlyRent) : null,
        daysLeft: contract ? daysUntil(contract.expiresAt) : 0,
        totalRentReceived: contract ? (rentSums.get(property.id) ?? 0) : 0
      }
    })
  }

  /** عرضه یا برداشتن ملک از بازار اجاره. */
  async setListed(
    telegramUserId: bigint,
    propertyId: string,
    listed: boolean
  ): Promise<{ title: string; listed: boolean; monthlyRent: number }> {
    const player = await this.requirePlayer(telegramUserId)

    const property = await this.db.property.findUnique({
      where: { id: propertyId },
      select: { id: true, ownerId: true, title: true, rentalPriceMonthly: true }
    })
    if (!property || property.ownerId !== player.id) {
      throw new NotFoundError('Property not found', 'این ملک متعلق به تو نیست. از «خانه» املاک خودت را ببین.')
    }

    if (!listed) {
      const active = await this.db.rentalContract.count({
        where: { propertyId, isActive: true, expiresAt: { gt: new Date() } }
      })
      if (active > 0) {
        throw new ConflictError(
          'Active contract',
          'این ملک قرارداد فعال دارد؛ تا پایان قرارداد نمی‌توان آن را از بازار برداشت.'
        )
      }
    }

    await this.db.property.update({
      where: { id: property.id },
      data: { isListedForRent: listed }
    })

    return {
      title: property.title,
      listed,
      monthlyRent: Number(property.rentalPriceMonthly)
    }
  }

  /** تعیین اجاره‌بهای ماهانه در بازهٔ مجاز. */
  async setRent(
    telegramUserId: bigint,
    propertyId: string,
    monthlyRent: number
  ): Promise<{ title: string; monthlyRent: number }> {
    const player = await this.requirePlayer(telegramUserId)

    const property = await this.db.property.findUnique({
      where: { id: propertyId },
      select: { id: true, ownerId: true, title: true, purchasePrice: true, rentalPriceMonthly: true }
    })
    if (!property || property.ownerId !== player.id) {
      throw new NotFoundError('Property not found', 'این ملک متعلق به تو نیست. از «خانه» املاک خودت را ببین.')
    }

    // مبنای بازه از قیمت خرید ملک مشتق می‌شود (ضد باگ نردبان قیمت)
    const base = this.rentBaseOf(Number(property.purchasePrice))
    const min = Math.round(base * PRICE_MIN_RATIO)
    const max = Math.round(base * PRICE_MAX_RATIO)

    if (!Number.isSafeInteger(monthlyRent) || monthlyRent < min || monthlyRent > max) {
      throw new ValidationError(
        'Rent out of range',
        `اجاره‌بها باید بین ${min.toLocaleString('fa-IR')} و ${max.toLocaleString('fa-IR')} تومان باشد.`
      )
    }

    const active = await this.db.rentalContract.count({
      where: { propertyId, isActive: true, expiresAt: { gt: new Date() } }
    })
    if (active > 0) {
      throw new ConflictError(
        'Active contract',
        'تا پایان قرارداد فعال نمی‌توانی اجاره‌بها را تغییر دهی.'
      )
    }

    await this.db.property.update({
      where: { id: property.id },
      data: { rentalPriceMonthly: monthlyRent }
    })

    return { title: property.title, monthlyRent }
  }

  /** آگهی‌های اجارهٔ فعال (به‌جز املاک خود بازیکن). */
  async listRentable(telegramUserId: bigint): Promise<RentableView[]> {
    const player = await this.requirePlayer(telegramUserId)

    const rows = await this.db.property.findMany({
      where: {
        isListedForRent: true,
        ownerId: { not: null, notIn: [player.id] },
        rentalContracts: {
          none: { isActive: true, expiresAt: { gt: new Date() } }
        }
      },
      orderBy: { rentalPriceMonthly: 'asc' },
      take: 12,
      select: {
        id: true,
        title: true,
        level: true,
        rentalPriceMonthly: true,
        owner: { select: { firstName: true, lastName: true } }
      }
    })

    return rows.map((row) => ({
      propertyId: row.id,
      title: row.title,
      level: row.level,
      monthlyRent: Number(row.rentalPriceMonthly),
      ownerName: row.owner
        ? `${row.owner.firstName} ${row.owner.lastName ?? ''}`.trim()
        : 'نامشخص',
      // همان ضریبی که موتور استراحت استفاده می‌کند: هر سطح ۵۰٪ بهتر
      recoveryBonusPercent: Math.round((row.level - 1) * 50)
    }))
  }

  /** قرارداد فعال بازیکن به‌عنوان مستأجر. */
  async getTenancy(telegramUserId: bigint): Promise<TenancyView | null> {
    const player = await this.requirePlayer(telegramUserId)

    // انقضای Lazy: اگر قراردادش سررسید شده باشد، همین‌جا بسته و اعلام می‌شود
    await this.closeExpiredForTenant(player.id)

    const contract = await this.db.rentalContract.findFirst({
      where: { tenantId: player.id, isActive: true, expiresAt: { gt: new Date() } },
      select: {
        id: true,
        monthlyRent: true,
        expiresAt: true,
        property: {
          select: { title: true, owner: { select: { firstName: true, lastName: true } } }
        }
      }
    })
    if (!contract) {
      return null
    }

    return {
      contractId: contract.id,
      propertyTitle: contract.property.title,
      monthlyRent: Number(contract.monthlyRent),
      daysLeft: daysUntil(contract.expiresAt),
      ownerName: contract.property.owner
        ? `${contract.property.owner.firstName} ${contract.property.owner.lastName ?? ''}`.trim()
        : 'نامشخص'
    }
  }

  /**
   * بستن قرارداد اجاره (ماه اول).
   * منطق مالی اتمیک در `housingRepository.rentProperty` پیاده شده است؛
   * این متد فقط عرضه‌بودن ملک را می‌سنجد، رخداد و اعلان‌ها را ثبت می‌کند.
   */
  async rent(
    telegramUserId: bigint,
    propertyId: string
  ): Promise<{ propertyTitle: string; monthlyRent: number; daysLeft: number; contractId: string }> {
    const player = await this.requirePlayer(telegramUserId)

    const property = await this.db.property.findUnique({
      where: { id: propertyId },
      select: { id: true, title: true, isListedForRent: true, ownerId: true }
    })
    if (!property) {
      throw new NotFoundError('Property not found', 'این ملک یافت نشد. فهرست «خانه» را دوباره باز کن و ملک موجود را انتخاب کن.')
    }
    if (!property.isListedForRent) {
      throw new ConflictError('Not listed', 'این ملک در بازار اجاره عرضه نشده است.')
    }

    const contract = await this.housingRepository.rentProperty(
      propertyId,
      player.id,
      CONTRACT_DAYS
    )

    const monthlyRent = Number(contract.monthlyRent)

    await this.eventService
      .recordPlayerEvent({
        playerId: player.id,
        type: GameEventType.HOUSE_RENTED,
        title: `اجارهٔ ${property.title}`,
        amount: monthlyRent,
        dedupeKey: `rent:${contract.id}`
      })
      .catch(() => undefined)

    // اعلان مالک: قرارداد تازه + دریافت اجارهٔ ماه اول (CRITICAL — پول واقعی)
    if (property.ownerId) {
      const tenant = await this.db.player
        .findUnique({ where: { id: player.id }, select: { firstName: true, lastName: true } })
        .catch(() => null)
      const tenantName = tenant ? `${tenant.firstName} ${tenant.lastName ?? ''}`.trim() : 'مستأجر تازه'
      this.notify(
        property.ownerId,
        'قرارداد اجارهٔ جدید',
        [
          `ملک: ${property.title}`,
          `مستأجر: ${tenantName}`,
          `اجارهٔ ماهانه: ${monthlyRent.toLocaleString('fa-IR')} تومان`,
          `مدت: ۱ ماه بازی (${CONTRACT_DAYS} روز بازی) — اجارهٔ ماه اول دریافت شد`,
          'وضعیت: فعال'
        ].join('\n'),
        RENT_LEVEL,
        `rental-new-owner:${contract.id}`
      )
      await this.eventService
        .recordPlayerEvent({
          playerId: property.ownerId,
          type: GameEventType.RENT_INCOME,
          title: `درآمد اجارهٔ ${property.title}`,
          amount: monthlyRent,
          dedupeKey: `rent-income:${contract.id}`
        })
        .catch(() => undefined)
    }

    // اعلان مستأجر: قراردادش ثبت شد (IMPORTANT)
    this.notify(
      player.id,
      'قرارداد اجاره ثبت شد',
      [
        `ملک: ${property.title}`,
        `اجارهٔ ماهانه: ${monthlyRent.toLocaleString('fa-IR')} تومان (ماه اول پرداخت شد)`,
        `مدت: ۱ ماه بازی (${CONTRACT_DAYS} روز بازی)`,
        'برای تمدید، پیش از پایان قرارداد «پرداخت اجاره» بزن.'
      ].join('\n'),
      TENANT_LEVEL,
      `rental-new-tenant:${contract.id}`
    )

    return {
      propertyTitle: property.title,
      monthlyRent,
      daysLeft: daysUntil(contract.expiresAt),
      contractId: contract.id
    }
  }

  /**
   * پرداخت اجاره + تمدید قرارداد ۳۰ روز دیگر.
   *
   * جریان: مستأجر دکمهٔ «پرداخت اجاره» می‌زند → پول از کیفش به مالک می‌رود
   * (اتومیت، بدون خلق پول) → موعد قرارداد ۳۰ روز به جلو می‌رود → هر دو
   * طرف اعلان می‌گیرند. دوبارزدن با compare-and-swap روی `expiresAt`
   * در مخزن شکسته می‌شود: فقط یک پرداخت، یک تمدید.
   */
  async renewRental(telegramUserId: bigint): Promise<{
    propertyTitle: string
    monthlyRent: number
    daysLeft: number
  }> {
    const player = await this.requirePlayer(telegramUserId)

    const contract = await this.db.rentalContract.findFirst({
      where: { tenantId: player.id, isActive: true, expiresAt: { gt: new Date() } },
      select: {
        id: true,
        monthlyRent: true,
        expiresAt: true,
        property: {
          select: { id: true, title: true, ownerId: true }
        }
      }
    })
    if (!contract) {
      throw new ConflictError(
        'No active tenancy',
        'قرارداد اجارهٔ فعالی نداری. برای دیدن آگهی‌ها، پنل «اجاره» را باز کن.'
      )
    }

    const rent = Number(contract.monthlyRent)
    const newExpiresAt = new Date(Date.now() + gameDays(CONTRACT_DAYS))
    const result = await this.housingRepository.renewRental(
      contract.id,
      player.id,
      rent,
      contract.expiresAt,
      newExpiresAt
    )

    // اعلان مالک: دریافت اجاره (CRITICAL — پول به حسابت رسید)
    if (result.ownerId) {
      const tenant = await this.db.player
        .findUnique({ where: { id: player.id }, select: { firstName: true, lastName: true } })
        .catch(() => null)
      const tenantName = tenant ? `${tenant.firstName} ${tenant.lastName ?? ''}`.trim() : 'مستأجر'
      this.notify(
        result.ownerId,
        'دریافت اجاره',
        [
          `مستأجر: ${tenantName}`,
          `مبلغ: ${rent.toLocaleString('fa-IR')} تومان`,
          `ملک: ${contract.property.title}`,
          'مبلغ به موجودی تو اضافه شد و قرارداد یک ماه بازی دیگر تمدید شد.'
        ].join('\n'),
        RENT_LEVEL,
        `rent-payment-owner:${contract.id}:${newExpiresAt.getTime()}`
      )
      await this.eventService
        .recordPlayerEvent({
          playerId: result.ownerId,
          type: GameEventType.RENT_INCOME,
          title: `درآمد اجارهٔ ${contract.property.title}`,
          amount: rent,
          dedupeKey: `rent-payment-owner:${contract.id}:${newExpiresAt.getTime()}`
        })
        .catch(() => undefined)
    }

    // اعلان مستأجر: پرداخت ثبت شد (IMPORTANT)
    this.notify(
      player.id,
      'اجاره پرداخت شد',
      [
        `ملک: ${contract.property.title}`,
        `مبلغ: ${rent.toLocaleString('fa-IR')} تومان`,
        'قرارداد یک ماه بازی دیگر تمدید شد.'
      ].join('\n'),
      TENANT_LEVEL,
      `rent-payment-tenant:${contract.id}:${newExpiresAt.getTime()}`
    )

    return {
      propertyTitle: contract.property.title,
      monthlyRent: rent,
      daysLeft: daysUntil(newExpiresAt)
    }
  }

  /** فسخ قرارداد از سوی مستأجر؛ اجارهٔ پرداخت‌شده برنمی‌گردد. */
  async endTenancy(telegramUserId: bigint): Promise<{ propertyTitle: string }> {
    const player = await this.requirePlayer(telegramUserId)

    const contract = await this.db.rentalContract.findFirst({
      where: { tenantId: player.id, isActive: true },
      select: { id: true, property: { select: { title: true, ownerId: true } } }
    })
    if (!contract) {
      throw new ConflictError('No active tenancy', 'قرارداد اجارهٔ فعالی نداری. برای دیدن پیشنهادها در گروه «اجاره» را بفرست.')
    }

    // شرط isActive: فسخ همزمان دو بار اثر نمی‌گذارد
    const ended = await this.db.rentalContract.updateMany({
      where: { id: contract.id, isActive: true },
      data: { isActive: false }
    })
    if (ended.count !== 1) {
      throw new ConflictError('Concurrent change', 'وضعیت قرارداد همین حالا تغییر کرد.')
    }

    // اعلان مالک: ملک خالی شد و دوباره قابل استفاده است (INFORMATIONAL)
    if (contract.property.ownerId) {
      this.notify(
        contract.property.ownerId,
        'پایان قرارداد اجاره',
        [
          `ملک: ${contract.property.title}`,
          'مستأجر قرارداد را فسخ کرد؛ ملک خالی شد و حالا می‌توانی دوباره عرضه کنی یا خودت در آن استراحت کنی.'
        ].join('\n'),
        'INFORMATIONAL',
        `rental-ended-owner:${contract.id}`
      )
    }

    return { propertyTitle: contract.property.title }
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

export const RENTAL_INFO = {
  contractDays: CONTRACT_DAYS,
  priceMinRatio: PRICE_MIN_RATIO,
  priceMaxRatio: PRICE_MAX_RATIO
} as const
