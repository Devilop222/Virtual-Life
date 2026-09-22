/**
 * بکاپِ منطقیِ دیتابیس — ساخت، بررسیِ سلامت، بازیابی و پاک‌سازی.
 *
 * ## چرا منطقی و نه `pg_dump`؟
 * چون `pg_dump` روی سرورِ هدف **وجود ندارد**. بستهٔ PostgreSQL داخلی این پروژه
 * دقیقاً سه باینری دارد — `initdb`، `pg_ctl`، `postgres` — و نه `pg_dump`، نه
 * `pg_restore`، نه `psql`. (این با باز کردن تاربال بررسی شد، نه از روی حدس.)
 * پس بکاپِ مبتنی بر `pg_dump` روی سرورِ واقعی محکوم به شکست است. همچنین
 * معماریِ این پروژه عمداً آفلاین است و بکاپ نباید به ابزارِ بیرونی وابسته شود.
 *
 * ## چگونه کدگذاری بدونِ ابزارِ بکاپ انجام می‌شود؟
 * خودِ PostgreSQL کدگذاری را انجام می‌دهد:
 *   • ساخت:  `SELECT row_to_json(t)::text FROM "T" t`
 *   • بازیابی: `INSERT INTO "T" SELECT * FROM jsonb_populate_recordset(null::"T", $1::jsonb)`
 * این یعنی **هیچ‌جا در سمت Node تایپ‌ها دست‌کاری نمی‌شوند**. `numeric`،
 * `timestamp`، `json`، `bytea` و enum همه توسط موتورِ خودِ دیتابیس به JSON و
 * بازگشت تبدیل می‌شوند. اگر خودمان تایپ‌ها را سریال می‌کردیم، هر تایپی که
 * یک بار فراموش شود یعنی بکاپِ بی‌صدا خراب — دقیقاً همان دسته خطایی که
 * بعد از یک فاجعه کشف می‌شود.
 *
 * ## چرا ترتیب کلیدهای خارجی و `session_replication_role` لازم است؟
 * درجِ ردیفِ فرزند پیش از والد نقضِ کلید خارجی است. دو محافظ با هم:
 *  ۱. ترتیبِ توپولوژیکِ جدول‌ها از `information_schema` (والدها اول).
 *  ۲. `SET LOCAL session_replication_role = 'replica'` که بررسیِ کلید خارجی را
 *     داخل همان تراکنش خاموش می‌کند — تا چرخهٔ واقعیِ کلیدهای خارجی هم
 *     مسئله نشود. اگر این تنظیم اجازه نداشته باشد (کاربرِ غیرسوپر)، فقط لاگ
 *     می‌شود و ترتیبِ مرحلهٔ ۱ کار را انجام می‌دهد.
 *
 * ## چرا یک تراکنش؟
 * بازیابیِ نیمه‌کاره یعنی دیتابیسِ خراب. کل کار داخل **یک** تراکنش است: اگر
 * هر جای مسیر خطا بدهد، PostgreSQL همه‌چیز را برمی‌گرداند و دادهٔ فعلی
 * دست‌نخورده می‌ماند. «بازیابی موفق شد» فقط وقتی گفته می‌شود که تراکنش
 * کامیت شده **و** شمارشِ ردیف‌ها با مانیفست خوانده باشد.
 */
import { spawn } from 'child_process'
import { createHash } from 'crypto'
import {
  closeSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'fs'
import { join } from 'path'
import { createGunzip, createGzip } from 'zlib'
import type { Writable } from 'stream'
import { logger } from '../../utils/logger'
import { quoteIdent, type OpsDatabase } from './ops-database'
import { readDiskMigrations, type AppliedMigration } from './migration-state'
import { FileLock, opsLockPath, toolsDir, updateLockPath } from './ops-lock'
import { OpsStateFile } from './ops-state'

/** نسخهٔ قالبِ بکاپ. اگر ساختار عوض شود، خوانندهٔ قدیمی باید صریح رد کند. */
export const BACKUP_FORMAT_VERSION = 1

/** تعداد ردیف در هر صفحهٔ خواندن از دیتابیس. */
const READ_PAGE = 2_000
/** تعداد ردیف در هر `INSERT` بازیابی. */
const WRITE_BATCH = 500
/** تنها اسکریپتی که این سرویس اجرا می‌کند — ثابت، بدون هیچ ورودیِ متنیِ کاربر. */
const RESTORE_SCRIPT = 'offline-deps/install.sh'
/** قفلِ عملیات تا این مدت زنده شمرده می‌شود (بکاپِ بزرگ می‌تواند طول بکشد). */
const OPS_LOCK_STALE_MS = 30 * 60 * 1000
/** نگه‌داریِ پیش‌فرضِ بکاپ‌ها؛ قدیمی‌ترها پاک می‌شوند. */
const DEFAULT_KEEP = 10

export type BackupKind = 'manual' | 'pre-update' | 'pre-restore'
export type IntegrityStatus = 'ok' | 'invalid' | 'unverified'

export interface BackupTableStat {
  name: string
  rows: number
  /** sha256 بایت‌های نوشته‌شدهٔ همین جدول — تشخیصِ بریدگی و خرابیِ بیت. */
  sha256: string
}

export interface BackupManifest {
  formatVersion: number
  id: string
  kind: BackupKind
  createdAt: string
  durationMs: number
  appVersion: string | null
  commit: string | null
  commitShort: string | null
  node: string
  /** مهاجرت‌های اعمال‌شده در لحظهٔ بکاپ — معیارِ سازگاری پیش از بازیابی. */
  migrations: string[]
  tables: BackupTableStat[]
  totalRows: number
  /** sha256 محتوای **فشردنشده** — اثر انگشتِ کلِ داده. */
  dataSha256: string
  dataBytes: number
  fileBytes: number
  integrity: IntegrityStatus
  integrityNote: string | null
}

export interface BackupSummary {
  id: string
  kind: BackupKind
  createdAt: string
  totalRows: number
  fileBytes: number
  commitShort: string | null
  integrity: IntegrityStatus
  tables: number
}

export interface VerifyResult {
  id: string
  ok: boolean
  integrity: IntegrityStatus
  /** توضیحِ انسانیِ آنچه پیدا شد — درست یا غلط. */
  note: string
  tables: number
  rows: number
  dataSha256: string | null
}

export interface RestoreOutcome {
  ok: boolean
  backupId: string
  message: string
  /** بکاپِ ایمنی که پیش از بازیابی از وضعیتِ فعلی گرفته شد. */
  safetyBackupId: string | null
  tablesRestored: number
  rowsRestored: number
}

/** نتیجهٔ درخواستِ بازیابی از سمت ربات (کار واقعی در فرآیندِ جدا انجام می‌شود). */
export interface RestoreRequestResult {
  started: boolean
  reason: string | null
  outcome: RestoreOutcome | null
}

interface Catalog {
  tables: string[]
  primaryKeys: Map<string, string[]>
  /** فرزند → والدها (برای ترتیب درج). */
  parents: Map<string, Set<string>>
  migrations: string[]
}

interface TableRow {
  r: string
}

/** ساخت شناسهٔ بکاپ: زمانِ خوانا + پسوندِ کوتاهِ تصادفی برای یکتایی. */
function newBackupId(): string {
  const now = new Date()
  const stamp =
    now.getUTCFullYear().toString() +
    String(now.getUTCMonth() + 1).padStart(2, '0') +
    String(now.getUTCDate()).padStart(2, '0') +
    String(now.getUTCHours()).padStart(2, '0') +
    String(now.getUTCMinutes()).padStart(2, '0') +
    String(now.getUTCSeconds()).padStart(2, '0')
  return `${stamp}${Math.random().toString(36).slice(2, 6)}`
}

/** آیا شناسهٔ بکاپ به شکلِ موردانتظار است؟ (ورودی از `callback_data` می‌آید.) */
export function isBackupId(value: string): boolean {
  return /^[0-9]{14}[a-z0-9]{4}$/.test(value)
}

/**
 * نوشتنِ یک قطعه در جریان، با احترام به backpressure.
 * بدون این، بکاپِ دیتابیسِ بزرگ کل حافظه را می‌خورد.
 */
function writeChunk(stream: Writable, chunk: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ok = stream.write(chunk, (error) => {
      if (error) {
        reject(error)
      }
    })
    if (ok) {
      resolve()
      return
    }
    stream.once('drain', resolve)
  })
}

function finishStream(stream: Writable): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.end(() => resolve())
    stream.once('error', reject)
  })
}

export class BackupService {
  private readonly backupsDir: string
  private readonly toolsPath: string
  private readonly repoRoot: string
  private readonly opsLock: FileLock
  private readonly updateLock: FileLock
  private readonly migrationsDir: string
  private readonly opsState: OpsStateFile

  constructor(
    private readonly db: OpsDatabase,
    repoRoot: string = process.cwd(),
    private readonly keep: number = DEFAULT_KEEP
  ) {
    this.repoRoot = repoRoot
    this.toolsPath = toolsDir(repoRoot)
    this.backupsDir = join(this.toolsPath, 'backups')
    this.opsLock = new FileLock(opsLockPath(repoRoot), OPS_LOCK_STALE_MS)
    this.updateLock = new FileLock(updateLockPath(repoRoot), OPS_LOCK_STALE_MS)
    this.migrationsDir = join(repoRoot, 'prisma', 'migrations')
    this.opsState = new OpsStateFile(OpsStateFile.defaultPath(repoRoot))
  }

  dirPath(id: string): string {
    return join(this.backupsDir, id)
  }

  lockPath(): string {
    return this.opsLock.filePath()
  }

  /**
   * آیا بازیابی اصلاً ممکن است؟
   *
   * بازیابیِ خراب‌شدنی بدتر از نداشتنِ بازیابی است، پس شرایط پیش‌نیاز همان‌جا
   * صریح گفته می‌شود. هیچ‌کدام از این‌ها حدس نیستند.
   */
  availability(): { available: boolean; reason: string | null } {
    if (!existsSync(this.migrationsDir)) {
      return { available: false, reason: 'پوشهٔ مهاجرت‌ها روی این سرور پیدا نشد.' }
    }
    return { available: true, reason: null }
  }

  // ──────────────────────────────────────────────────────────── خواندنِ کاتالوگ

  /**
   * خواندنِ واقعیتِ دیتابیس: جدول‌ها، کلیدهای اصلی، وابستگی‌های خارجی و
   * مهاجرت‌های اعمال‌شده.
   *
   * نام‌ها از **خودِ دیتابیس** می‌آیند، نه از فهرستی دست‌نویس: همهٔ ۵۸ مدلِ
   * این پروژه `@@map` دارند، پس نامِ جدول با نامِ مدل یکی نیست. فهرستِ
   * دست‌نویس یعنی جدولِ جاافتاده، و جدولِ جاافتاده یعنی بکاپِ ناقص که تا
   * روزِ بازیابی کسی نمی‌فهمد.
   */
  async readCatalog(tx: OpsDatabase): Promise<Catalog> {
    const tableRows = await tx.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
          AND table_name <> '_prisma_migrations'
        ORDER BY table_name`
    )
    const tables = tableRows.map((row) => row.table_name)

    const pkRows = await tx.query<{ table_name: string; column_name: string; ordinal_position: number | bigint }>(
      `SELECT tc.table_name, kcu.column_name, kcu.ordinal_position
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON kcu.constraint_name = tc.constraint_name
          AND kcu.table_schema = tc.table_schema
        WHERE tc.table_schema = 'public' AND tc.constraint_type = 'PRIMARY KEY'
        ORDER BY tc.table_name, kcu.ordinal_position`
    )
    const primaryKeys = new Map<string, string[]>()
    for (const row of pkRows) {
      const list = primaryKeys.get(row.table_name) ?? []
      list.push(row.column_name)
      primaryKeys.set(row.table_name, list)
    }

    const fkRows = await tx.query<{ child: string; parent: string }>(
      `SELECT DISTINCT tc.table_name AS child, ccu.table_name AS parent
         FROM information_schema.table_constraints tc
         JOIN information_schema.constraint_column_usage ccu
           ON ccu.constraint_name = tc.constraint_name
          AND ccu.table_schema = tc.table_schema
        WHERE tc.table_schema = 'public' AND tc.constraint_type = 'FOREIGN KEY'`
    )
    const parents = new Map<string, Set<string>>()
    for (const row of fkRows) {
      if (row.child === row.parent) {
        continue
      }
      const set = parents.get(row.child) ?? new Set<string>()
      set.add(row.parent)
      parents.set(row.child, set)
    }

    const migrationRows = await tx.query<{ migration_name: string }>(
      `SELECT migration_name FROM "_prisma_migrations"
        WHERE rolled_back_at IS NULL AND finished_at IS NOT NULL
        ORDER BY migration_name`
    )

    return { tables, primaryKeys, parents, migrations: migrationRows.map((row) => row.migration_name) }
  }

  /**
   * ترتیبِ درج: والدها پیش از فرزندان.
   *
   * چرخه‌ها با «باقی‌مانده به ترتیبِ الفبا» تمام می‌شوند، نه با خطا: چرخه در
   * `information_schema` ممکن است واقعی باشد و شکست دادنِ کلِ بازیابی به‌خاطر
   * آن، بدترین پاسخ است. `session_replication_role` هم آن‌جا کمک می‌کند.
   */
  restoreOrder(catalog: Catalog): string[] {
    const order: string[] = []
    const state = new Map<string, 'visiting' | 'done'>()

    const visit = (table: string): void => {
      const current = state.get(table)
      if (current === 'done') {
        return
      }
      // چرخه: نمی‌توانیم الان حلش کنیم؛ در «باقی‌مانده» می‌آید.
      if (current === 'visiting') {
        return
      }
      state.set(table, 'visiting')
      for (const parent of catalog.parents.get(table) ?? []) {
        if (catalog.tables.includes(parent)) {
          visit(parent)
        }
      }
      state.set(table, 'done')
      order.push(table)
    }

    for (const table of catalog.tables) {
      visit(table)
    }
    // هر جدولی که به‌خاطر چرخه از قلم افتاده باشد، به ترتیبِ الفبا اضافه می‌شود.
    for (const table of catalog.tables) {
      if (!order.includes(table)) {
        order.push(table)
      }
    }
    return order
  }

  // ──────────────────────────────────────────────────────────── ساخت

  /**
   * ساختِ یک بکاپِ کامل.
   *
   * کلِ خواندن داخلِ **یک** تراکنش با ایزولاسیونِ `REPEATABLE READ` است. بدون
   * آن، هر پرس‌وجو دادهٔ تازه‌تر می‌بیند و بکاپ می‌تواند نیمهٔ یک انتقالِ پول
   * را داشته باشد: پول از کیفِ فرستنده کم شده ولی به گیرنده نرسیده — بکاپی
   * که در روزِ فاجعه به داد می‌رسد، دقیقاً به پیوستگی نیاز دارد.
   */
  async create(kind: BackupKind, options: { appVersion?: string | null; commit?: string | null } = {}): Promise<BackupManifest> {
    const id = newBackupId()
    const partialDir = join(this.backupsDir, `${id}.partial`)
    const finalDir = join(this.backupsDir, id)
    const startedAt = Date.now()

    mkdirSync(partialDir, { recursive: true })
    const dataPath = join(partialDir, 'data.ndjson.gz')

    const overall = createHash('sha256')
    const tableStats: BackupTableStat[] = []
    let totalRows = 0

    const gzip = createGzip({ level: 6 })
    const out = createWriteStream(dataPath)
    gzip.pipe(out)
    // خطای نوشتار باید بالا برود؛ وگرنه بکاپِ ناقص بی‌صدا «سالم» می‌شود.
    const writeFailure = new Promise<never>((_, reject) => {
      out.once('error', reject)
    })

    let catalog: Catalog = { tables: [], primaryKeys: new Map(), parents: new Map(), migrations: [] }

    try {
      await Promise.race([
        writeFailure,
        this.db.transaction(async (tx) => {
          await tx.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
          catalog = await this.readCatalog(tx)

          for (const table of catalog.tables) {
            const tableHash = createHash('sha256')
            let rows = 0
            const pk = catalog.primaryKeys.get(table) ?? []

            let lastKey: unknown[] | null = null
            let offset = 0
            for (;;) {
              const quoted = quoteIdent(table)
              let sql: string
              const params: unknown[] = []
              if (pk.length > 0) {
                const cols = pk.map(quoteIdent).join(', ')
                const where = lastKey
                  ? `WHERE (${cols}) > (${pk.map((_, index) => `$${index + 1}`).join(', ')})`
                  : ''
                if (lastKey) {
                  params.push(...lastKey)
                }
                params.push(READ_PAGE)
                sql = `SELECT row_to_json(t)::text AS r FROM ${quoted} t ${where} ORDER BY ${cols} LIMIT $${params.length}`
              } else {
                // جدولِ بدون کلید اصلی: `ctid` درونِ همین snapshot ترتیبِ پایدار
                // می‌دهد، پس صفحه‌بندی نه ردیف جا می‌گذارد نه تکرار می‌کند.
                params.push(READ_PAGE, offset)
                sql = `SELECT row_to_json(t)::text AS r FROM ${quoted} t ORDER BY t.ctid LIMIT $1 OFFSET $2`
              }

              const page = await tx.query<TableRow>(sql, params)
              if (page.length === 0) {
                break
              }

              for (const row of page) {
                const line = `${JSON.stringify({ t: table, r: JSON.parse(row.r) as unknown })}\n`
                tableHash.update(line, 'utf8')
                overall.update(line, 'utf8')
                await writeChunk(gzip, line)
                rows += 1
              }

              if (page.length < READ_PAGE) {
                break
              }
              if (pk.length > 0) {
                const last = page[page.length - 1]!
                const parsed = JSON.parse(last.r) as Record<string, unknown>
                lastKey = pk.map((column) => parsed[column])
              } else {
                offset += page.length
              }
            }

            tableStats.push({ name: table, rows, sha256: tableHash.digest('hex') })
            totalRows += rows
          }
        })
      ])

      await finishStream(gzip)
      await new Promise<void>((resolve, reject) => {
        out.once('close', resolve)
        out.once('error', reject)
      })
    } catch (error) {
      // شکستِ وسطِ کار نباید پوشهٔ نیمه‌کاره را به‌عنوان بکاپِ معتبر جا بگذارد.
      gzip.destroy()
      rmSync(partialDir, { recursive: true, force: true })
      throw error
    }

    const dataBytes = statSync(dataPath).size
    const manifest: BackupManifest = {
      formatVersion: BACKUP_FORMAT_VERSION,
      id,
      kind,
      createdAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      appVersion: options.appVersion ?? null,
      commit: options.commit ?? null,
      commitShort: options.commit ? options.commit.slice(0, 7) : null,
      node: process.version,
      migrations: catalog.migrations,
      tables: tableStats,
      totalRows,
      dataSha256: overall.digest('hex'),
      dataBytes,
      fileBytes: dataBytes,
      integrity: 'ok',
      integrityNote: null
    }

    writeFileSync(join(partialDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
    // انتشارِ اتمیک: پوشهٔ نیمه‌کاره با نامِ نهایی جایگزین می‌شود. یک بکاپ فقط
    // وقتی «وجود دارد» که مانیفست و داده‌اش کامل و کنار هم باشند.
    mkdirSync(this.backupsDir, { recursive: true })
    if (existsSync(finalDir)) {
      rmSync(finalDir, { recursive: true, force: true })
    }
    renameSync(partialDir, finalDir)

    return manifest
  }

  // ──────────────────────────────────────────────────────────── خواندنِ فهرست

  list(): BackupSummary[] {
    if (!existsSync(this.backupsDir)) {
      return []
    }
    const summaries: BackupSummary[] = []
    for (const name of readdirSync(this.backupsDir)) {
      if (name.endsWith('.partial')) {
        continue
      }
      const manifest = this.readManifest(name)
      if (!manifest) {
        continue
      }
      summaries.push({
        id: manifest.id,
        kind: manifest.kind,
        createdAt: manifest.createdAt,
        totalRows: manifest.totalRows,
        fileBytes: manifest.fileBytes,
        commitShort: manifest.commitShort,
        integrity: manifest.integrity,
        tables: manifest.tables.length
      })
    }
    return summaries.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  readManifest(id: string): BackupManifest | null {
    if (!isBackupId(id)) {
      return null
    }
    try {
      const raw = readFileSync(join(this.dirPath(id), 'manifest.json'), 'utf8')
      const manifest = JSON.parse(raw) as BackupManifest
      if (manifest.formatVersion !== BACKUP_FORMAT_VERSION) {
        return null
      }
      return manifest
    } catch {
      return null
    }
  }

  // ──────────────────────────────────────────────────────────── بررسیِ سلامت

  /**
   * بررسیِ واقعیِ بکاپ — نه «فایل هست».
   *
   * چهار سنجه، و هر کدام یک دستهٔ شکستِ متفاوت را می‌گیرد:
   *  ۱. gzip کامل باز می‌شود (بریدگیِ فایل و خرابیِ بیت را می‌گیرد).
   *  ۲. هر خط JSON معتبر است (نوشتارِ نیمه‌کاره را می‌گیرد).
   *  ۳. اثر انگشتِ کلِ داده با مانیفست می‌خواند.
   *  ۴. شمارش و هشِ **هر جدول** جداگانه می‌خواند (جابه‌جاییِ داده را می‌گیرد
   *     که هشِ کل ممکن است پنهانش کند).
   *
   * نتیجه در خودِ مانیفست نوشته می‌شود تا مالک بدونِ اجرای دوبارهٔ بررسی هم
   * بداند آخرین نتیجه چه بوده.
   */
  async verify(id: string): Promise<VerifyResult> {
    const manifest = this.readManifest(id)
    if (!manifest) {
      return {
        id,
        ok: false,
        integrity: 'invalid',
        note: 'این بکاپ پیدا نشد یا قالبش خوانا نیست.',
        tables: 0,
        rows: 0,
        dataSha256: null
      }
    }

    const dataPath = join(this.dirPath(id), 'data.ndjson.gz')
    if (!existsSync(dataPath)) {
      return this.recordVerify(id, manifest, false, 'فایلِ دادهٔ این بکاپ وجود ندارد.')
    }

    const overall = createHash('sha256')
    const perTable = new Map<string, { rows: number; hash: ReturnType<typeof createHash> }>()
    const counts = new Map<string, number>()
    let totalRows = 0

    try {
      const result = await new Promise<string | null>((resolve, reject) => {
        let buffer = ''
        const gunzip = createGunzip()
        const input = createReadStream(dataPath)
        input.once('error', reject)
        gunzip.once('error', reject)
        gunzip.on('data', (chunk: Buffer) => {
          overall.update(chunk)
          buffer += chunk.toString('utf8')
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''
          for (const line of lines) {
            if (line.length === 0) {
              continue
            }
            let parsed: { t?: unknown; r?: unknown }
            try {
              parsed = JSON.parse(line) as { t?: unknown; r?: unknown }
            } catch {
              resolve('ساختار فایلِ دادهٔ این بکاپ خراب است.')
              input.destroy()
              gunzip.destroy()
              return
            }
            if (typeof parsed.t !== 'string') {
              resolve('ساختار فایلِ دادهٔ این بکاپ خراب است.')
              input.destroy()
              gunzip.destroy()
              return
            }
            const entry = perTable.get(parsed.t) ?? { rows: 0, hash: createHash('sha256') }
            entry.rows += 1
            entry.hash.update(`${line}\n`, 'utf8')
            perTable.set(parsed.t, entry)
            counts.set(parsed.t, (counts.get(parsed.t) ?? 0) + 1)
            totalRows += 1
          }
        })
        gunzip.once('end', () => resolve(null))
        input.pipe(gunzip)
      })

      if (result !== null) {
        return this.recordVerify(id, manifest, false, result)
      }
    } catch (error) {
      logger.warn({ err: error, id }, 'backup verify failed while reading')
      return this.recordVerify(id, manifest, false, 'خواندنِ فایلِ بکاپ کامل نشد (فایل بریده یا خراب است).')
    }

    const dataSha256 = overall.digest('hex')
    if (dataSha256 !== manifest.dataSha256) {
      return this.recordVerify(id, manifest, false, 'اثر انگشتِ دادهٔ بکاپ با زمانِ ساخت نمی‌خواند.')
    }
    if (totalRows !== manifest.totalRows) {
      return this.recordVerify(
        id,
        manifest,
        false,
        `تعدادِ ردیف‌ها با زمانِ ساخت نمی‌خواند (${totalRows} در برابر ${manifest.totalRows}).`
      )
    }
    for (const table of manifest.tables) {
      const seen = perTable.get(table.name)
      const rows = counts.get(table.name) ?? 0
      if (!seen || rows !== table.rows) {
        return this.recordVerify(id, manifest, false, `جدولِ «${table.name}» کامل نیست.`)
      }
      if (seen.hash.digest('hex') !== table.sha256) {
        return this.recordVerify(id, manifest, false, `محتوای جدولِ «${table.name}» با زمانِ ساخت نمی‌خواند.`)
      }
    }

    return this.recordVerify(
      id,
      manifest,
      true,
      `سالم است: ${manifest.tables.length} جدول و ${totalRows} ردیف بازخوانی و تأیید شد.`,
      dataSha256
    )
  }

  private recordVerify(
    id: string,
    manifest: BackupManifest,
    ok: boolean,
    note: string,
    dataSha256: string | null = null
  ): VerifyResult {
    const updated: BackupManifest = {
      ...manifest,
      integrity: ok ? 'ok' : 'invalid',
      integrityNote: note
    }
    try {
      writeFileSync(join(this.dirPath(id), 'manifest.json'), JSON.stringify(updated, null, 2))
    } catch (error) {
      logger.warn({ err: error, id }, 'could not record backup verification')
    }
    return {
      id,
      ok,
      integrity: updated.integrity,
      note,
      tables: manifest.tables.length,
      rows: manifest.totalRows,
      dataSha256
    }
  }

  // ─────────────────────────────────────────────────────── درخواستِ بازیابی

  /**
   * درخواستِ بازیابی از سمت ربات.
   *
   * این تابع **کارِ بازیابی را انجام نمی‌دهد**. فقط می‌سنجد که این درخواست
   * ارزشِ شروع را دارد، وضعیت را می‌نویسد و فرآیندِ جدا را رها می‌کند. کارِ
   * واقعی (`restoreNow`) در فرآیندی اجرا می‌شود که پس از خاموش‌شدنِ ربات
   * ادامه می‌یابد — چون بازیابی نباید با نویسندهٔ زندهٔ دیتابیس هم‌زمان شود.
   *
   * چرا قفل این‌جا گرفته **نمی‌شود**؟ چون آن فرآیند باید خودش قفل را بگیرد
   * (وگرنه نمی‌توانست تشخیص بدهد بازیابیِ دیگری مشغول است). این‌جا فقط
   * خوانده می‌شود تا مالک پیامِ روشنی بگیرد به‌جای این‌که کار بی‌اثر بیفتد؛
   * نگهبانِ واقعی قفلِ فرآیندِ جدا است که «fail-closed» عمل می‌کند.
   */
  requestRestore(id: string, actorTelegramId: bigint): RestoreRequestResult {
    const availability = this.availability()
    if (!availability.available) {
      return { started: false, reason: availability.reason, outcome: null }
    }
    if (!isBackupId(id) || !this.readManifest(id)) {
      return { started: false, reason: 'این بکاپ پیدا نشد.', outcome: null }
    }
    if (this.opsLock.isHeld()) {
      return { started: false, reason: 'یک عملیاتِ سنگینِ دیگر همین حالا در جریان است.', outcome: null }
    }
    if (this.updateLock.isHeld()) {
      return {
        started: false,
        reason: 'یک به‌روزرسانی در جریان است؛ بازیابی روی کدِ نیمه‌جدید انجام نمی‌شود.',
        outcome: null
      }
    }

    try {
      this.spawnDetachedRestore(id, actorTelegramId)
    } catch (error) {
      logger.error({ err: error, id }, 'restore spawn failed')
      return { started: false, reason: 'اجرای فرآیندِ بازیابی ممکن نشد. لاگ سرور را ببین.', outcome: null }
    }

    this.opsState.write({
      phase: 'running',
      operation: 'restore',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      message: 'بازیابی آغاز شد؛ ربات لحظه‌ای خاموش و دوباره روشن می‌شود.',
      backupId: id,
      actorId: actorTelegramId.toString()
    })
    return { started: true, reason: null, outcome: null }
  }

  /**
   * اجرای detached چرخهٔ بازیابی.
   *
   * `detached` + `unref()` فرزند را از چرخهٔ زندگیِ ربات بیرون می‌کند؛ وگرنه
   * `stop_bot` که خودِ اسکریپت اجرا می‌کند، همان فرآیندی را می‌کشد که باید
   * ربات را دوباره بالا بیاورد. خروجی به فایلِ لاگ می‌رود تا پس از مرگِ والد
   * گم نشود.
   *
   * هیچ ورودیِ متنیِ کاربری به فرمان نمی‌رسد: نامِ اسکریپت ثابت است و شناسهٔ
   * بکاپ پیش از این با `isBackupId` اعتبارسنجی شده (۱۴ رقم + ۴ نویسهٔ
   * alphanumeric)، پس نمی‌تواند به آرگومانِ دلخواه تبدیل شود.
   */
  private spawnDetachedRestore(id: string, actorTelegramId: bigint): void {
    const scriptPath = join(this.repoRoot, RESTORE_SCRIPT)
    mkdirSync(this.toolsPath, { recursive: true })
    const out = openSync(join(this.toolsPath, 'ops.log'), 'a')
    try {
      const child = spawn('bash', [scriptPath, 'restore', id], {
        cwd: this.repoRoot,
        detached: true,
        stdio: ['ignore', out, out],
        env: { ...process.env, OPS_ACTOR_ID: actorTelegramId.toString() }
      })
      // شکستِ اجرا (مثلاً نبودِ `bash`) روی رویداد `error` می‌آید، نه به‌صورت
      // throw. بدونِ این شنونده، Node با استثنای مدیریت‌نشده کل ربات را
      // می‌کشد و وضعیت برای همیشه «در حال بازیابی» می‌ماند.
      child.on('error', (error) => {
        logger.error({ err: error, id }, 'restore process failed to start')
        this.opsState.write({
          phase: 'failed',
          operation: 'restore',
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          message: 'اجرای فرآیندِ بازیابی ممکن نشد.',
          backupId: id,
          actorId: actorTelegramId.toString()
        })
      })
      child.unref()
      logger.info({ pid: child.pid, id }, 'restore process started')
    } finally {
      closeSync(out)
    }
  }

  /** وضعیتِ آخرین عملیاتِ عملیاتی — برای پنلِ مالک. */
  operationState(): ReturnType<OpsStateFile['read']> {
    return this.opsState.read()
  }

  // ──────────────────────────────────────────────────────────── بازیابی

  /**
   * بازیابیِ کامل — کار واقعی، پیش از راه‌اندازی دوبارهٔ ربات.
   *
   * این تابع از فرآیندِ **جدا** (`restore-cli`) صدا زده می‌شود، نه از خودِ
   * ربات: هنگامِ بازیابی نباید هیچ نویسندهٔ زنده‌ای روی دیتابیس باشد، وگرنه
   * ردیف‌هایی که بعد از پاک‌سازی نوشته می‌شوند با دادهٔ بکاپ درگیر می‌شوند.
   *
   * ترتیبِ ایمنی، عمدی:
   *   ۱. بکاپِ ایمنی از وضعیتِ **فعلی** — تا بازگشت همیشه ممکن باشد.
   *   ۲. بررسیِ سلامتِ بکاپِ هدف با خواندنِ کاملِ فایل.
   *   ۳. بررسیِ سازگاریِ مهاجرت‌ها (بکاپ نباید جلوتر از دیتابیس باشد).
   *   ۴. یک تراکنش: پاک‌سازی + درج + تأییدِ شمارش.
   */
  async restoreNow(id: string): Promise<RestoreOutcome> {
    const availability = this.availability()
    if (!availability.available) {
      return {
        ok: false,
        backupId: id,
        message: availability.reason ?? 'بازیابی روی این سرور ممکن نیست.',
        safetyBackupId: null,
        tablesRestored: 0,
        rowsRestored: 0
      }
    }

    if (!this.opsLock.tryAcquire()) {
      return {
        ok: false,
        backupId: id,
        message: 'یک عملیاتِ سنگینِ دیگر همین حالا در جریان است.',
        safetyBackupId: null,
        tablesRestored: 0,
        rowsRestored: 0
      }
    }

    try {
      if (this.updateLock.isHeld()) {
        return {
          ok: false,
          backupId: id,
          message: 'یک به‌روزرسانی در جریان است؛ بازیابی روی کدِ نیمه‌جدید انجام نمی‌شود.',
          safetyBackupId: null,
          tablesRestored: 0,
          rowsRestored: 0
        }
      }

      const manifest = this.readManifest(id)
      if (!manifest) {
        return {
          ok: false,
          backupId: id,
          message: 'این بکاپ پیدا نشد.',
          safetyBackupId: null,
          tablesRestored: 0,
          rowsRestored: 0
        }
      }

      const verified = await this.verify(id)
      if (!verified.ok) {
        return {
          ok: false,
          backupId: id,
          message: `این بکاپ سالم نیست و بازیابی نشد: ${verified.note}`,
          safetyBackupId: null,
          tablesRestored: 0,
          rowsRestored: 0
        }
      }

      const compatibility = await this.checkCompatibility(manifest)
      if (!compatibility.ok) {
        return {
          ok: false,
          backupId: id,
          message: compatibility.reason ?? 'این بکاپ با وضعیت فعلی دیتابیس سازگار نیست.',
          safetyBackupId: null,
          tablesRestored: 0,
          rowsRestored: 0
        }
      }

      let safetyBackupId: string | null = null
      try {
        const safety = await this.create('pre-restore')
        safetyBackupId = safety.id
      } catch (error) {
        // بدونِ نقطهٔ بازگشت، بازیابیِ برگشت‌ناپذیر انجام نمی‌شود. این
        // محافظه‌کاری است، نه شکستِ قابلیت.
        logger.error({ err: error }, 'safety backup before restore failed')
        return {
          ok: false,
          backupId: id,
          message: 'بکاپِ ایمنی پیش از بازیابی ساخته نشد؛ برای احتیاط بازیابی متوقف شد.',
          safetyBackupId: null,
          tablesRestored: 0,
          rowsRestored: 0
        }
      }

      const result = await this.applyRestore(manifest)
      return { ...result, safetyBackupId }
    } finally {
      this.opsLock.release()
    }
  }

  /**
   * آیا بکاپِ هدف با دیتابیسِ فعلی می‌خواند؟
   *
   * خطرِ واقعی: بکاپِ **جدیدتر** از کدِ فعلی. جدول‌ها یا ستون‌هایی در بکاپ
   * هستند که این نسخهٔ کد و این اسکیما نمی‌شناسند؛ بازیابی آن یعنی دیتابیسی
   * که کدِ فعلی نمی‌تواند بخواند. مهاجرت‌های بکاپ باید زیرمجموعهٔ مهاجرت‌های
   * اعمال‌شده باشند.
   */
  async checkCompatibility(manifest: BackupManifest): Promise<{ ok: boolean; reason: string | null }> {
    const applied = await this.appliedMigrations()
    if (applied === null) {
      return { ok: false, reason: 'وضعیتِ مهاجرت‌های دیتابیس خوانده نشد.' }
    }
    const appliedSet = new Set(applied.map((row) => row.migrationName))
    const unknown = manifest.migrations.filter((name) => !appliedSet.has(name))
    if (unknown.length > 0) {
      return {
        ok: false,
        reason: `این بکاپ از نسخه‌ای جلوتر از کدِ فعلی است (${unknown.length} مهاجرتِ ناشناخته).`
      }
    }
    return { ok: true, reason: null }
  }

  private async appliedMigrations(): Promise<AppliedMigration[] | null> {
    try {
      const rows = await this.db.query<{
        migration_name: string
        checksum: string | null
        finished_at: Date | string | null
        rolled_back_at: Date | string | null
      }>(
        `SELECT migration_name, checksum, finished_at, rolled_back_at
           FROM "_prisma_migrations" ORDER BY migration_name`
      )
      return rows.map((row) => ({
        migrationName: row.migration_name,
        checksum: row.checksum,
        finishedAt: row.finished_at,
        rolledBackAt: row.rolled_back_at
      }))
    } catch (error) {
      logger.warn({ err: error }, 'could not read applied migrations')
      return null
    }
  }

  /** مهاجرت‌های روی دیسک — برای گزارشِ هم‌خوانیِ کد و دیتابیس. */
  diskMigrations(): { name: string; checksum: string }[] {
    return readDiskMigrations(this.migrationsDir)
  }

  /**
   * هستهٔ بازیابی: پاک‌سازی و درج در یک تراکنش، سپس تأییدِ شمارش.
   */
  private async applyRestore(manifest: BackupManifest): Promise<Omit<RestoreOutcome, 'safetyBackupId'>> {
    // ردیف‌های بکاپ، دسته‌بندی‌شده بر اساس جدول — کل فایلِ فشرده‌نشده برای
    // بازیابیِ درست لازم است و برای دیتابیسِ این بازی چند مگابایت است.
    let grouped: Map<string, string[]>
    try {
      grouped = await this.readGroupedRows(manifest.id)
    } catch (error) {
      logger.error({ err: error }, 'restore could not read backup rows')
      return {
        ok: false,
        backupId: manifest.id,
        message: 'خواندنِ دادهٔ بکاپ ممکن نشد.',
        tablesRestored: 0,
        rowsRestored: 0
      }
    }

    try {
      const outcome = await this.db.transaction(async (tx) => {
        // خاموش‌کردنِ بررسیِ کلید خارجی درونِ همین تراکنش. اگر کاربر اجازه
        // نداشته باشد فقط لاگ می‌شود؛ ترتیبِ توپولوژیکِ زیر کار را می‌کند.
        try {
          await tx.execute("SET LOCAL session_replication_role = 'replica'")
        } catch (error) {
          logger.warn({ err: error }, 'session_replication_role unavailable; relying on insert order')
        }

        const catalog = await this.readCatalog(tx)
        const order = this.restoreOrder(catalog)

        if (catalog.tables.length > 0) {
          await tx.execute(`TRUNCATE TABLE ${catalog.tables.map(quoteIdent).join(', ')}`)
        }

        let restored = 0
        let tables = 0
        for (const table of order) {
          const lines = grouped.get(table)
          if (!lines || lines.length === 0) {
            continue
          }
          const quoted = quoteIdent(table)
          for (let index = 0; index < lines.length; index += WRITE_BATCH) {
            const batch = lines
              .slice(index, index + WRITE_BATCH)
              .map((line) => (JSON.parse(line) as { r: unknown }).r)
            await tx.execute(
              `INSERT INTO ${quoted} SELECT * FROM jsonb_populate_recordset(null::${quoted}, $1::jsonb)`,
              [JSON.stringify(batch)]
            )
          }
          restored += lines.length
          tables += 1
        }

        // تأییدِ درونِ تراکنش: اگر شمارش نخواند، کامیت نمی‌شود و دادهٔ فعلی
        // دست‌نخورده می‌ماند. این همان چیزی است که «موفق شد» را صادق می‌کند.
        for (const table of manifest.tables) {
          const rows = await tx.query<{ n: bigint }>(`SELECT count(*)::bigint AS n FROM ${quoteIdent(table.name)}`)
          const count = Number(rows[0]?.n ?? 0)
          if (count !== table.rows) {
            throw new Error(`شمارشِ جدولِ «${table.name}» با بکاپ نمی‌خواند (${count} در برابر ${table.rows})`)
          }
        }

        return { tables, restored }
      })

      return {
        ok: true,
        backupId: manifest.id,
        message: `بازیابی کامل شد: ${outcome.tables} جدول و ${outcome.restored} ردیف.`,
        tablesRestored: outcome.tables,
        rowsRestored: outcome.restored
      }
    } catch (error) {
      // تراکنش برگشت خورد → دیتابیس همان‌جایی است که بود. این پیام نباید
      // هیچ ادعای موفقیّتی داشته باشد.
      logger.error({ err: error, id: manifest.id }, 'restore rolled back')
      return {
        ok: false,
        backupId: manifest.id,
        message: 'بازیابی انجام نشد و همه‌چیز به حالتِ قبل برگشت.',
        tablesRestored: 0,
        rowsRestored: 0
      }
    }
  }

  /** خواندنِ کلِ فایلِ بکاپ و گروه‌بندیِ خط‌ها بر اساس جدول. */
  private async readGroupedRows(id: string): Promise<Map<string, string[]>> {
    const dataPath = join(this.dirPath(id), 'data.ndjson.gz')
    const grouped = new Map<string, string[]>()
    await new Promise<void>((resolve, reject) => {
      let buffer = ''
      const input = createReadStream(dataPath)
      const gunzip = createGunzip()
      input.once('error', reject)
      gunzip.once('error', reject)
      gunzip.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8')
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (line.length === 0) {
            continue
          }
          const table = (JSON.parse(line) as { t: string }).t
          const list = grouped.get(table) ?? []
          list.push(line)
          grouped.set(table, list)
        }
      })
      gunzip.once('end', () => resolve())
      input.pipe(gunzip)
    })
    return grouped
  }

  // ──────────────────────────────────────────────────────────── پاک‌سازی

  /**
   * پاک‌سازیِ بکاپ‌های قدیمی.
   *
   * دو استثنا هرگز پاک نمی‌شوند، حتی اگر از سقفِ نگه‌داری بیرون باشند:
   * جدیدترین بکاپِ کلی، و جدیدترین بکاپِ **ایمنیِ** هر نوع. بکاپِ ایمنی نقطهٔ
   * بازگشتِ یک عملیاتِ برگشت‌ناپذیر است؛ حذفِ آن یعنی از دست دادنِ تنها راهِ
   * بازگشت به‌خاطر نظمِ فهرست.
   */
  prune(keep: number = this.keep): string[] {
    const all = this.list()
    if (all.length <= keep) {
      return []
    }
    const keepIds = new Set(all.slice(0, keep).map((entry) => entry.id))
    for (const kind of ['pre-restore', 'pre-update'] as const) {
      const newest = all.find((entry) => entry.kind === kind)
      if (newest) {
        keepIds.add(newest.id)
      }
    }

    const removed: string[] = []
    for (const entry of all) {
      if (keepIds.has(entry.id)) {
        continue
      }
      try {
        rmSync(this.dirPath(entry.id), { recursive: true, force: true })
        removed.push(entry.id)
      } catch (error) {
        logger.warn({ err: error, id: entry.id }, 'could not remove old backup')
      }
    }
    return removed
  }

  /** پوشهٔ بکاپ‌های نیمه‌کاره — پس از یک crash، باید پاک شوند. */
  removePartialDirs(): string[] {
    if (!existsSync(this.backupsDir)) {
      return []
    }
    const removed: string[] = []
    for (const name of readdirSync(this.backupsDir)) {
      if (!name.endsWith('.partial')) {
        continue
      }
      try {
        rmSync(join(this.backupsDir, name), { recursive: true, force: true })
        removed.push(name)
      } catch {
        // پاک‌نشدنِ یک پوشهٔ نیمه‌کاره مانع کار نیست.
      }
    }
    return removed
  }

  /** حذفِ یک بکاپ — فقط با درخواستِ صریح. */
  remove(id: string): boolean {
    if (!this.readManifest(id)) {
      return false
    }
    try {
      rmSync(this.dirPath(id), { recursive: true, force: true })
      return true
    } catch {
      return false
    }
  }
}
