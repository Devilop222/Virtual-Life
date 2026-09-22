import { Bot } from 'grammy'
import { config } from '../config/env'
import { buildContainer, Container } from '../services/container'
import { createTelegramMemberInfoProvider } from './member-info.provider'
import { attachErrorHandler } from './middleware/error.middleware'
import { rateLimitMiddleware } from './middleware/rate-limit.middleware'
import { registerChatPolicy } from './chat-policy'
import { registerStartHandler } from './handlers/start.handler'
import { registerGroupHandlers } from './handlers/group.handler'
import { registerTextHandlers } from './handlers/text.handler'
import { registerExpansionHandlers } from './handlers/expansion.handler'
import { registerFeatureHandlers } from './handlers/features.handler'
import { registerWillHandlers } from './handlers/will.handler'
import { registerAdminHandlers } from './handlers/admin.handler'
import { registerDeployHandlers } from './handlers/deploy.handler'
import { registerOpsHandlers } from './handlers/ops.handler'
import { ackCallback } from './panel'
import { panelOwnerMiddleware } from './middleware/panel-owner.middleware'
import { logger } from '../utils/logger'
import { registerPushSender } from '../modules/notification/push'
import { registerConfirmationHandlers } from './confirm-action'
import { registerConfirmableActions } from './confirmations'
import { isParseError } from './panel'
import { PRIMARY_OWNER_TELEGRAM_ID } from '../modules/admin/admin.service'

export interface BotContext {
  bot: Bot
  container: Container
}

/**
 * همگام‌سازی هویت ربات در تلگرام: منوی دستورها، نام و توضیح کوتاه.
 * نام رسمی برند از `config/brand.ts` می‌آید (یک منبع حقیقت).
 * خطای شبکه در این مرحله فقط لاگ می‌شود؛ ربات بدون آن هم کار می‌کند.
 */
export async function syncBotProfile(
  bot: Bot,
  /**
   * چت‌هایی که دستورهای مدیریتی در منوی‌شان نشان داده می‌شود.
   *
   * پیش‌فرض (خالی) یعنی فقط مالکِ اصلی — رفتارِ پیشین. `app.ts` فهرستِ
   * ادمین‌های فعال را از دیتابیس می‌دهد تا ادمینِ تازه هم `/admin_help` را
   * در منوی خودش ببیند؛ بدون این، دستور برای او «وجود دارد ولی پیدا نمی‌شود».
   */
  adminChatIds: readonly bigint[] = []
): Promise<void> {
  const { BRAND } = await import('../config/brand')
  try {
    await Promise.all([
      // منوی عمومی فقط دستورهای بازیکن.
      //
      // `admin_help` اینجا نیست: `setMyCommands` بدون scope، فهرست را برای
      // **همهٔ** کاربرها منتشر می‌کند و یک دستور مدیریتی را به چشمِ بازیکن
      // می‌آورد. دستور سر جایش می‌ماند و هندلر/دسترسی‌اش دست‌نخورده است —
      // فقط در منوی عمومی دیده نمی‌شود.
      bot.api.setMyCommands([{ command: 'start', description: 'آغاز یا ازسرگیری بازی' }]),
      bot.api.setMyName(BRAND.name),
      bot.api.setMyShortDescription(`${BRAND.nameFa} — بازی زندگی در تلگرام. هر تصمیمت یک رد می‌گذارد.`),
      bot.api.setMyDescription(
        `به ${BRAND.nameFa} خوش آمدی. یک شخصیت می‌سازی؛ کار، تحصیل، ازدواج، کسب‌وکار و جایگاهت در شهر، همه از انتخاب‌های تو رشد می‌کنند.`
      )
    ])
  } catch (error) {
    logger.warn({ err: error }, 'bot profile sync failed (commands/description)')
  }
  await syncAdminCommands(bot, adminChatIds)
}

/**
 * دستور مدیریتی، فقط در چت خصوصیِ ادمین‌های فعال.
 *
 * Telegram دامنهٔ دستورها را با `BotCommandScopeChat` پشتیبانی می‌کند؛ این
 * همان ابزارِ رسمیِ «دستور برای یک نفر» است و از انتشارِ یک دستور مدیریتی در
 * منوی همهٔ بازیکنان جلوگیری می‌کند. شکستش چیزی را نمی‌شکند: ادمین می‌تواند
 * دستور را دستی بنویسد (هندلر و دسترسی‌اش سر جایشان هستند).
 */
async function syncAdminCommands(bot: Bot, adminChatIds: readonly bigint[]): Promise<void> {
  const targets = adminChatIds.length > 0 ? adminChatIds : [PRIMARY_OWNER_TELEGRAM_ID]
  await Promise.all(
    targets.map((chatId) =>
      bot.api
        .setMyCommands([{ command: 'admin_help', description: 'راهنمای مدیریت' }], {
          scope: { type: 'chat', chat_id: Number(chatId) }
        })
        .catch((error: unknown) => {
          logger.warn({ err: error }, 'admin command scope not applied')
        })
    )
  )
}

export function createBot(): BotContext {
  const bot = new Bot(config.BOT_TOKEN)

  const memberInfoProvider = createTelegramMemberInfoProvider(bot.api)
  const container = buildContainer(memberInfoProvider)

  // اعلان‌های مهم (دریافت پول، نتیجهٔ درخواست، ازدواج…) به چت خصوصی بازیکن
  // می‌روند. شکستِ تحویل (بلاک‌بودن ربات یا استارت‌نشدنِ خصوصی) بی‌صداست و
  // اعلان از راه تختهٔ «اعلان‌ها» قابل خواندن می‌ماند.
  registerPushSender(async (telegramUserId, text) => {
    try {
      await bot.api.sendMessage(telegramUserId.toString(), text, { parse_mode: 'Markdown' })
    } catch (error) {
      if (isParseError(error)) {
        await bot.api.sendMessage(telegramUserId.toString(), text)
        return
      }
      throw error
    }
  })

  attachErrorHandler(bot)
  bot.use(panelOwnerMiddleware(container))
  bot.use(rateLimitMiddleware())
  registerChatPolicy(bot, container)

  // عملیات حساس پشتِ یک لایهٔ تأیید مشترک (تک‌مصرف و replay-safe)
  registerConfirmableActions()
  registerConfirmationHandlers(bot, container)

  registerStartHandler(bot, container)
  registerGroupHandlers(bot, container)
  registerTextHandlers(bot, container)
  registerExpansionHandlers(bot, container)
  registerFeatureHandlers(bot, container)
  registerWillHandlers(bot, container)
  registerAdminHandlers(bot, container)
  // مرکز کنترلِ مالک آخر ثبت می‌شود تا هیچ middleware یا handler دیگری
  // `/botupdate` را نبلعد و `op:*` زودتر از بقیه گرفته شود؛ دسترسی‌اش هم پیش
  // از هر کاری سرور-ساید سنجیده می‌شود.
  registerOpsHandlers(bot, container)
  registerDeployHandlers(bot, container)
  bot.on('callback_query:data', async (ctx) => {
    await ackCallback(ctx, 'این دکمه دیگر قابل استفاده نیست. کلمهٔ همین بخش را دوباره بفرست تا پنل تازه باز شود.', true)
  })

  bot.on('message', async (ctx, next) => {
    logger.debug(
      {
        chatId: ctx.chat.id,
        chatType: ctx.chat.type,
        userId: ctx.from?.id
      },
      'Telegram message handled'
    )
    await next()
  })

  return { bot, container }
}