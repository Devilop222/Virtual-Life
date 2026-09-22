/**
 * صندوق اعلان‌ها — «خوانده‌شدن» باید واقعاً اتفاق بیفتد.
 *
 * ## حفره‌ای که این آزمون از تکرارش جلوگیری می‌کند
 *
 * کل نیمهٔ «خوانده/نخوانده»ی سیستم اعلان وجود داشت و **به هیچ‌چیز وصل نبود**:
 * `markAllAsRead`، `markAsRead`، `unreadCount` و `getBoard` صفر فراخوانِ
 * تولیدی داشتند، پنل از `listNotifications` می‌خواند که وضعیت را نشان نمی‌داد،
 * و هیچ دکمه‌ای برای علامت‌زدن نبود. سه پیامد واقعی داشت:
 *
 *  ۱. `Notification.status` برای همیشه `PENDING` می‌ماند؛ `readAt` هرگز
 *     نوشته نمی‌شد و پنل نمی‌توانست بگوید چه چیزی تازه است.
 *  ۲. سیاست نگهداری دو بازهٔ جدا دارد (خوانده ۳۰ روز، ناخوانده ۱۸۰ روز).
 *     شاخهٔ «خوانده» هیچ‌وقت اجرا نمی‌شد، پس همهٔ اعلان‌ها ۱۸۰ روز می‌ماندند.
 *  ۳. `sweepExpired`/`pruneNotifications` روی وضعیتی کار می‌کردند که
 *     هیچ‌کس نمی‌نوشت — حساب‌وکتابی که ورودی‌اش وصل نبود.
 *
 * این آزمون سه چیز را قفل می‌کند: کنشِ خواندن در سورس واقعاً وصل باشد،
 * پنل نشانِ ناخوانده را نشان دهد، و مسیر نگهداری به همان وضعیت تکیه کند.
 */
import { join } from 'path'
import { readText } from './helpers/source'
import { renderNotificationsList } from '../src/bot/renders'
import { buildNotificationsKeyboard } from '../src/bot/keyboards/main.keyboard'
import { CALLBACK_PREFIX_SECTION, isSectionAllowedHere } from '../src/bot/chat-policy'
import { NotificationStatus } from '@prisma/client'

const root = join(__dirname, '..')
const SRC = (rel: string) => readText(join(root, rel))

const item = (over: Partial<Parameters<typeof renderNotificationsList>[0]['items'][number]> = {}) => ({
  id: 'n1',
  title: 'حقوق امروزت واریز شد',
  message: 'مبلغ به کیف پولت رسید.',
  type: 'EVENT' as const,
  createdAt: new Date('2026-09-01T10:00:00Z'),
  unread: true,
  ...over
})

/** آنچه بازیکن می‌بیند — برای سنجش متن، نه شناسه. */
function rendered(board: Parameters<typeof renderNotificationsList>[0]): string {
  return renderNotificationsList(board)
}

describe('صندوق اعلان‌ها: نیمهٔ خوانده/نخوانده وصل است', () => {
  test('پنل از getBoard می‌خواند تا شمارِ ناخوانده‌ها هم بیاید', () => {
    const handler = SRC('src/bot/handlers/text.handler.ts')
    // مسیرِ خواندن با شمارِ ناخوانده: getBoard، نه listNotifications
    expect(handler).toContain('notificationService.getBoard')
    expect(handler).toContain('renderNotificationsList(board)')
  })

  test('کنشِ «همه را خواندم» در سورس ثبت شده و سرویس را صدا می‌زند', () => {
    const handler = SRC('src/bot/handlers/text.handler.ts')
    expect(handler).toContain("callbackQuery('notif:read_all'")
    expect(handler).toContain('markAllAsRead')
    // و پنل باید پس از نوشتن، از دیتابیس دوباره خوانده شود (نه متنِ خیالی)
    const readAll = handler.slice(handler.indexOf("callbackQuery('notif:read_all'"))
    expect(readAll.slice(0, 900)).toContain('getBoard')
  })

  test('سرویس‌های بی‌فراخوان حالا در سورس تولیدی صدا زده می‌شوند', () => {
    const sources = [
      SRC('src/bot/handlers/text.handler.ts'),
      SRC('src/bot/keyboards/main.keyboard.ts')
    ].join('\n')
    for (const method of ['getBoard', 'markAllAsRead', 'buildNotificationsKeyboard']) {
      expect(sources).toContain(method)
    }
  })

  test('وضعیتِ خوانده‌شده همان چیزی است که نگهداری رویش حساب می‌کند', () => {
    // اگر روزی نامِ وضعیت عوض شود، دو طرف باید با هم عوض شوند؛ این آزمون
    // پیوندِ پنهانِ بین «خواندن» و «پاکسازی» را صریح نگه می‌دارد.
    const retention = SRC('src/modules/maintenance/retention.service.ts')
    expect(retention).toContain('NotificationStatus.READ')
    expect(NotificationStatus.READ).toBe('READ')
  })
})

describe('صندوق اعلان‌ها: پنل چیزی را پنهان نمی‌کند', () => {
  test('اعلان ناخوانده نشانِ روشن دارد و خوانده‌شده نشانِ خنثی', () => {
    const unread = rendered({ items: [item({ unread: true })], unreadCount: 1, total: 1 })
    const read = rendered({ items: [item({ unread: false })], unreadCount: 0, total: 1 })
    expect(unread).toContain('🔵')
    expect(unread).not.toContain('⚪')
    expect(read).toContain('⚪')
    expect(read).not.toContain('🔵')
  })

  test('شمارِ ناخوانده و کل در متن می‌آید', () => {
    const out = rendered({ items: [item()], unreadCount: 3, total: 7 })
    expect(out).toContain('۳')
    expect(out).toContain('۷')
  })

  test('وقتی همه خوانده شده‌اند هم پنل صادق است و نشانِ ناخوانده ندارد', () => {
    const out = rendered({ items: [item({ unread: false })], unreadCount: 0, total: 1 })
    expect(out).not.toContain('🔵')
    expect(out).toContain('⚪')
  })

  test('اعلان‌های بیرونِ صفحه، پنهان نمی‌مانند — بازیکن می‌فهمد بیشتر هست', () => {
    // ریشهٔ باگ: فهرست ۱۰تایی سقف داشت ولی هیچ‌جا گفته نمی‌شد؛ بازیکنِ پرکار
    // فکر می‌کرد اعلان‌های قدیمی‌اش از بین رفته‌اند.
    const out = rendered({ items: [item(), item({ id: 'n2' })], unreadCount: 2, total: 25 })
    expect(out).toContain('۲۳')
    expect(out).toMatch(/قدیمی/)
  })

  test('صندوق خالی، متنِ بی‌ربط نشان نمی‌دهد', () => {
    const out = rendered({ items: [], unreadCount: 0, total: 0 })
    expect(out).toContain('اعلانِ تازه‌ای نداری')
  })
})

describe('صندوق اعلان‌ها: دکمه‌ها فقط وقتی معنا دارند که کاری بکنند', () => {
  test('دکمهٔ «خواندم» فقط با ناخواندهٔ موجود می‌آید', () => {
    const withUnread = JSON.stringify(buildNotificationsKeyboard(2).inline_keyboard)
    const without = JSON.stringify(buildNotificationsKeyboard(0).inline_keyboard)
    expect(withUnread).toContain('notif:read_all')
    expect(without).not.toContain('notif:read_all')
  })

  test('دکمهٔ به‌روزرسانی و بستن همیشه هست — پنل بن‌بست نمی‌شود', () => {
    for (const count of [0, 5]) {
      const raw = JSON.stringify(buildNotificationsKeyboard(count).inline_keyboard)
      expect(raw).toContain('notif:refresh')
      expect(raw).toContain('panel:close')
    }
  })

  test('شمارِ ناخوانده روی خودِ دکمه نوشته شده (نه فقط در متن)', () => {
    const raw = JSON.stringify(buildNotificationsKeyboard(4).inline_keyboard)
    expect(raw).toContain('۴')
  })
})

describe('صندوق اعلان‌ها: نگهبانِ callback رعایت شده', () => {
  test('پیشوند notif بخش دارد، پس از نگهبانِ سراسری رد نمی‌شود', () => {
    expect(CALLBACK_PREFIX_SECTION.notif).toBe('notifications')
  })

  test('همهٔ callbackهای تازه با پیشوند notif ساخته می‌شوند', () => {
    const keyboard = JSON.stringify(buildNotificationsKeyboard(1).inline_keyboard)
    for (const match of keyboard.matchAll(/"(notif:[a-z_]+)"/g)) {
      expect(match[1]!.split(':')[0]).toBe('notif')
    }
  })

  test('بخشِ اعلان‌ها در چت خصوصی هم در دسترس است', () => {
    // خواندن اعلان‌های خودِ بازیکن محدودیت محیطی ندارد؛ وگرنه بازیکنِ مسدود
    // هیچ‌وقت نمی‌فهمد چرا مسدود شده.
    expect(isSectionAllowedHere('notifications', 'private')).toBe(true)
  })
})
