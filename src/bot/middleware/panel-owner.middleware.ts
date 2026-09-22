import type { Context, NextFunction } from 'grammy'
import type { Container } from '../../services/container'
import { ackCallback } from '../panel'

/** Telegram supplies reply_to_message; callback_data is never an ownership proof.
 * Private panels belong to the private chat. Group panels must reply to their actor.
 * Missing/deleted reply metadata fails closed, including help, close and admin panels.
 */
export function ownsPanel(ctx: Context): boolean {
  const message = ctx.callbackQuery?.message
  const actor = ctx.from?.id
  if (!message || !actor) return false
  if (message.chat.type === 'private') return message.chat.id === actor
  if (message.chat.type !== 'group' && message.chat.type !== 'supergroup') return false
  return 'reply_to_message' in message && message.reply_to_message?.from?.id === actor
}

export function panelOwnerMiddleware(container: Container) {
  return async (ctx: Context, next: NextFunction): Promise<void> => {
    const data = ctx.callbackQuery?.data
    if (!data) return next()
    // No visible response for non-admin actors, even on stale administrative
    // buttons. `ctx.from` can be absent (deleted account / channel post); in
    // that case the actor is not an admin and must simply be acked, not
    // crash the middleware (a crash here means the callback is never answered
    // and the Telegram spinner hangs).
    if (data.startsWith('adm:')) {
      const actorId = ctx.from?.id
      if (actorId === undefined || !(await container.adminService.isAdmin(BigInt(actorId)))) {
        await ackCallback(ctx)
        return
      }
    }
    if (!ownsPanel(ctx)) {
      await ackCallback(
        ctx,
        'این پنل متعلق به تو نیست یا پیام آغاز آن حذف شده است. کلمهٔ همین بخش را بفرست تا پنل خودت باز شود.',
        true
      )
      return
    }
    if (data.startsWith('reg:') && ctx.chat?.type !== 'private') {
      await ackCallback(
        ctx,
        'ساخت شخصیت فقط در چت خصوصی ربات انجام می‌شود. آنجا /start را بفرست.',
        true
      )
      return
    }
    await next()
  }
}
