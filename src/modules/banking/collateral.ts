/**
 * فرمول‌های وثیقه و سقف وام — منبع واحد.
 *
 * این توابع عمداً در یک ماژول بدون وابستگی زندگی می‌کنند تا سرویس وام،
 * سرویس اعتباری و پنل تأیید همگی از یک فرمول بخوانند و هیچ‌کدام
 * نسخهٔ محلی خودش را بازنویسی نکند (بدون وابستگی چرخشی).
 */

/** سهمی از ارزش وثیقه که بانک بر مبنای آن وام می‌دهد. */
export const COLLATERAL_RATIO = 0.5

/** ارزش هر سطح کسب‌وکار در برآورد وثیقه. */
export const BUSINESS_LEVEL_VALUE = 10_000_000

/**
 * ارزش کسب‌وکار به‌عنوان وثیقه — خزانه + ارزش سطح.
 */
export function businessCollateralValue(treasury: number, level: number): number {
  return treasury + BUSINESS_LEVEL_VALUE * level
}

/**
 * سقف اصل وام = کمینهٔ (سهم وثیقه، سقف اعتباری بازیکن).
 * پیش‌نمایش پنل و پرداخت واقعی از همین تابع می‌خوانند تا هرگز جدا نیفتند.
 */
export function loanPrincipalCap(collateralValue: number, maxLoanAmount: number): number {
  return Math.min(Math.round(collateralValue * COLLATERAL_RATIO), maxLoanAmount)
}
