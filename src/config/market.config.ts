/**
 * تنظیمات بازار: قیمت‌گذاری پویا بر اساس عرضه و تقاضا.
 * تمام اعداد اقتصادی اینجا متمرکز شده‌اند تا در Handlerها Hard-Code نشوند.
 *
 * محاسبهٔ زمان فقط با ساعت مرکزی بازی (`utils/game-time`) انجام می‌شود.
 */

import { gameDays } from '../utils/game-time'

export const MARKET_CONFIG = {
  /** حداقل ضریب قیمت نسبت به قیمت پایه (کف قیمت). */
  minPriceMultiplier: 0.6,

  /** حداکثر ضریب قیمت نسبت به قیمت پایه (سقف قیمت). */
  maxPriceMultiplier: 1.8,

  /** حداکثر تغییر قیمت در هر بازمحاسبه (۵٪) — جلوگیری از جهش ناگهانی. */
  maxStepChange: 0.05,

  /** فاصلهٔ زمانی بازمحاسبهٔ قیمت. */
  recalcIntervalMs: 15 * 60 * 1000,

  /** پنجرهٔ زمانی محاسبهٔ تقاضا (۲۴ ساعت). */
  /** پنجرهٔ تقاضای بازار: یک روز بازی (۴۸ دقیقهٔ واقعی) — روی تقویم بازی. */
  demandWindowMs: gameDays(1),

  /** تعداد خریدی که «تقاضای متعادل» محسوب می‌شود. */
  neutralDemand: 10,

  /** حساسیت قیمت به تقاضا. */
  demandSensitivity: 0.4,

  /** حساسیت قیمت به کمبود موجودی. */
  scarcitySensitivity: 0.3,

  /** حساسیت قیمت به فعالیت اقتصادی منطقه. */
  economySensitivity: 0.2
} as const

/**
 * محاسبهٔ ضریب قیمت جدید بر پایهٔ تقاضا، کمبود و رونق اقتصادی.
 * نتیجه همیشه بین کف و سقف می‌ماند و در هر مرحله بیش از `maxStepChange` تغییر نمی‌کند.
 */
export function computePriceMultiplier(input: {
  currentMultiplier: number
  recentPurchases: number
  stock: number
  economicIndex: number
}): number {
  const cfg = MARKET_CONFIG

  // فشار تقاضا: بیشتر از حد متعادل → گران‌تر، کمتر → ارزان‌تر
  const demandRatio =
    (input.recentPurchases - cfg.neutralDemand) / Math.max(1, cfg.neutralDemand)
  const demandPressure = clamp(demandRatio, -1, 1) * cfg.demandSensitivity

  // کمبود موجودی: فقط برای کالاهای محدود (stock >= 0)
  let scarcityPressure = 0
  if (input.stock >= 0) {
    const scarcity = input.stock <= 0 ? 1 : clamp(1 - input.stock / 100, 0, 1)
    scarcityPressure = scarcity * cfg.scarcitySensitivity
  }

  // رونق اقتصادی منطقه: شاخص بالاتر → قدرت خرید بیشتر → قیمت بالاتر
  const economyPressure =
    ((clamp(input.economicIndex, 0, 100) - 50) / 50) * cfg.economySensitivity

  const target = 1 + demandPressure + scarcityPressure + economyPressure
  const bounded = clamp(target, cfg.minPriceMultiplier, cfg.maxPriceMultiplier)

  // حرکت تدریجی به سمت هدف (Smoothing)
  const delta = clamp(bounded - input.currentMultiplier, -cfg.maxStepChange, cfg.maxStepChange)
  const next = input.currentMultiplier + delta

  return roundTo(clamp(next, cfg.minPriceMultiplier, cfg.maxPriceMultiplier), 4)
}

/** روند قیمت بر اساس اختلاف ضریب فعلی و قبلی. */
export function priceTrendOf(current: number, previous: number): 'up' | 'down' | 'stable' {
  const diff = current - previous
  if (diff > 0.005) return 'up'
  if (diff < -0.005) return 'down'
  return 'stable'
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}
