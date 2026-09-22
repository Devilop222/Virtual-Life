import { GroupEnvironmentLevel, GroupStatus, GroupType } from '@prisma/client'
import { EnvironmentClassifier } from '../src/modules/groups/environment.classifier'
import { GroupService, MemberInfoProvider } from '../src/modules/groups/group.service'
import { GroupRepository } from '../src/database/repositories/group.repository'
import { PlayerGroupRepository } from '../src/database/repositories/player-group.repository'
import { PlayerRepository } from '../src/database/repositories/player.repository'
import { renderGroupInfoPanel } from '../src/bot/handlers/group.handler'
import { REGION_CONFIG } from '../src/config/region.config'

/**
 * گذارِ سطحِ منطقه:
 *  • جمعیتِ بازی (شهروندانِ دارای عضویت فعال) تنها معیار است.
 *  • شمارِ اعضای تلگرام هیچ نقشی در سطح ندارد.
 *  • گذار خودکار و تکرارناپذیر است.
 */

const GROUP_ID = -100987654321n
const T = REGION_CONFIG.populationThresholds

function provider(totalCount: number, realMemberCount = totalCount): MemberInfoProvider {
  return {
    getMemberInfo: jest.fn().mockResolvedValue({
      totalCount,
      realMemberCount,
      ownerTelegramUserId: undefined,
      adminTelegramUserIds: []
    })
  }
}

function storedGroup(level: GroupEnvironmentLevel, population: number, telegramMembers = 1) {
  return {
    id: 'g1',
    telegramGroupId: GROUP_ID,
    title: 'منطقه',
    type: GroupType.SUPERGROUP,
    memberCount: telegramMembers,
    realMemberCount: telegramMembers,
    gamePopulation: population,
    environmentLevel: level,
    levelChangedAt: null as Date | null,
    ownerTelegramUserId: undefined
  }
}

/**
 * دوبلِ مخزن با رفتارِ **واقعیِ** نوشتارِ شرطی.
 *
 * سطح در یک حافظهٔ کوچک نگه داشته می‌شود و `updateEnvironment` فقط وقتی مهری
 * برمی‌گرداند که سطحِ هدف با سطحِ فعلی فرق کند — همان چیزی که در دیتابیس
 * رقابت را می‌بندد. با یک `mockResolvedValue(1)` ثابت، آزمون چیزی را می‌سنجید
 * که در مخزنِ واقعی وجود ندارد.
 */
function makeService(gamePopulation: number, memberInfo: MemberInfoProvider) {
  const stored = storedGroup(GroupEnvironmentLevel.VILLAGE, 0)
  let stamp = Date.parse('2026-09-20T12:00:00.000Z')
  const groupRepository = {
    findByTelegramGroupId: jest.fn().mockImplementation(async () => ({ ...stored })),
    findById: jest.fn().mockImplementation(async () => ({ ...stored })),
    upsert: jest.fn().mockImplementation(async (input: object) => ({ ...stored, ...input })),
    updateEnvironment: jest
      .fn()
      .mockImplementation(async (_id: string, population: number, level: GroupEnvironmentLevel) => {
        stored.gamePopulation = population
        if (stored.environmentLevel !== level) {
          stored.environmentLevel = level
          stamp += 1000
          stored.levelChangedAt = new Date(stamp)
          return { levelChanged: true, levelChangedAt: stored.levelChangedAt, changed: true }
        }
        return { levelChanged: false, levelChangedAt: null, changed: false }
      }),
    listPageAfter: jest.fn().mockResolvedValue([])
  }
  const playerGroupRepository = {
    upsert: jest.fn(),
    countActivePlayers: jest.fn().mockResolvedValue(gamePopulation)
  }
  const service = new GroupService(
    groupRepository as unknown as GroupRepository,
    playerGroupRepository as unknown as PlayerGroupRepository,
    { findByTelegramUserId: jest.fn() } as unknown as PlayerRepository,
    memberInfo,
    new EnvironmentClassifier()
  )
  /** سطح/جمعیتی که «در دیتابیس» نشسته است. */
  const setStored = (level: GroupEnvironmentLevel, population: number, telegramMembers = 1): void => {
    stored.environmentLevel = level
    stored.gamePopulation = population
    stored.memberCount = telegramMembers
    stored.realMemberCount = telegramMembers
    stored.levelChangedAt = null
  }
  return { service, groupRepository, setStored }
}

describe('EnvironmentClassifier — آستانه‌ها از تنظیمات مرکزی', () => {
  const classifier = new EnvironmentClassifier()

  test('مرزهای روستا/شهر/استان/کشور', () => {
    expect(classifier.classify(T.village.min)).toBe(GroupEnvironmentLevel.VILLAGE)
    expect(classifier.classify(T.village.max!)).toBe(GroupEnvironmentLevel.VILLAGE)
    expect(classifier.classify(T.city.min)).toBe(GroupEnvironmentLevel.CITY)
    expect(classifier.classify(T.city.max!)).toBe(GroupEnvironmentLevel.CITY)
    expect(classifier.classify(T.province.min)).toBe(GroupEnvironmentLevel.PROVINCE)
    expect(classifier.classify(T.province.max!)).toBe(GroupEnvironmentLevel.PROVINCE)
    expect(classifier.classify(T.country.min)).toBe(GroupEnvironmentLevel.COUNTRY)
    expect(classifier.classify(10_000)).toBe(GroupEnvironmentLevel.COUNTRY)
  })

  test('ورودی نامعتبر رد می‌شود', () => {
    expect(() => classifier.classify(-1)).toThrow()
    expect(() => classifier.classify(1.5)).toThrow()
  })
})

describe('گذارِ سطح با جمعیتِ بازی', () => {
  test('گروهی با ۵۰۰ عضوِ تلگرام و صفر شهروند، روستا می‌ماند', async () => {
    // ریشهٔ ایراد: عضوی که شخصیت نساخته شهروند نیست. عدد تلگرام نباید سطح بسازد.
    const { service, setStored } = makeService(0, provider(500))
    setStored(GroupEnvironmentLevel.VILLAGE, 0, 500)

    const { group } = await service.ensureGroupUpdated({
      telegramGroupId: GROUP_ID,
      title: 'منطقه',
      type: GroupType.SUPERGROUP
    })

    expect(group.environmentLevel).toBe(GroupEnvironmentLevel.VILLAGE)
    expect(group.realMemberCount).toBe(500)
  })

  test('۱۴ → ۱۵ گذار به شهر', async () => {
    const { service, setStored } = makeService(T.city.min, provider(15))
    setStored(GroupEnvironmentLevel.VILLAGE, 14)

    const out = await service.refreshEnvironmentLevel('g1')

    expect(out.environmentLevel).toBe(GroupEnvironmentLevel.CITY)
    expect(out.levelChangedFrom).toBe(GroupEnvironmentLevel.VILLAGE)
    expect(out.levelChangedAt).toBeInstanceOf(Date)
  })

  test('۱۵ → ۱۴ بازگشت به روستا', async () => {
    const { service, setStored } = makeService(T.village.max!, provider(15))
    setStored(GroupEnvironmentLevel.CITY, 15)

    const out = await service.refreshEnvironmentLevel('g1')

    expect(out.environmentLevel).toBe(GroupEnvironmentLevel.VILLAGE)
    expect(out.levelChangedFrom).toBe(GroupEnvironmentLevel.CITY)
  })

  test('۵۱ شهروند گذار به کشور', async () => {
    const { service, setStored } = makeService(T.country.min, provider(51))
    setStored(GroupEnvironmentLevel.PROVINCE, 50)

    const out = await service.refreshEnvironmentLevel('g1')

    expect(out.environmentLevel).toBe(GroupEnvironmentLevel.COUNTRY)
  })

  test('گذار تکرارناپذیر است: نوشتنِ دوم تغییری گزارش نمی‌کند', async () => {
    const { service, setStored } = makeService(T.city.min, provider(15))
    setStored(GroupEnvironmentLevel.VILLAGE, 14)

    const first = await service.refreshEnvironmentLevel('g1')
    const second = await service.refreshEnvironmentLevel('g1')

    expect(first.levelChangedFrom).toBe(GroupEnvironmentLevel.VILLAGE)
    expect(first.levelChangedAt).toBeInstanceOf(Date)
    expect(second.levelChangedFrom).toBeNull()
    expect(second.levelChangedAt).toBeNull()
  })
})

describe('پنل اطلاعات منطقه', () => {
  const render = (level: GroupEnvironmentLevel, population: number, telegram: number) =>
    renderGroupInfoPanel({
      isGroup: true,
      registered: true,
      created: false,
      group: { ...storedGroup(level, population, telegram), status: GroupStatus.ACTIVE, createdAt: new Date() } as never,
      environmentLevel: level,
      environmentLabel: null,
      memberCountSynced: true,
      syncFailed: false
    })

  test('سطحِ نمایش‌داده‌شده از خودِ ردیف می‌آید، نه از یک متن ثابت', () => {
    expect(render(GroupEnvironmentLevel.VILLAGE, 3, 40)).toContain('روستا')
    expect(render(GroupEnvironmentLevel.CITY, 20, 40)).toContain('شهر')
    expect(render(GroupEnvironmentLevel.COUNTRY, 80, 900)).toContain('کشور')
  })

  test('پنل روستا هیچ وعدهٔ شهری نمی‌دهد', () => {
    const out = render(GroupEnvironmentLevel.VILLAGE, 3, 40)
    expect(out).not.toContain('شهردار')
  })

  test('شهروندان بازی و اعضای تلگرام دو عدد جدا و برچسب‌دارند', () => {
    const out = render(GroupEnvironmentLevel.VILLAGE, 3, 40)
    expect(out).toContain('شهروندان بازی')
    expect(out).toContain('اعضای تلگرام')
  })

  test('توضیح پنل می‌گوید اعضای تلگرام در تعیین سطح نقشی ندارند', () => {
    const out = render(GroupEnvironmentLevel.CITY, 20, 40)
    expect(out).toContain('عضویت فعال')
  })
})
