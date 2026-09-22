/**
 * نرخِ سود حساب بانکی — تبدیل نرخ سالانه به نرخ «روز بازی».
 *
 * ── چرا این فایل؟ ────────────────────────────────────────────────────────────
 * پیش از این، ستونِ `BankAccount.interestRateAnnual` در اسکیما با `۰٫۱۵` ساخته
 * می‌شد ولی **هیچ‌جا خوانده نمی‌شد**؛ نرخ واقعی، عددی تکرارشده در سرویس بانک بود
 * (`cycleRate(0.000411)`). یعنی هم یک ستونِ مرده داشتیم و هم یک منبعِ دومِ نرخ که
 * هر لحظه می‌توانست با متنِ پنل («سود سپردهٔ سالانه: ٪۱۵») واگرا شود.
 *
 * حالا عدد از همان ستون می‌آید و این تابع ترجمه می‌کند:
 *
 *   نرخ سالانه ÷ ۳۶۵ روزِ واقعی ÷ ۳۰ روزِ بازی در هر روزِ واقعی
 *   = نرخ در هر «روز بازی»
 *
 * با ٪۱۵: 0.15 ÷ 365 ÷ 30 ≈ 1.37e-5 → روی ۱۰ روزِ واقعی (۳۰۰ روزِ بازی) و
 * یک میلیون تومان، همان ۴٬۱۱۰ تومانِ قبلی درمی‌آید؛ یعنی این تغییر عددی بازی را
 * تغییر نمی‌دهد و فقط منبعش را یکی می‌کند.
 */

import { GAME_MINUTES_PER_REAL_MINUTE } from '../../utils/game-time'

/** روزهای یک سال تقویمی واقعی — پایهٔ تبدیل نرخ سالانه. */
export const REAL_DAYS_PER_YEAR = 365

/** نرخ سودِ پیش‌فرض سالانهٔ حساب جاری (همان `@default(0.15)` اسکیما). */
export const DEFAULT_ACCOUNT_ANNUAL_RATE = 0.15

/** نرخ در هر روزِ بازی از نرخ سالانهٔ حساب. */
export function gameDayRateFromAnnual(annualRate: number): number {
  const safe = Number.isFinite(annualRate) ? Math.max(0, annualRate) : 0
  if (safe <= 0) {
    return 0
  }
  return safe / (REAL_DAYS_PER_YEAR * GAME_MINUTES_PER_REAL_MINUTE)
}

/**
 * نرخ در هر روزِ *واقعی* — برای نمایش به بازیکن (٪ سالانه) و برای آزمون‌ها.
 * یک روز واقعی برابر ۳۰ روز بازی است.
 */
export function realDayRateFromAnnual(annualRate: number): number {
  return gameDayRateFromAnnual(annualRate) * GAME_MINUTES_PER_REAL_MINUTE
}
