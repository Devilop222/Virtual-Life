import { PlayerActivityState, PlayerStatus } from '@prisma/client'
import { ConflictError, ValidationError } from '../../utils/classes/errors'
// پیام‌های این فایل به بازیکن نشان داده می‌شوند؛ واحدها باید همان چیزی باشند که
// در پنل‌ها دیده می‌شود («تومان در ساعت بازی»)، نه واحدِ ذخیره‌سازیِ داخلی.
import { ratePerGameHour } from '../../utils/game-time'

/**
 * فعالیت‌هایی که از یک وضعیتِ در جریان هم مجازند.
 *
 * تنها استثنا فعلاً «استراحت در دوران تحصیل» است: دوره‌های تحصیلی بین ۸۰ تا
 * ۲۴۰ دقیقه طول می‌کشند و پیش‌تر در تمام آن مدت بازیکن نه می‌توانست کار کند
 * (که درست است — تحصیل و کار همزمان ممنوع است) و نه استراحت. یعنی کسی که
 * با خستگی بالا ثبت‌نام می‌کرد، ساعت‌ها با همان خستگی می‌ماند و درست بعد از
 * فارغ‌التحصیلی با دستمزدِ کفِ بهره‌وری سر کار می‌رفت. بازیابیِ توان هیچ‌وقت
 * رقیبِ «فعالیت اصلی» نیست، پس همیشه آزاد است.
 */
const ALSO_ALLOWED: Partial<Record<PlayerActivityState, PlayerActivityState[]>> = {
  [PlayerActivityState.STUDYING]: [PlayerActivityState.RESTING]
}

/**
 * دلیلِ بسته‌بودنِ کنشِ بازیکن؛ `null` یعنی آزاد است.
 *
 * چرا یک تابع جدا و نه چند `if` پراکنده؟ قاعدهٔ «فوت‌شده و مسدود نباید کنش
 * کنند» در چند لایه لازم است (وضعیت فعالیت، ورود به بخش، تأیید دومرحله‌ای،
 * جریان‌های ورودیِ متنی) و هر جای تازه‌ای که اضافه می‌شود، یک فرصتِ تازه برای
 * جاافتادنِ نیمی از قاعده است. این اتفاق واقعاً افتاده بود: در دو مسیر فقط
 * `DEAD` سنجیده می‌شد و حسابِ مسدود از همان حفره رد می‌شد.
 *
 * حالا **یک** تابع خالص این قاعده را تعریف می‌کند و همهٔ لایه‌ها از همین
 * می‌پرسند؛ افزودنِ وضعیتِ تازه در آینده فقط همین‌جا انجام می‌شود.
 */
export type PlayerBlockReason = 'dead' | 'banned'

export function playerBlockReason(status: PlayerStatus): PlayerBlockReason | null {
  if (status === PlayerStatus.DEAD) {
    return 'dead'
  }
  if (status === PlayerStatus.BANNED) {
    return 'banned'
  }
  return null
}

/** پیام‌های انسانیِ هر دلیل — یک منبع، تا هر لایه یک جملهٔ متفاوت نسازد. */
export const PLAYER_BLOCK_MESSAGES: Record<PlayerBlockReason, { code: string; text: string }> = {
  dead: { code: 'Player is dead', text: 'شخصیت تو فوت شده است؛ نمی‌تواند فعالیتی انجام دهد.' },
  banned: { code: 'Player is banned', text: 'حساب کاربری‌ات مسدود شده است.' }
}

export class PlayerStateMachine {
  static assertCanStartActivity(
    status: PlayerStatus,
    currentActivity: PlayerActivityState,
    targetActivity: PlayerActivityState
  ): void {
    const blocked = playerBlockReason(status)
    if (blocked) {
      const message = PLAYER_BLOCK_MESSAGES[blocked]
      throw new ConflictError(message.code, message.text)
    }

    if (currentActivity === PlayerActivityState.IDLE || currentActivity === targetActivity) {
      return
    }

    if (ALSO_ALLOWED[currentActivity]?.includes(targetActivity)) {
      return
    }

    const activityLabels: Record<PlayerActivityState, string> = {
      [PlayerActivityState.IDLE]: 'آزاد',
      [PlayerActivityState.WORKING]: 'مشغول به کار',
      [PlayerActivityState.STUDYING]: 'مشغول به تحصیل',
      [PlayerActivityState.RESTING]: 'در حال استراحت',
      [PlayerActivityState.SLEEPING]: 'در خواب',
      [PlayerActivityState.TRAVELING]: 'در سفر'
    }
    throw new ConflictError(
      'Concurrent activity not allowed',
      `الان ${activityLabels[currentActivity]} هستی؛ اول آن را تمام کن بعد فعالیت تازه شروع کن.`
    )
  }

  /**
   * وضعیتی که بازیکن پس از پایانِ یک فعالیتِ موقت به آن برمی‌گردد.
   *
   * استراحت، تحصیل را لغو نمی‌کند: اگر بازیکن هنوز `isEnrolled` باشد، بعد از
   * استراحت دوباره «مشغول به تحصیل» می‌شود، نه «آزاد». وگرنه یک استراحت
   * کوتاه، وضعیتِ تحصیلی را از روی پنل‌ها پاک می‌کرد.
   */
  static activityAfterRest(isEnrolled: boolean): PlayerActivityState {
    return isEnrolled ? PlayerActivityState.STUDYING : PlayerActivityState.IDLE
  }

  static validateSalaryAdjustment(
    currentSalary: number,
    newSalary: number,
    minAllowed = 50,
    maxAllowed = 100_000
  ): void {
    if (!Number.isFinite(newSalary) || newSalary < minAllowed || newSalary > maxAllowed) {
      throw new ValidationError(
        'Invalid salary amount',
        `مبلغ حقوق باید بین ${ratePerGameHour(minAllowed).toLocaleString('fa-IR')} و ${ratePerGameHour(maxAllowed).toLocaleString('fa-IR')} تومان در ساعت بازی باشد.`
      )
    }

    // Maximum 50% decrease or 200% increase per single adjustment for contract stability
    const maxDecrease = currentSalary * 0.5
    const maxIncrease = currentSalary * 3.0
    if (newSalary < maxDecrease || newSalary > maxIncrease) {
      throw new ValidationError(
        'Excessive salary fluctuation',
        'تغییر حقوق در هر نوبت نمی‌تواند بیش از ۳ برابر یا کمتر از نصف حقوق قبلی باشد.'
      )
    }
  }
}