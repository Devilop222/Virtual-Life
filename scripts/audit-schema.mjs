// ممیزی اسکیما ↔ مهاجرت‌ها ↔ دیتابیس
// این اسکریپت موقت است و در گیت کامیت نمی‌شود (پوشه scripts در .gitignore نیست،
// اما صرفاً ابزار بررسی است؛ در صورت نیاز حذف می‌شود).
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

const ROOT = process.cwd()
const schema = readFileSync(join(ROOT, 'prisma/schema.prisma'), 'utf8')

const SCALAR_TYPES = new Set([
  'String', 'Int', 'BigInt', 'Boolean', 'DateTime', 'Decimal', 'Json', 'Float'
])

// استخراج نام مدل‌ها و enum ها
const modelNames = new Set()
for (const m of schema.matchAll(/^model\s+(\w+)\s*\{/gm)) modelNames.add(m[1])
const enumNames = new Set()
for (const m of schema.matchAll(/^enum\s+(\w+)\s*\{/gm)) enumNames.add(m[1])

// ستون‌های هر مدل (نام فیزیکی ستون بعد از @map یا خود نام فیلد)
function columnsOfModel(modelName) {
  const start = schema.indexOf(`model ${modelName} {`)
  const body = schema.slice(start, schema.indexOf('\n}', start))
  const out = new Map() // fieldName -> columnName
  for (const line of body.split('\n')) {
    const f = line.match(/^\s*(\w+)\s+(\w+)(\[\])?([?])?(?:\s.*)?$/)
    if (!f) continue
    const [, field, type, isArr, ] = f
    const isRelation = modelNames.has(type) || isArr || line.includes('@relation')
    if (isRelation) continue
    const map = line.match(/@map\("(\w+)"\)/)
    out.set(field, map ? map[1] : field)
  }
  return out
}

function tableOfModel(modelName) {
  const start = schema.indexOf(`model ${modelName} {`)
  const body = schema.slice(start, schema.indexOf('\n}', start))
  return body.match(/@@map\("(\w+)"\)/)?.[1] ?? null
}

// استخراج جدول‌ها و ستون‌ها از مهاجرت‌ها
const migrationsDir = join(ROOT, 'prisma/migrations')
const migrationDirs = readdirSync(migrationsDir)
  .filter((n) => statSync(join(migrationsDir, n)).isDirectory())
  .sort()

// جدول -> Set(ستون)
const dbTables = new Map()
for (const dir of migrationDirs) {
  const sql = readFileSync(join(migrationsDir, dir, 'migration.sql'), 'utf8')
    .replace(/^\uFEFF/, '')
  for (const m of sql.matchAll(/CREATE TABLE\s+"(\w+)"\s*\(([\s\S]*?)\);/g)) {
    const [, table, body] = m
    if (!dbTables.has(table)) dbTables.set(table, new Set())
    const cols = dbTables.get(table)
    for (const cm of body.matchAll(/"(\w+)"/g)) cols.add(cm[1])
  }
  for (const m of sql.matchAll(/ALTER TABLE\s+"(\w+)"\s+ADD COLUMN\s+(?:"(\w+)"|(\w+))\s+/g)) {
    const [, table, quoted, bare] = m
    if (!dbTables.has(table)) dbTables.set(table, new Set())
    dbTables.get(table).add(quoted ?? bare)
  }
}

// گزارش
const problems = []
for (const modelName of [...modelNames].sort()) {
  const table = tableOfModel(modelName)
  const cols = columnsOfModel(modelName)
  const dbCols = table ? (dbTables.get(table) ?? new Set()) : null
  if (!table) {
    problems.push(`[جدول] مدل ${modelName} فاقد @@map است`)
    continue
  }
  if (!dbCols) {
    problems.push(`[جدول] جدول ${table} (مدل ${modelName}) در هیچ مهاجرتی ساخته نشده`)
    continue
  }
  for (const [field, col] of cols) {
    if (!dbCols.has(col)) {
      problems.push(`[ستون] ${modelName}.${field} → "${col}" در جدول ${table} وجود ندارد`)
    }
  }
}

console.log('=== ممیزی: ستون‌های اسکیما که در مهاجرت‌ها نیستند ===')
if (problems.length === 0) console.log('✅ هیچ ناسازگاری پیدا نشد')
else for (const p of problems) console.log(p)

// معکوس: ستون‌های دیتابیس که در اسکیما نیستند (ممکن است حذف‌شده یا عمدی)
console.log('\n=== ممیزی معکوس: ستون‌های دیتابیس که در هیچ مدلی نیستند ===')
const allSchemaCols = new Map() // table -> Set(col)
for (const modelName of modelNames) {
  const table = tableOfModel(modelName)
  if (!table) continue
  if (!allSchemaCols.has(table)) allSchemaCols.set(table, new Set())
  for (const col of columnsOfModel(modelName).values()) allSchemaCols.get(table).add(col)
}
let reverseCount = 0
for (const [table, cols] of [...dbTables].sort((a, b) => a[0].localeCompare(b[0]))) {
  const schemaCols = allSchemaCols.get(table)
  if (!schemaCols) continue
  for (const col of [...cols].sort()) {
    if (!schemaCols.has(col)) {
      console.log(`جدول ${table}: ستون اضافهٔ «${col}»`)
      reverseCount++
    }
  }
}
if (reverseCount === 0) console.log('✅ هیچ ستون اضافه‌ای پیدا نشد')
