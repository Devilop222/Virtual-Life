import { Bot, Context } from 'grammy'
import type { UserFromGetMe } from 'grammy/types'
import { PrismaClient } from '@prisma/client'
import { UserStateRepository } from '../src/database/repositories/user-state.repository'
import { ownsPanel, panelOwnerMiddleware } from '../src/bot/middleware/panel-owner.middleware'
import { CALLBACK_PREFIX_SECTION, chatPolicyMiddleware } from '../src/bot/chat-policy'
import { SECTION_CHAT_POLICY } from '../src/bot/command-catalog'
import { HELP_CATEGORIES, HELP_TOPICS } from '../src/bot/help-content'
import { registerTextHandlers } from '../src/bot/handlers/text.handler'
import { handleRegistrationText, registerStartHandler } from '../src/bot/handlers/start.handler'
import { formatLogDetails } from '../src/bot/handlers/admin.handler'
import { normalizeAdminSearch } from '../src/modules/admin/admin.service'
import type { Container } from '../src/services/container'

function context(data: string, actor = 42, chatType = 'supergroup', owner: number | null = 42) {
  const message = {
    message_id: 5,
    date: 10,
    chat: { id: chatType === 'private' ? 42 : -100, type: chatType },
    ...(owner === null ? {} : { reply_to_message: { from: { id: owner }, message_id: 4 } })
  }
  return {
    from: { id: actor },
    chat: message.chat,
    callbackQuery: { data, message },
    answerCallbackQuery: jest.fn().mockResolvedValue(undefined)
  }
}

const permissions = {
  adminService: { isAdmin: jest.fn().mockResolvedValue(true) },
  playerRepository: { findByTelegramUserId: jest.fn().mockResolvedValue({ status: 'ACTIVE' }) }
}

/** An in-memory adapter for the actual repository; deleteMany is compare-and-delete. */
export function confirmationRepository() {
  let row: Record<string, unknown> | null = null
  const db = {
    userState: {
      upsert: jest.fn().mockImplementation(({ create, update }) => {
        row = row ? { ...row, ...update } : { id: 'state-1', ...create }
        return Promise.resolve(row)
      }),
      findUnique: jest
        .fn()
        .mockImplementation(({ where }) =>
          Promise.resolve(row?.telegramUserId === where.telegramUserId ? { ...row } : null)
        ),
      deleteMany: jest.fn().mockImplementation(({ where }) => {
        const matches = row && Object.entries(where).every(([key, value]) => row![key] === value)
        if (matches) row = null
        return Promise.resolve({ count: matches ? 1 : 0 })
      })
    }
  }
  return { repo: new UserStateRepository(db as unknown as PrismaClient), db }
}

describe('Durable admin confirmations', () => {
  test('a confirmation is actor-bound, chat-bound and single-use', async () => {
    const { repo } = confirmationRepository()
    const token = await repo.issueConfirmation(42n, -100, {
      action: 'balance_add',
      target: '90',
      value: 500
    })
    expect(Buffer.byteLength(`adm:apply:${token}`)).toBeLessThanOrEqual(64)
    expect(await repo.consumeConfirmation(43n, -100, token)).toBeNull()
    expect(await repo.consumeConfirmation(42n, -200, token)).toBeNull()
    expect(await repo.consumeConfirmation(42n, -100, 'forged')).toBeNull()
    expect(await repo.consumeConfirmation(42n, -100, token)).toEqual({
      action: 'balance_add',
      target: '90',
      value: 500
    })
    expect(await repo.consumeConfirmation(42n, -100, token)).toBeNull()
  })

  test('concurrent clicks claim exactly once', async () => {
    const { repo } = confirmationRepository()
    const token = await repo.issueConfirmation(42n, -100, { action: 'ban', target: '90' })
    const results = await Promise.all(
      Array.from({ length: 12 }, () => repo.consumeConfirmation(42n, -100, token))
    )
    expect(results.filter(Boolean)).toHaveLength(1)
  })

  test('expires after five minutes and survives a repository restart before expiry', async () => {
    jest.useFakeTimers()
    try {
      const { repo, db } = confirmationRepository()
      const token = await repo.issueConfirmation(42n, -100, { action: 'ban' })
      jest.advanceTimersByTime(5 * 60 * 1000 + 1)
      expect(await repo.consumeConfirmation(42n, -100, token)).toBeNull()
      const fresh = await repo.issueConfirmation(42n, -100, { action: 'ban' })
      const restarted = new UserStateRepository(db as unknown as PrismaClient)
      expect(await restarted.consumeConfirmation(42n, -100, fresh)).toEqual({ action: 'ban' })
    } finally {
      jest.useRealTimers()
    }
  })

  test('cancel and replacement invalidate previous confirmations', async () => {
    const { repo } = confirmationRepository()
    const old = await repo.issueConfirmation(42n, 42, { action: 'ban' })
    const current = await repo.issueConfirmation(42n, 42, { action: 'health' })
    expect(await repo.consumeConfirmation(42n, 42, old)).toBeNull()
    await repo.clear(42n)
    expect(await repo.consumeConfirmation(42n, 42, current)).toBeNull()
  })
})

describe('Every group panel belongs to its opener', () => {
  test.each([
    'panel:close',
    'help:main',
    'id:toggle_privacy',
    'work:start_pt:bakery',
    'fam:accept:proposal',
    'biz:manage:company',
    'adm:home'
  ])('%s cannot control another actor panel', async (data) => {
    const ctx = context(data, 43)
    const next = jest.fn()
    await panelOwnerMiddleware(permissions as unknown as Container)(ctx as unknown as Context, next)
    expect(next).not.toHaveBeenCalled()
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('متعلق به تو نیست') })
    )
  })

  test.each(['group', 'supergroup', 'private'])('owner can use a %s panel', async (type) => {
    const ctx = context('help:main', 42, type)
    const next = jest.fn()
    await panelOwnerMiddleware(permissions as unknown as Container)(ctx as unknown as Context, next)
    expect(next).toHaveBeenCalledTimes(1)
  })

  test('missing group reply and mismatched private actor fail closed', () => {
    expect(ownsPanel(context('help:main', 42, 'group', null) as unknown as Context)).toBe(false)
    expect(ownsPanel(context('help:main', 43, 'private') as unknown as Context)).toBe(false)
  })

  test('non-admin receives no text even for a foreign admin panel', async () => {
    const ctx = context('adm:home', 999)
    const next = jest.fn()
    const container = { adminService: { isAdmin: jest.fn().mockResolvedValue(false) } }
    await panelOwnerMiddleware(container as unknown as Container)(ctx as unknown as Context, next)
    expect(next).not.toHaveBeenCalled()
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(undefined)
  })

  test('registration buttons never run in a group', async () => {
    const ctx = context('reg:gender:MALE')
    const next = jest.fn()
    await panelOwnerMiddleware(permissions as unknown as Container)(ctx as unknown as Context, next)
    expect(next).not.toHaveBeenCalled()
  })
})

describe('Nested callback chat policy and account status', () => {
  const groupPrefixes = Object.entries(CALLBACK_PREFIX_SECTION).filter(
    ([, section]) => SECTION_CHAT_POLICY[section] === 'GROUP_ONLY'
  )
  test.each(groupPrefixes)(
    '%s nested actions cannot bypass private-chat policy',
    async (prefix) => {
      const ctx = context(`${prefix}:nested:action`, 42, 'private')
      const next = jest.fn()
      await chatPolicyMiddleware(permissions as unknown as Container)(
        ctx as unknown as Context,
        next
      )
      expect(next).not.toHaveBeenCalled()
    }
  )

  test('banned actor cannot operate a previously opened nested panel', async () => {
    const ctx = context('bank:deposit')
    const next = jest.fn()
    const container = {
      playerRepository: { findByTelegramUserId: jest.fn().mockResolvedValue({ status: 'BANNED' }) }
    }
    await chatPolicyMiddleware(container as unknown as Container)(ctx as unknown as Context, next)
    expect(next).not.toHaveBeenCalled()
  })

  test('database failure is not treated as permission to play', async () => {
    const container = {
      playerRepository: { findByTelegramUserId: jest.fn().mockRejectedValue(new Error('offline')) }
    }
    const next = jest.fn()
    await expect(
      chatPolicyMiddleware(container as unknown as Container)(
        context('bank:deposit') as unknown as Context,
        next
      )
    ).rejects.toThrow('offline')
    expect(next).not.toHaveBeenCalled()
  })
})

describe('Real help handlers and Telegram limits', () => {
  const me = { id: 1, is_bot: true, first_name: 'bot', username: 'bot' } as UserFromGetMe
  test('every help page navigates on the same message with valid size and callbacks', async () => {
    const bot = new Bot('test:token', { botInfo: me })
    const calls: Array<{ method: string; payload: Record<string, unknown> }> = []
    bot.api.config.use((_prev, method, payload) => {
      calls.push({ method, payload: payload as unknown as Record<string, unknown> })
      return Promise.resolve({ ok: true, result: true } as never)
    })
    bot.use(panelOwnerMiddleware(permissions as unknown as Container))
    // مخزنِ بازیکن با پاسخ `null` یعنی «تازه‌وارد» — حالتی که همهٔ صفحه‌های
    // راهنما در آن وجود دارند (صفحهٔ ساختِ شخصیت برای بازیکنِ فعال عمداً
    // دیگر در راهنما نیست).
    registerTextHandlers(
      bot,
      {
        playerRepository: { findByTelegramUserId: jest.fn().mockResolvedValue(null) }
      } as unknown as Container
    )
    const routes = [
      'help:main',
      ...HELP_CATEGORIES.map((c) => `help:cat:${c.key}`),
      ...HELP_TOPICS.map((t) => `help:topic:${t.key}`),
      ...HELP_CATEGORIES.flatMap((c) => c.topicKeys.map((t) => `help:topic:${c.key}:${t}`))
    ]
    for (const data of routes) {
      const update = {
        update_id: 1,
        callback_query: {
          id: 'q',
          chat_instance: 'c',
          from: { id: 42, is_bot: false, first_name: 'user' },
          data,
          message: { message_id: 5, date: 10, chat: { type: 'private', id: 42 } }
        }
      }
      await bot.handleUpdate(update as never)
      if (data.startsWith('help:topic:')) {
        const key = data.split(':').at(-1)
        expect(calls.filter((c) => c.method === 'editMessageText').at(-1)?.payload.text).toBe(
          HELP_TOPICS.find((t) => t.key === key)!.body
        )
      }
    }
    expect(calls.filter((c) => c.method === 'sendMessage')).toHaveLength(0)
    const edits = calls.filter((c) => c.method === 'editMessageText')
    expect(edits).toHaveLength(routes.length)
    for (const edit of edits) {
      expect(edit.payload.message_id).toBe(5)
      expect(String(edit.payload.text).length).toBeLessThanOrEqual(4096)
      expect(String(edit.payload.text)).not.toMatch(/[━┈]|undefined|NaN/)
      const keyboard = edit.payload.reply_markup as {
        inline_keyboard: Array<Array<{ callback_data?: string }>>
      }
      for (const button of keyboard.inline_keyboard.flat()) {
        if (button.callback_data)
          expect(Buffer.byteLength(button.callback_data)).toBeLessThanOrEqual(64)
      }
    }
  })
})

describe('Registration and human-readable admin details', () => {
  test('group biography cannot accidentally complete private registration', async () => {
    const ctx = {
      chat: { id: -100, type: 'group' },
      from: { id: 42 },
      message: { message_id: 1 },
      reply: jest.fn()
    }
    const submitBiography = jest.fn()
    await handleRegistrationText(
      ctx as unknown as Context,
      { registrationService: { submitBiography } } as unknown as Container,
      'معرفی شخصیت'
    )
    expect(submitBiography).not.toHaveBeenCalled()
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('چت خصوصی'), expect.anything())
  })

  test.each([
    ['۸۳۶۹۹۳۹۰۲۴', '8369939024'],
    ['-۱۰۰۴۲', '-10042'],
    ['@Some_User', 'Some_User'],
    ['علي', 'علی']
  ])('admin search preserves identity in %s', (input, expected) => {
    expect(normalizeAdminSearch(input)).toBe(expected)
  })

  test('audit UI never exposes enum values or internal JSON field names', () => {
    expect(formatLogDetails({ before: 'ACTIVE', after: 'BANNED' })).toBe('قبل: فعال؛ بعد: مسدود')
    expect(
      formatLogDetails({ jobKey: 'sql_secret', role: 'ADMIN', path: '/home/file' })
    ).not.toMatch(/sql_secret|jobKey|ADMIN|\/home/)
  })
})

describe('Onboarding resumes the real registration step', () => {
  test.each([
    ['AWAITING_GENDER', true, 'جنسیت'],
    // متنِ معرفی در پاسِ بازطراحیِ تجربهٔ اول عوض شد؛ معیارِ تست همان
    // «خواستنِ معرفی از بازیکن» است، نه یک واژهٔ قدیمیِ آن.
    ['AWAITING_BIOGRAPHY', true, 'شخصیتت'],
    ['COMPLETED', false, 'خوش برگشتی']
  ])('private /start at %s renders the appropriate action', async (step, started, expected) => {
    const me = { id: 1, is_bot: true, first_name: 'bot', username: 'bot' } as UserFromGetMe
    const bot = new Bot('test:token', { botInfo: me })
    const messages: Array<{
      text?: string
      reply_markup?: { inline_keyboard?: Array<Array<{ callback_data?: string }>> }
    }> = []
    bot.api.config.use((_prev, _method, payload) => {
      messages.push(payload as never)
      return Promise.resolve({
        ok: true,
        result: { message_id: 5, date: 10, chat: { id: 42, type: 'private' } }
      } as never)
    })
    const registrationService = { start: jest.fn().mockResolvedValue({ step, started }) }
    registerStartHandler(bot, { registrationService } as unknown as Container)
    await bot.handleUpdate({
      update_id: 1,
      message: {
        message_id: 1,
        date: 10,
        from: { id: 42, first_name: 'user', is_bot: false },
        chat: { id: 42, type: 'private', first_name: 'user' },
        text: '/start',
        entities: [{ type: 'bot_command', offset: 0, length: 6 }]
      }
    })
    expect(messages).toHaveLength(1)
    expect(messages[0]?.text).toContain(expected)
    const buttons =
      messages[0]?.reply_markup?.inline_keyboard?.flat().map((b) => b.callback_data) ?? []
    if (step === 'AWAITING_BIOGRAPHY') expect(buttons).not.toContain('reg:gender:MALE')
    if (!started) {
      // بازیکنِ ثبت‌شده دیگر «ساخت شخصیت» نمی‌بیند؛ راهنمای شروع باز می‌شود
      expect(buttons).toContain('guide:page:0')
      expect(buttons).not.toContain('reg:gender:MALE')
    }
  })
})
