/**
 * نگهبانِ کامل‌بودنِ بستهٔ `dist` پیش از انتشار.
 *
 * چرا این آزمون وجود دارد؟ `dist` را `tsc` نمی‌سازد به‌تنهایی: `seed.js` جداگانه
 * از `prisma/seed.ts` کامپایل می‌شود. یک بازسازیِ دستی که فقط `tsc` را اجرا کند،
 * `seed.js` را جا می‌گذارد و بستهٔ ناقص بی‌صدا commit می‌شود؛ نتیجه‌اش این است که
 * نصبِ تازه در گام `run_seed` (که `node dist/seed.js` را اجرا می‌کند) می‌افتد.
 *
 * این آزمون روی *فایلِ کامیت‌شدهٔ* تاربال کار می‌کند، پس همان چیزی را می‌سنجد
 * که سرور مقصد می‌گیرد — نه درختِ کاری محلی را.
 */
import { execFileSync } from 'child_process'
import { readFileSync } from 'fs'
import { join } from 'path'

const ROOT = join(__dirname, '..')
// مسیر عمداً *نسبی* است: GNU tar روی Git Bash مسیر ویندوزی مثل `F:\...` را
// نامِ میزبانِ ریموت تفسیر می‌کند و شکست می‌خورد، در حالی که همهٔ محیط‌های
// ساخت/اجرا با `cwd = ROOT` یک مسیر نسبیِ ساده را درست می‌فهمند.
const BUNDLE = 'offline-deps/dist.tar.gz'

/** فایل‌هایی که نصب آفلاین بدون آن‌ها نمی‌تواند بالا بیاید. */
const REQUIRED = ['dist/app.js', 'dist/seed.js', 'dist/BUILD_INFO.json']

function listBundle(): string[] {
  const out = execFileSync('tar', ['tzf', BUNDLE], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 })
  return out
    .toString()
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

describe('offline-deps/dist.tar.gz — بستهٔ اجرایی', () => {
  const entries = listBundle()

  test.each(REQUIRED)('%s در بسته هست', (entry) => {
    expect(entries).toContain(entry)
  })

  test('هیچ موتور بومی (native engine) در بسته نیست', () => {
    // کلاینت Prisma در این پروژه WASM است؛ ورودِ `.so.node` یعنی بسته به پلتفرمِ
    // سازنده وابسته شده و روی سرور مقصد بار نمی‌شود.
    expect(entries.filter((e) => e.endsWith('.so.node'))).toEqual([])
  })

  test('مهر ساخت با فرمت درست و کامیتِ کامل نوشته شده', () => {
    const stamp = execFileSync('tar', ['-xOzf', BUNDLE, 'dist/BUILD_INFO.json'], {
      cwd: ROOT,
      maxBuffer: 1024 * 1024
    }).toString()
    const info = JSON.parse(stamp) as { commit: string; builtAt: string }

    expect(info.commit).toMatch(/^[a-f0-9]{40}$/)
    expect(Number.isNaN(Date.parse(info.builtAt))).toBe(false)
  })

  test('seed.js همان چیزی است که نصب آفلاین اجرا می‌کند، نه یک فایل خالی', () => {
    const seed = execFileSync('tar', ['-xOzf', BUNDLE, 'dist/seed.js'], {
      cwd: ROOT,
      maxBuffer: 32 * 1024 * 1024
    }).toString()

    expect(seed.length).toBeGreaterThan(500)
    expect(seed).toMatch(/require\(/)
  })

  test('seed داخل بسته واقعاً از prisma/seed.ts ساخته شده، نه یک استابِ خالی', () => {
    // `prisma/seed.ts` منبعِ حقیقت است. نامِ هر ثابت/تابعِ سطح‌بالای آن باید در
    // خروجیِ کامپایل‌شده بماند؛ پس اگر بسته از سورسِ دیگری (یا نسخهٔ قدیمی)
    // ساخته شود، این تست می‌شکند — و بقیهٔ سازگاری از انطباقِ نام‌ها می‌آید.
    const packaged = execFileSync('tar', ['-xOzf', BUNDLE, 'dist/seed.js'], {
      cwd: ROOT,
      maxBuffer: 32 * 1024 * 1024
    }).toString()
    const source = readFileSync(join(ROOT, 'prisma', 'seed.ts'), 'utf8')
    const topLevelNames = [...source.matchAll(/^(?:const|async function|function) (\w+)/gm)].map(
      (m) => m[1]
    )

    expect(topLevelNames.length).toBeGreaterThan(3)
    for (const name of topLevelNames) {
      expect(packaged).toContain(name)
    }
  })
})
