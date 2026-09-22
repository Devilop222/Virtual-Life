import { GameEventType, Prisma, PrismaClient, TransactionType } from '@prisma/client'
import { ConflictError, NotFoundError } from '../../utils/classes/errors'
import { EventService } from '../events/event.service'
import { dayIndex, weekIndex, stableHash, ratePerGameHour } from '../../utils/game-time'
import { PART_TIME_JOBS } from '../occupation/work-blueprints'
import { SHOP_ITEMS } from '../shop/shop-catalog'

/** کلیدهای فعالیت که پیشرفت کارت‌ها را جلو می‌برند. */
export type QuestTrigger =
  | 'work_shift'
  | 'shop_purchase'
  | 'bank_deposit'
  | 'item_used'
  | 'group_activity'
  | 'market_trade'
  | 'project_donation'

interface QuestBlueprint {
  key: QuestTrigger
  title: string
  hint: string
  target: number
  reward: number
}

/**
 * پلهٔ مرجعِ پاداش روزانه: دستمزد یک ساعت کار در ارزان‌ترین شغلِ بازار.
 *
 * چرا این عدد و نه یک عدد دلبخواه؟ چون بازیکن پاداش را با «کاری که می‌توانست
 * بکند» می‌سنجد. پیش‌تر پاداش کارت `cycleAmount(40_000)` بود، یعنی ۱٬۳۳۳
 * تومان، در حالی که:
 *   • ارزان‌ترین کالای فروشگاه ۵٬۰۰۰ تومان است — کارتی که خودش می‌گفت
 *     «از فروشگاه خرید کن»، کمتر از هزینهٔ همان خرید می‌داد؛
 *   • یک ساعت کار در ارزان‌ترین شغل ۶٬۰۰۰ تومان می‌دهد؛
 *   • استریک روزانه برای یک ضربه ۲٬۵۰۰ تومان می‌داد.
 * حاصل این‌که کارت روزانه هم به‌ضرر بازیکن بود و هم کمتر از یک ضربه می‌ارزید؛
 * پس عقلانی بود که کسی سراغش نرود. حالا مقیاس همهٔ پاداش‌های کارت با همان
 * واحدی است که قیمت‌ها با آن نوشته شده‌اند.
 */
export const HOURLY_FLOOR_WAGE = ratePerGameHour(
  Math.min(...PART_TIME_JOBS.map((job) => job.basePayPerMinute))
)

/** ارزان‌ترین کالای فروشگاه — کفِ «هزینهٔ» کارت‌های خرید. */
export const CHEAPEST_SHOP_ITEM = Math.min(...SHOP_ITEMS.map((item) => item.price))

/**
 * پاداش هر کارت: یک ساعت کار، ولی هرگز کمتر از ارزان‌ترین خریدِ ممکن.
 * `Math.max` عمدی است: اگر روزی کالای ارزانی گران‌تر از یک ساعت کارِ کف شود،
 * پاداش خودش بالا می‌رود و کارت دوباره به‌ضرر نمی‌افتد.
 */
const CARD_REWARD = Math.max(HOURLY_FLOOR_WAGE, CHEAPEST_SHOP_ITEM)

/**
 * کارت‌های ممکن. هر روز سه کارت از همین فهرست انتخاب می‌شود.
 * همه یک پاداش دارند: کارت باید بازیکن را به «امتحان‌کردن» دعوت کند، نه اینکه
 * با تفاوت‌های ریز، محاسبه‌ی سود و زیان راه بیندازد.
 */
const QUEST_POOL: readonly QuestBlueprint[] = [
  {
    key: 'work_shift',
    title: 'یک نوبت کاری کامل',
    hint: 'کلمهٔ «کار» را بفرست و یک شیفت را تا پایان ببر.',
    target: 1,
    reward: CARD_REWARD
  },
  {
    key: 'shop_purchase',
    title: 'خرید از فروشگاه',
    hint: 'کلمهٔ «فروشگاه» را بفرست و یک کالا بخر.',
    target: 1,
    reward: CARD_REWARD
  },
  {
    key: 'bank_deposit',
    title: 'واریز به حساب بانکی',
    hint: 'کلمهٔ «بانک» را بفرست و مبلغی واریز کن.',
    target: 1,
    reward: CARD_REWARD
  },
  {
    key: 'item_used',
    title: 'استفاده از یک کالای انبار',
    hint: 'کلمهٔ «انبار» را بفرست و یک کالا مصرف کن.',
    target: 1,
    reward: CARD_REWARD
  },
  {
    key: 'group_activity',
    title: 'سه فعالیت در گروه',
    hint: 'داخل گروه سه بخش مختلف بازی را باز کن.',
    target: 3,
    reward: CARD_REWARD
  },
  {
    key: 'market_trade',
    title: 'یک معاملهٔ بازار',
    hint: 'از «بازار» چیزی بخر یا از «انبار» آگهی بگذار.',
    target: 1,
    reward: CARD_REWARD
  },
  {
    key: 'project_donation',
    title: 'کمک به پروژهٔ شهر',
    hint: 'از پنل «شهر» به یکی از پروژه‌ها کمک کن.',
    target: 1,
    reward: CARD_REWARD
  }
]

/** پاداش تکمیل هر سه کارت یک روز — یک ساعت کار دیگر. */
const ALL_THREE_BONUS = CARD_REWARD
/** پاداش هفتهٔ بی‌نقص (۲۱ کارت از ۲۱ کارت) — پنج ساعت کار. */
const PERFECT_WEEK_CHEST = CARD_REWARD * 5
const CARDS_PER_DAY = 3
const CARDS_PER_WEEK = CARDS_PER_DAY * 7

/**
 * کلید ردیفِ علامت‌گذاریِ پاداش «هر سه کارت».
 * Unique سه‌گانهٔ (بازیکن، روز، کلید) تضمین می‌کند این پاداش در هر روز
 * فقط یک بار ساخته (و در نتیجه یک بار پرداخت) می‌شود — حتی اگر سه کارت
 * همزمانِ دو دستگاه در یک لحظه تکمیل شوند.
 */
const ALL_THREE_BONUS_KEY = 'ALL_THREE_BONUS'

export interface QuestCardView {
  key: string
  title: string
  hint: string
  progress: number
  target: number
  reward: number
  done: boolean
  claimed: boolean
}

export interface QuestBoard {
  cards: QuestCardView[]
  claimedToday: number
  allThreeClaimed: boolean
  allThreeBonus: number
  weekClaimedCount: number
  weekTarget: number
  chestReady: boolean
  chestClaimed: boolean
  chestAmount: number
}

/**
 * کارت‌های مأموریت روزانه.
 *
 * طراحی:
 *  • انتخاب سه کارت هر روز قطعی است (hash از شناسه + شمارهٔ روز)، پس همهٔ
 *    پنل‌ها و دستگاه‌ها یک چیز نشان می‌دهند و بازیکن نمی‌تواند با reload
 *    کارت آسان‌تر بگیرد.
 *  • پیشرفت با یک `updateMany` شرطی جلو می‌رود و فقط وقتی کارت مربوطه
 *    امروز فعال باشد یک Query می‌خورد — مسیر داغ پیام‌ها سنگین نمی‌شود.
 *  • دریافت پاداش با Unique سه‌گانهٔ (بازیکن، روز، کارت) و شرط
 *    `claimedAt: null` دوباره‌پرداخت را غیرممکن می‌کند.
 */
export class DailyQuestService {
  constructor(
    private readonly db: PrismaClient,
    private readonly eventService: EventService
  ) {}

  /** سه کارت امروز این بازیکن؛ انتخاب قطعی و بدون تصادف واقعی. */
  private todaysBlueprints(playerId: string, day: number): QuestBlueprint[] {
    const pool = [...QUEST_POOL]
    const picked: QuestBlueprint[] = []

    for (let slot = 0; slot < CARDS_PER_DAY && pool.length > 0; slot++) {
      const index = stableHash(`${playerId}:${day}:${slot}`) % pool.length
      picked.push(pool.splice(index, 1)[0]!)
    }

    return picked
  }

  /**
   * تخته‌کارت امروز.
   * ردیف‌های نبودهٔ امروز در همین‌جا ساخته می‌شوند تا trigger بعدی
   * حتماً چیزی برای به‌روزرسانی پیدا کند.
   */
  async getBoard(telegramUserId: bigint): Promise<QuestBoard> {
    const player = await this.db.player.findUnique({
      where: { telegramUserId },
      select: { id: true }
    })
    if (!player) {
      throw new NotFoundError('Player not found')
    }

    const day = dayIndex()
    const blueprints = this.todaysBlueprints(player.id, day)
    await this.ensureRows(player.id, day, blueprints)

    const rows = await this.db.dailyQuest.findMany({
      where: { playerId: player.id, dayIndex: day }
    })
    const byKey = new Map(rows.map((row) => [row.questKey, row]))

    const cards: QuestCardView[] = blueprints.map((bp) => {
      const row = byKey.get(bp.key)
      const progress = Math.min(row?.progress ?? 0, bp.target)
      return {
        key: bp.key,
        title: bp.title,
        hint: bp.hint,
        progress,
        target: bp.target,
        reward: bp.reward,
        done: progress >= bp.target,
        claimed: Boolean(row?.claimedAt)
      }
    })

    const claimedToday = cards.filter((c) => c.claimed).length
    const week = weekIndex()
    const [weekClaimedCount, chest] = await Promise.all([
      this.db.dailyQuest.count({
        where: {
          playerId: player.id,
          claimedAt: { not: null },
          dayIndex: { gte: week * 7, lt: (week + 1) * 7 }
        }
      }),
      this.db.weeklyChest.findUnique({
        where: { playerId_weekIndex: { playerId: player.id, weekIndex: week } }
      })
    ])

    return {
      cards,
      claimedToday,
      allThreeClaimed: claimedToday >= CARDS_PER_DAY,
      allThreeBonus: ALL_THREE_BONUS,
      weekClaimedCount,
      weekTarget: CARDS_PER_WEEK,
      chestReady: weekClaimedCount >= CARDS_PER_WEEK,
      chestClaimed: Boolean(chest),
      chestAmount: PERFECT_WEEK_CHEST
    }
  }

  /** ساخت ردیف‌های امروز؛ تصادم Unique بی‌خطر نادیده گرفته می‌شود. */
  private async ensureRows(
    playerId: string,
    day: number,
    blueprints: QuestBlueprint[]
  ): Promise<void> {
    await this.db.dailyQuest
      .createMany({
        data: blueprints.map((bp) => ({
          playerId,
          dayIndex: day,
          questKey: bp.key,
          target: bp.target,
          progress: 0
        })),
        skipDuplicates: true
      })
      .catch(() => undefined)
  }

  /**
   * ثبت پیشرفت یک فعالیت.
   *
   * هرگز خطا نمی‌دهد و هرگز مسیر اصلی Gameplay را نمی‌شکند: اگر کارت امروز
   * این فعالیت را نخواسته باشد، `updateMany` صفر ردیف می‌زند و تمام.
   */
  async track(playerId: string, trigger: QuestTrigger, amount = 1): Promise<void> {
    const day = dayIndex()
    if (!this.todaysBlueprints(playerId, day).some((bp) => bp.key === trigger)) {
      return
    }

    await this.db.dailyQuest
      .updateMany({
        where: { playerId, dayIndex: day, questKey: trigger, claimedAt: null },
        data: { progress: { increment: amount } }
      })
      .catch(() => undefined)
  }

  /** ثبت پیشرفت با شناسهٔ تلگرام (برای مسیرهایی که فقط شناسهٔ تلگرام دارند). */
  async trackByTelegramId(
    telegramUserId: bigint,
    trigger: QuestTrigger,
    amount = 1
  ): Promise<void> {
    const player = await this.db.player.findUnique({
      where: { telegramUserId },
      select: { id: true }
    })
    if (player) {
      await this.track(player.id, trigger, amount)
    }
  }

  /** دریافت پاداش یک کارت تکمیل‌شده. */
  async claimCard(
    telegramUserId: bigint,
    questKey: string
  ): Promise<{ reward: number; allThreeBonus: number }> {
    const player = await this.db.player.findUnique({
      where: { telegramUserId },
      select: { id: true }
    })
    if (!player) {
      throw new NotFoundError('Player not found')
    }

    const day = dayIndex()
    const blueprint = QUEST_POOL.find((bp) => bp.key === questKey)
    if (!blueprint) {
      throw new NotFoundError('Quest not found', 'این کارت وجود ندارد.')
    }

    const row = await this.db.dailyQuest.findUnique({
      where: {
        playerId_dayIndex_questKey: { playerId: player.id, dayIndex: day, questKey }
      }
    })
    if (!row) {
      throw new NotFoundError(
        'Quest not active',
        'این کارت امروز فعال نیست. «کارت روزانه» را دوباره باز کن و از کارت‌های امروز انتخاب کن.'
      )
    }
    if (row.claimedAt) {
      throw new ConflictError('Already claimed', 'پاداش این کارت را گرفته‌ای.')
    }
    if (row.progress < row.target) {
      throw new ConflictError('Not completed', 'این کارت هنوز کامل نشده است.')
    }

    const paid = await this.db.$transaction(async (tx) => {
      // شرط claimedAt: null دو کلیک همزمان را به یک پرداخت تبدیل می‌کند
      const claimed = await tx.dailyQuest.updateMany({
        where: { id: row.id, claimedAt: null },
        data: { claimedAt: new Date() }
      })
      if (claimed.count !== 1) {
        throw new ConflictError('Concurrent claim', 'پاداش همین حالا ثبت شد.')
      }

      // اگر این سومین کارتِ امروز باشد، بونس روز هم پرداخت می‌شود.
      // پرداختِ بونس خودِ خودش Idempotent است: ردیفِ علامت با Unique سه‌گانه
      // (بازیکن، روز، کلید) فقط یک بار ساخته می‌شود. دو کلیکِ همزمان روی دو
      // کارتِ مختلف هر دو «سومین کارت» را می‌بینند، ولی فقط اولی علامت را
      // می‌سازد و بونس می‌گیرد؛ دومی P2002 می‌خورد و فقط پاداشِ کارت خودش
      // (نه بونس) را می‌گیرد.
      const claimedToday = await tx.dailyQuest.count({
        where: { playerId: player.id, dayIndex: day, claimedAt: { not: null } }
      })
      let bonus = 0
      if (claimedToday >= CARDS_PER_DAY) {
        try {
          await tx.dailyQuest.create({
            data: {
              playerId: player.id,
              dayIndex: day,
              questKey: ALL_THREE_BONUS_KEY,
              target: 1,
              progress: 1
            }
          })
          bonus = ALL_THREE_BONUS
        } catch (error) {
          if (
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === 'P2002'
          ) {
            bonus = 0 // بونس همین حالا توسط درخواستِ موازی پرداخت شد
          } else {
            throw error
          }
        }
      }
      const total = blueprint.reward + bonus

      await tx.player.update({
        where: { id: player.id },
        data: { balance: { increment: total } }
      })
      await tx.financialTransaction.create({
        data: {
          amount: total,
          type: TransactionType.REWARD_PAYOUT,
          destinationPlayerId: player.id,
          reference:
            bonus > 0
              ? `کارت روزانه: ${blueprint.title} + پاداش تکمیل هر سه کارت`
              : `کارت روزانه: ${blueprint.title}`
        }
      })

      return { reward: blueprint.reward, allThreeBonus: bonus }
    })

    // رخدادِ خوراک بیرون از تراکنشِ پرداخت ثبت می‌شود: پول همین‌جا قطعی شده است،
    // پس یک ردیفِ خبری نباید وسطِ تراکنش با کانکسیونی دیگر نوشته شود (و اگر
    // تراکنش برگشت، ردیفِ بازمانده از آن بیرون نماند).
    await this.eventService
      .recordPlayerEvent({
        playerId: player.id,
        type: GameEventType.QUEST_COMPLETED,
        title: `کارت روزانه: ${blueprint.title}`,
        amount: paid.reward + paid.allThreeBonus,
        dedupeKey: `quest:${player.id}:${day}:${questKey}`
      })
      .catch(() => undefined)

    return paid
  }

  /** دریافت صندوق هفتهٔ بی‌نقص. */
  async claimWeeklyChest(telegramUserId: bigint): Promise<{ amount: number }> {
    const player = await this.db.player.findUnique({
      where: { telegramUserId },
      select: { id: true }
    })
    if (!player) {
      throw new NotFoundError('Player not found')
    }

    const week = weekIndex()
    const claimedCount = await this.db.dailyQuest.count({
      where: {
        playerId: player.id,
        claimedAt: { not: null },
        dayIndex: { gte: week * 7, lt: (week + 1) * 7 }
      }
    })
    if (claimedCount < CARDS_PER_WEEK) {
      throw new ConflictError(
        'Week not perfect',
        'صندوق هفته فقط با تکمیل هر ۲۱ کارت هفته باز می‌شود.'
      )
    }

    await this.db.$transaction(async (tx) => {
      try {
        // Unique روی (بازیکن، هفته) تنها ضامن یک‌بار پرداخت است — و چون *داخلِ*
        // همان تراکنشِ پرداخت نوشته می‌شود، شکستِ پرداخت ادعا را نمی‌سوزاند.
        // پیش‌تر این دو نوشتار دو تراکنشِ جدا بودند: اگر پرداخت می‌مرد، صندوق
        // «گرفته‌شده» ثبت می‌ماند و بازیکن هرگز پولش را نمی‌گرفت.
        await tx.weeklyChest.create({
          data: { playerId: player.id, weekIndex: week, amount: PERFECT_WEEK_CHEST }
        })
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          throw new ConflictError('Already claimed', 'صندوق این هفته را گرفته‌ای.')
        }
        throw error
      }

      await tx.player.update({
        where: { id: player.id },
        data: { balance: { increment: PERFECT_WEEK_CHEST } }
      })
      await tx.financialTransaction.create({
        data: {
          amount: PERFECT_WEEK_CHEST,
          type: TransactionType.REWARD_PAYOUT,
          destinationPlayerId: player.id,
          reference: 'صندوق هفتهٔ بی‌نقص کارت‌های روزانه'
        }
      })
    })

    await this.eventService
      .recordPlayerEvent({
        playerId: player.id,
        type: GameEventType.WEEKLY_CHEST,
        title: 'صندوق هفتهٔ بی‌نقص باز شد',
        amount: PERFECT_WEEK_CHEST,
        dedupeKey: `chest:${player.id}:${week}`
      })
      .catch(() => undefined)

    return { amount: PERFECT_WEEK_CHEST }
  }
}

export const QUEST_REWARDS = {
  card: CARD_REWARD,
  allThree: ALL_THREE_BONUS,
  chest: PERFECT_WEEK_CHEST,
  cardsPerDay: CARDS_PER_DAY,
  cardsPerWeek: CARDS_PER_WEEK,
  /** پلهٔ مرجع: یک ساعت کار در ارزان‌ترین شغلِ بازار. */
  hourlyFloorWage: HOURLY_FLOOR_WAGE,
  cheapestShopItem: CHEAPEST_SHOP_ITEM
} as const
