/**
 * هستهٔ وصیت — تنها منبع قواعد «چه کسی می‌تواند وارث باشد» و متن‌های آن.
 *
 * چرا جدا از سرویس؟ سه مصرف‌کنندهٔ متفاوت داریم و هر سه باید یک تصمیم بگیرند:
 *   ۱. پنل وصیت (`WillService`) — وقتی بازیکن وصیت می‌نویسد/عوض می‌کند.
 *   ۲. مسیر ورودیِ متنی (هندلر) — وقتی بازیکن با ریپلای یا یوزرنیم وارث می‌دهد.
 *   ۳. اجرای میراث (`InheritanceService`) — لحظهٔ مرگ، دوباره اعتبارسنجی می‌کند.
 *
 * اگر این قواعد در دو جا نوشته می‌شد، ممکن بود وصیتی ثبت شود که لحظهٔ مرگ
 * نامعتبر تشخیص داده شود (یا برعکس) — یعنی بازیکن وصیت می‌نوشت و پولش به
 * هیچ‌کس نمی‌رسید. حالا هر سه مسیر از همین تابع می‌گذرند.
 */
import { PlayerStatus } from '@prisma/client'

/** کدهای نتیجهٔ اعتبارسنجی وارث. */
export type HeirRejection =
  | 'self'
  | 'not_found'
  | 'deceased'
  | 'banned'
  | 'inactive'

/** برچسب فارسیِ هر کد؛ لحن انسانی و بی‌ابهام. */
export const HEIR_REJECTION_LABELS: Record<HeirRejection, string> = {
  self: 'خودت نمی‌توانی وارث خودت باشی. یک بازیکن دیگر را انتخاب کن.',
  not_found:
    'این بازیکن پیدا نشد. روی پیام خودش ریپلای کن یا شناسهٔ عددی تلگرامش را بفرست.',
  deceased: 'این بازیکن دیگر زنده نیست؛ وارث باید بازیکنی زنده باشد.',
  banned: 'این بازیکن از بازی محروم شده و نمی‌تواند وارث شود.',
  inactive: 'این حساب هنوز بازی را کامل شروع نکرده است.'
}

export interface HeirCandidate {
  id: string
  firstName: string
  lastName: string | null
  status: PlayerStatus
}

/**
 * آیا این بازیکن می‌تواند وارث باشد؟
 *
 * قاعده عمداً سخت‌گیرانه است: وارث باید زنده و فعال باشد. اگر وارث هم فوت
 * کند، دارایی به هیچ‌کس نمی‌رسد و پروندهٔ میراث روی «بدون وارث» می‌ماند؛
 * اجازه‌دادن به حسابِ مرده/محروم یعنی نوشتنِ وصیتی که هرگز اجرا نمی‌شود.
 */
export function validateHeir(
  ownerId: string,
  candidate: HeirCandidate | null
): HeirRejection | null {
  if (!candidate) return 'not_found'
  if (candidate.id === ownerId) return 'self'
  if (candidate.status === PlayerStatus.DEAD) return 'deceased'
  if (candidate.status === PlayerStatus.BANNED) return 'banned'
  if (candidate.status === PlayerStatus.INACTIVE) return 'inactive'
  return null
}

/** نام نمایشیِ کوتاهِ بازیکن. */
export function displayName(player: { firstName: string; lastName?: string | null }): string {
  return `${player.firstName} ${player.lastName ?? ''}`.trim()
}

/** محدودیت‌های یادداشتِ وصیت (متن دلخواه برای وارث). */
export const WILL_NOTE_LIMITS = { maxLength: 200 } as const

/** اطلاعات عمومی سیستم که در پنل و راهنما نمایش داده می‌شود. */
export const WILL_INFO = {
  /**
   * سهم بازیکن عادی از دارایی؛ همیشه ۱۰۰٪ — سیستم مالیاتِ ارث نمی‌گیرد.
   * این عدد وجود دارد تا اگر روزی سهم دولتی اضافه شد، پنل از یک منبع بخواند.
   */
  heirSharePercent: 100,
  /** بدهی‌ها پیش از تقسیم دارایی، از دارایی نقدی تسویه می‌شوند. */
  debtsSettleFirst: true
} as const

/**
 * تبدیل ورودیِ خامِ بازیکن به یک قالب قابل جست‌وجو.
 * سه شکل پذیرفته می‌شود: شناسهٔ عددی تلگرام، `@username`، و «ریپلای».
 */
export type HeirInput =
  | { kind: 'telegram_id'; value: bigint }
  | { kind: 'username'; value: string }
  | { kind: 'reply'; value: string }
  | { kind: 'invalid' }

export function parseHeirInput(raw: string): HeirInput {
  const text = (raw ?? '').trim()
  if (!text) return { kind: 'invalid' }

  const digits = text.replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
  if (/^\d{5,15}$/.test(digits)) {
    return { kind: 'telegram_id', value: BigInt(digits) }
  }
  const username = text.match(/^@?([A-Za-z0-9_]{4,32})$/)
  if (username) {
    return { kind: 'username', value: username[1]!.toLowerCase() }
  }
  return { kind: 'invalid' }
}
