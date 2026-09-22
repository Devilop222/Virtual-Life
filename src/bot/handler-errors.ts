import { Context } from 'grammy'
import { AppError } from '../utils/classes/errors'
import { logger } from '../utils/logger'
import { ackCallback, sendPanel } from './panel'

export interface HandlerErrorContext {
  /** بخش بازی، مثلاً occupation یا banking. */
  feature: string
  /** عملیات دقیق، مثلاً start_part_time. */
  action: string
  /** پیام کوتاه فارسی برای بازیکن وقتی خطا پیش‌بینی‌نشده است. */
  fallback: string
  /** زمینهٔ اضافی برای Log؛ هرگز داده حساس نفرست. */
  meta?: Record<string, string | number | boolean | undefined>
}

/**
 * ثبت خطای پیش‌بینی‌نشده با تمام زمینهٔ لازم برای عیب‌یابی.
 *
 * خطاهای دامنه (AppError) عمداً Log نمی‌شوند؛ آن‌ها بخشی از جریان
 * طبیعی بازی هستند (موجودی کافی نیست، ظرفیت پر است و…) و Log کردنشان
 * فقط نویز می‌سازد. فقط شناسه‌ها ثبت می‌شوند، نه محتوای پیام یا مبالغ.
 */
function logUnexpected(ctx: Context, error: unknown, context: HandlerErrorContext): void {
  logger.error(
    {
      err: error,
      errorType: error instanceof Error ? error.name : typeof error,
      feature: context.feature,
      action: context.action,
      callbackData: ctx.callbackQuery?.data,
      userId: ctx.from?.id,
      chatId: ctx.chat?.id,
      chatType: ctx.chat?.type,
      ...context.meta
    },
    `handler failed: ${context.feature}/${context.action}`
  )
}

/**
 * مدیریت یکدست خطای Callback.
 *
 * بازیکن یک پیام کوتاه و مرتبط با همان عملیات می‌بیند، نه یک متن
 * مبهم مشترک بین همهٔ دکمه‌ها. توسعه‌دهنده Log کامل می‌گیرد.
 */
export async function handleCallbackError(
  ctx: Context,
  error: unknown,
  context: HandlerErrorContext
): Promise<void> {
  if (error instanceof AppError) {
    await ackCallback(ctx, error.persianMessage, true)
    return
  }

  logUnexpected(ctx, error, context)
  await ackCallback(ctx, `${context.fallback} وضعیت بخش را به‌روزرسانی کن؛ اگر تغییری ثبت نشده بود، دوباره تلاش کن.`, true)
}

/** همان منطق برای دستورهای متنی که پاسخشان پیام است، نه Callback. */
export async function handleCommandError(
  ctx: Context,
  error: unknown,
  context: HandlerErrorContext
): Promise<void> {
  if (error instanceof AppError) {
    await sendPanel(ctx, { text: `⚠️ ${error.persianMessage}` })
    return
  }

  logUnexpected(ctx, error, context)
  await sendPanel(ctx, { text: `⚠️ ${context.fallback}\nوضعیت بخش را بررسی کن؛ اگر تغییری ثبت نشده بود، دوباره تلاش کن.` })
}
