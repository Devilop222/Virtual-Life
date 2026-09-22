/**
 * تمرینِ فعال مهارت — مسیر رشدِ انتخابی.
 *
 * پیش از این مهارت فقط از دو راه رشد می‌کرد: کارِ مرتبط (غیرفعال و کند) و
 * فارغ‌التحصیلی (یک‌باره و بسته به رشته). هیچ‌وقت بازیکن «تصمیم» نمی‌گرفت که
 * پول و انرژی‌اش را صرفِ رشدِ یک مهارت کند. حالا یک راه سوم هست:
 *
 *   پول + خستگی  →  امتیاز تمرین  →  سطح مهارت
 *
 * و چون مهارت در `workMultiplier` (ضریب دستمزد) و بهره‌وری کارمندان مصرف
 * می‌شود، این یک سرمایه‌گذاری واقعی با بازگشت است — نه یک عدد تزئینی.
 *
 * توازن (عمداً محافظه‌کارانه):
 *   • هر جلسه تمرین ۱۲ امتیاز می‌دهد؛ هر ۵۰ امتیاز یک سطح است. پس هر سطح
 *     ~۴ جلسه می‌خواهد. سقف مهارت ۱۰ است، یعنی از صفر تا سقف ~۳۶ جلسه.
 *   • هزینه با سطحِ هدف زیاد می‌شود: هرچه ماهرتر، رشد گران‌تر.
 *   • روزی بیش از چند جلسه ممکن نیست (خستگی سرمایهٔ محدود است) و هزینهٔ
 *     جلسه‌های پشت‌سرهم در یک روز هم بالا می‌رود تا «پول‌پاشیِ یک‌شبه» بهینه نباشد.
 *
 * همهٔ محاسبات اینجا تابع خالص است تا قابل تست باشد.
 */

import { SKILL_POINTS_PER_LEVEL, SKILL_MAX_LEVEL } from '../../database/repositories/player-skill.repository'

export { SKILL_POINTS_PER_LEVEL, SKILL_MAX_LEVEL }

/** امتیازی که یک جلسه تمرین فعال می‌دهد. */
export const TRAINING_POINTS_PER_SESSION = 12

/** خستگیِ هر جلسه تمرین — تمرین انرژی می‌گیرد و با کار رقابت می‌کند. */
export const TRAINING_FATIGUE = 8

/** بیشترین جلسهٔ تمرین در یک روز (محدودیت انرژی، نه محدودیت مصنوعی). */
export const MAX_TRAINING_SESSIONS_PER_DAY = 4

/** هزینهٔ پایهٔ جلسهٔ اول (تومان). */
export const TRAINING_BASE_COST = 250_000

/**
 * هزینهٔ یک جلسه تمرین برای رسیدن به سطحِ بعد.
 *
 * با سطحِ فعلی زیاد می‌شود (رشدِ مهارتِ بالا گران است) و با تعداد جلسه‌های
 * همان روز هم زیاد می‌شود (شتاب‌زدن در یک روز پرهزینه است).
 */
export function trainingSessionCost(currentLevel: number, sessionsToday: number): number {
  const level = Math.max(1, Math.min(SKILL_MAX_LEVEL, Math.floor(currentLevel)))
  // هر سطح بالاتر، ۱۵٪ گران‌تر
  const levelFactor = 1 + (level - 1) * 0.15
  // جلسهٔ دوم به‌بعدِ همان روز، هر کدام ۳۵٪ گران‌تر
  const sameDayFactor = 1 + Math.max(0, sessionsToday) * 0.35
  return Math.round((TRAINING_BASE_COST * levelFactor * sameDayFactor) / 10_000) * 10_000
}

/**
 * نتیجهٔ اعمال امتیاز تمرین روی یک مهارت.
 *
 * قانون «سطح هرگز پایین نمی‌آید» اینجا هم رعایت می‌شود: سطحِ جدید، بیشینهٔ
 * «سطح فعلی» و «سطح محاسبه‌شده از کل امتیازها» است. پس بازیکنی که سطحش را
 * از تحصیل گرفته، با تمرین امتیاز جمع می‌کند بدون اینکه سطحش کم شود.
 */
export function applyTrainingPoints(
  currentLevel: number,
  currentPoints: number,
  gained: number = TRAINING_POINTS_PER_SESSION
): { level: number; points: number; leveledUp: boolean } {
  const points = Math.max(0, currentPoints) + Math.max(0, gained)
  const levelFromPoints = Math.min(
    SKILL_MAX_LEVEL,
    1 + Math.floor(points / SKILL_POINTS_PER_LEVEL)
  )
  const level = Math.max(Math.floor(currentLevel), levelFromPoints)
  return { level, points, leveledUp: level > Math.floor(currentLevel) }
}

/** آیا این مهارت دیگر با تمرین رشد نمی‌کند (سقف)؟ */
export function isMaxLevel(level: number): boolean {
  return Math.floor(level) >= SKILL_MAX_LEVEL
}

/** امتیاز لازم تا سطح بعدی از مجموع امتیاز فعلی. */
export function pointsToNextLevel(currentPoints: number): number {
  const points = Math.max(0, currentPoints)
  const withinLevel = points % SKILL_POINTS_PER_LEVEL
  return SKILL_POINTS_PER_LEVEL - withinLevel
}

/**
 * آیا بازیکن امروز هنوز جای تمرین دارد؟
 */
export function canTrainToday(sessionsToday: number): boolean {
  return sessionsToday < MAX_TRAINING_SESSIONS_PER_DAY
}

/** خلاصهٔ قواعد تمرین برای راهنما و پنل‌ها. */
export const TRAINING_RULES = {
  pointsPerSession: TRAINING_POINTS_PER_SESSION,
  fatiguePerSession: TRAINING_FATIGUE,
  maxSessionsPerDay: MAX_TRAINING_SESSIONS_PER_DAY,
  baseCost: TRAINING_BASE_COST,
  pointsPerLevel: SKILL_POINTS_PER_LEVEL,
  maxLevel: SKILL_MAX_LEVEL
} as const
