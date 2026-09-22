/**
 * هستهٔ زندگی بازیکن — تنها مرجع همهٔ منحنی‌های «مسیر زندگی».
 *
 * چرا این فایل وجود دارد؟ پیش از این، ضریب سلامت/خستگی دو بار نوشته شده بود
 * (یکی در `income-calculation.service` برای پول واقعی، یکی داخل
 * `computeProductivity` برای عددِ روی پنل) و بقیهٔ عامل‌ها — سابقه، مدرک،
 * رشته و سن — یا در فرمول درآمد نبودند یا فقط روی پنل نمایش داده می‌شدند.
 * نتیجه: عددی که بازیکن می‌دید با عددی که واقعاً دستمزدش را می‌ساخت یکی نبود.
 *
 * حالا هر ضریب یک بار و فقط اینجا تعریف می‌شود و سه مصرف‌کننده از همین‌جا
 * می‌خوانند:
 *   ۱. درآمد کار پاره‌وقت و اضافه‌کاری (`workMultiplier`)
 *   ۲. عدد و برچسب «بهره‌وری» روی شناسنامه/وضعیت (`productivity`)
 *   ۳. پنل‌ها و راهنما (همان دو تابع بالا)
 *
 * اصول توازن (عمداً محافظه‌کارانه):
 *   • بازیکن تازه‌وارد دقیقاً همان درآمد قبلی را می‌گیرد (همهٔ ضریب‌ها ۱.۰).
 *   • سقفِ دست‌یافتنیِ کل ضریب‌ها ۲٫۸۷ است؛ یعنی قوی‌ترین بازیکنِ ممکن کمتر
 *     از ۳ برابرِ یک تازه‌وارد می‌گیرد — در برابر ~۱۱۰ ساعت کارِ مرتبط برای
 *     سقف مهارت، چند میلیون تومان شهریه و چند سال بازی. این «Power Creep» نیست.
 *   • هیچ ضریبی صفر نمی‌شود؛ کف ۰٫۵ برای توان بدنی تا بازی هرگز قفل نشود.
 *   • عددها پله‌ای و قابل‌تست‌اند، نه توابع نمایی که توازنشان با یک تغییر
 *     کوچک به هم می‌ریزد.
 */

import { LifeStage, lifeCycleService } from '../lifecycle/lifecycle.service'
import { EDUCATION_FIELDS, educationRankOf } from '../education/education-blueprints'
import { GAME_MINUTES_PER_REAL_MINUTE } from '../../utils/game-time'

/**
 * رتبهٔ عددی مدرک (۱=دیپلم … ۵=دکتری).
 * تعریف در `education-blueprints` است (مالک دادهٔ مقاطع) و اینجا فقط با
 * امضای هستهٔ زندگی بازصادرات می‌شود تا مصرف‌کننده‌ها یک نقطهٔ ورود داشته باشند.
 */
export { educationRankOf }

// ─────────────────────────────────────────────────────────────────────────────
//  ثابت‌های مشترک
// ─────────────────────────────────────────────────────────────────────────────

/** کمترین سلامت ممکن. کار هرگز بازیکن را «کشته» نمی‌کند؛ فقط ازکار می‌اندازد. */
export const MIN_HEALTH = 1
/** بیشترین خستگی ممکن؛ روی آن دقیقه‌ای مزد ندارد. */
export const MAX_FATIGUE = 100
/** سلامت پایه (بدون عضویت باشگاه). */
export const BASE_HEALTH_CAP = 100

// ─────────────────────────────────────────────────────────────────────────────
//  توان بدنی: سلامت و خستگی
// ─────────────────────────────────────────────────────────────────────────────

/** سلامت را به «درصدِ سقفِ واقعیِ خودِ بازیکن» تبدیل می‌کند. */
export function healthPercent(health: number, maxHealth: number = BASE_HEALTH_CAP): number {
  const cap = Math.max(1, Number.isFinite(maxHealth) ? Math.floor(maxHealth) : BASE_HEALTH_CAP)
  // ورودی نامعتبر «سالم کامل» فرض می‌شود، نه صفر؛ وگرنه یک دادهٔ خراب
  // دستمزد بازیکن را بی‌صدا نصف می‌کرد.
  const safe = Number.isFinite(health) ? health : cap
  const value = Math.max(0, Math.min(cap, Math.floor(safe)))
  return Math.round((value / cap) * 100)
}

/**
 * ضریب سلامت: ۱۰۰٪→۱٫۰، ۵۰٪→۰٫۷۵، ۲۰٪→۰٫۶، ۰٪→۰٫۵.
 *
 * درصدی حساب می‌شود نه مطلق؛ وگرنه عضو باشگاه (سقف ۱۲۰) با سلامت ۱۰۰ از
 * بازیکن عادی با سلامت ۱۰۰ «سالم‌تر» شمرده می‌شد در حالی که او ۸۳٪ توان دارد.
 */
export function healthFactor(health: number, maxHealth: number = BASE_HEALTH_CAP): number {
  const pct = healthPercent(health, maxHealth)
  // شیب‌ها دقیق نوشته شده‌اند (کسری، نه اعشارِ بریده) تا منحنی در مرزِ هر
  // بازه پرش نکند؛ با 0.00833 بریده، ضریب در ۸۰٪ یک جهشِ کوچک داشت.
  if (pct >= 80) return 1
  if (pct >= 50) return 0.75 + ((pct - 50) * 0.25) / 30
  if (pct >= 20) return 0.6 + (pct - 20) * 0.005
  return 0.5 + pct * 0.005
}

/** ضریب خستگی: ۰→۱٫۰، ۲۰→۱٫۰، ۶۰→۰٫۷۵، ۹۰→۰٫۵۵، ۱۰۰→۰٫۵ */
export function fatigueFactor(fatigue: number): number {
  const safe = Number.isFinite(fatigue) ? fatigue : 0
  const f = Math.max(0, Math.min(MAX_FATIGUE, Math.floor(safe)))
  if (f <= 20) return 1
  if (f <= 60) return 1 - (f - 20) * 0.00625
  if (f <= 90) return 0.75 - ((f - 60) * 0.2) / 30
  return 0.55 - (f - 90) * 0.005
}

/** کف ضریب توان بدنی — کار حتی در بدترین حالت هم بی‌معنا نمی‌شود. */
export const MIN_CONDITION_FACTOR = 0.5

/** ضریب ترکیبی توان بدنی (سلامت × خستگی) با کف ۰٫۵. */
export function conditionFactor(
  health: number,
  fatigue: number,
  maxHealth: number = BASE_HEALTH_CAP
): number {
  const raw = healthFactor(health, maxHealth) * fatigueFactor(fatigue)
  return Math.max(MIN_CONDITION_FACTOR, Math.min(1, raw))
}

/** آیا بازیکن از نظر توان بدنی اجازهٔ کار/اضافه‌کاری دارد؟ */
/** کمترین سلامتِ مجاز برای شروع کار و اضافه‌کاری. */
export const MIN_WORK_HEALTH = 11

export function canWorkWithBody(health: number, fatigue: number): boolean {
  const h = Number.isFinite(health) ? health : BASE_HEALTH_CAP
  const f = Number.isFinite(fatigue) ? fatigue : 0
  return h >= MIN_WORK_HEALTH && f < MAX_FATIGUE
}

/**
 * ظرفیت بدنیِ یک شیفت: از این شیفت چند دقیقهٔ بازی واقعاً کار درمی‌آید؟
 *
 * چرا یک تابع مشترک؟ چون همین قاعده دو مصرف‌کننده دارد — تسویهٔ شیفت (که
 * پول را می‌سازد) و چرخهٔ خودکار (که می‌پرسد «این شیفت باید تمام شود؟»).
 * اگر هر کدام فرمول خودش را داشته باشد، لحظه‌ای که تسویه یک عدد می‌دهد و
 * چرخهٔ خودکار عدد دیگری می‌بیند، بازیکن یا پول از دست می‌دهد یا شیفتش
 * بی‌دلیل بسته می‌شود.
 *
 * قاعده: با خستگی `f` و نرخ `r` (نقطهٔ خستگی در هر دقیقهٔ بازی)، حداکثر
 * `(MAX_FATIGUE − f) / r` دقیقهٔ بازی مزد دارد؛ فراتر از آن بدن کار نمی‌کند
 * و ادامهٔ شیفت فقط زمان تلف می‌کند.
 *
 * ورودی `elapsedGameMinutes` است، نه واقعی: نرخ و مدت باید هم‌واحد باشند
 * (هر دو دقیقهٔ بازی) وگرنه ضریب ۳۰ بی‌صدا وارد محاسبه می‌شود.
 */
export function payableShiftMinutes(input: {
  elapsedGameMinutes: number
  fatigue: number
  fatiguePerGameMinute: number
}): { payableMinutes: number; bodyCapacityReached: boolean } {
  const elapsed = Math.max(
    0,
    Number.isFinite(input.elapsedGameMinutes) ? input.elapsedGameMinutes : 0
  )
  const rate = input.fatiguePerGameMinute
  if (!Number.isFinite(rate) || rate <= 0) {
    // شغلی که خستگی نمی‌سازد، سقف بدنی هم ندارد.
    return { payableMinutes: elapsed, bodyCapacityReached: false }
  }
  const fatigue = Math.max(
    0,
    Math.min(MAX_FATIGUE, Number.isFinite(input.fatigue) ? input.fatigue : 0)
  )
  const payableMinutes = Math.min(elapsed, (MAX_FATIGUE - fatigue) / rate)
  // یک دقیقهٔ بازی رواداری تا گردکردن، شیفتِ سالم را زودتر از موعد نبندد.
  return { payableMinutes, bodyCapacityReached: elapsed - payableMinutes > 1 }
}

/**
 * نقطه‌های خستگیِ یک کار، از مدتِ بازی و نرخِ «در دقیقهٔ واقعی».
 *
 * تنها جایی که نرخِ خستگی به نقطهٔ خستگی تبدیل می‌شود. تسویهٔ شیفت و چرخهٔ
 * خودکار هر دو از همین می‌خوانند تا «چقدر خسته شدی» و «آیا باید بایستی؟»
 * هرگز دو جواب ندهند.
 */
export function fatiguePointsFor(gameMinutes: number, fatiguePerRealMinute: number): number {
  const minutes = Math.max(0, Number.isFinite(gameMinutes) ? gameMinutes : 0)
  const perGameMinute =
    Number.isFinite(fatiguePerRealMinute) && fatiguePerRealMinute > 0
      ? fatiguePerRealMinute / GAME_MINUTES_PER_REAL_MINUTE
      : 0
  return Math.min(MAX_FATIGUE, Math.round(perGameMinute * minutes))
}

// ─────────────────────────────────────────────────────────────────────────────
//  مهارت و سابقه
// ─────────────────────────────────────────────────────────────────────────────

/** سقف سطح مهارت — همان عددی که ریپازیتوری مهارت هم رعایت می‌کند. */
export const MAX_SKILL_LEVEL = 10
/** هر سطح مهارتِ مرتبط تا این مقدار به دستمزد می‌افزاید. */
const SKILL_STEP = 0.1

/** ضریب مهارت: سطح ۱→۱٫۰ … سطح ۱۰→۱٫۹ (بی‌مهارتی جریمه ندارد). */
export function skillFactor(skillLevelAverage: number | null | undefined): number {
  if (skillLevelAverage === null || skillLevelAverage === undefined || !Number.isFinite(skillLevelAverage)) {
    return 1
  }
  const level = Math.max(1, Math.min(MAX_SKILL_LEVEL, skillLevelAverage))
  return 1 + (level - 1) * SKILL_STEP
}

/**
 * پله‌های سابقه — دقیقاً همان پله‌هایی که برچسب تجربه نشان می‌دهد.
 *
 * پیش‌تر ضریب سابقه در ۱۰۰ امتیاز اشباع می‌شد (کمتر از سه شیفت کاری!) و بعد
 * از آن «تجربه» فقط یک عدد روی پنل بود. حالا climbs تا همان ۱۰۰۰ امتیازی که
 * برچسب «استاد» می‌گیرد، اما سقفش همان ۱٫۲۰ قبلی است؛ یعنی تورم نداریم،
 * فقط مسیر طولانی‌تر و معنادارتر شده.
 */
const EXPERIENCE_STEPS: readonly { min: number; factor: number }[] = [
  { min: 1_000, factor: 1.2 },
  { min: 400, factor: 1.16 },
  { min: 150, factor: 1.12 },
  { min: 50, factor: 1.08 },
  { min: 10, factor: 1.04 },
  { min: 0, factor: 1 }
]

/** سقف ضریب سابقه. */
export const MAX_EXPERIENCE_FACTOR = 1.2

/** ضریب سابقه: پله‌ای با درون‌یابی خطی بین پله‌ها؛ از ۱۰۰۰ امتیاز به بعد ثابت. */
export function experienceFactor(experience: number): number {
  const exp = Number.isFinite(experience) ? Math.max(0, experience) : 0
  const ladder = [...EXPERIENCE_STEPS].reverse() // صعودی: 0, 10, 50, 150, 400, 1000

  if (exp >= ladder[ladder.length - 1]!.min) {
    return ladder[ladder.length - 1]!.factor
  }

  for (let i = 0; i < ladder.length - 1; i += 1) {
    const lower = ladder[i]!
    const upper = ladder[i + 1]!
    if (exp >= lower.min && exp < upper.min) {
      const span = upper.min - lower.min
      const ratio = span > 0 ? (exp - lower.min) / span : 0
      return lower.factor + (upper.factor - lower.factor) * ratio
    }
  }
  return 1
}

// ─────────────────────────────────────────────────────────────────────────────
//  تحصیل: مدرک + رشته
// ─────────────────────────────────────────────────────────────────────────────

/** هر پلهٔ مدرک تا این مقدار به دستمزد می‌افزاید. */
const DEGREE_STEP = 0.05
/** پاداش کار در حوزهٔ رشتهٔ تحصیلی. */
const FIELD_MATCH_BONUS = 0.06
/** سقف سخت ضریب تحصیل — هیچ ترکیبی از آن عبور نمی‌کند. */
export const MAX_EDUCATION_FACTOR = 1.3

/**
 * دسته‌های شغلیِ هم‌حوزه با رشتهٔ تحصیلی.
 *
 * داده در `education-blueprints` است (مالک دادهٔ رشته‌ها) و اینجا فقط خوانده
 * می‌شود تا «رشته» از یک برچسب نمایشی به یک انتخابِ دارای پیامد تبدیل شود:
 * پزشک در درمانگاه بهتر از یک لیسانسِ بی‌ربط دستمزد می‌گیرد، اما در رستوران نه.
 */
export function fieldAffinityCategories(graduationField: string | null | undefined): readonly string[] {
  if (!graduationField) return []
  const field = EDUCATION_FIELDS.find((f) => f.title === graduationField || f.key === graduationField)
  return field?.affinityCategories ?? []
}

/** آیا این دستهٔ شغلی با رشتهٔ تحصیلی بازیکن هم‌حوزه است؟ */
export function fieldMatchesCategory(
  graduationField: string | null | undefined,
  jobCategory: string | null | undefined
): boolean {
  if (!graduationField || !jobCategory) return false
  return fieldAffinityCategories(graduationField).includes(jobCategory)
}

/**
 * ضریب تحصیل = مدرک + هم‌حوزه بودن رشته، با سقف سخت ۱٫۳۰.
 *
 * دیپلمِ بدون رشته دقیقاً ۱٫۰۰ می‌گیرد (تازه‌وارد هیچ جریمه‌ای نمی‌بیند) و
 * دکتریِ هم‌حوزه ۱٫۲۶ — یعنی گران‌ترین مسیر تحصیلی بالاخره ارزش دارد، اما
 * نه آن‌قدر که مدرک جای مهارت و سابقه را بگیرد.
 */
export function educationFactor(
  educationRank: number,
  fieldMatched = false
): number {
  const rank = Math.max(1, Math.min(5, Math.floor(educationRank)))
  const raw = 1 + (rank - 1) * DEGREE_STEP + (fieldMatched ? FIELD_MATCH_BONUS : 0)
  return Math.min(MAX_EDUCATION_FACTOR, raw)
}

// ─────────────────────────────────────────────────────────────────────────────
//  سن و مرحلهٔ زندگی
// ─────────────────────────────────────────────────────────────────────────────

/** کف ضریب سن — سال‌خوردگی هرگز بازیکن را از دور خارج نمی‌کند. */
export const MIN_AGE_FACTOR = 0.9

/**
 * ضریب سن: ملایم و بدون هیچ قاعدهٔ پزشکی/حقوقیِ ساختگی.
 *
 * فقط یک واقعیت سادهٔ شغلی: اوج توان کاری در جوانی و میانسالی است و بعد از
 * آن کمی کمتر. عمداً کوچک نگه داشته شده (حداقل ۰٫۹۰) تا بازیکنِ قدیمی که
 * سال‌ها وقت گذاشته احساس تنبیه نکند؛ اثر اصلی سن همچنان «باز شدن درِ
 * شغل‌ها» و «مرحلهٔ زندگی» است.
 */
export function ageFactor(age: number): number {
  const years = Number.isFinite(age) ? Math.max(0, Math.floor(age)) : 0
  if (years < 18) return 0.92
  if (years < 50) return 1
  if (years < 65) return 0.97
  return MIN_AGE_FACTOR
}

/** مرحلهٔ زندگی از سن مؤثر — تنها مرجع این نگاشت. */
export function lifeStageFor(age: number): LifeStage {
  return lifeCycleService.getLifeStage(Math.max(0, Math.floor(age)))
}

// ─────────────────────────────────────────────────────────────────────────────
//  ضریب نهایی کار و بهره‌وری
// ─────────────────────────────────────────────────────────────────────────────

export interface WorkMultiplierInput {
  /** سلامت فعلی. */
  health: number
  /** خستگی فعلی. */
  fatigue: number
  /** سقف واقعی سلامت (عضو باشگاه ۱۲۰). */
  maxHealth?: number
  /** میانگین سطح مهارت‌های مرتبط با شغل؛ نبود مهارت = سطح ۱. */
  skillLevelAverage?: number | null
  /** سابقهٔ کاری بازیکن. */
  experience?: number
  /** رتبهٔ مدرک (۱..۵). */
  educationRank?: number
  /** نام رشتهٔ فارغ‌التحصیلی (برای هم‌حوزه بودن با دستهٔ شغل). */
  graduationField?: string | null
  /** دستهٔ شغلی که قرار است انجام شود. */
  jobCategory?: string | null
  /** سن مؤثر بازیکن بر اساس تقویم بازی. */
  age?: number
}

export interface WorkMultiplierBreakdown {
  condition: number
  skill: number
  experience: number
  education: number
  age: number
  fieldMatched: boolean
  /** حاصل‌ضرب همهٔ ضریب‌ها — تنها عددی که واقعاً در دستمزد ضرب می‌شود. */
  total: number
}

/**
 * سقف *دست‌یافتنی* ضریب کار: مهارت ۱۰ + سابقهٔ کامل + دکتریِ هم‌حوزه +
 * توان بدنی کامل.
 *
 * عمداً از `MAX_EDUCATION_FACTOR` ساخته نشده: سقفِ سختِ ضریب تحصیل ۱٫۳۰ است
 * ولی بالاترین مقدارِ واقعیِ آن ۱٫۲۶ (دکتری + رشتهٔ هم‌حوزه) است. اگر سقفِ
 * مقیاسِ بهره‌وری روی عددِ دست‌نیافتنی بسته می‌شد، «۱۰۰» هرگز دیده نمی‌شد.
 */
export const MAX_WORK_MULTIPLIER =
  skillFactor(MAX_SKILL_LEVEL) * MAX_EXPERIENCE_FACTOR * educationFactor(5, true)

/**
 * تجزیهٔ کامل ضریب دستمزد — همان چیزی که هم درآمد از آن ساخته می‌شود و هم
 * عدد «بهره‌وری» روی پنل. تفکیک‌شده برگردانده می‌شود تا پنل بتواند بگوید
 * «کدام عامل الان پایین است» بدون اینکه فرمول را دوباره بنویسد.
 */
export function workMultiplier(input: WorkMultiplierInput): WorkMultiplierBreakdown {
  const condition = conditionFactor(input.health, input.fatigue, input.maxHealth)
  const skill = skillFactor(input.skillLevelAverage)
  const experience = experienceFactor(input.experience ?? 0)
  const fieldMatched = fieldMatchesCategory(input.graduationField, input.jobCategory)
  const education = educationFactor(input.educationRank ?? 1, fieldMatched)
  const age = ageFactor(input.age ?? 18)

  return {
    condition,
    skill,
    experience,
    education,
    age,
    fieldMatched,
    total: condition * skill * experience * education * age
  }
}

/** کمترین ضریب ممکنِ کار (توان بدنی در کف، بقیهٔ عامل‌ها ۱). */
export const MIN_WORK_MULTIPLIER = MIN_CONDITION_FACTOR

export interface ProductivityView {
  score: number
  label: string
  /** ضریب واقعی پشت این عدد — برای پنل‌هایی که می‌خواهند صادق باشند. */
  multiplier: number
}

/**
 * بهره‌وری = خودِ ضریب دستمزد، فقط روی مقیاس ۰ تا ۱۰۰.
 *
 * دو تکهٔ خطی و پیوسته:
 *   ضریب ۱٫۰۰ (تازه‌واردِ سالم) → ۴۰ «متوسط»
 *   ضریب `MAX_WORK_MULTIPLIER` (~۲٫۸۷، سقف ممکن) → ۱۰۰ «عالی»
 *   ضریب ۰٫۵۰ (توان بدنی در کف) → ۱۰ «بحرانی»
 *
 * چون مستقیماً از `workMultiplier` می‌آید، عددِ روی پنل هرگز نمی‌تواند با
 * دستمزدِ واقعی واگرا شود — همان چیزی که پیش‌تر دو فرمولِ جدا بودند.
 */
export function productivity(multiplier: number): ProductivityView {
  const m = Number.isFinite(multiplier) ? multiplier : 1
  const score =
    m >= 1
      ? 40 + (60 * (m - 1)) / (MAX_WORK_MULTIPLIER - 1)
      : 40 * ((m - MIN_WORK_MULTIPLIER) / (1 - MIN_WORK_MULTIPLIER))

  const rounded = Math.max(10, Math.min(100, Math.round(score)))
  return { score: rounded, label: productivityLabel(rounded), multiplier: m }
}

/** برچسب فارسی بهره‌وری. */
export function productivityLabel(score: number): string {
  if (score >= 80) return 'عالی'
  if (score >= 60) return 'خوب'
  if (score >= 40) return 'متوسط'
  if (score >= 25) return 'پایین'
  return 'بحرانی'
}

/** بهره‌وری مستقیم از ورودی‌های زندگی (میان‌بر مصرف‌کننده‌ها). */
export function productivityOf(input: WorkMultiplierInput): ProductivityView {
  return productivity(workMultiplier(input).total)
}

/**
 * توصیف کوتاه و انسانیِ «چرا بهره‌وری این عدد است».
 *
 * فقط عامل‌هایی که واقعاً پایین‌اند گفته می‌شوند؛ وگرنه پنل پر از توضیح
 * بی‌ربط می‌شد. متن کاملاً فارسی و بدون اصطلاح فنی است.
 */
export function productivityHint(breakdown: WorkMultiplierBreakdown): string | null {
  const reasons: string[] = []
  if (breakdown.condition < 0.95) {
    reasons.push('توان بدنی')
  }
  if (breakdown.skill < 1.1) {
    reasons.push('مهارت کم در این کار')
  }
  if (breakdown.experience < 1.08) {
    reasons.push('سابقهٔ کم')
  }
  if (breakdown.education < 1.05) {
    reasons.push('مدرک پایه')
  }
  if (reasons.length === 0) {
    return null
  }
  return `با تقویت ${reasons.join('، ')} بهره‌وری بالاتر می‌رود.`
}
