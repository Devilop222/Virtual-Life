/**
 * دروازهٔ مالکِ ربات — تنها نگهبانِ مسیرهای مدیریتی.
 *
 * ## چرا سرور-ساید و چرا یک‌جا؟
 * این دروازه پیش‌تر درونِ هندلرِ استقرار بود و اکنون دو مصرف‌کننده دارد. نگهبانِ
 * امنیتیِ تکراری یعنی روزی که یکی اصلاح شود و دیگری نه؛ پس یک پیاده‌سازی و
 * یک منبعِ حقیقت.
 *
 * شناسه از `ctx.from.id` می‌آید که **تلگرام امضا کرده است**، پس قابل جعل
 * نیست — برخلاف `callback_data` که کاربر می‌تواند هرچه بخواهد بفرستد. سنجش
 * دوباره در هر مسیر (هم باز کردنِ پنل، هم هر دکمهٔ اجرا) عمدی است: بین دیدنِ
 * صفحهٔ تأیید و زدنِ دکمه، نقشِ کاربر می‌تواند عوض شود.
 *
 * پاسخ به غیرمالک عمداً بی‌جزئیات است: وجودِ چنین پنلی نباید برای کسی که
 * دسترسی ندارد آشکار شود.
 */
import type { Context } from 'grammy'
import type { Container } from '../services/container'
import { ackCallback } from './panel'

export type OwnerGate = { ok: true; id: bigint } | { ok: false }

/** همان قراردادِ نگهبان، برای مسیرهایی که ادمینِ فعال هم مجاز است. */
export type AdminGate = OwnerGate

export async function requireOwner(ctx: Context, container: Container): Promise<OwnerGate> {
  const fromId = ctx.from?.id
  if (fromId === undefined) {
    await ackCallback(ctx, 'این کنش مجاز نیست.', true)
    return { ok: false }
  }
  const id = BigInt(fromId)
  if (!(await container.adminService.isOwner(id))) {
    await ackCallback(ctx, 'این بخش در دسترس تو نیست.', true)
    return { ok: false }
  }
  return { ok: true, id }
}

/**
 * نگهبانِ «ادمینِ فعال» — برای مسیرهایی که یک ادمینِ مجاز هم باید بتواند
 * کاری انجام دهد (مثل مدیریت بکاپ دیتابیس) ولی مالکِ ربات لازم نیست.
 *
 * دو تفاوت مهم با `requireOwner`:
 *  • منبعِ حقیقت همان جدولِ `bot_admins` است؛ پس هر کسی که در پنل مدیریت
 *    ادمین شده باشد، بدون تغییر کد دسترسی می‌گیرد.
 *  • پیامِ رد شدن برای هر دو یکسان و بی‌جزئیات است: کسی که دسترسی ندارد
 *    نباید بفهمد چه پنلی وجود دارد.
 */
export async function requireAdmin(ctx: Context, container: Container): Promise<AdminGate> {
  const fromId = ctx.from?.id
  if (fromId === undefined) {
    await ackCallback(ctx, 'این کنش مجاز نیست.', true)
    return { ok: false }
  }
  const id = BigInt(fromId)
  if (!(await container.adminService.isAdmin(id))) {
    await ackCallback(ctx, 'این بخش در دسترس تو نیست.', true)
    return { ok: false }
  }
  return { ok: true, id }
}

/**
 * پنلِ مدیریتی فقط در چت خصوصی.
 *
 * فرمانی که سرور را خاموش می‌کند یا داده را بازمی‌گرداند، جای درستی در گروه
 * ندارد — حتی اگر فرستنده مالک باشد: در گروه، پیام‌ها دیده می‌شوند و
 * دکمه‌های پنل ممکن است توسط دیگران لمس شوند.
 */
export function isPrivateChat(ctx: Context): boolean {
  return (ctx.chat?.type ?? '') === 'private'
}
