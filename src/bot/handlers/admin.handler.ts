/**
 * پنل ادمین ربات — Telegram-native، مبتنی بر دیتابیس.
 *
 * قوانین ثابت این فایل:
 *  • ورود با عبارت دقیق «پنل ادمین» (در چت خصوصی یا هر گروهی که ربات عضو است).
 *  • کاربر غیرادمین *هیچ* پاسخی نمی‌گیرد؛ حتی یک «دسترسی نداری».
 *  • پاسخ همیشه در Reply همان پیام است و ناوبری با edit همان پیام انجام
 *    می‌شود (ONE ACTION = ONE PANEL).
 *  • دسترسی همیشه سمت سرور از دیتابیس بررسی می‌شود؛ callback_data فقط
 *    «چه چیزی» را می‌گوید، نه «آیا مجازم».
 *  • مدیریت ادمین‌ها (فهرست/افزودن/حذف) فقط برای OWNER.
 *  • عملیات مخرب یک مرحلهٔ تأیید دارند.
 */
import { Bot, Context, InlineKeyboard } from 'grammy'
import {
  BotAdminRole,
  DegreeLevel,
  Gender,
  GroupStatus,
  GroupType,
  MaritalStatus,
  PlayerStatus,
  Prisma
} from '@prisma/client'
import type { Container } from '../../services/container'
import {
  ADMIN_FIELD_LIMITS,
  ADMIN_MESSAGE_LIMITS,
  WARNING_BAN_THRESHOLD,
  WARNING_REASON_LIMITS,
  botAdminRoleLabels,
  fieldLimitText,
  PRIMARY_OWNER_TELEGRAM_ID,
  playerStatusAdminLabels,
  textLimitText,
  validateAdminMessage,
  validateWarningReason,
  type AdminAdjustableField,
  type ModerationView
} from '../../modules/admin/admin.service'
import { degreeLabels, EDUCATION_FIELDS } from '../../modules/education/education-blueprints'
import { effectiveAge } from '../../modules/lifecycle/game-calendar'
import { ENVIRONMENT_LABELS } from '../../modules/groups/group.service'
import {
  REPORT_ANSWER_LIMITS,
  reportCategoryLabels,
  reportStatusLabels,
  type AdminReportView
} from '../../modules/support/support.service'
import type { StalledInheritanceView } from '../../modules/inheritance/inheritance.service'
import { AppError, ConflictError } from '../../utils/classes/errors'
import { isCancelWord, parseAmountDetailed, type AmountInvalidReason } from '../../utils/commands'
import { plainInput } from '../../utils/validation'
import { ratePerGameHour } from '../../utils/game-time'
import { fa, faDate, money, panel, type PanelSection } from '../ui-kit'
import { activityStateLabels, label, playerStatusLabels } from '../../utils/classes/labels'
import { genderLabels, maritalStatusLabels } from '../../modules/identity/player.service'
import type { AdminMetrics } from '../../modules/admin/admin.service'
import { ackCallback, editPanel, sendPanel as sendNewPanel, type PanelOptions } from '../panel'
import { handleCallbackError } from '../handler-errors'
import { logger } from '../../utils/logger'
import { ADMIN_HELP_PAGES, adminHelpKeyboard, renderAdminHelpPage } from '../admin-help'

// Per-update delivery target: text answers edit the panel that requested input.
const inputPanels = new WeakMap<Context, number>()
async function sendPanel(ctx: Context, options: PanelOptions): Promise<void> {
  const messageId = inputPanels.get(ctx)
  if (messageId && ctx.chat) {
    try {
      await ctx.api.editMessageText(ctx.chat.id, messageId, options.text, {
        parse_mode: options.parseMode ?? 'Markdown',
        reply_markup: options.keyboard
      })
      return
    } catch (error) {
      logger.warn({ err: error }, 'admin input panel edit failed')
    }
  }
  await sendNewPanel(ctx, options)
}

// ───────────────────────────────────────────────────────── عبارات ورودی

/**
 * عبارت‌های مدیریتی، به شکل *نرمال‌شده* (بدون نیم‌فاصله و اعراب).
 * تطبیق عینِ متن است، پس نوشتن «پنل ادمین» با فاصله لازم است.
 */
export const ADMIN_PHRASES = {
  'پنل ادمین': 'panel',
  'ادمین ها': 'list',
  ادمینها: 'list',
  'اضافه ادمین': 'add',
  'حذف ادمین': 'remove'
} as const

export type AdminPhrase = (typeof ADMIN_PHRASES)[keyof typeof ADMIN_PHRASES]

export function adminPhraseOf(normalizedText: string): AdminPhrase | null {
  return (ADMIN_PHRASES as Record<string, AdminPhrase>)[normalizedText] ?? null
}

/**
 * رسیدگی به عبارت مدیریتی.
 * `true` یعنی عبارت مصرف شد و router باید متوقف شود — حتی وقتی کاربر
 * ادمین نیست و عمداً بی‌پاسخ می‌ماند (تا وجود پنل فاش نشود).
 */
export async function handleAdminPhrase(
  ctx: Context,
  container: Container,
  phrase: AdminPhrase
): Promise<boolean> {
  const from = ctx.from
  if (!from) {
    return true
  }
  const fromId = BigInt(from.id)

  const admin = await container.adminService.findAdmin(fromId).catch((error: unknown) => {
    logger.error({ err: error, feature: 'admin', action: 'lookup' }, 'admin lookup failed')
    return null
  })

  // کاربر عادی: کاملاً بی‌صدا. نه پیام، نه ری‌اکشن، نه لاگ پرصدا.
  if (!admin || !admin.isActive) {
    logger.debug({ userId: from.id, phrase }, 'admin phrase ignored (not an admin)')
    return true
  }

  // عبارت مدیریتی هر جریان ورودی باز را می‌بندد تا state گیر نکند
  await container.userStateRepository.clear(fromId).catch(() => undefined)

  try {
    if (phrase === 'panel') {
      await openAdminHome(ctx, container, fromId)
      return true
    }

    if (admin.role !== BotAdminRole.OWNER) {
      await sendPanel(ctx, {
        text: panel({
          icon: '🔒',
          title: 'مدیریت ادمین‌ها',
          sections: [{ lines: ['افزودن، حذف و فهرست ادمین‌ها فقط برای ادمین اصلی ممکن است.'] }]
        })
      })
      return true
    }

    if (phrase === 'list') {
      await sendPanel(ctx, {
        text: await renderAdminListPanel(container, fromId),
        keyboard: buildAdminListKeyboard(await container.adminService.listAdmins(fromId))
      })
      return true
    }

    const repliedUser = repliedTelegramUser(ctx)
    if (!repliedUser) {
      await sendPanel(ctx, {
        text: panel({
          icon: '🛡️',
          title: phrase === 'add' ? 'افزودن ادمین' : 'حذف ادمین',
          sections: [
            {
              lines: [
                `اول روی پیامِ همان کاربر *ریپلای* کن، بعد «${
                  phrase === 'add' ? 'اضافه ادمین' : 'حذف ادمین'
                }» را بفرست.`
              ]
            }
          ],
          footer: '💡 هیچ داده‌ای از بازیکن حذف نمی‌شود؛ فقط دسترسی مدیریت عوض می‌شود.'
        })
      })
      return true
    }

    if (phrase === 'add') {
      await stageAdminChange(
        ctx,
        container,
        {
          action: 'admin_add',
          target: repliedUser.telegramUserId.toString(),
          firstName: repliedUser.firstName,
          username: repliedUser.username ?? null
        },
        'افزودن ادمین',
        [
          `کاربر: ${repliedUser.displayName}`,
          'دسترسی مدیریت بازی داده می‌شود؛ مدیریت فهرست ادمین‌ها همچنان فقط برای ادمین اصلی است.'
        ]
      )
      return true
    }

    // حذف ادمین: یک مرحلهٔ تأیید، چون برگشت‌ناپذیر به نظر می‌رسد.
    // مستقیم با شناسه خوانده می‌شود؛ جست‌وجو در «صفحهٔ اول» ادمین‌های صفحهٔ
    // دوم را پیدا نمی‌کرد و «در فهرست نیست» را اشتباه نشان می‌داد.
    const target = await container.adminService.findAdmin(repliedUser.telegramUserId)
    if (!target || !target.isActive) {
      await sendPanel(ctx, {
        text: panel({
          icon: 'ℹ️',
          title: 'حذف ادمین',
          sections: [{ lines: ['این کاربر در فهرست ادمین‌ها نیست.'] }]
        })
      })
      return true
    }
    // همان گاردِ دکمهٔ حذف: ادمین اصلی حذف‌شدنی نیست و نباید اصلاً به تأیید برسد
    if (target.role === BotAdminRole.OWNER) {
      await sendPanel(ctx, {
        text: panel({
          icon: 'ℹ️',
          title: 'حذف ادمین',
          sections: [{ lines: ['ادمین اصلی حذف‌شدنی نیست.'] }]
        })
      })
      return true
    }
    await stageAdminChange(
      ctx,
      container,
      {
        action: 'admin_remove',
        target: repliedUser.telegramUserId.toString()
      },
      'حذف دسترسی ادمین',
      [
        `کاربر: ${repliedUser.displayName}`,
        'فقط دسترسی مدیریت حذف می‌شود؛ شخصیت، موجودی و دارایی‌ها باقی می‌مانند.'
      ]
    )
    return true
  } catch (error) {
    if (error instanceof AppError) {
      await sendPanel(ctx, {
        text: panel({
          icon: '⚠️',
          title: 'انجام نشد',
          sections: [{ lines: error.persianMessage.split('\n') }]
        })
      })
      return true
    }
    logger.error({ err: error, feature: 'admin', action: phrase }, 'admin phrase failed')
    await sendPanel(ctx, { text: '⚠️ این کار انجام نشد؛ دوباره تلاش کن.' })
    return true
  }
}

/** کاربری که پیامِ او ریپلای شده است. */
function repliedTelegramUser(
  ctx: Context
): { telegramUserId: bigint; firstName: string; username?: string; displayName: string } | null {
  const replied = ctx.message?.reply_to_message?.from
  if (!replied || replied.is_bot) {
    return null
  }
  if (replied.id === ctx.from?.id) {
    return null
  }
  // نام تلگرام کاملاً در اختیار کاربر است و مستقیم در پنل مارک‌داون رندر
  // می‌شود؛ بدون پاک‌سازی، یک نام مانند «Ali *[x](t.me/scam)*» پارس تلگرام را
  // می‌شکند. همان مرزی که ثبت‌نام را محافظت می‌کند (`plainInput`)، اینجا هم هست.
  const rawName = plainInput(replied.first_name || '')
  const firstName = rawName.length > 0 ? rawName : 'بدون نام'
  const username =
    replied.username && /^[A-Za-z0-9_]{1,64}$/.test(replied.username) ? replied.username : undefined
  return {
    telegramUserId: BigInt(replied.id),
    firstName,
    username: username || undefined,
    displayName: username ? `${firstName} (\`@${username}\`)` : firstName
  }
}

// ───────────────────────────────────────────────────────── صفحه‌ها

/** متن داشبورد؛ اولین ارسال و دکمهٔ «به‌روزرسانی» از همین یک تابع می‌خوانند. */
function renderAdminDashboardText(metrics: AdminMetrics, role: BotAdminRole): string {
  const sections: PanelSection[] = [
    {
      title: 'بازیکنان',
      rows: [
        { label: '👥 ثبت‌نام‌شده', value: fa(metrics.totalPlayers) },
        { label: '✅ فعال', value: fa(metrics.activePlayers) },
        { label: '⛔ مسدود', value: fa(metrics.bannedPlayers) },
        { label: '🛠️ در حال کار', value: fa(metrics.workingPlayers) }
      ]
    },
    {
      title: 'دنیای بازی',
      rows: [
        { label: '🌐 گروه‌ها', value: fa(metrics.totalGroups) },
        { label: '🏢 کسب‌وکارها', value: fa(metrics.totalBusinesses) },
        { label: '🏠 املاک', value: fa(metrics.totalProperties) },
        { label: '🏦 حساب‌های بانکی', value: fa(metrics.totalBankAccounts) },
        { label: '📑 وام‌های جاری', value: fa(metrics.totalLoans) }
      ]
    },
    {
      title: 'اقتصاد و مدیریت',
      rows: [
        { label: '💰 گردش مالی', value: money(metrics.totalEconomyVolume) },
        { label: '🛡️ ادمین‌های فعال', value: fa(metrics.totalAdmins) },
        { label: '📜 اقدام ثبت‌شده', value: fa(metrics.adminLogCount) }
      ]
    },
    {
      title: 'دسترسی تو',
      rows: [{ label: '🎖️ نقش', value: botAdminRoleLabels[role] }]
    }
  ]
  return panel({ icon: '🛡️', title: 'پنل ادمین', sections, footer: 'اطلاعات پنل در گروه برای همه قابل مشاهده است. برای مدیریت اطلاعات خصوصی، پنل را در چت خصوصی ربات باز کن.' })
}

// ─────────────────────────────────────────── گزارش‌های بازیکنان

/**
 * صفِ گزارش‌ها — کارهای باقی‌مانده اول.
 * متنِ بازیکن کوتاه می‌شود تا پنل در تلگرام جمع‌وجور بماند؛ متنِ کامل در
 * پنلِ جزئیاتِ همان گزارش دیده می‌شود.
 */
function renderAdminReportsPanel(result: {
  items: AdminReportView[]
  total: number
  openCount: number
  page: number
  pageSize: number
}): string {
  const lines =
    result.items.length === 0
      ? ['هنوز هیچ گزارشی از بازیکنان ثبت نشده است.']
      : result.items.flatMap((report, index) => {
          const rows = [
            `${reportStatusIcons[report.status]} *${reportCategoryLabels[report.category]}* · ${reportStatusLabels[report.status]}`,
            `   👤 ${plainInput(report.playerName)} · \`${report.telegramUserId.toString()}\` · ${faDate(report.createdAt)}`,
            `   «${report.body.length > 120 ? `${report.body.slice(0, 120)}…` : report.body}»`
          ]
          if (index < result.items.length - 1) {
            rows.push('')
          }
          return rows
        })

  return panel({
    icon: '📨',
    title: `گزارش‌های بازیکنان (${fa(result.total)})`,
    sections: [
      { lines },
      { lines: [`💡 ${fa(result.openCount)} گزارش در انتظار بررسی است.`] }
    ],
    footer: '💡 هر پاسخ به بازیکن اعلان و پیام خصوصی می‌فرستد؛ لازم نیست در گروه دنبالش بگردی.'
  })
}

/** آیکنِ وضعیت گزارش — یک منبع تا رنگ و معنا همه‌جا یکی بماند. */
const reportStatusIcons: Record<AdminReportView['status'], string> = {
  OPEN: '🆕',
  ANSWERED: '↩️',
  CLOSED: '📪'
}

/** پنل جزئیات یک گزارش: متن کامل + پاسخ ثبت‌شده (اگر باشد). */
function renderAdminReportDetail(report: AdminReportView): string {
  const sections: PanelSection[] = [
    {
      rows: [
        { label: '🏷️ دسته', value: reportCategoryLabels[report.category] },
        { label: '🚦 وضعیت', value: reportStatusLabels[report.status] },
        {
          label: '👤 بازیکن',
          value: `${plainInput(report.playerName)} · \`${report.telegramUserId.toString()}\``
        },
        { label: '🕒 زمان ثبت', value: faDate(report.createdAt) }
      ]
    },
    { title: '📝 متن بازیکن', lines: [`«${report.body}»`] }
  ]

  if (report.answer) {
    sections.push({
      title: '✉️ پاسخ ثبت‌شده',
      lines: [
        `«${report.answer}»`,
        report.answeredAt ? `🕒 ${faDate(report.answeredAt)}` : ''
      ].filter((line) => line.length > 0)
    })
  }

  return panel({
    icon: '📨',
    title: 'گزارش بازیکن',
    sections,
    footer:
      report.status === 'CLOSED'
        ? 'این گزارش بسته شده است؛ اگر بازیکن دوباره بنویسد گزارش تازه‌ای ساخته می‌شود.'
        : '💡 پاسخ را همین‌جا بنویس؛ بازیکن اعلان و پیام خصوصی می‌گیرد.'
  })
}

/** دکمه‌های صف: یک دکمه برای هر گزارش + صفحه‌بندی + بازگشت. */
function buildAdminReportsKeyboard(result: {
  items: AdminReportView[]
  page: number
  total: number
  pageSize: number
}): InlineKeyboard {
  const keyboard = new InlineKeyboard()

  result.items.forEach((report, index) => {
    const label = `${reportStatusIcons[report.status]} ${reportCategoryLabels[report.category]} · ${plainInput(report.playerName)}`
    keyboard.text(label.slice(0, 60), `adm:report:${report.id}`)
    if (index % 2 === 1) {
      keyboard.row()
    }
  })
  if (result.items.length > 0 && result.items.length % 2 === 1) {
    keyboard.row()
  }

  const totalPages = Math.max(1, Math.ceil(result.total / result.pageSize))
  if (result.page > 0) keyboard.text('⬅️ قبلی', `adm:reports:${result.page - 1}`)
  keyboard.text(`${fa(result.page + 1)} / ${fa(totalPages)}`, `adm:reports:${result.page}`)
  if (result.page + 1 < totalPages) keyboard.text('بعدی ➡️', `adm:reports:${result.page + 1}`)
  keyboard.row()

  return keyboard.text('⬅️ داشبورد', 'adm:home').text('بستن', 'panel:close').row()
}

/** دکمه‌های پنل جزئیات: پاسخ/بستن + بازگشت به صف. */
function buildAdminReportDetailKeyboard(report: AdminReportView): InlineKeyboard {
  const keyboard = new InlineKeyboard()
  if (report.status !== 'CLOSED') {
    keyboard
      .add({
        text: report.answer ? '✏️ ویرایش پاسخ' : '✍️ نوشتن پاسخ',
        callback_data: `adm:report_reply:${report.id}`,
        style: 'primary'
      })
      .row()
      .add({
        text: '📪 بستن گزارش',
        callback_data: `adm:report_close:${report.id}`,
        style: 'danger'
      })
      .row()
  }
  return keyboard.text('⬅️ صف گزارش‌ها', 'adm:reports:0').text('بستن', 'panel:close').row()
}

/** بازگشتِ کوتاه به صف پس از ثبت پاسخ یا بستن گزارش. */
function buildAdminReportsBackKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text('⬅️ صف گزارش‌ها', 'adm:reports:0').text('بستن', 'panel:close')
}

/**
 * برچسبِ فارسیِ وضعیت پروندهٔ میراث — یک منبع برای فهرست و جزئیات.
 *
 * `lastError` خامِ دیتابیس هرگز به اپراتور نشان داده نمی‌شود: نامِ خطاهای
 * داخلی برای تصمیم‌گیری ادمین چیزی اضافه نمی‌کند و فقط نویزِ فنی است. آن‌چه
 * مهم است در دو خطِ زیر خلاصه می‌شود.
 */
const inheritanceStatusLabels: Record<StalledInheritanceView['status'], string> = {
  PENDING: 'در انتظار شروع',
  SETTLED_DEBTS: 'بدهی‌ها تسویه شد',
  TRANSFERRED: 'دارایی منتقل شد',
  NO_HEIR: 'بدون وارث',
  COMPLETED: 'بسته شد',
  FAILED: 'خطا خورده'
}

/** چرا این پروندهٔ گیر کرده و قدم بعدی چیست. */
function inheritanceStallReason(view: StalledInheritanceView): string {
  if (view.status === 'NO_HEIR') {
    // عمداً هیچ کنشی برای این حالت پیشنهاد نمی‌شود: انتقال وارثی ندارد و
    // هنگام «زندگی تازه»ی همان بازیکن به صندوق منطقه می‌رود. دکمه‌ای که
    // کاری نمی‌کند بدتر از نبودنش است.
    return 'وصیتِ معتبری نداشت و وارثی تعیین نشده؛ دارایی محفوظ می‌ماند تا با «زندگی تازه»ی همان بازیکن به صندوق منطقه برسد.'
  }
  return `انتقالِ دارایی نیمه‌کاره مانده و تلاشِ خودکار پس از ${fa(view.attempts)} بار متوقف شد.`
}

/** آیا این پرونده واقعاً با «تلاش دوباره» حل می‌شود؟ */
function isRetryableCase(view: StalledInheritanceView): boolean {
  return view.status !== 'NO_HEIR'
}

/** صفِ پرونده‌های میراثی که چرخهٔ خودکار رهایشان کرده است. */
function renderAdminInheritancePanel(cases: StalledInheritanceView[]): string {
  if (cases.length === 0) {
    return panel({
      icon: '⚖️',
      title: 'پرونده‌های میراث',
      sections: [
        {
          lines: [
            'در این لحظه پروندهٔ گیرکرده‌ای نیست.',
            'پرونده‌هایی که خودکار حل نمی‌شوند، همین‌جا برای تصمیم‌گیری می‌آیند.'
          ]
        }
      ]
    })
  }

  const lines = cases.flatMap((row, index) => {
    const rows = [
      `*${plainInput(row.deceasedName)}* — ${inheritanceStatusLabels[row.status]} · ${faDate(row.openedAt)}`,
      `   💰 ${money(row.cashTransferred)} منتقل شده · 🏠 ${fa(row.propertiesCount)} ملک · 🏢 ${fa(row.businessesCount)} کسب‌وکار`,
      `   ⚠️ ${inheritanceStallReason(row)}`
    ]
    if (index < cases.length - 1) rows.push('')
    return rows
  })

  return panel({
    icon: '⚖️',
    title: `پرونده‌های میراث (${fa(cases.length)})`,
    sections: [{ lines }],
    footer:
      '💡 «تلاش دوباره» همان انتقال را از مرحلهٔ نیمه‌کاره ادامه می‌دهد؛ پول دوبار منتقل نمی‌شود.'
  })
}

/**
 * دکمهٔ هر پرونده فقط وقتی ساخته می‌شود که کاری بکند.
 *
 * پروندهٔ بی‌وارث دکمهٔ تلاش دوباره نمی‌گیرد — انتقالش وارث ندارد و اجرای
 * دوباره بی‌اثر است. مرز در سرویس هم بررسی می‌شود؛ این‌جا فقط دکمهٔ بی‌اثر
 * ساخته نمی‌شود.
 */
function buildAdminInheritanceKeyboard(cases: StalledInheritanceView[]): InlineKeyboard {
  const keyboard = new InlineKeyboard()
  const retryable = cases.filter(isRetryableCase)
  retryable.forEach((row, index) => {
    keyboard.add({
      text: `🔁 تلاش دوباره — ${plainInput(row.deceasedName)}`.slice(0, 60),
      callback_data: `adm:case_retry:${row.caseId}`,
      style: 'primary'
    })
    if (index % 2 === 1) keyboard.row()
  })
  if (retryable.length > 0 && retryable.length % 2 === 1) keyboard.row()
  return keyboard
    .text('🔄 به‌روزرسانی', 'adm:cases')
    .text('⬅️ داشبورد', 'adm:home')
    .row()
    .text('بستن', 'panel:close')
    .row()
}

async function openAdminHome(ctx: Context, container: Container, adminId: bigint): Promise<void> {
  const [metrics, admin] = await Promise.all([
    container.adminService.getDashboardMetrics(adminId),
    container.adminService.findAdmin(adminId)
  ])
  const role = admin?.role ?? BotAdminRole.ADMIN

  await sendPanel(ctx, {
    text: renderAdminDashboardText(metrics, role),
    keyboard: buildAdminHomeKeyboard(admin?.role === BotAdminRole.OWNER)
  })
}

async function renderAdminListPanel(
  container: Container,
  adminId: bigint,
  page = 0
): Promise<string> {
  const result = await container.adminService.listAdmins(adminId, page)
  return panel({
    icon: '🛡️',
    title: `ادمین‌ها (${fa(result.total)})`,
    sections: [
      {
        lines:
          result.items.length === 0
            ? ['ادمینی در این صفحه نیست.']
            : result.items.flatMap((row) => {
                const name =
                  row.playerName ?? row.admin.firstName ?? row.admin.username ?? 'بدون نام'
                const id = row.admin.telegramUserId.toString()
                return [
                  `• *${plainInput(name)}* — ${botAdminRoleLabels[row.admin.role]} · ${row.admin.isActive ? 'فعال' : 'دسترسی لغوشده'}`,
                  `   🆔 \`${id}\`${row.admin.username ? ` · \`@${row.admin.username}\`` : ''}`,
                  `   📅 از ${faDate(row.admin.createdAt)}${
                    row.hasPlayer ? '' : ' · ⚠️ شخصیت بازی ندارد'
                  }`,
                  ''
                ]
              })
      },
      {
        title: 'افزودن و حذف',
        lines: [
          '➕ روی پیام کاربر ریپلای کن و «اضافه ادمین» را بفرست.',
          '🗑️ روی پیام همان ادمین ریپلای کن و «حذف ادمین» را بفرست.',
          '',
          'حذف ادمین هیچ داده‌ای از بازیکن پاک نمی‌کند.',
          'ادمین اصلی حذف‌شدنی نیست.'
        ]
      }
    ]
  })
}

/**
 * پنل moderation یک بازیکن: اخطارهای ثبت‌شده، فاصله تا مسدودسازی خودکار و
 * مسیرهای اقدام (اخطار تازه، پیام، لغو اخطار، حذف حساب).
 */
function renderAdminModerationPanel(view: ModerationView): string {
  const name = plainInput(`${view.firstName} ${view.lastName ?? ''}`.trim())
  const banned = view.status === PlayerStatus.BANNED

  const guidance: string[] = banned
    ? [
        'حساب مسدود است. برای بازگرداندن دسترسی، از «وضعیت و محدودیت‌ها» گزینهٔ «فعال» را بزن.',
        'لغو اخطار به‌تنهایی مسدودسازی را برنمی‌گرداند.'
      ]
    : view.remainingUntilBan === 0
      ? ['اخطارها به آستانه رسیده است؛ اخطار بعدی حساب را مسدود می‌کند.']
      : [
          `${fa(view.remainingUntilBan)} اخطار فعال دیگر تا مسدودسازی خودکار باقی است.`,
          'اخطار باید دلیل روشن داشته باشد؛ همان دلیل به بازیکن هم نشان داده می‌شود.'
        ]

  return panel({
    icon: '🛡️',
    title: 'اخطار و پیام',
    sections: [
      {
        rows: [
          { label: '👤 بازیکن', value: name },
          { label: '🆔 شناسه', value: `\`${view.telegramUserId.toString()}\`` },
          { label: '🚦 حساب', value: playerStatusAdminLabels[view.status] },
          {
            label: '⚠️ اخطار فعال',
            value: `${fa(view.activeCount)} از ${fa(view.threshold)}`
          }
        ]
      },
      {
        title: 'اخطارها',
        lines:
          view.warnings.length === 0
            ? ['اخطاری برای این بازیکن ثبت نشده است.']
            : view.warnings.flatMap((warning, index) => {
                const lines = [
                  `• ${warning.isActive ? '⚠️' : '↩️'} ${plainInput(warning.reason)}`,
                  `   ${faDate(warning.createdAt)} · توسط \`${warning.issuedBy.toString()}\`${
                    warning.causedBan ? ' · موجب مسدودسازی شد' : ''
                  }${warning.isActive ? '' : ' · لغوشده'}`
                ]
                // فاصله فقط *بین* اخطارها؛ وگرنه پیش از بخشِ بعدی دو خط خالی می‌افتد
                if (index < view.warnings.length - 1) {
                  lines.push('')
                }
                return lines
              })
      },
      { lines: guidance }
    ],
    footer: banned
      ? '💡 اخطارها پس از مسدودسازی هم ثبت می‌مانند تا دلیلش برای ادمین بعدی روشن بماند.'
      : `💡 با ${fa(WARNING_BAN_THRESHOLD)} اخطار فعال، حساب خودکار مسدود و نوبت کاری‌اش بسته می‌شود.`
  })
}

// ───────────────────────────────────────────────────────── کیبوردها

function buildAdminHomeKeyboard(isOwner: boolean): InlineKeyboard {
  const keyboard = new InlineKeyboard()
    .text('👥 بازیکنان', 'adm:players:0')
    .text('🌐 گروه‌ها', 'adm:groups:0')
    .row()
  if (isOwner) {
    keyboard.text('🛡️ ادمین‌ها', 'adm:admins').text('📜 گزارش‌ها', 'adm:logs:0').row()
  } else {
    keyboard.text('📜 گزارش‌ها', 'adm:logs:0').row()
  }
  // صفِ گزارش‌های بازیکنان برای *همهٔ* ادمین‌ها باز است (خواندن و پاسخ)؛
  // مسیر ثبت گزارش سمت بازیکن است و این‌جا فقط رسیدگی می‌شود.
  keyboard.text('📨 گزارش‌های بازیکنان', 'adm:reports:0').row()
  // پروندهٔ میراثی که خودکار حل نشده، داراییِ یخ‌زده است؛ اپراتور باید از
  // داشبورد یک قدم به آن برسد، نه اینکه دنبالش بگردد.
  keyboard.text('⚖️ پرونده‌های میراث', 'adm:cases').row()
  keyboard.text('⚙️ قوانین بازی', 'adm:settings').row()
  // مرکز کنترل سرور: بکاپ‌ها برای هر ادمینِ فعال باز است، پس باید از داشبورد
  // خودش هم یک قدم فاصله داشته باشد. پیش‌تر تنها راه، دانستنِ فرمانِ
  // `/botupdate` بود و مکانیابی‌اش برای ادمینِ غیرمالک ممکن نبود.
  keyboard.text('🖥️ بکاپ و وضعیت سرور', 'bk:panel').row()
  return keyboard.text('🔄 به‌روزرسانی', 'adm:home').text('بستن', 'panel:close').row()
}

function buildAdminListKeyboard(result: {
  page: number
  total: number
  pageSize: number
  items: Array<{ admin: { telegramUserId: bigint; role: BotAdminRole; isActive?: boolean } }>
}): InlineKeyboard {
  const keyboard = new InlineKeyboard().text('🔍 یافتن بازیکن', 'adm:find').row()
  for (const row of result.items) {
    // OWNER حذف‌شدنی نیست؛ دکمه‌ای که به خطا می‌رسد ساخته نمی‌شود
    if (row.admin.role === BotAdminRole.OWNER || row.admin.isActive === false) continue
    const id = row.admin.telegramUserId.toString()
    keyboard.text(`🗑️ حذف ${id}`, `adm:confirm:admin_remove:${id}`).row()
  }

  const totalPages = Math.max(1, Math.ceil(result.total / result.pageSize))
  if (totalPages > 1) {
    if (result.page > 0) keyboard.text('⬅️ قبلی', `adm:admins:${result.page - 1}`)
    keyboard.text(`${fa(result.page + 1)} / ${fa(totalPages)}`, `adm:admins:${result.page}`)
    if (result.page + 1 < totalPages) keyboard.text('بعدی ➡️', `adm:admins:${result.page + 1}`)
    keyboard.row()
  }

  return keyboard.text('⬅️ داشبورد', 'adm:home').text('بستن', 'panel:close').row()
}

function buildAdminPlayersKeyboard(
  ids: bigint[],
  page: number,
  totalPages: number
): InlineKeyboard {
  const keyboard = new InlineKeyboard()
  ids.forEach((id, index) => {
    keyboard.text(`👤 ${id.toString()}`, `adm:player:${id.toString()}`)
    if (index % 2 === 1) keyboard.row()
  })
  if (ids.length > 0 && ids.length % 2 === 1) keyboard.row()

  if (page > 0) keyboard.text('⬅️ قبلی', `adm:players:${page - 1}`)
  keyboard.text(`${fa(page + 1)} / ${fa(Math.max(1, totalPages))}`, `adm:players:${page}`)
  if (page + 1 < totalPages) keyboard.text('بعدی ➡️', `adm:players:${page + 1}`)
  keyboard.row()

  return keyboard
    .text('🔍 یافتن بازیکن', 'adm:find')
    .text('⬅️ داشبورد', 'adm:home')
    .row()
    .text('بستن', 'panel:close')
    .row()
}

function buildAdminPaginationKeyboard(
  kind: 'groups' | 'logs',
  page: number,
  totalPages: number
): InlineKeyboard {
  const keyboard = new InlineKeyboard()
  if (page > 0) keyboard.text('⬅️ قبلی', `adm:${kind}:${page - 1}`)
  keyboard.text(`${fa(page + 1)} / ${fa(Math.max(1, totalPages))}`, `adm:${kind}:${page}`)
  if (page + 1 < totalPages) keyboard.text('بعدی ➡️', `adm:${kind}:${page + 1}`)
  return keyboard.row().text('⬅️ داشبورد', 'adm:home').text('بستن', 'panel:close').row()
}

function buildAdminPlayerKeyboard(telegramUserId: bigint): InlineKeyboard {
  const id = telegramUserId.toString()
  return new InlineKeyboard()
    .text('💰 اقتصاد', `adm:econ:${id}`)
    .text('🎓 تحصیل و مهارت', `adm:edu:${id}`)
    .row()
    .text('شغل، کسب‌وکار و خانواده', `adm:life:${id}`)
    .row()
    .text('🚦 وضعیت و محدودیت‌ها', `adm:limits:${id}`)
    .text('🛡️ اخطار و پیام', `adm:mod:${id}`)
    .row()
    .text('🔄 به‌روزرسانی', `adm:player:${id}`)
    .text('⬅️ فهرست', 'adm:players:0')
    .row()
    .text('🏠 داشبورد', 'adm:home')
    .text('بستن', 'panel:close')
    .row()
}

function buildAdminEconKeyboard(telegramUserId: bigint): InlineKeyboard {
  const id = telegramUserId.toString()
  return new InlineKeyboard()
    .text('➕ افزودن موجودی', `adm:act:balance_add:${id}`)
    .text('➖ کسر موجودی', `adm:act:balance_remove:${id}`)
    .row()
    .text('🎯 تنظیم موجودی', `adm:act:balance_set:${id}`)
    .row()
    .text('بازگشت', `adm:player:${id}`)
    .text('بستن', 'panel:close')
    .row()
}

function buildAdminEduKeyboard(telegramUserId: bigint): InlineKeyboard {
  const id = telegramUserId.toString()
  const keyboard = new InlineKeyboard()
  for (const [level, title] of Object.entries(degreeLabels)) {
    keyboard.text(`🎓 ${title}`, `adm:degree:${level}:${id}`)
    keyboard.row()
  }
  return keyboard
    .text('🧠 مهارت‌ها', `adm:skills:${id}`)
    .text('⏹️ لغو تحصیل', `adm:confirm:edu_stop:${id}`)
    .row()
    .text('بازگشت', `adm:player:${id}`)
    .text('بستن', 'panel:close')
    .row()
}

function buildAdminLimitsKeyboard(telegramUserId: bigint): InlineKeyboard {
  const id = telegramUserId.toString()
  return new InlineKeyboard()
    .text('✅ فعال', `adm:status:ACTIVE:${id}`)
    .text('🌙 غیرفعال', `adm:status:INACTIVE:${id}`)
    .row()
    .text('❤️ سلامت', `adm:act:health:${id}`)
    .text('⚡ خستگی', `adm:act:fatigue:${id}`)
    .row()
    .text('⭐ تجربه', `adm:act:experience:${id}`)
    .row()
    .text('⛔ مسدودکردن', `adm:confirm:ban:${id}`)
    .row()
    .text('⏹️ توقف نوبت کاری', `adm:confirm:work_stop:${id}`)
    .text('🔥 صفرکردن استریک', `adm:confirm:streak_reset:${id}`)
    .row()
    .text('♻️ بازنشانی وضعیت', `adm:confirm:state_reset:${id}`)
    .row()
    .text('بازگشت', `adm:player:${id}`)
    .text('بستن', 'panel:close')
    .row()
}

/**
 * زیرپنل moderation: اخطار، پیام و حذف حساب.
 * جدا از «وضعیت و محدودیت‌ها» نگه داشته می‌شود تا صفحهٔ تنظیمات عددی شلوغ نشود؛
 * ناوبری سلسله‌مراتبی است: بازیکن → اخطار و پیام → اقدام.
 */
export function buildAdminModerationKeyboard(
  telegramUserId: bigint,
  warnings: ReadonlyArray<{ id: string; isActive: boolean }>
): InlineKeyboard {
  const id = telegramUserId.toString()
  const keyboard = new InlineKeyboard()
    .text('⚠️ ثبت اخطار', `adm:warn:${id}`)
    .text('✉️ پیام به بازیکن', `adm:msg:${id}`)
    .row()

  const active = warnings.filter((row) => row.isActive).slice(0, 5)
  active.forEach((warning, index) => {
    keyboard
      .text(
        `↩️ لغو اخطار ${fa(index + 1)}`,
        `adm:wrev:${id}:${warning.id}`
      )
      .row()
  })

  return keyboard
    .text('🗑️ حذف حساب کاربری', `adm:confirm:player_delete:${id}`)
    .row()
    .text('بازگشت', `adm:player:${id}`)
    .text('بستن', 'panel:close')
    .row()
}

function buildAdminSkillsKeyboard(
  telegramUserId: bigint,
  skills: Array<{ id: string; level: number; skill: { name: string } }>
): InlineKeyboard {
  const id = telegramUserId.toString()
  const keyboard = new InlineKeyboard()
  skills.forEach((skill) => {
    keyboard
      .text(`🧠 ${skill.skill.name} · سطح ${fa(skill.level)}`, `adm:skill:${skill.id}:${id}`)
      .row()
  })
  return keyboard.text('بازگشت', `adm:edu:${id}`).text('بستن', 'panel:close').row()
}

async function stageAdminChange(
  ctx: Context,
  container: Container,
  payload: Prisma.InputJsonObject,
  title: string,
  lines: string[]
): Promise<void> {
  const actor = BigInt(ctx.from!.id)
  if (!(await container.adminService.isAdmin(actor))) return
  if (String(payload.action).startsWith('admin_')) {
    await container.adminService.assertOwner(actor)
  }
  const target = BigInt(String(payload.target))
  if (String(payload.action) === 'admin_remove') {
    const existing = await container.adminService.findAdmin(target)
    if (!existing?.isActive || target === PRIMARY_OWNER_TELEGRAM_ID || existing.role === BotAdminRole.OWNER) {
      throw new ConflictError(
        'Protected or missing admin',
        'این دسترسی قابل حذف نیست؛ فهرست ادمین‌ها را بررسی کن.'
      )
    }
    lines = [`ادمین: ${plainInput(existing.firstName ?? 'بدون نام')}`, ...lines]
  } else if (String(payload.action) === 'admin_add') {
    const existing = await container.adminService.findAdmin(target)
    if (existing?.isActive)
      throw new ConflictError('Already admin', 'این کاربر از قبل ادمین است؛ تغییری لازم نیست.')
  } else {
    const player = await container.adminService.getPlayerAdminView(actor, target)
    lines = [`بازیکن: ${plainInput(player.firstName)}`, ...lines]
  }
  const token = await container.userStateRepository.issueConfirmation(actor, ctx.chat!.id, payload)
  const show = ctx.callbackQuery ? editPanel : sendPanel
  await show(ctx, {
    text: panel({
      icon: '⚠️',
      title: `تأیید ${title}`,
      sections: [
        { rows: [{ label: 'شناسهٔ هدف', value: `\`${String(payload.target)}\`` }] },
        { lines }
      ],
      footer: 'هنوز تغییری ثبت نشده است. تأیید ۵ دقیقه اعتبار دارد و فقط یک بار اجرا می‌شود.'
    }),
    keyboard: new InlineKeyboard()
      .text('تأیید تغییر', `adm:apply:${token}`)
      .text('انصراف', 'adm:discard')
      .row()
  })
}

/**
 * پیش‌نمایش حذف حساب و، در صورت نبودِ مانع، مرحلهٔ تأیید.
 *
 * ادمین پیش از تأیید دقیقاً می‌بیند چه چیزی پاک می‌شود و چه اثری روی دیگران
 * می‌ماند؛ اگر مانعی باشد (کارمند فعال، بدهی تسویه‌نشده، ودیهٔ در گرو…)
 * هیچ تأییدی صادر نمی‌شود و دلیلِ قابل اقدام نشان داده می‌شود.
 */
async function stagePlayerDeletion(
  ctx: Context,
  container: Container,
  targetId: bigint
): Promise<void> {
  const actor = BigInt(ctx.from!.id)
  const preview = await container.adminService.getDeletionPreview(actor, targetId)
  const show = ctx.callbackQuery ? editPanel : sendPanel

  if (preview.blockers.length > 0) {
    await show(ctx, {
      text: panel({
        icon: '⛔',
        title: 'حذف حساب ممکن نیست',
        sections: [
          { rows: [{ label: '👤 بازیکن', value: plainInput(preview.firstName) }] },
          {
            title: 'مانع‌ها',
            lines: preview.blockers.flatMap((blocker) => [
              `• *${blocker.title}*`,
              `   ${blocker.hint}`,
              ''
            ])
          }
        ],
        footer: '💡 با رفع هر مانع، حذف ممکن می‌شود؛ تا آن لحظه هیچ داده‌ای پاک نشده است.'
      }),
      keyboard: buildAdminPlayerKeyboard(targetId)
    })
    return
  }

  await stageAdminChange(
    ctx,
    container,
    { action: 'player_delete', target: targetId.toString() },
    'حذف کامل حساب کاربری',
    [
      `پولی که از گردش خارج می‌شود: ${money(preview.removedFunds)}`,
      '',
      'پاک می‌شود:',
      ...(preview.removals.length > 0
        ? preview.removals.map((row) => `• ${row.label}: ${fa(row.count)}`)
        : ['• ردیف وابسته‌ای برای این بازیکن ثبت نشده است.']),
      '',
      'اثر روی دیگران و دنیا:',
      ...(preview.settlements.length > 0
        ? preview.settlements.map((line) => `• ${line}`)
        : ['• اثری روی بازیکن دیگر ندارد.']),
      '',
      'دفتر مالی و تاریخچهٔ منطقه پاک نمی‌شود؛ فقط نام این بازیکن از آن ردیف‌ها برداشته می‌شود.',
      'این اقدام برگشت‌ناپذیر است.'
    ]
  )
}

function buildAdminGroupsKeyboard(
  groups: bigint[],
  page: number,
  totalPages: number
): InlineKeyboard {
  const keyboard = new InlineKeyboard()
  groups.forEach((id) => {
    keyboard.text(`🌐 ${id.toString()}`, `adm:group:${id.toString()}`).row()
  })
  if (page > 0) keyboard.text('⬅️ قبلی', `adm:groups:${page - 1}`)
  keyboard.text(`${fa(page + 1)} / ${fa(Math.max(1, totalPages))}`, `adm:groups:${page}`)
  if (page + 1 < totalPages) keyboard.text('بعدی ➡️', `adm:groups:${page + 1}`)
  return keyboard
    .row()
    .text('جست‌وجوی گروه', 'adm:group_find')
    .row()
    .text('⬅️ داشبورد', 'adm:home')
    .text('بستن', 'panel:close')
    .row()
}

// ───────────────────────────────────────────────────────── راهنمای ادمین

/** /admin_help برای ادمین فعال راهنما را باز می‌کند و برای دیگران عمداً بی‌صداست. */
export async function handleAdminHelpCommand(ctx: Context, container: Container): Promise<void> {
  const fromId = ctx.from?.id
  if (fromId === undefined) return
  const admin = await container.adminService.findAdmin(BigInt(fromId)).catch(() => null)
  if (!admin?.isActive) return
  await container.userStateRepository.clear(BigInt(fromId)).catch(() => undefined)
  await sendPanel(ctx, {
    text: renderAdminHelpPage(0),
    keyboard: adminHelpKeyboard(0)
  })
}

// ───────────────────────────────────────────────────────── ثبت هندلرها

export function registerAdminHandlers(bot: Bot, container: Container): void {
  // راهنمای چندصفحه‌ای با همان کنترل دسترسی سمت سرورِ پنل.
  bot.callbackQuery(/^adm:help:\d+$/, async (ctx) => {
    const adminId = BigInt(ctx.from.id)
    if (!(await guardAdmin(ctx, container, adminId))) return
    const requested = Number(ctx.callbackQuery.data.split(':')[2] ?? '0')
    const page = Math.min(Math.max(Number.isFinite(requested) ? requested : 0, 0), ADMIN_HELP_PAGES.length - 1)
    await ackCallback(ctx)
    await editPanel(ctx, {
      text: renderAdminHelpPage(page),
      keyboard: adminHelpKeyboard(page)
    })
  })

  bot.callbackQuery('adm:settings', async (ctx) => {
    if (!(await guardAdmin(ctx, container, BigInt(ctx.from.id)))) return
    await ackCallback(ctx)
    await editPanel(ctx, {
      text: panel({
        icon: '⚙️',
        title: 'قوانین و محدودهٔ مدیریت',
        sections: [
          {
            title: 'مقادیر قابل تنظیم برای هر بازیکن',
            lines: Object.entries(ADMIN_FIELD_LIMITS).map(([key, value]) => {
              const titles: Record<string, string> = {
                balance: 'موجودی',
                health: 'سلامت',
                fatigue: 'خستگی',
                experience: 'تجربه',
                skillLevel: 'سطح مهارت'
              }
              return `• ${titles[key]}: ${fa(value.min)} تا ${fa(value.max)} ${value.unit}`
            })
          },
          {
            title: 'قوانین سراسری',
            lines: [
              'پارامترهای اقتصاد و زمان‌بندی در تنظیمات نسخهٔ بازی تعریف شده‌اند؛ از این پنل قابل تغییر نیستند.',
              'سطح محیط گروه از جمعیت تلگرام محاسبه می‌شود؛ تغییر دستی سطح ارائه نمی‌شود.',
              'هر تغییر بازیکن پیش‌نمایش، تأیید یک‌بارمصرف و گزارش مدیریت دارد.'
            ]
          }
        ]
      }),
      keyboard: new InlineKeyboard().text('بازگشت', 'adm:home')
    })
  })

  bot.callbackQuery('adm:group_find', async (ctx) => {
    const actor = BigInt(ctx.from.id)
    if (!(await guardAdmin(ctx, container, actor))) return
    await container.userStateRepository.upsert(actor, {
      currentContext: 'adm:group_find',
      stateData: { chatId: ctx.chat!.id, panelMessageId: ctx.callbackQuery.message!.message_id }
    })
    await ackCallback(ctx)
    await editPanel(ctx, {
      text: panel({
        title: 'جست‌وجوی گروه',
        sections: [
          { lines: ['شناسهٔ عددی گروه یا بخشی از نام آن را بفرست.', 'برای لغو «انصراف» را بفرست.'] }
        ]
      }),
      keyboard: new InlineKeyboard().text('انصراف', 'adm:discard')
    })
  })

  bot.callbackQuery(/^adm:life:\d+$/, async (ctx) => {
    const actor = BigInt(ctx.from.id)
    if (!(await guardAdmin(ctx, container, actor))) return
    const target = BigInt(ctx.callbackQuery.data.split(':')[2]!)
    try {
      const view = await container.adminService.getPlayerLifeView(actor, target)
      await ackCallback(ctx)
      await editPanel(ctx, {
        text: panel({
          title: 'شغل، کسب‌وکار و خانواده',
          sections: [
            {
              rows: [
                { label: 'بازیکن', value: plainInput(view.player.firstName) },
                { label: 'شناسه', value: `\`${target.toString()}\`` }
              ]
            },
            {
              title: 'استخدام فعال',
              lines: view.jobs.length
                ? view.jobs.map(
                    (j) =>
                      `• ${plainInput(j.title)} در ${plainInput(j.business.name)}؛ حقوق ${money(ratePerGameHour(Number(j.salaryPerMinute)))} در ساعت بازی؛ طلب ثبت‌شده ${money(j.unpaidSalary)}`
                  )
                : ['استخدام فعالی ندارد.']
            },
            {
              title: 'کسب‌وکارها',
              lines: view.businesses.length
                ? view.businesses.map(
                    (b) =>
                      `• ${plainInput(b.name)}؛ سطح ${fa(b.level)}؛ ${fa(b.activeEmployees)} کارمند؛ خزانه ${money(b.treasury)}`
                  )
                : ['کسب‌وکاری ثبت نشده است.']
            },
            {
              title: 'ازدواج',
              lines: view.marriages.length
                ? view.marriages.map(
                    (m) =>
                      `• همسر: ${plainInput(m.playerAId === view.player.id ? m.playerB.firstName : m.playerA.firstName)}؛ مهریه ${money(m.mahr)}`
                  )
                : ['ازدواج فعالی ندارد.']
            },
            {
              title: 'درخواست‌های ازدواج',
              lines: [`${fa(view.pendingProposals)} درخواست در انتظار پاسخ دارد.`]
            }
          ],
          footer:
            'این صفحه فقط خواندنی است؛ قرارداد استخدام و ازدواج از اینجا تغییر نمی‌کند. حداکثر ۱۰ مورد از هر بخش نمایش داده می‌شود.'
        }),
        keyboard: buildAdminPlayerKeyboard(target)
      })
    } catch (error) {
      await handleCallbackError(ctx, error, {
        feature: 'admin',
        action: 'life',
        fallback: 'اطلاعات این بازیکن باز نشد. از فهرست دوباره انتخابش کن.'
      })
    }
  })

  bot.callbackQuery('adm:home', async (ctx) => {
    const adminId = BigInt(ctx.from.id)
    if (!(await guardAdmin(ctx, container, adminId))) return
    await container.userStateRepository.clear(adminId)
    await ackCallback(ctx, 'به‌روزرسانی شد')
    try {
      const [metrics, admin] = await Promise.all([
        container.adminService.getDashboardMetrics(adminId),
        container.adminService.findAdmin(adminId)
      ])
      await editPanel(ctx, {
        text: renderAdminDashboardText(metrics, admin?.role ?? BotAdminRole.ADMIN),
        keyboard: buildAdminHomeKeyboard(admin?.role === BotAdminRole.OWNER)
      })
    } catch (error) {
      await handleCallbackError(ctx, error, {
        feature: 'admin',
        action: 'dashboard',
        fallback: 'داشبورد باز نشد.'
      })
    }
  })

  // ── ادمین‌ها (فقط OWNER) — «adm:admins» و «adm:admins:N» هر دو پذیرفته می‌شوند
  bot.callbackQuery(/^adm:admins(?::\d+)?$/, async (ctx) => {
    const adminId = BigInt(ctx.from.id)
    if (!(await guardOwner(ctx, container, adminId))) return
    await ackCallback(ctx)
    const page = Number(ctx.callbackQuery.data.split(':')[2] ?? '0') || 0
    try {
      const result = await container.adminService.listAdmins(adminId, page)
      await editPanel(ctx, {
        text: await renderAdminListPanel(container, adminId, result.page),
        keyboard: buildAdminListKeyboard(result)
      })
    } catch (error) {
      await handleCallbackError(ctx, error, {
        feature: 'admin',
        action: 'list_admins',
        fallback: 'فهرست ادمین‌ها باز نشد.'
      })
    }
  })

  // ── بازیکنان
  bot.callbackQuery(/^adm:players:\d+$/, async (ctx) => {
    const adminId = BigInt(ctx.from.id)
    if (!(await guardAdmin(ctx, container, adminId))) return
    await ackCallback(ctx)
    const page = Number(ctx.callbackQuery.data.split(':')[2] ?? '0') || 0
    try {
      const searchState = await container.userStateRepository.findByTelegramUserId(adminId)
      const searchData = searchState?.stateData as Prisma.JsonObject | undefined
      const term =
        searchState?.currentContext === 'adm:search' &&
        searchData?.chatId === ctx.chat!.id &&
        typeof searchData.term === 'string'
          ? searchData.term
          : undefined
      const result = await container.adminService.listPlayers(adminId, page, term)
      const totalPages = Math.max(1, Math.ceil(result.total / result.pageSize))
      await editPanel(ctx, {
        text: panel({
          icon: '👥',
          title: `${term ? 'نتیجهٔ جست‌وجو' : 'بازیکنان'} (${fa(result.total)})`,
          sections: [
            {
              lines:
                result.items.length === 0
                  ? ['بازیکنی یافت نشد.']
                  : result.items.flatMap((player) => {
                      const name = plainInput(`${player.firstName} ${player.lastName ?? ''}`.trim())
                      const job = player.workSessions[0]
                      return [
                        `• \`${player.telegramUserId.toString()}\` · ${name}`,
                        `   ${money(player.balance)} · ${label(
                          playerStatusLabels,
                          player.status
                        )} · ${job ? plainInput(job.jobTitle) : 'بدون سابقهٔ نوبت کار'}`
                      ]
                    })
            }
          ],
          footer: '💡 با «یافتن بازیکن» می‌توانی شناسه یا نام را جست‌وجو کنی.'
        }),
        keyboard: buildAdminPlayersKeyboard(
          result.items.map((item) => item.telegramUserId),
          result.page,
          totalPages
        )
      })
    } catch (error) {
      await handleCallbackError(ctx, error, {
        feature: 'admin',
        action: 'list_players',
        fallback: 'فهرست بازیکنان باز نشد.'
      })
    }
  })

  bot.callbackQuery('adm:find', async (ctx) => {
    const adminId = BigInt(ctx.from.id)
    if (!(await guardAdmin(ctx, container, adminId))) return
    await ackCallback(ctx)
    await container.userStateRepository.upsert(adminId, {
      currentContext: 'adm:find',
      stateData: { chatId: ctx.chat!.id, panelMessageId: ctx.callbackQuery.message!.message_id }
    })
    await editPanel(ctx, {
      text: panel({
        icon: '🔍',
        title: 'یافتن بازیکن',
        sections: [
          {
            lines: [
              'شناسهٔ تلگرام (عدد) یا بخشی از نام/نام کاربری را بفرست.',
              'برای لغو «انصراف» را بنویس.'
            ]
          }
        ]
      }),
      keyboard: buildCloseKeyboard()
    })
  })

  bot.callbackQuery(/^adm:player:-?\d+$/, async (ctx) => {
    const adminId = BigInt(ctx.from.id)
    if (!(await guardAdmin(ctx, container, adminId))) return
    await ackCallback(ctx)
    const targetId = BigInt(ctx.callbackQuery.data.split(':')[2]!)
    try {
      const player = await container.adminService.getPlayerAdminView(adminId, targetId)
      await editPanel(ctx, {
        text: renderAdminPlayerPanel(player),
        keyboard: buildAdminPlayerKeyboard(targetId)
      })
    } catch (error) {
      await handleCallbackError(ctx, error, {
        feature: 'admin',
        action: 'view_player',
        fallback: 'اطلاعات این بازیکن باز نشد.'
      })
    }
  })

  bot.callbackQuery(/^adm:econ:-?\d+$/, async (ctx) => {
    const adminId = BigInt(ctx.from.id)
    if (!(await guardAdmin(ctx, container, adminId))) return
    await ackCallback(ctx)
    const targetId = BigInt(ctx.callbackQuery.data.split(':')[2]!)
    try {
      const player = await container.adminService.getPlayerAdminView(adminId, targetId)
      await editPanel(ctx, {
        text: panel({
          icon: '💰',
          title: 'مدیریت اقتصاد بازیکن',
          sections: [
            {
              rows: [
                {
                  label: '👤 بازیکن',
                  value: plainInput(`${player.firstName} ${player.lastName ?? ''}`.trim())
                },
                { label: '💰 موجودی فعلی', value: money(player.balance) }
              ]
            },
            {
              lines: [
                `بازهٔ مجاز موجودی: ${fieldLimitText('balance')}.`,
                '«تنظیم موجودی» مقدار را جایگزین می‌کند؛ دو گزینهٔ دیگر جمع/تفریق می‌کنند.'
              ]
            }
          ]
        }),
        keyboard: buildAdminEconKeyboard(targetId)
      })
    } catch (error) {
      await handleCallbackError(ctx, error, {
        feature: 'admin',
        action: 'econ_panel',
        fallback: 'پنل اقتصاد باز نشد.'
      })
    }
  })

  bot.callbackQuery(/^adm:edu:-?\d+$/, async (ctx) => {
    const adminId = BigInt(ctx.from.id)
    if (!(await guardAdmin(ctx, container, adminId))) return
    await ackCallback(ctx)
    const targetId = BigInt(ctx.callbackQuery.data.split(':')[2]!)
    try {
      const player = await container.adminService.getPlayerAdminView(adminId, targetId)
      const fieldTitle = player.enrolledFieldKey
        ? (EDUCATION_FIELDS.find((f) => f.key === player.enrolledFieldKey)?.title ?? null)
        : null
      await editPanel(ctx, {
        text: panel({
          icon: '🎓',
          title: 'تحصیل و مهارت',
          sections: [
            {
              rows: [
                {
                  label: '🎓 مدرک فعلی',
                  value: degreeLabels[player.currentDegree as DegreeLevel] ?? 'نامشخص'
                },
                { label: '📚 رشتهٔ در حال تحصیل', value: fieldTitle ?? '—' },
                { label: '🏅 رشتهٔ فارغ‌التحصیلی', value: player.graduationField ?? '—' }
              ]
            },
            { lines: ['مدرک تازه را از دکمه‌های زیر انتخاب کن.'] }
          ]
        }),
        keyboard: buildAdminEduKeyboard(targetId)
      })
    } catch (error) {
      await handleCallbackError(ctx, error, {
        feature: 'admin',
        action: 'edu_panel',
        fallback: 'پنل تحصیل باز نشد.'
      })
    }
  })

  bot.callbackQuery(/^adm:limits:-?\d+$/, async (ctx) => {
    const adminId = BigInt(ctx.from.id)
    if (!(await guardAdmin(ctx, container, adminId))) return
    await ackCallback(ctx)
    const targetId = BigInt(ctx.callbackQuery.data.split(':')[2]!)
    try {
      const player = await container.adminService.getPlayerAdminView(adminId, targetId)
      await editPanel(ctx, {
        text: panel({
          icon: '🚦',
          title: 'وضعیت و محدودیت‌ها',
          sections: [
            {
              rows: [
                { label: '🚦 حساب', value: playerStatusAdminLabels[player.status] },
                { label: '📌 فعالیت', value: label(activityStateLabels, player.activityState) },
                { label: '💼 نوبت کاری', value: player.workSessions[0]?.jobTitle ?? '—' },
                { label: '🔥 استریک', value: fa(player.streakCount) }
              ]
            },
            {
              lines: [
                '⏹️ توقف نوبت کاری: شیفت فعال لغو و ظرفیت آن شغل آزاد می‌شود.',
                '♻️ بازنشانی وضعیت: فعالیت، تحصیل، استراحت، سلامت و خستگی.',
                '⛔ مسدودکردن: بازیکن دیگر نمی‌تواند فعالیتی آغاز کند.',
                `🛡️ اخطار و پیام: اخطار با دلیل؛ با ${WARNING_BAN_THRESHOLD.toLocaleString('fa-IR')} اخطار فعال، مسدودسازی خودکار.`
              ]
            }
          ]
        }),
        keyboard: buildAdminLimitsKeyboard(targetId)
      })
    } catch (error) {
      await handleCallbackError(ctx, error, {
        feature: 'admin',
        action: 'limits_panel',
        fallback: 'پنل وضعیت باز نشد.'
      })
    }
  })

  // ── moderation: اخطار، پیام و حذف حساب
  bot.callbackQuery(/^adm:mod:-?\d+$/, async (ctx) => {
    const adminId = BigInt(ctx.from.id)
    if (!(await guardAdmin(ctx, container, adminId))) return
    await ackCallback(ctx)
    const targetId = BigInt(ctx.callbackQuery.data.split(':')[2]!)
    try {
      const view = await container.adminService.getModerationView(adminId, targetId)
      await editPanel(ctx, {
        text: renderAdminModerationPanel(view),
        keyboard: buildAdminModerationKeyboard(targetId, view.warnings)
      })
    } catch (error) {
      await handleCallbackError(ctx, error, {
        feature: 'admin',
        action: 'moderation_panel',
        fallback: 'پنل اخطارها باز نشد.'
      })
    }
  })

  bot.callbackQuery(/^adm:warn:-?\d+$/, async (ctx) => {
    const adminId = BigInt(ctx.from.id)
    if (!(await guardAdmin(ctx, container, adminId))) return
    const targetId = ctx.callbackQuery.data.split(':')[2]!
    await ackCallback(ctx)
    await container.userStateRepository.upsert(adminId, {
      currentContext: `adm:warn:${targetId}`,
      stateData: { chatId: ctx.chat!.id, panelMessageId: ctx.callbackQuery.message!.message_id }
    })
    await editPanel(ctx, {
      text: panel({
        icon: '⚠️',
        title: 'ثبت اخطار',
        sections: [
          {
            lines: [
              'دلیل اخطار را بنویس؛ همان دلیل به بازیکن نشان داده می‌شود و در گزارش مدیریت می‌ماند.',
              `اندازهٔ مجاز: ${textLimitText(WARNING_REASON_LIMITS)}.`,
              '',
              `با ${fa(WARNING_BAN_THRESHOLD)} اخطار فعال، حساب خودکار مسدود می‌شود.`,
              'برای لغو «انصراف» را بنویس.'
            ]
          }
        ]
      }),
      keyboard: buildCloseKeyboard()
    })
  })

  bot.callbackQuery(/^adm:msg:-?\d+$/, async (ctx) => {
    const adminId = BigInt(ctx.from.id)
    if (!(await guardAdmin(ctx, container, adminId))) return
    const targetId = ctx.callbackQuery.data.split(':')[2]!
    await ackCallback(ctx)
    await container.userStateRepository.upsert(adminId, {
      currentContext: `adm:msg:${targetId}`,
      stateData: { chatId: ctx.chat!.id, panelMessageId: ctx.callbackQuery.message!.message_id }
    })
    await editPanel(ctx, {
      text: panel({
        icon: '✉️',
        title: 'پیام به بازیکن',
        sections: [
          {
            lines: [
              'متن پیام را بنویس؛ در چت خصوصی ربات برای او ارسال می‌شود',
              'و یک نسخه هم در اعلان‌های بازی‌اش می‌ماند.',
              `اندازهٔ مجاز: ${textLimitText(ADMIN_MESSAGE_LIMITS)}.`,
              '',
              'برای لغو «انصراف» را بنویس.'
            ]
          }
        ]
      }),
      keyboard: buildCloseKeyboard()
    })
  })

  // لغو اخطار هم مثل هر تغییر دیگری پیش‌نمایش و تأیید یک‌بارمصرف دارد
  // «adm:wrev» کوتاه است چون شناسهٔ اخطار (uuid) جای کمی باقی می‌گذارد:
  // سقف callback_data تلگرام ۶۴ بایت است و شکل بلندتر از آن رد می‌شد.
  bot.callbackQuery(/^adm:wrev:(-?\d+):([\w-]+)$/, async (ctx) => {
    const adminId = BigInt(ctx.from.id)
    if (!(await guardAdmin(ctx, container, adminId))) return
    // adm:wrev:<شناسه کاربر>:<شناسه اخطار> — سه بخش پس از پیشوند
    const [, , rawTarget, warningId] = ctx.callbackQuery.data.split(':')
    const targetId = BigInt(rawTarget!)
    try {
      await stageAdminChange(
        ctx,
        container,
        { action: 'warning_revoke', target: targetId.toString(), warningId: warningId! },
        'لغو اخطار',
        [
          'این اخطار از شمار اخطارهای فعال خارج می‌شود.',
          'اگر حساب مسدود باشد، مسدودسازی خودکار برنمی‌گردد؛ بازگرداندن دسترسی اقدام جداگانه‌ای است.'
        ]
      )
      await ackCallback(ctx)
    } catch (error) {
      await handleCallbackError(ctx, error, {
        feature: 'admin',
        action: 'revoke_warning',
        fallback: 'لغو اخطار انجام نشد.'
      })
    }
  })

  bot.callbackQuery(/^adm:skills:-?\d+$/, async (ctx) => {
    const adminId = BigInt(ctx.from.id)
    if (!(await guardAdmin(ctx, container, adminId))) return
    await ackCallback(ctx)
    const targetId = BigInt(ctx.callbackQuery.data.split(':')[2]!)
    try {
      const skills = await container.adminService.listPlayerSkills(adminId, targetId)
      await editPanel(ctx, {
        text: panel({
          icon: '🧠',
          title: 'مهارت‌های بازیکن',
          sections: [
            {
              lines:
                skills.length === 0
                  ? ['مهارتی ثبت نشده است.']
                  : skills.map(
                      (skill) =>
                        `• ${skill.skill.name} · سطح ${fa(skill.level)} · ${fa(skill.points)} امتیاز`
                    )
            }
          ],
          footer: `💡 برای تغییر سطح، روی همان مهارت بزن (بازهٔ ${fieldLimitText('skillLevel')}).`
        }),
        keyboard: buildAdminSkillsKeyboard(targetId, skills)
      })
    } catch (error) {
      await handleCallbackError(ctx, error, {
        feature: 'admin',
        action: 'skills_panel',
        fallback: 'فهرست مهارت‌ها باز نشد.'
      })
    }
  })

  // ── ورودی عددی
  bot.callbackQuery(/^adm:act:[a-z_]+:-?\d+$/, async (ctx) => {
    const adminId = BigInt(ctx.from.id)
    if (!(await guardAdmin(ctx, container, adminId))) return
    const [, , action, rawTarget] = ctx.callbackQuery.data.split(':')
    const targetId = rawTarget!

    const prompts: Record<string, { title: string; lines: string[] }> = {
      balance_add: {
        title: '➕ افزودن موجودی',
        lines: [
          'مبلغی که به کیف پول بازیکن اضافه شود را بنویس.',
          `بازهٔ مجاز: ${fieldLimitText('balance')}.`
        ]
      },
      balance_remove: {
        title: '➖ کسر موجودی',
        lines: [
          'مبلغی که از کیف پول بازیکن کم شود را بنویس.',
          `بازهٔ مجاز: ${fieldLimitText('balance')}.`
        ]
      },
      balance_set: {
        title: '🎯 تنظیم موجودی',
        lines: [
          'موجودی نهایی بازیکن را بنویس (جایگزین می‌شود).',
          `بازهٔ مجاز: ${fieldLimitText('balance')}.`
        ]
      },
      health: {
        title: '❤️ تنظیم سلامت',
        lines: [`مقدار تازهٔ سلامت را بنویس (بازهٔ ${fieldLimitText('health')}).`]
      },
      fatigue: {
        title: '⚡ تنظیم خستگی',
        lines: [`مقدار تازهٔ خستگی را بنویس (بازهٔ ${fieldLimitText('fatigue')}).`]
      },
      experience: {
        title: '⭐ تنظیم تجربه',
        lines: [`مقدار تازهٔ تجربه را بنویس (بازهٔ ${fieldLimitText('experience')}).`]
      }
    }
    const prompt = prompts[action!]
    if (!prompt) {
      // پیش از اولین ack؛ ack دوم به کاربر نمی‌رسد
      await ackCallback(ctx, 'این عملیات شناخته‌شده نیست.', true)
      return
    }

    await ackCallback(ctx)
    await container.userStateRepository.upsert(adminId, {
      currentContext: `adm:amount:${action}:${targetId}`,
      stateData: { chatId: ctx.chat!.id, panelMessageId: ctx.callbackQuery.message!.message_id }
    })
    await editPanel(ctx, {
      text: panel({
        icon: '✍️',
        title: prompt.title,
        sections: [{ lines: [...prompt.lines, '', 'برای لغو «انصراف» را بنویس.'] }]
      }),
      keyboard: buildCloseKeyboard()
    })
  })

  bot.callbackQuery(/^adm:skill:[\w-]+:-?\d+$/, async (ctx) => {
    const adminId = BigInt(ctx.from.id)
    if (!(await guardAdmin(ctx, container, adminId))) return
    const [, , skillId, rawTarget] = ctx.callbackQuery.data.split(':')
    await ackCallback(ctx)
    await container.userStateRepository.upsert(adminId, {
      currentContext: `adm:skill:${skillId}:${rawTarget}`,
      stateData: { chatId: ctx.chat!.id, panelMessageId: ctx.callbackQuery.message!.message_id }
    })
    await editPanel(ctx, {
      text: panel({
        icon: '🧠',
        title: 'تنظیم سطح مهارت',
        sections: [
          {
            lines: [
              `سطح تازه را بنویس (بازهٔ ${fieldLimitText('skillLevel')}).`,
              '',
              'برای لغو «انصراف» را بنویس.'
            ]
          }
        ]
      }),
      keyboard: buildCloseKeyboard()
    })
  })

  // ── تغییر وضعیت حساب
  bot.callbackQuery(/^adm:status:[A-Z]+:-?\d+$/, async (ctx) => {
    const adminId = BigInt(ctx.from.id)
    if (!(await guardAdmin(ctx, container, adminId))) return
    const [, , rawStatus, rawTarget] = ctx.callbackQuery.data.split(':')
    const targetId = BigInt(rawTarget!)
    // فقط مقادیری که همین کیبورد تولید می‌کند پذیرفته است؛ بقیه حتی به سرویس نمی‌رسند.
    if (rawStatus !== PlayerStatus.ACTIVE && rawStatus !== PlayerStatus.INACTIVE) {
      await ackCallback(ctx, 'این وضعیت معتبر نیست.', true)
      return
    }
    try {
      await stageAdminChange(
        ctx,
        container,
        { action: 'status', target: targetId.toString(), value: rawStatus },
        'وضعیت حساب',
        [`وضعیت جدید: ${playerStatusAdminLabels[rawStatus]}`]
      )
      await ackCallback(ctx)
    } catch (error) {
      await handleCallbackError(ctx, error, {
        feature: 'admin',
        action: 'set_status',
        fallback: 'وضعیت حساب تغییر نکرد.'
      })
    }
  })

  // ── تنظیم مدرک
  bot.callbackQuery(/^adm:degree:[A-Z]+:-?\d+$/, async (ctx) => {
    const adminId = BigInt(ctx.from.id)
    if (!(await guardAdmin(ctx, container, adminId))) return
    const [, , rawDegree, rawTarget] = ctx.callbackQuery.data.split(':')
    const targetId = BigInt(rawTarget!)
    if (!(rawDegree !== undefined && rawDegree in degreeLabels)) {
      await ackCallback(ctx, 'این مدرک معتبر نیست.', true)
      return
    }
    try {
      await stageAdminChange(
        ctx,
        container,
        { action: 'degree', target: targetId.toString(), value: rawDegree },
        'مدرک تحصیلی',
        [`مدرک جدید: ${degreeLabels[rawDegree as DegreeLevel]}`]
      )
      await ackCallback(ctx)
    } catch (error) {
      await handleCallbackError(ctx, error, {
        feature: 'admin',
        action: 'set_degree',
        fallback: 'مدرک تغییر نکرد.'
      })
    }
  })

  // ── مرحلهٔ تأیید
  bot.callbackQuery(/^adm:confirm:[a-z_]+:-?\d+$/, async (ctx) => {
    const adminId = BigInt(ctx.from.id)
    if (!(await guardAdmin(ctx, container, adminId))) return
    const [, , action, rawTarget] = ctx.callbackQuery.data.split(':')
    const targetId = BigInt(rawTarget!)

    // گاردها پیش از اولین ack سنجیده می‌شوند؛ ack دوم هرگز به کاربر نمی‌رسد
    // (تلگرام هر callback را فقط یک بار پاسخ می‌دهد) و پیام خطا گم می‌شد.
    if (action === 'admin_remove' && !(await container.adminService.isOwner(adminId))) {
      await ackCallback(ctx, 'فقط ادمین اصلی می‌تواند ادمین حذف کند.', true)
      return
    }

    // حذف حساب: پیش‌نمایش واقعی (مانع‌ها، پاک‌شدنی‌ها و اثرها) پیش از تأیید
    if (action === 'player_delete') {
      try {
        await stagePlayerDeletion(ctx, container, targetId)
        await ackCallback(ctx)
      } catch (error) {
        await handleCallbackError(ctx, error, {
          feature: 'admin',
          action: 'delete_preview',
          fallback: 'پیش‌نمایش حذف حساب باز نشد.'
        })
      }
      return
    }

    const descriptions: Record<string, { title: string; lines: string[] }> = {
      work_stop: {
        title: '⏹️ توقف نوبت کاری',
        lines: [
          'نوبت کاری فعال این بازیکن لغو می‌شود و ظرفیت شغل آزاد می‌گردد.',
          'مزدی برای این شیفت پرداخت نمی‌شود.'
        ]
      },
      edu_stop: {
        title: '🎓 لغو تحصیل',
        lines: ['ثبت‌نام تحصیلی این بازیکن لغو می‌شود؛ شهریهٔ پرداختی برگردانده نمی‌شود.']
      },
      streak_reset: {
        title: '🔥 صفرکردن استریک',
        lines: ['استریک روزانهٔ این بازیکن صفر می‌شود.']
      },
      state_reset: {
        title: '♻️ بازنشانی وضعیت',
        lines: [
          'فعالیت، تحصیل، استراحت، نوبت کاری، سلامت و خستگی به حالت اولیه برمی‌گردد.',
          'موجودی و دارایی‌ها دست‌نخورده می‌ماند.'
        ]
      },
      ban: {
        title: '⛔ مسدودکردن حساب',
        lines: [
          'بازیکن دیگر نمی‌تواند فعالیتی آغاز کند و فعالیت جاری‌اش متوقف می‌شود.',
          'داده‌های او پاک نمی‌شود و با «فعال» قابل بازگرداندن است.'
        ]
      },
      admin_remove: {
        title: '🗑️ حذف ادمین',
        lines: [
          'فقط دسترسی مدیریت گرفته می‌شود.',
          'حساب بازی، موجودی و دارایی‌های او دست‌نخورده می‌ماند.'
        ]
      }
    }
    const description = descriptions[action!]
    if (!description) {
      await ackCallback(ctx, 'این عملیات شناخته‌شده نیست.', true)
      return
    }

    await stageAdminChange(
      ctx,
      container,
      { action: action!, target: targetId.toString() },
      description.title,
      description.lines
    )
    await ackCallback(ctx)
  })

  bot.callbackQuery('adm:discard', async (ctx) => {
    if (!(await guardAdmin(ctx, container, BigInt(ctx.from.id)))) return
    await container.userStateRepository.clear(BigInt(ctx.from.id))
    await ackCallback(ctx, 'لغو شد؛ تغییری ثبت نشد.')
    await editPanel(ctx, {
      text: resultPanel('لغو تغییر', ['هیچ تغییری ثبت نشد.']),
      keyboard: buildAdminHomeKeyboard(await container.adminService.isOwner(BigInt(ctx.from.id)))
    })
  })

  // Legacy execution buttons must never bypass the new confirmation protocol.
  bot.callbackQuery(/^adm:run:/, async (ctx) => {
    if (!(await guardAdmin(ctx, container, BigInt(ctx.from.id)))) return
    await ackCallback(
      ctx,
      'این دکمه قدیمی است. «پنل ادمین» را دوباره باز کن و تغییر را تأیید کن.',
      true
    )
  })

  bot.callbackQuery(/^adm:apply:[a-f0-9-]{36}$/, async (ctx) => {
    const adminId = BigInt(ctx.from.id)
    if (!(await guardAdmin(ctx, container, adminId))) return
    try {
      const change = await container.userStateRepository.consumeConfirmation(
        adminId,
        ctx.chat!.id,
        ctx.callbackQuery.data.slice('adm:apply:'.length)
      )
      if (!change) {
        await ackCallback(
          ctx,
          'این تأیید منقضی، لغو یا قبلاً استفاده شده است. تغییر را از پنل دوباره انتخاب کن.',
          true
        )
        return
      }
      const target = BigInt(String(change.target))
      const action = String(change.action)
      let detail = 'تغییر ثبت شد و در گزارش مدیریت قابل مشاهده است.'
      switch (action) {
        case 'admin_add':
          await container.adminService.addAdmin(adminId, {
            telegramUserId: target,
            firstName: typeof change.firstName === 'string' ? change.firstName : undefined,
            username: typeof change.username === 'string' ? change.username : undefined
          })
          detail = 'دسترسی ادمین اضافه شد. ورود با «پنل ادمین» امکان‌پذیر است.'
          break
        case 'admin_remove':
          await container.adminService.removeAdmin(adminId, target)
          detail = 'دسترسی مدیریت حذف شد؛ اطلاعات بازی دست‌نخورده ماند.'
          break
        case 'work_stop':
          await container.adminService.stopActiveWork(adminId, target)
          break
        case 'edu_stop':
          await container.adminService.stopEducation(adminId, target)
          break
        case 'streak_reset':
          await container.adminService.resetStreak(adminId, target)
          break
        case 'state_reset':
          await container.adminService.resetState(adminId, target)
          break
        case 'ban':
          await container.adminService.setAccountStatus(adminId, target, PlayerStatus.BANNED)
          break
        case 'warning': {
          const result = await container.adminService.issueWarning(
            adminId,
            target,
            String(change.reason ?? '')
          )
          detail = [
            `اخطارهای فعال: ${fa(result.activeCount)} از ${fa(WARNING_BAN_THRESHOLD)}`,
            result.banned
              ? '⛔ آستانه پر شد؛ حساب خودکار مسدود و نوبت کاری فعالش بسته شد.'
              : `${fa(result.remainingUntilBan)} اخطار فعال دیگر تا مسدودسازی خودکار.`,
            'دلیل در اعلان‌های بازی به خودِ بازیکن هم نشان داده شد.'
          ].join('\n')
          break
        }
        case 'warning_revoke': {
          const result = await container.adminService.revokeWarning(
            adminId,
            target,
            String(change.warningId ?? '')
          )
          detail = [
            `اخطارهای فعال: ${fa(result.activeCount)} از ${fa(WARNING_BAN_THRESHOLD)}`,
            result.stillBanned
              ? 'حساب همچنان مسدود است؛ بازگرداندن دسترسی از «وضعیت و محدودیت‌ها» انجام می‌شود.'
              : 'حساب مسدود نیست.'
          ].join('\n')
          break
        }
        case 'message': {
          const text = plainInput(String(change.text ?? ''))
          await container.adminService.sendPlayerMessage(adminId, target, text)
          const delivered = await ctx.api
            .sendMessage(
              target.toString(),
              panel({
                icon: '📩',
                title: 'پیام مدیریت',
                sections: [{ lines: [text] }],
                footer: 'این پیام از طرف مدیریت بازی برای تو ارسال شده است.'
              }),
              { parse_mode: 'Markdown' }
            )
            .then(() => true)
            .catch((error: unknown) => {
              logger.warn(
                { err: error, feature: 'admin', action: 'message_deliver' },
                'admin direct message was not delivered'
              )
              return false
            })
          detail = delivered
            ? 'پیام خصوصی ارسال شد و یک نسخه هم در اعلان‌های بازی او ماند.'
            : 'پیام در اعلان‌های بازی او ثبت شد، ولی پیام خصوصی نرسید؛ احتمالاً ربات را مسدود کرده است.'
          break
        }
        case 'player_delete': {
          const result = await container.adminService.deletePlayer(adminId, target)
          detail = [
            `حساب «${plainInput(result.firstName)}» و داده‌های وابسته پاک شد.`,
            `پول خارج‌شده از گردش: ${money(result.removedFunds)}`,
            'دفتر مالی و تاریخچهٔ منطقه نگه داشته شد.'
          ].join('\n')
          break
        }
        case 'status':
          await container.adminService.setAccountStatus(
            adminId,
            target,
            change.value as PlayerStatus
          )
          break
        case 'degree':
          await container.adminService.setDegree(adminId, target, change.value as DegreeLevel)
          break
        case 'skill':
          await container.adminService.setSkillLevel(
            adminId,
            target,
            String(change.skillId),
            Number(change.value)
          )
          break
        case 'balance_add':
        case 'balance_remove': {
          const result = await container.adminService.adjustBalance(
            adminId,
            target,
            Number(change.value) * (action === 'balance_remove' ? -1 : 1)
          )
          detail = `موجودی قبلی: ${money(result.before)}\nموجودی جدید: ${money(result.after)}`
          break
        }
        case 'balance_set':
        case 'health':
        case 'fatigue':
        case 'experience': {
          const field = action === 'balance_set' ? 'balance' : action
          const result = await container.adminService.setField(
            adminId,
            target,
            field,
            Number(change.value)
          )
          detail = `مقدار قبلی: ${field === 'balance' ? money(result.before) : fa(result.before)}\nمقدار جدید: ${field === 'balance' ? money(result.after) : fa(result.after)}`
          break
        }
        default:
          throw new Error('Unknown administrative change')
      }
      await ackCallback(ctx, 'تغییر ثبت شد')
      await editPanel(ctx, {
        text: resultPanel('تغییر ثبت شد', [`شناسهٔ هدف: \`${target.toString()}\``, detail]),
        keyboard: await postChangeKeyboard(container, adminId, action, target)
      })
    } catch (error) {
      await handleCallbackError(ctx, error, {
        feature: 'admin',
        action: 'apply',
        fallback:
          'نتیجهٔ تغییر قابل تأیید نیست. وضعیت هدف و گزارش مدیریت را بررسی کن؛ سپس در صورت نیاز دوباره اقدام کن.'
      })
    }
  })

  // ── گروه‌ها
  bot.callbackQuery(/^adm:groups:\d+$/, async (ctx) => {
    const adminId = BigInt(ctx.from.id)
    if (!(await guardAdmin(ctx, container, adminId))) return
    await ackCallback(ctx)
    const page = Number(ctx.callbackQuery.data.split(':')[2] ?? '0') || 0
    try {
      const searchState = await container.userStateRepository.findByTelegramUserId(adminId)
      const searchData = searchState?.stateData as Prisma.JsonObject | undefined
      const term =
        searchState?.currentContext === 'adm:group_search' &&
        searchData?.chatId === ctx.chat!.id &&
        typeof searchData.term === 'string'
          ? searchData.term
          : undefined
      const result = await container.adminService.listGroups(adminId, page, term)
      const totalPages = Math.max(1, Math.ceil(result.total / result.pageSize))
      await editPanel(ctx, {
        text: panel({
          icon: '🌐',
          title: `${term ? 'نتیجهٔ جست‌وجوی گروه' : 'گروه‌ها'} (${fa(result.total)})`,
          sections: [
            {
              lines:
                result.items.length === 0
                  ? ['گروهی ثبت نشده است.']
                  : result.items.flatMap((group) => [
                      `• *${plainInput(group.title)}* — \`${group.telegramGroupId.toString()}\``,
                      `   ${ENVIRONMENT_LABELS[group.environmentLevel]} · ${fa(
                        group.gamePopulation
                      )} شهروند · ${group.status === GroupStatus.ACTIVE ? 'فعال' : 'غیرفعال'}`
                    ])
            }
          ]
        }),
        keyboard: buildAdminGroupsKeyboard(
          result.items.map((group) => group.telegramGroupId),
          result.page,
          totalPages
        )
      })
    } catch (error) {
      await handleCallbackError(ctx, error, {
        feature: 'admin',
        action: 'list_groups',
        fallback: 'فهرست گروه‌ها باز نشد.'
      })
    }
  })

  bot.callbackQuery(/^adm:group:-?\d+$/, async (ctx) => {
    const adminId = BigInt(ctx.from.id)
    if (!(await guardAdmin(ctx, container, adminId))) return
    await ackCallback(ctx)
    const telegramGroupId = BigInt(ctx.callbackQuery.data.split(':')[2]!)
    try {
      const group = await container.groupRepository.findByTelegramGroupId(telegramGroupId)
      if (!group) {
        await editPanel(ctx, {
          text: resultPanel('🌐 گروه', ['این گروه در فهرست گروه‌های بازی نیست.']),
          keyboard: buildAdminGroupsKeyboard([], 0, 1)
        })
        return
      }
      await editPanel(ctx, {
        text: renderAdminGroupPanel(group),
        keyboard: new InlineKeyboard()
          .text('🔄 همگام‌سازی با تلگرام', `adm:group:sync:${group.telegramGroupId.toString()}`)
          .row()
          .text('⬅️ فهرست گروه‌ها', 'adm:groups:0')
          .text('بستن', 'panel:close')
          .row()
      })
    } catch (error) {
      await handleCallbackError(ctx, error, {
        feature: 'admin',
        action: 'view_group',
        fallback: 'اطلاعات گروه باز نشد.'
      })
    }
  })

  bot.callbackQuery(/^adm:group:sync:-?\d+$/, async (ctx) => {
    const adminId = BigInt(ctx.from.id)
    if (!(await guardAdmin(ctx, container, adminId))) return
    await ackCallback(ctx)
    const telegramGroupId = BigInt(ctx.callbackQuery.data.split(':')[3]!)
    try {
      const existing = await container.groupRepository.findByTelegramGroupId(telegramGroupId)
      if (!existing) {
        await editPanel(ctx, {
          text: resultPanel('🌐 همگام‌سازی', ['این گروه در فهرست گروه‌های بازی نیست.']),
          keyboard: buildAdminGroupsKeyboard([], 0, 1)
        })
        return
      }
      const result = await container.groupService.ensureGroupUpdated({
        telegramGroupId,
        title: existing.title,
        type: (existing.type as GroupType) ?? GroupType.SUPERGROUP
      })
      await editPanel(ctx, {
        text: resultPanel('🔄 همگام‌سازی انجام شد', [
          result.memberCountSynced
            ? `اعضای تلگرام تازه خوانده شد: ${fa(result.group.realMemberCount)} نفر.`
            : 'تلگرام اطلاعات اعضا را نداد؛ عدد ذخیره‌شده حفظ شد.',
          `👥 شهروندان بازی: ${fa(result.group.gamePopulation)} نفر`,
          `🏙️ سطح محیط: ${ENVIRONMENT_LABELS[result.group.environmentLevel]}`
        ]),
        keyboard: new InlineKeyboard()
          .text('🔄 همگام‌سازی دوباره', `adm:group:sync:${telegramGroupId.toString()}`)
          .row()
          .text('⬅️ اطلاعات گروه', `adm:group:${telegramGroupId.toString()}`)
          .text('بستن', 'panel:close')
          .row()
      })
    } catch (error) {
      await handleCallbackError(ctx, error, {
        feature: 'admin',
        action: 'sync_group',
        fallback: 'همگام‌سازی گروه انجام نشد.'
      })
    }
  })

  // ── گزارش اقدامات
  bot.callbackQuery(/^adm:logs:\d+$/, async (ctx) => {
    const adminId = BigInt(ctx.from.id)
    if (!(await guardAdmin(ctx, container, adminId))) return
    await ackCallback(ctx)
    const page = Number(ctx.callbackQuery.data.split(':')[2] ?? '0') || 0
    try {
      const result = await container.adminService.listAdminLogs(adminId, page)
      const totalPages = Math.max(1, Math.ceil(result.total / result.pageSize))
      await editPanel(ctx, {
        text: panel({
          icon: '📜',
          title: `گزارش اقدامات (${fa(result.total)})`,
          sections: [
            {
              lines:
                result.items.length === 0
                  ? ['هنوز اقدامی ثبت نشده است.']
                  : result.items.flatMap((entry) => [
                      `• *${adminActionLabels[entry.action] ?? 'اقدام مدیریتی'}*`,
                      `   👤 \`${entry.actorUserId.toString()}\`${
                        entry.targetUserId ? ` → \`${entry.targetUserId.toString()}\`` : ''
                      } · ${faDate(entry.createdAt)}`,
                      `   ${formatLogDetails(entry.details)}`,
                      ''
                    ])
            }
          ]
        }),
        keyboard: buildAdminPaginationKeyboard('logs', result.page, totalPages)
      })
    } catch (error) {
      await handleCallbackError(ctx, error, {
        feature: 'admin',
        action: 'list_logs',
        fallback: 'گزارش اقدامات باز نشد.'
      })
    }
  })

  // ── پرونده‌های میراثی که چرخهٔ خودکار رهایشان کرده
  bot.callbackQuery('adm:cases', async (ctx) => {
    const adminId = BigInt(ctx.from.id)
    if (!(await guardAdmin(ctx, container, adminId))) return
    await ackCallback(ctx)
    try {
      const cases = await container.adminService.listStalledInheritance(adminId)
      await editPanel(ctx, {
        text: renderAdminInheritancePanel(cases),
        keyboard: buildAdminInheritanceKeyboard(cases)
      })
    } catch (error) {
      await handleCallbackError(ctx, error, {
        feature: 'admin',
        action: 'list_stalled_inheritance',
        fallback: 'پرونده‌های میراث باز نشد.'
      })
    }
  })

  bot.callbackQuery(/^adm:case_retry:[\w-]+$/, async (ctx) => {
    const adminId = BigInt(ctx.from.id)
    if (!(await guardAdmin(ctx, container, adminId))) return
    const caseId = ctx.callbackQuery.data.slice('adm:case_retry:'.length)
    try {
      const result = await container.adminService.retryInheritanceCase(adminId, caseId)
      if (!result) {
        await ackCallback(ctx, 'این پرونده دیگر وجود ندارد.', true)
      } else {
        await ackCallback(ctx, `دوباره اجرا شد — ${plainInput(result.deceasedName)}`)
      }
      // صف پس از تلاش دوباره بازخوانی می‌شود: اگر پرونده بسته شده باشد باید
      // از فهرست بیرون برود، و گرنه اپراتور باید وضعیت تازه‌اش را ببیند.
      const cases = await container.adminService.listStalledInheritance(adminId)
      await editPanel(ctx, {
        text: renderAdminInheritancePanel(cases),
        keyboard: buildAdminInheritanceKeyboard(cases)
      })
    } catch (error) {
      await handleCallbackError(ctx, error, {
        feature: 'admin',
        action: 'retry_inheritance',
        fallback: 'اجرای دوبارهٔ این پرونده ممکن نشد.'
      })
    }
  })

  // ── گزارش‌های بازیکنان (صف ← جزئیات ← پاسخ)
  bot.callbackQuery(/^adm:reports:\d+$/, async (ctx) => {
    const adminId = BigInt(ctx.from.id)
    if (!(await guardAdmin(ctx, container, adminId))) return
    await ackCallback(ctx)
    const page = Number(ctx.callbackQuery.data.split(':')[2] ?? '0') || 0
    try {
      const result = await container.adminService.listReports(adminId, page)
      await editPanel(ctx, {
        text: renderAdminReportsPanel(result),
        keyboard: buildAdminReportsKeyboard(result)
      })
    } catch (error) {
      await handleCallbackError(ctx, error, {
        feature: 'admin',
        action: 'list_reports',
        fallback: 'گزارش‌های بازیکنان باز نشد.'
      })
    }
  })

  bot.callbackQuery(/^adm:report:.+$/, async (ctx) => {
    const adminId = BigInt(ctx.from.id)
    if (!(await guardAdmin(ctx, container, adminId))) return
    await ackCallback(ctx)
    const reportId = ctx.callbackQuery.data.slice('adm:report:'.length)
    try {
      const report = await container.adminService.getReport(adminId, reportId)
      if (!report) {
        await editPanel(ctx, {
          text: resultPanel('گزارش پیدا نشد', [
            'این گزارش دیگر وجود ندارد؛ صف را دوباره باز کن.'
          ]),
          keyboard: buildAdminReportsBackKeyboard()
        })
        return
      }
      await editPanel(ctx, {
        text: renderAdminReportDetail(report),
        keyboard: buildAdminReportDetailKeyboard(report)
      })
    } catch (error) {
      await handleCallbackError(ctx, error, {
        feature: 'admin',
        action: 'show_report',
        fallback: 'این گزارش باز نشد.'
      })
    }
  })

  bot.callbackQuery(/^adm:report_reply:.+$/, async (ctx) => {
    const adminId = BigInt(ctx.from.id)
    if (!(await guardAdmin(ctx, container, adminId))) return
    const reportId = ctx.callbackQuery.data.slice('adm:report_reply:'.length)
    await ackCallback(ctx)
    try {
      const report = await container.adminService.getReport(adminId, reportId)
      if (!report) {
        await editPanel(ctx, {
          text: resultPanel('گزارش پیدا نشد', ['صف را دوباره باز کن.']),
          keyboard: buildAdminReportsBackKeyboard()
        })
        return
      }

      // جریانِ ورودی به همین چت و همین پنل گره می‌خورد (مثل اخطار و پیام).
      await container.userStateRepository.upsert(adminId, {
        currentContext: `adm:report_reply:${reportId}`,
        stateData: { chatId: ctx.chat!.id, panelMessageId: ctx.callbackQuery.message!.message_id }
      })

      await editPanel(ctx, {
        text: panel({
          icon: '✍️',
          title: 'نوشتن پاسخ',
          sections: [
            { rows: [{ label: '👤 بازیکن', value: plainInput(report.playerName) }] },
            { title: '📝 گزارش او', lines: [`«${report.body}»`] }
          ],
          footer: `💡 پاسخ باید ${textLimitText(REPORT_ANSWER_LIMITS)} باشد و به‌صورت اعلان به بازیکن می‌رسد.`
        }),
        keyboard: new InlineKeyboard().text('لغو پاسخ', 'adm:report_cancel')
      })
    } catch (error) {
      await handleCallbackError(ctx, error, {
        feature: 'admin',
        action: 'reply_report_prompt',
        fallback: 'صفحهٔ نوشتن پاسخ باز نشد.'
      })
    }
  })

  bot.callbackQuery('adm:report_cancel', async (ctx) => {
    const adminId = BigInt(ctx.from.id)
    if (!(await guardAdmin(ctx, container, adminId))) return
    // state پیش از هر چیز پاک می‌شود؛ وگرنه متنِ بعدیِ ادمین پاسخ می‌شد.
    await container.userStateRepository.clear(adminId)
    await ackCallback(ctx, 'لغو شد')
    await editPanel(ctx, {
      text: resultPanel('لغو پاسخ', ['هیچ پاسخی ثبت نشد.']),
      keyboard: buildAdminReportsBackKeyboard()
    })
  })

  bot.callbackQuery(/^adm:report_close:.+$/, async (ctx) => {
    const adminId = BigInt(ctx.from.id)
    if (!(await guardAdmin(ctx, container, adminId))) return
    const reportId = ctx.callbackQuery.data.slice('adm:report_close:'.length)
    await ackCallback(ctx, 'گزارش بسته شد')
    try {
      const result = await container.adminService.closeReport(adminId, reportId)
      // Push بیرون تراکنش: شکستِ تحویل، بسته‌شدنِ ثبت‌شده را برنمی‌گرداند.
      await container.notificationService
        .pushByPlayerId(
          result.playerId,
          '📪 گزارش پشتیبانی بسته شد',
          result.reason ?? 'گزارشت بررسی و بسته شد.'
        )
        .catch(() => false)
      await editPanel(ctx, {
        text: resultPanel('گزارش بسته شد', [
          `${plainInput(result.playerName)} اعلان بسته‌شدن را گرفت.`
        ]),
        keyboard: buildAdminReportsBackKeyboard()
      })
    } catch (error) {
      await handleCallbackError(ctx, error, {
        feature: 'admin',
        action: 'close_report',
        fallback: 'بستن گزارش انجام نشد.'
      })
    }
  })
}

// ───────────────────────────────────────────────────────── ورودی متنی

/**
 * رسیدگی به ورودی متنیِ جریان‌های ادمین.
 * از `bot.on('message:text')` صدا زده می‌شود؛ `true` یعنی پیام مصرف شد.
 */
export async function handleAdminInputText(
  ctx: Context,
  container: Container,
  pendingContext: string,
  rawText: string
): Promise<boolean> {
  const adminId = BigInt(ctx.from!.id)
  const admin = await container.adminService.findAdmin(adminId)
  // اگر دسترسی در میانهٔ جریان گرفته شده باشد، state پاک می‌شود و بی‌صدا می‌ایستیم
  if (!admin || !admin.isActive) {
    await container.userStateRepository.clear(adminId).catch(() => undefined)
    return true
  }

  const pending = await container.userStateRepository.findByTelegramUserId(adminId)
  const metadata = pending?.stateData as Prisma.JsonObject | undefined
  if (typeof metadata?.chatId === 'number' && metadata.chatId !== ctx.chat?.id) {
    await sendPanel(ctx, {
      text: 'این ورودی مربوط به پنل چت دیگری است. به همان چت برگرد یا اینجا «پنل ادمین» را باز کن.'
    })
    return true
  }
  if (typeof metadata?.panelMessageId === 'number') inputPanels.set(ctx, metadata.panelMessageId)

  if (isCancelWord(rawText)) {
    await container.userStateRepository.clear(adminId)
    await sendPanel(ctx, {
      text: resultPanel('✖️ لغو شد', ['هیچ تغییری ثبت نشد.']),
      keyboard: buildCloseKeyboard()
    })
    return true
  }

  if (pendingContext.startsWith('adm:confirm:')) {
    await sendPanel(ctx, {
      text: 'تغییر هنوز ثبت نشده است. دکمهٔ تأیید را بزن یا «انصراف» را بفرست.'
    })
    return true
  }

  if (pendingContext === 'adm:group_find') {
    await showGroupSearch(ctx, container, adminId, rawText)
    return true
  }

  if (pendingContext === 'adm:find') {
    // ورودی خالی state را نمی‌سوزاند تا «دوباره تلاش کن» واقعاً کار کند
    if (rawText.trim().length > 0) {
      await container.userStateRepository.clear(adminId)
    }
    await showSearchResult(ctx, container, adminId, rawText)
    return true
  }

  if (pendingContext.startsWith('adm:warn:')) {
    const targetId = BigInt(pendingContext.slice('adm:warn:'.length))
    await runWarningInput(ctx, container, targetId, rawText)
    return true
  }

  if (pendingContext.startsWith('adm:msg:')) {
    const targetId = BigInt(pendingContext.slice('adm:msg:'.length))
    await runMessageInput(ctx, container, targetId, rawText)
    return true
  }

  if (pendingContext.startsWith('adm:amount:')) {
    const [, , action, rawTarget] = pendingContext.split(':')
    const targetId = BigInt(rawTarget!)
    await runAmountAction(ctx, container, adminId, action!, targetId, rawText)
    return true
  }

  if (pendingContext.startsWith('adm:skill:')) {
    const [, , skillId, rawTarget] = pendingContext.split(':')
    const targetId = BigInt(rawTarget!)
    const parsed = parseAmountDetailed(rawText, {
      allowZero: false,
      max: ADMIN_FIELD_LIMITS.skillLevel.max
    })
    if (!parsed.ok) {
      await sendPanel(ctx, {
        text: panel({
          icon: '⚠️',
          title: 'سطح مهارت ثبت نشد',
          sections: [
            { lines: [`سطح مهارت باید عددی صحیح بین ${fieldLimitText('skillLevel')} باشد.`] }
          ]
        }),
        keyboard: buildCloseKeyboard()
      })
      return true
    }
    try {
      await stageAdminChange(
        ctx,
        container,
        { action: 'skill', target: targetId.toString(), skillId: skillId!, value: parsed.value },
        'سطح مهارت',
        [`سطح جدید: ${fa(parsed.value)}`]
      )
    } catch (error) {
      await sendInputError(ctx, error, 'تنظیم سطح مهارت انجام نشد.')
    }
    return true
  }

  if (pendingContext.startsWith('adm:report_reply:')) {
    const reportId = pendingContext.slice('adm:report_reply:'.length)
    await runReportReplyInput(ctx, container, reportId, rawText)
    return true
  }

  return false
}

/**
 * دریافت متنِ پاسخ به گزارش و ثبت آن.
 *
 * ترتیب: اعتبارسنجی و ثبت در یک تراکنش ← پاک‌کردن state ← پیام نتیجه.
 * تختهٔ اعلان و گزارش مدیریت داخل همان تراکنش سرویس نوشته می‌شوند؛ پیام
 * خصوصی این‌جا و بیرون تراکنش می‌رود تا شکستِ تحویل، پاسخِ ثبت‌شده را
 * برنگرداند. اگر اعتبارسنجی رد شود، state پاک نمی‌شود تا ادمین همان‌جا متنِ
 * درست را بنویسد.
 */
async function runReportReplyInput(
  ctx: Context,
  container: Container,
  reportId: string,
  rawText: string
): Promise<void> {
  const adminId = BigInt(ctx.from!.id)
  try {
    const result = await container.adminService.replyToReport(adminId, reportId, rawText)
    await container.userStateRepository.clear(adminId)
    await container.notificationService
      .pushByPlayerId(result.playerId, '📨 پاسخ پشتیبانی', result.answer)
      .catch(() => false)

    await sendPanel(ctx, {
      text: panel({
        icon: '✅',
        title: 'پاسخ ثبت و ارسال شد',
        sections: [
          {
            rows: [
              { label: '👤 بازیکن', value: plainInput(result.playerName) },
              { label: '🕒 زمان', value: faDate(new Date()) }
            ]
          },
          { lines: [`«${result.answer}»`] }
        ],
        footer: '💡 پاسخ در «اعلان‌ها» و پنل پشتیبانی خودِ بازیکن دیده می‌شود.'
      }),
      keyboard: buildAdminReportsBackKeyboard()
    })
  } catch (error) {
    await sendInputError(ctx, error, 'پاسخ ثبت نشد.')
  }
}

/**
 * دریافت دلیل اخطار از متن و بردنش به مرحلهٔ تأیید.
 * اعتبارسنجی همان تابعی است که سرویس هم موقع نوشتن صدا می‌زند؛ پس پیام خطا
 * و رفتار واقعی هرگز از هم جدا نمی‌افتند.
 */
async function runWarningInput(
  ctx: Context,
  container: Container,
  targetId: bigint,
  rawText: string
): Promise<void> {
  let reason: string
  try {
    reason = validateWarningReason(rawText)
  } catch (error) {
    await sendPanel(ctx, {
      text: panel({
        icon: '⚠️',
        title: 'اخطار ثبت نشد',
        sections: [
          {
            lines: [
              error instanceof AppError
                ? error.persianMessage
                : `دلیل اخطار باید ${textLimitText(WARNING_REASON_LIMITS)} باشد.`
            ]
          }
        ],
        footer: '💡 جریان باز است؛ دلیل درست را همین‌جا بنویس.'
      }),
      keyboard: buildCloseKeyboard()
    })
    return
  }

  try {
    await stageAdminChange(
      ctx,
      container,
      { action: 'warning', target: targetId.toString(), reason },
      'اخطار',
      [
        `دلیل: ${reason}`,
        '',
        `پس از ثبت، اخطارهای فعال با آستانهٔ ${fa(WARNING_BAN_THRESHOLD)} مقایسه می‌شود؛`,
        'اگر آستانه پر شود حساب همان لحظه مسدود و نوبت کاری‌اش بسته می‌شود.'
      ]
    )
  } catch (error) {
    await sendInputError(ctx, error, 'اخطار ثبت نشد.')
  }
}

/** دریافت متن پیام ادمین و بردنش به مرحلهٔ تأیید. */
async function runMessageInput(
  ctx: Context,
  container: Container,
  targetId: bigint,
  rawText: string
): Promise<void> {
  let text: string
  try {
    text = validateAdminMessage(rawText)
  } catch (error) {
    await sendPanel(ctx, {
      text: panel({
        icon: '⚠️',
        title: 'پیام ارسال نشد',
        sections: [
          {
            lines: [
              error instanceof AppError
                ? error.persianMessage
                : `پیام باید ${textLimitText(ADMIN_MESSAGE_LIMITS)} باشد.`
            ]
          }
        ],
        footer: '💡 جریان باز است؛ متن درست را همین‌جا بنویس.'
      }),
      keyboard: buildCloseKeyboard()
    })
    return
  }

  try {
    await stageAdminChange(
      ctx,
      container,
      { action: 'message', target: targetId.toString(), text },
      'ارسال پیام',
      [
        'متن پیام:',
        text,
        '',
        'پیام در چت خصوصی ربات برای او ارسال می‌شود و یک نسخه در اعلان‌های بازی‌اش می‌ماند.'
      ]
    )
  } catch (error) {
    await sendInputError(ctx, error, 'پیام ثبت نشد.')
  }
}

async function showSearchResult(
  ctx: Context,
  container: Container,
  adminId: bigint,
  term: string
): Promise<void> {
  const trimmed = term.trim()
  if (trimmed.length === 0) {
    await sendPanel(ctx, {
      text: panel({
        icon: '⚠️',
        title: 'جست‌وجو',
        sections: [{ lines: ['چیزی ننوشتی؛ دوباره تلاش کن.'] }]
      })
    })
    return
  }

  try {
    const result = await container.adminService.listPlayers(adminId, 0, trimmed)
    await container.userStateRepository.upsert(adminId, {
      currentContext: 'adm:search',
      stateData: { term: trimmed, chatId: ctx.chat!.id }
    })
    if (result.items.length === 0) {
      await sendPanel(ctx, {
        text: panel({
          icon: '🔍',
          title: 'یافتن بازیکن',
          sections: [{ lines: ['بازیکنی با این مشخصات پیدا نشد.'] }]
        }),
        keyboard: new InlineKeyboard()
          .text('جست‌وجوی دوباره', 'adm:find')
          .text('داشبورد', 'adm:home')
      })
      return
    }
    if (result.items.length === 1) {
      const only = result.items[0]!
      const player = await container.adminService.getPlayerAdminView(adminId, only.telegramUserId)
      await sendPanel(ctx, {
        text: renderAdminPlayerPanel(player),
        keyboard: buildAdminPlayerKeyboard(only.telegramUserId)
      })
      return
    }

    await sendPanel(ctx, {
      text: panel({
        icon: '🔍',
        title: `نتیجهٔ جست‌وجو (${fa(result.total)})`,
        sections: [
          {
            lines: result.items.flatMap((player) => [
              `• \`${player.telegramUserId.toString()}\` · ${`${player.firstName} ${
                player.lastName ?? ''
              }`.trim()}`,
              `   ${money(player.balance)} · ${label(playerStatusLabels, player.status)}`
            ])
          }
        ]
      }),
      keyboard: buildAdminPlayersKeyboard(
        result.items.map((item) => item.telegramUserId),
        result.page,
        Math.max(1, Math.ceil(result.total / result.pageSize))
      )
    })
  } catch (error) {
    await sendInputError(ctx, error, 'جست‌وجو انجام نشد.')
  }
}

/**
 * پیام خطای مبلغ.
 *
 * هر دلیل، پیام خودش را دارد؛ هیچ‌وقت «صفر رد شد» را با «باید بین ۰ تا … باشد»
 * پاسخ نمی‌دهیم، چون دقیقاً همان تضادِ متن/رفتار است که در مهریه باگ ساخت.
 */
function amountErrorText(reason: AmountInvalidReason, field: AdminAdjustableField): string {
  switch (reason) {
    case 'empty':
      return 'چیزی ننوشتی؛ عدد را بفرست.'
    case 'negative':
      return 'مقدار نمی‌تواند منفی باشد.'
    case 'zero':
      return 'مقدار نمی‌تواند صفر باشد.'
    case 'not_a_number':
      return 'فقط عدد بنویس (رقم فارسی یا لاتین، با پسوند «هزار/میلیون» هم می‌شود).'
    case 'not_an_integer':
      return 'مقدار باید عدد صحیح باشد؛ اعشار پذیرفته نمی‌شود.'
    case 'too_large':
      return `مقدار از بازهٔ مجاز بیرون است (بازهٔ ${fieldLimitText(field)}).`
  }
}

async function runAmountAction(
  ctx: Context,
  container: Container,
  adminId: bigint,
  action: string,
  targetId: bigint,
  rawText: string
): Promise<void> {
  const fieldOf: Record<string, AdminAdjustableField> = {
    balance_add: 'balance',
    balance_remove: 'balance',
    balance_set: 'balance',
    health: 'health',
    fatigue: 'fatigue',
    experience: 'experience'
  }
  const field = fieldOf[action]
  if (!field) {
    await container.userStateRepository.clear(adminId)
    await sendPanel(ctx, { text: '⚠️ عملیات ناشناخته است.' })
    return
  }

  // صفر برای «مقدار مطلق» معتبر است (تنظیم موجودی روی صفر، سلامت صفر) ولی برای
  // «دلتا» بی‌معناست. قاعده به *عملیات* وابسته است، نه به فیلد.
  const isDelta = action === 'balance_add' || action === 'balance_remove'
  const parsed = parseAmountDetailed(rawText, {
    allowZero: !isDelta,
    max: ADMIN_FIELD_LIMITS[field].max
  })
  if (!parsed.ok) {
    await sendPanel(ctx, {
      text: panel({
        icon: '⚠️',
        title: 'مقدار نامعتبر',
        sections: [{ lines: [amountErrorText(parsed.reason, field)] }],
        footer: '💡 جریان باز است؛ می‌توانی عدد درست را همین‌جا بفرستی.'
      }),
      keyboard: buildCloseKeyboard()
    })
    return
  }

  try {
    const titles: Record<string, string> = {
      balance_add: 'افزایش موجودی',
      balance_remove: 'کسر موجودی',
      balance_set: 'تنظیم موجودی',
      health: 'تنظیم سلامت',
      fatigue: 'تنظیم خستگی',
      experience: 'تنظیم تجربه'
    }
    await stageAdminChange(
      ctx,
      container,
      { action, target: targetId.toString(), value: parsed.value },
      titles[action]!,
      [
        `مقدار درخواستی: ${field === 'balance' ? money(parsed.value) : fa(parsed.value)}`,
        'مقدار معتبر است؛ برای اعمال، دکمهٔ تأیید را بزن.'
      ]
    )
  } catch (error) {
    await sendInputError(ctx, error, 'این تغییر ثبت نشد.')
  }
}

// ───────────────────────────────────────────────────────── رندرها

/**
 * کیبوردِ پس از ثبت تغییر: بازگشت به همان صفحه‌ای که اقدام از آن آمده است.
 * حذف حساب، صفحهٔ بازیکن را از بین می‌برد پس به داشبورد برمی‌گردیم؛ اخطار و
 * پیام به همان پنل moderation برمی‌گردند تا شمار اخطارها تازه بماند.
 */
async function postChangeKeyboard(
  container: Container,
  adminId: bigint,
  action: string,
  target: bigint
): Promise<InlineKeyboard> {
  if (action.startsWith('admin_') || action === 'player_delete') {
    return buildAdminHomeKeyboard(await container.adminService.isOwner(adminId))
  }
  if (action === 'warning' || action === 'warning_revoke' || action === 'message') {
    try {
      const view = await container.adminService.getModerationView(adminId, target)
      return buildAdminModerationKeyboard(target, view.warnings)
    } catch (error) {
      logger.warn({ err: error, feature: 'admin', action: 'moderation_keyboard' }, 'moderation keyboard fell back')
      return buildAdminPlayerKeyboard(target)
    }
  }
  return buildAdminPlayerKeyboard(target)
}

function resultPanel(title: string, lines: string[]): string {
  return panel({ icon: '🛡️', title, sections: [{ lines }] })
}

function buildCloseKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text('بستن', 'panel:close').row()
}

function renderAdminPlayerPanel(player: {
  telegramUserId: bigint
  firstName: string
  lastName: string | null
  username: string | null
  gender: string
  age: number
  startedAt: Date | null
  balance: { toString(): string }
  health: number
  fatigue: number
  experience: number
  status: PlayerStatus
  activityState: string
  maritalStatus: string
  currentDegree: string
  graduationField: string | null
  isEnrolled: boolean
  enrolledFieldKey: string | null
  streakCount: number
  createdAt: Date
  lastActivityAt: Date | null
  homeGroup: { title: string; environmentLevel: keyof typeof ENVIRONMENT_LABELS } | null
  workSessions: Array<{ jobTitle: string; status: string }>
  skills: Array<{ level: number; skill: { name: string } }>
}): string {
  const session = player.workSessions[0]
  const jobLabel = !session
    ? 'نوبت کاری ثبت نشده'
    : session.status === 'ACTIVE'
      ? `${session.jobTitle} (در حال کار)`
      : `${session.jobTitle} (آخرین نوبت؛ فعال نیست)`
  const fieldTitle = player.enrolledFieldKey
    ? (EDUCATION_FIELDS.find((f) => f.key === player.enrolledFieldKey)?.title ?? null)
    : null

  return panel({
    icon: '👤',
    title: plainInput(`${player.firstName} ${player.lastName ?? ''}`.trim()),
    sections: [
      {
        title: 'هویت',
        rows: [
          { label: '🆔 شناسه', value: `\`${player.telegramUserId.toString()}\`` },
          { label: '🔗 نام کاربری', value: player.username ? `\`@${player.username}\`` : '—' },
          { label: '⚧ جنسیت', value: genderLabels[player.gender as Gender] ?? '—' },
          // سن با تقویم بازی — همان عددی که شناسنامه و آگهی‌های شغلی می‌بینند
          { label: '🎂 سن', value: `${fa(effectiveAge(player.startedAt, player.age))} سال` },
          {
            label: '🏠 منطقه',
            value: player.homeGroup
              ? `${plainInput(player.homeGroup.title)} (${ENVIRONMENT_LABELS[player.homeGroup.environmentLevel]})`
              : '—'
          }
        ]
      },
      {
        title: 'اقتصاد و تن',
        rows: [
          { label: '💰 موجودی', value: money(player.balance) },
          { label: '❤️ سلامت', value: `${fa(player.health)}٪` },
          { label: '⚡ خستگی', value: `${fa(player.fatigue)}٪` },
          { label: '⭐ تجربه', value: fa(player.experience) }
        ]
      },
      {
        title: 'شغل، تحصیل و حساب',
        rows: [
          { label: '💼 شغل', value: jobLabel },
          {
            label: '🎓 مدرک',
            value: degreeLabels[player.currentDegree as DegreeLevel] ?? 'نامشخص'
          },
          { label: '📚 در حال تحصیل', value: fieldTitle ?? '—' },
          { label: '🏅 فارغ‌التحصیل', value: player.graduationField ?? '—' },
          { label: '📌 فعالیت', value: label(activityStateLabels, player.activityState) },
          { label: '🚦 حساب', value: playerStatusAdminLabels[player.status] },
          {
            label: '💍 وضعیت تأهل',
            value: maritalStatusLabels[player.maritalStatus as MaritalStatus] ?? 'نامشخص'
          },
          { label: '🔥 استریک', value: fa(player.streakCount) },
          { label: '🕒 آخرین فعالیت', value: faDate(player.lastActivityAt) }
        ]
      },
      ...(player.skills.length > 0
        ? [
            {
              title: '🧠 مهارت‌ها',
              lines: player.skills.map((skill) => `• ${skill.skill.name} · سطح ${fa(skill.level)}`)
            } satisfies PanelSection
          ]
        : [])
    ]
  })
}

function renderAdminGroupPanel(group: {
  title: string
  telegramGroupId: bigint
  type: GroupType
  memberCount: number
  realMemberCount: number
  gamePopulation: number
  environmentLevel: keyof typeof ENVIRONMENT_LABELS
  status: GroupStatus
  createdAt: Date
  updatedAt: Date
}): string {
  return panel({
    icon: '🌐',
    title: plainInput(group.title),
    sections: [
      {
        title: 'اطلاعات گروه',
        rows: [
          { label: '🆔 شناسه', value: `\`${group.telegramGroupId.toString()}\`` },
          { label: '📦 نوع', value: group.type === GroupType.GROUP ? 'گروه' : 'سوپرگروه' },
          { label: '🏙️ سطح محیط', value: ENVIRONMENT_LABELS[group.environmentLevel] },
          { label: '👥 شهروندان بازی', value: fa(group.gamePopulation) },
          { label: '📱 اعضای تلگرام', value: fa(group.memberCount) },
          { label: '🧑 اعضای بدون ربات', value: fa(group.realMemberCount) },
          { label: '🚦 وضعیت', value: group.status === GroupStatus.ACTIVE ? 'فعال' : 'غیرفعال' },
          { label: '📅 ثبت‌شده از', value: faDate(group.createdAt) },
          { label: '🔄 آخرین همگام‌سازی', value: faDate(group.updatedAt) }
        ]
      },
      {
        lines: [
          '💡 سطح محیط از «شهروندان بازی» می‌آید: بازیکنانی که شخصیت ساخته‌اند و',
          'در همین منطقه عضویت فعال دارند. اعضای تلگرام فقط نمایش داده می‌شوند.',
          '«همگام‌سازی» شمار اعضا و فهرست مدیران را از تلگرام می‌خواند؛ اگر ربات',
          'ادمین آن گروه نباشد، عدد ذخیره‌شده حفظ می‌ماند.'
        ]
      }
    ]
  })
}

/** برچسب فارسی هر اقدام مدیریتی در گزارش. */
export const adminActionLabels: Record<string, string> = {
  admin_add: '➕ افزودن ادمین',
  admin_remove: '🗑️ حذف ادمین',
  balance_add: '💰 افزایش موجودی',
  balance_remove: '💸 کسر موجودی',
  set_balance: '🎯 تنظیم موجودی',
  set_health: '❤️ تنظیم سلامت',
  set_fatigue: '⚡ تنظیم خستگی',
  set_experience: '⭐ تنظیم تجربه',
  set_skill_level: '🧠 تنظیم سطح مهارت',
  set_account_status: '🚦 تغییر وضعیت حساب',
  set_degree: '🎓 تغییر مدرک',
  stop_education: '🎓 لغو تحصیل',
  stop_work: '⏹️ توقف نوبت کاری',
  reset_state: '♻️ بازنشانی وضعیت',
  reset_streak: '🔥 صفرکردن استریک',
  warning_issue: '⚠️ ثبت اخطار',
  warning_issue_auto_ban: '⛔ اخطار سوم و مسدودسازی خودکار',
  warning_revoke: '↩️ لغو اخطار',
  message_send: '✉️ پیام به بازیکن',
  report_reply: '📨 پاسخ به گزارش بازیکن',
  report_close: '📪 بستن گزارش بازیکن',
  player_delete: '🗑️ حذف حساب کاربری'
}

export function formatLogDetails(details: unknown): string {
  if (!details || typeof details !== 'object') return 'جزئیاتی ثبت نشده است.'
  const entry = details as Record<string, unknown>
  const display = (value: unknown): string => {
    if (typeof value === 'number') return fa(value)
    if (typeof value === 'boolean') return value ? 'بله' : 'خیر'
    if (typeof value !== 'string') return 'ثبت‌شده'
    return (
      playerStatusAdminLabels[value as PlayerStatus] ??
      degreeLabels[value as DegreeLevel] ??
      (/^[0-9.-]+$/.test(value)
        ? fa(Number(value))
        : /[\u0600-\u06ff]/.test(value)
          ? plainInput(value)
          : 'ثبت‌شده')
    )
  }
  if ('before' in entry && 'after' in entry)
    return `قبل: ${display(entry.before)}؛ بعد: ${display(entry.after)}`
  const names: Record<string, string> = {
    role: 'نقش',
    jobTitle: 'عنوان شغل',
    skill: 'مهارت',
    delta: 'مقدار تغییر',
    field: 'رشته',
    reason: 'دلیل',
    activeCount: 'اخطار فعال',
    banned: 'مسدود شد',
    length: 'اندازهٔ پیام',
    removedFunds: 'پول خارج‌شده',
    firstName: 'بازیکن'
  }
  const parts = Object.entries(entry)
    .filter(([key]) => names[key])
    .map(([key, value]) => `${names[key]}: ${display(value)}`)
  return parts.length ? parts.join('؛ ') : 'اقدام ثبت شده است.'
}

// ───────────────────────────────────────────────────────── گاردها

/** دسترسی ادمین؛ در نبود دسترسی فقط یک هشدار کوتاه و بدون افشای محتوا. */
async function guardAdmin(ctx: Context, container: Container, adminId: bigint): Promise<boolean> {
  if (await container.adminService.isAdmin(adminId)) {
    return true
  }
  logger.info({ userId: adminId.toString() }, 'unauthorized admin callback ignored')
  await ackCallback(ctx)
  return false
}

async function guardOwner(ctx: Context, container: Container, adminId: bigint): Promise<boolean> {
  if (await container.adminService.isOwner(adminId)) {
    return true
  }
  logger.info({ userId: adminId.toString() }, 'unauthorized owner callback ignored')
  await ackCallback(ctx, '⛔ این بخش فقط برای ادمین اصلی است.', true)
  return false
}

async function sendInputError(ctx: Context, error: unknown, fallback: string): Promise<void> {
  if (error instanceof AppError) {
    await sendPanel(ctx, {
      text: panel({
        icon: '⚠️',
        title: 'انجام نشد',
        sections: [{ lines: error.persianMessage.split('\n') }]
      }),
      keyboard: buildCloseKeyboard()
    })
    return
  }
  logger.error({ err: error, feature: 'admin', action: 'input' }, 'admin input failed')
  await sendPanel(ctx, {
    text: panel({
      icon: '⚠️',
      title: 'انجام نشد',
      sections: [{ lines: [fallback] }]
    }),
    keyboard: buildCloseKeyboard()
  })
}

async function showGroupSearch(
  ctx: Context,
  container: Container,
  actor: bigint,
  term: string
): Promise<void> {
  try {
    const result = await container.adminService.listGroups(actor, 0, term)
    await container.userStateRepository.upsert(actor, {
      currentContext: 'adm:group_search',
      stateData: { term, chatId: ctx.chat!.id }
    })
    await sendPanel(ctx, {
      text: panel({
        title: 'نتیجهٔ جست‌وجوی گروه',
        sections: [
          {
            lines: result.items.length
              ? result.items.map(
                  (g) => `• ${plainInput(g.title)} — \`${g.telegramGroupId.toString()}\``
                )
              : ['گروهی پیدا نشد. شناسه یا بخش دیگری از نام را جست‌وجو کن.']
          }
        ]
      }),
      keyboard: buildAdminGroupsKeyboard(
        result.items.map((g) => g.telegramGroupId),
        0,
        Math.max(1, Math.ceil(result.total / result.pageSize))
      )
    })
  } catch (error) {
    await sendInputError(ctx, error, 'جست‌وجوی گروه انجام نشد. دوباره تلاش کن.')
  }
}
