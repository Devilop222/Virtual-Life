/**
 * تصمیمِ «این شیفت باید خودکار تمام شود؟» — خالص و بدون دیتابیس.
 *
 * چرا جدا از سرویس؟ چون همین تصمیم دو مصرف‌کننده دارد:
 *   ۱. سرویسِ شیفت، وقتی خودِ بازیکن پنل را باز می‌کند (پاسخ فوری، بدون انتظار).
 *   ۲. چرخهٔ خودکارِ سرور، که برای هر شیفتِ رهاشده هم اجرا می‌شود.
 *
 * هر دو باید **یک جواب** بدهند. اگر هر کدام فرمول خودش را داشته باشد، بازیکن
 * یا با پیام «کارت تمام شد» روبه‌رو می‌شود که چرخهٔ خودکار هیچ‌وقت اجرا نکرده،
 * یا شیفتش بی‌دلیل بسته می‌شود. پس فرمول یک‌بار اینجا نوشته می‌شود و هر دو
 * از آن می‌خوانند.
 *
 * همهٔ ورودی‌ها از قبل خوانده‌شده‌اند (بدون کوئری): چرخهٔ خودکار باید بتواند
 * با یک کوئریِ بسته، همهٔ شیفت‌ها را بسنجد و تنها همان‌هایی را تسویه کند که
 * واقعاً سررسید شده‌اند.
 */

import { GAME_MINUTES_PER_REAL_MINUTE, gameMinutesSince } from '../../utils/game-time'
import { MAX_FATIGUE, payableShiftMinutes } from '../life/life-core'

/**
 * آستانهٔ خستگیِ بحرانی — مرزِ «بدن دیگر کار نمی‌کند».
 *
 * عمداً پایین‌تر از `MAX_FATIGUE` است: در ۱۰۰ بازیکن عملاً ازکارافتاده است و
 * رسیدن به آن یعنی شیفت چند دقیقه‌ای ادامه پیدا کرده که مزد نداشته. ۹۰ یعنی
 * «یک حاشیهٔ کوچک برای رسیدن به تخت/درمانگاه، ولی نه ادامهٔ کار».
 */
export const CRITICAL_FATIGUE_THRESHOLD = 90

export type WorkStopReason = 'CRITICAL_FATIGUE' | 'BODY_CAPACITY_REACHED'

export interface ShiftDueDecision {
  /** آیا این شیفت باید خودکار تسویه شود؟ */
  due: boolean
  reason: WorkStopReason | null
  /** کل مدتِ سپری‌شدهٔ شیفت بر حسب دقیقهٔ بازی. */
  elapsedGameMinutes: number
  /** بخشی از همان مدت که واقعاً مزد دارد (سقفِ ظرفیت بدن). */
  payableGameMinutes: number
  /** خستگی‌ای که این شیفت اضافه می‌کند. */
  fatigueGained: number
}

/**
 * سنجشِ سررسیدِ یک شیفتِ فعال.
 *
 * دو شرط، دقیقاً همان‌هایی که تسویهٔ دستی می‌سنجد:
 *  • خستگی به آستانهٔ بحرانی می‌رسد، یا
 *  • ظرفیت بدنِ شیفت تمام می‌شود (بیش از آن مزد وجود ندارد).
 *
 * `fatiguePerRealMinute` باید نرخِ **خامِ** Blueprint باشد، نه تبدیل‌شده؛
 * تبدیل به دقیقهٔ بازی فقط یک‌بار و داخل `payableShiftMinutes` رخ می‌دهد.
 */
export function shiftDueDecision(input: {
  startedAt: Date
  fatigue: number
  fatiguePerRealMinute: number
  now?: number
  criticalThreshold?: number
}): ShiftDueDecision {
  const elapsedGameMinutes = gameMinutesSince(input.startedAt, input.now)
  const fatiguePerMinute = input.fatiguePerRealMinute / GAME_MINUTES_PER_REAL_MINUTE
  const { payableMinutes, bodyCapacityReached } = payableShiftMinutes({
    elapsedGameMinutes,
    fatigue: input.fatigue,
    fatiguePerGameMinute: fatiguePerMinute
  })

  const gained = Math.min(MAX_FATIGUE, Math.round(fatiguePerMinute * payableMinutes))
  const threshold = input.criticalThreshold ?? CRITICAL_FATIGUE_THRESHOLD
  const critical = input.fatigue + gained >= threshold

  return {
    due: critical || bodyCapacityReached,
    reason: critical ? 'CRITICAL_FATIGUE' : bodyCapacityReached ? 'BODY_CAPACITY_REACHED' : null,
    elapsedGameMinutes,
    payableGameMinutes: payableMinutes,
    fatigueGained: gained
  }
}

/** پیامِ کوتاهِ پایانِ خودکار، بر اساس دلیلِ توقف. */
export function workStopReasonText(reason: WorkStopReason | null): string {
  return reason === 'CRITICAL_FATIGUE'
    ? 'خستگی‌ات به مرز بحرانی رسید؛ بدن دیگر کار نمی‌کند.'
    : 'بدنت تا آخرین دقیقهٔ مزددار کار کرد و شیفت خودکار بسته شد.'
}
