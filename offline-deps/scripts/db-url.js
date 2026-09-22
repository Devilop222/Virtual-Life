#!/usr/bin/env node
/**
 * تصمیمِ «کدام آدرس دیتابیس؟» — یک قاعده، یک جا.
 * ----------------------------------------------------------------
 * چرا این فایل وجود دارد؟ سه ابزار (db-setup، migrate و اسکریپت‌های راستی‌آزمایی)
 * هر کدام قاعدهٔ خودشان را داشتند و هر سه یک اشتباهِ مشترک داشتند:
 *
 *   if (process.env.DATABASE_URL) return   // ← .env خوانده نمی‌شد
 *
 * یعنی یک `export DATABASE_URL=...` در شلِ اپراتور، **بی‌صدا** بر `.env` غلبه
 * می‌کرد. نتیجه‌اش این پیام بود:
 *
 *   خطا در ساخت دیتابیس: connect ECONNREFUSED 127.0.0.1:5433
 *
 * در حالی که نصب‌کننده چند لحظه قبل دیتابیسِ داخلی را روی ۵۴۳۲ ساخته و در
 * `.env` ثبت کرده بود. آن عددِ ۵۴۳۳ هیچ‌جا در کد نبود؛ از محیطِ شل آمده بود.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  قاعدهٔ نهایی (ترتیب قطعی)
 * ─────────────────────────────────────────────────────────────────────────────
 *   ۱. `--url=<conn>`  — صریح‌ترین. نصب‌کننده همیشه همین را می‌دهد.
 *   ۲. `DATABASE_URL`  — متغیر محیطی (رابطهٔ اسکریپت‌های راستی‌آزمایی روی
 *      دیتابیسِ آزمایشی به همین وابسته است و حفظ می‌شود).
 *   ۳. `.env` پروژه    — آدرسِ ثبت‌شدهٔ نصب.
 *
 * تفاوت مهم با قبل: منبعِ انتخاب‌شده **گزارش** می‌شود. اگر متغیر محیطی با
 * `.env` فرق داشته باشد، هشدار داده می‌شود تا اپراتور بفهمد کدام آدرس هدف
 * است؛ سکوت، همان چیزی بود که عیب‌یابی را غیرممکن می‌کرد.
 */
'use strict'

const fs = require('fs')
const path = require('path')

/** نشانیِ بی‌رمز: هرگز رمز عبور را در پیام یا لاگ چاپ نکن. */
function describeDatabase(rawUrl) {
  try {
    const url = new URL(rawUrl)
    const user = decodeURIComponent(url.username) || '(بدون کاربر)'
    const port = url.port || '5432'
    const db = decodeURIComponent(url.pathname.replace(/^\//, '')) || '(بدون نام)'
    return { user, host: url.hostname || '127.0.0.1', port: Number(port), database: db }
  } catch {
    return null
  }
}

/** آیا آدرس به همین ماشین اشاره می‌کند؟ (بکاپ/بازیابی محلی معنا دارد) */
function isLocalUrl(rawUrl) {
  const info = describeDatabase(rawUrl)
  if (!info) return false
  return info.host === '127.0.0.1' || info.host === 'localhost' || info.host === '::1'
}

/** مقدار یک کلید از فایل `.env` — بدون وابستگی به dotenv. */
function readDotEnvValue(envFile, key) {
  try {
    if (!fs.existsSync(envFile)) return null
    for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
      if (!match || match[1] !== key) continue
      const value = match[2].replace(/^["']|["']$/g, '').trim()
      return value === '' ? null : value
    }
    return null
  } catch {
    return null
  }
}

/** `--url=...` یا `--url ...` از آرگومان‌های خط فرمان. */
function explicitUrlFromArgv(argv) {
  for (let i = 0; i < argv.length; i++) {
    const arg = String(argv[i])
    if (arg.startsWith('--url=')) {
      const value = arg.slice('--url='.length).trim()
      return value === '' ? null : value
    }
    if (arg === '--url' && argv[i + 1]) {
      const value = String(argv[i + 1]).trim()
      return value === '' ? null : value
    }
  }
  return null
}

/**
 * آدرسِ مؤثر + منبعش.
 *
 * @returns {{ url: string|null, source: 'argument'|'environment'|'dotenv'|null,
 *             conflict: { env: string, dotenv: string }|null, envFile: string }}
 */
function resolveDatabaseUrl(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || process.argv[2] || '.')
  const envFile = options.envFile || path.join(repoRoot, '.env')
  const argv = options.argv || process.argv

  const explicit = explicitUrlFromArgv(argv)
  if (explicit) {
    return { url: explicit, source: 'argument', conflict: null, envFile }
  }

  const fromEnv = (process.env.DATABASE_URL || '').trim()
  const fromDotEnv = readDotEnvValue(envFile, 'DATABASE_URL')

  if (fromEnv) {
    // همین‌جا چیزی گفته می‌شود که پیش‌تر پنهان بود: دو منبع، دو جواب مختلف.
    const conflict =
      fromDotEnv && fromDotEnv !== fromEnv ? { env: fromEnv, dotenv: fromDotEnv } : null
    return { url: fromEnv, source: 'environment', conflict, envFile }
  }
  if (fromDotEnv) {
    return { url: fromDotEnv, source: 'dotenv', conflict: null, envFile }
  }
  return { url: null, source: null, conflict: null, envFile }
}

const SOURCE_LABELS = {
  argument: 'آرگومان --url (صریح‌ترین منبع)',
  environment: 'متغیر محیطی DATABASE_URL',
  dotenv: 'فایل .env پروژه'
}

/** یک خطِ خوانا: «هدف: user@host:port/db — از متغیر محیطی». */
function describeSource(resolved) {
  if (!resolved.url) return 'هیچ آدرسی پیدا نشد'
  const info = describeDatabase(resolved.url)
  const where = SOURCE_LABELS[resolved.source] || 'منبع نامشخص'
  if (!info) return `آدرس نامعتبر — از ${where}`
  return `هدف: ${info.user}@${info.host}:${info.port}/${info.database} — از ${where}`
}

/** هشدارِ تعارضِ دو منبع (بدون چاپ رمز). */
function conflictWarning(resolved) {
  if (!resolved.conflict) return null
  const env = describeDatabase(resolved.conflict.env)
  const dotenv = describeDatabase(resolved.conflict.dotenv)
  const fmt = (info) => (info ? `${info.host}:${info.port}/${info.database}` : 'نامعتبر')
  return [
    `دو آدرسِ متفاوت پیدا شد: متغیر محیطی → ${fmt(env)} ولی .env → ${fmt(dotenv)}.`,
    `همین حالا از ${SOURCE_LABELS[resolved.source]} استفاده می‌شود.`,
    'اگر آدرسِ .env را می‌خواهی، متغیر را پاک کن: unset DATABASE_URL'
  ].join('\n   ')
}

/**
 * راهنمای شکستِ اتصال.
 *
 * پیامِ خامِ درایور (`connect ECONNREFUSED 127.0.0.1:5433`) هیچ‌وقت نمی‌گوید
 * این عدد از کجا آمده؛ همان چیزی که عیب‌یابیِ نصب را ساعت‌ها طول می‌داد.
 */
function connectionFailureHint(resolved, error) {
  const info = resolved && resolved.url ? describeDatabase(resolved.url) : null
  const lines = []
  if (info) {
    lines.push(`آدرسِ هدف: ${info.user}@${info.host}:${info.port}/${info.database}`)
  }
  if (resolved && resolved.source) {
    lines.push(`منبعِ آدرس: ${SOURCE_LABELS[resolved.source]}`)
  }
  const code = (error && error.code) || ''
  if (code === 'ECONNREFUSED' || /ECONNREFUSED/.test(String(error && error.message))) {
    lines.push(
      info && info.port !== 5432
        ? `روی پورتِ ${info.port} کسی گوش نمی‌دهد. اگر دیتابیسِ داخلیِ بازی را می‌خواهی، پورتِ درست ۵۴۳۲ است (مقدارِ .env همان است).`
        : 'روی این پورت کسی گوش نمی‌دهد؛ PostgreSQL بالا نیست.',
      '۱) اگر می‌خواهی نصب‌کننده دیتابیسِ خودش را بسازد:  unset DATABASE_URL  و بعد  bash offline-deps/install.sh',
      '۲) اگر دیتابیسِ دیگری را هدف گرفته‌ای: مطمئن شو همان پورت در حال اجراست، یا آدرس را صریح بده:  --url=postgresql://…'
    )
  }
  if (code === '28P01' || /password authentication failed/i.test(String(error && error.message))) {
    lines.push('نام کاربری/رمز با این دیتابیس نمی‌خواند؛ آدرسِ درست را در .env بگذار.')
  }
  if (code === '3D000' || /database .* does not exist/i.test(String(error && error.message))) {
    lines.push('نامِ دیتابیس وجود ندارد؛ ابتدا db-setup را اجرا کن تا ساخته شود.')
  }
  return lines.join('\n   ')
}

module.exports = {
  describeDatabase,
  isLocalUrl,
  readDotEnvValue,
  explicitUrlFromArgv,
  resolveDatabaseUrl,
  describeSource,
  conflictWarning,
  connectionFailureHint,
  SOURCE_LABELS
}

// اجرای مستقیم: گزارشِ کوتاهِ «الان کدام آدرس هدف است؟» (بدون اتصال).
if (require.main === module) {
  const rest = process.argv.slice(2)
  // اولین آرگومانِ غیرسوییچ، ریشهٔ پروژه است؛ `--url=...` آدرس را می‌دهد.
  const repoRoot = rest.find((arg) => !String(arg).startsWith('--'))
  const resolved = resolveDatabaseUrl({ repoRoot, argv: rest })
  console.log(describeSource(resolved))
  const warning = conflictWarning(resolved)
  if (warning) console.log(`   ${warning}`)
  if (!resolved.url) {
    console.error('DATABASE_URL پیداشدنی نبود (نه در محیط، نه --url، نه .env)')
    process.exit(1)
  }
}
