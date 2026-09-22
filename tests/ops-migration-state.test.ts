/**
 * مقایسهٔ مهاجرت‌های دیسک و دیتابیس.
 *
 * این سنجش تعیین می‌کند که «کدِ در حال اجرا با دیتابیس می‌خواند یا نه»، و
 * تنها مرجعش چک‌سامی است که مهاجرت‌سازِ آفلاین نوشته. اگر قاعدهٔ چک‌سام یک
 * بایت فرق کند، هر مهاجرتِ سالم «ویرایش‌شده» گزارش می‌شود و سیگنالِ واقعی
 * بین هشدارهای دروغین گم می‌شود — پس هم‌خوانی با مهاجرت‌ساز صریحاً آزموده
 * می‌شود (از جمله رفتارِ BOM).
 */
import { createHash } from 'crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { compareMigrations, readDiskMigrations, type AppliedMigration } from '../src/modules/ops/migration-state'

function makeMigrationsDir(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'legacy-migrations-'))
  for (const [name, sql] of Object.entries(files)) {
    mkdirSync(join(root, name), { recursive: true })
    writeFileSync(join(root, name, 'migration.sql'), sql)
  }
  return root
}

function applied(name: string, checksum: string, overrides: Partial<AppliedMigration> = {}): AppliedMigration {
  return {
    migrationName: name,
    checksum,
    finishedAt: '2026-01-01T00:00:00.000Z',
    rolledBackAt: null,
    ...overrides
  }
}

describe('خواندنِ مهاجرت‌های دیسک', () => {
  test('فقط پوشه‌های دارای migration.sql خوانده می‌شوند و ترتیب الفبایی است', () => {
    const dir = makeMigrationsDir({
      '20260202000000_b': 'SELECT 2;\n',
      '20260101000000_a': 'SELECT 1;\n'
    })
    try {
      mkdirSync(join(dir, '20260303000000_empty'), { recursive: true })
      const migrations = readDiskMigrations(dir)
      expect(migrations.map((entry) => entry.name)).toEqual(['20260101000000_a', '20260202000000_b'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('چک‌سام دقیقاً مثل مهاجرت‌سازِ آفلاین حساب می‌شود (BOM حذف می‌شود)', () => {
    // مهاجرت‌ساز: replace(/^\uFEFF/, '') و بعد sha256 روی UTF-8
    const sql = '\uFEFFSELECT 1;\n'
    const dir = makeMigrationsDir({ '20260101000000_a': sql })
    try {
      const expected = createHash('sha256').update(sql.replace(/^\uFEFF/, ''), 'utf8').digest('hex')
      expect(readDiskMigrations(dir)[0]?.checksum).toBe(expected)
      // و نه هشِ نسخهٔ BOMدار
      expect(readDiskMigrations(dir)[0]?.checksum).not.toBe(
        createHash('sha256').update(sql, 'utf8').digest('hex')
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('پوشهٔ نبود، فهرستِ خالی می‌دهد (نه استثنا)', () => {
    expect(readDiskMigrations(join(tmpdir(), 'definitely-not-here-legacy'))).toEqual([])
  })
})

describe('مقایسهٔ دیسک و دیتابیس', () => {
  test('هم‌خوانی کامل', () => {
    const disk = [
      { name: 'a', checksum: 'h1' },
      { name: 'b', checksum: 'h2' }
    ]
    const state = compareMigrations(disk, [applied('a', 'h1'), applied('b', 'h2')])
    expect(state.ok).toBe(true)
    expect(state.applied).toBe(2)
    expect(state.pending).toEqual([])
  })

  test('مهاجرتِ اعمال‌نشده: کد جلوتر از دیتابیس است', () => {
    const state = compareMigrations([{ name: 'a', checksum: 'h1' }], [])
    expect(state.ok).toBe(false)
    expect(state.pending).toEqual(['a'])
  })

  test('مهاجرتِ ناشناخته: دیتابیس جلوتر از کد است', () => {
    const state = compareMigrations([], [applied('a', 'h1')])
    expect(state.ok).toBe(false)
    expect(state.missing).toEqual(['a'])
  })

  test('چک‌سامِ متفاوت یعنی مهاجرتِ اعمال‌شده ویرایش شده است', () => {
    const state = compareMigrations([{ name: 'a', checksum: 'new' }], [applied('a', 'old')])
    expect(state.ok).toBe(false)
    expect(state.drifted).toEqual(['a'])
  })

  test('مهاجرتِ برگشت‌خورده «اعمال‌نشده» شمرده می‌شود ولی «گم‌شده» نه', () => {
    const rolledBack = compareMigrations(
      [{ name: 'a', checksum: 'h1' }],
      [applied('a', 'h1', { rolledBackAt: '2026-01-02T00:00:00.000Z' })]
    )
    // فایلش روی دیسک است (پس گم نشده) ولی اثرش برگشته (پس اعمال‌نشده است)
    expect(rolledBack.missing).toEqual([])
    expect(rolledBack.pending).toEqual(['a'])
    expect(rolledBack.ok).toBe(false)

    const unfinished = compareMigrations(
      [{ name: 'a', checksum: 'h1' }],
      [applied('a', 'h1', { finishedAt: null })]
    )
    expect(unfinished.ok).toBe(false)
    expect(unfinished.failed).toEqual(['a'])
  })

  test('نبودِ چک‌سام در ردیف، «ویرایش‌شده»ی دروغین نمی‌سازد', () => {
    // ردیف‌های قدیمی ممکن است checksum نداشته باشند؛ نبودِ اطلاعات نباید به
    // «مهاجرت دست‌کاری شده» ترجمه شود.
    const state = compareMigrations([{ name: 'a', checksum: 'h1' }], [applied('a', '')])
    expect(state.drifted).toEqual([])
    expect(state.ok).toBe(true)
  })
})
