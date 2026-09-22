/**
 * قراردادِ نگهبانِ callback — «هیچ پیشوندی بی‌نگهبان نمی‌ماند».
 *
 * ## حفره‌ای که این آزمون از تکرارش جلوگیری می‌کند
 * نگهبانِ سراسری (`chatPolicyMiddleware`) با «بخش» کار می‌کند: پیشوند → بخش →
 * سیاست محیط + وضعیتِ حساب (فوت/مسدود). هر پیشوندی که در جدولِ نگاشت نباشد،
 * از نگهبان **رد می‌شود**. این یک حفرهٔ واقعی ساخت که در بازبینی پیدا شد:
 * دکمه‌های تأییدِ دومرحله‌ای (`act:go:*`) هیچ بخشی ندارند، پس بازیکنی که پس از
 * دیدنِ صفحهٔ تأیید می‌مرد یا مسدود می‌شد، توکنِ باقی‌مانده را می‌زد و ملک
 * می‌خرید یا شرکت تأسیس می‌کرد.
 *
 * آن نقص رفع شد، ولی *علت* ساختاری باقی می‌ماند: افزودنِ یک پیشوند تازه
 * بی‌صدا از نگهبان رد می‌شود. این آزمون آن را غیرممکن می‌کند — هر پیشوند یا
 * بخش دارد، یا باید در `UNMAPPED_CALLBACK_PREFIXES` با نگهبانِ اعلام‌شده ثبت
 * شود.
 *
 * ## چرا استخراج از سورس و نه از یک فهرست دستی؟
 * چون خطای واقعی «فراموش‌کردن» است. اگر فهرست ورودی‌ها را خودمان نگه داریم،
 * همان فراموشی تکرار می‌شود. آزمون سورس را می‌خواند تا آن‌چه *واقعاً ساخته
 * می‌شود* سنجیده شود.
 */
import { readdirSync } from 'fs'
import { join } from 'path'
import { readText } from './helpers/source'
import {
  CALLBACK_PREFIX_SECTION,
  ENTRY_CALLBACK_SECTION,
  UNMAPPED_CALLBACK_PREFIXES
} from '../src/bot/chat-policy'

const BOT_DIR = join(__dirname, '..', 'src', 'bot')

function botFiles(dir = BOT_DIR, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      botFiles(full, acc)
    } else if (entry.name.endsWith('.ts')) {
      acc.push(full)
    }
  }
  return acc
}

const VALID = /^[a-z_]+$/

/**
 * همهٔ پیشوندهای callback که در لایهٔ ربات ساخته یا شنیده می‌شوند.
 *
 * سه شکلِ واقعیِ کد پوشش داده می‌شود:
 *  ۱. `callback_data: 'x:…'` و قالبِ `` callback_data: `x:${…}` ``
 *  ۲. `callbackQuery(/^x:…/)` و `callbackQuery('x:…')`
 *  ۳. شکلِ دو‌آرگومانیِ کیبورد: `.text('برچسب', 'x:…')`
 */
function emittedPrefixes(content: string): Set<string> {
  const out = new Set<string>()
  const add = (raw: string): void => {
    const prefix = raw.split(':')[0]!.trim()
    if (VALID.test(prefix)) {
      out.add(prefix)
    }
  }

  // ۱) callback_data — رشته یا قالب
  for (const m of content.matchAll(/callback_data:\s*[`'"]([^`'"\n]*)/g)) {
    const value = m[1] ?? ''
    if (value.includes(':') || value.length > 0) {
      add(value)
    }
  }

  // ۲) الگوهای ثبت‌شده روی ربات
  for (const m of content.matchAll(/callbackQuery\(\s*\/\^([a-z_]+)/g)) {
    out.add(m[1]!)
  }
  for (const m of content.matchAll(/callbackQuery\(\s*'([a-z_]+)[:']/g)) {
    out.add(m[1]!)
  }

  // ۳) شکلِ دو‌آرگومانیِ `.text('برچسب', 'x:…')`
  for (const m of content.matchAll(/\.text\(\s*'(?:[^'\\]|\\.)*'\s*,\s*'([a-z_]+):/g)) {
    out.add(m[1]!)
  }

  return out
}

const EMITTED = (() => {
  const all = new Set<string>()
  for (const file of botFiles()) {
    for (const prefix of emittedPrefixes(readText(file))) {
      all.add(prefix)
    }
  }
  return all
})()

describe('قراردادِ نگهبانِ callback', () => {
  test('استخراج‌کننده واقعاً کار می‌کند (وگرنه آزمون بی‌ارزش می‌شد)', () => {
    // یک آزمونِ خالی که صفر پیشوند پیدا کند، همیشه سبز است. این کف، آن
    // حالتِ خطرناک را می‌گیرد.
    expect(EMITTED.size).toBeGreaterThan(30)
    // و چند پیشوندِ شناخته‌شده باید واقعاً دیده شوند.
    expect([...EMITTED]).toEqual(expect.arrayContaining(['bank', 'house', 'act', 'panel', 'adm']))
  })

  test('هر پیشوند یا بخش دارد یا نگهبانِ اعلام‌شده', () => {
    const declared = new Set([
      ...Object.keys(CALLBACK_PREFIX_SECTION),
      ...Object.values(ENTRY_CALLBACK_SECTION).map((key) => key.split(':')[0]!),
      ...Object.keys(UNMAPPED_CALLBACK_PREFIXES)
    ])
    // بخشِ ورودی‌های ENTRY هم پیشوند را پوشش می‌دهد
    for (const entry of Object.keys(ENTRY_CALLBACK_SECTION)) {
      declared.add(entry.split(':')[0]!)
    }

    const orphans = [...EMITTED].filter((prefix) => !declared.has(prefix)).sort()
    expect(orphans).toEqual([])
  })

  test('فهرستِ استثنا کهنه نمی‌شود: هر ورودی واقعاً در کد وجود دارد', () => {
    const stale = Object.keys(UNMAPPED_CALLBACK_PREFIXES)
      .filter((prefix) => !EMITTED.has(prefix))
      .sort()
    // اگر پیشوندی حذف شد، ثبتش هم باید حذف شود؛ وگرنه فهرست به سندی
    // بی‌ربط تبدیل می‌شود که دیگر کسی باورش نمی‌کند.
    expect(stale).toEqual([])
  })

  test('هر پیشوندِ بی‌بخش نگهبان و دلیلِ مکتوب دارد', () => {
    for (const [prefix, entry] of Object.entries(UNMAPPED_CALLBACK_PREFIXES)) {
      expect(`${prefix}: guard`).toBe(`${prefix}: ${entry.guard ? 'guard' : 'MISSING'}`)
      expect(entry.guard.length).toBeGreaterThan(8)
      expect(entry.why.length).toBeGreaterThan(8)
      // و نباید هم‌زمان در جدولِ نگاشت باشد (تناقض).
      expect(CALLBACK_PREFIX_SECTION[prefix]).toBeUndefined()
    }
  })

  test('ادعای نگهبان، در سورس واقعاً وجود دارد', () => {
    // بندِ کلیدیِ این قرارداد: `guard` یک رشتهٔ توصیفی است و به‌تنهایی
    // هیچ‌چیز را تضمین نمی‌کند. اگر کسی بررسیِ وضعیت را از سرویسِ مهارت
    // بردارد، جدول به سندِ دروغ تبدیل می‌شود و همان حفرهٔ `act` دوباره
    // باز می‌شود — این بار بی‌صدا. پس هر ورودی باید نشانیِ نگهبانش را
    // بدهد و همین‌جا در همان فایل جسته شود.
    const root = join(__dirname, '..')
    for (const [prefix, entry] of Object.entries(UNMAPPED_CALLBACK_PREFIXES)) {
      const path = join(root, entry.evidence.file)
      let content: string
      try {
        content = readText(path)
      } catch {
        throw new Error(`پیشوند «${prefix}» به فایلی اشاره می‌کند که وجود ندارد: ${entry.evidence.file}`)
      }
      if (!content.includes(entry.evidence.needle)) {
        throw new Error(
          `نگهبانِ پیشوند «${prefix}» در ${entry.evidence.file} پیدا نشد ` +
            `(دنبال «${entry.evidence.needle}» گشتم). یا نگهبان را برگردان یا ثبتِ این پیشوند را اصلاح کن.`
        )
      }
    }
  })

  test('پیشوندهای بی‌بخشِ حاضر دقیقاً همان ده‌تای بررسی‌شده‌اند', () => {
    const mapped = new Set([
      ...Object.keys(CALLBACK_PREFIX_SECTION),
      ...Object.keys(ENTRY_CALLBACK_SECTION).map((e) => e.split(':')[0]!),
      ...Object.values(ENTRY_CALLBACK_SECTION)
    ])
    const unmapped = [...EMITTED].filter((p) => !mapped.has(p)).sort()
    // فهرست صریح: افزودنِ پیشوندِ بی‌بخشِ تازه این آزمون را قرمز می‌کند و
    // نویسنده را مجبور به تصمیم‌گیری دربارهٔ نگهبانش می‌کند.
    expect(unmapped).toEqual([
      'act',
      'adm',
      'bk',
      'deploy',
      'guide',
      'op',
      'panel',
      'reg',
      'skill',
      'skills'
    ])
    expect(unmapped).toEqual(Object.keys(UNMAPPED_CALLBACK_PREFIXES).sort())
  })
})
