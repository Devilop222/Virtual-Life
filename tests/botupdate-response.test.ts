/**
 * `/botupdate` باید در **هر** مسیر پاسخ بدهد.
 *
 * ## باگی که این آزمون قفل می‌کند
 * این فرمان یک **پیام** است، نه دکمه. ولی مسیرهای خطا و نگهبانِ دسترسی،
 * پیامشان را از کانالِ Callback (`answerCallbackQuery`) می‌فرستادند. در بافتِ
 * فرمان آن کانال وجود ندارد، تلگرام ردش می‌کند و چون خطا بی‌صدا گرفته می‌شد،
 * مالک ربات **هیچ چیزی** نمی‌دید: نه «دسترسی نداری»، نه «در جریان است»، نه
 * «خطا خورد». دقیقاً همان «ربات جواب نمی‌دهد».
 *
 * پس اینجا خودِ `registerOpsHandlers` روی یک Bot واقعی grammy اجرا می‌شود و
 * Update از `bot.handleUpdate` عبور می‌کند؛ بعد شمارش می‌شود که واقعاً یک
 * پیام برگشته یا نه.
 */
import { Bot, Context } from 'grammy'
import type { UserFromGetMe } from 'grammy/types'
import { registerOpsHandlers } from '../src/bot/handlers/ops.handler'
import { ackCallback } from '../src/bot/panel'
import type { Container } from '../src/services/container'
import { syncBotProfile } from '../src/bot/bot'
import { readText } from './helpers/source'
import { join } from 'path'

const OWNER_ID = 6910416744
const STRANGER_ID = 31337

const ME = {
  id: 1,
  is_bot: true,
  first_name: 'bot',
  username: 'b',
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false
} as unknown as UserFromGetMe

interface ApiCall {
  method: string
  payload: unknown
}

function makeBot(container: Container, calls: ApiCall[]): Bot {
  const bot = new Bot('test:token', { botInfo: ME })
  bot.api.config.use((_prev, method, payload) => {
    calls.push({ method, payload })
    const result =
      method === 'getMe'
        ? ME
        : { message_id: 5, date: 1_700_000_000, chat: { id: 1, type: 'private' } }
    return Promise.resolve({ ok: true, result } as never)
  })
  registerOpsHandlers(bot, container)
  return bot
}

function update(text: string, userId: number, chatType: 'private' | 'group') {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      date: 1_700_000_000,
      text,
      // فیلترِ `command()` در grammy از همین entities می‌خواند؛ بدون آن، پیام
      // یک متنِ ساده شمرده می‌شود و هندلرِ فرمان هرگز صدا زده نمی‌شود.
      entities: text.startsWith('/')
        ? [{ type: 'bot_command', offset: 0, length: text.length }]
        : undefined,
      chat: { id: chatType === 'private' ? userId : -1000, type: chatType },
      from: { id: userId, is_bot: false, first_name: 'آرش' }
    }
  }
}

/** کمینهٔ چیزی که مسیرِ `/botupdate` لازم دارد — بقیه عمداً غایب است. */
function makeContainer(overrides: Record<string, unknown> = {}): Container {
  return {
    adminService: { isOwner: jest.fn().mockResolvedValue(false) },
    systemStatusService: { snapshot: jest.fn().mockResolvedValue({}) },
    backupService: { list: jest.fn().mockReturnValue([]) },
    userStateRepository: { findByTelegramUserId: jest.fn().mockResolvedValue(null) },
    ...overrides
  } as unknown as Container
}

async function run(text: string, userId: number, calls: ApiCall[], container: Container) {
  const bot = makeBot(container, calls)
  await bot.handleUpdate(update(text, userId, 'private') as never, {
    api: bot.api,
    me: ME
  } as never)
}

const sentMessages = (calls: ApiCall[]): string[] =>
  calls
    .filter((c) => c.method === 'sendMessage')
    .map((c) => String((c.payload as { text?: string }).text ?? ''))

describe('/botupdate never answers with silence', () => {
  test('غیرمالک در چت خصوصی پیام می‌گیرد (نه سکوت)', async () => {
    const calls: ApiCall[] = []
    await run('/botupdate', STRANGER_ID, calls, makeContainer())

    expect(sentMessages(calls).length).toBeGreaterThan(0)
  })

  test('در گروه هم پاسخ واضح می‌دهد', async () => {
    const calls: ApiCall[] = []
    const bot = makeBot(makeContainer(), calls)
    await bot.handleUpdate(update('/botupdate', OWNER_ID, 'group') as never, {
      api: bot.api,
      me: ME
    } as never)

    expect(sentMessages(calls).join('\n')).toContain('چت خصوصی')
  })

  test('مالک در چت خصوصی پنل مرکز کنترل را می‌گیرد', async () => {
    const calls: ApiCall[] = []
    const container = makeContainer({
      adminService: { isOwner: jest.fn().mockResolvedValue(true) }
    })
    await run('/botupdate', OWNER_ID, calls, container)

    expect(sentMessages(calls).length).toBeGreaterThan(0)
  })

  test('خطای غیرمنتظره هم به مالک گزارش می‌شود، نه این‌که گم شود', async () => {
    const calls: ApiCall[] = []
    const container = makeContainer({
      adminService: { isOwner: jest.fn().mockResolvedValue(true) },
      systemStatusService: {
        snapshot: jest.fn().mockRejectedValue(new Error('snapshot exploded'))
      }
    })
    await run('/botupdate', OWNER_ID, calls, container)

    const text = sentMessages(calls).join('\n')
    expect(text.length).toBeGreaterThan(0)
    // پیام باید انسانی باشد، نه متنِ خامِ خطا
    expect(text).not.toContain('snapshot exploded')
  })
})

describe('ackCallback — یک کانال، دو بافت', () => {
  test('بدون Callback، متن به‌عنوان پیام می‌رود', async () => {
    const replies: string[] = []
    const ctx = {
      from: { id: 1 },
      chat: { id: 1, type: 'private' },
      reply: async (text: string) => {
        replies.push(text)
        return { message_id: 1 }
      }
    } as unknown as Context

    await ackCallback(ctx, 'این بخش در دسترس تو نیست.', true)

    expect(replies).toEqual(['این بخش در دسترس تو نیست.'])
  })

  test('با Callback، توست می‌رود و پیام تازه ساخته نمی‌شود', async () => {
    const answered: string[] = []
    const replies: string[] = []
    const ctx = {
      from: { id: 1 },
      chat: { id: 1, type: 'private' },
      callbackQuery: { id: '1', data: 'x', from: { id: 1 } },
      answerCallbackQuery: async (options?: { text?: string }) => {
        answered.push(options?.text ?? '')
      },
      reply: async (text: string) => {
        replies.push(text)
        return { message_id: 1 }
      }
    } as unknown as Context

    await ackCallback(ctx, 'انجام شد', true)

    expect(answered).toEqual(['انجام شد'])
    expect(replies).toEqual([])
  })

  test('فرمانِ مدیر از مسیر خطای پیام استفاده می‌کند، نه مسیر دکمه', () => {
    const source = readText(join(__dirname, '..', 'src', 'bot', 'handlers', 'ops.handler.ts'))
    const command = source.slice(source.indexOf("bot.command('botupdate'"))
    const body = command.slice(0, command.indexOf('\n  })'))

    expect(body).toContain('handleCommandError')
    expect(body).not.toContain('handleCallbackError')
  })
})

describe('Public command menu', () => {
  async function syncProfile(): Promise<ApiCall[]> {
    const calls: ApiCall[] = []
    const bot = new Bot('test:token', { botInfo: ME })
    bot.api.config.use((_prev, method, payload) => {
      calls.push({ method, payload })
      return Promise.resolve({ ok: true, result: ME } as never)
    })
    await syncBotProfile(bot)
    return calls.filter((c) => c.method === 'setMyCommands')
  }

  test('منوی عمومی فقط دستورهای بازیکن را دارد', async () => {
    const [publicList] = await syncProfile()
    const commands = (publicList!.payload as { commands: Array<{ command: string }> }).commands
    const scope = (publicList!.payload as { scope?: unknown }).scope

    expect(scope).toBeUndefined()
    expect(commands.map((c) => c.command)).toEqual(['start'])
  })

  test('admin_help فقط در چت خصوصیِ مالک دیده می‌شود', async () => {
    const lists = await syncProfile()
    const scoped = lists.find(
      (c) => (c.payload as { scope?: { type?: string } }).scope?.type === 'chat'
    )

    expect(scoped).toBeDefined()
    const payload = scoped!.payload as {
      scope: { chat_id: number }
      commands: Array<{ command: string }>
    }
    expect(payload.scope.chat_id).toBe(OWNER_ID)
    expect(payload.commands.map((c) => c.command)).toEqual(['admin_help'])
  })
})
