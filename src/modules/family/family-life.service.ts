import {
  GameEventType,
  NotificationType,
  PrismaClient,
  ProfilePrivacy,
  TransactionType
} from '@prisma/client'
import { ConflictError, NotFoundError, ValidationError } from '../../utils/classes/errors'
import type { NotificationLevel } from '../notification/push'
import { EventService } from '../events/event.service'
import { REAL_MS_PER_GAME_HOUR, dayIndex, gameDaysSince } from '../../utils/game-time'
import { money } from '../../utils/format'
import { effectiveAge } from '../lifecycle/game-calendar'
import { degreeLabels, DegreeLevel } from '../education/education-blueprints'
import { isPlayerEmployed } from '../occupation/employment'
import { resolveMaxHealth } from '../health/max-health'
import {
  ACTIVITY_WARMTH_GAIN,
  coupleBonusMultiplier,
  gainWarmth,
  giftWarmthGain,
  GIFT_MAX,
  GIFT_MIN,
  warmthLabel
} from './family-warmth'
import { readWarmth, warmthAnchorOf, writeWarmth } from './family-warmth.store'
import { SPOUSE_ACTIVE_MS } from './marriage.service'
import { settleWidowhood } from './widowhood'

/** هزینهٔ «وقت مشترک» — پولی که از بازی خارج می‌شود (Sink). */
export const FAMILY_ACTIVITY_COST = 300_000
/** خستگی‌ای که هر دو همسر با وقت مشترک در می‌کنند. */
export const ACTIVITY_FATIGUE_RELIEF = 20
/** سلامتِ دریافتی هر دو همسر از وقت مشترک. */
export const ACTIVITY_HEALTH_GAIN = 6

/** بازیکنِ همسر به‌همراه فیلدهای لازم برای پنل و اثرها. */
const SPOUSE_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  username: true,
  privacy: true,
  age: true,
  startedAt: true,
  currentDegree: true,
  graduationField: true,
  balance: true,
  health: true,
  fatigue: true,
  lastActivityAt: true,
  homeGroup: { select: { title: true } }
} as const

export interface FamilyDetailView {
  hasSpouse: boolean
  spouse: {
    name: string
    /** نام کاربری تلگرام؛ اگر پروفایل همسر خصوصی باشد `null` است. */
    username: string | null
    age: number
    degreeLabel: string
    field: string | null
    employed: boolean
    regionTitle: string | null
    /** آیا همسر ۴۸ ساعت اخیر فعال بوده؟ */
    activeRecently: boolean
  } | null
  warmth: number | null
  warmthLabelText: string | null
  bonusMultiplier: number | null
  daysMarried: number
  mahr: number
  marriedAt: Date | null
  activityDoneToday: boolean
  activityCost: number
  myBalance: number
  /** موجودی همسر فقط وقتی پروفایلش عمومی است دیده می‌شود. */
  spouseBalance: { visible: boolean; amount: number } | null
  householdBalance: number | null
  myHome: string | null
  spouseHome: string | null
  sharedHome: string | null
}

/**
 * زندگیِ خانواده پس از عقد — سیستم زندهٔ رابطه.
 *
 * سه مکانیک واقعی که «خانواده» را از یک وضعیتِ ثابت به یک گیم‌پلی روزانه
 * تبدیل می‌کنند:
 *
 *  ۱. *وقت مشترک* (`spendTimeTogether`): روزی یک‌بار، هزینه دارد، خستگیِ هر
 *     دو همسر را کم و سلامتی‌شان را زیاد می‌کند و گرما می‌سازد. تصمیم:
 *     پولِ نقد بدهم تا انرژی و رابطه بگیرم؟ (خانواده ↔ سلامت ↔ کار)
 *  ۲. *هدیه* (`sendGiftToSpouse`): انتقال واقعی پول به همسر که بسته به مبلغ
 *     گرما می‌آورد. تصمیم: چقدر بدهم؟ (خانواده ↔ اقتصاد)
 *  ۳. *گرمای رابطه*: با بی‌توجهی فرسایش می‌شود و پاداش روزانهٔ زوجین را
 *     کم می‌کند؛ با همین دو مکانیک و خودِ پاداش رشد می‌کند. (پیامد)
 *
 * همهٔ نوشتارها شرطی و اتمیک‌اند: قفل روزانهٔ وقت مشترک، گارد موجودی برای
 * خرج/هدیه و نوشتار دوطرفهٔ گرما — دابل‌کلیک و درخواست همزمان پولی نمی‌سازد.
 */
export class FamilyLifeService {
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

  /**
   * ازدواج فعال بازیکن به‌همراه هر دو طرف.
   *
   * پیش از خواندن، اگر همسر فوت کرده باشد ازدواج بسته می‌شود (Lazy) تا وقتِ
   * مشترک/هدیه/پنل جزئیات با یک همسرِ فوت‌شده ادامه پیدا نکند.
   */
  private async findActiveMarriage(playerId: string) {
    await settleWidowhood(this.db, playerId, {
      notify: this.notificationService
        ? (notifyPlayerId, title, message, type, dedupeKey, level) =>
            this.notificationService!.notifyPlayerById(
              notifyPlayerId,
              title,
              message,
              type,
              dedupeKey,
              level
            )
        : undefined,
      recordEvent: (input) => this.eventService.recordPlayerEvent(input)
    })
    return this.db.marriage.findFirst({
      where: { isActive: true, OR: [{ playerAId: playerId }, { playerBId: playerId }] },
      include: { playerA: { select: SPOUSE_SELECT }, playerB: { select: SPOUSE_SELECT } }
    })
  }

  private async requirePlayer(telegramUserId: bigint) {
    const me = await this.db.player.findUnique({
      where: { telegramUserId },
      select: { id: true, balance: true }
    })
    if (!me) {
      throw new NotFoundError('Player not found')
    }
    return me
  }

  /** آیا این همسر برای فعالیت مشترک «حاضر» شمرده می‌شود؟ */
  private static spouseIsPresent(spouse: { lastActivityAt: Date | null }): boolean {
    return (
      spouse.lastActivityAt !== null &&
      Date.now() - spouse.lastActivityAt.getTime() <= SPOUSE_ACTIVE_MS
    )
  }

  /**
   * وقت مشترک — روزی یک‌بار برای هر ازدواج.
   *
   * هزینه از جیبِ شروعکننده می‌رود (Sink)، هر دو همسر خستگی در می‌کنند و
   * سلامت می‌گیرند، و گرمای رابطه بالا می‌رود. قفل روزانه و گارد موجودی
   * هر دو داخل یک تراکنش‌اند.
   */
  async spendTimeTogether(telegramUserId: bigint): Promise<{ warmth: number }> {
    const me = await this.requirePlayer(telegramUserId)
    const marriage = await this.findActiveMarriage(me.id)
    if (!marriage) {
      throw new ConflictError('Not married', 'برای وقتِ مشترک باید متأهل باشی.')
    }
    const spouse = marriage.playerAId === me.id ? marriage.playerB : marriage.playerA

    const day = dayIndex()
    if (marriage.lastActivityDayIndex === day) {
      throw new ConflictError('Already today', 'امروز وقتِ مشترک داشتید؛ فردا دوباره سر بزن.')
    }
    if (!FamilyLifeService.spouseIsPresent(spouse)) {
      throw new ConflictError(
        'Spouse inactive',
        'همسرت دو روز اخیر فعالیتی نداشته است؛ وقتِ مشترک با همسرِ غایب ممکن نیست.'
      )
    }

    const now = new Date()
    const warmth = await this.db.$transaction(async (tx) => {
      // قفل روزانه: نوشتار شرطی تا دابل‌کلیک/درخواست همزمان دوبار خرج نکند
      const locked = await tx.marriage.updateMany({
        where: {
          id: marriage.id,
          OR: [{ lastActivityDayIndex: null }, { lastActivityDayIndex: { not: day } }]
        },
        data: { lastActivityDayIndex: day }
      })
      if (locked.count !== 1) {
        throw new ConflictError('Concurrent activity', 'وقتِ مشترک همین حالا ثبت شد.')
      }

      const debited = await tx.player.updateMany({
        where: { id: me.id, balance: { gte: FAMILY_ACTIVITY_COST } },
        data: { balance: { decrement: FAMILY_ACTIVITY_COST } }
      })
      if (debited.count !== 1) {
        throw new ValidationError(
          'Insufficient for activity',
          `هزینهٔ وقتِ مشترک ${money(FAMILY_ACTIVITY_COST)} است و موجودی‌ات کافی نیست.`
        )
      }
      await tx.financialTransaction.create({
        data: {
          amount: FAMILY_ACTIVITY_COST,
          type: TransactionType.FAMILY_EXPENSE,
          sourcePlayerId: me.id,
          reference: 'وقتِ مشترک خانواده'
        }
      })

      // گرما: خواندنِ مقدارِ واقعی (با فرسایش) و افزودن سهمِ فعالیت
      const anchor = warmthAnchorOf(marriage)
      const current = await readWarmth(tx, anchor)
      const next = gainWarmth(current, ACTIVITY_WARMTH_GAIN)
      await writeWarmth(tx, anchor, next, now)

      // اثر جسمی برای هر دو همسر: خستگی کمتر، سلامت بیشتر (تا سقف واقعی هرکس)
      for (const partner of [marriage.playerA, marriage.playerB]) {
        const maxHealth = await resolveMaxHealth(tx, partner.id)
        await tx.player.update({
          where: { id: partner.id },
          data: {
            fatigue: { decrement: Math.min(partner.fatigue, ACTIVITY_FATIGUE_RELIEF) },
            health: Math.min(maxHealth, partner.health + ACTIVITY_HEALTH_GAIN)
          }
        })
      }

      return next
    })

    await this.eventService
      .recordPlayerEvent({
        playerId: me.id,
        type: GameEventType.MARRIAGE_REGISTERED,
        title: '🕯️ وقتِ مشترک خانواده',
        detail: 'خستگیِ هر دو کم شد و رابطه گرم‌تر شد.',
        amount: FAMILY_ACTIVITY_COST,
        dedupeKey: `family-activity:${marriage.id}:${day}`
      })
      .catch(() => undefined)

    await this.notificationService
      ?.notifyPlayerById(
        spouse.id,
        '🕯️ وقتِ مشترک',
        `همسرت امروز برای زندگیِ مشترکتان وقت گذاشت؛ کمی خستگی در کردی و سلامت گرفتی.`,
        undefined,
        `family-activity-notify:${marriage.id}:${day}`,
        'INFORMATIONAL'
      )
      .catch(() => undefined)

    return { warmth }
  }

  /**
   * هدیه به همسر — انتقال واقعی پول + گرمای وابسته به مبلغ.
   * پول از جیبِ فرستنده به کیفِ پول همسر می‌رود (نه ساخته می‌شود، نه می‌سوزد).
   */
  async sendGiftToSpouse(
    telegramUserId: bigint,
    amount: number
  ): Promise<{ amount: number; spouseName: string; warmthGain: number }> {
    if (!Number.isSafeInteger(amount)) {
      throw new ValidationError('Invalid gift amount', 'مبلغ هدیه باید عدد صحیح باشد.')
    }
    if (amount < GIFT_MIN || amount > GIFT_MAX) {
      throw new ValidationError(
        'Gift amount out of range',
        `هدیه باید بین ${money(GIFT_MIN)} تا ${money(GIFT_MAX)} باشد.`
      )
    }

    const me = await this.requirePlayer(telegramUserId)
    const marriage = await this.findActiveMarriage(me.id)
    if (!marriage) {
      throw new ConflictError('Not married', 'برای هدیه‌دادن باید متأهل باشی.')
    }
    const spouse = marriage.playerAId === me.id ? marriage.playerB : marriage.playerA
    const spouseName = `${spouse.firstName} ${spouse.lastName ?? ''}`.trim()
    const warmthGain = giftWarmthGain(amount)

    let transactionId = ''
    const now = new Date()
    await this.db.$transaction(async (tx) => {
      const debited = await tx.player.updateMany({
        where: { id: me.id, balance: { gte: amount } },
        data: { balance: { decrement: amount } }
      })
      if (debited.count !== 1) {
        throw new ValidationError(
          'Insufficient for gift',
          `موجودی‌ات برای هدیهٔ ${money(amount)} کافی نیست.`
        )
      }
      await tx.player.update({
        where: { id: spouse.id },
        data: { balance: { increment: amount } }
      })
      const ledger = await tx.financialTransaction.create({
        data: {
          amount,
          type: TransactionType.TRANSFER,
          sourcePlayerId: me.id,
          destinationPlayerId: spouse.id,
          reference: 'هدیه به همسر'
        }
      })
      transactionId = ledger.id

      if (warmthGain > 0) {
        const anchor = warmthAnchorOf(marriage)
        const current = await readWarmth(tx, anchor)
        await writeWarmth(tx, anchor, gainWarmth(current, warmthGain), now)
      }
    })

    await this.eventService
      .recordPlayerEvent({
        playerId: me.id,
        type: GameEventType.MARRIAGE_REGISTERED,
        title: '🎁 هدیه به همسر',
        detail: `به ${spouseName}`,
        amount,
        dedupeKey: `family-gift:${transactionId}`
      })
      .catch(() => undefined)

    await this.notificationService
      ?.notifyPlayerById(
        spouse.id,
        '🎁 هدیهٔ همسر',
        `همسرت ${money(amount)} به تو هدیه داد و به حساب‌ات نشست.`,
        undefined,
        `family-gift-notify:${transactionId}`,
        'CRITICAL'
      )
      .catch(() => undefined)

    return { amount, spouseName, warmthGain }
  }

  /** نمای کامل «جزئیات خانواده» — همه از وضعیتِ واقعیِ دیتابیس. */
  async getFamilyDetail(telegramUserId: bigint): Promise<FamilyDetailView> {
    const me = await this.requirePlayer(telegramUserId)
    const marriage = await this.findActiveMarriage(me.id)

    if (!marriage) {
      return {
        hasSpouse: false,
        spouse: null,
        warmth: null,
        warmthLabelText: null,
        bonusMultiplier: null,
        daysMarried: 0,
        mahr: 0,
        marriedAt: null,
        activityDoneToday: false,
        activityCost: FAMILY_ACTIVITY_COST,
        myBalance: Number(me.balance),
        spouseBalance: null,
        householdBalance: null,
        myHome: null,
        spouseHome: null,
        sharedHome: null
      }
    }

    const spouse = marriage.playerAId === me.id ? marriage.playerB : marriage.playerA
    const anchor = warmthAnchorOf(marriage)
    const warmth = await readWarmth(this.db, anchor)
    const spousePublic = spouse.privacy === ProfilePrivacy.PUBLIC
    const employed = await isPlayerEmployed(this.db, spouse.id)

    // خانه‌ها: ملکِ شخصی، قرارداد اجارهٔ فعال و خانهٔ همسر — دادهٔ واقعی مسکن
    const [myProperties, myRental, spouseProperties] = await Promise.all([
      this.db.property.findMany({
        where: { ownerId: me.id, status: 'OWNED' },
        select: { title: true },
        orderBy: { createdAt: 'desc' },
        take: 1
      }),
      this.db.rentalContract.findFirst({
        where: { tenantId: me.id, isActive: true },
        include: { property: { select: { title: true } } }
      }),
      this.db.property.findMany({
        where: { ownerId: spouse.id, status: 'OWNED' },
        select: { title: true },
        orderBy: { createdAt: 'desc' },
        take: 1
      })
    ])
    const myHome =
      myProperties[0]?.title ?? (myRental ? `${myRental.property.title} (اجاره‌ای)` : null)
    const spouseHome = spouseProperties[0]?.title ?? null

    return {
      hasSpouse: true,
      spouse: {
        name: `${spouse.firstName} ${spouse.lastName ?? ''}`.trim(),
        username: spousePublic ? spouse.username : null,
        age: effectiveAge(spouse.startedAt, spouse.age),
        degreeLabel: degreeLabels[(spouse.currentDegree as DegreeLevel) ?? DegreeLevel.DIPLOMA] ?? 'دیپلم',
        field: spouse.graduationField,
        employed,
        regionTitle: spouse.homeGroup?.title ?? null,
        activeRecently: FamilyLifeService.spouseIsPresent(spouse)
      },
      warmth,
      warmthLabelText: warmthLabel(warmth),
      bonusMultiplier: coupleBonusMultiplier(warmth),
      daysMarried: gameDaysSince(marriage.marriedAt),
      mahr: Number(marriage.mahr),
      marriedAt: marriage.marriedAt,
      activityDoneToday: marriage.lastActivityDayIndex === dayIndex(),
      activityCost: FAMILY_ACTIVITY_COST,
      myBalance: Number(me.balance),
      spouseBalance: spousePublic
        ? { visible: true, amount: Number(spouse.balance) }
        : { visible: false, amount: 0 },
      householdBalance: spousePublic ? Number(me.balance) + Number(spouse.balance) : null,
      myHome,
      spouseHome,
      sharedHome: myHome ?? spouseHome
    }
  }
}

/** خلاصهٔ قواعد زندگی خانواده برای راهنما و پنل‌ها. */
export const FAMILY_LIFE_INFO = {
  activityCost: FAMILY_ACTIVITY_COST,
  activityFatigueRelief: ACTIVITY_FATIGUE_RELIEF,
  activityHealthGain: ACTIVITY_HEALTH_GAIN,
  activityWarmthGain: ACTIVITY_WARMTH_GAIN,
  giftMin: GIFT_MIN,
  giftMax: GIFT_MAX,
  spouseActiveHours: Math.round(SPOUSE_ACTIVE_MS / REAL_MS_PER_GAME_HOUR)
} as const
