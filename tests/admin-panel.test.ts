import { BotAdminRole } from '@prisma/client'
import {
  ADMIN_PHRASES,
  adminPhraseOf,
  handleAdminInputText,
  handleAdminPhrase
} from '../src/bot/handlers/admin.handler'
import { normalizePersianText } from '../src/utils/commands'

const OWNER_ID = 6910416744
const ADMIN_ID = 8369939024
const USER_ID = 31337

interface FakeCtx {
  reply: jest.Mock
  chat: { id: number; type: string }
  from: { id: number; is_bot: boolean }
  message: { message_id: number; reply_to_message?: { from: unknown } }
  answerCallbackQuery: jest.Mock
  editMessageText: jest.Mock
}

function makeCtx(userId = USER_ID, replyTo?: { id: number; first_name: string }): FakeCtx {
  return {
    chat: { id: userId, type: 'private' },
    reply: jest.fn().mockResolvedValue({}),
    from: { id: userId, is_bot: false },
    message: {
      message_id: 11,
      ...(replyTo ? { reply_to_message: { from: replyTo } } : {})
    },
    answerCallbackQuery: jest.fn().mockResolvedValue(undefined),
    editMessageText: jest.fn().mockResolvedValue({})
  }
}

function makeContainer(role: BotAdminRole | null, isActive = true) {
  return {
    adminService: {
      findAdmin: jest
        .fn()
        .mockImplementation((id: bigint) =>
          Promise.resolve(
            role === null || (id !== BigInt(OWNER_ID) && id !== BigInt(ADMIN_ID))
              ? null
              : { telegramUserId: id, role, isActive, firstName: 'ادمین' }
          )
        ),
      assertOwner: jest.fn().mockResolvedValue({ role: BotAdminRole.OWNER }),
      getPlayerAdminView: jest.fn().mockResolvedValue({ firstName: 'نگار' }),
      isAdmin: jest.fn().mockResolvedValue(role !== null && isActive),
      isOwner: jest.fn().mockResolvedValue(role === BotAdminRole.OWNER && isActive),
      listAdmins: jest
        .fn()
        .mockImplementation((_actor: bigint, page = 0) =>
          Promise.resolve({ total: 0, page, pageSize: 10, items: [] })
        ),
      addAdmin: jest.fn().mockResolvedValue({
        telegramUserId: 555n,
        role: BotAdminRole.ADMIN,
        isActive: true
      }),
      removeAdmin: jest.fn().mockResolvedValue({ removedName: 'نگار' }),
      adjustBalance: jest.fn().mockResolvedValue({ before: 1_000_000, after: 1_500_000 }),
      setField: jest.fn().mockResolvedValue({ before: 1_000_000, after: 0 }),
      setSkillLevel: jest.fn().mockResolvedValue({ skillName: 'آشپزی', before: 2, after: 7 }),
      getDashboardMetrics: jest.fn().mockResolvedValue({
        totalPlayers: 1,
        activePlayers: 1,
        bannedPlayers: 0,
        workingPlayers: 0,
        totalGroups: 0,
        totalBusinesses: 0,
        totalBankAccounts: 0,
        totalProperties: 0,
        totalLoans: 0,
        totalAdmins: 1,
        totalEconomyVolume: 0,
        adminLogCount: 0
      })
    },
    userStateRepository: {
      findByTelegramUserId: jest.fn().mockResolvedValue(null),
      issueConfirmation: jest.fn().mockResolvedValue('11111111-1111-4111-8111-111111111111'),
      clear: jest.fn().mockResolvedValue(undefined),
      upsert: jest.fn().mockResolvedValue(undefined)
    }
  }
}

describe('The entry phrases are matched exactly', () => {
  test('«پنل ادمین» with its space opens the panel', () => {
    expect(adminPhraseOf(normalizePersianText('پنل ادمین'))).toBe('panel')
  })

  test('all management phrases are recognised after normalization', () => {
    expect(Object.keys(ADMIN_PHRASES)).toHaveLength(5)
    expect(adminPhraseOf(normalizePersianText('ادمین ها'))).toBe('list')
    // «ادمین‌ها» با نیم‌فاصله نرمال می‌شود به «ادمینها» — باید همان فهرست را بدهد
    expect(adminPhraseOf(normalizePersianText('ادمین‌ها'))).toBe('list')
    expect(adminPhraseOf(normalizePersianText('اضافه ادمین'))).toBe('add')
    expect(adminPhraseOf(normalizePersianText('حذف ادمین'))).toBe('remove')
  })

  test('half-width / Arabic yeh and ZWNJ still match (normalization, not luck)', () => {
    expect(adminPhraseOf(normalizePersianText('پنل  ادمين'))).toBe('panel')
    expect(adminPhraseOf(normalizePersianText('‌پنل ادمین‌'))).toBe('panel')
  })

  test('a missing space or extra words is NOT the phrase', () => {
    expect(adminPhraseOf(normalizePersianText('پنلادمین'))).toBeNull()
    expect(adminPhraseOf(normalizePersianText('پنل ادمین لطفاً'))).toBeNull()
    expect(adminPhraseOf(normalizePersianText('ادمین'))).toBeNull()
    expect(adminPhraseOf(normalizePersianText('پنل'))).toBeNull()
  })
})

describe('Ordinary users never learn the panel exists', () => {
  test('a non-admin typing «پنل ادمین» gets no reply at all', async () => {
    const container = makeContainer(null)
    const ctx = makeCtx(USER_ID)

    const consumed = await handleAdminPhrase(ctx as never, container as never, 'panel')

    expect(consumed).toBe(true)
    expect(ctx.reply).not.toHaveBeenCalled()
    expect(ctx.editMessageText).not.toHaveBeenCalled()
    expect(ctx.answerCallbackQuery).not.toHaveBeenCalled()
  })

  test('a non-admin is silent for every management phrase', async () => {
    const container = makeContainer(null)
    for (const phrase of Object.values(ADMIN_PHRASES)) {
      const ctx = makeCtx(USER_ID)
      await handleAdminPhrase(ctx as never, container as never, phrase)
      expect(ctx.reply).not.toHaveBeenCalled()
    }
  })

  test('a deactivated admin is treated as an ordinary user', async () => {
    const container = makeContainer(BotAdminRole.OWNER, false)
    const ctx = makeCtx(OWNER_ID)
    await handleAdminPhrase(ctx as never, container as never, 'panel')
    expect(ctx.reply).not.toHaveBeenCalled()
  })

  test('the phrase is still consumed, so it never leaks into another flow', async () => {
    const container = makeContainer(null)
    const ctx = makeCtx(USER_ID)
    await expect(handleAdminPhrase(ctx as never, container as never, 'panel')).resolves.toBe(true)
  })
})

describe('Admins do get a response', () => {
  test('an admin typing «پنل ادمین» receives the dashboard as a reply', async () => {
    const container = makeContainer(BotAdminRole.ADMIN)
    const ctx = makeCtx(ADMIN_ID)

    await handleAdminPhrase(ctx as never, container as never, 'panel')

    expect(ctx.reply).toHaveBeenCalledTimes(1)
    const [text, options] = ctx.reply.mock.calls[0] as [string, { reply_parameters?: unknown }]
    expect(text).toContain('پنل ادمین')
    // پاسخ روی همان پیام کاربر ریپلای می‌خورد
    expect(options.reply_parameters).toEqual({ message_id: 11, allow_sending_without_reply: true })
  })

  test('admin management phrases are owner-only', async () => {
    const container = makeContainer(BotAdminRole.ADMIN)
    const ctx = makeCtx(ADMIN_ID)

    await handleAdminPhrase(ctx as never, container as never, 'list')

    const [text] = ctx.reply.mock.calls[0] as [string]
    expect(text).toContain('فقط برای ادمین اصلی')
    expect(container.adminService.listAdmins).not.toHaveBeenCalled()
  })

  test('«اضافه ادمین» without a reply explains the flow instead of guessing a user', async () => {
    const container = makeContainer(BotAdminRole.OWNER)
    const ctx = makeCtx(OWNER_ID)

    await handleAdminPhrase(ctx as never, container as never, 'add')

    const [text] = ctx.reply.mock.calls[0] as [string]
    expect(text).toContain('ریپلای')
    expect(container.adminService.addAdmin).not.toHaveBeenCalled()
  })

  test('«اضافه ادمین» on a replied message previews that exact user without granting permission', async () => {
    const container = makeContainer(BotAdminRole.OWNER)
    const ctx = makeCtx(OWNER_ID, { id: 4242, first_name: 'نگار' })

    await handleAdminPhrase(ctx as never, container as never, 'add')

    expect(container.adminService.addAdmin).not.toHaveBeenCalled()
    expect(container.userStateRepository.issueConfirmation).toHaveBeenCalledWith(
      BigInt(OWNER_ID),
      OWNER_ID,
      {
        action: 'admin_add',
        target: '4242',
        firstName: 'نگار',
        username: null
      }
    )
  })

  test('a bot or a self-reply can never be promoted', async () => {
    const container = makeContainer(BotAdminRole.OWNER)
    const self = makeCtx(OWNER_ID, { id: OWNER_ID, first_name: 'خودم' })
    await handleAdminPhrase(self as never, container as never, 'add')
    expect(container.adminService.addAdmin).not.toHaveBeenCalled()
  })

  test('«حذف ادمین» asks for confirmation before running', async () => {
    const container = makeContainer(BotAdminRole.OWNER)
    // مسیر حذف با findAdmin کار می‌کند، نه با جست‌وجو در یک صفحه
    container.adminService.findAdmin.mockImplementation((id: bigint) =>
      Promise.resolve(
        id === 4242n
          ? { telegramUserId: 4242n, role: BotAdminRole.ADMIN, isActive: true, firstName: 'نگار' }
          : { telegramUserId: BigInt(OWNER_ID), role: BotAdminRole.OWNER, isActive: true }
      )
    )
    const ctx = makeCtx(OWNER_ID, { id: 4242, first_name: 'نگار' })

    await handleAdminPhrase(ctx as never, container as never, 'remove')

    // هنوز حذفی اتفاق نیفتاده؛ فقط دکمهٔ تأیید
    expect(container.adminService.removeAdmin).not.toHaveBeenCalled()
    const [, options] = ctx.reply.mock.calls[0] as [
      string,
      { reply_markup?: { inline_keyboard: unknown[][] } }
    ]
    const buttons = (options.reply_markup?.inline_keyboard ?? []).flat() as Array<
      Record<string, unknown>
    >
    const callbacks = buttons.flatMap((b) =>
      typeof b.callback_data === 'string' ? [b.callback_data] : []
    )
    expect(callbacks).toContain('adm:apply:11111111-1111-4111-8111-111111111111')
  })

  test('an open input flow is closed when an admin phrase arrives', async () => {
    const container = makeContainer(BotAdminRole.OWNER)
    const ctx = makeCtx(OWNER_ID)
    await handleAdminPhrase(ctx as never, container as never, 'panel')
    expect(container.userStateRepository.clear).toHaveBeenCalledWith(BigInt(OWNER_ID))
  })
})

describe('Numeric input flow of the admin panel', () => {
  function lastText(ctx: FakeCtx): string {
    const [text] = ctx.reply.mock.calls.at(-1) as [string]
    return text
  }

  test('«تنظیم موجودی» may set the wallet to zero', async () => {
    const container = makeContainer(BotAdminRole.OWNER)
    const ctx = makeCtx(OWNER_ID)

    await handleAdminInputText(ctx as never, container as never, 'adm:amount:balance_set:4242', '0')

    expect(container.adminService.setField).not.toHaveBeenCalled()
    expect(container.userStateRepository.issueConfirmation).toHaveBeenCalledWith(
      BigInt(OWNER_ID),
      OWNER_ID,
      {
        action: 'balance_set',
        target: '4242',
        value: 0
      }
    )
    expect(lastText(ctx)).toContain('هنوز تغییری ثبت نشده')
  })

  test('a zero delta for add/remove is refused without contradicting the shown range', async () => {
    const container = makeContainer(BotAdminRole.OWNER)
    const ctx = makeCtx(OWNER_ID)

    await handleAdminInputText(ctx as never, container as never, 'adm:amount:balance_add:4242', '0')

    expect(container.adminService.adjustBalance).not.toHaveBeenCalled()
    const text = lastText(ctx)
    // پیام نباید بگوید «بین ۰ تا …» در حالی که صفر را رد کرده است
    expect(text).toContain('نمی‌تواند صفر باشد')
    expect(text).not.toContain('باید عددی صحیح بین')
  })

  test('a negative amount says so, and never reaches the database', async () => {
    const container = makeContainer(BotAdminRole.OWNER)
    const ctx = makeCtx(OWNER_ID)

    await handleAdminInputText(
      ctx as never,
      container as never,
      'adm:amount:balance_remove:4242',
      '-50000'
    )

    expect(container.adminService.adjustBalance).not.toHaveBeenCalled()
    expect(lastText(ctx)).toContain('منفی')
  })

  test('persian digits, thousands separators and «هزار» suffix all parse', async () => {
    const container = makeContainer(BotAdminRole.OWNER)

    for (const raw of ['۵۰۰۰۰۰', '500,000', '۵۰۰ هزار', '500k']) {
      const ctx = makeCtx(OWNER_ID)
      await handleAdminInputText(
        ctx as never,
        container as never,
        'adm:amount:balance_add:4242',
        raw
      )
      expect(container.adminService.adjustBalance).not.toHaveBeenCalled()
      expect(container.userStateRepository.issueConfirmation).toHaveBeenLastCalledWith(
        BigInt(OWNER_ID),
        OWNER_ID,
        {
          action: 'balance_add',
          target: '4242',
          value: 500_000
        }
      )
    }
  })

  test('«انصراف» closes the flow without writing anything', async () => {
    const container = makeContainer(BotAdminRole.OWNER)
    const ctx = makeCtx(OWNER_ID)

    const consumed = await handleAdminInputText(
      ctx as never,
      container as never,
      'adm:amount:balance_add:4242',
      'انصراف'
    )

    expect(consumed).toBe(true)
    expect(container.userStateRepository.clear).toHaveBeenCalledWith(BigInt(OWNER_ID))
    expect(container.adminService.adjustBalance).not.toHaveBeenCalled()
  })

  test('a stripped admin mid-flow is silenced and their state is dropped', async () => {
    const container = makeContainer(null)
    const ctx = makeCtx(USER_ID)

    const consumed = await handleAdminInputText(
      ctx as never,
      container as never,
      'adm:amount:balance_add:4242',
      '500000'
    )

    expect(consumed).toBe(true)
    expect(ctx.reply).not.toHaveBeenCalled()
    expect(container.userStateRepository.clear).toHaveBeenCalledWith(BigInt(USER_ID))
  })

  test('an empty search term keeps the flow open so a retry works', async () => {
    const container = makeContainer(BotAdminRole.OWNER)
    const ctx = makeCtx(OWNER_ID)

    await handleAdminInputText(ctx as never, container as never, 'adm:find', '   ')

    expect(container.userStateRepository.clear).not.toHaveBeenCalled()
    expect(lastText(ctx)).toContain('دوباره')
  })
})

describe('Admin names cannot break the Markdown panel', () => {
  test('a hostile Telegram display name is sanitized before it reaches the panel', async () => {
    const container = makeContainer(BotAdminRole.OWNER)
    // نام تلگرام کاملاً در اختیار کاربر است؛ این همان کلاسِ نقصی است که
    // در ثبت‌نام با plainInput بسته شد.
    const ctx = makeCtx(OWNER_ID, { id: 4242, first_name: 'Ali *[x](t.me/scam)* _bad_' })

    await handleAdminPhrase(ctx as never, container as never, 'add')

    const [, , target] = container.userStateRepository.issueConfirmation.mock.calls[0] as [
      bigint,
      number,
      { firstName: string; username?: string }
    ]
    // plainInput فقط نشانه‌های مارک‌داون (* _ ` [ ]) را برمی‌دارد
    expect(target.firstName).toBe('Ali x(t.me/scam) bad')
    expect(target.firstName).not.toMatch(/[*_`[\]]/)
  })

  test('the rendered success panel is parseable Markdown for that name', async () => {
    const container = makeContainer(BotAdminRole.OWNER)
    const ctx = makeCtx(OWNER_ID, { id: 4242, first_name: 'Ali *[x](t.me/scam)* _bad_' })

    await handleAdminPhrase(ctx as never, container as never, 'add')

    const [text] = ctx.reply.mock.calls[0] as [string]
    // bold باید جفت باشد؛ * یتیم یا [] باز، پارس تلگرام را می‌شکند
    expect((text.match(/\*/g) ?? []).length % 2).toBe(0)
    expect(text).not.toMatch(/\[(?!\])/)
  })
})

describe('Admin input keeps panel location and context', () => {
  test('valid numeric input edits the original panel instead of sending a new message', async () => {
    const container = makeContainer(BotAdminRole.OWNER)
    container.userStateRepository.findByTelegramUserId.mockResolvedValue({
      stateData: { chatId: OWNER_ID, panelMessageId: 99 }
    } as never)
    const edit = jest.fn().mockResolvedValue({})
    const ctx = Object.assign(makeCtx(OWNER_ID), { api: { editMessageText: edit } })
    await handleAdminInputText(ctx as never, container as never, 'adm:amount:health:4242', '۷۰')
    expect(ctx.reply).not.toHaveBeenCalled()
    expect(edit).toHaveBeenCalledWith(
      OWNER_ID,
      99,
      expect.stringContaining('تأیید'),
      expect.anything()
    )
    expect(container.adminService.setField).not.toHaveBeenCalled()
  })

  test('answering a pending admin input in a different chat does not stage a change', async () => {
    const container = makeContainer(BotAdminRole.OWNER)
    container.userStateRepository.findByTelegramUserId.mockResolvedValue({
      stateData: { chatId: -100, panelMessageId: 99 }
    } as never)
    const ctx = makeCtx(OWNER_ID)
    await handleAdminInputText(ctx as never, container as never, 'adm:amount:health:4242', '۷۰')
    expect(container.userStateRepository.issueConfirmation).not.toHaveBeenCalled()
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('چت دیگری'), expect.anything())
  })

  test('skill edits require a numeric preview and confirmation too', async () => {
    const container = makeContainer(BotAdminRole.OWNER)
    const ctx = makeCtx(OWNER_ID)
    await handleAdminInputText(ctx as never, container as never, 'adm:skill:skill1:4242', '۷')
    expect(container.adminService.setSkillLevel).not.toHaveBeenCalled()
    expect(container.userStateRepository.issueConfirmation).toHaveBeenCalledWith(
      BigInt(OWNER_ID),
      OWNER_ID,
      { action: 'skill', target: '4242', skillId: 'skill1', value: 7 }
    )
  })
})

test('admin promotion preserves a real username containing underscores', async () => {
  const container = makeContainer(BotAdminRole.OWNER)
  const ctx = makeCtx(OWNER_ID, { id: 4242, first_name: 'Ali', username: 'some_user' } as never)
  await handleAdminPhrase(ctx as never, container as never, 'add')
  expect(container.userStateRepository.issueConfirmation).toHaveBeenCalledWith(BigInt(OWNER_ID), OWNER_ID, expect.objectContaining({ username: 'some_user' }))
  expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('`@some_user`'), expect.anything())
})
