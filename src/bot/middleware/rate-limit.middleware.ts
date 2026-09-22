import { Context, NextFunction } from 'grammy'

const lastUpdateAt = new Map<number, number>()
const MIN_INTERVAL_MS = 800
const MAX_MAP_SIZE = 10000
const TTL_MS = 60 * 1000

export function rateLimitMiddleware(): (ctx: Context, next: NextFunction) => Promise<void> {
  return async (ctx, next) => {
    if (!ctx.from) {
      await next()
      return
    }

    const userId = ctx.from.id
    const now = Date.now()
    const last = lastUpdateAt.get(userId) ?? 0

    if (now - last < MIN_INTERVAL_MS) {
      // به‌روزرسانی حذف می‌شود، اما کلیک دکمه باید حتماً پاسخ بگیرد؛ وگرنه
      // نشانگر لودینگ تلگرام برای کاربر تا ابد روشن می‌ماند.
      if (ctx.callbackQuery) {
        await ctx.answerCallbackQuery('درخواست‌ها خیلی سریع ارسال شدند. یک ثانیه صبر کن و دوباره دکمه را بزن.').catch(() => undefined)
      }
      return
    }

    if (lastUpdateAt.size > MAX_MAP_SIZE) {
      for (const [key, timestamp] of lastUpdateAt.entries()) {
        if (now - timestamp > TTL_MS) {
          lastUpdateAt.delete(key)
        }
      }
    }

    lastUpdateAt.set(userId, now)
    await next()
  }
}