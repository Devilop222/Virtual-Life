/**
 * محاسبهٔ درآمد کار.
 *
 * ⚠️ این فایل دیگر فرمول نمی‌نویسد — فقط ورودی‌های یک شغل را به
 * `modules/life/life-core` می‌دهد و نتیجه را برای مصرف‌کننده‌ها مرتب می‌کند.
 * هر ضریب (سلامت، خستگی، مهارت، سابقه، مدرک، رشته، سن) یک بار و فقط در
 * `life-core` تعریف شده است؛ همان ضریب‌ها عدد «بهره‌وری» روی شناسنامه را هم
 * می‌سازند، پس نمایش و واقعیت نمی‌توانند از هم واگرا شوند.
 *
 * `healthFactor` و `fatigueFactor` از همان‌جا بازصادرات می‌شوند تا
 * مصرف‌کننده‌های قدیمی (پنل‌ها و تست‌ها) نشکنند.
 */

import {
  healthFactor,
  fatigueFactor,
  conditionFactor,
  productivity,
  workMultiplier,
  fatiguePointsFor,
  type WorkMultiplierBreakdown
} from '../life/life-core'
import { ratePerGameMinute } from '../../utils/game-time'

export { healthFactor, fatigueFactor, conditionFactor }

export interface IncomeCalculationParams {
  /** دستمزد پایهٔ شغل به تومان در *دقیقهٔ واقعی* (واحد ذخیره‌شده در دیتابیس). */
  basePayPerMinute: number
  difficulty: number
  skillLevelAverage?: number | null
  playerExperience?: number
  educationRank?: number
  /** نام رشتهٔ فارغ‌التحصیلی؛ برای هم‌حوزه بودن با دستهٔ شغل. */
  graduationField?: string | null
  /** دستهٔ شغلی که انجام می‌شود. */
  jobCategory?: string | null
  /** سن مؤثر بازیکن (تقویم بازی: هر هفته یک سال). */
  age?: number
  elapsedMinutes: number
  /** سلامت فعلی؛ هرچه کمتر، بهره‌وری کمتر. */
  health?: number
  /** خستگی فعلی؛ هرچه بیشتر، بهره‌وری کمتر. */
  fatigue?: number
  /** سقف واقعی سلامت بازیکن (عضو باشگاه ۱۲۰). */
  maxHealth?: number
}

export interface IncomeCalculationResult {
  /** مدت کار بر حسب دقیقهٔ *بازی* — همان واحدی که دستمزد و خستگی با آن حساب می‌شود. */
  elapsedMinutes: number
  /** دستمزد مؤثر به تومان در دقیقهٔ *بازی*. */
  effectivePayPerMinute: number
  /** ضریب سلامت در لحظهٔ تسویه (برای نمایش در پنل). */
  healthFactor: number
  /** ضریب خستگی در لحظهٔ تسویه. */
  fatigueFactor: number
  /** ضریب توان بدنیِ اعمال‌شده (با کف ۰٫۵). */
  conditionFactor: number
  /** ضریب تحصیلِ اعمال‌شده (مدرک + هم‌حوزه بودن رشته). */
  educationFactor: number
  /** آیا رشتهٔ بازیکن با این دستهٔ شغلی هم‌حوزه بود؟ */
  fieldMatched: boolean
  /** ضریب سنِ اعمال‌شده. */
  ageFactor: number
  /** بهره‌وری لحظه‌ای ۰-۱۰۰ — همان عددی که روی شناسنامه می‌آید. */
  productivityScore: number
  totalEarnedMoney: number
  earnedExperience: number
  healthDrain: number
  fatigueGained: number
  /** تفکیک کامل ضریب‌ها برای پنل‌هایی که دلیل را نشان می‌دهند. */
  breakdown: WorkMultiplierBreakdown
}

export class IncomeCalculationService {
  /**
   * محاسبهٔ درآمد یک بازهٔ کار.
   *
   * ⚠️ قرارداد واحدها: `params.elapsedMinutes` **دقیقهٔ بازی** است و
   * `fatigueRate`/`healthDrainRate`/`expRate` **در دقیقهٔ واقعی** ذخیره
   * شده‌اند (همان واحدی که در `WorkBlueprint` نوشته شده). تبدیل هر کدام دقیقاً
   * یک‌بار و فقط اینجا انجام می‌شود.
   *
   * این قرارداد پیش‌تر شکسته شده بود: فراخوان‌دهنده نرخ خستگی را از قبل
   * تبدیل می‌کرد و اینجا دوباره تبدیل می‌شد، پس خستگیِ ثبت‌شده ۳۰ برابر کمتر
   * از واقعیت بود («+۱٪» برای یک شیفت سنگین) و هیچ شیفتی هرگز به مرز بدنی
   * نمی‌رسید. هر عددی که اینجا می‌آید باید نرخِ خامِ دقیقهٔ واقعی باشد.
   */
  calculatePartTimeIncome(
    params: IncomeCalculationParams,
    healthDrainRate: number,
    fatigueRate: number,
    expRate: number
  ): IncomeCalculationResult {
    const minutes = Math.max(0, Math.floor(params.elapsedMinutes))

    const breakdown = workMultiplier({
      health: params.health ?? 100,
      fatigue: params.fatigue ?? 0,
      maxHealth: params.maxHealth,
      skillLevelAverage: params.skillLevelAverage,
      experience: params.playerExperience ?? 0,
      educationRank: params.educationRank ?? 1,
      graduationField: params.graduationField ?? null,
      jobCategory: params.jobCategory ?? null,
      age: params.age
    })

    // سختی کار ویژگیِ خودِ شغل است (نه ویژگی بازیکن) و برای همین بیرون از
    // ضریب «بهره‌وری» می‌ماند؛ وگرنه یک شغل سخت، بهره‌وریِ بازیکن را
    // به‌دروغ بالا نشان می‌داد.
    const difficultyMultiplier = 1 + (params.difficulty - 1) * 0.15

    // دستمزد از نرخِ «هر دقیقهٔ واقعی» به نرخِ «هر دقیقهٔ بازی» ترجمه می‌شود و
    // مدت کار هم دقیقهٔ بازی است؛ پس مبلغ نهایی به‌ازای هر دقیقهٔ واقعیِ کار
    // هیچ تغییری نمی‌کند (نه تورم، نه افت درآمد).
    const effectivePayPerMinute = Math.round(
      ratePerGameMinute(params.basePayPerMinute) * difficultyMultiplier * breakdown.total
    )

    return {
      elapsedMinutes: minutes,
      effectivePayPerMinute,
      healthFactor: round2(healthFactor(params.health ?? 100, params.maxHealth)),
      fatigueFactor: round2(fatigueFactor(params.fatigue ?? 0)),
      conditionFactor: round2(breakdown.condition),
      educationFactor: round2(breakdown.education),
      fieldMatched: breakdown.fieldMatched,
      ageFactor: round2(breakdown.age),
      productivityScore: productivity(breakdown.total).score,
      totalEarnedMoney: effectivePayPerMinute * minutes,
      earnedExperience: Math.round(ratePerGameMinute(expRate) * minutes * params.difficulty),
      healthDrain: Math.min(100, Math.round(ratePerGameMinute(healthDrainRate) * minutes)),
      fatigueGained: fatiguePointsFor(minutes, fatigueRate),
      breakdown
    }
  }

  calculateFullTimeSalary(
    salaryPerMinute: number,
    elapsedMinutes: number
  ): { elapsedMinutes: number; totalSalary: number } {
    const minutes = Math.max(0, Math.floor(elapsedMinutes))
    return {
      elapsedMinutes: minutes,
      totalSalary: Math.round(salaryPerMinute * minutes)
    }
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

export const incomeCalculationService = new IncomeCalculationService()
