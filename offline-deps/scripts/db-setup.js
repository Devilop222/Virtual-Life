#!/usr/bin/env node
/**
 * سازندهٔ دیتابیس (Database bootstrap)
 * ------------------------------------------------
 * دیتابیس هدف را (اگر وجود ندارد) می‌سازد — فقط با درایور pg و بدون psql.
 *
 * استفاده:  node offline-deps/scripts/db-setup.js [مسیر-ریشه-پروژه] [--url=<آدرس>]
 *
 * آدرس به ترتیب از `--url`، متغیر محیطی `DATABASE_URL` و `.env` خوانده می‌شود؛
 * قاعده و پیام‌هایش در `db-url.js` است (یک منبع، برای همهٔ ابزارها).
 */
'use strict'

const path = require('path')
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
      '۱) برای دیتابیس داخلی:  bash offline-deps/install.sh  (خودش می‌سازد و در .env می‌نویسد)',
      '۲) برای دیتابیس آمادهٔ خودت:  node offline-deps/scripts/db-setup.js . --url=postgresql://user@127.0.0.1:5432/dbname'
    ].join('\n')
  )
  process.exit(1)
}

// کدام آدرس، از کجا — پیش از هر اتصال گفته می‌شود.
console.log(describeSource(resolved))
const conflict = conflictWarning(resolved)
if (conflict) console.log(`   ${conflict}`)

const rawUrl = resolved.url
const url = new URL(rawUrl)
const dbName = decodeURIComponent(url.pathname.replace(/^\//, ''))
const base = {
  host: url.hostname || '127.0.0.1',
  port: url.port ? Number(url.port) : 5432,
  user: decodeURIComponent(url.username) || 'postgres',
  password: decodeURIComponent(url.password) || undefined,
  application_name: 'vl-db-setup'
}
if (url.searchParams.get('sslmode') === 'require' || url.searchParams.get('ssl') === 'true') {
  base.ssl = { rejectUnauthorized: false }
}

async function main() {
  const admin = new Client({ ...base, database: 'postgres' })
  await admin.connect()
  const { rows } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName])
  if (rows.length === 0) {
    await admin.query(`CREATE DATABASE "${dbName.replace(/"/g, '""')}"`)
    console.log(`دیتابیس «${dbName}» ساخته شد.`)
  } else {
    console.log(`دیتابیس «${dbName}» از قبل موجود است.`)
  }
  await admin.end()
}

main().catch((e) => {
  console.error('خطا در ساخت دیتابیس:', e.message)
  const hint = connectionFailureHint(resolved, e)
  if (hint) console.error(`   ${hint}`)
  process.exit(1)
})
