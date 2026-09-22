import { z } from 'zod'
import { safeCallbackSchema } from './validation'

export function normalizePersianText(text: string): string {
  if (!text) return ''

  return text
    // Arabic Yeh and Alef Maksura to Persian Yeh
    .replace(/[\u064A\u0649]/g, '\u06CC')
    // Arabic Kaf to Persian Keheh
    .replace(/\u0643/g, '\u06A9')
    // Arabic Tanween and Harakat removal
    .replace(/[\u064B-\u065F\u0670]/g, '')
    // Zero-width non-joiner (zwnj) to single space for uniform matching
    .replace(/[\u200C\u200B\u200D\uFEFF]/g, ' ')
    // Remove emojis, symbols, punctuation, keeping only Persian letters and spaces
    .replace(/[^\u0600-\u06FF\s]/g, '')
    // Collapse whitespace
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * واژه‌های لغو در همهٔ جریان‌های ورودی متنی.
 * یک منبع حقیقت: پیش‌تر هر جریان فهرست خودش را داشت («انصراف» در یکی،
 * «انصراف» و «بستن» در دیگری) و کاربر در یک پنل لغو می‌کرد و در پنل دیگر نه.
 */
const CANCEL_WORDS: ReadonlySet<string> = new Set(['انصراف', 'بستن', 'لغو', 'بیخیال'])

/** آیا این متن یعنی «لغو»؟ با نرمال‌سازی فارسی، پس نیم‌فاصله و اعراب مهم نیست. */
export function isCancelWord(text: string): boolean {
  if (!text) return false
  return CANCEL_WORDS.has(normalizePersianText(text))
}

export function isPersianText(text: string): boolean {
  return /[\u0600-\u06FF]/.test(text)
}

export interface ParsedCallback {
  action: string
  args: string[]
}

export function parseCallback(callbackData: string): ParsedCallback | null {
  const parsed = safeCallbackSchema.safeParse(callbackData)
  if (!parsed.success) {
    return null
  }

  const [action, ...args] = parsed.data.split(':')
  if (!action) {
    return null
  }

  return { action, args }
}

export function validateGenderArg(gender: string): 'MALE' | 'FEMALE' | null {
  const schema = z.enum(['MALE', 'FEMALE'])
  const parsed = schema.safeParse(gender)
  return parsed.success ? parsed.data : null
}

/** دلیل نامعتبر بودن یک ورودی مبلغ؛ برای ساخت پیام خطای دقیق. */
export type AmountInvalidReason =
  | 'empty'
  | 'not_a_number'
  | 'negative'
  | 'zero'
  | 'too_large'
  | 'not_an_integer'

export type AmountParseResult =
  | { ok: true; value: number }
  | { ok: false; reason: AmountInvalidReason }

export interface AmountParseOptions {
  /** صفر مجاز باشد؟ پیش‌فرض نه؛ در بیشتر جریان‌های مالی صفر بی‌معناست. */
  allowZero?: boolean
  /** سقف مجاز؛ پیش‌فرض فقط «عدد صحیح امن». */
  max?: number
}

/** رقم‌های فارسی و عربی به لاتین. */
function toLatinDigits(value: string): string {
  return value
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
}

/**
 * ضریب‌های کلامی و حرفی.
 * ترتیب مهم است: «میلیارد» باید پیش از «میلیون» سنجیده شود وگرنه
 * «۲ میلیارد» به‌اشتباه «میلیون» می‌خورد.
 */
const MULTIPLIERS: ReadonlyArray<readonly [RegExp, number]> = [
  [/^(.+?)میلیارد$/, 1_000_000_000],
  [/^(.+?)میلیون$/, 1_000_000],
  [/^(.+?)هزار$/, 1_000],
  [/^(\d+(?:\.\d+)?)b$/, 1_000_000_000],
  [/^(\d+(?:\.\d+)?)m$/, 1_000_000],
  [/^(\d+(?:\.\d+)?)k$/, 1_000]
]

/**
 * خواندن مبلغ از ورودی آزاد بازیکن.
 *
 * یک قاعده برای همهٔ جریان‌های مالی (بانک، مهریه، قرض، حراج، پنل ادمین):
 *  • رقم فارسی/عربی/لاتین
 *  • جداکنندهٔ هزارگان (`،` `,` `٬` `_`) و فاصله نادیده گرفته می‌شود
 *  • ممیز عربی `٫` به `.` تبدیل می‌شود
 *  • واحد پول («تومان») حذف می‌شود
 *  • ضریب کلامی/حرفی: «هزار/میلیون/میلیارد» و `k/m/b`
 *
 * خروجی همیشه یک عدد صحیح است؛ هر چیز دیگر با «دلیل» دقیق رد می‌شود تا
 * پیام خطا بتواند همان چیزی را بگوید که واقعاً اتفاق افتاده است.
 */
/** «نیم» در ورودی عامیانه (نیم میلیون = 500 هزار). */
function normalizeHalfWord(value: string): string {
  return value
    .replace(/نیم\s*میلیارد/g, '0.5میلیارد')
    .replace(/نیم\s*میلیون/g, '0.5میلیون')
    .replace(/نیم\s*هزار/g, '0.5هزار')
}

export function parseAmountDetailed(
  raw: string,
  options: AmountParseOptions = {}
): AmountParseResult {
  const { allowZero = false, max } = options

  if (!raw || raw.trim().length === 0) {
    return { ok: false, reason: 'empty' }
  }

  const cleaned = normalizeHalfWord(toLatinDigits(raw))
    .replace(/[،,٬_']/g, '')
    .replace(/[٫]/g, '.')
    .replace(/(تومان|تومن|توما|toman)s?$/i, '')
    .trim()
    .toLowerCase()

  // ورودی ترکیبی مثل «2 میلیون و 500 هزار» — هر تکه جدا سنجیده و جمع می‌شود.
  //
  // «و» حرف ربط فارسی است، ولی همین حرف وسط «میلیون» هم هست؛ اگر کورکورانه
  // روی «و» تقسیم کنیم، «100 میلیون» به «100میلی» + «ن» می‌شکند و ورودی
  // درست رد می‌شود. پس فقط «و»یی جداکننده است که دست‌کم از یک طرف فاصله دارد.
  const CONJUNCTION = /\s+(?:و|and)\s*|\s*(?:و|and)\s+/g
  const parts = cleaned.split(CONJUNCTION).map((part) => part.trim()).filter(Boolean)
  if (parts.length > 1 && parts.length <= 4) {
    let sum = 0
    for (const part of parts) {
      const res = parseAmountDetailed(part, { ...options, max: undefined })
      if (!res.ok) return res
      sum += res.value
      if (!Number.isSafeInteger(sum)) return { ok: false, reason: 'too_large' }
    }
    if (max !== undefined && sum > max) return { ok: false, reason: 'too_large' }
    if (sum === 0 && !allowZero) return { ok: false, reason: 'zero' }
    if (sum < 0) return { ok: false, reason: 'negative' }
    return { ok: true, value: sum }
  }

  const normalized = cleaned.replace(/[\s\u00a0\u200c\u200f\u200e]+/g, '')

  if (normalized.length === 0) {
    return { ok: false, reason: 'not_a_number' }
  }

  if (normalized.startsWith('-') || normalized.startsWith('−') || normalized.startsWith('–')) {
    return { ok: false, reason: 'negative' }
  }

  let numericText = normalized
  let multiplier = 1
  for (const [pattern, factor] of MULTIPLIERS) {
    const match = normalized.match(pattern)
    if (match?.[1]) {
      numericText = match[1]
      multiplier = factor
      break
    }
  }

  if (!/^\d+(?:\.\d+)?$/.test(numericText)) {
    return { ok: false, reason: 'not_a_number' }
  }

  const base = Number(numericText)
  if (!Number.isFinite(base)) {
    return { ok: false, reason: 'too_large' }
  }

  const value = Math.round(base * multiplier)
  if (!Number.isSafeInteger(value)) {
    return { ok: false, reason: 'too_large' }
  }
  if (value < 0) {
    return { ok: false, reason: 'negative' }
  }
  if (value === 0 && !allowZero) {
    return { ok: false, reason: 'zero' }
  }
  if (max !== undefined && value > max) {
    return { ok: false, reason: 'too_large' }
  }
  if (multiplier === 1 && Number.isInteger(base) === false) {
    return { ok: false, reason: 'not_an_integer' }
  }

  return { ok: true, value }
}

/**
 * پوستهٔ سازگار با امضای قدیمی: عدد یا `null`.
 * برای جریان‌هایی که پیام خطای اختصاصی نمی‌خواهند.
 */
export function parseAmountInput(raw: string, options: AmountParseOptions = {}): number | null {
  const result = parseAmountDetailed(raw, options)
  return result.ok ? result.value : null
}

// ───────────────────────────────────────────── انتقال پول بین بازیکنان

/**
 * کلیدواژه‌های انتقال پول. یک منبع حقیقت: هم راهنما و هم پیام‌های خطا
 * از همین فهرست می‌خوانند تا «کلمهٔ درست» هرگز دو نسخهٔ متفاوت نداشته باشد.
 */
export const TRANSFER_KEYWORDS: readonly string[] = [
  'انتقال پول',
  'پول بده',
  'دادن پول',
  'انتقال'
] as const

/**
 * کلیدواژه‌های انتقالِ *بانکی* — حساب به حساب.
 *
 * عمداً پیش از کلیدواژه‌های نقدی سنجیده می‌شوند: «انتقال بانکی» با «انتقال »
 * شروع می‌شود، و اگر ترتیب برعکس بود، همهٔ انتقال‌های بانکی به مسیرِ نقدی
 * (با سقفِ کوچک و بدون مالیات) می‌افتادند — یعنی دورترین حالت به هدفِ این
 * جداسازی.
 */
export const BANK_TRANSFER_KEYWORDS: readonly string[] = [
  'انتقال بانکی',
  'انتقال از بانک',
  'بانک به بانک'
] as const

/** نمونهٔ قالب درست برای راهنما و پیام خطا. */
export const TRANSFER_EXAMPLE = 'انتقال ۵۰۰۰۰۰'

/** نمونهٔ انتقالِ بانکی. */
export const BANK_TRANSFER_EXAMPLE = 'انتقال بانکی ۵۰۰۰۰۰۰'

export type TransferCommand =
  | { kind: 'transfer'; amount: number }
  | { kind: 'bank_transfer'; amount: number }
  | { kind: 'transfer_invalid'; reason: AmountInvalidReason | 'missing_amount' }
  | { kind: 'none' }

/**
 * خواندن دستور انتقال از متنِ خامِ پیام (نه نسخهٔ نرمال‌شده).
 *
 * چرا خام؟ `normalizePersianText` برای همسان‌سازی کلیدواژه‌ها رقم‌ها را دور
 * می‌ریزد؛ مبلغ باید از متن اصلی خوانده شود. اینجا فقط نیم‌فاصله، رقم
 * فارسی/عربی و فاصله‌های اضافی یکدست می‌شوند.
 */
export function parseTransferCommand(raw: string): TransferCommand {
  if (!raw) return { kind: 'none' }

  const text = toLatinDigits(raw)
    .replace(/[\u200C\u200B\u200D\uFEFF]/g, ' ')
    .replace(/[\u064A\u0649]/g, '\u06CC')
    .replace(/[\u0643]/g, '\u06A9')
    .replace(/\s+/g, ' ')
    .trim()

  // ترتیب مهم است: بانکی پیش از «انتقال پول» و هر دو پیش از «انتقال»؛ وگرنه
  // «انتقال بانکی» به مسیرِ نقدی می‌افتاد.
  const rails: ReadonlyArray<readonly ['bank_transfer' | 'transfer', readonly string[]]> = [
    ['bank_transfer', BANK_TRANSFER_KEYWORDS],
    ['transfer', TRANSFER_KEYWORDS]
  ]
  let rail: 'bank_transfer' | 'transfer' | null = null
  let keyword = ''
  for (const [kind, words] of rails) {
    const hit = words.find((word) => text.startsWith(`${word} `) || text === word)
    if (hit) {
      rail = kind
      keyword = hit
      break
    }
  }
  if (!rail) {
    return { kind: 'none' }
  }

  const rest = text.slice(keyword.length).trim()
  if (!rest) {
    return { kind: 'transfer_invalid', reason: 'missing_amount' }
  }

  const parsed = parseAmountDetailed(rest, { max: MAX_SAFE_TRANSFER_INPUT })
  if (!parsed.ok) {
    return { kind: 'transfer_invalid', reason: parsed.reason }
  }
  return rail === 'bank_transfer'
    ? { kind: 'bank_transfer', amount: parsed.value }
    : { kind: 'transfer', amount: parsed.value }
}

/** سقفِ خواندنِ ورودی؛ سقفِ واقعیِ بازی در `TransferService` سنجیده می‌شود. */
const MAX_SAFE_TRANSFER_INPUT = Number.MAX_SAFE_INTEGER
