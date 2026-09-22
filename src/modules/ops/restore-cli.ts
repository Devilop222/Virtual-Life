/**
 * ورودیِ فرآیندِ **جدا**ی بازیابی.
 *
 * ## چرا جدا و نه درونِ خودِ ربات؟
 * بازیابی، کلِ داده را پاک و از بکاپ پر می‌کند. اگر رباتی که این کار را
 * می‌کند هنوز زنده باشد، سه چیز هم‌زمان غلط می‌شود:
 *
 *  ۱. **نویسندهٔ زنده.** هر آپدیتِ تلگرام که وسطِ بازیابی پردازش شود، ردیفی
 *     می‌نویسد که پس از پایان کار با دادهٔ بکاپ قاطی می‌شود.
 *  ۲. **حافظهٔ نهانِ سرویس‌ها.** سرویس‌های درون‌حافظه‌ای (آمارِ منطقه، حالتِ
 *     بازیکن) پس از پاک‌شدنِ جدول‌ها همان دادهٔ قدیمی را نگه می‌دارند.
 *  ۳. **مرگِ وسطِ کار.** این فرآیند با `detached` اجرا می‌شود تا مرگِ ربات
 *     نیمه‌کاره‌اش نکند — همان الگویی که استقرار از قبل دارد.
 *
 * پس ترتیبِ `install.sh restore` این است: خاموش‌کردنِ ربات → این فرآیند →
 * روشن‌کردنِ دوباره → بررسیِ سلامت. خودِ رباتی که بازیابی را شروع می‌کند،
 * فقط درخواست را ثبت و فرآیند را رها می‌کند.
 *
 * ## قراردادِ خروجی
 * کد خروجِ غیرصفر یعنی بازیابی موفق نبوده. وضعیتِ انسانی در پروندهٔ
 * `ops.state.json` نوشته می‌شود تا پنلِ مالک پس از بالا آمدنِ دوبارهٔ ربات
 * واقعیت را بگوید — و در صورت شکست، `install.sh` همان پرونده را با پیامِ
 * خودش بازنویسی می‌کند، چون «ربات بالا نیامد» اطلاعاتی است که فقط او دارد.
 */
import 'dotenv/config'
import { resolve } from 'path'
import { prisma } from '../../database/client'
import { logger } from '../../utils/logger'
import { BackupService, isBackupId } from './backup.service'
import { PrismaOpsDatabase } from './ops-database'
import { OpsStateFile, type OpsOperationState } from './ops-state'

async function main(): Promise<number> {
  const backupId = process.argv[2] ?? ''
  const repoRoot = resolve(process.argv[3] ?? process.cwd())
  const actorId = process.env.OPS_ACTOR_ID ?? null
  const state = new OpsStateFile(OpsStateFile.defaultPath(repoRoot))
  const startedAt = new Date().toISOString()

  const write = (phase: OpsOperationState['phase'], message: string): void => {
    state.write({
      phase,
      operation: 'restore',
      startedAt,
      finishedAt: new Date().toISOString(),
      message,
      backupId: backupId.length > 0 ? backupId : null,
      actorId
    })
  }

  // شناسه از `callback_data` می‌آید؛ پیش از هر کاری اعتبارسنجی می‌شود تا
  // ورودیِ نامعتبر به مسیرِ فایل (`.tools/backups/<id>`) نرسد.
  if (!isBackupId(backupId)) {
    write('failed', 'شناسهٔ بکاپ نامعتبر است.')
    return 1
  }

  write('running', 'بازیابی آغاز شد.')
  const service = new BackupService(new PrismaOpsDatabase(prisma), repoRoot)

  try {
    const outcome = await service.restoreNow(backupId)
    const message = outcome.safetyBackupId
      ? `${outcome.message} بکاپِ ایمنی: ${outcome.safetyBackupId}`
      : outcome.message
    write(outcome.ok ? 'success' : 'failed', message)
    return outcome.ok ? 0 : 1
  } catch (error) {
    // خطای پیش‌بینی‌نشده هم باید در پرونده بنشیند؛ وگرنه مالک فقط یک
    // «در حال بازیابی» جاودانه می‌بیند.
    logger.error({ err: error }, 'restore cli failed unexpectedly')
    write('failed', 'بازیابی با خطای غیرمنتظره متوقف شد.')
    return 1
  }
}

void main()
  .then(async (code) => {
    await prisma.$disconnect().catch(() => undefined)
    process.exit(code)
  })
  .catch(async (error: unknown) => {
    logger.error({ err: error }, 'restore cli could not start')
    await prisma.$disconnect().catch(() => undefined)
    process.exit(1)
  })
