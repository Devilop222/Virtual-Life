import { GameEventType, NotificationType, Prisma, PrismaClient, TransactionType } from '@prisma/client'
import { ConflictError, NotFoundError } from '../../utils/classes/errors'
import { insufficientFunds } from '../../utils/format'
import { EventService } from '../events/event.service'
import { cycleAmount, dayIndex, gameDaysSince, gameHoursSince, stableHash } from '../../utils/game-time'
import type { NotificationLevel } from '../notification/push'

export interface PetKind {
  key: string
  name: string
  emoji: string
  price: number
  bonusMin: number
  bonusMax: number
  /** یک جملهٔ کوتاه دربارهٔ شخصیتِ نژاد — برای فروشگاه و صفحهٔ بازبینی. */
  trait: string
}

/** نژادهای حیوان خانگی؛ گران‌تر = هدیهٔ روزانهٔ بهتر. */
export const PET_KINDS: readonly PetKind[] = [
  {
    key: 'cat',
    name: 'گربه',
    emoji: '🐱',
    price: 800_000,
    bonusMin: cycleAmount(80_000),
    bonusMax: cycleAmount(160_000),
    trait: 'مستقل و کم‌توقع؛ خانه را دوست دارد'
  },
  {
    key: 'dog',
    name: 'سگ',
    emoji: '🐕',
    price: 1_000_000,
    bonusMin: cycleAmount(100_000),
    bonusMax: cycleAmount(200_000),
    trait: 'وفادار و پرانرژی؛ بهترین همدمِ روزهای سخت'
  },
  {
    key: 'bird',
    name: 'طوطی',
    emoji: '🦜',
    price: 600_000,
    bonusMin: cycleAmount(60_000),
    bonusMax: cycleAmount(125_000),
    trait: 'پرحرف و بامزه؛ حالِ خانه را عوض می‌کند'
  },
  {
    key: 'rabbit',
    name: 'خرگوش',
    emoji: '🐰',
    price: 500_000,
    bonusMin: cycleAmount(50_000),
    bonusMax: cycleAmount(105_000),
    trait: 'آرام و ارزان؛ شروعِ خوبِ سرپرستی'
  }
]

/**
 * هزینهٔ هر وعدهٔ غذا برای «هر روز بازی».
 *
 * عمداً *کمتر* از `bonusMin` هر نژاد است: وعدهٔ پنل «روزی یک درآمد کوچک»
 * است و باید در بدترین حالت هم راست باشد — حتی روزی که حیوان کمترین هدیه را
 * می‌دهد، خرجِ غذا نباید از هدیه بیشتر شود. وگرنه «درآمد» عملاً زیان است.
 */
const FEED_COST = cycleAmount(10_000)

/**
 * گامِ تنوعِ هدیه در واحدِ اقتصادِ فعلی.
 *
 * پیش‌تر این عدد ۵٬۰۰۰ خام بود، در حالی که بازهٔ هدیه با `cycleAmount`
 * سی‌برابر کوچک شده بود؛ نتیجه این بود که بازهٔ هر نژاد کمتر از یک گام
 * می‌شد، `stepCount` همیشه ۱ می‌ماند (تنوعِ روزانه بی‌اثر) و گرد‌کردنِ نهایی
 * هر مبلغی زیر ۲٬۵۰۰ را به **صفر** می‌رساند. یعنی هدیهٔ روزانه در تمامِ نژادها
 * و تمامِ سطوحِ پیوند صفر تومان بود. گام هم باید به همان زبانِ اقتصاد باشد.
 */
const BONUS_STEP = cycleAmount(5_000)

/** کمینهٔ مطلقِ هدیه؛ تضمین می‌کند گرد‌کردن هرگز هدیه را صفر نکند. */
const MIN_BONUS = 10
/** گرسنگی روزانه ۱۰ واحد رشد می‌کند (Lazy). */
const HUNGER_PER_DAY = 10
/**
 * اگر بیش از این تعداد روز به حیوان غذا نرسد، «بیمار» می‌شود:
 * حالش صفر می‌شود، هدیه نمی‌دهد و با او نمی‌توان بازی کرد.
 * درمان، همان غذا دادن است — بدون مکانیکِ تازهٔ بی‌دلیل.
 */
const SICK_AFTER_DAYS = 2
/** مقدار حالی که غذا خوردن به حیوان می‌دهد. */
const FEED_MOOD_GAIN = 25
/** حالی که بازی کردن اضافه می‌کند (روزی یک بار). */
const PLAY_MOOD_GAIN = 15

/**
 * سطوحِ پیوند (Bond).
 *
 * پیوند از تعدادِ *روزهای مراقبت* ساخته می‌شود (غذا دادن و بازی)، نه از
 * مقدار پولی که خرج شده؛ پس بازیکنِ کم‌درآمد هم می‌تواند رابطه‌اش را
 * عمیق کند. هر سطح، ضریبِ هدیهٔ روزانه را ۵٪ بالا می‌برد (سقف ۲۰٪).
 */
export const PET_BOND_LEVELS = [
  { level: 0, minPoints: 0, title: 'آشنای تازه', emoji: '🌱' },
  { level: 1, minPoints: 3, title: 'همدم', emoji: '🐾' },
  { level: 2, minPoints: 8, title: 'یارِ وفادار', emoji: '💞' },
  { level: 3, minPoints: 15, title: 'دوستِ صمیمی', emoji: '💖' },
  { level: 4, minPoints: 25, title: 'یارِ همیشگی', emoji: '👑' }
] as const

/** هر سطح پیوند، ۵٪ هدیهٔ روزانه را بیشتر می‌کند. */
const BOND_BONUS_STEP = 0.05

export type PetStatus = 'happy' | 'ok' | 'hungry' | 'sad' | 'sick'

export interface PetView {
  id: string
  kindKey: string
  kindName: string
  emoji: string
  name: string
  hunger: number
  mood: number
  status: PetStatus
  statusLabel: string
  statusHint: string
  isSick: boolean
  daysSinceFed: number
  hoursSinceFed: number
  fedToday: boolean
  playedToday: boolean
  bonusReady: boolean
  bonusCheckedToday: boolean
  giftReceivedToday: boolean
  feedCost: number
  adoptedAt: Date
  daysTogether: number
  bondPoints: number
  bondLevel: number
  bondTitle: string
  bondEmoji: string
  bondNextLevelAt: number | null
  bondProgressPercent: number
  bonusMultiplierPercent: number
  canFeed: boolean
  canPlay: boolean
  nextStepHint: string
}

export interface PetShopView {
  hasPet: boolean
  petName: string | null
  balance: number
  feedCostPerDay: number
  sickAfterDays: number
  kinds: Array<PetKind & { affordable: boolean; shortfall: number }>
}

/** نتیجهٔ سرپرستی — همهٔ چیزی که صفحهٔ موفقیت و بازیکن لازم دارد. */
export interface PetAdoptResult {
  name: string
  kindName: string
  kindKey: string
  emoji: string
  price: number
  balanceAfter: number
}

/** پیشوندهای dedupeKey که «مراقبت» شمرده می‌شوند و پیوند را می‌سازند. */
const CARE_KEY_PREFIXES = ['pet-feed:', 'pet-play:'] as const

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
}

/**
 * حیوان خانگی — نسخهٔ کامل.
 *
 * طراحی:
 *  • هر بازیکن فقط یک حیوان دارد (Unique روی playerId).
 *  • هیچ تایمری وجود ندارد؛ گرسنگی/حال/بیماری Lazy هنگام باز کردن پنل از
 *    lastFedAt حساب می‌شود و فقط *اگر تغییر کرده باشد* ذخیره می‌گردد.
 *  • پیوند از رخدادهای مراقبت (`pet-feed:*` و `pet-play:*`) شمرده می‌شود؛
 *    پس هیچ ستون تازه‌ای برای آن لازم نیست و داده هرگز واگرا نمی‌شود.
 *  • هدیهٔ روزانه قطعی است (hash از petId+روز)، فقط برای حیوانِ سالمِ
 *    خوشحال پرداخت می‌شود و با سطحِ پیوند تا ۲۰٪ بیشتر می‌شود.
 *  • «بیماری» یک وضعیتِ واقعی است: بی‌غذاییِ بیش از دو روز حال را صفر
 *    می‌کند و تنها راهِ درمان، رسیدگی (غذا) است.
 */
export class PetService {
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

  // ────────────────────────────────────────────────────────── محاسبات حالت

  /** گرسنگی/حال/بیماری بر اساس زمانِ سپری‌شده از آخرین غذا. */
  private stateOf(pet: { hunger: number; mood: number; lastFedAt: Date }): {
    hunger: number
    mood: number
    sick: boolean
    daysSinceFed: number
  } {
    const daysSinceFed = gameDaysSince(pet.lastFedAt)
    const hunger = Math.min(100, Math.round(pet.hunger + daysSinceFed * HUNGER_PER_DAY))
    const sick = daysSinceFed >= SICK_AFTER_DAYS
    const mood = sick
      ? 0
      : hunger >= 100
        ? 0
        : Math.max(0, Math.min(100, 100 - Math.max(0, hunger - 40)))
    return { hunger, mood, sick, daysSinceFed }
  }

  private static statusOf(state: { hunger: number; mood: number; sick: boolean }): {
    status: PetStatus
    statusLabel: string
    statusHint: string
  } {
    if (state.sick) {
      return {
        status: 'sick',
        statusLabel: '🤒 بیمار',
        statusHint: 'بیش از دو روز غذا نخورده؛ حالش بد است. با یک وعده غذا حالش را برگردان.'
      }
    }
    if (state.hunger >= 80) {
      return {
        status: 'hungry',
        statusLabel: '🍽️ گرسنه',
        statusHint: 'خیلی گرسنه است؛ همین حالا بهش غذا بده.'
      }
    }
    if (state.mood >= 80) {
      return {
        status: 'happy',
        statusLabel: '😄 سرحال',
        statusHint: 'حالش عالی است و آمادهٔ هدیه دادن.'
      }
    }
    if (state.mood >= 60) {
      return {
        status: 'ok',
        statusLabel: '🙂 خوب',
        statusHint: 'برای گرفتنِ هدیهٔ امروز آماده است.'
      }
    }
    return {
      status: 'sad',
      statusLabel: '😔 دلگیر',
      statusHint: 'حالش برای هدیه کافی نیست؛ غذا و کمی بازی حالش را بهتر می‌کند.'
    }
  }

  /** سطح پیوند از تعدادِ نقاطِ مراقبت. */
  private bondOf(points: number): {
    level: number
    title: string
    emoji: string
    nextLevelAt: number | null
    progressPercent: number
    multiplierPercent: number
  } {
    // نوعِ صریح لازم است: `PET_BOND_LEVELS` با `as const` تعریف شده، پس
    // `PET_BOND_LEVELS[0]` نوعِ لیترالِ عنصر صفر است و انتساب عنصرهای بعدی
    // به آن خطای کامپایل می‌دهد.
    let current: (typeof PET_BOND_LEVELS)[number] = PET_BOND_LEVELS[0]!
    for (const level of PET_BOND_LEVELS) {
      if (points >= level.minPoints) current = level
    }
    const next = PET_BOND_LEVELS.find((level) => level.minPoints > points) ?? null
    const spanStart = current.minPoints
    const spanEnd = next ? next.minPoints : current.minPoints
    const progressPercent =
      next === null || spanEnd <= spanStart
        ? 100
        : Math.min(100, Math.round(((points - spanStart) / (spanEnd - spanStart)) * 100))
    return {
      level: current.level,
      title: current.title,
      emoji: current.emoji,
      nextLevelAt: next ? next.minPoints : null,
      progressPercent,
      multiplierPercent: Math.round((1 + current.level * BOND_BONUS_STEP) * 100)
    }
  }

  /** شناسهٔ بازیکن از تلگرام؛ خطای انسانی اگر شخصیت ساخته نشده باشد. */
  private async playerIdOf(telegramUserId: bigint): Promise<string> {
    const player = await this.db.player.findUnique({
      where: { telegramUserId },
      select: { id: true }
    })
    if (!player) {
      throw new NotFoundError(
        'Player not found',
        'اول شخصیتت را در چت خصوصی ربات بساز تا سرپرستیِ حیوان ممکن شود.'
      )
    }
    return player.id
  }

  /** نقطهٔ مراقبت‌های اخیر + وضعیت امروز، در دو پرسش و بدون N+1. */
  private async careSnapshot(playerId: string, day: number): Promise<{
    carePoints: number
    fedToday: boolean
    playedToday: boolean
    giftReceivedToday: boolean
  }> {
    const [carePoints, todayEvents] = await Promise.all([
      this.db.gameEvent.count({
        where: {
          playerId,
          OR: CARE_KEY_PREFIXES.map((prefix) => ({ dedupeKey: { startsWith: prefix } }))
        }
      }),
      this.db.gameEvent.findMany({
        where: {
          playerId,
          dedupeKey: { endsWith: `:${day}` },
          OR: [
            ...CARE_KEY_PREFIXES.map((prefix) => ({ dedupeKey: { startsWith: prefix } })),
            { dedupeKey: { startsWith: 'pet-gift:' } },
            { dedupeKey: { startsWith: 'pet-bonus-nogift:' } }
          ]
        },
        select: { dedupeKey: true }
      })
    ])

    const keys = todayEvents.map((event) => event.dedupeKey ?? '')
    return {
      carePoints,
      fedToday: keys.some((key) => key.startsWith('pet-feed:')),
      playedToday: keys.some((key) => key.startsWith('pet-play:')),
      giftReceivedToday: keys.some((key) => key.startsWith('pet-gift:'))
    }
  }

  // ───────────────────────────────────────────────────────────── نمای پنل

  /** پنل حیوان + تازه‌سازی Lazy وضعیت. `null` یعنی هنوز حیوانی ندارد. */
  async getView(telegramUserId: bigint): Promise<PetView | null> {
    const playerId = await this.playerIdOf(telegramUserId)
    const pet = await this.db.pet.findUnique({ where: { playerId } })
    if (!pet) {
      return null
    }

    const day = dayIndex()
    const state = this.stateOf(pet)

    // ذخیرهٔ وضعیتِ محاسبه‌شده فقط اگر با مقدار ذخیره‌شده تفاوت داشته باشد؛
    // نوشتنِ بی‌دلیل روی هر باز کردنِ پنل، بارِ بی‌فایده روی دیتابیس است.
    if (pet.hunger !== state.hunger || pet.mood !== state.mood) {
      await this.db.pet.updateMany({
        where: { id: pet.id },
        data: { hunger: state.hunger, mood: state.mood }
      })
    }

    const { status, statusLabel, statusHint } = PetService.statusOf(state)
    const care = await this.careSnapshot(playerId, day)
    const bond = this.bondOf(care.carePoints)
    const kind = PET_KINDS.find((k) => k.key === pet.kind)
    const bonusCheckedToday = pet.lastBonusDayIndex === day
    const canFeed = !(care.fedToday && state.hunger === 0)
    const canPlay = !care.playedToday && !state.sick
    const bonusReady = !bonusCheckedToday && !state.sick && state.mood >= 60

    // اعلان بیماری: یک بار در روز، و فقط اگر واقعاً بیمار باشد. Lazy و
    // dedupe‌شده تا نه اسپم شود و نه پس از restart تکرار گردد.
    if (state.sick) {
      await this.notifySickOnce(playerId, pet.id, pet.name, day)
    }

    const nextStepHint = state.sick
      ? '🏥 درمانش ساده است: یک وعده غذا حالش را برمی‌گرداند.'
      : !care.fedToday
        ? '🍽️ امروز بهش غذا بده تا حالش خوب بماند.'
        : !care.playedToday
          ? '🎾 امروز با او بازی کن؛ پیوندتان عمیق‌تر می‌شود.'
          : bonusReady
            ? '🎁 حالش خوب است — هدیهٔ امروز را بگیر.'
            : '✅ امروز به‌خوبی از او مراقبت کردی؛ فردا دوباره سر بزن.'

    return {
      id: pet.id,
      kindKey: pet.kind,
      kindName: kind?.name ?? pet.kind,
      emoji: kind?.emoji ?? '🐾',
      name: pet.name,
      hunger: state.hunger,
      mood: state.mood,
      status,
      statusLabel,
      statusHint,
      isSick: state.sick,
      daysSinceFed: Math.floor(state.daysSinceFed),
      hoursSinceFed: gameHoursSince(pet.lastFedAt),
      fedToday: care.fedToday,
      playedToday: care.playedToday,
      bonusReady,
      bonusCheckedToday,
      giftReceivedToday: care.giftReceivedToday,
      feedCost: FEED_COST,
      adoptedAt: pet.adoptedAt,
      daysTogether: gameDaysSince(pet.adoptedAt),
      bondPoints: care.carePoints,
      bondLevel: bond.level,
      bondTitle: bond.title,
      bondEmoji: bond.emoji,
      bondNextLevelAt: bond.nextLevelAt,
      bondProgressPercent: bond.progressPercent,
      bonusMultiplierPercent: bond.multiplierPercent,
      canFeed,
      canPlay,
      nextStepHint
    }
  }

  /**
   * اعلانِ یک‌باردرروزِ بیماری.
   *
   * ضدتکرار روی *کلید اعلان* می‌نشیند (`pet-sick:{petId}:{day}`) نه روی رخداد
   * بازی؛ پس باز کردنِ چند بارهٔ پنل در یک روز فقط یک اعلان می‌سازد و خطای
   * تحویل هم هرگز پنل را نمی‌شکند.
   */
  private async notifySickOnce(
    playerId: string,
    petId: string,
    petName: string,
    day: number
  ): Promise<void> {
    if (!this.notificationService) return
    await this.notificationService
      .notifyPlayerById(
        playerId,
        '🤒 حیوانت بیمار شد',
        `${petName} بیش از دو روز است غذا نخورده و حالش بد شده. یک وعده غذا حالش را برمی‌گرداند و بعد از آن دوباره می‌تواند هدیه بدهد.`,
        undefined,
        `pet-sick:${petId}:${day}`,
        'IMPORTANT'
      )
      .catch(() => undefined)
  }

  /** نمای فروشگاه: نژادها + موجودی + توان خرید هر نژاد. */
  async getShopView(telegramUserId: bigint): Promise<PetShopView> {
    const playerId = await this.playerIdOf(telegramUserId)
    const [player, pet] = await Promise.all([
      this.db.player.findUniqueOrThrow({ where: { id: playerId }, select: { balance: true } }),
      this.db.pet.findUnique({ where: { playerId }, select: { name: true } })
    ])
    const balance = Number(player.balance)
    return {
      hasPet: pet !== null,
      petName: pet?.name ?? null,
      balance,
      feedCostPerDay: FEED_COST,
      sickAfterDays: SICK_AFTER_DAYS,
      kinds: PET_KINDS.map((kind) => ({
        ...kind,
        affordable: balance >= kind.price,
        shortfall: Math.max(0, kind.price - balance)
      }))
    }
  }

  // ────────────────────────────────────────────────────────── سرپرستی

  /**
   * به سرپرستی گرفتن حیوان.
   *
   * همه‌چیز در یک تراکنش: کسر شرطی پول، ساخت رکورد حیوان و ردیف دفتر کل.
   * اگر هر بخشی شکست بخورد، هیچ ردیف ناقصی باقی نمی‌ماند و پول برمی‌گردد.
   * «قبلاً حیوان داری» **فقط** برای نقضِ یکتایی گفته می‌شود؛ خطاهای دیگر
   * پیامِ درست خودشان را می‌گیرند.
   */
  async adopt(
    telegramUserId: bigint,
    kindKey: string,
    rawName: string
  ): Promise<PetAdoptResult> {
    const name = this.cleanName(rawName)

    const kind = PET_KINDS.find((k) => k.key === kindKey)
    if (!kind) {
      throw new NotFoundError('Unknown kind', 'این نوع حیوان وجود ندارد؛ فهرست فروشگاه را دوباره باز کن.')
    }

    const playerId = await this.playerIdOf(telegramUserId)

    // پیش‌بررسی روشن: بازیکنی که حیوان دارد، پیامِ درست می‌گیرد (نه خطای دیتابیس).
    const existing = await this.db.pet.findUnique({
      where: { playerId },
      select: { name: true, kind: true }
    })
    if (existing) {
      const existingKind = PET_KINDS.find((k) => k.key === existing.kind)
      throw new ConflictError(
        'Already have a pet',
        `تو همین حالا از ${existingKind?.emoji ?? '🐾'} *${existing.name}* نگهداری می‌کنی؛ هر بازیکن فقط یک حیوان می‌تواند داشته باشد.`
      )
    }

    let balanceAfter = 0
    try {
      await this.db.$transaction(async (tx) => {
        const debited = await tx.player.updateMany({
          where: { id: playerId, balance: { gte: kind.price } },
          data: { balance: { decrement: kind.price } }
        })
        if (debited.count !== 1) {
          const fresh = await tx.player.findUniqueOrThrow({
            where: { id: playerId },
            select: { balance: true }
          })
          const shortfall = kind.price - Number(fresh.balance)
          throw new ConflictError(
            'Insufficient balance',
            `هزینهٔ سرپرستی ${kind.emoji} ${kind.name} ${kind.price.toLocaleString('fa-IR')} تومان است.\n${shortfall.toLocaleString('fa-IR')} تومان کم داری؛ می‌توانی نژادِ ارزان‌تری انتخاب کنی یا اول درآمد بسازی.`
          )
        }

        // Unique روی playerId: دومین سرپرستی ناممکن است
        await tx.pet.create({
          data: { playerId, kind: kind.key, name }
        })

        await tx.financialTransaction.create({
          data: {
            amount: kind.price,
            type: TransactionType.PET_EXPENSE,
            sourcePlayerId: playerId,
            reference: `سرپرستی ${kind.name}`
          }
        })

        const fresh = await tx.player.findUniqueOrThrow({
          where: { id: playerId },
          select: { balance: true }
        })
        balanceAfter = Number(fresh.balance)
      })
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError(
          'Already have a pet',
          'تو قبلاً یک حیوان خانگی داری؛ هر بازیکن فقط یکی می‌تواند داشته باشد.'
        )
      }
      throw error
    }

    await this.eventService
      .recordPlayerEvent({
        playerId,
        type: GameEventType.PET_ADOPTED,
        title: `${kind.emoji} ${name} به زندگی تو آمد!`,
        amount: kind.price,
        dedupeKey: `pet-adopt:${playerId}`
      })
      .catch(() => undefined)

    return {
      name,
      kindName: kind.name,
      kindKey: kind.key,
      emoji: kind.emoji,
      price: kind.price,
      balanceAfter
    }
  }

  /** پاک‌سازی و اعتبارسنجی نامِ حیوان؛ پیامِ خطای انسانی. */
  private cleanName(rawName: string): string {
    const name = rawName.replace(/\s+/g, ' ').trim().slice(0, 24)
    if (name.length < 2) {
      throw new NotFoundError(
        'Invalid name',
        'نام حیوان باید دست‌کم ۲ حرف باشد؛ مثلاً «پشمک» یا «سیاه».'
      )
    }
    if (!/\p{L}|\p{Extended_Pictographic}/u.test(name)) {
      throw new NotFoundError(
        'Invalid name',
        'نام حیوان باید حرف یا ایموجی داشته باشد؛ عدد و علامت به‌تنهایی نام نیستند.'
      )
    }
    return name
  }

  // ─────────────────────────────────────────────────────── نگهداری روزانه

  /** غذا دادن؛ گرسنگی صفر، حال بهتر و بیماری درمان می‌شود. */
  async feed(telegramUserId: bigint): Promise<{ mood: number; cost: number; cured: boolean }> {
    const playerId = await this.playerIdOf(telegramUserId)
    const pet = await this.db.pet.findUnique({ where: { playerId } })
    if (!pet) {
      throw new ConflictError(
        'No pet',
        'هنوز حیوان خانگی نداری. در بخش «حیوان» شرایط و هزینهٔ سرپرستی را ببین.'
      )
    }

    const day = dayIndex()
    const state = this.stateOf(pet)
    const care = await this.careSnapshot(playerId, day)

    // گاردِ دکمهٔ کهنه: غذا دادنِ دوباره وقتی سیر است، پول را بی‌دلیل می‌سوزاند.
    if (care.fedToday && state.hunger === 0) {
      throw new ConflictError(
        'Already fed',
        `${pet.name} امروز سیر شده است؛ فردا دوباره سر بزن یا حالا با او بازی کن.`
      )
    }

    await this.db.$transaction(async (tx) => {
      const debited = await tx.player.updateMany({
        where: { id: playerId, balance: { gte: FEED_COST } },
        data: { balance: { decrement: FEED_COST } }
      })
      if (debited.count !== 1) {
        const fresh = await tx.player.findUnique({
          where: { id: playerId },
          select: { balance: true }
        })
        throw new ConflictError(
          'Insufficient balance',
          insufficientFunds(
            FEED_COST,
            Number(fresh?.balance ?? 0),
            'غذای امروزِ حیوانت',
            'کارِ کوچکی در گروه بکن (مثلاً کارت روزانه) و بعد همین‌جا برگرد؛ بازی کردن با او رایگان است.'
          )
        )
      }

      await tx.pet.updateMany({
        where: { id: pet.id },
        data: {
          hunger: 0,
          mood: Math.min(100, state.mood + FEED_MOOD_GAIN),
          lastFedAt: new Date()
        }
      })

      await tx.financialTransaction.create({
        data: {
          amount: FEED_COST,
          type: TransactionType.PET_EXPENSE,
          sourcePlayerId: playerId,
          reference: `غذای ${pet.name}`
        }
      })
    })

    await this.eventService
      .recordPlayerEvent({
        playerId,
        type: GameEventType.PET_FED,
        title: `${pet.name} سیر شد`,
        dedupeKey: `pet-feed:${pet.id}:${day}`
      })
      .catch(() => undefined)

    const fresh = await this.db.pet.findUniqueOrThrow({ where: { id: pet.id } })
    return { mood: fresh.mood, cost: FEED_COST, cured: state.sick }
  }

  /**
   * بازی کردن با حیوان — رایگان، روزی یک بار.
   *
   * یک‌باردرروز بودنش را خودِ دیتابیس تضمین می‌کند: رخدادِ `PET_PLAY` با
   * dedupeKey یکتا در همان تراکنشِ تغییرِ حال نوشته می‌شود، پس دو کلیکِ
   * هم‌زمان یکی بیشتر اثر نمی‌کند.
   */
  async play(telegramUserId: bigint): Promise<{ mood: number; bondLevel: number }> {
    const playerId = await this.playerIdOf(telegramUserId)
    const pet = await this.db.pet.findUnique({ where: { playerId } })
    if (!pet) {
      throw new ConflictError(
        'No pet',
        'هنوز حیوان خانگی نداری. در بخش «حیوان» شرایط و هزینهٔ سرپرستی را ببین.'
      )
    }

    const state = this.stateOf(pet)
    if (state.sick) {
      throw new ConflictError(
        'Pet sick',
        `${pet.name} بیمار است و حالِ بازی ندارد؛ اول بهش غذا بده.`
      )
    }

    const day = dayIndex()
    try {
      await this.db.$transaction(async (tx) => {
        await tx.gameEvent.create({
          data: {
            scope: 'PLAYER',
            type: GameEventType.PET_PLAY,
            priority: 1,
            playerId,
            title: `با ${pet.name} بازی کردی`,
            dedupeKey: `pet-play:${pet.id}:${day}`
          }
        })
        await tx.pet.updateMany({
          where: { id: pet.id },
          data: { mood: Math.min(100, state.mood + PLAY_MOOD_GAIN) }
        })
      })
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError(
          'Already played',
          `امروز با ${pet.name} بازی کرده‌ای؛ فردا دوباره سر بزن.`
        )
      }
      throw error
    }

    const [fresh, care] = await Promise.all([
      this.db.pet.findUniqueOrThrow({ where: { id: pet.id } }),
      this.careSnapshot(playerId, day)
    ])
    return { mood: fresh.mood, bondLevel: this.bondOf(care.carePoints).level }
  }

  /**
   * هدیهٔ روزانهٔ حیوانِ خوشحال؛ نتیجهٔ قطعی روز و مقیاس‌پذیر با پیوند.
   * `null` یعنی امروز هدیه‌ای نداشت (تلاشِ روز مصرف شد) — این خروجی
   * همان قرارداد قبلی است تا مسیرهای موجود نشکنند.
   */
  async claimDailyBonus(
    telegramUserId: bigint
  ): Promise<{ amount: number; petName: string; multiplierPercent: number } | null> {
    const playerId = await this.playerIdOf(telegramUserId)
    const pet = await this.db.pet.findUnique({ where: { playerId } })
    if (!pet) {
      throw new ConflictError(
        'No pet',
        'هنوز حیوان خانگی نداری. در بخش «حیوان» شرایط و هزینهٔ سرپرستی را ببین.'
      )
    }

    const day = dayIndex()
    if (pet.lastBonusDayIndex === day) {
      throw new ConflictError('Bonus claimed', 'هدیهٔ امروزش را گرفته‌ای.')
    }

    const state = this.stateOf(pet)
    if (state.sick) {
      throw new ConflictError(
        'Pet sick',
        `${pet.name} بیمار است و هدیه‌ای ندارد؛ اول بهش غذا بده.`
      )
    }
    if (state.mood < 60) {
      throw new ConflictError(
        'Pet unhappy',
        `حال ${pet.name} برای هدیه کافی نیست؛ غذا بده و کمی بازی کن.`
      )
    }

    const kind = PET_KINDS.find((k) => k.key === pet.kind) ?? PET_KINDS[0]!

    const roll = stableHash(`petbonus:${pet.id}:${day}`) % 100
    if (roll >= 55) {
      // امروز هدیه‌ای در کار نیست؛ تلاشِ روز مصرف می‌شود و فردا دوباره شانس هست.
      // یک رخدادِ سبک هم ثبت می‌شود تا پنل بتواند بگوید «امروز بررسی شد».
      await this.db.pet.updateMany({
        where: { id: pet.id, lastBonusDayIndex: { not: day } },
        data: { lastBonusDayIndex: day }
      })
      await this.eventService
        .recordPlayerEvent({
          playerId,
          type: GameEventType.PET_FED,
          title: `${pet.name} امروز هدیه‌ای نداشت`,
          dedupeKey: `pet-bonus-nogift:${pet.id}:${day}`
        })
        .catch(() => undefined)
      return null
    }

    const care = await this.careSnapshot(playerId, day)
    const bond = this.bondOf(care.carePoints)
    const variant = stableHash(`petvariant:${pet.id}:${day}`)
    const amount = petBonusAmount(kind, bond.multiplierPercent, variant)

    await this.db.$transaction(async (tx) => {
      const claimed = await tx.pet.updateMany({
        where: { id: pet.id, lastBonusDayIndex: { not: day } },
        data: { lastBonusDayIndex: day }
      })
      if (claimed.count !== 1) {
        throw new ConflictError('Concurrent claim', 'هدیه همین حالا گرفته شد.')
      }

      await tx.player.update({
        where: { id: playerId },
        data: { balance: { increment: amount } }
      })
      await tx.financialTransaction.create({
        data: {
          amount,
          type: TransactionType.PET_BONUS,
          destinationPlayerId: playerId,
          reference: `هدیهٔ روزانهٔ ${pet.name}`
        }
      })
    })

    await this.eventService
      .recordPlayerEvent({
        playerId,
        // نوعِ درست: این رخداد «هدیه» است نه «غذا»؛ پیش‌تر با PET_FED ثبت
        // می‌شد و در تاریخچه برچسبِ «غذای حیوان» می‌گرفت.
        type: GameEventType.PET_GIFT,
        title: `${pet.name} برایت هدیه آورد!`,
        amount,
        dedupeKey: `pet-gift:${pet.id}:${day}`
      })
      .catch(() => undefined)

    return { amount, petName: pet.name, multiplierPercent: bond.multiplierPercent }
  }
}

/**
 * مبلغِ قطعیِ هدیهٔ یک روز — تک‌منبعِ حقیقت، خالص و مستقیم آزمون‌پذیر.
 *
 * دو ضمانتِ این تابع:
 *  • گامِ تنوع (`BONUS_STEP`) هم‌واحدِ اقتصاد است، پس `stepCount` واقعاً چند
 *    حالت می‌سازد و انتخابِ روز اثری دارد.
 *  • گردکردن هرگز مبلغ را صفر نمی‌کند و نتیجه هرگز از `bonusMin` کمتر نمی‌شود؛
 *    پس هدیه در بدترین حالت هم از خرجِ روزانهٔ غذا بیشتر است.
 */
export function petBonusAmount(kind: PetKind, multiplierPercent: number, variant: number): number {
  const span = Math.max(0, kind.bonusMax - kind.bonusMin)
  const stepCount = Math.floor(span / BONUS_STEP) + 1
  const base = kind.bonusMin + (variant % stepCount) * BONUS_STEP
  // گردکردن به نزدیک‌ترین تومان کامل — بدونِ کوانتیزاسیونِ ثابت، که قبلاً
  // هر مبلغ زیر گامِ خودش را به صفر می‌رساند.
  const scaled = Math.round((base * multiplierPercent) / 100)
  return Math.max(kind.bonusMin, MIN_BONUS, scaled)
}

export const PET_INFO = {
  feedCost: FEED_COST,
  kinds: PET_KINDS,
  bondLevels: PET_BOND_LEVELS,
  bondBonusStep: BOND_BONUS_STEP,
  sickAfterDays: SICK_AFTER_DAYS,
  playMoodGain: PLAY_MOOD_GAIN
} as const
