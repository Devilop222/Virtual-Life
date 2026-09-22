#!/usr/bin/env node
/**
 * بررسی هم‌خوانیِ کلاینتِ Prisma داخل بستهٔ آفلاین با اسکیمای مخزن.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * چرا این اسکریپت وجود دارد؟
 *
 * `prisma generate` فقط در `offline-deps/packaging.sh` (روی دستگاهِ سازنده)
 * اجرا می‌شود؛ `install.sh` روی سرور فقط `node_modules-linux.tar.gz` را باز
 * می‌کند و بعد صرفاً با `require('@prisma/client')` چک می‌کند ماژول *بار می‌شود*.
 * آن بررسی، سکیما را نمی‌سنجد. پس اگر بسته با اسکیمای کهنه ساخته شده باشد،
 * هیچ خطایی در زمان نصب دیده نمی‌شود و سرور بی‌صدا کدی اجرا می‌کند که کلاینتش
 * نمی‌فهمد — «مدلِ ناشناخته» یا «Unknown argument» فقط وقتی رخ می‌دهد که
 * بازیکن به آن مسیر برسد.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * سه سنجهٔ مستقل
 *
 *  ۱. متنی: کلاینتِ تولیدشده یک نسخهٔ *واژه‌به‌واژه* از `schema.prisma` را کنار
 *     خود نگه می‌دارد (`.prisma/client/schema.prisma`). مقایسهٔ آن با
 *     `prisma/schema.prisma` یک اثباتِ بایتی است.
 *  ۲. مدل و enum: با وابستگی‌های *خودِ بسته* یک فرزند اجرا می‌شود و
 *     `Prisma.ModelName` و مقادیرِ هر enum را زنده می‌خواند.
 *  ۳. ستون: همان فرزند `Prisma.<Model>ScalarFieldEnum` را می‌خواند تا ستونِ
 *     تازه‌ای که کلاینت نمی‌شناسد هم گرفته شود (رایج‌ترین تغییرِ اسکیما).
 *
 * هیچ دیتابیسی لازم نیست، هیچ اینترنتی لازم نیست و هیچ چیزی نوشته نمی‌شود.
 * کدِ خروج: ۰ = هم‌خوان، ۱ = کهنه.
 *
 * اجرا: node scripts/offline-client-parity-check.cjs [مسیر بستهٔ node_modules-linux.tar.gz]
 *
 * بدون آرگومان، بستهٔ استانداردِ مخزن سنجیده می‌شود. با آرگومان می‌توان هر
 * آرشیوی را سنجید — همین راه، سنجه را *قابل‌آزمودن* می‌کند: می‌توان بستهٔ کهنهٔ
 * قدیمی را روی همین اسکریپت انداخت و دید که واقعاً FAIL می‌دهد.
 */
'use strict'

const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const sourceSchemaPath = path.join(root, 'prisma', 'schema.prisma')
const repoSchemaPath = path.join(root, 'node_modules', '.prisma', 'client', 'schema.prisma')
const bundlePath = process.argv[2]
  ? path.resolve(process.cwd(), process.argv[2])
  : path.join(root, 'offline-deps', 'node_modules-linux.tar.gz')

const SCALAR_TYPES = new Set([
  'String',
  'Int',
  'BigInt',
  'Float',
  'Decimal',
  'Boolean',
  'DateTime',
  'Json',
  'Bytes'
])

/**
 * مسیرِ سازگار با tar.
 *
 * روی ویندوز `os.tmpdir()` مسیری مثل `C:\\Users\\…\\Temp\\x` می‌دهد و tarِ Git
 * Bash از آن سر در نمی‌آورد («Error is not recoverable») و هیچ‌چیز باز نمی‌کند.
 */
function toTarPath(p) {
  if (process.platform !== 'win32') return p
  const drive = /^([A-Za-z]):[\\/](.*)$/.exec(p)
  if (!drive) return p
  return `/${drive[1].toLowerCase()}/${drive[2].replace(/\\/g, '/')}`
}

/** مدل‌ها، enumها و ستون‌های اسکالرِ اعلام‌شده در اسکیمای مخزن. */
function parseSchema(text) {
  const models = new Map()
  const enums = new Map()
  let current = null

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\/\/.*$/, '').trim()
    if (line.length === 0) continue

    const model = /^model\s+(\w+)\s*\{/.exec(line)
    if (model) {
      current = { kind: 'model', name: model[1], fields: [] }
      models.set(current.name, current)
      continue
    }
    const enumMatch = /^enum\s+(\w+)\s*\{/.exec(line)
    if (enumMatch) {
      current = { kind: 'enum', name: enumMatch[1] }
      enums.set(current.name, [])
      continue
    }
    if (line === '}') {
      current = null
      continue
    }
    if (!current) continue

    if (current.kind === 'enum') {
      if (/^\w+$/.test(line)) enums.get(current.name).push(line)
      continue
    }

    if (line.startsWith('@@')) continue
    const parts = line.split(/\s+/)
    const baseType = (parts[1] ?? '').replace(/[?[\]]/g, '')
    if (parts.length >= 2) current.fields.push({ name: parts[0], baseType })
  }

  // ستونِ اسکالر = فیلدی که نوعش یکی از نوع‌های اسکالرِ Prisma است.
  // فیلدِ رابطه نوعش نامِ یک مدل است و فیلدِ enum نوعش نامِ یک enum؛ هیچ‌کدام
  // در `ScalarFieldEnum` نمی‌آیند، پس همین شرط دقیقاً همان مجموعه را می‌دهد.
  const scalars = new Map()
  for (const [name, model] of models) {
    scalars.set(name, model.fields.filter((f) => SCALAR_TYPES.has(f.baseType)).map((f) => f.name))
  }

  return { models: [...models.keys()].sort(), enums, scalars }
}

/** خواندنِ زندهٔ رجیستریِ کلاینتِ داخل بسته — با وابستگی‌های خودِ بسته. */
function probeBundleClient(work) {
  const probe = path.join(work, 'client-parity-probe.cjs')
  fs.writeFileSync(
    probe,
    `'use strict'
const client = require('@prisma/client')

// مدل‌ها: Prisma.ModelName رجیستریِ رسمیِ مدل‌هاست.
const models = Object.keys(client.Prisma.ModelName ?? {}).sort()

// ستون‌های اسکالرِ هر مدل از ScalarFieldEnum همان مدل خوانده می‌شود.
const scalars = {}
for (const model of models) {
  const registry = client.Prisma[model + 'ScalarFieldEnum']
  scalars[model] = registry ? Object.keys(registry).sort() : []
}

// enumها در این نسخهٔ Prisma Named Export اند (نه پراپرتیِ Prisma).
// شکلِ یکتای آن‌ها: هر کلید به رشتهٔ هم‌نامِ خودش نگاشت می‌شود.
const enums = {}
for (const [name, value] of Object.entries(client)) {
  if (name === 'Prisma' || name === 'PrismaClient') continue
  if (!value || typeof value !== 'object' || Array.isArray(value)) continue
  const keys = Object.keys(value)
  if (keys.length > 0 && keys.every((k) => value[k] === k)) {
    enums[name] = keys.sort()
  }
}
process.stdout.write(JSON.stringify({ models, enums, scalars }))
`
  )

  const run = spawnSync(process.execPath, [probe], {
    cwd: work,
    encoding: 'utf8',
    env: { ...process.env, NODE_PATH: path.join(work, 'node_modules') }
  })

  if (run.status !== 0) {
    throw new Error(`پروبِ کلاینتِ بسته شکست خورد:\n${run.stderr || run.stdout}`)
  }
  return JSON.parse(run.stdout)
}

/**
 * اثباتِ زمانِ اجرا: با کلاینتِ *خودِ بسته* مسیرهایی که کدِ `src` واقعاً صدا
 * می‌زند اجرا می‌شود تا دیده شود ناسازگاری فقط یک واقعیتِ متنی نیست، بلکه
 * خطای واقعی می‌دهد. اعتبارسنجیِ Prisma *پیش از* اتصال انجام می‌شود، پس بدون
 * دیتابیس هم نتیجه قابل‌اعتماد است.
 */
function proveRuntimeImpact(work, missing) {
  const probe = path.join(work, 'runtime-impact-probe.cjs')
  fs.writeFileSync(
    probe,
    `'use strict'
const { PrismaClient, TransactionType } = require('@prisma/client')
const { PrismaPg } = require('@prisma/adapter-pg')

async function main() {
  const out = []
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: 'postgresql://probe:probe@127.0.0.1:1/probe' })
  })

  const model = ${JSON.stringify(missing.model ?? null)}
  const column = ${JSON.stringify(missing.column ?? null)}
  const enumValue = ${JSON.stringify(missing.enumValue ?? null)}

  if (model) {
    const delegate = db[model.charAt(0).toLowerCase() + model.slice(1)]
    out.push('مدلِ «' + model + '» روی کلاینتِ بسته: ' + typeof delegate)
  }
  if (column) {
    const [m, field] = column.split('.')
    const delegate = db[m.charAt(0).toLowerCase() + m.slice(1)]
    try {
      await delegate.findFirst({ select: { [field]: true } })
      out.push('ستونِ «' + column + '»: خطایی نگرفت (غیرمنتظره)')
    } catch (error) {
      out.push('ستونِ «' + column + '»: ' + error.constructor.name)
    }
  }
  if (enumValue) {
    const raw = TransactionType.PROJECT_DONATION
    out.push('TransactionType.PROJECT_DONATION روی کلاینتِ بسته = ' + String(raw))
    try {
      await db.financialTransaction.create({
        data: { amount: 1, type: raw, sourcePlayerId: 'probe' }
      })
      out.push('نوشتنِ آن enum: خطایی نگرفت (غیرمنتظره)')
    } catch (error) {
      out.push('نوشتنِ آن enum: ' + error.constructor.name)
    }
  }

  await db.$disconnect().catch(() => undefined)
  process.stdout.write(out.join('\\n'))
}

main().catch((error) => {
  process.stdout.write('probe failed: ' + String(error && error.message))
})
`
  )

  const run = spawnSync(process.execPath, [probe], {
    cwd: work,
    encoding: 'utf8',
    env: { ...process.env, NODE_PATH: path.join(work, 'node_modules') },
    timeout: 60_000
  })
  const output = (run.stdout || '').trim()
  if (output.length > 0) {
    console.log('\nاثباتِ زمانِ اجرا (با کلاینتِ خودِ بسته):')
    for (const line of output.split('\n')) console.log(`    ${line}`)
  }
}

function main() {
  const schema = parseSchema(fs.readFileSync(sourceSchemaPath, 'utf8'))
  let failed = false

  // ── سنجهٔ صفر: محیطِ توسعهٔ خودمان هم نباید کهنه باشد (کنترلِ منفی) ──
  if (fs.existsSync(repoSchemaPath)) {
    const same =
      fs.readFileSync(repoSchemaPath, 'utf8').trim() ===
      fs.readFileSync(sourceSchemaPath, 'utf8').trim()
    console.log(
      same
        ? '✓ کلاینتِ node_modules مخزن با schema.prisma هم‌خوان است'
        : '✗ کلاینتِ node_modules مخزن کهنه است — اول «prisma generate» را اجرا کن'
    )
    if (!same) failed = true
  }

  if (!fs.existsSync(bundlePath)) {
    console.error(`✗ بستهٔ آفلاین پیدا نشد: ${bundlePath}`)
    process.exit(1)
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-parity-'))
  process.on('exit', () => fs.rmSync(work, { recursive: true, force: true }))

  // tar ممکن است به‌خاطر نمادهای .bin کدِ خروج غیرصفر بدهد؛ معیار، خودِ کلاینت است.
  const untar = spawnSync(
    'tar',
    ['--no-same-owner', '-xzf', toTarPath(bundlePath), '-C', toTarPath(work)],
    { encoding: 'utf8' }
  )
  if (untar.error) {
    console.error(`✗ اجرای tar ممکن نشد: ${untar.error.message}`)
    process.exit(1)
  }

  // ── سنجهٔ ۱: متنی ──
  const bundleSchemaPath = path.join(work, 'node_modules', '.prisma', 'client', 'schema.prisma')
  if (!fs.existsSync(bundleSchemaPath)) {
    console.error('✗ اسکیمای جاسازی‌شده در کلاینتِ بسته پیدا نشد؛ بسته سالم نیست.')
    process.exit(1)
  }
  const textSame =
    fs.readFileSync(bundleSchemaPath, 'utf8').trim() ===
    fs.readFileSync(sourceSchemaPath, 'utf8').trim()
  console.log(
    textSame
      ? '✓ اسکیمای جاسازی‌شده در بسته واژه‌به‌واژه با prisma/schema.prisma یکسان است'
      : '✗ اسکیمای جاسازی‌شده در بسته با prisma/schema.prisma فرق دارد'
  )
  if (!textSame) failed = true

  // ── سنجهٔ ۲ و ۳: مدل، ستون و enum روی کلاینتِ زندهٔ بسته ──
  const live = probeBundleClient(work)
  const liveModels = new Set(live.models)

  const missingModels = schema.models.filter((m) => !liveModels.has(m))
  console.log(
    missingModels.length === 0
      ? `✓ هر ${schema.models.length} مدلِ اسکیما در کلاینتِ بسته هست`
      : `✗ ${missingModels.length} مدل در کلاینتِ بسته نیست: ${missingModels.join(', ')}`
  )
  if (missingModels.length > 0) failed = true

  const missingColumns = []
  for (const [model, fields] of schema.scalars) {
    if (!liveModels.has(model)) continue
    const liveFields = new Set(live.scalars[model] ?? [])
    const missing = fields.filter((f) => !liveFields.has(f))
    if (missing.length > 0) missingColumns.push(`${model}: ${missing.join(', ')}`)
  }
  console.log(
    missingColumns.length === 0
      ? '✓ ستون‌های اسکالرِ همهٔ مدل‌ها در کلاینتِ بسته هست'
      : `✗ ستون‌های غایب در کلاینتِ بسته:\n    ${missingColumns.join('\n    ')}`
  )
  if (missingColumns.length > 0) failed = true

  const missingEnumValues = []
  for (const [name, values] of schema.enums) {
    const liveValues = new Set(live.enums[name] ?? [])
    if (liveValues.size === 0) {
      missingEnumValues.push(`${name} (کلِ enum)`)
      continue
    }
    const missing = values.filter((v) => !liveValues.has(v))
    if (missing.length > 0) missingEnumValues.push(`${name}: ${missing.join(', ')}`)
  }
  console.log(
    missingEnumValues.length === 0
      ? `✓ هر ${schema.enums.size} enumِ اسکیما با مقادیرش در کلاینتِ بسته هست`
      : `✗ مقادیرِ غایبِ enum در کلاینتِ بسته:\n    ${missingEnumValues.join('\n    ')}`
  )
  if (missingEnumValues.length > 0) failed = true

  if (failed) {
    proveRuntimeImpact(work, {
      model: missingModels[0] ?? null,
      column: missingColumns[0] ? missingColumns[0].split(': ')[0] + '.' + missingColumns[0].split(': ')[1].split(',')[0] : null,
      enumValue: missingEnumValues.length > 0
    })
    console.error(
      '\nنتیجه: کلاینتِ Prisma داخل بستهٔ آفلاین با اسکیمای مخزن هم‌خوان نیست.\n' +
        'روی سرورِ بدون اینترنت هیچ‌چیز این را درست نمی‌کند (install.sh کلاینت را ' +
        'بازتولید نمی‌کند). راهِ درست: بستهٔ کلاینت را با اسکیمای فعلی بازسازی و ' +
        'دوباره کامیت کن.'
    )
    process.exit(1)
  }

  console.log('\nPASS: کلاینتِ Prisma داخل بستهٔ آفلاین با اسکیمای مخزن هم‌خوان است.')
}

try {
  main()
} catch (error) {
  console.error(`✗ ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
