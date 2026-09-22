import { join } from 'path'
import { readText } from './helpers/source'
import { sourceFiles } from './helpers/source-tree'

/**
 * اینورینت پول: هیچ تغییرِ موجودیِ بازیکن نباید بی‌ردیفِ دفتری باشد.
 *
 * چرا؟ این کلاس باگ یک‌بار واقعاً اتفاق افتاد: هزینهٔ مهاجرت (پایه ۲ میلیون
 * تومان) مستقیم از `balance` کم می‌شد و هیچ `financial_transactions` نمی‌ساخت.
 * نتیجه‌اش این بود که دفتر کلِ بازیکن با کیف پولش نمی‌خواند، ممیزی اقتصاد
 * (`offline-deps/scripts/economy-audit.js`) آن را «کسرِ بدون ثبت» می‌دید و
 * بازیکن هم در تاریخچه نمی‌فهمید پولش کجا رفت.
 *
 * تست، سورس را می‌خواند و برای هر تغییر موجودی، در همان نزدیکی دنبال یکی از این
 * دو می‌گردد: ثبت مستقیم ردیف (`financialTransaction`) یا صدا زدن یک تابعِ
 * ثبت‌کننده (نامی که `ledger`/`record…` دارد). اگر نه، قرمز می‌شود.
 *
 * حساب‌های داخلیِ سیستم (صندوق بانک) از این قاعده مستثنا هستند: آن‌ها کیف پولِ
 * بازیکن نیستند و جداگانه در `bankPool` با ستون‌های حسابداری خودشان ثبت می‌شوند.
 */

const ROOT = join(__dirname, '..')

/** فایل‌هایی که `balance` در آن‌ها حساب داخلیِ سیستم است، نه کیف بازیکن. */
const INTERNAL_ACCOUNT_FILES = new Set([
  join(ROOT, 'src', 'modules', 'banking', 'bank-pool.service.ts')
])

/** فاصله‌ای که در آن دنبال ردیف دفتری می‌گردیم. */
const WINDOW = 80

const LEDGER_PATTERN = /financialTransaction|Ledger|ledger|recordRepay|recordPayment|recordTransaction/

function violationsIn(path: string): number[] {
  const lines = readText(path).split('\n')
  const hits: number[] = []
  lines.forEach((line, index) => {
    if (!/balance:\s*\{\s*(increment|decrement)/.test(line)) return
    const from = Math.max(0, index - WINDOW)
    const to = Math.min(lines.length, index + WINDOW)
    if (!LEDGER_PATTERN.test(lines.slice(from, to).join('\n'))) hits.push(index + 1)
  })
  return hits
}

describe('اینورینت پول: تغییرِ موجودی بازیکن همیشه ردیف دفتری دارد', () => {
  test('هیچ تغییرِ موجودیِ بی‌ردیف در کل سورس نمانده است', () => {
    const offenders: string[] = []

    for (const file of sourceFiles(join(ROOT, 'src'))) {
      if (INTERNAL_ACCOUNT_FILES.has(file)) continue
      for (const line of violationsIn(file)) {
        offenders.push(`${file.replace(ROOT, '').replace(/\\/g, '/')}:${line}`)
      }
    }

    expect(offenders).toEqual([])
  })

  test('تست واقعاً سورس را می‌بیند (گاردِ خودِ ابزار)', () => {
    // اگر مسیر یا الگو عوض شود، تستِ بالا می‌تواند بی‌صدا سبز شود.
    const files = sourceFiles(join(ROOT, 'src'))
    expect(files.length).toBeGreaterThan(100)

    const anyHit = files.some((file) => violationsIn(file).length > 0 || readText(file).includes('financialTransaction'))
    expect(anyHit).toBe(true)
  })
})
