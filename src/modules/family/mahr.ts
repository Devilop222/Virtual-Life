/**
 * مهریه — تنها منبع حقیقتِ قواعد مهریه در کل پروژه.
 *
 * چرا این فایل؟ پیش‌تر حداقل مهریه در سرویس ازدواج، سقف در یک متن راهنما و
 * رفتار «۰» در یک پیام دیگر تعریف می‌شد؛ نتیجه سه قاعدهٔ متفاوت برای یک چیز
 * بود. حالا هر عدد، هر متن و هر اعتبارسنجی مهریه از همین‌جا می‌آید.
 *
 * ── قاعدهٔ بازی ─────────────────────────────────────────────
 *  • مهریه را *زن* تعیین می‌کند؛ بازی هیچ کفِ ساختگی تحمیل نمی‌کند.
 *    کمینهٔ ثبت یک تومان است، یعنی عملاً «هرچه طرفین بپذیرند».
 *  • تنها محدودیت *واقعی* مهریه، توان پرداخت مرد در لحظهٔ عقد است؛ آن شرط
 *    در `MarriageService.finalize` با یک نوشتار شرطی روی موجودی اعمال می‌شود.
 *  • سقف `MAX` هیچ قاعدهٔ بازی نیست؛ فقط محافظ سرریز محاسبات عددی است و
 *    در متن‌ها هم به همان شکل معرفی می‌شود.
 *  • در پیشنهادِ مرد، `۰` یعنی «تعیین‌نشده»: مهریه را خودِ زن می‌چیند.
 *    چون ستون `mahr` در دیتابیس تهی‌پذیر نیست، صفر نشانهٔ «تعیین‌نشده» است
 *    و هرگز به‌عنوان مهریهٔ نهایی ثبت نمی‌شود.
 */
import { ValidationError } from '../../utils/classes/errors'
import { fa, money } from '../../utils/format'
import { parseAmountDetailed } from '../../utils/commands'

export const MAHR_RULES = {
  /** کمینهٔ قابل ثبت؛ بازی سقف ساختگیِ پایینی نمی‌گذارد. */
  min: 1,
  /** سقف ثبت — فقط محافظ سرریز عدد، نه قاعدهٔ بازی. */
  max: 1_000_000_000_000,
  /** مقدار «تعیین‌نشده» در پیشنهاد مرد. */
  unset: 0
} as const

/** آیا این مبلغ یک مهریهٔ تعیین‌شده است؟ (صفر = تعیین‌نشده) */
export function isMahrSet(amount: number): boolean {
  return Number.isFinite(amount) && amount >= MAHR_RULES.min
}

/** نمایش یکدست مبلغ مهریه؛ صفر همیشه «تعیین‌نشده» خوانده می‌شود. */
export function describeMahr(amount: number): string {
  return isMahrSet(amount) ? money(amount) : 'تعیین‌نشده'
}

/** بازهٔ مجاز، به شکل آمادهٔ نمایش. */
export function mahrRangeText(): string {
  return `از ${money(MAHR_RULES.min)} تا ${money(MAHR_RULES.max)}`
}

/** پیام خطای یکتا برای مهریهٔ خارج از بازه. */
export function mahrRangeError(): string {
  return `مهریه باید عددی صحیح و ${mahrRangeText()} باشد.`
}

/**
 * اعتبارسنجی مبلغ مهریه.
 * تنها راه نوشتن مهریه در دیتابیس؛ هر مسیر دیگری باید از همین‌جا بگذرد.
 */
export function validateMahrAmount(amount: number): number {
  if (!Number.isSafeInteger(amount)) {
    throw new ValidationError('Invalid mahr', 'مهریه باید عددِ صحیح باشد.')
  }
  if (!isMahrSet(amount) || amount > MAHR_RULES.max) {
    throw new ValidationError('Mahr out of range', mahrRangeError())
  }
  return amount
}

/**
 * نرمال‌سازی مهریهٔ *پیشنهادی* مرد.
 *
 * «تعیین‌نشده» دو املا دارد: `null` (از لایهٔ پیام) و `۰`
 * (`MAHR_RULES.unset`، که همان چیزی است که خروجی `propose` برمی‌گرداند).
 * هر دو پذیرفته می‌شوند و به یک مقدار نرمال می‌رسند؛ وگرنه دامنهٔ ورودی و
 * خروجیِ یک تابع با هم نمی‌خواند و فراخوان بعدی با `۰` خطا می‌گیرد.
 */
export function normalizeMahrOffer(mahr: number | null): number {
  if (mahr === null || mahr === MAHR_RULES.unset) {
    return MAHR_RULES.unset
  }
  return validateMahrAmount(mahr)
}

/** نتیجهٔ خواندن ورودی متنی مهریه. */
export type MahrInputResult =
  | { kind: 'unset' }
  | { kind: 'amount'; amount: number }
  | { kind: 'invalid'; message: string }

/** دلیل رد ورودی → پیام فارسیِ هماهنگ با قاعدهٔ واحد. */
function invalidMahr(reason: string, allowUnset: boolean): MahrInputResult {
  if (reason === 'zero') {
    return {
      kind: 'invalid',
      message: allowUnset
        ? 'اگر می‌خواهی مهریه را خودِ خانم تعیین کند عدد ۰ را بفرست.'
        : 'مهریه نمی‌تواند صفر باشد؛ مبلغی که می‌پسندی را بنویس.'
    }
  }
  if (reason === 'negative') {
    return { kind: 'invalid', message: 'مهریه نمی‌تواند منفی باشد.' }
  }
  if (reason === 'too_large' || reason === 'not_an_integer') {
    return { kind: 'invalid', message: mahrRangeError() }
  }
  return {
    kind: 'invalid',
    message: `مهریه باید یک عدد معتبر باشد. مثال: ${fa(500_000)} یا ۲ میلیون`
  }
}

/**
 * خواندن مهریه از پیام بازیکن.
 *
 * @param allowUnset اگر `true` باشد (پیشنهاد مرد) عدد `۰` به‌معنی
 *   «تعیین‌نشده» پذیرفته می‌شود؛ در جریان تعیین مهریه توسط زن `۰` رد می‌شود.
 */
export function parseMahrInput(raw: string, allowUnset: boolean): MahrInputResult {
  const parsed = parseAmountDetailed(raw, { allowZero: allowUnset, max: MAHR_RULES.max })

  if (!parsed.ok) {
    return invalidMahr(parsed.reason, allowUnset)
  }
  if (parsed.value === MAHR_RULES.unset) {
    return { kind: 'unset' }
  }
  try {
    return { kind: 'amount', amount: validateMahrAmount(parsed.value) }
  } catch (error) {
    if (error instanceof ValidationError) {
      return { kind: 'invalid', message: error.persianMessage }
    }
    throw error
  }
}

/**
 * سه خط قاعدهٔ مهریه که در *همهٔ* پیام‌های خواستگاری عیناً تکرار می‌شود.
 * اگر روزی قاعده عوض شود، فقط همین‌جا عوض می‌شود.
 */
export function mahrRuleLines(): string[] {
  return [
    `• بازهٔ مجاز: ${mahrRangeText()}`,
    '• تعیین مهریه با خانم است؛ آقا پیشنهاد می‌دهد و او می‌پذیرد یا عوض می‌کند',
    '• شرط واقعی: هنگام عقد باید توان پرداخت مهریه در کیف پول آقای باشد'
  ]
}
