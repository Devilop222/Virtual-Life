/**
 * دسترسیِ عملیاتی: «بکاپ برای همهٔ ادمین‌های مجاز، استقرار فقط برای مالک».
 *
 * این سوئیت قراردادِ امنیتی را در سطحِ سورس قفل می‌کند، چون خطا در یک گیت به
 * راحتی و بی‌صدا رخ می‌دهد: کافی است یک مسیر جدید بدون نگهبان اضافه شود یا
 * یک مسیر حساس به دروازهٔ ضعیف‌تر منتقل شود.
 */

import { join } from 'path'
import { Bot } from 'grammy'
import { readText } from './helpers/source'
import { syncBotProfile } from '../src/bot/bot'

const ops = readText(join('src', 'bot', 'handlers', 'ops.handler.ts'))
const guard = readText(join('src', 'bot', 'owner-guard.ts'))
const adminPanel = readText(join('src', 'bot', 'handlers', 'admin.handler.ts'))

/** همهٔ بلوک‌های `bot.callbackQuery(...)` که کلیدِ `bk:` را می‌گیرند. */
function backupBlocks(): string[] {
  return ops
    .split('bot.callbackQuery(')
    .slice(1)
    .filter((block) => block.slice(0, 120).includes('bk:'))
}

describe('دروازهٔ بکاپ دیتابیس', () => {
  test('هر مسیرِ بکاپ از دروازهٔ ادمین رد می‌شود، نه فقط مالک', () => {
    const blocks = backupBlocks()
    expect(blocks.length).toBeGreaterThanOrEqual(9)
    for (const block of blocks) {
      expect(block).toContain('gateAdminPrivate(ctx, container)')
      // حتی یک مسیر نباید دروازهٔ مالک داشته باشد (وگرنه ادمین پشت در می‌ماند)
      expect(block).not.toContain('gateOwnerPrivate(ctx, container)')
    }
  })

  test('لاگ و استقرار مالک‌محور می‌مانند', () => {
    const logs = ops.split('bot.callbackQuery(').find((block) => block.startsWith("'op:logs'"))!
    expect(logs).toContain('gateOwnerPrivate(ctx, container)')
    expect(guard).toContain('requireOwner')
  })

  test('پنلِ ادمین دکمهٔ مالک را رندر نمی‌کند (دکمهٔ بی‌دسترسی ممنوع)', () => {
    const keyboard = ops.slice(
      ops.indexOf('function buildControlKeyboard'),
      ops.indexOf('// ──────────────────────────────────────────────────────────────── لاگ')
    )
    expect(keyboard).toContain('showOwnerActions')
    expect(keyboard).toContain('🚀 به‌روزرسانی سرور')
    expect(keyboard).toContain('💾 بکاپ‌ها')
    // دکمهٔ لاگ داخل شرطِ مالک باشد
    const logIndex = keyboard.indexOf("'op:logs'")
    expect(logIndex).toBeGreaterThan(-1)
    expect(keyboard.lastIndexOf('if (showOwnerActions)', logIndex)).toBeGreaterThan(-1)
  })

  test('بازیابی همچنان دو مرحله‌ای است و در هر دو مرحله دسترسی سنجیده می‌شود', () => {
    expect(ops).toContain('bk:r:')
    expect(ops).toContain('bk:r2:')
    const confirm = ops.split('bot.callbackQuery(').find((block) => block.includes('bk:r2:'))!
    expect(confirm).toContain('gateAdminPrivate(ctx, container)')
    // تأیید نهایی فقط بعد از صفحهٔ تفصیلیِ بازیابی ممکن است
    expect(ops).toContain('renderRestoreConfirm')
  })

  test('حذف هم تأیید جداگانه دارد', () => {
    expect(ops).toContain('bk:del:')
    expect(ops).toContain('bk:del2:')
    expect(ops).toContain('تأیید حذف')
  })

  test('نگهبانِ ادمین از جدولِ ادمین‌ها می‌خواند، نه از یک شناسهٔ ثابت', () => {
    expect(guard).toContain('container.adminService.isAdmin(id)')
    expect(guard).not.toMatch(/PRIMARY_OWNER|8369939024/)
  })

  test('هر دو دروازه، چتِ خصوصی را شرط می‌کنند', () => {
    const gates = ops.slice(
      ops.indexOf('async function gateOwnerPrivate'),
      ops.indexOf('async function openControlCenter')
    )
    expect(gates.match(/isPrivateChat\(ctx\)/g)?.length).toBe(2)
  })
})

describe('دسترسیِ ادمین باید پیدا شدنی باشد، نه فقط ممکن', () => {
  test('داشبوردِ ادمین یک قدم تا بکاپ‌ها فاصله دارد', () => {
    const home = adminPanel.slice(
      adminPanel.indexOf('function buildAdminHomeKeyboard'),
      adminPanel.indexOf('function buildAdminListKeyboard')
    )
    expect(home).toContain("'bk:panel'")
  })

  test('دستورهای مدیریتی برای هر ادمینِ فعال دامنهٔ چتی می‌گیرند', async () => {
    const calls: Array<{ method: string; payload: Record<string, unknown> }> = []
    const bot = new Bot('test:token', {
      botInfo: { id: 1, is_bot: true, first_name: 'bot', username: 'bot' } as never
    })
    bot.api.config.use((_prev, method, payload) => {
      calls.push({ method, payload: payload as Record<string, unknown> })
      return Promise.resolve({ ok: true, result: {} } as never)
    })

    await syncBotProfile(bot, [11n, 22n])

    const scoped = calls.filter(
      (call) =>
        call.method === 'setMyCommands' &&
        (call.payload as { scope?: { type?: string } }).scope?.type === 'chat'
    )
    expect(
      scoped.map((call) => (call.payload as { scope: { chat_id: number } }).scope.chat_id)
    ).toEqual([11, 22])
    for (const call of scoped) {
      expect((call.payload as { commands: Array<{ command: string }> }).commands.map((c) => c.command)).toEqual([
        'admin_help'
      ])
    }
    // منوی عمومی همچنان فقط دستورهای بازیکن است
    const publicList = calls.find(
      (call) => call.method === 'setMyCommands' && !(call.payload as { scope?: unknown }).scope
    )
    expect((publicList!.payload as { commands: Array<{ command: string }> }).commands.map((c) => c.command)).toEqual([
      'start'
    ])
  })

  test('پیش‌فرضِ نبودِ فهرست، دامنهٔ مالک است (رفتارِ قبلی حفظ می‌شود)', async () => {
    const calls: Array<{ method: string; payload: Record<string, unknown> }> = []
    const bot = new Bot('test:token', {
      botInfo: { id: 1, is_bot: true, first_name: 'bot', username: 'bot' } as never
    })
    bot.api.config.use((_prev, method, payload) => {
      calls.push({ method, payload: payload as Record<string, unknown> })
      return Promise.resolve({ ok: true, result: {} } as never)
    })

    await syncBotProfile(bot, [])

    const scoped = calls.filter(
      (call) =>
        call.method === 'setMyCommands' &&
        (call.payload as { scope?: { type?: string } }).scope?.type === 'chat'
    )
    expect(scoped).toHaveLength(1)
  })
})

describe('رابط کاربری فقط Inline است', () => {
  test('هیچ ReplyKeyboard در سورس وجود ندارد', () => {
    for (const file of ['src/bot/bot.ts', 'src/bot/panel.ts', 'src/bot/keyboards/main.keyboard.ts']) {
      const source = readText(join(...file.split('/')))
      for (const forbidden of ['ReplyKeyboardMarkup', 'KeyboardButton', 'force_reply', 'remove_keyboard']) {
        expect(source).not.toContain(forbidden)
      }
    }
  })
})
