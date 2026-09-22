import { GameEventType, Prisma, PrismaClient, TransactionType } from '@prisma/client'
import { NotFoundError } from '../../utils/classes/errors'
import { EventService } from '../events/event.service'
import { employedPlayerFilter } from '../occupation/employment'
import { logger } from '../../utils/logger'

export interface AchievementBlueprint {
  key: string
  icon: string
  title: string
  description: string
  reward: number
}

/**
 * نشان‌ها.
 *
 * همه از دادهٔ واقعیِ موجود ارزیابی می‌شوند؛ هیچ شمارندهٔ جداگانه‌ای نگه
 * داشته نمی‌شود تا امکان ناسازگاری صفر باشد. ترتیب از ساده به سخت است و
 * پاداش‌ها با سختی واقعی تناسب دارند.
 */
export const ACHIEVEMENTS: readonly AchievementBlueprint[] = [
  {
    key: 'first_shift',
    icon: '👷',
    title: 'نخستین نوبت کاری',
    description: 'اولین شیفت کاری‌ات را کامل کردی.',
    reward: 100_000
  },
  {
    key: 'ten_shifts',
    icon: '🔁',
    title: 'کارگر پرتلاش',
    description: 'ده نوبت کاری کامل انجام دادی.',
    reward: 250_000
  },
  {
    key: 'saver',
    icon: '🏦',
    title: 'پس‌اندازکن',
    description: 'موجودی بانکی‌ات از ده میلیون گذشت.',
    reward: 200_000
  },
  {
    key: 'graduate',
    icon: '🎓',
    title: 'دانش‌آموخته',
    description: 'مدرکی بالاتر از دیپلم گرفتی.',
    reward: 200_000
  },
  {
    key: 'homeowner',
    icon: '🏠',
    title: 'خانه‌دار',
    description: 'اولین ملک خودت را خریدی.',
    reward: 300_000
  },
  {
    key: 'landlord',
    icon: '🔑',
    title: 'موجر',
    description: 'ملکت را به بازیکن دیگری اجاره دادی.',
    reward: 300_000
  },
  {
    key: 'employer',
    icon: '🏢',
    title: 'کارفرما',
    description: 'کسب‌وکار فعال خودت را راه انداختی.',
    reward: 400_000
  },
  {
    key: 'trader',
    icon: '🤝',
    title: 'معامله‌گر',
    description: 'در بازار بازیکنان معامله کردی.',
    reward: 150_000
  },
  {
    key: 'patron',
    icon: '🏗️',
    title: 'حامی شهر',
    description: 'بیش از یک میلیون به پروژه‌های شهر کمک کردی.',
    reward: 300_000
  },
  {
    key: 'recruiter',
    icon: '🔗',
    title: 'سفیر بازی',
    description: 'سه بازیکن را با موفقیت معرفی کردی.',
    reward: 500_000
  },
  {
    key: 'traveler',
    icon: '🧭',
    title: 'جهانگرد',
    description: 'مُهر پنج منطقهٔ مختلف را گرفتی.',
    reward: 400_000
  },
  {
    key: 'loyal',
    icon: '🔥',
    title: 'همیشه حاضر',
    description: 'زنجیرهٔ حضور روزانه‌ات به هفت روز رسید.',
    reward: 250_000
  },
  {
    key: 'streak_14',
    icon: '🗓️',
    title: 'دو هفتهٔ پیوسته',
    description: 'چهارده روز پشت سر هم در بازی ماندی.',
    reward: 300_000
  },
  {
    key: 'streak_30',
    icon: '📅',
    title: 'ماه کامل حضوری',
    description: 'سی روز بدون وقفه فعال بودی.',
    reward: 700_000
  },
  {
    key: 'streak_90',
    icon: '🏔️',
    title: 'افسانهٔ استمرار',
    description: 'نود روز پیاپی؛ تعهد تو به این شهر مثال‌زدنی است.',
    reward: 1_500_000
  },
  {
    key: 'mayor',
    icon: '🗳️',
    title: 'شهردار',
    description: 'در انتخابات منطقه‌ات برنده شدی.',
    reward: 500_000
  },
  {
    key: 'wealthy',
    icon: '💎',
    title: 'ثروتمند',
    description: 'خالص دارایی‌ات از صد میلیون گذشت.',
    reward: 700_000
  },
  {
    key: 'debt_free',
    icon: '✅',
    title: 'بی‌بدهی',
    description: 'یک وام را کامل تسویه کردی.',
    reward: 200_000
  }
]

export interface AchievementView extends AchievementBlueprint {
  unlocked: boolean
  grantedAt: Date | null
}

export interface AchievementBoard {
  items: AchievementView[]
  unlockedCount: number
  total: number
  totalReward: number
  newlyUnlocked: AchievementView[]
}

/**
 * موتور نشان‌ها.
 *
 * ارزیابی فقط زمانی اجرا می‌شود که بازیکن پنل نشان‌ها یا شناسنامه را باز کند
 * (Lazy)؛ در مسیر داغ پیام‌های گروه هیچ هزینه‌ای ندارد. پرداخت پاداش با
 * Unique روی (بازیکن، کلید) دقیقاً یک بار انجام می‌شود.
 */
export class AchievementService {
  constructor(
    private readonly db: PrismaClient,
    private readonly eventService: EventService
  ) {}

  /**
   * تخته‌نشان بازیکن + پرداخت خودکار نشان‌های تازه باز شده.
   * `newlyUnlocked` فقط در همین فراخوانی پر است تا UI بتواند جشن بگیرد.
   */
  async getBoard(telegramUserId: bigint): Promise<AchievementBoard> {
    const player = await this.db.player.findUnique({
      where: { telegramUserId },
      select: {
        id: true,
        currentDegree: true,
        streakCount: true,
        balance: true
      }
    })
    if (!player) {
      throw new NotFoundError('Player not found')
    }

    const [granted, earnedKeys] = await Promise.all([
      this.db.achievementGrant.findMany({
        where: { playerId: player.id },
        select: { key: true, grantedAt: true }
      }),
      this.evaluate(player.id, {
        currentDegree: player.currentDegree,
        streakCount: player.streakCount,
        cash: Number(player.balance)
      })
    ])

    const grantedMap = new Map(granted.map((g) => [g.key, g.grantedAt]))
    const newlyUnlocked: AchievementView[] = []

    for (const key of earnedKeys) {
      if (grantedMap.has(key)) continue
      const blueprint = ACHIEVEMENTS.find((a) => a.key === key)
      if (!blueprint) continue

      const paid = await this.grant(player.id, blueprint)
      if (paid) {
        grantedMap.set(key, new Date())
        newlyUnlocked.push({ ...blueprint, unlocked: true, grantedAt: new Date() })
      }
    }

    const items: AchievementView[] = ACHIEVEMENTS.map((bp) => ({
      ...bp,
      unlocked: grantedMap.has(bp.key),
      grantedAt: grantedMap.get(bp.key) ?? null
    }))

    return {
      items,
      unlockedCount: items.filter((i) => i.unlocked).length,
      total: ACHIEVEMENTS.length,
      totalReward: items.filter((i) => i.unlocked).reduce((sum, i) => sum + i.reward, 0),
      newlyUnlocked
    }
  }

  /**
   * پرداخت یک نشان؛ Unique روی (بازیکن، نشان) تنها ضامن یک‌بار پرداخت است.
   *
   * ادعا و پرداخت در *یک* تراکنش‌اند: پیش‌تر ردیفِ نشان بیرون از تراکنشِ پرداخت
   * نوشته می‌شد، پس اگر پرداخت می‌مرد نشان برای همیشه «گرفته‌شده» می‌ماند و پولش
   * هرگز پرداخت نمی‌شد. حالا شکست، ادعا را هم برمی‌گرداند و بازدید بعدیِ
   * تخته‌نشان همان را دوباره (و این‌بار کامل) پرداخت می‌کند.
   */
  private async grant(playerId: string, blueprint: AchievementBlueprint): Promise<boolean> {
    try {
      await this.db.$transaction(async (tx) => {
        await tx.achievementGrant.create({
          data: { playerId, key: blueprint.key, reward: blueprint.reward }
        })
        await tx.player.update({
          where: { id: playerId },
          data: { balance: { increment: blueprint.reward } }
        })
        await tx.financialTransaction.create({
          data: {
            amount: blueprint.reward,
            type: TransactionType.REWARD_PAYOUT,
            destinationPlayerId: playerId,
            reference: `نشان «${blueprint.title}»`
          }
        })
      })
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return false // پیش‌تر پرداخت شده
      }
      // تخته‌نشان نباید به‌خاطر یک نشان باز نشود؛ ولی خطا بی‌صدا هم نمی‌ماند.
      logger.warn(
        { err: error, playerId, achievement: blueprint.key },
        'achievement: grant rolled back, will be retried on the next board load'
      )
      return false
    }

    // پرداخت ثبت شده است؛ سرگذشت، بی‌صدا و پس از تراکنش نوشته می‌شود.
    await this.eventService
      .recordPlayerEvent({
        playerId,
        type: GameEventType.ACHIEVEMENT_UNLOCKED,
        title: `${blueprint.icon} نشان «${blueprint.title}»`,
        detail: blueprint.description,
        amount: blueprint.reward,
        dedupeKey: `ach:${blueprint.key}:${playerId}`
      })
      .catch(() => undefined)

    return true
  }

  /**
   * کلید نشان‌هایی که بازیکن واجد شرایطشان است.
   * تمام شرط‌ها در یک دستهٔ موازی از Aggregate خوانده می‌شوند (بدون N+1).
   */
  private async evaluate(
    playerId: string,
    snapshot: { currentDegree: string; streakCount: number; cash: number }
  ): Promise<string[]> {
    const [
      shiftCount,
      bankAgg,
      propertyCount,
      rentedOutCount,
      businessCount,
      tradeCount,
      donationAgg,
      referralCount,
      stampCount,
      mayorWins,
      paidLoans,
      debtAgg,
      employed
    ] = await Promise.all([
      this.db.workSession.count({ where: { playerId, status: 'COMPLETED' } }),
      this.db.bankAccount.aggregate({ where: { playerId }, _sum: { balance: true } }),
      this.db.property.count({ where: { ownerId: playerId } }),
      this.db.rentalContract.count({
        where: { property: { ownerId: playerId }, isActive: true }
      }),
      this.db.business.count({ where: { ownerId: playerId, status: 'ACTIVE' } }),
      this.db.financialTransaction.count({
        where: {
          type: TransactionType.MARKET_TRADE,
          OR: [{ sourcePlayerId: playerId }, { destinationPlayerId: playerId }]
        }
      }),
      this.db.financialTransaction.aggregate({
        where: { sourcePlayerId: playerId, reference: { startsWith: 'کمک به پروژه' } },
        _sum: { amount: true }
      }),
      this.db.referral.count({
        where: { referrerPlayerId: playerId, rewardedAt: { not: null } }
      }),
      this.db.travelStamp.count({ where: { playerId } }),
      this.db.election.count({ where: { winnerId: playerId } }),
      this.db.loan.count({ where: { playerId, status: 'PAID' } }),
      this.db.loan.aggregate({
        where: { playerId, status: 'ACTIVE' },
        _sum: { remainingAmount: true }
      }),
      this.db.player.count({ where: { id: playerId, ...employedPlayerFilter() } })
    ])

    const bank = Number(bankAgg._sum.balance ?? 0)
    const debt = Number(debtAgg._sum.remainingAmount ?? 0)
    const netWorth = snapshot.cash + bank - debt

    const earned: string[] = []
    const add = (key: string, condition: boolean) => {
      if (condition) earned.push(key)
    }

    add('first_shift', shiftCount >= 1 || employed === 1)
    add('ten_shifts', shiftCount >= 10)
    add('saver', bank >= 10_000_000)
    add('graduate', snapshot.currentDegree !== 'DIPLOMA')
    add('homeowner', propertyCount >= 1)
    add('landlord', rentedOutCount >= 1)
    add('employer', businessCount >= 1)
    add('trader', tradeCount >= 1)
    add('patron', Number(donationAgg._sum.amount ?? 0) >= 1_000_000)
    add('recruiter', referralCount >= 3)
    add('traveler', stampCount >= 5)
    add('loyal', snapshot.streakCount >= 7)
    add('streak_14', snapshot.streakCount >= 14)
    add('streak_30', snapshot.streakCount >= 30)
    add('streak_90', snapshot.streakCount >= 90)
    add('mayor', mayorWins >= 1)
    add('wealthy', netWorth >= 100_000_000)
    add('debt_free', paidLoans >= 1)

    return earned
  }

  /** خط خلاصهٔ نشان‌ها برای شناسنامه (بدون ارزیابی مجدد و بدون پرداخت). */
  async getSummary(playerId: string): Promise<{ count: number; icons: string[] }> {
    const granted = await this.db.achievementGrant.findMany({
      where: { playerId },
      select: { key: true },
      orderBy: { grantedAt: 'desc' },
      take: 5
    })
    const count = await this.db.achievementGrant.count({ where: { playerId } })
    const icons = granted
      .map((g) => ACHIEVEMENTS.find((a) => a.key === g.key)?.icon)
      .filter((icon): icon is string => Boolean(icon))

    return { count, icons }
  }
}
