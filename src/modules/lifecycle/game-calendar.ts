/**
 * تقویم زندگی: سن بازیکن با ساعت مرکزی بازی جلو می‌رود.
 *
 * قرارداد دنیا: ۱۲ روز واقعی = ۱ سال بازی (۱ روز بازی = ۴۸ دقیقهٔ واقعی،
 * ۱ سال بازی = ۱۲ ماه بازی). پس یک شخصیت در هر ۱۲ روز واقعی یک سال پیر می‌شود.
 *
 * محاسبه کاملاً Timestamp-based و Lazy است؛ هیچ تایمری وجود ندارد و Restart
 * ربات هرگز سن را نمی‌بُرد و جلو نمی‌اندازد. سن ذخیره‌شده در دیتابیس فقط
 * «سال پایه» است (Backward Compatible) و سن واقعی همیشه از این‌جا می‌آید.
 */

import { config } from '../../config/env'
import {
  GAME_DAYS_PER_YEAR,
  REAL_MS_PER_GAME_YEAR,
  gameDaysToNextBirthday,
  gameDaysSince
} from '../../utils/game-time'

/** تعداد سال‌های بازیِ کاملِ سپری‌شده از یک لحظه. */
export function gameYearsSinceDate(from: Date | null | undefined, now: number = Date.now()): number {
  if (!from) return 0
  const elapsed = Math.max(0, now - from.getTime())
  return Math.floor(elapsed / REAL_MS_PER_GAME_YEAR)
}

/** سن مؤثر بازیکن بر اساس سال‌های بازیِ سپری‌شده از شروع زندگی. */
export function effectiveAge(startedAt: Date | null | undefined, baseAge: number): number {
  if (!startedAt) return baseAge
  const years = gameYearsSinceDate(startedAt)
  const age = baseAge + Math.max(0, years)
  return Math.min(config.GAME_MAX_AGE, age)
}

/**
 * روزهای بازیِ باقی‌مانده تا تولد بعدی (شروع سال تازهٔ زندگی).
 *
 * خروجی همیشه در بازهٔ ۱ تا ۳۶۰ روز بازی است (یک سال کامل بازی).
 */
export function daysToNextBirthday(startedAt: Date | null | undefined): number {
  return gameDaysToNextBirthday(startedAt)
}

/** تعداد سال‌های کامل بازی‌شده. */
export function playedYears(startedAt: Date | null | undefined): number {
  return gameYearsSinceDate(startedAt)
}

/** روزهای بازیِ کاملِ سپری‌شده از شروع زندگی (برای پنل‌های آماری). */
export function playedGameDays(startedAt: Date | null | undefined): number {
  return gameDaysSince(startedAt ?? new Date())
}

/** سقف روزهای یک سال بازی — برای اعتبارسنجی نمایش. */
export const GAME_YEAR_IN_GAME_DAYS = GAME_DAYS_PER_YEAR
