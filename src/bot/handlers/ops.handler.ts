/**
 * مرکز کنترلِ مالک — `/botupdate`.
 *
 * ## چه چیزی این‌جا هست
 * یک پنلِ واحد که به سه سؤالِ مالک جواب می‌دهد: کدام کد اجرا می‌شود؟
 * دیتابیس سالم است؟ آخرین عملیاتِ سنگین چگونه تمام شد؟ و از همان‌جا سه کار
 * را می‌شود انجام داد: به‌روزرسانیِ سرور، ساخت/بررسی/بازگرداندنِ بکاپ، و
 * خواندنِ لاگ.
 *
 * ## چه چیزی عمداً این‌جا **نیست**
 * «کنسولِ سرور». در طرحِ خواسته‌شده، مالک باید از تلگرام دستورِ آزاد روی سرور
 * اجرا کند. این پیاده نشد و تصمیم عمدی است، نه کارِ ناتمام:
 *
 *  ۱. تنها راهِ رسیدنِ یک پیامِ تلگرام به `shell` باید همان یک مسیرِ ثابت و
 *     بازبینی‌شده باشد (`DeployService` → `install.sh update`). یک کنسولِ
 *     باز، همان سطحِ حمله را از «یک اسکریپتِ ثابت با یک آرگومانِ ثابت» به
 *     «کلِ سرور» می‌برد: فایلِ توکن، دیتابیس، شبکه.
 *  ۲. ورودیِ متنیِ کاربر باید از shell عبور کند و هیچ بازبینیِ کدی نمی‌تواند
 *     ایمنیِ نقل‌قول‌گذاری را در همهٔ حالت‌ها تضمین کند؛ حتی مالکِ فعلی هم
 *     بعداً عوض می‌شود یا حسابش در دسترسِ دیگری می‌افتد.
 *  ۳. نیازِ واقعیِ مالک — «چه خبر است؟ چه خطایی داد؟» — با خواندنِ لاگِ
 *     سانسورشده جواب می‌گیرد، که محدود و بی‌خطر است.
 *
 * پس جانشینِ امن، پنلِ لاگ است: دنبالهٔ لاگ با حذفِ توکن و نشانیِ اتصال، و
 * هیچ راهی برای اجرای چیزی.
 *
 * ## مرزِ دسترسی
 * هر مسیر — باز کردنِ پنل و هر دکمه — از `gateOwnerPrivate` می‌گذرد: مالکِ
 * واقعیِ ربات **و** چت خصوصی، دوباره و سرور-ساید در هر گام. پنلی که سرور را
 * بازمی‌گرداند جای درستی در گروه ندارد، حتی اگر فرستنده مالک باشد.
 */
import { Bot, Context, InlineKeyboard } from 'grammy'
import { Container } from '../../services/container'
import { sendPanel, editPanel, ackCallback } from '../panel'
import { handleCallbackError, handleCommandError } from '../handler-errors'
import { requireAdmin, requireOwner, isPrivateChat, type AdminGate, type OwnerGate } from '../owner-guard'
import { panel, momentFa, fa } from '../ui-kit'
import { botLogPath } from '../../modules/ops/ops-lock'
import { tailLog } from '../../modules/ops/log-tail'
import type {
  BackupManifest,
  BackupSummary,
  IntegrityStatus
} from '../../modules/ops/backup.service'
import type { SystemSnapshot } from '../../modules/ops/system-status.service'

/** الگوی شناسهٔ بکاپ — تنها ورودیِ متنی که به مسیرِ فایل می‌رسد. */
const BACKUP_ID = '[0-9]{14}[a-z0-9]{4}'

// ──────────────────────────────────────────────────────────────── متن‌های کمکی

/** مدتِ زمانِ خوانا: «۳ ساعت و ۱۲ دقیقه». */
function humanDuration(seconds: number): string {
  if (seconds < 60) {
    return `${fa(seconds)} ثانیه`
  }
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    return `${fa(minutes)} دقیقه`
  }
  const hours = Math.floor(minutes / 60)
  const restMinutes = minutes % 60
  if (hours < 24) {
    return restMinutes > 0 ? `${fa(hours)} ساعت و ${fa(restMinutes)} دقیقه` : `${fa(hours)} ساعت`
  }
  const days = Math.floor(hours / 24)
  const restHours = hours % 24
  return restHours > 0 ? `${fa(days)} روز و ${fa(restHours)} ساعت` : `${fa(days)} روز`
}

/** حجمِ خوانا. */
function humanBytes(bytes: number | null): string {
  if (bytes === null) {
    return 'نامعلوم'
  }
  if (bytes < 1024) {
    return `${fa(bytes)} بایت`
  }
  const kb = bytes / 1024
  if (kb < 1024) {
    return `${fa(Math.round(kb))} کیلوبایت`
  }
  const mb = kb / 1024
  if (mb < 1024) {
    return `${fa(Math.round(mb * 10) / 10)} مگابایت`
  }
  return `${fa(Math.round((mb / 1024) * 10) / 10)} گیگابایت`
}

/** وضعیتِ سلامتِ بکاپ به زبانِ مالک. */
function integrityLabel(status: IntegrityStatus): string {
  if (status === 'ok') {
    return '✅ سالم'
  }
  if (status === 'invalid') {
    return '⛔️ خراب'
  }
  return '⚪️ بررسی‌نشده'
}

function kindLabel(kind: BackupSummary['kind']): string {
  if (kind === 'pre-restore') {
    return 'ایمنیِ بازیابی'
  }
  if (kind === 'pre-update') {
    return 'ایمنیِ به‌روزرسانی'
  }
  return 'دستی'
}

function phaseLabel(phase: string): string {
  if (phase === 'running') {
    return '⏳ در جریان'
  }
  if (phase === 'success') {
    return '✅ موفق'
  }
  if (phase === 'failed') {
    return '⚠️ ناموفق'
  }
  return 'انجام نشده'
}

// ──────────────────────────────────────────────────────────────── مرکز کنترل

/**
 * متنِ مرکز کنترل از وضعیتِ آماده ساخته می‌شود.
 *
 * جدا نگه داشته شده تا بدون تلگرام هم قابل سنجش باشد؛ پنلِ وضعیت باید
 * *دقیق* باشد و آزمونِ دقیق نباید به یک کلاینتِ تلگرام گره بخورد.
 */
export function renderControlCenter(snapshot: SystemSnapshot): string {
  const { runtime, code, database, population, deploy, backups, ops, upgrades } = snapshot

  const healthLine = database.reachable
    ? `✅ پاسخ می‌دهد${database.latencyMs === null ? '' : ` (${fa(database.latencyMs)} هزارم ثانیه)`}`
    : '⛔️ پاسخ نمی‌دهد'

  const migrationsLine = database.migrations
    ? database.migrations.ok
      ? `✅ هم‌خوان (${fa(database.migrations.applied)} مهاجرت)`
      : [
          database.migrations.pending.length > 0
            ? `⏳ ${fa(database.migrations.pending.length)} اعمال‌نشده`
            : null,
          database.migrations.missing.length > 0
            ? `⚠️ ${fa(database.migrations.missing.length)} ناشناخته`
            : null,
          database.migrations.drifted.length > 0
            ? `⚠️ ${fa(database.migrations.drifted.length)} تغییرکرده`
            : null,
          database.migrations.failed.length > 0
            ? `⛔️ ${fa(database.migrations.failed.length)} ناتمام`
            : null
        ]
          .filter((line): line is string => line !== null)
          .join(' · ')
    : 'نامعلوم'

  const artifactLine =
    code.artifact.fresh === true
      ? '✅ هم‌خوان با کدِ مخزن'
      : code.artifact.fresh === false
        ? '⚠️ کهنه‌تر از کدِ مخزن'
        : 'نامعلوم'

  const sections = [
    {
      title: 'کدِ در حال اجرا',
      rows: [
        { label: 'نسخه', value: code.commitShort ?? 'نامعلوم' },
        { label: 'شاخه', value: code.branch ?? 'نامعلوم' },
        { label: 'بستهٔ اجرایی', value: artifactLine },
        {
          label: 'تغییراتِ ذخیره‌نشده',
          value: code.dirtyCount === 0 ? 'ندارد' : `${fa(code.dirtyCount)} فایل`
        }
      ]
    },
    {
      title: 'دیتابیس',
      rows: [
        { label: 'حال', value: healthLine },
        { label: 'نسخه', value: database.version ?? 'نامعلوم' },
        { label: 'حجم', value: humanBytes(database.sizeBytes) },
        { label: 'مهاجرت‌ها', value: migrationsLine },
        { label: 'جدول‌ها', value: database.tables === null ? 'نامعلوم' : fa(database.tables) }
      ]
    },
    {
      title: 'بازیکنان',
      rows:
        population === null
          ? [{ label: 'شمارش', value: 'نامعلوم' }]
          : [
              { label: 'شخصیت‌ها', value: fa(population.players) },
              { label: 'گروه‌ها', value: fa(population.groups) }
            ]
    },
    {
      title: 'آخرین کارها',
      rows: [
        {
          label: 'به‌روزرسانی',
          value:
            deploy.phase === 'success'
              ? `${phaseLabel(deploy.phase)} — ${momentFa(deploy.finishedAt)}`
              : phaseLabel(deploy.phase)
        },
        {
          label: 'بکاپ',
          value:
            backups.newest === null
              ? 'تا حالا گرفته نشده'
              : `${integrityLabel(backups.newest.integrity)} — ${momentFa(new Date(backups.newest.createdAt))}`
        },
        ...(ops.phase === 'idle'
          ? []
          : [{ label: 'آخرین بازیابی', value: phaseLabel(ops.phase) }])
      ]
    },
    {
      title: 'فرآیند',
      rows: [
        { label: 'حافظه', value: `${fa(runtime.rssMb)} مگابایت` },
        { label: 'پایندگی', value: humanDuration(runtime.uptimeSec) },
        { label: 'شناسهٔ اجرا', value: fa(runtime.pid) },
        { label: 'موتور', value: runtime.node },
        { label: 'حالت', value: runtime.env }
      ]
    }
  ]

  const warnings: string[] = []
  if (!database.reachable) {
    warnings.push('· دیتابیس جواب نمی‌دهد؛ بازی برای بازیکنان کار نمی‌کند.')
  }
  if (database.migrations && !database.migrations.ok) {
    warnings.push('· مهاجرت‌ها با کدِ در حال اجرا هم‌خوان نیستند.')
  }
  if (code.artifact.fresh === false) {
    warnings.push('· بستهٔ اجرایی با کدِ مخزن یکی نیست؛ سرور کدِ قدیمی را اجرا می‌کند.')
  }
  if (snapshot.deployLockHeld || backups.lockHeld) {
    warnings.push('· یک عملیاتِ سنگین همین حالا در جریان است.')
  }
  if (ops.phase === 'failed' && ops.message) {
    warnings.push(`· آخرین بازیابی موفق نبود: ${ops.message}`)
  }
  if (backups.invalid > 0) {
    warnings.push('· یک یا چند بکاپ خراب است و برای بازیابی قابل اعتماد نیست.')
  }
  if (!upgrades.available) {
    warnings.push(`· ${upgrades.reason ?? 'به‌روزرسانی روی این سرور ممکن نیست.'}`)
  }

  const footer =
    warnings.length > 0
      ? warnings.join('\n')
      : code.dirtyCount > 0
        ? `تغییراتِ ذخیره‌نشده روی سرور:\n${code.dirtyFiles.join('\n')}`
        : 'همه‌چیز مرتب است.'

  return panel({ icon: '🛠', title: 'مرکز کنترل', sections, footer })
}

/**
 * کیبوردِ مرکز کنترل.
 *
 * `showOwnerActions` عمدی است: بکاپ برای هر ادمینِ فعال باز است، ولی
 * به‌روزرسانیِ سرور و لاگ مالک‌محور می‌مانند. دکمه‌ای که به "دسترسی نداری"
 * می‌خورد بدتر از دکمهٔ نبودن است — پس دکمهٔ مالک در پنلِ ادمین رندر نمی‌شود.
 */
function buildControlKeyboard(container: Container, showOwnerActions: boolean): InlineKeyboard {
  const keyboard = new InlineKeyboard()
  if (showOwnerActions && container.deployService.status().available) {
    keyboard.add({ text: '🚀 به‌روزرسانی سرور', callback_data: 'deploy:panel', style: 'primary' }).row()
  }
  keyboard.add({ text: '💾 بکاپ‌ها', callback_data: 'bk:panel', style: 'primary' })
  if (showOwnerActions) {
    keyboard.text('📜 لاگ سرور', 'op:logs').row()
  }
  keyboard.add({ text: 'بستن', callback_data: 'panel:close', style: 'danger' })
  return keyboard
}

// ──────────────────────────────────────────────────────────────── لاگ

function renderLogsPanel(repoRoot: string): string {
  const tail = tailLog(botLogPath(repoRoot))

  if (!tail.present) {
    return panel({
      icon: '📜',
      title: 'لاگ سرور',
      sections: [
        {
          lines: [
            'فایل لاگ روی این سرور پیدا نشد.',
            'اگر ربات با اسکریپت نصب راه انداخته شده، لاگ باید ساخته شده باشد.'
          ]
        }
      ]
    })
  }

  if (tail.lines.length === 0) {
    return panel({
      icon: '📜',
      title: 'لاگ سرور',
      sections: [{ lines: ['فایل لاگ خالی است.'] }],
      footer: `حجم فایل: ${humanBytes(tail.sizeBytes)}`
    })
  }

  return panel({
    icon: '📜',
    title: 'لاگ سرور',
    sections: [
      {
        title: `آخرین ${fa(tail.lines.length)} خط`,
        lines: tail.lines.map((line) => `\`${line}\``)
      }
    ],
    footer: `حجم فایل: ${humanBytes(tail.sizeBytes)}\nتوکن‌ها و نشانی‌های اتصال پیش از نمایش پاک شده‌اند.`
  })
}

// ──────────────────────────────────────────────────────────────── بکاپ‌ها

function renderBackupsPanel(backups: BackupSummary[]): string {
  if (backups.length === 0) {
    return panel({
      icon: '💾',
      title: 'بکاپ‌ها',
      sections: [
        {
          lines: [
            'هنوز بکاپی گرفته نشده.',
            'با «بکاپ تازه» یک نسخهٔ کامل از وضعیت فعلی ساخته می‌شود.'
          ]
        }
      ]
    })
  }

  const totalBytes = backups.reduce((sum, entry) => sum + entry.fileBytes, 0)
  const invalid = backups.filter((entry) => entry.integrity === 'invalid').length

  return panel({
    icon: '💾',
    title: 'بکاپ‌ها',
    sections: [
      {
        rows: [
          { label: 'تعداد', value: fa(backups.length) },
          { label: 'حجم کل', value: humanBytes(totalBytes) },
          { label: 'خراب', value: fa(invalid) }
        ]
      },
      {
        title: 'فهرست',
        lines: backups
          .slice(0, 8)
          .map(
            (entry) =>
              `• ${momentFa(new Date(entry.createdAt))} — ${integrityLabel(entry.integrity)} — ${kindLabel(entry.kind)} — ${fa(entry.totalRows)} ردیف`
          )
      }
    ],
    footer: backups.length > 8 ? `و ${fa(backups.length - 8)} بکاپِ قدیمی‌تر.` : undefined
  })
}

function buildBackupsKeyboard(backups: BackupSummary[]): InlineKeyboard {
  const keyboard = new InlineKeyboard()
  for (const entry of backups.slice(0, 5)) {
    keyboard
      .add({
        text: `${integrityLabel(entry.integrity)} ${momentFa(new Date(entry.createdAt))}`,
        callback_data: `bk:view:${entry.id}`,
        style: 'primary'
      })
      .row()
  }
  keyboard.add({ text: '🆕 بکاپ تازه', callback_data: 'bk:new', style: 'success' })
  keyboard.text('✅ بررسی همه', 'bk:all').row()
  keyboard.add({ text: '🧹 پاک‌سازی قدیمی‌ها', callback_data: 'bk:prune', style: 'danger' }).row()
  keyboard.add({ text: '⬅️ بازگشت', callback_data: 'op:panel', style: 'primary' }).row()
  return keyboard
}

function renderBackupDetail(manifest: BackupManifest): string {
  return panel({
    icon: '🗂',
    title: 'یک بکاپ',
    sections: [
      {
        rows: [
          { label: 'شناسه', value: manifest.id },
          { label: 'زمان', value: momentFa(new Date(manifest.createdAt)) },
          { label: 'نوع', value: kindLabel(manifest.kind) },
          { label: 'سلامت', value: integrityLabel(manifest.integrity) },
          { label: 'ردیف‌ها', value: fa(manifest.totalRows) },
          { label: 'جدول‌ها', value: fa(manifest.tables.length) },
          { label: 'حجم', value: humanBytes(manifest.fileBytes) },
          { label: 'کد', value: manifest.commitShort ?? 'نامعلوم' },
          { label: 'مهاجرت‌ها', value: fa(manifest.migrations.length) }
        ]
      },
      {
        title: 'وضعیتِ بررسی',
        lines: [manifest.integrityNote ?? 'این بکاپ هنوز بررسی نشده است.']
      }
    ],
    footer:
      manifest.integrity === 'invalid'
        ? 'این بکاپ خراب است و بازیابی نمی‌شود.'
        : 'بازیابی این بکاپ، دادهٔ فعلی را با آن جایگزین می‌کند.'
  })
}

function buildBackupDetailKeyboard(manifest: BackupManifest): InlineKeyboard {
  const keyboard = new InlineKeyboard()
  keyboard.add({ text: '🔍 بررسی سلامت', callback_data: `bk:v:${manifest.id}`, style: 'primary' }).row()
  if (manifest.integrity !== 'invalid') {
    keyboard.add({ text: '♻️ بازیابی این بکاپ', callback_data: `bk:r:${manifest.id}`, style: 'success' }).row()
  }
  keyboard.add({ text: '🗑 حذف', callback_data: `bk:del:${manifest.id}`, style: 'danger' }).row()
  keyboard.add({ text: '⬅️ بازگشت', callback_data: 'bk:panel', style: 'primary' }).row()
  return keyboard
}

function renderRestoreConfirm(manifest: BackupManifest): string {
  return panel({
    icon: '⚠️',
    title: 'بازیابی از بکاپ',
    sections: [
      {
        lines: [
          'با تأیید، دادهٔ فعلیِ بازی با محتوای این بکاپ جایگزین می‌شود.',
          'این کار برگشت‌پذیر است، ولی تا پایانش چند لحظه بازی قطع می‌شود.'
        ]
      },
      {
        title: 'آن‌چه جایگزین می‌شود',
        rows: [
          { label: 'زمانِ بکاپ', value: momentFa(new Date(manifest.createdAt)) },
          { label: 'ردیف‌ها', value: fa(manifest.totalRows) },
          { label: 'جدول‌ها', value: fa(manifest.tables.length) }
        ]
      },
      {
        title: 'مسیرِ ایمنی',
        lines: [
          '۱. اول یک بکاپِ ایمنی از وضعیتِ فعلی گرفته می‌شود.',
          '۲. ربات خاموش می‌شود تا کسی وسطِ کار ننویسد.',
          '۳. کلِ کار در یک تراکنش انجام می‌شود؛ اگر خطایی رخ دهد، همه‌چیز به حالتِ قبل برمی‌گردد.',
          '۴. ربات دوباره روشن می‌شود و نتیجه همین‌جا گزارش می‌شود.'
        ]
      }
    ],
    footer:
      manifest.integrity === 'ok'
        ? 'سلامتِ این بکاپ تأیید شده است.'
        : 'این بکاپ پیش از بازیابی دوباره بررسی می‌شود.'
  })
}

// ──────────────────────────────────────────────────────────────── پیوندها

/**
 * مالکِ واقعی **و** چت خصوصی — در هر گام دوباره.
 * سنجشِ دوباره عمدی است: بین دیدنِ صفحهٔ تأیید و زدنِ دکمه، نقش می‌تواند عوض شود.
 */
async function gateOwnerPrivate(ctx: Context, container: Container): Promise<OwnerGate> {
  if (!isPrivateChat(ctx)) {
    await ackCallback(ctx, 'این بخش فقط در چت خصوصی کار می‌کند.', true)
    return { ok: false }
  }
  return requireOwner(ctx, container)
}

/**
 * ادمینِ فعال **و** چت خصوصی — برای مسیرهای بکاپ.
 *
 * چرا بکاپ برای همهٔ ادمین‌ها باز است؟ چون بکاپ یک قابلیتِ عملیاتی است، نه
 * یک امتیازِ مالکیت: اگر تنها یک نفر بتواند بکاپ بگیرد یا سالم بودنش را
 * بسنجد، آن یک نفر تبدیل به تک‌نقطهٔ شکست می‌شود. عملیاتِ خطرناک (بازیابی و
 * حذف) همچنان صفحهٔ تأییدِ جداگانه دارند و در هر گام دسترسی دوباره سنجیده
 * می‌شود.
 *
 * استقرار/به‌روزرسانی سرور و لاگ از این دسته **نیستند** و مالک‌محور می‌مانند.
 */
async function gateAdminPrivate(ctx: Context, container: Container): Promise<AdminGate> {
  if (!isPrivateChat(ctx)) {
    await ackCallback(ctx, 'این بخش فقط در چت خصوصی کار می‌کند.', true)
    return { ok: false }
  }
  return requireAdmin(ctx, container)
}

async function openControlCenter(
  ctx: Context,
  container: Container,
  edit: boolean,
  showOwnerActions: boolean
): Promise<void> {
  const payload = {
    text: renderControlCenter(await container.systemStatusService.snapshot()),
    keyboard: buildControlKeyboard(container, showOwnerActions)
  }
  if (edit) {
    await editPanel(ctx, payload)
    return
  }
  await sendPanel(ctx, payload)
}

async function openBackups(ctx: Context, container: Container): Promise<void> {
  const backups = container.backupService.list()
  await editPanel(ctx, {
    text: renderBackupsPanel(backups),
    keyboard: buildBackupsKeyboard(backups)
  })
}

/** پنلِ «این بکاپ نیست» — برای دکمهٔ کهنه پس از پاک‌سازی. */
async function showMissingBackup(ctx: Context, message: string): Promise<void> {
  await ackCallback(ctx, message, true)
  await editPanel(ctx, {
    text: panel({
      icon: '⏳',
      title: 'این بکاپ دیگر نیست',
      sections: [
        {
          lines: [
            'ممکن است پاک‌سازیِ قدیمی‌ها حذفش کرده باشد.',
            'از فهرستِ بکاپ‌ها یک نسخهٔ موجود انتخاب کن.'
          ]
        }
      ]
    }),
    keyboard: new InlineKeyboard().add({ text: '⬅️ بازگشت', callback_data: 'bk:panel', style: 'primary' })
  })
}

// ──────────────────────────────────────────────────────────────── ثبت

export function registerOpsHandlers(bot: Bot, container: Container): void {
  const repoRoot = process.cwd()

  //
  // این یک **فرمان** است، نه دکمه: پس مسیر خطا هم باید مسیرِ پیام باشد.
  // پیش‌تر `handleCallbackError` صدا زده می‌شد که پاسخش را از کانالِ
  // Callback می‌فرستد؛ در بافتِ فرمان آن کانال وجود ندارد و نتیجه، سکوتِ
  // کامل در برابر مالک بود.
  bot.command('botupdate', async (ctx) => {
    try {
      if (!isPrivateChat(ctx)) {
        await ctx.reply('این فرمان فقط در چت خصوصی ربات کار می‌کند.')
        return
      }
      const gate = await gateAdminPrivate(ctx, container)
      if (!gate.ok) {
        return
      }
      await openControlCenter(ctx, container, false, await container.adminService.isOwner(gate.id))
    } catch (error) {
      await handleCommandError(ctx, error, {
        feature: 'ops',
        action: 'open',
        fallback: 'باز کردن مرکز کنترل ممکن نشد.'
      })
    }
  })

  bot.callbackQuery('op:panel', async (ctx) => {
    try {
      const gate = await gateAdminPrivate(ctx, container)
      if (!gate.ok) {
        return
      }
      await ackCallback(ctx)
      await openControlCenter(ctx, container, true, await container.adminService.isOwner(gate.id))
    } catch (error) {
      await handleCallbackError(ctx, error, {
        feature: 'ops',
        action: 'refresh',
        fallback: 'خواندن وضعیت ممکن نشد.'
      })
    }
  })

  bot.callbackQuery('op:logs', async (ctx) => {
    try {
      const gate = await gateOwnerPrivate(ctx, container)
      if (!gate.ok) {
        return
      }
      await ackCallback(ctx)
      await editPanel(ctx, {
        text: renderLogsPanel(repoRoot),
        keyboard: new InlineKeyboard()
          .add({ text: '🔄 تازه‌سازی', callback_data: 'op:logs', style: 'primary' })
          .row()
          .add({ text: '⬅️ بازگشت', callback_data: 'op:panel', style: 'primary' })
      })
    } catch (error) {
      await handleCallbackError(ctx, error, {
        feature: 'ops',
        action: 'logs',
        fallback: 'خواندن لاگ ممکن نشد.'
      })
    }
  })

  bot.callbackQuery('bk:panel', async (ctx) => {
    try {
      const gate = await gateAdminPrivate(ctx, container)
      if (!gate.ok) {
        return
      }
      await ackCallback(ctx)
      await openBackups(ctx, container)
    } catch (error) {
      await handleCallbackError(ctx, error, {
        feature: 'backup',
        action: 'panel',
        fallback: 'فهرست بکاپ‌ها خوانده نشد.'
      })
    }
  })

  bot.callbackQuery('bk:new', async (ctx) => {
    try {
      const gate = await gateAdminPrivate(ctx, container)
      if (!gate.ok) {
        return
      }
      // ساختِ بکاپ می‌تواند چند لحظه طول بکشد؛ پاسخِ فوری می‌رود تا مالک فکر
      // نکند دکمه کار نکرده است.
      await ackCallback(ctx, 'در حال ساخت بکاپ…')

      const code = await container.systemStatusService.codeInfo()
      const manifest = await container.backupService.create('manual', {
        appVersion: code.version,
        commit: code.commit
      })
      const verified = await container.backupService.verify(manifest.id)
      const stored = container.backupService.readManifest(manifest.id) ?? manifest

      await editPanel(ctx, {
        text: panel({
          icon: '💾',
          title: 'بکاپ ساخته شد',
          sections: [
            { lines: [verified.note] },
            {
              rows: [
                { label: 'شناسه', value: stored.id },
                { label: 'ردیف‌ها', value: fa(stored.totalRows) },
                { label: 'حجم', value: humanBytes(stored.fileBytes) }
              ]
            }
          ]
        }),
        keyboard: buildBackupDetailKeyboard(stored)
      })
    } catch (error) {
      await handleCallbackError(ctx, error, {
        feature: 'backup',
        action: 'create',
        fallback: 'ساخت بکاپ ممکن نشد.'
      })
    }
  })

  bot.callbackQuery(new RegExp(`^bk:view:(${BACKUP_ID})$`), async (ctx) => {
    try {
      const gate = await gateAdminPrivate(ctx, container)
      if (!gate.ok) {
        return
      }
      await ackCallback(ctx)
      const manifest = container.backupService.readManifest(ctx.match[1]!)
      if (!manifest) {
        await showMissingBackup(ctx, 'این بکاپ دیگر وجود ندارد.')
        return
      }
      await editPanel(ctx, {
        text: renderBackupDetail(manifest),
        keyboard: buildBackupDetailKeyboard(manifest)
      })
    } catch (error) {
      await handleCallbackError(ctx, error, {
        feature: 'backup',
        action: 'detail',
        fallback: 'این بکاپ خوانده نشد.'
      })
    }
  })

  bot.callbackQuery(new RegExp(`^bk:v:(${BACKUP_ID})$`), async (ctx) => {
    try {
      const gate = await gateAdminPrivate(ctx, container)
      if (!gate.ok) {
        return
      }
      const id = ctx.match[1]!
      if (!container.backupService.readManifest(id)) {
        await showMissingBackup(ctx, 'این بکاپ دیگر وجود ندارد.')
        return
      }
      await ackCallback(ctx, 'در حال بررسی…')
      const result = await container.backupService.verify(id)
      const manifest = container.backupService.readManifest(id)
      if (!manifest) {
        await showMissingBackup(ctx, 'این بکاپ دیگر وجود ندارد.')
        return
      }
      await editPanel(ctx, {
        text: panel({
          icon: result.ok ? '✅' : '⛔️',
          title: result.ok ? 'بکاپ سالم است' : 'بکاپ خراب است',
          sections: [
            { lines: [result.note] },
            {
              rows: [
                { label: 'شناسه', value: manifest.id },
                { label: 'جدول‌ها', value: fa(result.tables) },
                { label: 'ردیف‌ها', value: fa(result.rows) }
              ]
            }
          ]
        }),
        keyboard: buildBackupDetailKeyboard(manifest)
      })
    } catch (error) {
      await handleCallbackError(ctx, error, {
        feature: 'backup',
        action: 'verify',
        fallback: 'بررسی این بکاپ ممکن نشد.'
      })
    }
  })

  bot.callbackQuery('bk:all', async (ctx) => {
    try {
      const gate = await gateAdminPrivate(ctx, container)
      if (!gate.ok) {
        return
      }
      await ackCallback(ctx, 'در حال بررسی همه…')
      const results = []
      for (const entry of container.backupService.list()) {
        results.push(await container.backupService.verify(entry.id))
      }
      const healthy = results.filter((entry) => entry.ok).length
      await editPanel(ctx, {
        text: panel({
          icon: healthy === results.length ? '✅' : '⚠️',
          title: 'بررسیِ همهٔ بکاپ‌ها',
          sections: [
            {
              rows: [
                { label: 'سالم', value: fa(healthy) },
                { label: 'خراب', value: fa(results.length - healthy) }
              ]
            },
            {
              title: 'نتیجه',
              lines:
                results.length === 0
                  ? ['بکاپی برای بررسی نیست.']
                  : results.map((entry) => `• ${entry.id} — ${entry.note}`)
            }
          ]
        }),
        keyboard: new InlineKeyboard().add({ text: '⬅️ بازگشت', callback_data: 'bk:panel', style: 'primary' })
      })
    } catch (error) {
      await handleCallbackError(ctx, error, {
        feature: 'backup',
        action: 'verifyAll',
        fallback: 'بررسی بکاپ‌ها ممکن نشد.'
      })
    }
  })

  bot.callbackQuery('bk:prune', async (ctx) => {
    try {
      const gate = await gateAdminPrivate(ctx, container)
      if (!gate.ok) {
        return
      }
      await ackCallback(ctx)
      const removed = container.backupService.prune()
      await editPanel(ctx, {
        text: panel({
          icon: '🧹',
          title: 'پاک‌سازی بکاپ‌ها',
          sections: [
            {
              lines:
                removed.length === 0
                  ? ['بکاپی برای پاک‌کردن نبود.']
                  : [
                      `${fa(removed.length)} بکاپِ قدیمی پاک شد.`,
                      'جدیدترین بکاپ و آخرین بکاپِ ایمنی هرگز پاک نمی‌شوند.'
                    ]
            }
          ]
        }),
        keyboard: new InlineKeyboard().add({ text: '⬅️ بازگشت', callback_data: 'bk:panel', style: 'primary' })
      })
    } catch (error) {
      await handleCallbackError(ctx, error, {
        feature: 'backup',
        action: 'prune',
        fallback: 'پاک‌سازی ممکن نشد.'
      })
    }
  })

  bot.callbackQuery(new RegExp(`^bk:del:(${BACKUP_ID})$`), async (ctx) => {
    try {
      const gate = await gateAdminPrivate(ctx, container)
      if (!gate.ok) {
        return
      }
      const manifest = container.backupService.readManifest(ctx.match[1]!)
      if (!manifest) {
        await showMissingBackup(ctx, 'این بکاپ دیگر وجود ندارد.')
        return
      }
      await ackCallback(ctx)
      await editPanel(ctx, {
        text: panel({
          icon: '🗑',
          title: 'حذفِ بکاپ',
          sections: [
            { lines: ['این بکاپ حذف می‌شود. دادهٔ بازی دست‌نخورده می‌ماند.'] },
            {
              rows: [
                { label: 'شناسه', value: manifest.id },
                { label: 'زمان', value: momentFa(new Date(manifest.createdAt)) }
              ]
            }
          ]
        }),
        keyboard: new InlineKeyboard()
          .add({ text: '✅ تأیید حذف', callback_data: `bk:del2:${manifest.id}`, style: 'danger' })
          .row()
          .add({ text: 'انصراف', callback_data: `bk:view:${manifest.id}`, style: 'primary' })
      })
    } catch (error) {
      await handleCallbackError(ctx, error, {
        feature: 'backup',
        action: 'deleteConfirm',
        fallback: 'این کار ممکن نشد.'
      })
    }
  })

  bot.callbackQuery(new RegExp(`^bk:del2:(${BACKUP_ID})$`), async (ctx) => {
    try {
      const gate = await gateAdminPrivate(ctx, container)
      if (!gate.ok) {
        return
      }
      const removed = container.backupService.remove(ctx.match[1]!)
      await ackCallback(ctx, removed ? 'پاک شد' : 'این بکاپ پیدا نشد', !removed)
      await openBackups(ctx, container)
    } catch (error) {
      await handleCallbackError(ctx, error, {
        feature: 'backup',
        action: 'delete',
        fallback: 'حذف ممکن نشد.'
      })
    }
  })

  bot.callbackQuery(new RegExp(`^bk:r:(${BACKUP_ID})$`), async (ctx) => {
    try {
      const gate = await gateAdminPrivate(ctx, container)
      if (!gate.ok) {
        return
      }
      const manifest = container.backupService.readManifest(ctx.match[1]!)
      if (!manifest) {
        await showMissingBackup(ctx, 'این بکاپ دیگر وجود ندارد.')
        return
      }
      if (manifest.integrity === 'invalid') {
        await ackCallback(ctx, 'این بکاپ خراب است و بازیابی نمی‌شود.', true)
        return
      }
      await ackCallback(ctx)
      await editPanel(ctx, {
        text: renderRestoreConfirm(manifest),
        keyboard: new InlineKeyboard()
          .add({ text: '✅ تأیید بازیابی', callback_data: `bk:r2:${manifest.id}`, style: 'success' })
          .row()
          .add({ text: 'انصراف', callback_data: `bk:view:${manifest.id}`, style: 'danger' })
      })
    } catch (error) {
      await handleCallbackError(ctx, error, {
        feature: 'backup',
        action: 'restoreConfirm',
        fallback: 'این مرحله ممکن نشد.'
      })
    }
  })

  bot.callbackQuery(new RegExp(`^bk:r2:(${BACKUP_ID})$`), async (ctx) => {
    try {
      // دسترسی **دوباره** سنجیده می‌شود: بین تأیید و اجرا نقش می‌تواند عوض شود.
      const gate = await gateAdminPrivate(ctx, container)
      if (!gate.ok) {
        return
      }
      const id = ctx.match[1]!
      await ackCallback(ctx, 'در حال آغاز بازیابی…')
      const result = container.backupService.requestRestore(id, gate.id)

      if (!result.started) {
        await ackCallback(ctx, result.reason ?? 'شروع نشد.', true)
        await openBackups(ctx, container)
        return
      }

      await editPanel(ctx, {
        text: panel({
          icon: '♻️',
          title: 'بازیابی آغاز شد',
          sections: [
            {
              lines: [
                'ربات خاموش می‌شود، دادهٔ بازی از بکاپ بازسازی می‌شود و بعد دوباره روشن می‌شود.',
                'چند لحظه صبر کن و بعد همین فرمان را بزن تا نتیجه را ببینی.'
              ]
            }
          ]
        }),
        keyboard: new InlineKeyboard().add({ text: 'بستن', callback_data: 'panel:close', style: 'danger' })
      })
    } catch (error) {
      await handleCallbackError(ctx, error, {
        feature: 'backup',
        action: 'restore',
        fallback: 'شروع بازیابی ممکن نشد.'
      })
    }
  })
}
