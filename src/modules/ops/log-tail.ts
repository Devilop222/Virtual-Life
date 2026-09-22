/**
 * خواندنِ دنبالهٔ لاگِ سرور، با پاک‌سازیِ رازها — جانشینِ امنِ «کنسول».
 *
 * ## چه چیزی این‌جا **نیست**
 * هیچ راهی برای اجرای دستور. یک کنسولِ باز روی تلگرام یعنی هر کسی که به آن
 * حساب دست پیدا کند، به کلِ سرور دست پیدا می‌کند؛ و از آن بدتر، ورودیِ متنیِ
 * کاربر باید به shell برسد که هیچ بازبینیِ کدی نمی‌تواند ایمنش کند. آن‌چه
 * مالک واقعاً به آن نیاز دارد — «چه خبر است؟ چه خطایی داده؟» — با خواندنِ
 * لاگ جواب می‌گیرد، و خواندنِ لاگ را می‌شود محدود و پاک‌سازی کرد.
 *
 * ## چرا پاک‌سازیِ راز در دو لایه؟
 * لایهٔ اول (`pino` در `utils/logger`) فیلدهای شناخته‌شده را سانسور می‌کند،
 * ولی **رشتهٔ خامِ داخل پیام** را نمی‌بیند: اگر کتابخانه‌ای خطا را با URLِ
 * اتصال در متن پرتاب کند، همان متن داخل `msg` می‌نشیند و از فیلترِ فیلدی رد
 * می‌شود. لایهٔ دوم همان‌جا لازم است. این یک احتمال نظری نیست: پیامِ خطای
 * `pg` و `Prisma` هر دو می‌توانند رشتهٔ اتصال را در متن داشته باشند.
 */
import { existsSync, openSync, closeSync, fstatSync, readSync } from 'fs'

/** حداکثر بایتی که از انتهای لاگ خوانده می‌شود (۶۴ کیلوبایت). */
const MAX_READ_BYTES = 64 * 1024
/** حداکثر خطی که به تلگرام می‌رود. */
export const MAX_LOG_LINES = 40
/** حداکثر طولِ هر خط پس از نمایش؛ خطِ بلند پنل را از هم می‌پاشد. */
const MAX_LINE_CHARS = 160

/**
 * الگوهای راز ↔ جانشین.
 *
 * ترتیب مهم است: `postgresql://...` باید پیش از قاعدهٔ `KEY=value` بیاید،
 * وگرنه `DATABASE_URL=postgresql://...` فقط تا علامت مساوی پاک می‌شود و بقیهٔ
 * رشتهٔ اتصال می‌ماند.
 */
const REDACTIONS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /postgres(?:ql)?:\/\/[^\s"'`]+/gi, replacement: '[نشانیِ پاک‌شده]' },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, replacement: '[توکنِ گیت‌هاب]' },
  { pattern: /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g, replacement: '[توکنِ ربات]' },
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, replacement: '[توکنِ پاک‌شده]' },
  {
    // نامِ متغیر عمداً در جانشین می‌ماند تا مالک بفهمد *کدام* کلید پاک شده
    // است؛ ولی همان متغیر هم نباید با حرف لاتین قاطی شود تا متنِ فارسی
    // خالص بماند — پس جانشین بدونِ تکرارِ نام ساخته می‌شود.
    pattern: /\b([A-Z_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|APIKEY|API_KEY|CREDENTIALS?)[A-Z_]*)\s*[=:]\s*\S+/gi,
    replacement: '$1=[پاک‌شده]'
  }
]

/** پاک‌سازیِ رازها از یک متنِ آزاد. */
export function redactSecrets(text: string): string {
  let output = text
  for (const rule of REDACTIONS) {
    output = output.replace(rule.pattern, rule.replacement)
  }
  return output
}

export interface LogTail {
  lines: string[]
  /** آیا لاگ اصلاً وجود دارد؟ */
  present: boolean
  /** حجمِ کلِ فایل به بایت. */
  sizeBytes: number
  /** آیا خطوطی از ابتدا بریده شد (فایل بزرگ‌تر از سقفِ خواندن بود)؟ */
  truncated: boolean
}

/**
 * خواندنِ دنبالهٔ فایل.
 *
 * فقط انتهای فایل خوانده می‌شود (نه کلِ آن): لاگِ سرور می‌تواند صدها
 * مگابایت باشد و خواندنِ کاملش درونِ ربات، حافظه و رویداد‌حلقه را می‌بلعد.
 */
export function tailLog(path: string, lineCount: number = MAX_LOG_LINES): LogTail {
  if (!existsSync(path)) {
    return { lines: [], present: false, sizeBytes: 0, truncated: false }
  }

  let fd: number | null = null
  try {
    fd = openSync(path, 'r')
    const size = fstatSync(fd).size
    const readBytes = Math.min(size, MAX_READ_BYTES)
    const start = size - readBytes

    const buffer = Buffer.alloc(readBytes)
    let filled = 0
    while (filled < readBytes) {
      const read = readSync(fd, buffer, filled, readBytes - filled, start + filled)
      if (read <= 0) {
        break
      }
      filled += read
    }

    const text = buffer.subarray(0, filled).toString('utf8')
    const rawLines = text.split('\n')
    // اگر از میانِ فایل شروع کرده باشیم، خطِ اول بریده است و دور انداخته می‌شود.
    if (start > 0 && rawLines.length > 0) {
      rawLines.shift()
    }
    const cleaned = rawLines
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0)

    const selected = cleaned.slice(-lineCount).map((line) => {
      const redacted = redactSecrets(line)
      return redacted.length > MAX_LINE_CHARS ? `${redacted.slice(0, MAX_LINE_CHARS)}…` : redacted
    })

    return {
      lines: selected,
      present: true,
      sizeBytes: size,
      truncated: start > 0 || cleaned.length > lineCount
    }
  } catch {
    // لاگِ ناخوانا نباید پنل را بشکند؛ «موجود نیست» گزارش می‌شود.
    return { lines: [], present: false, sizeBytes: 0, truncated: false }
  } finally {
    if (fd !== null) {
      closeSync(fd)
    }
  }
}
