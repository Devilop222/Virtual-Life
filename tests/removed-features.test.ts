/**
 * «بورس شهر» و «مزرعه» حذف شده‌اند — این آزمون تضمین می‌کند برنگردند.
 *
 * چرا آزمون و نه فقط یک کامیت؟ چون این دو سیستم در ۱۷ فایل پخش بودند (سرویس،
 * کیبورد، callback، راهنما، کاتالوگ، سیاست محیط، میراث، پنل ادمین). یک بازگشتِ
 * نصفه‌کاره — مثلاً برگشتنِ دکمه بدون سرویس — بدتر از نبودنشان است: بازیکن
 * دکمه‌ای می‌بیند که هیچ کاری نمی‌کند.
 *
 * نکتهٔ عمدی: مقادیرِ enum و برچسب‌های دفتر کل *باید* بمانند، چون ردیف‌های
 * تاریخیِ همان انواع در دیتابیس هستند و خواندنشان به آن برچسب‌ها وابسته است.
 */
import { readdirSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { readText } from './helpers/source'

const ROOT = join(__dirname, '..')
const SRC = join(ROOT, 'src')

function sourceFiles(dir = SRC, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) sourceFiles(full, acc)
    else if (entry.name.endsWith('.ts')) acc.push(full)
  }
  return acc
}

const SCHEMA = readText(join(ROOT, 'prisma', 'schema.prisma'))

describe('حذف کاملِ کد — هیچ مسیری باقی نمانده', () => {
  test('سرویس‌ها و پوشه‌هایشان رفته‌اند', () => {
    expect(existsSync(join(SRC, 'modules', 'stock'))).toBe(false)
    expect(existsSync(join(SRC, 'modules', 'farm'))).toBe(false)
  })

  test('هیچ فایل سورسی به callbackها، سرویس‌ها یا مدل‌ها اشاره نمی‌کند', () => {
    const forbidden = [
      /stk:/,
      /farm:/,
      /StockService/,
      /FarmService/,
      /stockService/,
      /farmService/,
      /stockHolding/,
      /farmPlot/,
      /buildStockKeyboard/,
      /buildFarmKeyboard/,
      /renderStockPanel/,
      /renderFarmPanel/
    ]
    const leaks: string[] = []
    for (const file of sourceFiles()) {
      const content = readText(file)
      for (const pattern of forbidden) {
        if (pattern.test(content)) leaks.push(`${file} :: ${pattern}`)
      }
    }
    expect(leaks).toEqual([])
  })

  test('بخش‌ها، کلیدواژه‌ها و سیاست محیط پاک شده‌اند', () => {
    const catalog = readText(join(SRC, 'bot', 'command-catalog.ts'))
    const policy = readText(join(SRC, 'bot', 'chat-policy.ts'))
    expect(catalog).not.toMatch(/stocks|farm|بورس|سهام|مزرعه|باغچه|کشاورزی/)
    expect(policy).not.toMatch(/'stk|'farm|stocks|farm/)
  })

  test('راهنما و راهنمای شروع وعدهٔ حذف‌شده نمی‌دهند', () => {
    const help = readText(join(SRC, 'bot', 'help-content.ts'))
    const guide = readText(join(SRC, 'bot', 'start-guide.ts'))
    expect(help).not.toMatch(/بورس|سهام|مزرعه|باغچه|کشاورزی/)
    expect(guide).not.toMatch(/بورس|سهام|مزرعه/)
  })

  test('مدل‌ها از اسکیما و از کلاینتِ تولیدشده رفته‌اند', () => {
    expect(SCHEMA).not.toMatch(/model StockHolding|model FarmPlot/)
    expect(SCHEMA).not.toMatch(/stock_holdings|farm_plots/)

    const embedded = readText(join(ROOT, 'node_modules', '.prisma', 'client', 'schema.prisma'))
    expect(embedded).not.toMatch(/model StockHolding|model FarmPlot/)
  })
})

describe('Migration — حذفِ جدول‌ها با سند، و حفظِ تاریخچه', () => {
  const migrationPath = join(
    ROOT,
    'prisma',
    'migrations',
    '20260920000000_remove_stock_market_and_farm',
    'migration.sql'
  )
  const sql = readFileSync(migrationPath, 'utf8')

  test('هر دو جدول با DROP صریح حذف می‌شوند', () => {
    expect(sql).toMatch(/DROP TABLE IF EXISTS "stock_holdings"/)
    expect(sql).toMatch(/DROP TABLE IF EXISTS "farm_plots"/)
  })

  test('مقدارهای enum عمداً حفظ می‌شوند (خواندنِ ردیف‌های تاریخی)', () => {
    // اگر روزی کسی این‌ها را «پاک‌سازی» کند، دفتر کلِ گذشته ناخوانا می‌شود.
    expect(SCHEMA).toContain('STOCK_BUY')
    expect(SCHEMA).toContain('FARM_HARVEST')
    const ledger = readText(join(SRC, 'modules', 'finance', 'ledger.service.ts'))
    expect(ledger).toContain("STOCK_BUY: 'خرید سهام'")
    expect(ledger).toContain("FARM_PLANT: 'کاشت محصول'")
    // و درآمدی‌بودنِ آن‌ها برای ممیزیِ گذشته هم دست‌نخورده می‌ماند.
    expect(ledger).toContain('TransactionType.STOCK_SELL')
    expect(ledger).toContain('TransactionType.FARM_HARVEST')
  })

  test('هیچ پولی در جریانِ حذف ساخته یا نابود نمی‌شود', () => {
    // قاعده: کاشت/خرید قبلاً Sink شده بود؛ پسوداندن = MINT بی‌سند.
    expect(sql).not.toMatch(/UPDATE\s+"players"/i)
    expect(sql).not.toMatch(/INSERT INTO/i)
  })
})
