import { PlayerStatus } from '@prisma/client'
import {
  ENTRY_CALLBACK_SECTION,
  SECTION_CHAT_POLICY,
  SECTION_KEYWORDS,
  SECTION_TITLES,
  checkSectionEntry,
  groupOnlyAlert,
  groupOnlyNotice,
  isSectionAllowedHere,
  privateOnlyAlert,
  privateOnlyNotice,
  sectionKeyword,
  sectionPolicy,
  sectionTitle
} from '../src/bot/chat-policy'
import { EXACT_SECTIONS } from '../src/bot/command-catalog'

const GROUP_TYPES = ['group', 'supergroup']

function mockPlayerContainer(status: PlayerStatus | null, groupRow: unknown = { id: 'g1' }) {
  return {
    playerRepository: {
      findByTelegramUserId: async () =>
        status === null ? null : { status, telegramUserId: 1n }
    },
    groupRepository: {
      findByTelegramGroupId: async () => groupRow
    }
  }
}

function mockCtx(chatType: string, fromId = 1) {
  return { chat: { type: chatType, id: -100 }, from: { id: fromId } }
}

describe('Section chat policy table is the single source of truth', () => {
  test('every routable section has a policy', () => {
    const sections = new Set(Object.values(EXACT_SECTIONS))
    expect(sections.size).toBeGreaterThan(40)
    for (const section of sections) {
      expect(SECTION_CHAT_POLICY[section]).toMatch(/^(GROUP_ONLY|PRIVATE_ONLY|BOTH)$/)
    }
  })

  test('every policy key has a human title and a suggested keyword', () => {
    for (const section of Object.keys(SECTION_CHAT_POLICY)) {
      expect(sectionTitle(section)).not.toBe('این بخش')
      expect(SECTION_TITLES[section]!.length).toBeGreaterThan(0)
      expect(sectionKeyword(section)).not.toBe(section)
      expect(SECTION_KEYWORDS[section]!.length).toBeGreaterThan(0)
    }
  })

  test('cross-section jump callbacks only target known sections', () => {
    for (const section of Object.values(ENTRY_CALLBACK_SECTION)) {
      expect(SECTION_CHAT_POLICY[section]).toBeDefined()
    }
  })

  test('unknown sections fail open as BOTH', () => {
    expect(sectionPolicy('some-future-section')).toBe('BOTH')
    expect(isSectionAllowedHere('some-future-section', 'private')).toBe(true)
  })
})

describe('isSectionAllowedHere matrix', () => {
  test('GROUP_ONLY sections open in groups, never in private', () => {
    expect(isSectionAllowedHere('occupation', 'private')).toBe(false)
    expect(isSectionAllowedHere('market', 'private')).toBe(false)
    expect(isSectionAllowedHere('my_job', 'private')).toBe(false)
    for (const type of GROUP_TYPES) {
      expect(isSectionAllowedHere('occupation', type)).toBe(true)
      expect(isSectionAllowedHere('market', type)).toBe(true)
      expect(isSectionAllowedHere('my_job', type)).toBe(true)
    }
  })

  test('PRIVATE_ONLY invite opens in private, never in groups', () => {
    expect(isSectionAllowedHere('invite', 'private')).toBe(true)
    for (const type of GROUP_TYPES) {
      expect(isSectionAllowedHere('invite', type)).toBe(false)
    }
  })

  test('BOTH sections open everywhere', () => {
    for (const section of ['identity', 'ledger', 'history', 'banking', 'help']) {
      expect(isSectionAllowedHere(section, 'private')).toBe(true)
      for (const type of GROUP_TYPES) {
        expect(isSectionAllowedHere(section, type)).toBe(true)
      }
    }
  })
})

describe('guidance notices stay human', () => {
  test('group-only notice quotes the keyword and never leaks dev vocabulary', () => {
    const text = groupOnlyNotice('market')
    expect(text).toContain('«بازار»')
    expect(text).toContain('گروه')
    expect(text).not.toMatch(/\b(Session|session|callback|Callback|Prisma|PrismaClient)\b/)
    expect(groupOnlyAlert('market')).toContain('گروه')
  })

  test('private-only notice names private chat', () => {
    const text = privateOnlyNotice('invite')
    expect(text).toContain('چت خصوصی')
    expect(text).toContain('«دعوت دوستان»')
    expect(privateOnlyAlert('invite')).toContain('چت خصوصی')
  })
})

describe('checkSectionEntry gate', () => {
  test('wrong chat is rejected before any account lookup', async () => {
    const rejecting = {
      playerRepository: {
        findByTelegramUserId: async () => {
          throw new Error('must not be called')
        }
      }
    }
    const result = await checkSectionEntry(
      mockCtx('private') as never,
      rejecting as never,
      'occupation'
    )
    expect(result).toBe('wrong_chat')
  })

  test('active players pass; strangers pass (registration decides later)', async () => {
    const active = mockPlayerContainer(PlayerStatus.ACTIVE)
    expect(
      await checkSectionEntry(mockCtx('group') as never, active as never, 'occupation')
    ).toBe('allowed')
    const stranger = mockPlayerContainer(null)
    expect(
      await checkSectionEntry(mockCtx('group') as never, stranger as never, 'occupation')
    ).toBe('allowed')
  })

  test('banned and dead players are stopped, except on exempt sections', async () => {
    const banned = mockPlayerContainer(PlayerStatus.BANNED)
    const dead = mockPlayerContainer(PlayerStatus.DEAD)
    expect(await checkSectionEntry(mockCtx('group') as never, banned as never, 'banking')).toBe(
      'banned'
    )
    expect(await checkSectionEntry(mockCtx('group') as never, dead as never, 'banking')).toBe(
      'dead'
    )
    // راهنما حتی برای مسدود هم باز است
    expect(await checkSectionEntry(mockCtx('group') as never, banned as never, 'help')).toBe(
      'allowed'
    )
    expect(await checkSectionEntry(mockCtx('group') as never, dead as never, 'help')).toBe(
      'allowed'
    )
  })

  test('a blocked player can still read their own notices in private, never in a group', async () => {
    const banned = mockPlayerContainer(PlayerStatus.BANNED)
    const dead = mockPlayerContainer(PlayerStatus.DEAD)
    // دلیلِ اخطار و خبرِ مسدودسازی در اعلان‌های بازیکن ثبت می‌شود؛ راهِ خواندنش
    // در چت خصوصی باز می‌ماند تا «حسابت مسدود است» بدون دلیل نماند.
    expect(
      await checkSectionEntry(mockCtx('private') as never, banned as never, 'notifications')
    ).toBe('allowed')
    expect(
      await checkSectionEntry(mockCtx('private') as never, dead as never, 'notifications')
    ).toBe('allowed')
    // در گروه، متنِ پنل برای همه دیده می‌شود؛ پس دلیلِ اخطار عمومی نمی‌شود
    expect(
      await checkSectionEntry(mockCtx('group') as never, banned as never, 'notifications')
    ).toBe('banned')
    // بقیهٔ بخش‌ها برای حساب مسدود بسته می‌مانند
    expect(
      await checkSectionEntry(mockCtx('private') as never, banned as never, 'occupation')
    ).not.toBe('allowed')
  })
})
