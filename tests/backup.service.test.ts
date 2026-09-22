/**
 * بکاپ و بازیابی — آزمونِ خط لولهٔ کامل.
 *
 * ## چرا این آزمون‌ها مهم‌اند
 * بازیابی، خطرناک‌ترین عملیاتِ این پروژه است: کلِ دادهٔ بازی را پاک و از یک
 * فایل پر می‌کند. منطقش باید اثبات شود، نه ادعا. این محیط PostgreSQL ندارد
 * (نه دیتابیس، نه docker، نه `pg_dump`)؛ پس به‌جای ادعای «روی سرور کار
 * می‌کند»، یک جایگزینِ حافظه‌ای دقیق می‌نشیند که همان پرس‌وجوهایی را جواب
 * می‌دهد که سرویس واقعاً می‌فرستد و همان اثرها را می‌پذیرد.
 *
 * ## چه چیزی واقعاً سنجیده می‌شود (و چه چیزی نه)
 * سنجیده می‌شود: خواندنِ کاتالوگ، صفحه‌بندی، نوشتنِ فایلِ فشرده، مانیفست،
 * اثر انگشت، تشخیصِ خرابی و بریدگی، ترتیبِ کلیدهای خارجی، دسته‌بندیِ درج،
 * تأییدِ شمارش، برگشتِ تراکنش، گاردهای پیش از بازیابی و سیاستِ پاک‌سازی.
 * سنجیده **نمی‌شود**: اینکه خودِ PostgreSQL همان SQL را همان‌طور تفسیر کند
 * (`row_to_json` / `jsonb_populate_recordset` / `session_replication_role`).
 * این‌ها قراردادهایی هستند که مستند شده‌اند ولی این‌جا اجرا نمی‌شوند و باید
 * روی یک سرورِ واقعی یک بار آزموده شوند.
 */
import { gzipSync } from 'zlib'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { BackupService, isBackupId } from '../src/modules/ops/backup.service'
import type { OpsDatabase } from '../src/modules/ops/ops-database'
import { FileLock, opsLockPath, updateLockPath, toolsDir } from '../src/modules/ops/ops-lock'

// ─────────────────────────────────────────────────── دیتابیسِ جایگزین

interface FakeTable {
  pk: string[]
  rows: Record<string, unknown>[]
}

/**
 * جایگزینِ حافظه‌ایِ PostgreSQL.
 *
 * عمداً «کور» نیست: پرس‌وجوها را تشخیص می‌دهد و همان چیزی را برمی‌گرداند که
 * کاتالوگِ واقعی برمی‌گرداند، ولی هیچ‌جا خودش داده نمی‌سازد — همه از تنظیمِ
 * آزمون می‌آید. اگر سرویس شکلِ پرس‌وجو را عوض کند، تشخیص شکست می‌خورد و
 * آزمون قرمز می‌شود؛ همان چیزی که می‌خواهیم.
 */
class FakeDatabase implements OpsDatabase {
  readonly statements: string[] = []
  readonly inserted = new Map<string, Record<string, unknown>[]>()
  /** شمارشِ جعلی برای آزمونِ برگشتِ تراکنش: جدول → عددِ نادرست. */
  countOverride = new Map<string, number>()

  constructor(
    private readonly tables: Record<string, FakeTable>,
    private readonly foreignKeys: Array<[string, string]> = [],
    private readonly migrations: string[] = []
  ) {}

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    this.statements.push(sql)

    if (sql.includes('information_schema.tables')) {
      return Object.keys(this.tables)
        .sort()
        .map((table_name) => ({ table_name })) as T[]
    }
    if (sql.includes('PRIMARY KEY')) {
      return Object.entries(this.tables).flatMap(([table_name, table]) =>
        table.pk.map((column_name, index) => ({ table_name, column_name, ordinal_position: index + 1 }))
      ) as T[]
    }
    if (sql.includes('FOREIGN KEY')) {
      return this.foreignKeys.map(([child, parent]) => ({ child, parent })) as T[]
    }
    if (sql.includes('_prisma_migrations')) {
      return this.migrations.map((migration_name) => ({
        migration_name,
        checksum: 'x',
        finished_at: '2026-01-01T00:00:00.000Z',
        rolled_back_at: null
      })) as T[]
    }
    if (sql.includes('count(*)')) {
      const table = tableOf(sql)
      const override = this.countOverride.get(table)
      if (override !== undefined) {
        return [{ n: override }] as T[]
      }
      return [{ n: this.inserted.get(table)?.length ?? 0 }] as T[]
    }
    if (sql.includes('row_to_json')) {
      return this.page(sql, params) as T[]
    }
    throw new Error(`پرس‌وجوی ناشناخته در آزمون: ${sql}`)
  }

  async execute(sql: string, params: unknown[] = []): Promise<number> {
    this.statements.push(sql)
    if (sql.startsWith('TRUNCATE')) {
      for (const match of sql.matchAll(/"([^"]+)"/g)) {
        this.inserted.delete(match[1]!)
      }
      return 0
    }
    if (sql.startsWith('INSERT INTO')) {
      // همان کاری که `jsonb_populate_recordset` می‌کند: دستهٔ JSON → ردیف‌ها
      const table = tableOf(sql)
      const batch = JSON.parse(String(params[0])) as Record<string, unknown>[]
      const list = this.inserted.get(table) ?? []
      list.push(...batch)
      this.inserted.set(table, list)
      return batch.length
    }
    return 0
  }

  async transaction<T>(fn: (tx: OpsDatabase) => Promise<T>): Promise<T> {
    const tx: OpsDatabase = {
      query: <R = Record<string, unknown>>(sql: string, params: unknown[] = []) => this.query<R>(sql, params),
      execute: (sql: string, params: unknown[] = []) => this.execute(sql, params),
      transaction: (inner) => inner(tx)
    }
    // مثل PostgreSQL: استثنا کلِ کار را برمی‌گرداند. این‌جا حالتِ قبلی لازم
    // نیست چون هر آزمون از یک نمونهٔ تازه شروع می‌شود.
    return fn(tx)
  }

  private page(sql: string, params: unknown[]): Record<string, unknown>[] {
    const table = this.tables[tableOf(sql)]!
    let rows = [...table.rows]
    const keyset = sql.includes('WHERE (')
    if (keyset) {
      const limit = Number(params[params.length - 1])
      const keys = params.slice(0, -1)
      rows = rows.filter((row) =>
        table.pk.some((column, index) => {
          const value = row[column]
          const bound = keys[index]
          return typeof value === 'number' && typeof bound === 'number' ? value > bound : String(value) > String(bound)
        })
      )
      rows = rows.slice(0, limit)
    } else {
      const limit = Number(params[0])
      const offset = Number(params[1] ?? 0)
      rows = rows.slice(offset, offset + limit)
    }
    return rows.map((row) => ({ r: JSON.stringify(row) }))
  }
}

/** نامِ جدول از اولین شناسهٔ نقل‌قول‌شدهٔ بعد از FROM/INSERT INTO. */
function tableOf(sql: string): string {
  const match = sql.match(/(?:FROM|INTO)\s+"([^"]+)"/)
  if (!match) {
    throw new Error(`نامِ جدول در پرس‌وجو پیدا نشد: ${sql}`)
  }
  return match[1]!
}

/** ساختِ یک ریشهٔ پروژهٔ موقت با پوشهٔ مهاجرت‌ها. */
function makeRepo(migrationNames: string[] = []): string {
  const root = mkdtempSync(join(tmpdir(), 'legacy-ops-'))
  mkdirSync(toolsDir(root), { recursive: true })
  // پوشهٔ مهاجرت‌ها باید همیشه باشد؛ نبودش یعنی «قابلیت روی این سرور نیست»
  // و آن گارد پیش از هر گاردِ دیگری در `restoreNow` سنجیده می‌شود.
  mkdirSync(join(root, 'prisma', 'migrations'), { recursive: true })
  for (const name of migrationNames) {
    const dir = join(root, 'prisma', 'migrations', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'migration.sql'), `-- ${name}\nSELECT 1;\n`)
  }
  return root
}

/** دادهٔ نمونه: زنجیرهٔ پدر→فرزند با کلید خارجی. */
function sampleTables(): Record<string, FakeTable> {
  return {
    players: {
      pk: ['id'],
      rows: [
        { id: 'p1', name: 'آرش', balance: '1500' },
        { id: 'p2', name: 'نگار', balance: '0' }
      ]
    },
    properties: {
      pk: ['id'],
      rows: [{ id: 'h1', owner_id: 'p1', price: '900' }]
    }
  }
}

describe('بکاپ: خط لولهٔ کامل', () => {
  let repoRoot: string

  beforeEach(() => {
    repoRoot = makeRepo()
  })

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true })
  })

  test('شناسهٔ بکاپ فقط شکلِ موردانتظار را می‌پذیرد', () => {
    expect(isBackupId('20260920123456ab4f')).toBe(true)
    // تزریقِ مسیر هرگز نباید به مسیرِ فایل برسد
    expect(isBackupId('../../etc/passwd')).toBe(false)
    expect(isBackupId('20260920123456')).toBe(false)
    expect(isBackupId('20260920123456ab4f/../x')).toBe(false)
    expect(isBackupId('abcdefghijklmnopqr')).toBe(false)
  })

  test('ساخت و بررسی: فایل نوشته می‌شود و سالم تأیید می‌شود', async () => {
    const db = new FakeDatabase(sampleTables(), [['properties', 'players']])
    const service = new BackupService(db, repoRoot)

    const manifest = await service.create('manual', { commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' })

    expect(manifest.totalRows).toBe(3)
    expect(manifest.tables.map((table) => table.name).sort()).toEqual(['players', 'properties'])
    expect(manifest.tables.find((table) => table.name === 'players')?.rows).toBe(2)
    expect(manifest.integrity).toBe('ok')
    expect(manifest.commitShort).toBe('aaaaaaa')
    expect(existsSync(join(service.dirPath(manifest.id), 'data.ndjson.gz'))).toBe(true)
    // انتشارِ اتمیک: پوشهٔ نیمه‌کاره نباید بماند
    expect(existsSync(join(service.dirPath(manifest.id) + '.partial'))).toBe(false)

    const verified = await service.verify(manifest.id)
    expect(verified.ok).toBe(true)
    expect(verified.rows).toBe(3)
    expect(service.readManifest(manifest.id)?.integrity).toBe('ok')
  })

  test('مانیفست مهاجرت‌های اعمال‌شده را برای بررسیِ سازگاری نگه می‌دارد', async () => {
    const db = new FakeDatabase(sampleTables(), [], ['20260101000000_a', '20260202000000_b'])
    const service = new BackupService(db, repoRoot)

    const manifest = await service.create('manual')
    expect(manifest.migrations).toEqual(['20260101000000_a', '20260202000000_b'])
  })

  test('بریدگیِ فایل به‌عنوان خرابی شناسایی می‌شود، نه بکاپِ سالم', async () => {
    const db = new FakeDatabase(sampleTables())
    const service = new BackupService(db, repoRoot)
    const manifest = await service.create('manual')

    // فایلِ gzip از وسط بریده می‌شود
    const dataPath = join(service.dirPath(manifest.id), 'data.ndjson.gz')
    const raw = readFileSync(dataPath)
    writeFileSync(dataPath, raw.subarray(0, Math.floor(raw.length / 2)))

    const verified = await service.verify(manifest.id)
    expect(verified.ok).toBe(false)
    expect(verified.integrity).toBe('invalid')
    expect(service.readManifest(manifest.id)?.integrity).toBe('invalid')
  })

  test('تغییرِ محتوا با اثر انگشت شناسایی می‌شود', async () => {
    const db = new FakeDatabase(sampleTables())
    const service = new BackupService(db, repoRoot)
    const manifest = await service.create('manual')

    // gzip سالم، ولی محتوا دست‌کاری‌شده — دقیقاً همان چیزی که فقط اثر انگشت
    // می‌گیرد: فایل باز می‌شود، JSON معتبر است، ولی داده عوض شده.
    const tampered = `${JSON.stringify({ t: 'players', r: { id: 'p9', name: 'جعل', balance: '999999' } })}\n`
    writeFileSync(join(service.dirPath(manifest.id), 'data.ndjson.gz'), gzipSync(tampered))

    const verified = await service.verify(manifest.id)
    expect(verified.ok).toBe(false)
    expect(verified.integrity).toBe('invalid')
  })

  test('صفحه‌بندیِ جدولِ بزرگ هر ردیف را یک بار می‌خواند', async () => {
    const repoRoot = makeRepo()
    try {
      // بیشتر از یک صفحه (۲۰۰۰) تا مسیرِ کلیدگردانِ صفحه‌بندی واقعاً اجرا شود
      const rows = Array.from({ length: 2005 }, (_, index) => ({ id: index + 1, name: `p${index + 1}` }))
      const db = new FakeDatabase({ players: { pk: ['id'], rows } })
      const service = new BackupService(db, repoRoot)

      const manifest = await service.create('manual')
      expect(manifest.totalRows).toBe(2005)
      expect(manifest.tables[0]?.rows).toBe(2005)

      const verified = await service.verify(manifest.id)
      expect(verified.ok).toBe(true)
      expect(verified.rows).toBe(2005)
    } finally {
      rmSync(repoRoot, { recursive: true, force: true })
    }
  })

  test('بکاپِ نبوده هرگز «سالم» گزارش نمی‌شود', async () => {
    const service = new BackupService(new FakeDatabase(sampleTables()), repoRoot)
    const verified = await service.verify('20260920123456zzzz')
    expect(verified.ok).toBe(false)
    expect(verified.integrity).toBe('invalid')
  })
})

describe('بازیابی: ترتیب و اتمیک بودن', () => {
  test('والد پیش از فرزند درج می‌شود', async () => {
    const repoRoot = makeRepo()
    try {
      const db = new FakeDatabase(sampleTables(), [['properties', 'players']])
      const service = new BackupService(db, repoRoot)
      await service.create('manual')

      const catalog = await db.transaction((tx) => service.readCatalog(tx))
      const order = service.restoreOrder(catalog)
      expect(order.indexOf('players')).toBeLessThan(order.indexOf('properties'))
    } finally {
      rmSync(repoRoot, { recursive: true, force: true })
    }
  })

  test('بازیابيِ کامل موفق: پاک‌سازی، درجِ دسته‌ای و تأییدِ شمارش', async () => {
    const repoRoot = makeRepo()
    try {
      const db = new FakeDatabase(sampleTables(), [['properties', 'players']])
      const service = new BackupService(db, repoRoot)
      const backup = await service.create('manual')

      const outcome = await service.restoreNow(backup.id)

      expect(outcome.ok).toBe(true)
      expect(outcome.rowsRestored).toBe(3)
      expect(outcome.tablesRestored).toBe(2)
      expect(outcome.safetyBackupId).not.toBeNull()
      expect(db.statements.some((sql) => sql.startsWith('TRUNCATE'))).toBe(true)
      expect(db.inserted.get('players')).toHaveLength(2)

      // بکاپِ ایمنی واقعاً روی دیسک است و سالم خوانده می‌شود
      const safety = service.readManifest(outcome.safetyBackupId!)
      expect(safety?.kind).toBe('pre-restore')
    } finally {
      rmSync(repoRoot, { recursive: true, force: true })
    }
  })

  test('اگر شمارش نخواند، بازیابی موفق اعلام نمی‌شود', async () => {
    const repoRoot = makeRepo()
    try {
      const db = new FakeDatabase(sampleTables())
      const service = new BackupService(db, repoRoot)
      const backup = await service.create('manual')
      // شبیه‌سازیِ بازیابیِ نیمه‌کاره: جدول کم می‌آورد
      db.countOverride.set('players', 1)

      const outcome = await service.restoreNow(backup.id)

      expect(outcome.ok).toBe(false)
      expect(outcome.rowsRestored).toBe(0)
      // پیام نباید هیچ ادعای موفقیّتی داشته باشد
      expect(outcome.message).not.toContain('کامل شد')
    } finally {
      rmSync(repoRoot, { recursive: true, force: true })
    }
  })

  test('بکاپِ خراب هرگز بازیابی نمی‌شود و بکاپِ ایمنی هم ساخته نمی‌شود', async () => {
    const repoRoot = makeRepo()
    try {
      const db = new FakeDatabase(sampleTables())
      const service = new BackupService(db, repoRoot)
      const backup = await service.create('manual')
      // خراب‌کردنِ عمدی پس از ساخت
      writeFileSync(join(service.dirPath(backup.id), 'data.ndjson.gz'), gzipSync('{"t":"players","r":{}}\n'))

      const outcome = await service.restoreNow(backup.id)

      expect(outcome.ok).toBe(false)
      expect(outcome.safetyBackupId).toBeNull()
      expect(service.list().filter((entry) => entry.kind === 'pre-restore')).toHaveLength(0)
    } finally {
      rmSync(repoRoot, { recursive: true, force: true })
    }
  })

  test('بکاپِ جلوتر از کدِ فعلی بازیابی نمی‌شود', async () => {
    const repoRoot = makeRepo(['20260101000000_a'])
    try {
      // بکاپ دو مهاجرت دیده، ولی دیتابیس فعلی هیچ‌کدام را اعمال نکرده است
      const backingDb = new FakeDatabase(sampleTables(), [], ['20260101000000_a', '20260202000000_b'])
      const service = new BackupService(backingDb, repoRoot)
      const backup = await service.create('manual')

      const currentDb = new FakeDatabase(sampleTables(), [], [])
      const current = new BackupService(currentDb, repoRoot)
      const outcome = await current.restoreNow(backup.id)

      expect(outcome.ok).toBe(false)
      expect(outcome.message).toContain('جلوتر')
    } finally {
      rmSync(repoRoot, { recursive: true, force: true })
    }
  })

  test('در جریان بودنِ عملیاتِ دیگر، بازیابی را متوقف می‌کند', async () => {
    const repoRoot = makeRepo()
    try {
      const service = new BackupService(new FakeDatabase(sampleTables()), repoRoot)
      const lock = new FileLock(opsLockPath(repoRoot), 60_000)
      expect(lock.tryAcquire()).toBe(true)
      try {
        const outcome = await service.restoreNow('20260920123456zzzz')
        expect(outcome.ok).toBe(false)
        expect(outcome.message).toContain('در جریان')
      } finally {
        lock.release()
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true })
    }
  })

  test('به‌روزرسانیِ در جریان، بازیابی را متوقف می‌کند', async () => {
    const repoRoot = makeRepo()
    try {
      const service = new BackupService(new FakeDatabase(sampleTables()), repoRoot)
      const lock = new FileLock(updateLockPath(repoRoot), 60_000)
      expect(lock.tryAcquire()).toBe(true)
      try {
        const outcome = await service.restoreNow('20260920123456zzzz')
        expect(outcome.ok).toBe(false)
      } finally {
        lock.release()
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true })
    }
  })
})

describe('درخواستِ بازیابی از سمت ربات', () => {
  test('شناسهٔ نامعتبر یا بکاپِ ناموجود شروع نمی‌شود', () => {
    const repoRoot = makeRepo()
    try {
      const service = new BackupService(new FakeDatabase(sampleTables()), repoRoot)
      expect(service.requestRestore('not-an-id', 1n).started).toBe(false)
      expect(service.requestRestore('20260920123456zzzz', 1n).started).toBe(false)
    } finally {
      rmSync(repoRoot, { recursive: true, force: true })
    }
  })
})

describe('پاک‌سازیِ بکاپ‌ها', () => {
  test('سقفِ نگه‌داری رعایت می‌شود و جدیدترین بکاپ دست‌نخورده می‌ماند', async () => {
    const repoRoot = makeRepo()
    try {
      const service = new BackupService(new FakeDatabase(sampleTables()), repoRoot)
      const ids: string[] = []
      for (let index = 0; index < 4; index += 1) {
        // شناسه‌ها زمان‌محورند؛ برای ترتیبِ قطعی، مانیفست‌ها را دستی بازنویسی می‌کنیم
        const manifest = await service.create('manual')
        ids.push(manifest.id)
      }

      const rewritten = service.list().map((entry, index) => ({
        ...entry,
        createdAt: `2026-09-2${index}T00:00:00.000Z`
      }))
      for (const entry of rewritten) {
        const path = join(service.dirPath(entry.id), 'manifest.json')
        const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
        writeFileSync(path, JSON.stringify({ ...raw, createdAt: entry.createdAt }, null, 2))
      }

      const removed = service.prune(2)
      const remaining = service.list()

      expect(removed.length).toBe(2)
      expect(remaining.length).toBe(2)
      // جدیدترین (تاریخِ ۲۳) هرگز پاک نمی‌شود
      expect(remaining[0]?.createdAt).toBe('2026-09-23T00:00:00.000Z')
    } finally {
      rmSync(repoRoot, { recursive: true, force: true })
    }
  })

  test('آخرین بکاپِ ایمنی حتی بیرونِ سقف هم پاک نمی‌شود', async () => {
    const repoRoot = makeRepo()
    try {
      const service = new BackupService(new FakeDatabase(sampleTables()), repoRoot)
      const safety = await service.create('pre-restore')
      for (let index = 0; index < 3; index += 1) {
        await service.create('manual')
      }
      const ordered = service.list()
      // همهٔ بکاپ‌های دستی را تازه‌تر می‌کنیم تا ایمنی به انتهای فهرست برود
      for (const entry of ordered) {
        const path = join(service.dirPath(entry.id), 'manifest.json')
        const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
        const createdAt = entry.kind === 'pre-restore' ? '2020-01-01T00:00:00.000Z' : entry.createdAt
        writeFileSync(path, JSON.stringify({ ...raw, createdAt }, null, 2))
      }

      service.prune(1)
      expect(service.readManifest(safety.id)).not.toBeNull()
    } finally {
      rmSync(repoRoot, { recursive: true, force: true })
    }
  })

  test('پوشه‌های نیمه‌کارهٔ جامانده پاک می‌شوند', () => {
    const repoRoot = makeRepo()
    try {
      const service = new BackupService(new FakeDatabase(sampleTables()), repoRoot)
      const partial = join(toolsDir(repoRoot), 'backups', '20260920123456zzzz.partial')
      mkdirSync(partial, { recursive: true })
      expect(service.removePartialDirs()).toEqual(['20260920123456zzzz.partial'])
      expect(existsSync(partial)).toBe(false)
    } finally {
      rmSync(repoRoot, { recursive: true, force: true })
    }
  })
})
