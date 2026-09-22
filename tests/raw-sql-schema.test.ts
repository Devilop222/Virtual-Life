import { join } from 'path'
import { readText as readSource } from './helpers/source'

const ROOT = join(__dirname, '..')

function read(relativePath: string): string {
  return readSource(join(ROOT, relativePath))
}

/** ستون‌های واقعی یک مدل Prisma بر اساس @map. */
function columnsOfModel(modelName: string): string[] {
  const schema = read('prisma/schema.prisma')
  const start = schema.indexOf(`model ${modelName} {`)
  expect(start).toBeGreaterThan(-1)
  const body = schema.slice(start, schema.indexOf('\n}', start))

  return [...body.matchAll(/@map\("(\w+)"\)/g)]
    .map((match) => match[1]!)
    .filter((name) => !name.includes('_capacities') && !name.endsWith('s'))
}

/** نام جدول یک مدل Prisma بر اساس @@map. */
function tableOfModel(modelName: string): string {
  const schema = read('prisma/schema.prisma')
  const start = schema.indexOf(`model ${modelName} {`)
  const body = schema.slice(start, schema.indexOf('\n}', start))
  return body.match(/@@map\("(\w+)"\)/)?.[1] ?? ''
}

describe('Raw SQL matches the Prisma schema', () => {
  const source = read('src/database/repositories/job-capacity.repository.ts')

  test('job_capacities has no id column, so no query may return one', () => {
    const columns = columnsOfModel('JobCapacity')

    expect(columns).toEqual(expect.arrayContaining(['job_key', 'capacity', 'occupied']))
    expect(columns).not.toContain('id')

    // رگرسیون واقعی: RETURNING "id" باعث خطای 42703 و شکست شروع هر شغل می‌شد
    expect(source).not.toMatch(/RETURNING\s+"id"/i)
  })

  test('every quoted identifier in raw SQL exists in the schema', () => {
    const table = tableOfModel('JobCapacity')
    const allowed = new Set([table, ...columnsOfModel('JobCapacity')])

    const statements = source.match(/\$(?:queryRaw|executeRaw)<?[^`]*`([^`]+)`/gs) ?? []
    expect(statements.length).toBeGreaterThan(0)

    for (const statement of statements) {
      for (const match of statement.matchAll(/"(\w+)"/g)) {
        expect(allowed).toContain(match[1])
      }
    }
  })

  test('taking a slot is a single conditional update, not read-then-write', () => {
    const takeSlot = source.slice(source.indexOf('async takeSlot'), source.indexOf('async releaseSlot'))

    // شرط ظرفیت باید داخل خود UPDATE باشد تا دو بازیکن همزمان
    // نتوانند آخرین ظرفیت را بگیرند
    expect(takeSlot).toMatch(/UPDATE\s+"job_capacities"/i)
    expect(takeSlot).toMatch(/"occupied"\s*<\s*"capacity"/i)
    expect(takeSlot).not.toMatch(/findUnique|findFirst/)
  })

  test('releasing a slot never drives the counter below zero', () => {
    const releaseSlot = source.slice(source.indexOf('async releaseSlot'))
    expect(releaseSlot).toMatch(/GREATEST\("occupied"\s*-\s*1,\s*0\)/i)
  })
})
