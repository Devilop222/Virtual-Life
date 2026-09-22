/**
 * چرخهٔ عمر وام بانکی — تنها منبع حقیقتِ «الان این وام کجاست؟».
 *
 * ── چرا این فایل؟ ────────────────────────────────────────────────────────────
 * پیش از این، `Loan.dueAt` نوشته می‌شد ولی **هیچ‌جا خوانده نمی‌شد**: وامِ
 * سررسیدگذشته تا ابد `ACTIVE` می‌ماند، ورشکستگی مفهومی نداشت و وثیقه (ملک یا
 * شرکت) هرگز آزاد نمی‌شد. نتیجه یک بن‌بست بود: بازیکنی که قسط نمی‌داد، می‌توانست
 * وام را نادیده بگیرد، و بازیکنی که وثیقه گذاشته بود تا ابد ملکش را در گرو
 * می‌دید بدون هیچ راهی.
 *
 * حالا عمر وام صریح است:
 *
 *   ACTIVE ──(نزدیک سررسید)──▶ DUE_SOON
 *      │
 *      ├──(سررسید گذشت، داخل مهلت)──▶ OVERDUE
 *      │
 *      └──(مهلت هم گذشت)──▶ DEFAULTED  ← تملک وثیقه، جریمهٔ اعتبار
 *                                  PAID ← تسویهٔ کامل
 *
 * مدل کاملاً Lazy و مبتنی بر Timestamp است: هیچ تایمری لازم نیست، Restart چیزی
 * را نمی‌بُرد، و همان تابع هم پنل و هم فرایند تملک را تغذیه می‌کند تا نمایش و
 * واقعیت هرگز واگرا نشوند.
 */

import { gameDays, gameDaysSince, daysUntil } from '../../utils/game-time'

/**
 * مهلت پس از سررسید، پیش از نکول — ۷ روز بازی.
 *
 * چرا ۷؟ یک هفتهٔ بازی ≈ ۵٫۶ ساعت واقعی؛ یعنی بازیکنی که یک روز واقعی از بازی
 * دور بوده هم فرصت جبران دارد، اما وام هم برای همیشه زنده نمی‌ماند. مبلغ قسط
 * پیش‌فرض (۱ میلیون) در همان بازه چند بار قابل پرداخت است، پس این مهلت سخت‌گیرانه
 * نیست ولی بی‌عاقبت هم نیست.
 */
export const LOAN_GRACE_DAYS = 7

/** آستانهٔ هشدار نزدیکی سررسید — ۳ روز بازی. */
export const LOAN_DUE_SOON_DAYS = 3

export type LoanLifecycleState = 'ACTIVE' | 'DUE_SOON' | 'OVERDUE' | 'DEFAULTED' | 'PAID' | 'CLOSED'

export interface LoanLifecycle {
  state: LoanLifecycleState
  /** روزهای بازیِ باقی‌مانده تا سررسید (۰ اگر رسیده یا گذشته باشد). */
  daysUntilDue: number
  /** روزهای بازیِ گذشته از سررسید (۰ اگر نرسیده باشد). */
  daysPastDue: number
  /** روزهای بازیِ باقی‌مانده تا نکول (۰ اگر نکول شده باشد). */
  graceDaysLeft: number
  /** آیا عمر وام تمام شده (پرداخت‌شده، نکول‌شده یا بسته)؟ */
  isTerminal: boolean
  /** آیا همین حالا باید نکول شود؟ (شرطِ Sweep و پنل از همین می‌خوانند) */
  shouldDefault: boolean
  /** برچسب فارسیِ آماده برای نمایش در پنل بازیکن. */
  label: string
}

/** آخرین لحظهٔ معتبرِ پرداخت = سررسید + مهلت. */
export function defaultDeadline(dueAt: Date | number | string): number {
  const base = typeof dueAt === 'number' ? dueAt : new Date(dueAt).getTime()
  return base + gameDays(LOAN_GRACE_DAYS)
}

/**
 * وضعیت مشتق‌شدهٔ یک وام در لحظهٔ دلخواه.
 *
 * این تابع هیچ Query و هیچ تصمیم مالی نمی‌گیرد؛ فقط «الان کجا هستیم» را
 * می‌گوید تا پنل، Sweep و تست همه یک پاسخ بگیرند.
 */
export function loanLifecycle(input: {
  status: string
  dueAt: Date | number | string
  now?: number
}): LoanLifecycle {
  const now = input.now ?? Date.now()
  const dueMs = typeof input.dueAt === 'number' ? input.dueAt : new Date(input.dueAt).getTime()
  const due = new Date(dueMs)

  if (input.status === 'PAID') {
    return terminal('PAID', 'تسویه‌شده')
  }
  if (input.status === 'DEFAULTED') {
    return terminal('DEFAULTED', 'نکول‌شده — وثیقه تملک شد')
  }
  if (input.status !== 'ACTIVE') {
    // CLOSED و هر وضعیت ناشناختهٔ آیندهٔ اسکیما: بسته، بدون اقدام خودکار
    return terminal('CLOSED', 'بسته‌شده')
  }

  const daysPastDue = gameDaysSince(due, now)
  const dueMsIsFuture = now < dueMs
  const daysUntilDue = dueMsIsFuture ? daysUntil(due, now) : 0
  const graceMsLeft = Math.max(0, defaultDeadline(dueMs) - now)
  const graceDaysLeft = Math.ceil(graceMsLeft / (gameDays(1) || 1))
  const shouldDefault = graceMsLeft <= 0

  if (shouldDefault) {
    return {
      state: 'OVERDUE',
      daysUntilDue: 0,
      daysPastDue,
      graceDaysLeft: 0,
      isTerminal: false,
      shouldDefault: true,
      label: 'سررسیدگذشته — در آستانهٔ نکول'
    }
  }

  if (!dueMsIsFuture) {
    return {
      state: 'OVERDUE',
      daysUntilDue: 0,
      daysPastDue,
      graceDaysLeft,
      isTerminal: false,
      shouldDefault: false,
      label: `سررسیدگذشته (${daysPastDue.toLocaleString('fa-IR')} روز بازی پیش)`
    }
  }

  if (daysUntilDue <= LOAN_DUE_SOON_DAYS) {
    return {
      state: 'DUE_SOON',
      daysUntilDue,
      daysPastDue: 0,
      graceDaysLeft,
      isTerminal: false,
      shouldDefault: false,
      label: `نزدیک سررسید (${daysUntilDue.toLocaleString('fa-IR')} روز بازی مانده)`
    }
  }

  return {
    state: 'ACTIVE',
    daysUntilDue,
    daysPastDue: 0,
    graceDaysLeft,
    isTerminal: false,
    shouldDefault: false,
    label: `فعال (${daysUntilDue.toLocaleString('fa-IR')} روز بازی تا سررسید)`
  }
}

/**
 * هشدارِ بازیکن‌محور برای پنل بانک — فقط وقتی واقعاً ریسکی هست.
 *
 * چرا جدا؟ پنل باید بتواند «چه خبر است و چه کار کنم» را بدون منطق تکراری
 * نشان دهد؛ متنِ هشدار هم مثل خود وضعیت یک منبع واحد دارد.
 */
export function loanWarningText(lifecycle: LoanLifecycle): string | null {
  if (lifecycle.state === 'OVERDUE' && lifecycle.shouldDefault) {
    return '🚨 مهلت پرداخت تمام شده؛ وام در آستانهٔ نکول است و وثیقه‌ات تملک می‌شود. همین حالا تسویه کن.'
  }
  if (lifecycle.state === 'OVERDUE') {
    return `⚠️ سررسید گذشته است و ${lifecycle.graceDaysLeft.toLocaleString('fa-IR')} روز بازی تا تملک وثیقه مانده. الان تسویه کن تا اعتبارت آسیب نبیند.`
  }
  if (lifecycle.state === 'DUE_SOON') {
    return '⏳ سررسید نزدیک است؛ با «تسویهٔ کامل وام» کمترین بهره را می‌پردازی.'
  }
  return null
}

function terminal(state: LoanLifecycleState, label: string): LoanLifecycle {
  return {
    state,
    daysUntilDue: 0,
    daysPastDue: 0,
    graceDaysLeft: 0,
    isTerminal: true,
    shouldDefault: false,
    label
  }
}
