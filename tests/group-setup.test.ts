import {
  handleGroupContext,
  isGroupSetupAuthorized,
  renderGroupNotSetupPanel,
  renderNewRegionPanel
} from '../src/bot/handlers/group.handler'
import { groupSetupNote } from '../src/bot/admin-help'
import { Group, GroupEnvironmentLevel, GroupStatus, GroupType } from '@prisma/client'
import type { Container } from '../src/services/container'

/**
 * راه‌اندازی محیط گروه یک اقدام مدیریتی است:
 *  • کاربر عادی با /start یا کلیدواژه نمی‌تواند گروهِ ثبت‌نشده را فعال کند.
 *  • مدیر/مالک گروه با /start محیط را راه می‌اندازد.
 *  • فعالیت واقعی بازیکنِ ثبت‌شده، عضویت محلی‌اش را تثبیت می‌کند.
 */

function makeGroup(over: Partial<Group> = {}): Group {
  return {
    id: 'g-' + Math.random().toString(36).slice(2, 8),
    telegramGroupId: -100n,
    title: 'گروه آزمون',
    type: GroupType.SUPERGROUP,
    memberCount: 10,
    realMemberCount: 10,
    gamePopulation: 10,
    environmentLevel: GroupEnvironmentLevel.VILLAGE,
    ownerTelegramUserId: null,
    status: GroupStatus.ACTIVE,
    activePolicy: null,
    lotteryLastWeek: null,
    lotteryLastWinnerId: null,
    lotteryLastPrize: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over
  } as Group
}

function makeContainer(existing: Group | null, log: string[] = []): Container {
  return {
    groupRepository: {
      findByTelegramGroupId: jest.fn(async () => {
        log.push('lookup')
        return existing
      })
    },
    groupService: {
      ensureGroupUpdated: jest.fn(async (input) => {
        log.push(`ensure:${input.telegramGroupId}`)
        const group = existing ?? makeGroup({ telegramGroupId: input.telegramGroupId })
        return { group, created: existing === null, environmentChanged: false, memberCountSynced: true }
      }),
      linkPlayerToGroup: jest.fn(async () => {
        log.push('link')
        return {}
      }),
      refreshEnvironmentLevel: jest.fn(async () => {
        log.push('refresh')
        return {
          gamePopulation: existing?.gamePopulation ?? 1,
          environmentLevel: existing?.environmentLevel ?? GroupEnvironmentLevel.VILLAGE,
          levelChangedFrom: null,
          changed: false
        }
      })
    },
    eventService: {
      recordRegionEvent: jest.fn(async () => ({ id: 'e1' }))
    }
  } as unknown as Container
}

function groupCtx(chatId: number, fromId: number, adminStatus: string | null) {
  const ctx = {
    chat: { id: chatId, type: 'supergroup', title: 'گروه آزمون' },
    from: { id: fromId, is_bot: false, first_name: 'کاربر' },
    api: {
      getChatMember: jest.fn(async (_chatId: string, userId: number) => {
        return { status: adminStatus ?? 'member', user: { id: userId } }
      })
    }
  }
  return ctx as unknown as Parameters<typeof handleGroupContext>[0] & {
    api: { getChatMember: ReturnType<typeof jest.fn> }
  }
}

/** شناسه‌های چت یکتا در هر آزمون تا حافظهٔ Cooldown ماژول اشتراکی اثر نگذارد. */
let chatSeq = -100_000
function nextChatId(): number {
  return --chatSeq
}

describe('isGroupSetupAuthorized — only group leadership can activate the environment', () => {
  const api = (status: string | null) => ({
    getChatMember: jest.fn(async (_c: string, u: number) => ({ status: status ?? 'member', user: { id: u } }))
  })

  test('creator and administrator are authorized', async () => {
    expect(await isGroupSetupAuthorized(api('creator') as never, -100n, 7n)).toBe(true)
    expect(await isGroupSetupAuthorized(api('administrator') as never, -100n, 7n)).toBe(true)
  })

  test('plain member and kicked user are not', async () => {
    expect(await isGroupSetupAuthorized(api('member') as never, -101n, 7n)).toBe(false)
    expect(await isGroupSetupAuthorized(api('left') as never, -102n, 7n)).toBe(false)
  })

  test('telegram API failure fails closed', async () => {
    const failing = {
      getChatMember: jest.fn(async () => {
        throw new Error('bot is not a member')
      })
    }
    expect(await isGroupSetupAuthorized(failing as never, -103n, 7n)).toBe(false)
  })

  test('the anonymous group admin is always authorized', async () => {
    const never = { getChatMember: jest.fn(async () => {
      throw new Error('must not be called')
    }) }
    expect(await isGroupSetupAuthorized(never as never, -104n, 1087968824n)).toBe(true)
  })
})

describe('handleGroupContext — setup gate', () => {
  test('a plain user typing /start in an unregistered group does NOT create it', async () => {
    const chatId = nextChatId()
    const log: string[] = []
    const ctx = groupCtx(chatId, 42, 'member')
    const result = await handleGroupContext(ctx, makeContainer(null, log), {
      setupByUserId: 42n
    })

    expect(result.registered).toBe(false)
    expect(result.needsSetup).toBe(true)
    expect(result.group).toBeNull()
    // هیچ نوشتاری رخ نداده و تلگرام برای اعضا پرسیده نشده... به‌جز بررسی ادمین
    expect(ctx.api.getChatMember).toHaveBeenCalledWith(String(chatId), 42)
  })

  test('an admin typing /start in an unregistered group DOES create it', async () => {
    const chatId = nextChatId()
    const log: string[] = []
    const ctx = groupCtx(chatId, 7, 'creator')
    const result = await handleGroupContext(ctx, makeContainer(null, log), {
      setupByUserId: 7n
    })

    expect(result.registered).toBe(true)
    expect(result.created).toBe(true)
    expect(result.needsSetup).toBeUndefined()
    expect(log.some((l) => l.startsWith('ensure:'))).toBe(true)
  })

  test('keyword flow (no setup user) never activates a fresh group', async () => {
    const chatId = nextChatId()
    const log: string[] = []
    const ctx = groupCtx(chatId, 11, 'administrator') // حتی ادمین: بدون setup صریح ثبت نمی‌شود
    const result = await handleGroupContext(ctx, makeContainer(null, log))

    expect(result.needsSetup).toBe(true)
    expect(log.some((l) => l.startsWith('ensure:'))).toBe(false)
  })

  test('a failed admin setup reports a temporary failure, not “not set up”', async () => {
    const chatId = nextChatId()
    const container = makeContainer(null)
    ;(container.groupService.ensureGroupUpdated as jest.Mock).mockRejectedValue(
      new Error('db down')
    )
    const ctx = groupCtx(chatId, 7, 'creator')
    const result = await handleGroupContext(ctx, container, { setupByUserId: 7n })

    expect(result.registered).toBe(false)
    // ادمینی که /start فرستاده باید پیام «کمی بعد دوباره» ببیند نه «راه‌اندازی نشده»
    expect(result.syncFailed).toBe(true)
    expect(result.needsSetup).toBeUndefined()
  })

  test('an already-registered group keeps syncing for everyone, no setup rights needed', async () => {
    const chatId = nextChatId()
    const existing = makeGroup({ telegramGroupId: BigInt(chatId) })
    const ctx = groupCtx(chatId, 42, 'member')
    const result = await handleGroupContext(ctx, makeContainer(existing), {
      setupByUserId: 42n
    })

    expect(result.registered).toBe(true)
    expect(result.created).toBe(false)
    expect(result.group?.id).toBe(existing.id)
    expect(ctx.api.getChatMember).not.toHaveBeenCalled()
  })
})

describe('renderGroupNotSetupPanel — player-facing, no developer words', () => {
  test('explains the admin action, without internal terms', () => {
    const text = renderGroupNotSetupPanel(false)
    expect(text).toContain('راه‌اندازی نشده')
    expect(text).toContain('مدیران گروه')
    expect(text).toContain('/start')
    expect(text).not.toMatch(/Prisma|Repository|Service|state|SQL|error/i)
  })
})

describe('پنلِ لحظهٔ ثبت منطقه — عمومی، ولی بی‌دانشِ فنی', () => {
  const result = {
    isGroup: true,
    registered: true,
    created: true,
    environmentLevel: GroupEnvironmentLevel.VILLAGE,
    environmentLabel: 'روستا',
    group: makeGroup(),
    syncFailed: false
  } as unknown as Parameters<typeof renderNewRegionPanel>[0]

  test('کل گروه مسیر بازی را می‌بینند، نه پیکربندی ربات', () => {
    const text = renderNewRegionPanel(result)
    expect(text).toContain('منطقهٔ تازهٔ بازی')
    expect(text).toContain('شناسنامه')
    expect(text).not.toMatch(/BotFather|mybots|Group Privacy|Bot Settings|Privacy/i)
    expect(text).not.toMatch(/Prisma|Repository|Service|SQL|API/i)
  })

  test('نکتهٔ راه‌اندازی در چت خصوصیِ ثبت‌کننده می‌رود، نه در گروه', () => {
    // مسیرِ دقیق فقط برای کسی است که واقعاً می‌تواند آن را عوض کند.
    expect(groupSetupNote()).toMatch(/BotFather/)
    expect(groupSetupNote()).toMatch(/Group Privacy/)
    expect(groupSetupNote()).toMatch(/یک‌باره/)
  })
})
