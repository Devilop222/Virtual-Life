/**
 * ورودیِ راهنما — تصمیمِ «تازه‌وارد یا بازیکن» در یک نقطه.
 *
 * ## چرا یک فایل؟
 * راهنما چهار نقطهٔ ورود دارد (پیام متنی، دو Callback، و پیامِ وسطِ ثبت‌نام).
 * اگر هر کدام خودش وضعیت را بسنجد، دیر یا زود یکی از آن‌ها فراموش می‌شود و
 * بازیکنی که سال‌ها بازی کرده دوباره آموزشِ «ساخت شخصیت» می‌بیند. یک تابع،
 * یک قاعده: **میان‌برِ تازه‌کار فقط برای کسی که هنوز شخصیت ندارد.**
 *
 * خطای خواندن = «بازیکنِ فعال» فرض می‌شود، چون نشان‌دادنِ آموزشِ ساختِ
 * شخصیت به بازیکنِ موجود بدتر از برعکسش است. همین قاعده در نبودِ مخزنِ
 * بازیکن (ساختِ سبک/تستی) هم حاکم است.
 */
import type { InlineKeyboard } from 'grammy'
import type { Container } from '../services/container'
import { buildHelpMainKeyboard } from './keyboards/main.keyboard'

/** آیا این کاربر هنوز شخصیتی نساخته؟ */
export async function isNewcomer(
  container: Container,
  telegramUserId: bigint
): Promise<boolean> {
  // `undefined` یعنی «مخزن در دسترس نیست» و با نبودِ بازیکن (`null`) یکی نیست.
  const player = await container.playerRepository
    ?.findByTelegramUserId(telegramUserId)
    .catch(() => null)
  return player === null
}

/** کیبوردِ صفحهٔ اصلیِ راهنما، متناسب با وضعیتِ همین کاربر. */
export async function helpMainKeyboardFor(
  container: Container,
  telegramUserId: bigint
): Promise<InlineKeyboard> {
  return buildHelpMainKeyboard({ newcomer: await isNewcomer(container, telegramUserId) })
}
