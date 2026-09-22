import { Bot, Context } from 'grammy'
import { logger } from '../../utils/logger'
import { AppError } from '../../utils/classes/errors'
import { ackCallback, sendPanel } from '../panel'

async function replyPersianError(ctx: Context, persianMessage: string): Promise<void> {
  try {
    if (ctx.callbackQuery) await ackCallback(ctx, persianMessage, true)
    else await sendPanel(ctx, { text: persianMessage })
  } catch {
    logger.warn('Failed to send error message to user')
  }
}

export function attachErrorHandler(bot: Bot): void {
  bot.catch(async (err) => {
    const ctx = err.ctx
    const error = err.error

    if (ctx) {
      logger.error(
        { updateId: ctx.update.update_id, chatId: ctx.chat?.id, userId: ctx.from?.id },
        'Telegram update failed'
      )
    }

    if (error instanceof AppError) {
      logger.warn({ type: error.constructor.name, message: error.message }, 'Operational error')
      if (ctx) {
        await replyPersianError(ctx, error.persianMessage)
      }
      return
    }

    logger.error({ err: error }, 'Unhandled error in bot pipeline')
    if (ctx) {
      await replyPersianError(ctx, 'نتیجهٔ درخواست مشخص نشد. وضعیت همین بخش را به‌روزرسانی کن؛ اگر تغییری ثبت نشده بود، دوباره تلاش کن.')
    }
  })
}