#!/usr/bin/env node
/**
 * مهاجرت‌ساز آفلاین (Offline migration runner)
 * ------------------------------------------------
 * مهاجرت‌های prisma/migrations را به‌ترتیب با درایور pg اعمال می‌کند —
 * بدون نیاز به هیچ موتور باینری Prisma؛ روی x64 و arm64 یکسان کار می‌کند.
 *
 * ثبت وضعیت در جدول _prisma_migrations با فرمت دقیق Prisma 6.19 انجام می‌شود
 * تا همواره با دستورهای خط فرمان Prisma (CLI) سازگار بماند.
 *
 * استفاده:  node offline-deps/scripts/migrate.js [مسیر-ریشه-پروژه] [--url=<آدرس>]
 *
 * آدرس به ترتیب از `--url`، متغیر محیطی `DATABASE_URL` و `.env` خوانده می‌شود؛
 * قاعده و پیام‌هایش در `db-url.js` است (یک منبع، برای همهٔ ابزارها) — تا مهاجرت
 * هرگز بی‌صدا روی دیتابیسِ اشتباهی اجرا نشود.
 */
'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { Client } = require('pg')
const {
  resolveDatabaseUrl,
  describeSource,
  conflictWarning,
  connectionFailureHint
} = require('./db-url')

const repoRootArg = process.argv.slice(2).find((arg) => !String(arg).startsWith('--'))
const repoRoot = path.resolve(repoRootArg || '.')
const resolved = resolveDatabaseUrl({ repoRoot })

if (!resolved.url) {
  console.error(
    [
      'آدرس دیتابیس پیداشدنی نبود — نه --url، نه متغیر محیطی DATABASE_URL و نه .env.',
      'برای دیتابیس داخلی:  bash offline-deps/install.sh  |  برای دیتابیس آماده:  --url=postgresql://…'
    ].join('\n')
  )
  process.exit(1)
}

const connectionString = resolved.url
// کدام آدرس، از کجا — پیش از هر مهاجرت گفته می‌شود. مهاجرت روی دیتابیسِ اشتباه
// برگشت‌پذیر نیست، پس این یک خط هیچ‌وقت «پرگویی» نیست.
console.log(describeSource(resolved))
const conflict = conflictWarning(resolved)
if (conflict) console.log(`   ${conflict}`)

const migrationsDir = path.join(repoRoot, 'prisma', 'migrations')
if (!fs.existsSync(migrationsDir)) {
  console.error('پوشهٔ مهاجرت‌ها پیدا نشد:', migrationsDir)
  process.exit(1)
}

// نام‌ها پیشوند زمانی (YYYYMMDDHHMMSS_...) دارند؛ مرتب کردن لکسیکافیکی = ترتیب اجرا
const migrations = fs
  .readdirSync(migrationsDir)
  .filter((n) => {
    const p = path.join(migrationsDir, n)
    return fs.statSync(p).isDirectory() && fs.existsSync(path.join(p, 'migration.sql'))
  })
  .sort()

async function main() {
  const client = new Client({ connectionString, application_name: 'vl-migrate' })
  await client.connect()

  // جدول دفترچهٔ حساب مهاجرت‌ها (فرمت دقیق Prisma 6.19)
  await client.query(
    `CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
       "id" varchar(36) NOT NULL,
       "checksum" varchar(64) NOT NULL,
       "finished_at" timestamp with time zone,
       "migration_name" varchar(255) NOT NULL,
       "logs" text,
       "rolled_back_at" timestamp with time zone,
       "started_at" timestamp with time zone NOT NULL DEFAULT now(),
       "applied_steps_count" integer NOT NULL DEFAULT 0,
       CONSTRAINT "_prisma_migrations_pkey" PRIMARY KEY ("id")
     )`
  )

  const failed = await client.query(
    'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL'
  )
  if (failed.rows.length > 0) {
    console.error('مهاجرت ناقص/ناموفق از قبل در دیتابیس ثبت شده — ابتدا دستی حل کنید:', failed.rows.map((r) => r.migration_name).join(', '))
    process.exit(1)
  }

  const applied = new Set(
    (
      await client.query('SELECT migration_name FROM _prisma_migrations WHERE rolled_back_at IS NULL')
    ).rows.map((r) => r.migration_name)
  )

  let count = 0
  for (const name of migrations) {
    if (applied.has(name)) continue
    const sqlFile = path.join(migrationsDir, name, 'migration.sql')
    // BOM احتمالی را حذف کن (PG 18 آن را می‌پذیرد نه؛ ریشهٔ مشکل قبلی)
    const sql = fs.readFileSync(sqlFile, 'utf8').replace(/^\uFEFF/, '')
    const checksum = crypto.createHash('sha256').update(sql, 'utf8').digest('hex')
    const id = crypto.randomUUID()
    const now = new Date().toISOString()

    console.log(`اعمال مهاجرت: ${name}`)
    await client.query('BEGIN')
    try {
      // پروتکل سادهٔ pg: اجرای چندگانهٔ دستورها در یک تراکنش
      await client.query(sql)
      await client.query(
        `INSERT INTO "_prisma_migrations"
           (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 1)`,
        [id, checksum, now, name, null, null, now]
      )
      await client.query('COMMIT')
      count++
    } catch (e) {
      await client.query('ROLLBACK')
      console.error(`\nخطا در مهاجرت ${name} (همهٔ تغییرات این مهاجرت خنثی شد):\n${e.message}`)
      process.exit(1)
    }
  }

  if (count > 0) {
    console.log(`مهاجرت‌ها با موفقیت اعمال شد (${count} مورد).`)
  } else {
    console.log('دیتابیس به‌روز است — مهاجرت جدیدی وجود ندارد.')
  }
  await client.end()
}

main().catch((e) => {
  console.error('خطای مهاجرت:', e.message)
  const hint = connectionFailureHint(resolved, e)
  if (hint) console.error(`   ${hint}`)
  process.exit(1)
})
