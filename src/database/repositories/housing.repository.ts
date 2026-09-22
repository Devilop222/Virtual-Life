import {
  Prisma,
  PrismaClient,
  LoanStatus,
  Property,
  PropertyStatus,
  PropertyType,
  RentalContract,
  TransactionType,
  PlayerActivityState
} from '@prisma/client'
import { ConflictError, NotFoundError, ValidationError } from '../../utils/classes/errors'
import { resolveMaxHealth } from '../../modules/health/max-health'
import { PlayerStateMachine } from '../../modules/identity/player-state-machine'
import { gameDays } from '../../utils/game-time'

export interface CreatePropertyInput {
  type: PropertyType
  title: string
  level: number
  purchasePrice: number
  rentalPriceMonthly: number
  baseAssetValue: number
  fatigueRecoveryRate: number
  ownerId?: string
  groupId?: string
}

/** قراردادِ مرتبط با ملک (فقط فیلدهایی که پنل‌ها و منطق سکونت لازم دارند). */
export interface PlayerPropertyRental {
  id: string
  isActive: boolean
  expiresAt: Date
  tenant: { firstName: string; lastName: string | null }
}

/** ملکِ یک بازیکن به همراه قراردادها؛ نوعِ بازگشتِ `listPlayerProperties`. */
export interface PlayerProperty {
  id: string
  title: string
  level: number
  isFurnished: boolean
  isListedForRent: boolean
  baseAssetValue: Property['baseAssetValue']
  rentalContracts: PlayerPropertyRental[]
}

export class HousingRepository {
  constructor(private readonly db: PrismaClient) {}

  async listAvailableForPurchase(): Promise<Property[]> {
    return this.db.property.findMany({
      where: { status: PropertyStatus.AVAILABLE },
      orderBy: { purchasePrice: 'asc' }
    })
  }

  async listPlayerProperties(ownerId: string): Promise<PlayerProperty[]> {
    return this.db.property.findMany({
      where: { ownerId },
      select: {
        id: true,
        title: true,
        level: true,
        isFurnished: true,
        isListedForRent: true,
        baseAssetValue: true,
        rentalContracts: {
          where: { isActive: true },
          select: { id: true, isActive: true, expiresAt: true, tenant: { select: { firstName: true, lastName: true } } }
        }
      }
    })
  }

  async findActiveRental(tenantId: string): Promise<(RentalContract & { property: Property }) | null> {
    return this.db.rentalContract.findFirst({
      where: { tenantId, isActive: true, expiresAt: { gt: new Date() } },
      include: { property: true }
    })
  }

  async findById(id: string): Promise<Property | null> {
    return this.db.property.findUnique({ where: { id }, include: { owner: true } })
  }

  async buyProperty(propertyId: string, buyerId: string): Promise<Property> {
    return this.db.$transaction(async (tx) => {
      let property = await tx.property.findUnique({ where: { id: propertyId } })
      
      // If property does not exist by ID, check if propertyId is a blueprint type
      if (!property) {
        property = await tx.property.findFirst({
          where: { type: propertyId as PropertyType, status: PropertyStatus.AVAILABLE }
        })
      }

      if (!property || property.status !== PropertyStatus.AVAILABLE) {
        throw new Error('Property is not available for purchase')
      }

      // ادعای انحصاری ملک پیش از کسر پول: دو خریدار همزمان نمی‌توانند یک ملک را
      // بخرند (وگرنه هر دو پول می‌دادند اما سند فقط به نام یکی می‌خورد).
      const claimed = await tx.property.updateMany({
        where: { id: property.id, status: PropertyStatus.AVAILABLE },
        data: { ownerId: buyerId, status: PropertyStatus.OWNED }
      })
      if (claimed.count !== 1) {
        throw new ConflictError(
          'Property just sold',
          'این ملک همین حالا به خریدار دیگری فروخته شد.'
        )
      }

      const price = Number(property.purchasePrice)
      const debited = await tx.player.updateMany({
        where: { id: buyerId, balance: { gte: price } },
        data: { balance: { decrement: price } }
      })
      if (debited.count !== 1) {
        throw new ValidationError(
          'Insufficient funds to buy property',
          'موجودیت برای خرید این ملک کافی نیست.'
        )
      }

      const updatedProperty = await tx.property.findUniqueOrThrow({
        where: { id: property.id }
      })

      await tx.financialTransaction.create({
        data: {
          amount: property.purchasePrice,
          type: TransactionType.PROPERTY_PURCHASE,
          sourcePlayerId: buyerId,
          reference: `خرید ملک: ${property.title}`
        }
      })

      return updatedProperty
    })
  }

  async acquirePropertyDirect(
    blueprintInput: CreatePropertyInput,
    buyerId: string
  ): Promise<Property> {
    return this.db.$transaction(async (tx) => {
      // کسر شرطی موجودی: محافظت از Double-Spend در خرید همزمان
      const debited = await tx.player.updateMany({
        where: { id: buyerId, balance: { gte: blueprintInput.purchasePrice } },
        data: { balance: { decrement: blueprintInput.purchasePrice } }
      })
      if (debited.count !== 1) {
        throw new ValidationError(
          'Insufficient funds to buy property',
          'موجودیت برای خرید این ملک کافی نیست.'
        )
      }

      const createdProperty = await tx.property.create({
        data: {
          type: blueprintInput.type,
          title: blueprintInput.title,
          level: blueprintInput.level,
          purchasePrice: blueprintInput.purchasePrice,
          rentalPriceMonthly: blueprintInput.rentalPriceMonthly,
          baseAssetValue: blueprintInput.baseAssetValue,
          fatigueRecoveryRate: blueprintInput.fatigueRecoveryRate,
          ownerId: buyerId,
          status: PropertyStatus.OWNED
        }
      })

      await tx.financialTransaction.create({
        data: {
          amount: blueprintInput.purchasePrice,
          type: TransactionType.PROPERTY_PURCHASE,
          sourcePlayerId: buyerId,
          reference: `خرید ملک: ${blueprintInput.title}`
        }
      })

      return createdProperty
    })
  }

  /**
   * فروش ملک به شهر (خروج از دارایی).
   *
   * چرا `ownerId: null` و نه حذف ردیف؟ قراردادها و وثیقه‌های تاریخی به
   * همین ردیف ارجاع دارند؛ ردیفِ بی‌صاحب در هیچ فهرستِ بازیکنی دیده
   * نمی‌شود (همهٔ Queryها یا `ownerId = بازیکن` دارند یا
   * `ownerId != null`)، اما سوابق مالی/اجاره‌ای سالم می‌مانند.
   *
   * Guards (همه داخل تراکنش، با شرطِ نوشتار):
   *  • ملک باید متعلق به فروشنده باشد (CAS: دو کلیک همزمان = یک فروش)
   *  • قرارداد اجارهٔ فعال (با مستأجر واقعی) نباید داشته باشد
   *  • وثیقهٔ وامِ باز نباید داشته باشد
   *
   * قیمت از قبل (در سرویس) از ارزش پایهٔ دارایی محاسبه شده؛ پول به کیف
   * فروشنده واریز و یک ردیف `PROPERTY_SALE` فقط با مقصد (مبدأ، ترازنامهٔ
   * عمومی شهر است) ثبت می‌شود.
   */
  async sellProperty(propertyId: string, sellerId: string, salePrice: number): Promise<{ title: string }> {
    return this.db.$transaction(async (tx) => {
      const property = await tx.property.findUnique({ where: { id: propertyId } })
      if (!property || property.ownerId !== sellerId) {
        throw new NotFoundError('Property not found', 'این ملک در فهرست املاکت نیست. پنل «خانه» را تازه کن.')
      }

      const activeContract = await tx.rentalContract.findFirst({
        where: { propertyId, isActive: true, expiresAt: { gt: new Date() } }
      })
      if (activeContract) {
        throw new ConflictError(
          'Property is rented',
          'این ملک قرارداد اجارهٔ فعال دارد؛ تا پایان قرارداد نمی‌توانی آن را بفروشی.'
        )
      }

      const activeLoan = await tx.loan.findFirst({
        where: { collateralPropertyId: propertyId, status: LoanStatus.ACTIVE }
      })
      if (activeLoan) {
        throw new ConflictError(
          'Property is collateral',
          'این ملک وثیقهٔ یک وام باز است؛ اول تسویهٔ وام را انجام بده.'
        )
      }

      // ادعای انحصاری فروش: فقط یک درخواست می‌تواند ملک را رها کند.
      const sold = await tx.property.updateMany({
        where: { id: property.id, ownerId: sellerId },
        data: { ownerId: null, status: PropertyStatus.AVAILABLE, isListedForRent: false }
      })
      if (sold.count !== 1) {
        throw new ConflictError('Property already sold', 'این ملک همین حالا فروخته شد یا مالکش عوض شد.')
      }

      await tx.player.update({
        where: { id: sellerId },
        data: { balance: { increment: salePrice } }
      })

      await tx.financialTransaction.create({
        data: {
          amount: salePrice,
          type: TransactionType.PROPERTY_SALE,
          destinationPlayerId: sellerId,
          reference: `فروش ${property.title} به شهر`
        }
      })

      return { title: property.title }
    })
  }

  /**
   * تمدید قرارداد اجاره با پرداخت اجارهٔ ماه بعد (Escrow اتمیک).
   *
   * ضدتکرار با compare-and-swap روی `expiresAt` همزمان: دو کلیکِ همزمانِ
   * «پرداخت اجاره» هر دو مقدارِ خوانده‌شدهٔ موعد را می‌بینند، ولی فقط یکی
   * می‌تواند آن را به‌روزرسانی کند (count === 1)؛ دومی صفر ردیف می‌بیند و
   * کل تراکنش — همراه با کسر پول — برمی‌گردد.
   *
   * پول از کیف مستأجر به مالک می‌رود (Zero-sum) و یک ردیف `PROPERTY_RENT`
   * با هر دو طرف ثبت می‌شود.
   */
  async renewRental(
    contractId: string,
    tenantId: string,
    rent: number,
    oldExpiresAt: Date,
    newExpiresAt: Date
  ): Promise<{ ownerId: string }> {
    return this.db.$transaction(async (tx) => {
      const contract = await tx.rentalContract.findUnique({
        where: { id: contractId },
        include: {
          property: {
            select: {
              id: true,
              title: true,
              owner: { select: { id: true } }
            }
          }
        }
      })
      if (!contract || contract.tenantId !== tenantId || !contract.isActive) {
        throw new ConflictError('Contract changed', 'وضعیت قرارداد عوض شده است. پنل «اجاره» را تازه کن.')
      }
      const owner = contract.property.owner
      if (!owner) {
        throw new NotFoundError('Owner not found', 'مالک این ملک در بازی یافت نشد.')
      }

      // ادعای اتمیکِ تمدید: فقط درخواستی که هنوز موعدِ کهنه را می‌بیند برنده است.
      const extended = await tx.rentalContract.updateMany({
        where: { id: contract.id, isActive: true, tenantId, expiresAt: oldExpiresAt },
        data: { expiresAt: newExpiresAt }
      })
      if (extended.count !== 1) {
        throw new ConflictError('Concurrent renewal', 'این پرداخت همین حالا ثبت شده است؛ دوبار پرداخت نشد.')
      }

      const debited = await tx.player.updateMany({
        where: { id: tenantId, balance: { gte: rent } },
        data: { balance: { decrement: rent } }
      })
      if (debited.count !== 1) {
        throw new ValidationError(
          'Insufficient funds for monthly rent',
          'موجودیت برای پرداخت اجاره کافی نیست. برای واریز به کیف پول، از «بانک» برداشت کن.'
        )
      }

      await tx.player.update({
        where: { id: owner.id },
        data: { balance: { increment: rent } }
      })

      await tx.financialTransaction.create({
        data: {
          amount: rent,
          type: TransactionType.PROPERTY_RENT,
          sourcePlayerId: tenantId,
          destinationPlayerId: owner.id,
          // شناسهٔ ملک در reference تا جمعِ «دریافتی هر قرارداد» قابل محاسبه باشد
          reference: `تمدید اجاره: ${contract.property.title} · ${contract.property.id}`
        }
      })

      return { ownerId: owner.id }
    })
  }

  /**
   * اجارهٔ ملک از مالک آن (Escrow اتمیک).
   *
   * Guards:
   *  • مستأجر نمی‌تواند مالک همان ملک باشد
   *  • ملک نباید قرارداد فعال داشته باشد
   *  • مستأجر نباید قرارداد فعال دیگری داشته باشد
   *
   * پول اجاره به مالک پرداخت و برای هر دو طرف تراکنش ثبت می‌شود
   * (رفع باگ سوختن پول اجاره).
   */
  async rentProperty(propertyId: string, tenantId: string, durationDays = 30): Promise<RentalContract> {
    return this.db.$transaction(async (tx) => {
      const property = await tx.property.findUnique({ where: { id: propertyId } })
      if (!property || property.status !== PropertyStatus.OWNED || !property.ownerId) {
        throw new NotFoundError('Property not available', 'این ملک قابل اجاره نیست.')
      }
      if (property.ownerId === tenantId) {
        throw new ValidationError(
          'Own property',
          'این ملک متعلق به خودت است!'
        )
      }

      const activeOnProperty = await tx.rentalContract.findFirst({
        where: { propertyId, isActive: true, expiresAt: { gt: new Date() } }
      })
      if (activeOnProperty) {
        throw new ConflictError(
          'Already rented',
          'این ملک همین حالا به کسی اجاره داده شده است.'
        )
      }

      const tenantsActive = await tx.rentalContract.findFirst({
        where: { tenantId, isActive: true, expiresAt: { gt: new Date() } }
      })
      if (tenantsActive) {
        throw new ConflictError(
          'Tenant has active rental',
          'یک قرارداد اجارهٔ فعال داری؛ اول آن را واگذار کن.'
        )
      }

      const owner = await tx.player.findUnique({
        where: { id: property.ownerId },
        select: { id: true }
      })
      if (!owner) {
        throw new NotFoundError('Owner not found', 'مالک این ملک در بازی یافت نشد.')
      }

      const rent = Number(property.rentalPriceMonthly)
      const debited = await tx.player.updateMany({
        where: { id: tenantId, balance: { gte: rent } },
        data: { balance: { decrement: rent } }
      })
      if (debited.count !== 1) {
        throw new ValidationError(
          'Insufficient funds for monthly rent',
          'موجودیت برای پرداخت اجاره کافی نیست.'
        )
      }

      // پرداخت واقعی به مالک (رفع باگ سوختن اجاره)
      await tx.player.update({
        where: { id: owner.id },
        data: { balance: { increment: rent } }
      })

      // انقضای Lazy: قراردادهای منقضیِ هنوز-فعالِ همین ملک و همین مستأجر
      // بسته می‌شوند تا قید یکتایی پایین (is_active) با انقضای تنبیه‌پذیر
      // سازگار بماند و ملکِ با قرارداد منقضی قفل نشود.
      await tx.rentalContract.updateMany({
        where: { isActive: true, expiresAt: { lte: new Date() }, OR: [{ propertyId }, { tenantId }] },
        data: { isActive: false }
      })

      // مدت قرارداد روی تقویم بازی است (۳۰ روز بازی = ۱ روز واقعی).
      const expiresAt = new Date(Date.now() + gameDays(durationDays))

      // قفل نهایی در دیتابیس: یونیک‌ایندکس partial روی «یک قرارداد فعال به
      // ازای هر ملک/مستأجر» دو درخواست همزمان را می‌شکند؛ چک‌های بالا فقط
      // پیام خطای دقیق می‌سازند.
      let contract: RentalContract
      try {
        contract = await tx.rentalContract.create({
          data: {
            propertyId,
            tenantId,
            monthlyRent: property.rentalPriceMonthly,
            expiresAt,
            isActive: true
          }
        })
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          const detail = JSON.stringify(error.meta ?? {})
          throw new ConflictError(
            'Rental already active',
            detail.includes('one_active_rental_per_tenant')
              ? 'یک قرارداد اجارهٔ فعال داری؛ اول آن را واگذار کن.'
              : 'این ملک همین حالا به کسی اجاره داده شده است.'
          )
        }
        throw error
      }

      await tx.financialTransaction.create({
        data: {
          amount: rent,
          type: TransactionType.PROPERTY_RENT,
          sourcePlayerId: tenantId,
          destinationPlayerId: owner.id,
          // شناسهٔ ملک در reference تا جمعِ «دریافتی هر قرارداد» قابل محاسبه باشد
          reference: `اجاره ملک: ${property.title} · ${property.id}`
        }
      })

      return contract
    })
  }

  async startResting(playerId: string): Promise<void> {
    await this.db.player.update({
      where: { id: playerId },
      data: {
        activityState: PlayerActivityState.RESTING,
        restStartedAt: new Date()
      }
    })
  }

  async stopResting(
    playerId: string,
    fatigueRecovered: number,
    healthRecovered: number
  ): Promise<boolean> {
    const player = await this.db.player.findUnique({ where: { id: playerId } })
    if (!player) {
      return false
    }
    const currentFatigue = player.fatigue ?? 0
    const currentHealth = player.health ?? 100
    const newFatigue = Math.max(0, currentFatigue - fatigueRecovered)
    // سقف واقعی سلامت (عضو باشگاه = ۱۲۰)؛ clamp قدیمیِ ۱۰۰ استراحت را برای
    // عضو باشگاه به «کاهش سلامت» تبدیل می‌کرد.
    const maxHealth = await resolveMaxHealth(this.db, playerId)
    const newHealth = Math.min(maxHealth, currentHealth + healthRecovered)

    // نوشتار شرطی روی «هنوز در حال استراحت بودن»: دو کلیکِ همزمانِ
    // «پایان استراحت» فقط یکی را قبول می‌کند؛ دومی صفر ردیف می‌زند و
    // ریکاوری را دوبار اعمال نمی‌کند (پیش‌تر updateِ بی‌شرط بود و با هر
    // دوبارزدن، خستگی/سلامت دوبار جبران می‌شد).
    const updated = await this.db.player.updateMany({
      where: {
        id: playerId,
        activityState: PlayerActivityState.RESTING,
        restStartedAt: { not: null }
      },
      data: {
        // استراحت، تحصیل را لغو نمی‌کند: بازیکنِ در حال تحصیل بعد از استراحت
        // دوباره «مشغول به تحصیل» می‌شود تا دوره‌اش از دید پنل‌ها نپرد.
        activityState: PlayerStateMachine.activityAfterRest(player.isEnrolled ?? false),
        restStartedAt: null,
        fatigue: newFatigue,
        health: newHealth
      }
    })

    return updated.count === 1
  }
}