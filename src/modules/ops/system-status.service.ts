/**
 * وضعیتِ سیستم — یک نگاهِ صادقانه به سرور، از داخلِ خودِ ربات.
 *
 * ## چه چیزی این‌جا هست و چه چیزی نیست
 * پنلِ مالک باید سه سؤال را بی‌درنگ جواب بدهد: «کدام کد اجرا می‌شود؟»،
 * «دیتابیس سالم است؟» و «آخرین عملیات موفق بود؟». هرچه در این سرویس جمع
 * می‌شود از **درونِ فرآیند** یا از **دیتابیس** می‌آید؛ هیچ‌کدام از shell
 * نمی‌آید. این عمدی است: تنها راهِ رسیدنِ یک پیامِ تلگرام به shell باید همان
 * یک مسیرِ بازبینی‌شده باشد (`DeployService` → `install.sh`) و بس. یک
 * «کنسول» که دستورِ آزاد اجرا کند، سطحِ حمله را از یک اسکریپتِ ثابت به کلِ
 * سرور گسترش می‌دهد و هیچ بازبینیِ کدی نمی‌تواند تضمینش کند.
 *
 * ## چه چیزی هرگز برنمی‌گردد
 * توکن، رمز، `DATABASE_URL` با اعتبارنامه، مسیرهای حساس یا متغیرهای محیط.
 * حتی نامِ کاربر و میزبانِ دیتابیس هم نمایش داده نمی‌شود؛ فقط «سالم/ناسالم»
 * و اندازه و تأخیر. پنل روی تلگرام است و اسکرین‌شاتِ آن بیرون می‌رود.
 */
import { logger } from '../../utils/logger'
import type { DeployService, DeployStatus } from '../deploy/deploy.service'
import type { CodeState, CodeStateReader } from './code-state'
import { compareMigrations, type AppliedMigration, type MigrationState } from './migration-state'
import type { OpsDatabase } from './ops-database'
import type { BackupService, BackupSummary } from './backup.service'
import type { OpsOperationState, OpsStateFile } from './ops-state'
import { opsLockPath, updateLockPath, FileLock } from './ops-lock'

/** قفلِ عملیات در پنل با همان سنِ سرویسِ بکاپ سنجیده می‌شود. */
const LOCK_STALE_MS = 30 * 60 * 1000
/** مهلتِ پرس‌وجوی سلامت — نبودِ دیتابیس نباید پنل را بی‌پاسخ بگذارد. */
const HEALTH_TIMEOUT_MS = 5_000

export interface DatabaseStatus {
  reachable: boolean
  latencyMs: number | null
  version: string | null
  sizeBytes: number | null
  tables: number | null
  error: string | null
  migrations: MigrationState | null
}

export interface RuntimeStatus {
  pid: number
  uptimeSec: number
  node: string
  env: string
  rssMb: number
  heapUsedMb: number
}

export interface PopulationStatus {
  players: number
  groups: number
}

export interface BackupStatus {
  count: number
  newest: BackupSummary | null
  invalid: number
  /** بکاپ‌هایی که هرگز بررسیِ سلامت نشده‌اند. */
  unverified: number
  totalBytes: number
  lockHeld: boolean
}

export interface SystemSnapshot {
  runtime: RuntimeStatus
  code: CodeState
  database: DatabaseStatus
  population: PopulationStatus | null
  deploy: DeployStatus
  deployLockHeld: boolean
  ops: OpsOperationState
  backups: BackupStatus
  upgrades: { available: boolean; reason: string | null }
}

/** شمارندهٔ جمعیت — تزریق‌شده تا سرویس به مدل‌های دامنه چسبیده نباشد. */
export type PopulationCounter = () => Promise<PopulationStatus | null>

export class SystemStatusService {
  constructor(
    private readonly db: OpsDatabase,
    private readonly codeState: CodeStateReader,
    private readonly deployService: DeployService,
    private readonly backupService: BackupService,
    private readonly opsState: OpsStateFile,
    private readonly repoRoot: string = process.cwd(),
    private readonly populationCounter: PopulationCounter = async () => null
  ) {}

  /**
   * فقط وضعیتِ کد — سبک و از حافظهٔ نهان.
   *
   * `snapshot()` برای پنل است و چند پرس‌وجوی دیتابیس می‌زند؛ وقتی فقط مُهرِ
   * کامیت لازم است (مثلاً در مانیفستِ بکاپ)، سنجشِ کلِ سرور کارِ بی‌مورد است.
   */
  codeInfo(): Promise<CodeState> {
    return this.codeState.read()
  }

  async snapshot(): Promise<SystemSnapshot> {
    const [code, database, population] = await Promise.all([
      this.codeState.read(),
      this.databaseStatus(),
      this.safePopulation()
    ])

    const backups = this.backupService.list()
    return {
      runtime: this.runtimeStatus(),
      code,
      database,
      population,
      deploy: this.deployService.status(),
      deployLockHeld: new FileLock(updateLockPath(this.repoRoot), LOCK_STALE_MS).isHeld(),
      ops: this.opsState.read(),
      backups: {
        count: backups.length,
        newest: backups[0] ?? null,
        invalid: backups.filter((entry) => entry.integrity === 'invalid').length,
        unverified: backups.filter((entry) => entry.integrity === 'unverified').length,
        totalBytes: backups.reduce((sum, entry) => sum + entry.fileBytes, 0),
        lockHeld: new FileLock(opsLockPath(this.repoRoot), LOCK_STALE_MS).isHeld()
      },
      upgrades: this.deployService.availability()
    }
  }

  /**
   * سلامتِ دیتابیس، با مهلت.
   *
   * مهلت حیاتی است: اگر دیتابیس پاسخ ندهد، پنلِ مالک باید *بگوید* پاسخ
   * نمی‌دهد. بدون آن، خودِ پنل هم روی همان اتصالِ معلق می‌ماند و مالک هیچ
   * اطلاعاتی نمی‌گیرد — یعنی وقتی بیشترین نیاز به تشخیص هست، هیچ چیز نمی‌بینی.
   */
  private async databaseStatus(): Promise<DatabaseStatus> {
    const empty: DatabaseStatus = {
      reachable: false,
      latencyMs: null,
      version: null,
      sizeBytes: null,
      tables: null,
      error: null,
      migrations: null
    }

    const started = Date.now()
    try {
      const rows = await this.withTimeout(
        this.db.query<{ version: string; size: bigint | number | string | null; tables: bigint | number | string | null }>(
          `SELECT version() AS version,
                  pg_database_size(current_database()) AS size,
                  (SELECT count(*) FROM information_schema.tables
                    WHERE table_schema = 'public' AND table_type = 'BASE TABLE') AS tables`
        )
      )
      const row = rows[0]
      const latencyMs = Date.now() - started
      return {
        reachable: true,
        latencyMs,
        // فقط شمارهٔ نسخه، نه رشتهٔ کاملِ `version()` که نامِ میزبان و معماری
        // سیستم را هم دارد. پنل روی تلگرام است و هرچه کمتر بیرون برود بهتر.
        version: shortVersion(row?.version ?? null),
        sizeBytes: toNumber(row?.size ?? null),
        tables: toNumber(row?.tables ?? null),
        error: null,
        migrations: await this.migrationStatus()
      }
    } catch (error) {
      logger.warn({ err: error }, 'database health probe failed')
      return { ...empty, error: 'دیتابیس پاسخ نداد.' }
    }
  }

  /**
   * مقایسهٔ مهاجرت‌های دیسک و دیتابیس.
   *
   * شکستِ این مرحله کلِ وضعیت را «ناسالم» نمی‌کند: نبودِ جدولِ
   * `_prisma_migrations` یک وضعیتِ واقعی است و باید «نامعلوم» گزارش شود، نه
   * خطا. ولی اگر خوانده شود، نتیجهٔ آن دقیق است.
   */
  private async migrationStatus(): Promise<MigrationState | null> {
    try {
      const rows = await this.withTimeout(
        this.db.query<{
          migration_name: string
          checksum: string | null
          finished_at: Date | string | null
          rolled_back_at: Date | string | null
        }>(
          `SELECT migration_name, checksum, finished_at, rolled_back_at
             FROM "_prisma_migrations" ORDER BY migration_name`
        )
      )
      const applied: AppliedMigration[] = rows.map((row) => ({
        migrationName: row.migration_name,
        checksum: row.checksum,
        finishedAt: row.finished_at,
        rolledBackAt: row.rolled_back_at
      }))
      return compareMigrations(this.backupService.diskMigrations(), applied)
    } catch (error) {
      logger.warn({ err: error }, 'migration status unavailable')
      return null
    }
  }

  private async safePopulation(): Promise<PopulationStatus | null> {
    try {
      return await this.withTimeout(this.populationCounter())
    } catch (error) {
      logger.warn({ err: error }, 'population count failed')
      return null
    }
  }

  private runtimeStatus(): RuntimeStatus {
    const memory = process.memoryUsage()
    return {
      pid: process.pid,
      uptimeSec: Math.floor(process.uptime()),
      node: process.version,
      env: process.env.NODE_ENV ?? 'development',
      rssMb: Math.round(memory.rss / (1024 * 1024)),
      heapUsedMb: Math.round(memory.heapUsed / (1024 * 1024))
    }
  }

  /** مهلت‌دار کردن یک وعده؛ وعدهٔ معلق نباید پنل را نگه دارد. */
  private async withTimeout<T>(promise: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | null = null
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), HEALTH_TIMEOUT_MS)
        })
      ])
    } finally {
      if (timer) {
        clearTimeout(timer)
      }
    }
  }
}

/** `PostgreSQL 16.4 on x86_64...` → `16.4` */
function shortVersion(raw: string | null): string | null {
  if (!raw) {
    return null
  }
  const match = raw.match(/PostgreSQL\s+([0-9]+(?:\.[0-9]+)?)/i)
  return match?.[1] ?? null
}  /** مقادیر `count(*)::bigint` و `pg_database_size` ممکن است رشته یا BigInt باشند. */
function toNumber(value: bigint | number | string | null): number | null {
  if (value === null) {
    return null
  }
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}
