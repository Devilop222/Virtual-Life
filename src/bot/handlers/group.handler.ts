import { Context } from 'grammy'
import { GameEventType, Group, GroupEnvironmentLevel, GroupStatus, GroupType } from '@prisma/client'
import { Container } from '../../services/container'
import {
  ENVIRONMENT_LABELS,
  environmentThresholdsText,
  playerGroupLabels
} from '../../modules/groups/group.service'
import { levelChangeDedupeKey, levelChangeEventTitle } from '../../modules/autonomous/autonomous.jobs'
import { panel, fa, faDate } from '../ui-kit'
import { groupSetupNote } from '../admin-help'
import { logger } from '../../utils/logger'

const GROUP_SYNC_COOLDOWN_MS = 60_000
/**
 * مهلت کوتاهِ تلاشِ دوباره پس از همگام‌سازی ناموفق.
 *
 * شکستِ ثبت گروه نباید همان ۶۰ ثانیهٔ عادی را قفل کند: پنل به کاربر می‌گوید
 * «یک بار دیگر /start را بفرست» و آن تلاش باید واقعاً ثبت را بیازماید. از طرفی
 * مهلت صفر هم درست نیست؛ با هر کلیدواژهٔ بازی یک جفت درخواست به تلگرام می‌رفت
 * (توفانِ درخواست روی گروهی که ربات از آن بیرون انداخته شده). عدد میانه:
 * ۱۰ ثانیه.
 */
const GROUP_SYNC_FAILURE_RETRY_MS = 10_000

/**
 * مهلت نگه‌داشتن نتیجهٔ «آیا این کاربر می‌تواند محیط بازی را راه بیندازد؟»
 *
 * بررسی ادمین یک تماس با تلگرام است؛ برای هر /start تکرارش عاقلانه نیست،
 * ولی کشِ طولانی هم پاسخِ واقعیت را کهنه می‌کند (ادمین تازه هنوز دسترسی
 * ندارد و برعکس). پنج دقیقه میانهٔ معقولی است.
 */
const SETUP_AUTH_CACHE_TTL_MS = 5 * 60_000
const MAX_SETUP_AUTH_CACHE = 2000
/** کاربر ناشناسِ ادمین گروه: پیام‌های ادمینِ ناشناس با این حساب فرستاده می‌شود. */
const TELEGRAM_ANONYMOUS_ADMIN_ID = 1087968824n

const MAX_SYNC_CACHE = 1000
const lastGroupSync = new Map<string, number>()
const setupAuthCache = new Map<string, { allowed: boolean; at: number }>()

export interface GroupContextResult {
  /** چت، گروه است؟ */
  isGroup: boolean
  /** ردیف گروه در دیتابیس وجود دارد؟ (منبع حقیقت وضعیت ثبت) */
  registered: boolean
  /** همین فراخوانی گروه را ساخته است؟ */
  created: boolean
  /** ردیف دیتابیس؛ همیشه وقتی `registered` باشد پر است. */
  group: Group | null
  environmentLevel: GroupEnvironmentLevel | null
  environmentLabel: string | null
  /** جمعیت از تلگرام خوانده شد یا از دیتابیس ماند؟ */
  memberCountSynced: boolean
  /** همگام‌سازی با تلگرام شکست خورد (ولی گروه از دیتابیس خوانده شد). */
  syncFailed: boolean
  /**
   * گروه ثبت نشده و فراخوانیِ فعلی حق راه‌اندازی‌اش را هم نداشته است.
   * تنها حالتی که بازی باید صریح بگوید «این محیط هنوز راه‌اندازی نشده».
   */
  needsSetup?: boolean
}

const NOT_A_GROUP: GroupContextResult = {
  isGroup: false,
  registered: false,
  created: false,
  group: null,
  environmentLevel: null,
  environmentLabel: null,
  memberCountSynced: false,
  syncFailed: false
}

/** پاکسازی حافظهٔ Cooldown تا در صدها گروه رشد بی‌نهایت نکند. */
function pruneSyncCache(): void {
  if (lastGroupSync.size <= MAX_SYNC_CACHE) return
  const cutoff = Date.now() - GROUP_SYNC_COOLDOWN_MS * 10
  for (const [key, ts] of lastGroupSync.entries()) {
    if (ts < cutoff) lastGroupSync.delete(key)
  }
}

/** پاکسازی حافظهٔ کش مجوز راه‌اندازی. */
function pruneSetupAuthCache(): void {
  if (setupAuthCache.size <= MAX_SETUP_AUTH_CACHE) return
  const cutoff = Date.now() - SETUP_AUTH_CACHE_TTL_MS * 2
  for (const [key, entry] of setupAuthCache.entries()) {
    if (entry.at < cutoff) setupAuthCache.delete(key)
  }
}

/**
 * آیا این کاربر مجاز به راه‌اندازی محیط بازی در این گروه است؟
 *
 * قانون محصول: فعال‌سازی محیط بازی یک اقدام مدیریتی است؛ کاربر عادی نباید
 * بتواند منطقه‌ای را ثبت کند. نتیجه منفی هم «بی‌احترامی» نیست؛ پیام راه‌اندازی
 * به او می‌گوید یکی از مدیران گروه باید /start را بفرستد.
 *
 * خطای تلگرام (مثلاً ربات هنوز ادمین نشده و فهرست اعضا را نمی‌بیند) منجر به
 * «مجاز نیست» می‌شود؛ این محافظه‌کاری عمدی است و پیام نهایی هرگز نمی‌گوید
 * «تو ادمین نیستی» — فقط می‌گوید راه‌اندازی هنوز انجام نشده.
 */
export async function isGroupSetupAuthorized(
  api: { getChatMember: (chatId: string, userId: number) => Promise<{ status: string }> },
  chatId: bigint,
  userId: bigint
): Promise<boolean> {
  // ادمین ناشناس گروه همیشه مجاز است؛ هویت واقعی‌اش در تلگرام پنهان می‌ماند
  // و getChatMember برای آن پاسخ معناداری نمی‌دهد.
  if (userId === TELEGRAM_ANONYMOUS_ADMIN_ID) {
    return true
  }

  const key = `${chatId}:${userId}`
  const cached = setupAuthCache.get(key)
  if (cached && Date.now() - cached.at <= SETUP_AUTH_CACHE_TTL_MS) {
    return cached.allowed
  }

  let allowed = false
  try {
    const member = await api.getChatMember(chatId.toString(), Number(userId))
    allowed = member.status === 'creator' || member.status === 'administrator'
  } catch (error) {
    logger.debug({ err: error, groupId: chatId.toString() }, 'group setup admin check failed')
    allowed = false
  }

  setupAuthCache.set(key, { allowed, at: Date.now() })
  pruneSetupAuthCache()
  return allowed
}

/** وضعیت ذخیره‌شدهٔ گروه در دیتابیس، بدون تماس با تلگرام. */
async function fromDatabase(
  container: Container,
  telegramGroupId: bigint,
  extra: Partial<GroupContextResult> = {}
): Promise<GroupContextResult> {
  // «ردیفی پیدا نشد» با «نتوانستیم بخوانیم» یکی نیست؛ syncFailed فقط از
  // نتیجهٔ واقعی خواندن می‌آید تا خطای موقت دیتابیس هرگز «ثبت نشده» جلوه نکند.
  let readFailed = false
  const group = await container.groupRepository
    .findByTelegramGroupId(telegramGroupId)
    .catch((error: unknown) => {
      logger.warn({ err: error, groupId: telegramGroupId.toString() }, 'group lookup failed')
      readFailed = true
      return null
    })

  return {
    isGroup: true,
    registered: group !== null,
    created: false,
    group,
    environmentLevel: group?.environmentLevel ?? null,
    environmentLabel: group ? ENVIRONMENT_LABELS[group.environmentLevel] : null,
    memberCountSynced: false,
    syncFailed: readFailed,
    ...extra
  }
}

/**
 * ثبت/همگام‌سازی گروه و بازگرداندن وضعیت واقعی آن.
 *
 * قواعد:
 *  ۱. منبع حقیقت، ردیف دیتابیس است — نه نتیجهٔ تماس با تلگرام. اگر
 *     تلگرام اطلاعات ندهد، گروه همچنان ثبت است و اطلاعات ذخیره‌شده نمایش داده
 *     می‌شود؛ هرگز «نامشخص» بی‌دلیل نشان داده نمی‌شود.
 *  ۲. ساختنِ گروه فقط یک اقدام مدیریتی است. گروهِ ثبت‌نشده فقط وقتی ساخته
 *     می‌شود که `setupByUserId` داده شده و آن کاربر در تلگرام مدیر/مالک گروه
 *     باشد؛ کلیدواژهٔ عادی بازیکن هرگز محیط تازه‌ای فعال نمی‌کند.
 *  ۳. گروهِ ثبت‌شده با همگام‌سازی مهارت‌دار (Cooldown یک‌دقیقه‌ای) تازه می‌شود.
 */
export async function handleGroupContext(
  ctx: Context,
  container: Container,
  options: { setupByUserId?: bigint } = {}
): Promise<GroupContextResult> {
  const chat = ctx.chat
  if (!chat || (chat.type !== 'group' && chat.type !== 'supergroup')) {
    return NOT_A_GROUP
  }

  const telegramGroupId = BigInt(chat.id)
  const groupType = chat.type === 'group' ? GroupType.GROUP : GroupType.SUPERGROUP
  const title = chat.title ?? 'بدون عنوان'

  const cacheKey = String(chat.id)
  const now = Date.now()
  const lastSync = lastGroupSync.get(cacheKey) ?? 0

  // آیا این فراخوانی یک تلاش راه‌اندازی بود؟ اگر راه‌اندازی وسطش شکست بخورد،
  // پاسخ باید «موقتاً نشد» باشد، نه «راه‌اندازی نشده» — این دو برای ادمینی که
  // همین حالا /start فرستاده پیام‌های کاملاً متفاوتی دارند.
  let setupAttempted = false

  // در پنجرهٔ Cooldown، وضعیت از دیتابیس خوانده می‌شود؛ نه تماس با تلگرام
  // و نه اعلام «ثبت ناموفق» برای گروهی که همین حالا ثبت شده است.
  // «syncFailed» را خودِ خواندن دیتابیس بر اساس نتیجهٔ واقعی پر می‌کند.
  if (now - lastSync <= GROUP_SYNC_COOLDOWN_MS) {
    return fromDatabase(container, telegramGroupId)
  }

  // گروه از قبل در دیتابیس هست؟ اگر نباشد، این یک «تلاشِ راه‌اندازی» است و
  // فقط برای ادمینِ گروه انجام می‌شود. این خواندن ارزان است و جایگزین
  // رفتار قدیمیِ «هر کلیدواژه‌ای گروه را از دم ثبت می‌کرد» می‌شود.
  const existing = await container.groupRepository
    .findByTelegramGroupId(telegramGroupId)
    .catch((error: unknown) => {
      logger.warn({ err: error, groupId: telegramGroupId.toString() }, 'group lookup failed')
      return null
    })

  if (!existing) {
    const setupUserId = options.setupByUserId
    const authorized = setupUserId
      ? await isGroupSetupAuthorized(ctx.api, telegramGroupId, setupUserId)
      : false

    if (!authorized) {
      // هیچ نوشتاری انجام نمی‌شود؛ Cooldown هم ست نمی‌شود تا تلاشِ بعدیِ
      // ادمین بلافاصله امکان‌پذیر باشد.
      return {
        ...NOT_A_GROUP,
        needsSetup: true
      }
    }
    setupAttempted = true
  }

  lastGroupSync.set(cacheKey, now)
  pruneSyncCache()

  try {
    const syncResult = await container.groupService.ensureGroupUpdated({
      telegramGroupId,
      title,
      type: groupType
    })
    const { created, environmentChanged, memberCountSynced } = syncResult
    let group = syncResult.group

    if (ctx.from) {
      await container.groupService
        .linkPlayerToGroup(BigInt(ctx.from.id), telegramGroupId)
        .catch(() => {
          // بازیکن ممکن است هنوز ثبت‌نام نکرده باشد؛ بی‌خطر نادیده گرفته می‌شود
        })
    }

    // جمعیتِ همان لحظه: پیوستنِ همین بازیکن می‌تواند منطقه را یک پله بالا ببرد.
    // سطح از شمارِ شهروندانِ *ثبت‌شده* می‌آید، پس بازمحاسبه فقط بعد از پیوند
    // معنا دارد. خطای این گام نباید کل همگام‌سازی را بشکند.
    const refresh = await container.groupService
      .refreshEnvironmentLevel(group.id)
      .catch((error: unknown) => {
        logger.warn({ err: error, groupId: group.id }, 'environment refresh failed')
        return null
      })
    const levelChangedFrom = refresh?.levelChangedFrom ?? syncResult.levelChangedFrom
    const levelChangedAt = refresh?.levelChangedAt ?? syncResult.levelChangedAt
    if (refresh) {
      group = {
        ...group,
        gamePopulation: refresh.gamePopulation,
        environmentLevel: refresh.environmentLevel
      }
    }

    // رخدادهای خبری منطقه
    if (created) {
      await container.eventService
        .recordRegionEvent({
          groupId: group.id,
          type: GameEventType.REGION_REGISTERED,
          title: `منطقهٔ «${group.title}» به دنیای بازی پیوست`,
          dedupeKey: `region-registered:${group.id}`,
          priority: 5
        })
        .catch(() => {})
    } else if ((environmentChanged || levelChangedFrom !== null) && levelChangedFrom && levelChangedAt) {
      // خبر با همان شکل و همان کلیدِ چرخهٔ خودکار ثبت می‌شود: کلید، **مهرِ همین
      // تغییر** را در خود دارد (نه سطحِ مقصد) تا هم دو نوشتنِ هم‌زمانِ یک تغییر
      // یک خبر بسازند و هم تغییرِ بعدیِ همان منطقه بی‌خبر نماند.
      const change = {
        groupId: group.id,
        groupTitle: group.title,
        from: levelChangedFrom,
        to: group.environmentLevel,
        population: group.gamePopulation,
        ownerTelegramUserId: group.ownerTelegramUserId,
        at: levelChangedAt.toISOString()
      }
      await container.eventService
        .recordRegionEvent({
          groupId: group.id,
          type: GameEventType.REGION_LEVEL_CHANGED,
          title: levelChangeEventTitle(change),
          dedupeKey: levelChangeDedupeKey('region-level', change),
          priority: 5
        })
        .catch(() => {})
    }

    return {
      isGroup: true,
      registered: true,
      created,
      group,
      environmentLevel: group.environmentLevel,
      environmentLabel: ENVIRONMENT_LABELS[group.environmentLevel],
      memberCountSynced,
      syncFailed: false
    }
  } catch (error) {
    logger.warn({ err: error, groupId: chat.id }, 'Failed to sync group info')
    // Cooldown را به مهلتِ کوتاهِ تلاشِ دوباره کاهش می‌دهیم (نه حذف کامل)
    lastGroupSync.set(cacheKey, Date.now() - (GROUP_SYNC_COOLDOWN_MS - GROUP_SYNC_FAILURE_RETRY_MS))
    pruneSyncCache()
  }

  // همگام‌سازی شکست؛ ولی این به معنی «گروه ثبت نیست» نیست. تنها اگر خودِ
  // راه‌اندازی وسطش شکست بخورد، «موقتاً نشد» گزارش می‌شود تا ادمینی که
  // همین حالا /start فرستاده پیامِ گمراه‌کنندهٔ «راه‌اندازی نشده» نبیند.
  if (setupAttempted) {
    return fromDatabase(container, telegramGroupId, { syncFailed: true })
  }
  return fromDatabase(container, telegramGroupId)
}

/**
 * پنل «این محیط هنوز راه‌اندازی نشده» — تنها حالتی که بازی صریح می‌گوید
 * محیط بازی فعال نیست؛ همراه با راهِ حل (اقدام مدیر گروه)، نه متن فنی.
 */
export function renderGroupNotSetupPanel(syncFailed = false): string {
  if (syncFailed) {
    return panel({
      icon: '🌍',
      title: 'منطقهٔ بازی',
      sections: [
        {
          lines: ['خواندن اطلاعات این گروه انجام نشد.', 'کمی بعد دوباره /start را بفرست.']
        }
      ]
    })
  }

  return panel({
    icon: '🌍',
    title: 'راه‌اندازی نشده',
    sections: [
      {
        lines: [
          'این گروه هنوز برای بازی راه‌اندازی نشده است.',
          '',
          'برای فعال‌سازی بازی در این گروه، یکی از مدیران گروه',
          'باید یک بار /start را بفرستد.'
        ]
      }
    ],
    footer: '💡 بعد از راه‌اندازی، همین‌جا می‌توانی با کلمه‌های بازی وارد محیط شوی.'
  })
}

/**
 * پنل اطلاعات گروه — همیشه از ردیف دیتابیس خوانده می‌شود.
 * «سطح محیط» هیچ‌وقت خالی نمی‌ماند؛ اگر گروه ثبت نشده باشد صراحتاً گفته می‌شود.
 */
export function renderGroupInfoPanel(result: GroupContextResult): string {
  const group = result.group

  if (!group) {
    // «ردیفی پیدا نشد» با «نتوانستیم بخوانیم» یکی نیست. اعلام «ثبت نشده» روی
    // یک خطای موقت دیتابیس، اطلاعات غلط می‌دهد و کاربر را به /start بیهوده می‌فرستد.
    return renderGroupNotSetupPanel(result.syncFailed)
  }

  const sections: Parameters<typeof panel>[0]['sections'] = [
    {
      title: 'اطلاعات گروه',
      rows: [
        { label: '🏷️ نام', value: group.title },
        { label: '🆔 شناسهٔ گروه', value: `\`${group.telegramGroupId.toString()}\`` },
        {
          label: '🏙️ سطح محیط',
          value: ENVIRONMENT_LABELS[group.environmentLevel]
        },
        { label: '👥 شهروندان بازی', value: `${fa(group.gamePopulation)} نفر` },
        { label: '📱 اعضای تلگرام', value: `${fa(group.realMemberCount)} نفر` },
        {
          label: '🚦 وضعیت',
          value: group.status === GroupStatus.ACTIVE ? 'فعال' : 'غیرفعال'
        },
        { label: '📅 ثبت‌شده از', value: faDate(group.createdAt) }
      ]
    },
    {
      title: 'سطح محیط از کجا می‌آید؟',
      lines: [
        'بر پایهٔ شمار شهروندان بازی؛ یعنی کسانی که شخصیت ساخته‌اند و',
        'در این منطقه عضویت فعال دارند. اعضای تلگرام فقط نمایش داده می‌شوند',
        'و در تعیین سطح نقشی ندارند.',
        environmentThresholdsText(),
        '',
        '🎯 با هر شهروند تازه، سطح همین‌جا خودکار به‌روز می‌شود.'
      ]
    }
  ]

  return panel({
    icon: '🌍',
    title: 'منطقهٔ بازی',
    sections,
    footer:
      result.created === true
        ? '🎉 این گروه همین حالا به دنیای بازی پیوست.'
        : '💡 برای دیدن بخش‌های بازی، کلمهٔ هر بخش را بفرست (مثلاً «کار»).'
  })
}

/** نقش محلی بازیکن در این گروه، اگر ثبت‌نام کرده و نقش دارد. */
export function localRoleLine(
  roleLabel: string | null,
  level: GroupEnvironmentLevel | null
): string | null {
  if (!roleLabel || !level) return null
  return `🎖️ نقش محلی تو در این منطقه: ${roleLabel} (${ENVIRONMENT_LABELS[level]})`
}

/** برچسب نقش از نگاشت مشترک؛ برای نمایش در پنل گروه. */
export function roleLabelOf(role: string): string {
  return playerGroupLabels[role as keyof typeof playerGroupLabels] ?? role
}

/**
 * پنلِ لحظهٔ ثبت منطقه — همان چیزی که کل گروه می‌بینند.
 *
 * (نکتهٔ یک‌بارهٔ راه‌اندازی در `admin-help.ts` است: مخاطبش ثبت‌کنندهٔ گروه در
 * چت خصوصی است، نه گروه.)
 *
 * عمداً هیچ دانشِ پیکربندیِ ربات در آن نیست؛ نکتهٔ راه‌اندازی جدا و در چت
 * خصوصیِ ثبت‌کنندهٔ گروه می‌رود (`groupSetupNote`).
 */
export function renderNewRegionPanel(result: GroupContextResult): string {
  return panel({
    icon: '🌍',
    title: 'منطقهٔ تازهٔ بازی',
    sections: [
      {
        lines: [
          '✅ این گروه به دنیای بازی پیوست و به‌عنوان یک منطقه ثبت شد.',
          `🏙️ سطح محیط · ${result.environmentLabel}`,
          `👥 شهروندان · ${fa(result.group?.gamePopulation ?? 0)} نفر`
        ]
      },
      {
        title: 'چطور بازی کنم؟',
        lines: [
          '💡 بازی کاملاً متنی است؛ کافی است کلمهٔ هر بخش را بفرستی:',
          '🪪 شناسنامه   💼 کار   🎓 تحصیل   🏠 خانه',
          '🏦 بانک   🛒 فروشگاه   🏆 رتبه   🎯 مأموریت',
          '🏙️ شهر   📰 خبر   📊 آمار   🗂️ تاریخچه'
        ]
      }
    ],
    footer: '❓ برای راهنمای کامل، کلمهٔ «راهنما» را بفرست.'
  })
}

export function registerGroupHandlers(bot: import('grammy').Bot, container: Container): void {
  bot.on('my_chat_member', async (ctx) => {
    const status = ctx.myChatMember?.new_chat_member.status
    if (status !== 'member' && status !== 'administrator') {
      return
    }

    // افزودن ربات به گروه در تنظیم پیش‌فرض تلگرام کارِ مدیر است؛ اما گروه‌هایی
    // که «افزودن ربات برای اعضا» را باز گذاشته‌اند استثنا هستند. پس هویت
    // کنشنده بررسی می‌شود؛ کاربر عادی محیط بازی را فعال نمی‌کند.
    const actorId = ctx.myChatMember?.from?.id
    const result = await handleGroupContext(ctx, container, {
      setupByUserId: actorId === undefined ? undefined : BigInt(actorId)
    })
    if (!result.registered) {
      if (result.syncFailed) return
      await ctx
        .reply(
          panel({
            icon: '🌍',
            title: 'راه‌اندازی نشده',
            sections: [
              {
                lines: [
                  'این گروه هنوز برای بازی راه‌اندازی نشده است.',
                  'برای فعال‌سازی، یکی از مدیران گروه باید /start را بفرستد.'
                ]
              }
            ]
          }),
          { parse_mode: 'Markdown' }
        )
        .catch(() => {})
      return
    }

    // ربات تازه اضافه شده: معرفی کوتاه. اگر گروه از قبل ثبت بوده، همان
    // اطلاعات واقعی نمایش داده می‌شود، نه پیام «ثبت شد».
    const text = result.created ? renderNewRegionPanel(result) : renderGroupInfoPanel(result)

    await ctx.reply(text, { parse_mode: 'Markdown' }).catch(() => {})

    // نکتهٔ راه‌اندازی فقط در چت خصوصیِ همان کسی می‌رود که ربات را اضافه کرده:
    // تنها او به BotFather دسترسی دارد، و چتِ گروهیِ بازیکنان جای دانشِ
    // پیکربندی ربات نیست. شکست ارسال (کاربر خصوصی را استارت نکرده) بی‌صدا است.
    if (result.created && actorId !== undefined) {
      await ctx.api
        .sendMessage(actorId, groupSetupNote(), { parse_mode: 'Markdown' })
        .catch(() => {})
    }
  })
}
