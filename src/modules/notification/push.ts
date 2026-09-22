import { logger } from '../../utils/logger'

/**
 * تحویل اعلان به بازیکن — تنها نقطهٔ تصمیم «این اتفاق را چطور به بازیکن بگوییم».
 *
 * چهار سطح، با قرارداد صریح:
 *  • CRITICAL      — اتفاقِ پولی/حقوقیِ قطعی. همیشه: تختهٔ اعلان + پیام خصوصی.
 *  • IMPORTANT     — اتفاق مهمِ گیم‌پلی. معمولاً: تختهٔ اعلان + پیام خصوصی.
 *  • INFORMATIONAL — خوب است بداند. فقط تختهٔ اعلان (بدون مزاحمت در چت).
 *  • INTERNAL      — داخلی. نه تخته، نه پیام؛ فقط لاگ.
 *
 * چرا جدا از `NotificationService`؟ سرویس‌ها به `Bot` دسترسی ندارند و نباید
 * داشته باشند. اینجا یک فرستندهٔ ثبت‌شدنی نگه می‌داریم که `bot.ts` پر می‌کند؛
 * اگر فرستنده‌ای ثبت نشده باشد (تست، اسکریپت، یا بازیکنی که هرگز ربات را
 * استارت نکرده) اعلان **گم نمی‌شود**: ردیفِ تخته همان‌جا نوشته می‌شود و
 * بازیکن دفعهٔ بعد در «اعلان‌ها» می‌بیندش.
 */
export type NotificationLevel = 'CRITICAL' | 'IMPORTANT' | 'INFORMATIONAL' | 'INTERNAL'

/** آیا این سطح در تختهٔ اعلان‌ها ثبت می‌شود؟ */
export function storedInBoard(level: NotificationLevel): boolean {
  return level !== 'INTERNAL'
}

/** آیا این سطح به چت خصوصی بازیکن push می‌شود؟ */
export function pushedToChat(level: NotificationLevel): boolean {
  return level === 'CRITICAL' || level === 'IMPORTANT'
}

export type PushSender = (telegramUserId: bigint, text: string) => Promise<void>

let pushSender: PushSender | null = null

/** ثبت فرستندهٔ واقعی (از `bot.ts`). */
export function registerPushSender(sender: PushSender): void {
  pushSender = sender
}

/** حذف فرستنده — فقط برای تست. */
export function clearPushSender(): void {
  pushSender = null
}

/**
 * فرستادن پیام خصوصی.
 *
 * هرگز پرتاب نمی‌کند: بازیکن ممکن است ربات را بلاک کرده باشد یا اصلاً
 * خصوصی استارت نکرده باشد (تلگرام اجازهٔ پیام‌دادن نمی‌دهد). شکستِ تحویل
 * فقط لاگ می‌شود؛ محتوای اعلان از راه تخته قابل خواندن می‌ماند.
 */
export async function pushPrivateMessage(
  telegramUserId: bigint,
  text: string
): Promise<boolean> {
  if (!pushSender) {
    return false
  }
  try {
    await pushSender(telegramUserId, text)
    return true
  } catch (error) {
    logger.debug(
      { err: error, telegramUserId: telegramUserId.toString() },
      'private notification delivery failed (bot blocked or chat not started)'
    )
    return false
  }
}
