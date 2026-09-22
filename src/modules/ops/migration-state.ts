/**
 * وضعیتِ مهاجرت‌های دیتابیس — سنجشِ واقعیِ «آیا دیتابیس با این کد می‌خواند؟»
 *
 * ## چرا این سنجش لازم است؟
 * سه واگراییِ واقعی وجود دارد و هر سه بی‌صدا هستند — هیچ‌کدام خطا نمی‌دهد،
 * فقط ربات رفتاری می‌کند که با کدش نمی‌خواند:
 *
 *  ۱. **مهاجرتِ اعمال‌نشده** (کد جلوتر از دیتابیس): کدِ تازه روی ستون/جدولی
 *     کار می‌کند که هنوز ساخته نشده. اولین کسی که به آن مسیر برسد خطا می‌گیرد.
 *  ۲. **مهاجرتِ گم‌شده** (دیتابیس جلوتر از کد): روی سرور نسخهٔ جدیدتری اجرا
 *     شده و بعد کد به نسخهٔ قدیمی برگشته. جدول هست ولی کد نمی‌شناسدش.
 *  ۳. **مهاجرتِ ویرایش‌شده**: فایلِ یک مهاجرتِ اعمال‌شده بعداً دست‌کاری شده.
 *     دیتابیس‌ها یکسان نیستند ولی هیچ‌کس نمی‌داند کدام درست است.
 *
 * منبعِ حقیقت، جدولِ `_prisma_migrations` است که مهاجرت‌سازِ آفلاین
 * (`offline-deps/scripts/migrate.js`) با فرمتِ دقیقِ Prisma 6.19 پر می‌کند:
 * `migration_name` = نام پوشه، و `checksum` = sha256 هگزِ محتوای
 * `migration.sql` با BOM حذف‌شده. پس مقایسهٔ چک‌سام معتبر است، نه حدس.
 */
import { createHash } from 'crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'

/** یک مهاجرتِ روی دیسک. */
export interface DiskMigration {
  name: string
  /** sha256 هگزِ محتوای فایل — همان الگوریتمِ مهاجرت‌ساز. */
  checksum: string
}

/** یک ردیفِ جدولِ `_prisma_migrations`. */
export interface AppliedMigration {
  migrationName: string
  checksum: string | null
  finishedAt: Date | string | null
  rolledBackAt: Date | string | null
}

export interface MigrationState {
  onDisk: number
  applied: number
  /** روی دیسک هست، اعمال نشده — کد جلوتر از دیتابیس است. */
  pending: string[]
  /** اعمال شده، روی دیسک نیست — کد از دیتابیس عقب‌تر است. */
  missing: string[]
  /** چک‌سامِ مهاجرتِ اعمال‌شده با فایلِ فعلی نمی‌خواند. */
  drifted: string[]
  /** نیمه‌کاره یا برگشت‌خورده. */
  failed: string[]
  /** آیا همه‌چیز هم‌خوان است؟ */
  ok: boolean
}

/**
 * خواندنِ مهاجرت‌های روی دیسک.
 *
 * ریشهٔ ایراد: چک‌سام باید **دقیقاً** مثل مهاجرت‌ساز حساب شود، وگرنه هر
 * مهاجرتِ سالم «ویرایش‌شده» گزارش می‌شود. مهاجرت‌ساز BOM را پیش از هش‌گیری
 * حذف می‌کند (`replace(/^\uFEFF/, '')`) چون PostgreSQL 18 آن را نمی‌پذیرد؛
 * همان قاعده این‌جا هم تکرار می‌شود.
 */
export function readDiskMigrations(migrationsDir: string): DiskMigration[] {
  if (!existsSync(migrationsDir)) {
    return []
  }
  return readdirSync(migrationsDir)
    .filter((name) => {
      const dir = join(migrationsDir, name)
      try {
        return statSync(dir).isDirectory() && existsSync(join(dir, 'migration.sql'))
      } catch {
        return false
      }
    })
    .sort()
    .map((name) => {
      const sql = readFileSync(join(migrationsDir, name, 'migration.sql'), 'utf8').replace(/^\uFEFF/, '')
      return { name, checksum: createHash('sha256').update(sql, 'utf8').digest('hex') }
    })
}

/** تبدیل تاریخِ احتمالی به رشتهٔ ISO — ورودیِ درایور می‌تواند Date باشد. */
function asIso(value: Date | string | null): string | null {
  if (value === null) {
    return null
  }
  return value instanceof Date ? value.toISOString() : String(value)
}

/**
 * مقایسهٔ دیسک و دیتابیس.
 *
 * عمداً هیچ‌کدام از این حالات «خطا» پرتاب نمی‌کند: نبودِ جدولِ
 * `_prisma_migrations` یک وضعیتِ واقعی است (دیتابیسِ تازه یا دستی‌ساخته)، نه
 * یک استثنا. بازگشتِ وضعیتِ ساخت‌یافته یعنی پنل می‌تواند به مالک *بگوید*
 * مشکل چیست، به‌جای این‌که فقط بترکد.
 */
export function compareMigrations(
  disk: DiskMigration[],
  applied: AppliedMigration[]
): MigrationState {
  const diskByName = new Map(disk.map((row) => [row.name, row]))

  const live = applied.filter((row) => asIso(row.rolledBackAt) === null)
  const done = live.filter((row) => asIso(row.finishedAt) !== null)
  // معیارِ هر دو سنجه `done` است، نه «هر ردیفی که در جدول هست» و نه `live`:
  //  • مهاجرتِ برگشت‌خورده روی دیسک هست ولی **اثر ندارد** → باید «اعمال‌نشده»
  //    شمرده شود (اگر ردیفِ برگشت‌خورده را «اعمال‌شده» بگیریم، کدِ ناقص
  //    هم‌خوان گزارش می‌شود).
  //  • و برعکس، مهاجرتِ برگشت‌خورده «گم‌شده» نیست؛ فایلش همان‌جاست.
  const doneByName = new Map(done.map((row) => [row.migrationName, row]))

  const pending = disk.filter((row) => !doneByName.has(row.name)).map((row) => row.name)
  const missing = done.filter((row) => !diskByName.has(row.migrationName)).map((row) => row.migrationName)

  // فقط مهاجرت‌های *اعمال‌شده* معیارِ مقایسهٔ محتوا هستند؛ مهاجرتی که هنوز
  // اجرا نشده طبیعی است که در دیتابیس نباشد.
  const drifted = done
    .filter((row) => {
      const onDisk = diskByName.get(row.migrationName)
      if (!onDisk || !row.checksum) {
        return false
      }
      return row.checksum !== onDisk.checksum
    })
    .map((row) => row.migrationName)

  const failed = live.filter((row) => asIso(row.finishedAt) === null).map((row) => row.migrationName)

  return {
    onDisk: disk.length,
    applied: done.length,
    pending,
    missing,
    drifted,
    failed,
    ok: pending.length === 0 && missing.length === 0 && drifted.length === 0 && failed.length === 0
  }
}
