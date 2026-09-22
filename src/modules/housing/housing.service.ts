import { HousingRepository } from '../../database/repositories/housing.repository'
import { PlayerRepository } from '../../database/repositories/player.repository'
import { PROPERTY_BLUEPRINTS, PropertyBlueprint } from './housing-blueprints'
import { ConflictError, NotFoundError, ValidationError } from '../../utils/classes/errors'
import { insufficientFunds } from '../../utils/format'
import { GAME_MINUTES_PER_HOUR, cycleRate, gameDays, gameMinutesSince, ratePerGameMinute } from '../../utils/game-time'
import { PlayerActivityState, PrismaClient, TransactionType } from '@prisma/client'
import { PlayerStateMachine } from '../identity/player-state-machine'
import { ProjectsService } from '../city/projects.service'
import { BASE_MAX_HEALTH, resolveMaxHealth } from '../health/max-health'
import { STARTER_SHELTER_TITLE, resolveShelter } from './starter-shelter'

/** هزینهٔ مبله‌کردن ملک. */
export const FURNISH_COST = 5_000_000
/** ضریب ریکاوری اضافه در ملک مبله. */
const FURNISHED_REST_BONUS = 1.15
/** دورهٔ نگهداری: هر ۳۰ روز یک بار. */
/** دورهٔ نگهداری ملک: ۳۰ روز بازی (≈ ۲۴ ساعت واقعی). */
const MAINTENANCE_PERIOD_DAYS = 30
/** شارژ نگهداری: ۰٫۵٪ ارزش ملک در هر دوره. */
/** نرخ نگهداری در هر دورهٔ *بازی* — هم‌تراز با همان ۰٫۵٪ در ماه واقعیِ قبلی. */
const MAINTENANCE_RATE = cycleRate(0.005)
/**
 * ریکاوری استراحت در خانه — پایهٔ الونک، به‌ازای هر **دقیقهٔ واقعی**.
 *
 * چرا «دقیقهٔ واقعی» و نه بازی؟ چون این نرخ ریتمِ نفس‌کشیدنِ بازیکن است (او
 * واقعی می‌نشیند و استراحت می‌کند) و در واحد بازی روی ساعتِ ۳۰ برابر تندتر
 * می‌نشست و رابطه‌اش با خستگیِ کار (که آن هم بر پایهٔ دقیقهٔ واقعی است)
 * بی‌معنا می‌شد. `stopRestAtHome` و پیش‌نمایش پنل هر دو از همین دو عدد
 * می‌خوانند تا پنل چیزی را وعده ندهد که سرویس عمل نمی‌کند.
 */
export const REST_FATIGUE_PER_REAL_MINUTE = 1.5
export const REST_HEALTH_PER_REAL_MINUTE = 0.2

/**
 * نرخ بازگشتِ فروشِ ملک به شهر: ۶۰٪ ارزشِ پایهٔ دارایی.
 *
 * عمداً کمتر از قیمتِ خرید تا چرخهٔ «خرید → فروش» ماشینِ پول‌سازی نشود
 * (در هر چرخه پول خالص از گردش خارج می‌شود) و با منطقِ واقعیِ بازارِ ملک
 * همخوانی داشته باشد: دارایی با احتیاط فروخته می‌شود، نه با سودِ بی‌دلیل.
 */
export const PROPERTY_SALE_RECOVERY_RATE = 0.6

export interface RestStatus {
  isResting: boolean
  elapsedMinutes: number
  fatigueRecovered: number
  healthRecovered: number
  propertyTitle: string
  /** بافر فعال از پروژه‌های شهری، برای نمایش در پنل استراحت. */
  regionBonusApplied: boolean
}

export class HousingService {
  constructor(
    private readonly housingRepository: HousingRepository,
    private readonly playerRepository: PlayerRepository,
    private readonly projectsService?: ProjectsService,
    private readonly db?: PrismaClient
  ) {}

  getBlueprints(): readonly PropertyBlueprint[] {
    return PROPERTY_BLUEPRINTS
  }

  /**
   * آیا ملک در حال حاضر مستأجرِ فعال دارد؟
   *
   * «اجاره داده» یعنی قراردادِ *زنده*: `isActive` و هنوز سررسید نشده.
   * قراردادِ منقضی (که هنوز Lazy بسته نشده) خانه را اشغال نمی‌کند؛
   * ملک خالی است و مالک می‌تواند در آن استراحت کند.
   */
  private isRentedOut(property: { rentalContracts?: Array<{ isActive: boolean; expiresAt: Date }> }): boolean {
    const now = Date.now()
    return Boolean(
      (property.rentalContracts ?? []).some((c) => c.isActive && c.expiresAt.getTime() > now)
    )
  }

  /** املاکِ بازیکن *برای استراحتِ خودِ او* قابل استفاده: اجاره‌داده‌شده‌ها را ندارند. */
  private liveOwned<T extends { id: string; rentalContracts?: Array<{ isActive: boolean; expiresAt: Date }> }>(
    owned: T[]
  ): T[] {
    return owned.filter((p) => !this.isRentedOut(p))
  }

  async listPlayerRealEstate(telegramUserId: bigint) {
    const player = await this.playerRepository.findByTelegramUserId(telegramUserId)
    if (!player) {
      throw new NotFoundError('Player not found')
    }

    const [owned, activeRental] = await Promise.all([
      this.housingRepository.listPlayerProperties(player.id),
      this.housingRepository.findActiveRental(player.id)
    ])

    return {
      owned,
      activeRental
    }
  }

  async buyPropertyByBlueprint(telegramUserId: bigint, typeKey: string) {
    const player = await this.playerRepository.findByTelegramUserId(telegramUserId)
    if (!player) {
      throw new NotFoundError('Player not found')
    }

    if (player.status === 'DEAD') {
      throw new ConflictError('Player is dead', 'شخصیت فوت‌شده امکان خرید ملک ندارد.')
    }

    const blueprint = PROPERTY_BLUEPRINTS.find((b) => b.type === typeKey)
    if (!blueprint) {
      throw new NotFoundError('Property blueprint not found', 'نوع ملک انتخابی یافت نشد.')
    }

    if (Number(player.balance) < blueprint.purchasePrice) {
      throw new ValidationError(
        'Insufficient balance for property',
        insufficientFunds(
          blueprint.purchasePrice,
          Number(player.balance),
          `خرید ملک ${blueprint.title}`,
          'ملک ارزان‌تر را ببین، یا اول درآمد بساز و بعد برگرد.'
        )
      )
    }

    // Direct purchase & deed creation
    const property = await this.housingRepository.acquirePropertyDirect(
      {
        type: blueprint.type,
        title: blueprint.title,
        level: blueprint.level,
        purchasePrice: blueprint.purchasePrice,
        rentalPriceMonthly: blueprint.rentalPriceMonthly,
        baseAssetValue: blueprint.baseAssetValue,
        fatigueRecoveryRate: blueprint.fatigueRecoveryMultiplier
      },
      player.id
    )

    // موجودی پس از خرید برای پنل نتیجه (بازیکن بدون بازکردن پنل بانک بفهمد).
    return { property, balanceAfter: Number(player.balance) - blueprint.purchasePrice }
  }

  async startRestAtHome(telegramUserId: bigint) {
    const player = await this.playerRepository.findByTelegramUserId(telegramUserId)
    if (!player) {
      throw new NotFoundError('Player not found')
    }

    PlayerStateMachine.assertCanStartActivity(
      player.status,
      player.activityState,
      PlayerActivityState.RESTING
    )

    const [owned, rental] = await Promise.all([
      this.housingRepository.listPlayerProperties(player.id),
      this.housingRepository.findActiveRental(player.id)
    ])

    // یک ملکِ اجاره‌داده‌شده، خانهٔ مستأجر است نه مالک: تا قرارداد فعال است
    // مالک نمی‌تواند هم «کامل واگذار کرده» باشد و هم خودش در آن بخوابد.
    const usableOwned = this.liveOwned(owned)

    // بی‌خانگی دیگر بن‌بست نیست: آلونک سرپناهِ ابتداییِ هر شخصیت است و کارش
    // دقیقاً همین است که «رایگان ولی کند» را ممکن کند. ملکِ کاملاً
    // اجاره‌داده‌شده هم همان حکم را دارد — مالک در آن زندگی نمی‌کند.
    const shelter = resolveShelter(usableOwned.length > 0 || Boolean(rental))
    if (!shelter.isShelter && usableOwned.length === 0 && !rental) {
      // شاخهٔ غیرقابل‌دسترس، فقط برای اطمینان از اینورینت.
      throw new ConflictError('No shelter available', 'امکان استراحت وجود ندارد.')
    }

    await this.housingRepository.startResting(player.id)
  }

  /**
   * پایان استراحت و اعمال ریکاوری.
   *
   * ضریب ریکاوری از دو منبع می‌آید: سطح ملک، و پروژه‌های تکمیل‌شدهٔ منطقهٔ اقامت
   * (پارک روی خستگی، درمانگاه روی سلامت). نبود سرویس پروژه‌ها اثر بی‌طرف دارد
   * تا این متد در تست‌ها و مسیرهای سبک هم قابل استفاده بماند.
   */
  async stopRestAtHome(telegramUserId: bigint): Promise<RestStatus> {
    const player = await this.playerRepository.findByTelegramUserId(telegramUserId)
    if (!player || player.activityState !== PlayerActivityState.RESTING || !player.restStartedAt) {
      throw new ConflictError('Not resting', 'الان در حال استراحت نیستی.')
    }

    // استراحت روی ساعت بازی شمرده می‌شود و نرخ‌های ریکاوری هم به دقیقهٔ بازی
    // ترجمه شده‌اند؛ پس مقدار ریکاوری به‌ازای هر دقیقهٔ واقعی ثابت می‌ماند.
    const elapsedMinutes = gameMinutesSince(player.restStartedAt)
    const [owned, rental, buffs] = await Promise.all([
      this.housingRepository.listPlayerProperties(player.id),
      this.housingRepository.findActiveRental(player.id),
      this.projectsService
        ?.getRegionBuffs(player.homeGroupId)
        .catch(() => null) ?? Promise.resolve(null)
    ])

    // استراحت در ملکِ *سکونتِ خودِ بازیکن* است: املاکی که مستأجر دیگری
    // در آن‌ها زندگی می‌کند، سطح/امکانشان مالِ بازیکن نیست.
    const usable = this.liveOwned(owned)
    // آلونک: بدون خانهٔ قابل‌استفاده، سرپناهِ ابتدایی جای ملک را می‌گیرد
    // (نصف خستگی و یک‌چهارم سلامتِ یک خانهٔ سطح ۱).
    const shelter = resolveShelter(usable.length > 0 || Boolean(rental))
    const bestLevel = Math.max(...usable.map((p) => p.level), rental?.property.level ?? 1)
    const multiplier = shelter.isShelter
      ? shelter.multiplier
      : 1 + (bestLevel - 1) * 0.5
    // ملک مبله ریکاوری بهتری می‌دهد (فقط املاکی که واقعاً در آن استراحت می‌کند)
    const furnishedBonus = usable.some((p) => p.isFurnished) ? FURNISHED_REST_BONUS : 1

    // آلونک هیچ‌وقت از بافرهای منطقه بهره نمی‌برد: بافرها برای پروژه‌های
    // شهر ساخته شده‌اند و بردنشان به یک سرپناهِ رایگان، پروژه را بی‌معنا می‌کرد.
    const fatigueMultiplier = shelter.isShelter
      ? shelter.multiplier
      : multiplier * furnishedBonus * (buffs?.restFatigueMultiplier ?? 1)
    const healthMultiplier = shelter.isShelter
      ? shelter.multiplier
      : multiplier * furnishedBonus * (buffs?.restHealthMultiplier ?? 1)

    const fatigueRecovered = Math.min(
      player.fatigue,
      Math.round(ratePerGameMinute(REST_FATIGUE_PER_REAL_MINUTE) * elapsedMinutes * fatigueMultiplier)
    )
    // سقف واقعی سلامت (عضو باشگاه = ۱۲۰)؛ سقفِ هاردکدِ ۱۰۰ برای عضو باشگاه
    // با سلامت بالای ۱۰۰، «ریکاوری منفی» می‌ساخت و استراحت سلامتش را *کم*
    // می‌کرد. نبودِ اتصال دیتابیس (تست‌های سبک) سقف پایه را می‌دهد.
    const maxHealth = this.db ? await resolveMaxHealth(this.db, player.id) : BASE_MAX_HEALTH
    const healthRecovered = Math.min(
      Math.max(0, maxHealth - player.health),
      Math.round(ratePerGameMinute(REST_HEALTH_PER_REAL_MINUTE) * elapsedMinutes * healthMultiplier)
    )

    await this.housingRepository.stopResting(player.id, fatigueRecovered, healthRecovered)

    return {
      isResting: false,
      elapsedMinutes,
      fatigueRecovered,
      healthRecovered,
      propertyTitle: shelter.isShelter
        ? STARTER_SHELTER_TITLE
        : (owned[0]?.title ?? rental?.property.title ?? 'اقامتگاه مسکونی'),
      regionBonusApplied: !shelter.isShelter && (fatigueMultiplier > multiplier || healthMultiplier > multiplier)
    }
  }

  /** پیش‌نمایش ریکاوری ساعتی برای پنل مسکن — همان ضرایبِ واقعی استراحت، اما بدونِ نیاز به «شروع استراحت». */
  async getRecoveryPreview(
    telegramUserId: bigint
  ): Promise<{
    bestLevel: number
    isFurnished: boolean
    hasProperty: boolean
    hasRental: boolean
    multiplier: number
    fatiguePerHour: number
    healthPerHour: number
    regionBonusApplied: boolean
    /** آیا ریکاوریِ پیش‌نمایش از آلونک می‌آید؟ */
    isShelter: boolean
    /** جملهٔ انسانىِ وضعیتِ پناهگاه برای پنل. */
    shelterHint: string
  }> {
    const player = await this.playerRepository.findByTelegramUserId(telegramUserId)
    if (!player) {
      throw new NotFoundError('Player not found')
    }
    const [owned, rental, buffs] = await Promise.all([
      this.housingRepository.listPlayerProperties(player.id),
      this.housingRepository.findActiveRental(player.id),
      this.projectsService?.getRegionBuffs(player.homeGroupId).catch(() => null) ?? Promise.resolve(null)
    ])
    // پیش‌نمایش هم همان منطق استراحتِ واقعی را نشان می‌دهد: ملکِ
    // اجاره‌داده‌شده برای استراحتِ خودِ مالک حساب نمی‌شود.
    const usable = this.liveOwned(owned)
    const hasProperty = usable.length > 0
    const hasRental = Boolean(rental)
    const shelter = resolveShelter(hasProperty || hasRental)
    if (shelter.isShelter) {
      // آلونک همیشه باز است، پس پیش‌نمایش دیگر صفر نیست؛ نرخ‌های واقعیِ
      // همان آلونک نشان داده می‌شود تا بازیکنِ تازه‌وارد بفهمد راهی دارد.
      return {
        bestLevel: 0,
        isFurnished: false,
        hasProperty: false,
        hasRental: false,
        multiplier: shelter.multiplier,
        fatiguePerHour: Math.round(GAME_MINUTES_PER_HOUR * REST_FATIGUE_PER_REAL_MINUTE * shelter.multiplier),
        healthPerHour: Math.round(GAME_MINUTES_PER_HOUR * REST_HEALTH_PER_REAL_MINUTE * shelter.multiplier),
        regionBonusApplied: false,
        isShelter: true,
        shelterHint: shelter.hint
      }
    }
    const bestLevel = Math.max(...usable.map((p) => p.level), rental?.property.level ?? 1)
    const isFurnished = usable.some((p) => p.isFurnished)
    const baseMultiplier = 1 + (bestLevel - 1) * 0.5
    const furnishedBonus = isFurnished ? FURNISHED_REST_BONUS : 1
    const fatigueMultiplier = baseMultiplier * furnishedBonus * (buffs?.restFatigueMultiplier ?? 1)
    const healthMultiplier = baseMultiplier * furnishedBonus * (buffs?.restHealthMultiplier ?? 1)
    // همان نرخ‌های stopRestAtHome — هر ۶۰ دقیقهٔ **واقعی** استراحت.
    const fatiguePerHour = Math.round(GAME_MINUTES_PER_HOUR * REST_FATIGUE_PER_REAL_MINUTE * fatigueMultiplier)
    const healthPerHour = Math.round(GAME_MINUTES_PER_HOUR * REST_HEALTH_PER_REAL_MINUTE * healthMultiplier)
    const regionBonusApplied = (buffs?.restFatigueMultiplier ?? 1) > 1 || (buffs?.restHealthMultiplier ?? 1) > 1
    return {
      bestLevel,
      isFurnished,
      hasProperty,
      hasRental,
      multiplier: fatigueMultiplier,
      fatiguePerHour,
      healthPerHour,
      regionBonusApplied,
      isShelter: false,
      shelterHint: ''
    }
  }

  /** مبله‌کردن ملک: هزینهٔ یک‌باره، ریکاوری ۱۵٪ بهتر برای همیشه. */
  async furnishProperty(
    telegramUserId: bigint,
    propertyId: string
  ): Promise<{ title: string; cost: number }> {
    const player = await this.playerRepository.findByTelegramUserId(telegramUserId)
    if (!player) {
      throw new NotFoundError('Player not found')
    }

    const property = await this.db?.property.findUnique({
      where: { id: propertyId },
      select: { id: true, ownerId: true, title: true, isFurnished: true }
    })
    if (!property || property.ownerId !== player.id) {
      throw new NotFoundError('Property not found', 'این ملک متعلق به تو نیست. از «خانه» املاک خودت را ببین.')
    }
    if (property.isFurnished) {
      throw new ConflictError('Already furnished', 'این ملک از قبل مبله است.')
    }

    await this.db?.$transaction(async (tx) => {
      const debited = await tx.player.updateMany({
        where: { id: player.id, balance: { gte: FURNISH_COST } },
        data: { balance: { decrement: FURNISH_COST } }
      })
      if (debited.count !== 1) {
        throw new ConflictError(
          'Insufficient balance',
          `مبله‌کردن ${FURNISH_COST.toLocaleString('fa-IR')} تومان هزینه دارد.`
        )
      }

      // شرط وضعیت: مبله‌شدن دوباره ناممکن است
      const updated = await tx.property.updateMany({
        where: { id: property.id, isFurnished: false },
        data: { isFurnished: true }
      })
      if (updated.count !== 1) {
        throw new ConflictError('Concurrent furnish', 'ملک همین حالا مبله شد.')
      }

      await tx.financialTransaction.create({
        data: {
          amount: FURNISH_COST,
          type: TransactionType.PROPERTY_MAINTENANCE,
          sourcePlayerId: player.id,
          reference: `مبله‌سازی ${property.title}`
        }
      })
    })

    return { title: property.title, cost: FURNISH_COST }
  }

  /**
   * فروش ملک به شهر — خروج از دارایی با شرایط منطقی.
   *
   * Flow (در handler): انتخاب ← صفحهٔ تأیید (قیمت دقیق) ← تأیید ← اجرا.
   * در لحظهٔ اجرا همهٔ شرایط دوباره بررسی می‌شوند (مالکیت، قراردادِ فعال،
   * وثیقهٔ وام) و عملیات در یک تراکنش اتمیک انجام می‌شود؛ قیمت در لحظهٔ
   * اجرا از ارزش پایهٔ دارایی محاسبه می‌شود، نه از همان چیزی که صفحهٔ
   * تأیید نشان داده بود.
   *
   * قیمت: ۶۰٪ ارزش پایهٔ دارایی — کمتر از قیمت خرید تا چرخهٔ خرید→فروش
   * ماشینِ پول‌سازی نشود.
   */
  async sellProperty(
    telegramUserId: bigint,
    propertyId: string
  ): Promise<{ title: string; salePrice: number }> {
    const player = await this.playerRepository.findByTelegramUserId(telegramUserId)
    if (!player) {
      throw new NotFoundError('Player not found')
    }

    const property = await this.db?.property.findUnique({
      where: { id: propertyId },
      select: { id: true, ownerId: true, title: true, baseAssetValue: true }
    })
    if (!property || property.ownerId !== player.id) {
      throw new NotFoundError('Property not found', 'این ملک در فهرست املاکت نیست. پنل «خانه» را تازه کن.')
    }

    // قیمت از همان لحظهٔ اجرا — منبع واحدِ قیمت‌گذاری فروش
    const salePrice = Math.round(Number(property.baseAssetValue) * PROPERTY_SALE_RECOVERY_RATE)

    const result = await this.housingRepository.sellProperty(propertyId, player.id, salePrice)

    return { title: result.title, salePrice }
  }

  /** قیمت فروشِ یک ملک — فقط برای نمایش در پنل/صفحهٔ تأیید (بدون نوشتار). */
  async getSalePrice(telegramUserId: bigint, propertyId: string): Promise<number> {
    const player = await this.playerRepository.findByTelegramUserId(telegramUserId)
    if (!player) {
      throw new NotFoundError('Player not found')
    }
    const property = await this.db?.property.findUnique({
      where: { id: propertyId },
      select: { id: true, ownerId: true, baseAssetValue: true }
    })
    if (!property || property.ownerId !== player.id) {
      throw new NotFoundError('Property not found', 'این ملک در فهرست املاکت نیست.')
    }
    return Math.round(Number(property.baseAssetValue) * PROPERTY_SALE_RECOVERY_RATE)
  }

  /**
   * شارژ نگهداری معوقه (Lazy).
   *
   * هر ۳۰ روز، ۰٫۵٪ ارزش هر ملک به‌عنوان شارژ کسر می‌شود. اگر موجودی کافی
   * نباشد، آن ملک نادیده گرفته می‌شود و در نتیجه گزارش می‌آید تا بازیکن بداند.
   * این Sink پایدار، دارایی مسکن را «مجانی» نگه نمی‌دارد.
   */
  async chargeOverdueMaintenance(
    telegramUserId: bigint
  ): Promise<{ chargedTotal: number; chargedCount: number; skippedTitles: string[] }> {
    const player = await this.playerRepository.findByTelegramUserId(telegramUserId)
    if (!player || !this.db) {
      return { chargedTotal: 0, chargedCount: 0, skippedTitles: [] }
    }

    const cutoff = new Date(Date.now() - gameDays(MAINTENANCE_PERIOD_DAYS))
    const overdue = await this.db.property.findMany({
      where: {
        ownerId: player.id,
        OR: [{ lastMaintenanceAt: null }, { lastMaintenanceAt: { lt: cutoff } }]
      },
      take: 10,
      select: { id: true, title: true, purchasePrice: true }
    })

    let chargedTotal = 0
    const skippedTitles: string[] = []

    for (const property of overdue) {
      const fee = Math.max(
        50_000,
        Math.round(Number(property.purchasePrice) * MAINTENANCE_RATE)
      )

      try {
        await this.db.$transaction(async (tx) => {
          const debited = await tx.player.updateMany({
            where: { id: player.id, balance: { gte: fee } },
            data: { balance: { decrement: fee } }
          })
          if (debited.count !== 1) {
            throw new ValidationError('Skip', 'insufficient')
          }

          const updated = await tx.property.updateMany({
            where: {
              id: property.id,
              OR: [
                { lastMaintenanceAt: null },
                { lastMaintenanceAt: { lt: cutoff } }
              ]
            },
            data: { lastMaintenanceAt: new Date() }
          })
          if (updated.count !== 1) {
            throw new ValidationError('Race', 'already charged')
          }

          await tx.financialTransaction.create({
            data: {
              amount: fee,
              type: TransactionType.PROPERTY_MAINTENANCE,
              sourcePlayerId: player.id,
              reference: `شارژ نگهداری ${property.title}`
            }
          })

          chargedTotal += fee
        })
      } catch {
        skippedTitles.push(property.title)
      }
    }

    return {
      chargedTotal,
      chargedCount: overdue.length - skippedTitles.length,
      skippedTitles
    }
  }
}