/**
 * تنظیمات مرکزی منطقه و اقامت.
 * هیچ عدد آستانه‌ای در Handlerها یا Serviceهای دیگر Hard-Code نمی‌شود.
 *
 * محاسبهٔ زمان فقط با ساعت مرکزی بازی (`utils/game-time`) انجام می‌شود؛
 * این‌جا فقط «چند روز/ساعت بازی» تعیین می‌شود.
 */

import { gameDays } from '../utils/game-time'

export const REGION_CONFIG = {
  /** آستانهٔ جمعیت بازی (شهروندانِ دارای عضویت فعال) برای تعیین سطح منطقه. */
  populationThresholds: {
    village: { min: 0, max: 14 },
    city: { min: 15, max: 30 },
    province: { min: 31, max: 50 },
    country: { min: 51, max: null as number | null }
  },

  // نرخ مالیات در `config/economy.ts` (بخش TAX_RATES) است؛ اینجا فقط
  // تنظیمات آماری منطقه می‌ماند تا دو منبع برای نرخ مالیات نداشته باشیم.

  /** ضریب هموارسازی شاخص اقتصادی (۰ تا ۱). */
  economicSmoothing: 0.3,

  /** مدت اعتبار آمار تجمیعی منطقه. */
  statTtlMs: 5 * 60 * 1000
} as const

export const RESIDENCE_CONFIG = {
  /** فاصلهٔ لازم بین دو مهاجرت: ۳ روز بازی (۲٫۴ ساعت واقعی). */
  migrationCooldownMs: gameDays(3),

  /** هزینهٔ پایهٔ مهاجرت. */
  migrationBaseCost: 2_000_000,

  /** ضریب هزینهٔ مهاجرت بر اساس سطح منطقهٔ مقصد. */
  migrationLevelMultiplier: {
    VILLAGE: 1,
    CITY: 1.5,
    PROVINCE: 2,
    COUNTRY: 3
  } as Record<string, number>,

  /** حداکثر فاصلهٔ زمانی که «حضور موقت» در منطقه معتبر می‌ماند: ۷ روز بازی (۵٫۶ ساعت واقعی). */
  travelPresenceTtlMs: gameDays(7)
} as const

/** هزینهٔ نهایی مهاجرت به یک سطح منطقه. */
export function migrationCostFor(environmentLevel: string): number {
  const multiplier = RESIDENCE_CONFIG.migrationLevelMultiplier[environmentLevel] ?? 1
  return Math.round(RESIDENCE_CONFIG.migrationBaseCost * multiplier)
}
