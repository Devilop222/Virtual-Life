/**
 * قالب‌بندی عدد، مبلغ و تاریخ فارسی.
 *
 * این فایل تنها منبع قالب‌بندی عدد در کل پروژه است (هم لایهٔ پیام و هم
 * لایهٔ سرویس از همین‌جا می‌خوانند) تا یک مبلغ در پنل و در متن سرویس
 * هرگز دو شکل متفاوت نداشته باشد. هیچ وابستگی به تلگرام ندارد؛ پس ماژول‌های
 * دامنه می‌توانند بدون وصل‌شدن به لایهٔ پیام از آن استفاده کنند.
 */

/** تبدیل عدد به رشتهٔ فارسی با جداکنندهٔ هزارگان. */
export function fa(value: number | { toString(): string } | null | undefined): string {
  if (value === null || value === undefined) return '۰'
  if (typeof value === 'bigint') return value.toLocaleString('fa-IR')
  const number = Number(value)
  return Number.isFinite(number) ? number.toLocaleString('fa-IR') : 'نامشخص'
}

/** مبلغ با واحد تومان. */
export function money(value: number | { toString(): string } | null | undefined): string {
  return `${fa(value)} تومان`
}

/**
 * پیامِ یکدستِ «پول کافی نیست».
 *
 * چرا یک تابعِ مشترک؟ قبلاً هر سرویس یک جملهٔ متفاوت داشت و بیشترشان فقط
 * «موجودی کافی نیست» می‌گفتند: بازیکن نمی‌فهمید الان چقدر دارد و چقدر کم
 * دارد، پس برای فهمیدنش مجبور بود پنل بانک را باز کند و دوباره تلاش کند.
 * این متن سه چیز را می‌گوید: هزینه، موجودی فعلی، کمبود — به‌همراه یک راهِ
 * ادامهٔ اختیاری.
 *
 * @param needed هزینهٔ موردنیاز (تومان)
 * @param balance موجودی فعلی بازیکن (تومان)
 * @param action انجام‌دهندهٔ هزینه؛ اگر بدهی، جمله بدون فاعل ساخته می‌شود
 * @param hint راهِ ادامه (اختیاری)
 */
export function insufficientFunds(
  needed: number,
  balance: number,
  action?: string,
  hint?: string
): string {
  const shortfall = Math.max(0, Math.round(needed) - Math.round(balance))
  const head = action ? `«${action}» ${money(needed)} می‌شود` : `هزینه ${money(needed)} است`
  const parts = [
    `${head}، اما موجودی کیفت ${money(balance)} است — ${money(shortfall)} کم داری.`
  ]
  if (hint) {
    parts.push(hint)
  }
  return parts.join('\n')
}

/**
 * تاریخ شمسیِ یک Moment در مرز روزِ بازی (UTC).
 *
 * همهٔ چرخه‌های بازی (روزانه/هفتگی) با dayIndex مبتنی بر UTC شمرده می‌شوند؛
 * نمایش تاریخ هم باید با همان مرز بخواند، وگرنه سررسید وامِ «امروز» می‌تواند
 * فردا دیده شود. ورودی nullable قابل قبول است و '—' برمی‌گرداند.
 */
export function faDate(date: Date | null | undefined): string {
  if (!date) return '—'
  return date.toLocaleDateString('fa-IR', { timeZone: 'UTC' })
}
