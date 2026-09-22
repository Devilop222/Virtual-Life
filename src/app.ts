import './config/env'
import { config } from './config/env'
import { logger } from './utils/logger'
import { createBot, syncBotProfile } from './bot/bot'
import { startHealthServer } from './server/health.server'
import { prisma } from './database/client'
import type { Bot } from 'grammy'

/** رباتِ فعال برای `bot.stop()` در shutdown؛ بدون توقف polling، آپدیت‌ها
 *  حتی پس از قطع دیتابیس هم پردازش می‌شوند و خطای DB می‌گیرند. */
let activeBot: Bot | null = null
/** زمان‌بندِ خودکار — برای توقفش در خاموشیِ نرم (تا هیچ کاری روی اتصالِ بسته اجرا نشود). */
let autonomous: { stop(): void } | null = null

async function main(): Promise<void> {
  const { bot, container } = createBot()
  activeBot = bot

  const healthServer = startHealthServer()
  healthServer.listen(config.PORT, () => {
    logger.info(`Health server listening on port ${config.PORT}`)
  })

  try {
    await prisma.$connect()
    logger.info('Database connected')
  } catch (error) {
    logger.error({ err: error }, 'Database connection failed')
    throw error
  }

  // ادمین‌های اولیهٔ ربات (Idempotent) — دیتابیس منبع حقیقت دسترسی مدیریت است
  try {
    await container.adminService.bootstrap()
  } catch (error) {
    // نبود ادمین بازی را نمی‌خواباند؛ فقط لاگ می‌شود
    logger.error({ err: error }, 'admin bootstrap failed')
  }

  // ⚙️ چرخهٔ خودکار سرور — تنها زمان‌بندِ بازی.
  //
  // پیش از این اینجا یک `setInterval` شش‌ساعته بود که چند کار را دستی صدا
  // می‌زد؛ بقیهٔ تغییرهای زمان‌محور (پایان شیفتِ رهاشده، پایان تحصیل، ارتقای
  // سطح منطقه) هیچ‌وقت بدون باز شدن پنل اجرا نمی‌شدند. حالا همه از یک زمان‌بندِ
  // واحد رد می‌شوند و هر کار فاصلهٔ خودش را دارد.
  //
  // اولین تیک **بلافاصله** اجرا می‌شود و همین، Catch-up است: هر کاری از تفاضلِ
  // زمانی حساب می‌کند، پس هرچه در مدت خاموشی سررسید شده بود در همان بالا آمدن
  // پردازش می‌شود — بدون بازپخشِ تک‌تک دقیقه‌ها.
  container.autonomousService.start()
  autonomous = container.autonomousService
  logger.info(
    { jobs: container.autonomousService.jobNames() },
    'autonomous processing started'
  )

  logger.info('Starting bot with long polling...')
  await bot.start({
    onStart: async (botInfo) => {
      logger.info(`Bot @${botInfo.username} started`)
      // دستورهای مدیریتی در منوی ادمین‌های فعال (نه فقط مالک). اگر خواندن
      // فهرست شکست بخورد، پیش‌فرضِ امن (فقط مالک) اعمال می‌شود.
      const adminChatIds = await container.adminService
        .listActiveAdminTelegramIds()
        .catch(() => [])
      await syncBotProfile(bot, adminChatIds)
    }
  })
}

let shuttingDown = false

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return
  }
  shuttingDown = true

  logger.info(`Received ${signal}, shutting down gracefully...`)
  try {
    // اول زمان‌بند بمیرد: هیچ چرخهٔ تازه‌ای روی اتصالی که در حال بسته شدن است
    // شروع نشود.
    if (autonomous) {
      autonomous.stop()
      autonomous = null
    }
    // بعد polling تلگرام را متوقف کن: تا دیتابیس قطع نشده، آپدیت‌های در‌صف
    // خالی شوند و هیچ آپدیتی با `prisma.$disconnect()` شده روی مسیر کار نکند.
    // `stop()` در صورتی که ربات هرگز استارت نشده باشد هم بی‌خطر است.
    if (activeBot) {
      try {
        await activeBot.stop()
        logger.info('Bot stopped')
      } catch (error) {
        // توقف ربات هرگز نباید shutdown را شکست بدهد؛ دیتابیس باید قطع شود
        logger.warn({ err: error }, 'bot.stop() failed during shutdown')
      }
    }
    await prisma.$disconnect()
    process.exit(0)
  } catch (error) {
    logger.error({ err: error }, 'Error during shutdown')
    process.exit(1)
  }
}

process.once('SIGINT', () => void shutdown('SIGINT'))
process.once('SIGTERM', () => void shutdown('SIGTERM'))

main().catch((error: unknown) => {
  logger.error({ err: error }, 'Fatal error during startup')
  process.exit(1)
})
