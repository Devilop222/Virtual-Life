/**
 * آزمون یکپارچهٔ هندلرهای callback پنل ادمین.
 *
 * اینجا خودِ `registerAdminHandlers` روی یک Bot واقعی grammy اجرا می‌شود و
 * Update ساختگی از `bot.handleUpdate` عبور می‌کند؛ پس گارد دسترسی، ackCallback،
 * رندر پنل و editPanel همه واقعاً اجرا می‌شوند (نه ماک).
 */
import { Bot } from 'grammy'
import type { UserFromGetMe } from 'grammy/types'
import { BotAdminRole, PlayerStatus } from '@prisma/client'
import { Context } from 'grammy'
import { handleAdminInputText, registerAdminHandlers } from '../src/bot/handlers/admin.handler'
import type { Container } from '../src/services/container'

const OWNER_ID = 6910416744
const ADMIN_ID = 8369939024
const USER_ID = 31337
const TARGET_ID = 4242

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
    // ترنسفورمر grammy باید پاسخِ کامل API را برگرداند ({ ok, result })؛
    // در غیر این صورت خودِ grammy GrammyError می‌سازد و مسیر واقعی هندلر تست نمی‌شود.
    const result =
      method === 'getMe'
        ? ME
        : { message_id: 5, date: 1_700_000_000, chat: { id: 1, type: 'private' } }
    return Promise.resolve({ ok: true, result } as never)
  })
  registerAdminHandlers(bot, container)
  return bot
}

function metrics() {
  return {
    totalPlayers: 3,
    activePlayers: 2,
    bannedPlayers: 1,
    workingPlayers: 1,
    totalGroups: 1,
    totalBusinesses: 2,
    totalBankAccounts: 3,
    totalProperties: 4,
    totalLoans: 0,
    totalAdmins: 2,
    totalEconomyVolume: 12_345_000,
    adminLogCount: 7
  }
}

const WARNING_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'

function moderationView() {
  return {
    telegramUserId: BigInt(TARGET_ID),
    firstName: 'آرش',
    lastName: 'م.',
    status: PlayerStatus.ACTIVE,
    warnings: [
      {
        id: WARNING_ID,
        reason: 'تبلیغ نامربوط در گروه',
        issuedBy: BigInt(ADMIN_ID),
        isActive: true,
        causedBan: false,
        createdAt: new Date('2026-09-10T00:00:00Z'),
        revokedAt: null
      }
    ],
    activeCount: 2,
    threshold: 3,
    remainingUntilBan: 1
  }
}

function deletionPreview(blockers: Array<{ title: string; hint: string }> = []) {
  return {
    telegramUserId: BigInt(TARGET_ID),
    firstName: 'آرش',
    blockers,
    removals: [
      { label: 'کسب‌وکار', count: 1 },
      { label: 'نوبت کاری', count: 2 }
    ],
    settlements: ['ازدواج فعالش پایان می‌یابد و همسر «جداشده» ثبت می‌شود.'],
    removedFunds: 290_000
  }
}

function makeContainer(role: BotAdminRole | null) {
  return {
    adminService: {
      findAdmin: jest
        .fn()
        .mockResolvedValue(
          role ? { telegramUserId: BigInt(OWNER_ID), role, isActive: true } : null
        ),
      isAdmin: jest.fn().mockResolvedValue(role !== null),
      isOwner: jest.fn().mockResolvedValue(role === BotAdminRole.OWNER),
      getDashboardMetrics: jest.fn().mockResolvedValue(metrics()),
      listPlayers: jest.fn().mockResolvedValue({
        total: 1,
        page: 0,
        pageSize: 10,
        items: [
          {
            id: 'p1',
            telegramUserId: BigInt(TARGET_ID),
            firstName: 'آرش',
            lastName: 'م.',
            username: null,
            age: 24,
            status: PlayerStatus.ACTIVE,
            activityState: 'IDLE',
            balance: 1_000_000n,
            workSessions: []
          }
        ]
      }),
      listGroups: jest.fn().mockResolvedValue({ total: 0, page: 0, pageSize: 10, items: [] }),
      listAdminLogs: jest.fn().mockResolvedValue({ total: 0, page: 0, pageSize: 8, items: [] }),
      listAdmins: jest.fn().mockImplementation((_actor: bigint, page = 0) =>
        Promise.resolve({
          total: 1,
          page,
          pageSize: 10,
          items: [
            {
              admin: {
                telegramUserId: BigInt(OWNER_ID),
                role: BotAdminRole.OWNER,
                isActive: true,
                firstName: 'اصلی',
                username: null,
                createdAt: new Date('2026-09-01T00:00:00Z')
              },
              hasPlayer: true,
              playerName: 'ادمین اصلی'
            }
          ]
        })
      ),
      getPlayerAdminView: jest.fn().mockResolvedValue({
        telegramUserId: BigInt(TARGET_ID),
        firstName: 'آرش',
        lastName: 'م.',
        username: null,
        gender: 'MALE',
        age: 24,
        startedAt: null,
        balance: 1_000_000n,
        health: 80,
        fatigue: 20,
        experience: 10,
        status: PlayerStatus.ACTIVE,
        activityState: 'IDLE',
        maritalStatus: 'SINGLE',
        currentDegree: 'BACHELOR',
        graduationField: null,
        isEnrolled: false,
        enrolledFieldKey: null,
        streakCount: 3,
        createdAt: new Date('2026-09-01T00:00:00Z'),
        lastActivityAt: null,
        homeGroup: null,
        workSessions: [],
        skills: []
      }),
      listPlayerSkills: jest.fn().mockResolvedValue([]),
      setAccountStatus: jest
        .fn()
        .mockResolvedValue({ before: PlayerStatus.ACTIVE, after: PlayerStatus.BANNED }),
      stopActiveWork: jest.fn().mockResolvedValue({ jobTitle: 'نانوایی' }),
      removeAdmin: jest.fn().mockResolvedValue({ removedName: 'نگار' }),
      getModerationView: jest.fn().mockResolvedValue(moderationView()),
      issueWarning: jest
        .fn()
        .mockResolvedValue({ activeCount: 3, banned: true, remainingUntilBan: 0 }),
      revokeWarning: jest.fn().mockResolvedValue({ activeCount: 2, stillBanned: false }),
      sendPlayerMessage: jest.fn().mockResolvedValue({ firstName: 'آرش', notificationId: 'n1' }),
      getDeletionPreview: jest.fn().mockResolvedValue(deletionPreview()),
      deletePlayer: jest.fn().mockResolvedValue({ firstName: 'آرش', removedFunds: 290_000 })
    },
    groupRepository: { findByTelegramGroupId: jest.fn().mockResolvedValue(null) },
    groupService: { ensureGroupUpdated: jest.fn() },
    userStateRepository: {
      findByTelegramUserId: jest.fn().mockResolvedValue(null),
      issueConfirmation: jest.fn().mockResolvedValue('11111111-1111-4111-8111-111111111111'),
      consumeConfirmation: jest
        .fn()
        .mockResolvedValue({ action: 'ban', target: String(TARGET_ID) }),
      clear: jest.fn().mockResolvedValue(undefined),
      upsert: jest.fn().mockResolvedValue(undefined)
    }
  } as unknown as Container
}

function callbackUpdate(data: string, userId: number) {
  return {
    update_id: 1,
    callback_query: {
      id: 'cq1',
      from: { id: userId, is_bot: false, first_name: 'u' },
      chat_instance: 'ci',
      data,
      message: {
        message_id: 5,
        date: 1_700_000_000,
        text: 'old',
        chat: { id: userId, type: 'private' as const }
      }
    }
  }
}

async function run(
  role: BotAdminRole | null,
  data: string,
  userId = OWNER_ID
): Promise<{ calls: ApiCall[]; container: unknown }> {
  const calls: ApiCall[] = []
  const container = makeContainer(role)
  const bot = makeBot(container, calls)
  await bot.handleUpdate(
    callbackUpdate(data, userId) as never,
    {
      api: bot.api,
      me: ME
    } as never
  )
  return { calls, container }
}

function editedText(calls: ApiCall[]): string | null {
  const edit = calls.find((c) => c.method === 'editMessageText')
  return edit ? String((edit.payload as { text: string }).text) : null
}

function answered(calls: ApiCall[]): boolean {
  return calls.some((c) => c.method === 'answerCallbackQuery')
}

describe('Admin callbacks are guarded server-side', () => {
  test('a non-admin gets an alert and never the panel content', async () => {
    const { calls } = await run(null, 'adm:home', USER_ID)
    expect(answered(calls)).toBe(true)
    expect(editedText(calls)).toBeNull()
  })

  test('a non-admin cannot reach the player list or the logs', async () => {
    for (const data of ['adm:players:0', 'adm:logs:0', 'adm:groups:0', `adm:player:${TARGET_ID}`]) {
      const { calls } = await run(null, data, USER_ID)
      expect(editedText(calls)).toBeNull()
    }
  })

  test('a plain admin cannot open the owner-only admins list', async () => {
    const { calls } = await run(BotAdminRole.ADMIN, 'adm:admins', ADMIN_ID)
    expect(editedText(calls)).toBeNull()
    expect(answered(calls)).toBe(true)
  })

  test('a plain admin cannot run admin_remove even with a forged callback', async () => {
    const { calls, container } = await run(
      BotAdminRole.ADMIN,
      `adm:run:admin_remove:${TARGET_ID}`,
      ADMIN_ID
    )
    const svc = (container as { adminService: { removeAdmin: jest.Mock } }).adminService
    expect(svc.removeAdmin).not.toHaveBeenCalled()
    expect(editedText(calls)).toBeNull()
  })
})

describe('Admin callbacks render panels in place', () => {
  test('adm:home edits the same message with the dashboard', async () => {
    const { calls } = await run(BotAdminRole.OWNER, 'adm:home')
    const text = editedText(calls)
    expect(text).not.toBeNull()
    expect(text).toContain('پنل ادمین')
    expect(text).toContain('۱۲٬۳۴۵٬۰۰۰')
    expect(calls.filter((c) => c.method === 'sendMessage')).toHaveLength(0)
  })

  test('the dashboard never renders undefined or null', async () => {
    const { calls } = await run(BotAdminRole.OWNER, 'adm:home')
    const text = editedText(calls)!
    expect(text).not.toMatch(/undefined|null|NaN|\[object Object\]/)
  })

  test('the player panel renders every section without leaking internals', async () => {
    const { calls } = await run(BotAdminRole.OWNER, `adm:player:${TARGET_ID}`)
    const text = editedText(calls)!
    expect(text).toContain('آرش')
    expect(text).not.toMatch(/undefined|null|NaN|\[object Object\]/)
  })

  test('the player list page answers the query and edits in place', async () => {
    const { calls } = await run(BotAdminRole.OWNER, 'adm:players:0')
    expect(answered(calls)).toBe(true)
    expect(editedText(calls)).toContain('بازیکنان')
  })

  test('an unknown destructive action is refused instead of silently ignored', async () => {
    const { calls } = await run(BotAdminRole.OWNER, 'adm:run:nuke_everything:4242')
    expect(editedText(calls)).toBeNull()
    const alerts = calls.filter((c) => c.method === 'answerCallbackQuery')
    expect(alerts.length).toBeGreaterThan(0)
  })

  test('a negative telegram id survives the callback round-trip', async () => {
    const { calls } = await run(BotAdminRole.OWNER, 'adm:player:-1004242')
    expect(editedText(calls)).toContain('آرش')
  })

  test('ban goes through confirm, and the confirm panel names the action', async () => {
    const { calls } = await run(BotAdminRole.OWNER, `adm:confirm:ban:${TARGET_ID}`)
    const text = editedText(calls)!
    expect(text).toContain('مسدودکردن')
    expect(text).toContain(TARGET_ID.toString())
  })

  test('running ban applies the status and shows before → after', async () => {
    const { calls } = await run(
      BotAdminRole.OWNER,
      'adm:apply:11111111-1111-4111-8111-111111111111'
    )
    const text = editedText(calls)!
    expect(text).toContain('تغییر ثبت شد')
    expect(text).toContain(String(TARGET_ID))
  })

  test('the owner can see the admin list with a remove button per non-owner', async () => {
    const { calls } = await run(BotAdminRole.OWNER, 'adm:admins')
    const text = editedText(calls)!
    expect(text).toContain('ادمین‌ها')
    // OWNER در فهرست هست ولی دکمهٔ حذف برای خودش ساخته نمی‌شود
    expect(text).not.toContain('adm:run:admin_remove')
  })
})

describe('Administrative confirmation regression flows', () => {
  test('ban preview → apply edits one message and calls the service once', async () => {
    const calls: ApiCall[] = []
    const container = makeContainer(BotAdminRole.OWNER)
    const bot = makeBot(container, calls)
    const consume = container.userStateRepository.consumeConfirmation as jest.Mock
    consume
      .mockResolvedValueOnce({ action: 'ban', target: String(TARGET_ID) })
      .mockResolvedValue(null)
    await bot.handleUpdate(callbackUpdate(`adm:confirm:ban:${TARGET_ID}`, OWNER_ID) as never)
    expect(container.adminService.setAccountStatus).not.toHaveBeenCalled()
    expect(container.userStateRepository.issueConfirmation).toHaveBeenCalledWith(
      BigInt(OWNER_ID),
      OWNER_ID,
      { action: 'ban', target: String(TARGET_ID) }
    )
    for (let i = 0; i < 2; i++)
      await bot.handleUpdate(
        callbackUpdate('adm:apply:11111111-1111-4111-8111-111111111111', OWNER_ID) as never
      )
    expect(container.adminService.setAccountStatus).toHaveBeenCalledTimes(1)
    expect(container.adminService.setAccountStatus).toHaveBeenCalledWith(
      BigInt(OWNER_ID),
      BigInt(TARGET_ID),
      PlayerStatus.BANNED
    )
    expect(calls.filter((c) => c.method === 'sendMessage')).toHaveLength(0)
    expect(calls.filter((c) => c.method === 'editMessageText')).toHaveLength(2)
  })

  test('legacy execution buttons cannot change any state', async () => {
    const calls: ApiCall[] = []
    const container = makeContainer(BotAdminRole.OWNER)
    const bot = makeBot(container, calls)
    for (const action of ['ban', 'state_reset', 'admin_remove', 'work_stop']) {
      await bot.handleUpdate(callbackUpdate(`adm:run:${action}:${TARGET_ID}`, OWNER_ID) as never)
    }
    expect(container.adminService.setAccountStatus).not.toHaveBeenCalled()
    expect(container.adminService.removeAdmin).not.toHaveBeenCalled()
    expect(container.adminService.stopActiveWork).not.toHaveBeenCalled()
    expect(container.userStateRepository.consumeConfirmation).not.toHaveBeenCalled()
  })

  test.each(['ACTIVE', 'INACTIVE'])('status %s is preview-only until confirmed', async (status) => {
    const { container } = await run(BotAdminRole.OWNER, `adm:status:${status}:${TARGET_ID}`)
    const c = container as Container
    expect(c.adminService.setAccountStatus).not.toHaveBeenCalled()
    expect(c.userStateRepository.issueConfirmation).toHaveBeenCalledWith(
      BigInt(OWNER_ID),
      OWNER_ID,
      { action: 'status', target: String(TARGET_ID), value: status }
    )
  })

  test('a stripped admin cannot consume or apply a valid-looking token', async () => {
    const { calls, container } = await run(null, 'adm:apply:11111111-1111-4111-8111-111111111111')
    expect((container as Container).userStateRepository.consumeConfirmation).not.toHaveBeenCalled()
    expect(editedText(calls)).toBeNull()
    const answer = calls.find((c) => c.method === 'answerCallbackQuery')
    expect((answer?.payload as { text?: string }).text).toBeUndefined()
  })

  test('the settings page does not advertise runtime configuration that is not implemented', async () => {
    const { calls } = await run(BotAdminRole.ADMIN, 'adm:settings', ADMIN_ID)
    expect(editedText(calls)).toContain('قابل تغییر نیستند')
    expect(editedText(calls)).toContain('مقادیر قابل تنظیم')
  })

  test('empty employment, businesses and marriage have explicit states', async () => {
    const calls: ApiCall[] = []
    const container = makeContainer(BotAdminRole.OWNER)
    container.adminService.getPlayerLifeView = jest
      .fn()
      .mockResolvedValue({
        player: { id: 'p1', firstName: 'آرش' },
        jobs: [],
        businesses: [],
        marriages: [],
        pendingProposals: 0
      })
    const bot = makeBot(container, calls)
    await bot.handleUpdate(callbackUpdate(`adm:life:${TARGET_ID}`, OWNER_ID) as never)
    const text = editedText(calls)!
    expect(text).toContain('استخدام فعالی ندارد')
    expect(text).toContain('کسب‌وکاری ثبت نشده')
    expect(text).toContain('ازدواج فعالی ندارد')
    expect(text).toContain('۰ درخواست')
  })
})

describe('Filtered admin pagination', () => {
  test('the user search term is kept for the next page', async () => {
    const calls: ApiCall[] = []
    const container = makeContainer(BotAdminRole.OWNER)
    ;(container.userStateRepository.findByTelegramUserId as jest.Mock).mockResolvedValue({
      currentContext: 'adm:search',
      stateData: { chatId: OWNER_ID, term: 'آرش' }
    })
    const bot = makeBot(container, calls)
    await bot.handleUpdate(callbackUpdate('adm:players:1', OWNER_ID) as never)
    expect(container.adminService.listPlayers).toHaveBeenCalledWith(BigInt(OWNER_ID), 1, 'آرش')
    expect(calls.filter((c) => c.method === 'sendMessage')).toHaveLength(0)
  })

  test('a group search does not leak across chats', async () => {
    const calls: ApiCall[] = []
    const container = makeContainer(BotAdminRole.OWNER)
    ;(container.userStateRepository.findByTelegramUserId as jest.Mock).mockResolvedValue({
      currentContext: 'adm:group_search',
      stateData: { chatId: -100, term: 'شهر' }
    })
    const bot = makeBot(container, calls)
    await bot.handleUpdate(callbackUpdate('adm:groups:1', OWNER_ID) as never)
    expect(container.adminService.listGroups).toHaveBeenCalledWith(BigInt(OWNER_ID), 1, undefined)
  })
})

describe('Moderation subpanel: warning, message and deletion', () => {
  const keyboardOf = (calls: ApiCall[]) => {
    const edit = calls.find((c) => c.method === 'editMessageText')
    const markup = (edit?.payload ?? {}) as {
      reply_markup?: { inline_keyboard: Array<Array<{ callback_data?: string; text?: string }>> }
    }
    return (markup.reply_markup?.inline_keyboard ?? []).flat()
  }

  test('the moderation panel shows the warning list and every action button', async () => {
    const { calls, container } = await run(BotAdminRole.OWNER, `adm:mod:${TARGET_ID}`)
    const text = editedText(calls)!
    expect(text).toContain('اخطار')
    expect(text).toContain('تبلیغ نامربوط در گروه')
    expect(text).toContain('۱ اخطار فعال دیگر تا مسدودسازی')
    expect(text).not.toMatch(/undefined|null|NaN|\[object Object\]/)

    const data = keyboardOf(calls).map((button) => button.callback_data)
    expect(data).toEqual(
      expect.arrayContaining([
        `adm:warn:${TARGET_ID}`,
        `adm:msg:${TARGET_ID}`,
        `adm:wrev:${TARGET_ID}:${WARNING_ID}`,
        `adm:confirm:player_delete:${TARGET_ID}`
      ])
    )
    // سقف واقعی تلگرام با شناسهٔ uuid، نه با نمونهٔ کوتاه
    for (const item of data) {
      expect(Buffer.byteLength(item!)).toBeLessThanOrEqual(64)
    }
    expect((container as Container).adminService.getModerationView).toHaveBeenCalledWith(
      BigInt(OWNER_ID),
      BigInt(TARGET_ID)
    )
  })

  test('a banned player sees the blocked state instead of a misleading countdown', async () => {
    const calls: ApiCall[] = []
    const container = makeContainer(BotAdminRole.OWNER)
    ;(container.adminService.getModerationView as jest.Mock).mockResolvedValue({
      ...moderationView(),
      status: PlayerStatus.BANNED,
      activeCount: 3,
      remainingUntilBan: 0
    })
    const bot = makeBot(container, calls)
    await bot.handleUpdate(callbackUpdate(`adm:mod:${TARGET_ID}`, OWNER_ID) as never)
    const text = editedText(calls)!
    expect(text).toContain('مسدود')
    // شمارشِ «تا مسدودسازی» برای حسابِ مسدود گمراه‌کننده است
    expect(text).not.toContain('تا مسدودسازی')
    expect(text).toContain('برای بازگرداندن دسترسی')
    expect(text).toContain('پس از مسدودسازی هم ثبت می‌مانند')
  })

  test('an active player sees the real countdown to the automatic ban', async () => {
    const { calls } = await run(BotAdminRole.OWNER, `adm:mod:${TARGET_ID}`)
    const text = editedText(calls)!
    expect(text).toContain('۱ اخطار فعال دیگر تا مسدودسازی خودکار باقی است')
    expect(text).toContain('با ۳ اخطار فعال، حساب خودکار مسدود')
  })

  test('revoking a warning parses the real uuid and stages a single-use confirmation', async () => {
    const { calls, container } = await run(
      BotAdminRole.OWNER,
      `adm:wrev:${TARGET_ID}:${WARNING_ID}`
    )
    const c = container as Container
    expect(c.adminService.revokeWarning).not.toHaveBeenCalled()
    expect(c.userStateRepository.issueConfirmation).toHaveBeenCalledWith(
      BigInt(OWNER_ID),
      OWNER_ID,
      { action: 'warning_revoke', target: String(TARGET_ID), warningId: WARNING_ID }
    )
    const text = editedText(calls)!
    expect(text).toContain('لغو اخطار')
    expect(text).toContain('مسدودسازی خودکار برنمی‌گردد')
    expect(text).not.toMatch(/NaN|\[object Object\]/)
  })

  test('any uuid-shaped warning id is parsed exactly, never as the target', async () => {
    const calls: ApiCall[] = []
    const container = makeContainer(BotAdminRole.OWNER)
    const otherWarning = '11111111-2222-4333-8444-555555555555'
    const bot = makeBot(container, calls)
    await bot.handleUpdate(
      callbackUpdate(`adm:wrev:${TARGET_ID}:${otherWarning}`, OWNER_ID) as never
    )
    // مرحلهٔ تأیید ساخته می‌شود؛ خودِ لغو فقط با تأیید یک‌بارمصرف اجرا می‌شود
    expect(container.adminService.revokeWarning).not.toHaveBeenCalled()
    expect(container.userStateRepository.issueConfirmation).toHaveBeenCalledWith(
      BigInt(OWNER_ID),
      OWNER_ID,
      { action: 'warning_revoke', target: String(TARGET_ID), warningId: otherWarning }
    )
  })

  test('the warning button opens a text step, not a silent write', async () => {
    const { calls, container } = await run(BotAdminRole.ADMIN, `adm:warn:${TARGET_ID}`, ADMIN_ID)
    const text = editedText(calls)!
    expect(text).toContain('دلیل اخطار را بنویس')
    expect(text).toContain('۳ تا ۲۰۰ نویسه')
    expect((container as Container).userStateRepository.upsert).toHaveBeenCalledWith(
      BigInt(ADMIN_ID),
      expect.objectContaining({ currentContext: `adm:warn:${TARGET_ID}` })
    )
    expect((container as Container).adminService.issueWarning).not.toHaveBeenCalled()
  })

  test('the message button opens a text step and never sends before confirmation', async () => {
    const { calls, container } = await run(BotAdminRole.ADMIN, `adm:msg:${TARGET_ID}`, ADMIN_ID)
    const text = editedText(calls)!
    expect(text).toContain('متن پیام را بنویس')
    expect(text).toContain('۳ تا ۵۰۰ نویسه')
    expect((container as Container).adminService.sendPlayerMessage).not.toHaveBeenCalled()
    expect(calls.filter((c) => c.method === 'sendMessage')).toHaveLength(0)
  })

  test('deletion shows the real preview with removals and settlements', async () => {
    const { calls, container } = await run(
      BotAdminRole.OWNER,
      `adm:confirm:player_delete:${TARGET_ID}`
    )
    const c = container as Container
    expect(c.adminService.deletePlayer).not.toHaveBeenCalled()
    expect(c.adminService.getDeletionPreview).toHaveBeenCalledWith(
      BigInt(OWNER_ID),
      BigInt(TARGET_ID)
    )
    const text = editedText(calls)!
    expect(text).toContain('حذف')
    expect(text).toContain('کسب‌وکار')
    expect(text).toContain('۲۹۰٬۰۰۰')
    expect(c.userStateRepository.issueConfirmation).toHaveBeenCalledWith(
      BigInt(OWNER_ID),
      OWNER_ID,
      { action: 'player_delete', target: String(TARGET_ID) }
    )
  })

  test('a blocked deletion says why and issues no confirmation', async () => {
    const calls: ApiCall[] = []
    const container = makeContainer(BotAdminRole.OWNER)
    ;(container.adminService.getDeletionPreview as jest.Mock).mockResolvedValue(
      deletionPreview([
        {
          title: 'وام بانکی تسویه‌نشده',
          hint: 'وام بانکی تسویه‌نشده دارد؛ حذف حساب بدهی را نابود می‌کند.'
        }
      ])
    )
    const bot = makeBot(container, calls)
    await bot.handleUpdate(callbackUpdate(`adm:confirm:player_delete:${TARGET_ID}`, OWNER_ID) as never)
    const text = editedText(calls)!
    expect(text).toContain('وام بانکی تسویه‌نشده')
    expect(container.userStateRepository.issueConfirmation).not.toHaveBeenCalled()
    expect(container.adminService.deletePlayer).not.toHaveBeenCalled()
  })

  test('a non-admin never reaches moderation data or actions', async () => {
    for (const data of [
      `adm:mod:${TARGET_ID}`,
      `adm:warn:${TARGET_ID}`,
      `adm:msg:${TARGET_ID}`,
      `adm:wrev:${TARGET_ID}:${WARNING_ID}`,
      `adm:confirm:player_delete:${TARGET_ID}`
    ]) {
      const { calls, container } = await run(null, data, USER_ID)
      const c = container as Container
      expect(editedText(calls)).toBeNull()
      expect(c.adminService.getModerationView).not.toHaveBeenCalled()
      expect(c.adminService.getDeletionPreview).not.toHaveBeenCalled()
      expect(c.adminService.issueWarning).not.toHaveBeenCalled()
      expect(c.adminService.deletePlayer).not.toHaveBeenCalled()
      expect(c.userStateRepository.upsert).not.toHaveBeenCalled()
    }
  })

  test('a plain admin can moderate but the confirmation is still one-shot', async () => {
    const calls: ApiCall[] = []
    const container = makeContainer(BotAdminRole.ADMIN)
    const consume = container.userStateRepository.consumeConfirmation as jest.Mock
    consume
      .mockResolvedValueOnce({
        action: 'warning',
        target: String(TARGET_ID),
        reason: 'فریب در معاملهٔ بازار'
      })
      .mockResolvedValue(null)
    const bot = makeBot(container, calls)
    const token = 'adm:apply:11111111-1111-4111-8111-111111111111'
    await bot.handleUpdate(callbackUpdate(token, ADMIN_ID) as never)
    await bot.handleUpdate(callbackUpdate(token, ADMIN_ID) as never)

    expect(container.adminService.issueWarning).toHaveBeenCalledTimes(1)
    expect(container.adminService.issueWarning).toHaveBeenCalledWith(
      BigInt(ADMIN_ID),
      BigInt(TARGET_ID),
      'فریب در معاملهٔ بازار'
    )
    const text = editedText(calls)!
    expect(text).toContain('آستانه پر شد')
  })

  test('applying a revoke reports the honest state and never unbans silently', async () => {
    const calls: ApiCall[] = []
    const container = makeContainer(BotAdminRole.ADMIN)
    ;(container.userStateRepository.consumeConfirmation as jest.Mock).mockResolvedValue({
      action: 'warning_revoke',
      target: String(TARGET_ID),
      warningId: WARNING_ID
    })
    ;(container.adminService.revokeWarning as jest.Mock).mockResolvedValue({
      activeCount: 2,
      stillBanned: true
    })
    const bot = makeBot(container, calls)
    await bot.handleUpdate(
      callbackUpdate('adm:apply:11111111-1111-4111-8111-111111111111', ADMIN_ID) as never
    )
    expect(container.adminService.revokeWarning).toHaveBeenCalledWith(
      BigInt(ADMIN_ID),
      BigInt(TARGET_ID),
      WARNING_ID
    )
    const text = editedText(calls)!
    expect(text).toContain('همچنان مسدود است')
  })

  test('applying a message records it in-game and tries the private delivery', async () => {
    const calls: ApiCall[] = []
    const container = makeContainer(BotAdminRole.ADMIN)
    ;(container.userStateRepository.consumeConfirmation as jest.Mock).mockResolvedValue({
      action: 'message',
      target: String(TARGET_ID),
      text: 'موجودی تو بررسی و اصلاح شد.'
    })
    const bot = makeBot(container, calls)
    await bot.handleUpdate(
      callbackUpdate('adm:apply:11111111-1111-4111-8111-111111111111', ADMIN_ID) as never
    )

    expect(container.adminService.sendPlayerMessage).toHaveBeenCalledWith(
      BigInt(ADMIN_ID),
      BigInt(TARGET_ID),
      'موجودی تو بررسی و اصلاح شد.'
    )
    const pm = calls.find((c) => c.method === 'sendMessage')
    expect(pm).toBeDefined()
    expect((pm!.payload as { chat_id: string }).chat_id).toBe(String(TARGET_ID))
    expect(String((pm!.payload as { text: string }).text)).toContain('پیام مدیریت')
    expect(editedText(calls)).toContain('پیام خصوصی ارسال شد')
  })

  test('an undeliverable private message is reported honestly, not as success', async () => {
    const calls: ApiCall[] = []
    const container = makeContainer(BotAdminRole.ADMIN)
    ;(container.userStateRepository.consumeConfirmation as jest.Mock).mockResolvedValue({
      action: 'message',
      target: String(TARGET_ID),
      text: 'موجودی تو بررسی و اصلاح شد.'
    })
    const bot = makeBot(container, calls)
    bot.api.config.use((_prev, method, payload) => {
      calls.push({ method, payload })
      if (method === 'sendMessage') {
        return Promise.reject(new Error('bot was blocked by the user'))
      }
      const result =
        method === 'getMe'
          ? ME
          : { message_id: 5, date: 1_700_000_000, chat: { id: 1, type: 'private' } }
      return Promise.resolve({ ok: true, result } as never)
    })
    await bot.handleUpdate(
      callbackUpdate('adm:apply:11111111-1111-4111-8111-111111111111', ADMIN_ID) as never
    )

    expect(container.adminService.sendPlayerMessage).toHaveBeenCalled()
    expect(editedText(calls)).toContain('پیام خصوصی نرسید')
  })

  test('applying a deletion reports the removed funds and keeps the ledger', async () => {
    const calls: ApiCall[] = []
    const container = makeContainer(BotAdminRole.OWNER)
    ;(container.userStateRepository.consumeConfirmation as jest.Mock).mockResolvedValue({
      action: 'player_delete',
      target: String(TARGET_ID)
    })
    const bot = makeBot(container, calls)
    await bot.handleUpdate(
      callbackUpdate('adm:apply:11111111-1111-4111-8111-111111111111', OWNER_ID) as never
    )
    expect(container.adminService.deletePlayer).toHaveBeenCalledWith(
      BigInt(OWNER_ID),
      BigInt(TARGET_ID)
    )
    const text = editedText(calls)!
    expect(text).toContain('آرش')
    expect(text).toContain('۲۹۰٬۰۰۰')
    expect(text).toContain('دفتر مالی و تاریخچهٔ منطقه نگه داشته شد')
  })

  test('an expired confirmation cannot run a destructive action', async () => {
    const calls: ApiCall[] = []
    const container = makeContainer(BotAdminRole.OWNER)
    ;(container.userStateRepository.consumeConfirmation as jest.Mock).mockResolvedValue(null)
    const bot = makeBot(container, calls)
    await bot.handleUpdate(
      callbackUpdate('adm:apply:11111111-1111-4111-8111-111111111111', OWNER_ID) as never
    )
    expect(container.adminService.deletePlayer).not.toHaveBeenCalled()
    expect(container.adminService.issueWarning).not.toHaveBeenCalled()
    expect(editedText(calls)).toBeNull()
    const alert = calls.find((c) => c.method === 'answerCallbackQuery')
    expect(String((alert?.payload as { text?: string }).text)).toContain('منقضی')
  })
})

describe('Moderation text input flows', () => {
  function inputBot(role: BotAdminRole | null, calls: ApiCall[]) {
    const container = makeContainer(role)
    const bot = makeBot(container, calls)
    const update = {
      update_id: 2,
      message: {
        message_id: 9,
        date: 1_700_000_000,
        text: 'x',
        chat: { id: OWNER_ID, type: 'private' as const },
        from: { id: OWNER_ID, is_bot: false, first_name: 'u' }
      }
    }
    const ctx = new Context(update as never, bot.api as never, ME)
    return { container, ctx }
  }

  function sentText(calls: ApiCall[]): string {
    const sent = calls.filter((c) => c.method === 'sendMessage')
    return sent.map((c) => String((c.payload as { text: string }).text)).join('\n')
  }

  test('a valid reason goes to the confirmation step, not straight to the database', async () => {
    const calls: ApiCall[] = []
    const { container, ctx } = inputBot(BotAdminRole.OWNER, calls)
    const handled = await handleAdminInputText(
      ctx,
      container,
      `adm:warn:${TARGET_ID}`,
      'فریب در معاملهٔ بازار'
    )
    expect(handled).toBe(true)
    expect(container.adminService.issueWarning).not.toHaveBeenCalled()
    expect(container.userStateRepository.issueConfirmation).toHaveBeenCalledWith(
      BigInt(OWNER_ID),
      OWNER_ID,
      { action: 'warning', target: String(TARGET_ID), reason: 'فریب در معاملهٔ بازار' }
    )
    expect(sentText(calls)).toContain('تأیید')
  })

  test('an invalid reason is rejected with the same rule the service enforces', async () => {
    const calls: ApiCall[] = []
    const { container, ctx } = inputBot(BotAdminRole.OWNER, calls)
    const handled = await handleAdminInputText(ctx, container, `adm:warn:${TARGET_ID}`, '!')
    expect(handled).toBe(true)
    expect(container.userStateRepository.issueConfirmation).not.toHaveBeenCalled()
    expect(sentText(calls)).toContain('۳ تا ۲۰۰ نویسه')
  })

  test('a valid admin message is staged with its exact text', async () => {
    const calls: ApiCall[] = []
    const { container, ctx } = inputBot(BotAdminRole.ADMIN, calls)
    await handleAdminInputText(ctx, container, `adm:msg:${TARGET_ID}`, 'موجودی تو اصلاح شد.')
    expect(container.adminService.sendPlayerMessage).not.toHaveBeenCalled()
    expect(container.userStateRepository.issueConfirmation).toHaveBeenCalledWith(
      BigInt(OWNER_ID),
      OWNER_ID,
      { action: 'message', target: String(TARGET_ID), text: 'موجودی تو اصلاح شد.' }
    )
  })

  test('«انصراف» closes the flow without any write', async () => {
    const calls: ApiCall[] = []
    const { container, ctx } = inputBot(BotAdminRole.OWNER, calls)
    const handled = await handleAdminInputText(ctx, container, `adm:warn:${TARGET_ID}`, 'انصراف')
    expect(handled).toBe(true)
    expect(container.userStateRepository.clear).toHaveBeenCalledWith(BigInt(OWNER_ID))
    expect(container.userStateRepository.issueConfirmation).not.toHaveBeenCalled()
    expect(sentText(calls)).toContain('لغو شد')
  })

  test('input from another chat cannot drive this admin panel', async () => {
    const calls: ApiCall[] = []
    const { container, ctx } = inputBot(BotAdminRole.OWNER, calls)
    ;(container.userStateRepository.findByTelegramUserId as jest.Mock).mockResolvedValue({
      currentContext: `adm:warn:${TARGET_ID}`,
      stateData: { chatId: -100999, panelMessageId: 5 }
    })
    const handled = await handleAdminInputText(ctx, container, `adm:warn:${TARGET_ID}`, 'دلیل اخطار')
    expect(handled).toBe(true)
    expect(container.userStateRepository.issueConfirmation).not.toHaveBeenCalled()
    expect(sentText(calls)).toContain('چت دیگری')
  })

  test('an admin stripped mid-flow gets silence and a cleared state', async () => {
    const calls: ApiCall[] = []
    const { container, ctx } = inputBot(null, calls)
    const handled = await handleAdminInputText(ctx, container, `adm:warn:${TARGET_ID}`, 'دلیل اخطار')
    expect(handled).toBe(true)
    expect(container.userStateRepository.clear).toHaveBeenCalledWith(BigInt(OWNER_ID))
    expect(calls).toHaveLength(0)
  })
})

