/**
 * گرمای رابطهٔ زوجین — وضعیتِ زندهٔ زندگی مشترک.
 *
 * چرا این ماژول وجود دارد؟ پیش از این ازدواج پس از ثبتِ عقد فقط دو دکمه داشت:
 * «پاداش روزانه» و «طلاق». هیچ وضعیتِ پویایی در کار نبود؛ نه تصمیمی، نه
 * پیامدی، نه دلیلی برای سرزدن. حالا رابطه یک عدد «گرما» دارد که:
 *
 *   • با *بی‌توجهی* فرسایش می‌شود (هر روزِ کامل بدون تعامل، ۱ واحد کم)
 *   • با *پاداش روزانهٔ زوجین* (+۲)، *وقت مشترک* (+۴) و *هدیه* (تا +۸) رشد می‌کند
 *   • مستقیماً روی همان پاداش روزانه اثر می‌گذارد: زندگیِ سرد، پاداش کمتری دارد
 *
 * همهٔ محاسبات اینجا تابع خالص است (بدون دیتابیس) تا قابل تست باشند و
 * سرویس ازدواج فقط «چه چیزی ذخیره شود» را مدیریت کند، نه «چگونه محاسبه شود».
 *
 * اصول توازن (عمداً محافظه‌کارانه):
 *   • زوج تازه‌عقد‌شده دقیقاً همان پاداش قبلی را می‌گیرند (گرما ۱۰۰ = ضریب ۱٫۰).
 *     هیچ جریمه‌ای برای شروع نیست؛ فقط بی‌توجهی طولانی پاداش را کم می‌کند.
 *   • کف گرما ۱۵ است؛ رابطه هرگز «صفر» نمی‌شود و پاداش هرگز کامل قطع نمی‌شود.
 *   • یک زوج فعال با پاداش روزانه (+۲) و گاهی وقت مشترک/هدیه به‌راحتی گرم
 *     می‌ماند؛ فرسایش فقط سراغ زوج‌هایی می‌رود که روزها به خانواده سر نمی‌زنند.
 */

/** بیشترین گرمای ممکن. */
export const WARMTH_MAX = 100

/** کمترین گرما — رابطه هرگز از این سردتر نمی‌شود. */
export const WARMTH_MIN = 15

/** گرمای لحظهٔ عقد. */
import { playtimeDays } from '../../utils/game-time'

export const WARMTH_INITIAL = 100

/** هر روزِ کامل بدون تعاملِ خانواده، این مقدار گرما کم می‌شود. */
export const WARMTH_DECAY_PER_DAY = 1

/** گرمای دریافتی از گرفتن پاداش روزانهٔ زوجین. */
export const BONUS_WARMTH_GAIN = 2

/** گرمای دریافتی از «وقت مشترک». */
export const ACTIVITY_WARMTH_GAIN = 4

/** ضریب پاداش روزانه در گرمای کامل (تازه‌عروس‌ها همین عدد را می‌گیرند). */
export const FULL_WARMTH_MULTIPLIER = 1

/**
 * فرسایش گرمای رابطه از آخرین تعامل.
 *
 * @param stored آخرین مقدار ذخیره‌شده در دیتابیس
 * @param anchorMs آخرین لحظه‌ای که گرما لمس شد (میلی‌ثانیه)
 * @param nowMs اکنون (میلی‌ثانیه)
 */
export function decayedWarmth(stored: number, anchorMs: number, nowMs: number = Date.now()): number {
  const base = clampWarmth(stored)
  // گرمای رابطه با «روز واقعی» فرسوده می‌شود، نه با روز بازی: این یک ریتم
  // بازیکن است (هر روز واقعی یک پله) و اگر روی روز بازی می‌نشست، رابطه‌ها
  // ۳۰ برابر تندتر سرد می‌شدند.
  const elapsedDays = Math.max(0, Math.floor((nowMs - anchorMs) / playtimeDays(1)))
  return Math.max(WARMTH_MIN, base - elapsedDays * WARMTH_DECAY_PER_DAY)
}

/** مهار گرما در بازهٔ مجاز. */
export function clampWarmth(value: number): number {
  const safe = Number.isFinite(value) ? Math.floor(value) : WARMTH_INITIAL
  return Math.max(WARMTH_MIN, Math.min(WARMTH_MAX, safe))
}

/** افزودن گرما با مهار در سقف؛ برای هدیه/فعالیت/پاداش. */
export function gainWarmth(current: number, gain: number): number {
  return clampWarmth(current + Math.max(0, Math.floor(gain)))
}

/**
 * ضریب پاداش روزانهٔ زوجین بر اساس گرما.
 *
 * پله‌ها:
 *   • ۸۰ به بالا → ۱٫۰۰ (زندگی گرم؛ همان پاداش کامل)
 *   • ۶۰ تا ۷۹  → ۰٫۸۰
 *   • ۴۰ تا ۵۹  → ۰٫۶۰
 *   • زیر ۴۰    → ۰٫۵۰
 */
export function coupleBonusMultiplier(warmth: number): number {
  const w = clampWarmth(warmth)
  if (w >= 80) return 1
  if (w >= 60) return 0.8
  if (w >= 40) return 0.6
  return 0.5
}

/** مبلغ واقعی پاداش روزانه با احتساب گرما. */
export function coupleBonusOf(warmth: number, baseAmount: number): number {
  return Math.round(baseAmount * coupleBonusMultiplier(warmth))
}

/** کف هدیه (تومان). */
export const GIFT_MIN = 50_000

/** سقف هدیه (تومان) — محافظ سرریز، نه محدودیت گیم‌پلی. */
export const GIFT_MAX = 100_000_000

/** هر این مقدار تومان هدیه، یک واحد گرما می‌آورد. */
export const GIFT_STEP_AMOUNT = 500_000

/** سقف گرمای یک هدیهٔ واحد؛ هدیهٔ بزرگ رابطه را یک‌شبه نمی‌سازد. */
export const GIFT_MAX_GAIN = 8

/**
 * گرمای هدیه بر اساس مبلغ: هر ۵۰۰ هزار تومان یک واحد، حداقل یک واحد
 * (هر هدیه‌ای نشانهٔ توجه است) و حداکثر ۸ واحد.
 */
export function giftWarmthGain(amount: number): number {
  if (!Number.isFinite(amount) || amount < GIFT_MIN) {
    return 0
  }
  const gain = Math.floor(amount / GIFT_STEP_AMOUNT)
  return Math.max(1, Math.min(GIFT_MAX_GAIN, gain))
}

/** برچسب فارسی وضعیت رابطه برای پنل‌ها. */
export function warmthLabel(warmth: number): string {
  const w = clampWarmth(warmth)
  if (w >= 80) return 'صمیمی'
  if (w >= 60) return 'پایدار'
  if (w >= 40) return 'سرد'
  return 'در آستانهٔ بحران'
}

/** خلاصهٔ عددی قواعد خانواده — برای راهنما و پنل‌ها، از همین منبع حقیقت. */
export const FAMILY_RULES = {
  warmthMax: WARMTH_MAX,
  warmthMin: WARMTH_MIN,
  warmthInitial: WARMTH_INITIAL,
  decayPerDay: WARMTH_DECAY_PER_DAY,
  bonusWarmthGain: BONUS_WARMTH_GAIN,
  activityWarmthGain: ACTIVITY_WARMTH_GAIN,
  giftMin: GIFT_MIN,
  giftMax: GIFT_MAX,
  giftStepAmount: GIFT_STEP_AMOUNT,
  giftMaxGain: GIFT_MAX_GAIN
} as const
