import {
  GameEventType,
  NotificationType,
  PrismaClient,
  TransactionType
} from '@prisma/client'
import { ConflictError, NotFoundError } from '../../utils/classes/errors'
import { money } from '../../utils/format'
import { EventService } from '../events/event.service'
import type { NotificationLevel } from '../notification/push'
import { cycleAmount, dayIndex } from '../../utils/game-time'

export interface StreakResult {
  streak: number
  reward: number
  alreadyClaimedToday: boolean
}

/**
 * پاداش روز پایه؛ از روز هفتم سقف می‌خورد.
 *
 * «روز» این‌جا روز *بازی* است (۴۸ دقیقهٔ واقعی)؛ پس مبلغ‌ها با `cycleAmount`
 * هم‌تراز شده‌اند تا جریان پول روزانه در زمان واقعی ثابت بماند. روزشمار هم
 * از ساعت مرکزی بازی می‌آید — هیچ مرز زمانی محلی در این فایل نیست.
 */
const BASE_REWARD = cycleAmount(50_000)
const STREAK_BONUS_STEP = cycleAmount(25_000)
const MAX_EFFECTIVE_STREAK = 7

/**
 * خلاصهٔ عددیِ استریک — برای راهنما و آزمون توازنِ اقتصاد، از همین منبع حقیقت.
 * مبلغ روز n = `baseReward + bonusStep × min(n, maxEffectiveStreak)`.
 */
export const STREAK_RULES = {
  baseReward: BASE_REWARD,
  bonusStep: STREAK_BONUS_STEP,
  maxEffectiveStreak: MAX_EFFECTIVE_STREAK
} as const

/** پاداش روزِ n از زنجیره (روز اول = ۱). */
export function streakRewardForDay(day: number): number {
  const safe = Math.max(1, Math.floor(day))
  return BASE_REWARD + STREAK_BONUS_STEP * Math.min(safe, MAX_EFFECTIVE_STREAK)
}

/**
 * استریک حضور روزانه.
 *
 * قواعد:
 *  • هر روز یک بار قابل دریافت است (Idempotent با شرط روی lastStreakAt)
 *  • اگر دیروز هم گرفته بودی، زنجیره ادامه پیدا می‌کند؛ وگرنه به ۱ ریست می‌شود
 *  • پاداش = پایه + گام × کمینهٔ(زنجیره، ۷) — همان نرخ قبلی، فقط روی
 *    تقویم بازی؛ بدون ساخت پول بی‌دلیل و متعادل با هزینهٔ زندگی
 */
export class RewardsService {
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

  async claimDailyStreak(telegramUserId: bigint): Promise<StreakResult> {
    const paid = await this.db.$transaction(async (tx) => {
      const player = await tx.player.findUnique({
        where: { telegramUserId },
        select: {
          id: true,
          balance: true,
          streakCount: true,
          lastStreakAt: true,
          firstName: true
        }
      })
      if (!player) {
        throw new NotFoundError('Player not found')
      }

      const today = dayIndex(Date.now())

      if (player.lastStreakAt) {
        const lastDay = dayIndex(player.lastStreakAt.getTime())
        if (lastDay === today) {
          throw new ConflictError(
            'Already claimed',
            'پاداش امروز را گرفته‌ای. فردا دوباره سر بزن! 🔥'
          )
        }
      }

      const yesterday = today - 1
      const continued = player.lastStreakAt && dayIndex(player.lastStreakAt.getTime()) === yesterday

      const streak = continued ? player.streakCount + 1 : 1
      const effective = Math.min(streak, MAX_EFFECTIVE_STREAK)
      const reward = BASE_REWARD + STREAK_BONUS_STEP * effective

      // شرط دوگانه روی lastStreakAt: دو کلیک همزمان فقط یکی را پاس می‌کند
      const claimed = await tx.player.updateMany({
        where: { id: player.id, lastStreakAt: player.lastStreakAt },
        data: {
          streakCount: streak,
          lastStreakAt: new Date(),
          balance: { increment: reward }
        }
      })
      if (claimed.count !== 1) {
        throw new ConflictError('Concurrent claim', 'پاداش همین حالا توسط درخواست دیگری ثبت شد.')
      }

      await tx.financialTransaction.create({
        data: {
          amount: reward,
          type: TransactionType.REWARD_PAYOUT,
          destinationPlayerId: player.id,
          reference: `پاداش حضور روزانه — روز ${streak.toLocaleString('fa-IR')}`
        }
      })

      return { playerId: player.id, streak, reward, today }
    })

    // رخدادِ خوراک بیرون از تراکنشِ پرداخت ثبت می‌شود: پول همین‌جا قطعی شده است،
    // پس یک ردیفِ خبری نباید وسطِ تراکنش با کانکسیونی دیگر نوشته شود (و اگر
    // تراکنش برگشت، ردیفِ بازمانده از آن بیرون نماند).
    await this.eventService
      .recordPlayerEvent({
        playerId: paid.playerId,
        type: GameEventType.STREAK_CLAIMED,
        title: `استریک ${paid.streak.toLocaleString('fa-IR')} روزه`,
        amount: paid.reward,
        dedupeKey: `streak:${paid.playerId}:${paid.today}`
      })
      .catch(() => {})

    return { streak: paid.streak, reward: paid.reward, alreadyClaimedToday: false }
  }

  async getStreakStatus(telegramUserId: bigint) {
    const player = await this.db.player.findUnique({
      where: { telegramUserId },
      select: { streakCount: true, lastStreakAt: true }
    })
    if (!player) {
      throw new NotFoundError('Player not found')
    }

    const today = dayIndex(Date.now())
    const claimedToday = player.lastStreakAt && dayIndex(player.lastStreakAt.getTime()) === today

    let currentStreak = player.streakCount
    if (player.lastStreakAt) {
      const lastDay = dayIndex(player.lastStreakAt.getTime())
      // زنجیرهٔ شکسته نمایش داده نمی‌شود
      if (lastDay < previousDayIndex(today)) currentStreak = 0
    } else {
      currentStreak = 0
    }

    const nextReward =
      BASE_REWARD + STREAK_BONUS_STEP * Math.min(currentStreak + 1, MAX_EFFECTIVE_STREAK)

    return { claimedToday: Boolean(claimedToday), currentStreak, nextReward }
  }

  // ---------- معرفی (Referral) ----------

  /**
   * اتصال یک بازیکن تازه‌ساخته‌شده به معرفش بر اساس کد.
   *
   * این متد بعد از تکمیل ثبت‌نام صدا زده می‌شود، چون تا آن لحظه رکورد
   * بازیکن وجود ندارد. کد در طول ثبت‌نام داخل UserState نگه داشته می‌شود.
   *
   * قواعد ضد سوءاستفاده:
   *   • کد نامعتبر بی‌صدا نادیده گرفته می‌شود (بازیکن جدید نباید خطا ببیند)
   *   • معرفی خود ممنوع است
   *   • هر بازیکن فقط یک بار می‌تواند معرفی شود (Unique روی refereePlayerId)
   */
  async linkReferral(refereePlayerId: string, referrerCode: string): Promise<boolean> {
    const normalized = referrerCode.trim().toUpperCase()
    if (normalized.length === 0) {
      return false
    }

    const referrer = await this.db.player.findFirst({
      where: { referralCode: normalized },
      select: { id: true }
    })
    if (!referrer || referrer.id === refereePlayerId) {
      return false
    }

    try {
      await this.db.referral.create({
        data: { referrerPlayerId: referrer.id, refereePlayerId }
      })
      return true
    } catch {
      // این بازیکن قبلاً معرفی شده است
      return false
    }
  }

  /** کد معرفی پایدار هر بازیکن؛ در اولین نیاز ساخته و ذخیره می‌شود. */
  async getReferralCode(telegramUserId: bigint): Promise<string> {
    const player = await this.db.player.findUnique({
      where: { telegramUserId },
      select: { id: true, referralCode: true }
    })
    if (!player) {
      throw new NotFoundError('Player not found')
    }
    if (player.referralCode) {
      return player.referralCode
    }

    for (let attempt = 0; attempt < 5; attempt++) {
      const code = randomCode()
      try {
        await this.db.player.update({
          where: { id: player.id },
          data: { referralCode: code }
        })
        return code
      } catch {
        // تصادم کد یکتا؛ با کد جدید تلاش می‌کنیم
      }
    }
    throw new ConflictError('Could not generate referral code')
  }

  /**
   * ثبت معرفی پس از تکمیل ثبت‌نام بازیکن جدید.
   * پاداش مرحلهٔ اول: معرف ۳۰۰ هزار، معرفی‌شده ۱۵۰ هزار.
   */
  async settleReferralSignup(refereeTelegramUserId: bigint): Promise<{
    referrerRewarded: boolean
  }> {
    const referee = await this.db.player.findUnique({
      where: { telegramUserId: refereeTelegramUserId },
      select: { id: true }
    })
    if (!referee) return { referrerRewarded: false }

    const referral = await this.db.referral.findUnique({
      where: { refereePlayerId: referee.id }
    })
    if (!referral || referral.rewardedAt) return { referrerRewarded: false }

    const REFERRER_REWARD = 300_000
    const REFEREE_REWARD = 150_000

    const done = await this.db.$transaction(async (tx) => {
      const claimed = await tx.referral.updateMany({
        where: { id: referral.id, rewardedAt: null },
        data: { rewardedAt: new Date() }
      })
      if (claimed.count !== 1) return false

      await tx.player.update({
        where: { id: referral.referrerPlayerId },
        data: { balance: { increment: REFERRER_REWARD } }
      })
      await tx.player.update({
        where: { id: referral.refereePlayerId },
        data: { balance: { increment: REFEREE_REWARD } }
      })

      for (const [pid, amount, role] of [
        [referral.referrerPlayerId, REFERRER_REWARD, 'معرفی بازیکن جدید'],
        [referral.refereePlayerId, REFEREE_REWARD, 'هدیهٔ پیوستن با معرفی']
      ] as const) {
        await tx.financialTransaction.create({
          data: {
            amount,
            type: TransactionType.REWARD_PAYOUT,
            destinationPlayerId: pid,
            reference: `${role} 🤝`
          }
        })
      }
      return true
    })

    if (done) {
      await this.eventService
        .recordPlayerEvent({
          playerId: referral.referrerPlayerId,
          type: GameEventType.PLAYER_REFERRED,
          title: 'یک بازیکن جدید با معرفی تو وارد شد',
          dedupeKey: `referral:${referral.id}`
        })
        .catch(() => {})

      // دو طرف این معرفی پول گرفتند و هیچ‌کدام خبردار نمی‌شدند. برای بازیکن
      // تازه‌وارد این بهترین لحظهٔ ممکن است: می‌فهمد لینکِ دوستش واقعاً ارزش
      // داشته. کلید ضدتکرار از شناسهٔ خودِ ردیف معرفی می‌آید.
      await this.notificationService
        ?.announce({
          playerId: referral.referrerPlayerId,
          type: NotificationType.EVENT,
          level: 'CRITICAL',
          dedupeKey: `referral-reward:${referral.id}`,
          title: '🤝 پاداش معرفی واریز شد',
          message: [
            'یک بازیکن جدید با لینک تو وارد بازی شد.',
            `پاداش تو: ${money(REFERRER_REWARD)} تومان (به کیف پولت واریز شد)`
          ].join('\n')
        })
        .catch(() => undefined)

      await this.notificationService
        ?.announce({
          playerId: referral.refereePlayerId,
          type: NotificationType.EVENT,
          level: 'CRITICAL',
          dedupeKey: `referral-welcome:${referral.id}`,
          title: '🎁 هدیهٔ پیوستن گرفتی',
          message: [
            `چون با معرفی یک دوست وارد شدی، ${money(REFEREE_REWARD)} تومان هدیه گرفتی و به کیف پولت اضافه شد.`,
            'برای شروع: «کارت روزانه» را باز کن — سه کارِ کوچکِ امروز، سه پاداش نقدی.'
          ].join('\n')
        })
        .catch(() => undefined)
    }

    return { referrerRewarded: done }
  }

  /** پاداش مرحلهٔ دوم: وقتی معرفی‌شده اقامت گرفت، به معرف پاداش بزرگ‌تر می‌رسد. */
  async settleReferralResidenceBonus(refereePlayerId: string): Promise<void> {
    const referral = await this.db.referral.findUnique({
      where: { refereePlayerId }
    })
    if (!referral || !referral.rewardedAt || referral.bonusPaidAt) return

    const BONUS = 500_000
    // ادعا و پرداخت در یک تراکنش — دقیقاً مثلِ مرحلهٔ اولِ معرفی در همین فایل.
    // پیش‌تر `bonusPaidAt` بیرون از تراکنشِ پرداخت نوشته می‌شد: اگر پرداخت
    // می‌مرد، پاداش برای همیشه «پرداخت‌شده» علامت می‌ماند و معرف هرگز
    // ۵۰۰٬۰۰۰ تومان را نمی‌گرفت (و شرطِ `bonusPaidAt: null` جلوی تکرار را
    // هم می‌بست).
    const done = await this.db.$transaction(async (tx) => {
      const claimed = await tx.referral.updateMany({
        where: { id: referral.id, bonusPaidAt: null, rewardedAt: { not: null } },
        data: { bonusPaidAt: new Date() }
      })
      if (claimed.count !== 1) return false

      await tx.player.update({
        where: { id: referral.referrerPlayerId },
        data: { balance: { increment: BONUS } }
      })
      await tx.financialTransaction.create({
        data: {
          amount: BONUS,
          type: TransactionType.REWARD_PAYOUT,
          destinationPlayerId: referral.referrerPlayerId,
          reference: 'پاداش اقامت بازیکن معرفی‌شده 🏡'
        }
      })
      return true
    })

    // پنج‌صد هزار تومان به کیف معرف رفت؛ بی‌خبری برای این مبلغ پذیرفتنی نیست
    // (قبلاً نه خبری بود، نه حتی رخدادی در گروه).
    if (done) {
      await this.notificationService
        ?.announce({
          playerId: referral.referrerPlayerId,
          type: NotificationType.EVENT,
          level: 'CRITICAL',
          dedupeKey: `referral-residence:${referral.id}`,
          title: '🏡 پاداش اقامت گرفتی',
          message: [
            'بازیکنی که با معرفی تو وارد شد، اقامت گرفت.',
            `پاداش مرحلهٔ دوم: ${money(BONUS)} تومان (به کیف پولت واریز شد)`
          ].join('\n')
        })
        .catch(() => undefined)
    }
  }

  /**
   * آمار معرفی + کد.
   * کد در همین‌جا تضمین می‌شود تا پنل دعوت هرگز کد خالی نشان ندهد.
   */
  async getReferralStats(telegramUserId: bigint) {
    const player = await this.db.player.findUnique({
      where: { telegramUserId },
      select: { id: true, referralCode: true }
    })
    if (!player) {
      throw new NotFoundError('Player not found')
    }

    const code = player.referralCode ?? (await this.getReferralCode(telegramUserId))

    const [rewarded, pending] = await Promise.all([
      this.db.referral.count({
        where: { referrerPlayerId: player.id, rewardedAt: { not: null } }
      }),
      this.db.referral.count({
        where: { referrerPlayerId: player.id, rewardedAt: null }
      })
    ])

    return { code, invitedCount: rewarded, pendingCount: pending }
  }
}

/** شمارهٔ روز دیروز بر اساس شمارهٔ روز امروز. */
function previousDayIndex(today: number): number {
  return today - 1
}

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

function randomCode(length = 8): string {
  let out = ''
  for (let i = 0; i < length; i++) {
    out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]
  }
  return out
}
