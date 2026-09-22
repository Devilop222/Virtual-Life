import { GroupEnvironmentLevel, GroupType, PlayerGroupRole } from '@prisma/client'
import { GroupService, MemberInfoProvider, getLocalRoleTitle } from '../src/modules/groups/group.service'
import { EnvironmentClassifier } from '../src/modules/groups/environment.classifier'
import { GroupRepository } from '../src/database/repositories/group.repository'
import { PlayerGroupRepository } from '../src/database/repositories/player-group.repository'
import { PlayerRepository } from '../src/database/repositories/player.repository'

const GROUP_ID = -100123456789n

function makeFakeProvider(realCount: number): MemberInfoProvider {
  return {
    getMemberInfo: jest.fn().mockResolvedValue({
      totalCount: realCount,
      realMemberCount: realCount,
      ownerTelegramUserId: undefined,
      adminTelegramUserIds: []
    })
  }
}

interface Harness {
  service: GroupService
  groupRepository: {
    findByTelegramGroupId: jest.Mock
    findById: jest.Mock
    upsert: jest.Mock
    updateEnvironment: jest.Mock
    listPageAfter: jest.Mock
  }
  playerGroupRepository: { upsert: jest.Mock; countActivePlayers: jest.Mock }
  playerRepository: { findByTelegramUserId: jest.Mock }
  /**
   * سطحِ «ذخیره‌شدهٔ» منطقه در حافظهٔ جعلی.
   *
   * مخزنِ واقعی یک نوشتارِ **شرطی** است: تا وقتی سطحِ ردیف با مقدارِ تازه فرق
   * نکند، ستون دست نمی‌خورد و مهری هم گرفته نمی‌شود. اگر جعلی سادهٔ
   * `mockResolvedValue(1)` بماند، آزمون چیزی را می‌سنجد که در دیتابیس وجود
   * ندارد — پس همین رفتار بازسازی می‌شود.
   */
  setStoredLevel: (id: string, level: GroupEnvironmentLevel, population?: number) => void
}

function makeGroupService(provider: MemberInfoProvider, gamePopulation = 0): Harness {
  const levels = new Map<string, GroupEnvironmentLevel>()
  const populations = new Map<string, number>()
  // مهرِ تغییر: هر تغییرِ واقعی یک مهرِ جلوتر می‌گیرد (مثل یک ستونِ زمانیِ
  // واقعی)، تا آزمون بتواند ثابت کند کلیدِ ضدتکرارِ دو تغییرِ پیاپی یکی نیست.
  let stamp = Date.parse('2026-09-20T12:00:00.000Z')

  const buildGroup = (id: string) => ({
    id,
    telegramGroupId: GROUP_ID,
    title: 'منطقه',
    type: GroupType.SUPERGROUP,
    memberCount: 1,
    realMemberCount: 1,
    gamePopulation: populations.get(id) ?? 0,
    environmentLevel: levels.get(id) ?? GroupEnvironmentLevel.VILLAGE,
    levelChangedAt: null,
    ownerTelegramUserId: undefined
  })

  const groupRepository = {
    findByTelegramGroupId: jest.fn().mockResolvedValue(null),
    findById: jest.fn().mockImplementation(async (id: string) => buildGroup(id)),
    upsert: jest.fn().mockImplementation((input: object) =>
      Promise.resolve({ ...buildGroup('group-1'), ...input })
    ),
    updateEnvironment: jest
      .fn()
      .mockImplementation(async (id: string, population: number, level: GroupEnvironmentLevel) => {
        populations.set(id, population)
        if ((levels.get(id) ?? GroupEnvironmentLevel.VILLAGE) !== level) {
          levels.set(id, level)
          stamp += 1000
          return { levelChanged: true, levelChangedAt: new Date(stamp), changed: true }
        }
        return { levelChanged: false, levelChangedAt: null, changed: false }
      }),
    listPageAfter: jest.fn().mockResolvedValue([])
  }
  const playerGroupRepository = {
    upsert: jest.fn(),
    countActivePlayers: jest.fn().mockResolvedValue(gamePopulation)
  }
  const playerRepository = {
    findByTelegramUserId: jest.fn()
  }

  const service = new GroupService(
    groupRepository as unknown as GroupRepository,
    playerGroupRepository as unknown as PlayerGroupRepository,
    playerRepository as unknown as PlayerRepository,
    provider,
    new EnvironmentClassifier()
  )

  return {
    service,
    groupRepository,
    playerGroupRepository,
    playerRepository,
    setStoredLevel: (id, level, population) => {
      levels.set(id, level)
      if (population !== undefined) {
        populations.set(id, population)
      }
    }
  }
}

describe('GroupService', () => {
  describe('ensureGroupUpdated — سطح محیط از جمعیتِ بازی می‌آید، نه از شمارِ اعضای تلگرام', () => {
    test('گروه تازه با ۲۰ عضوِ تلگرام ولی بدون شهروند، روستا است', async () => {
      // ریشهٔ باگ: عضوی که هیچ‌وقت شخصیت نساخته شهروندِ بازی نیست و نباید
      // منطقه را ارتقا بدهد. عدد تلگرام فقط ذخیره می‌شود.
      const { service, groupRepository } = makeGroupService(makeFakeProvider(20), 0)

      const { group } = await service.ensureGroupUpdated({
        telegramGroupId: GROUP_ID,
        title: 'گروه روستایی',
        type: GroupType.SUPERGROUP
      })

      expect(group.environmentLevel).toBe(GroupEnvironmentLevel.VILLAGE)
      expect(group.realMemberCount).toBe(20)
      expect(group.gamePopulation).toBe(0)
      // جمعیت/سطح جزو فیلدهای تلگرامی نیستند: تنها نویسنده‌شان بازمحاسبهٔ سطح است.
      expect(groupRepository.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ realMemberCount: 20 })
      )
      expect(groupRepository.upsert).toHaveBeenCalledWith(
        expect.not.objectContaining({ environmentLevel: expect.anything() })
      )
    })

    /** گروه موجود در دیتابیس؛ جمعیتش دوباره شمرده می‌شود. */
    const existingGroup = (level: GroupEnvironmentLevel, population: number) => ({
      id: 'group-1',
      telegramGroupId: GROUP_ID,
      title: 'منطقه',
      type: GroupType.SUPERGROUP,
      memberCount: 3,
      realMemberCount: 3,
      gamePopulation: population,
      environmentLevel: level,
      ownerTelegramUserId: undefined
    })

    test('۲۰ شهروندِ بازی منطقه را شهر می‌کند', async () => {
      const { service, groupRepository, setStoredLevel } = makeGroupService(makeFakeProvider(3), 20)
      setStoredLevel('group-1', GroupEnvironmentLevel.VILLAGE, 14)
      groupRepository.findByTelegramGroupId.mockResolvedValue(
        existingGroup(GroupEnvironmentLevel.VILLAGE, 14)
      )

      const { group } = await service.ensureGroupUpdated({
        telegramGroupId: GROUP_ID,
        title: 'منطقه',
        type: GroupType.SUPERGROUP
      })

      expect(group.environmentLevel).toBe(GroupEnvironmentLevel.CITY)
      expect(group.gamePopulation).toBe(20)
    })

    test('۶۰ شهروندِ بازی منطقه را کشور می‌کند — هرچند تلگرام ۲۰۰ عضو دارد', async () => {
      const { service, groupRepository, setStoredLevel } = makeGroupService(makeFakeProvider(200), 60)
      setStoredLevel('group-1', GroupEnvironmentLevel.CITY, 20)
      groupRepository.findByTelegramGroupId.mockResolvedValue(
        existingGroup(GroupEnvironmentLevel.CITY, 20)
      )

      const { group } = await service.ensureGroupUpdated({
        telegramGroupId: GROUP_ID,
        title: 'منطقه',
        type: GroupType.SUPERGROUP
      })

      expect(group.environmentLevel).toBe(GroupEnvironmentLevel.COUNTRY)
      expect(group.realMemberCount).toBe(200)
    })

    test('گروه تازه created است ولی environmentChanged نیست', async () => {
      // سطحِ گروهِ تازه یک مقدارِ آغازین است، نه یک «تغییر»؛ وگرنه هر ثبت
      // منطقه یک خبرِ «سطح عوض شد» بی‌معنا می‌ساخت.
      const { service } = makeGroupService(makeFakeProvider(30), 0)

      const result = await service.ensureGroupUpdated({
        telegramGroupId: GROUP_ID,
        title: 'گروه جدید',
        type: GroupType.SUPERGROUP
      })

      expect(result.created).toBe(true)
      expect(result.environmentChanged).toBe(false)
      expect(result.levelChangedFrom).toBeNull()
    })

    test('شمارِ خوانده‌نشدهٔ اعضا هرگز مقدار ذخیره‌شده را بازنویسی نمی‌کند', async () => {
      const provider: MemberInfoProvider = {
        getMemberInfo: jest.fn().mockResolvedValue({
          totalCount: null,
          realMemberCount: null,
          ownerTelegramUserId: undefined,
          adminTelegramUserIds: []
        })
      }
      const { service, groupRepository, setStoredLevel } = makeGroupService(provider, 40)
      setStoredLevel('group-1', GroupEnvironmentLevel.PROVINCE, 40)
      groupRepository.findByTelegramGroupId.mockResolvedValue({
        id: 'group-1',
        telegramGroupId: GROUP_ID,
        title: 'گروه قدیمی',
        type: GroupType.SUPERGROUP,
        memberCount: 300,
        realMemberCount: 298,
        gamePopulation: 40,
        environmentLevel: GroupEnvironmentLevel.PROVINCE,
        ownerTelegramUserId: undefined
      })

      const result = await service.ensureGroupUpdated({
        telegramGroupId: GROUP_ID,
        title: 'گروه قدیمی',
        type: GroupType.SUPERGROUP
      })

      expect(result.memberCountSynced).toBe(false)
      expect(result.group.environmentLevel).toBe(GroupEnvironmentLevel.PROVINCE)
      expect(groupRepository.upsert).not.toHaveBeenCalled()
    })

    test('جمعیتِ تازه‌ای که سطح را عوض می‌کند، ارتقا را گزارش می‌دهد', async () => {
      const { service, groupRepository, setStoredLevel } = makeGroupService(makeFakeProvider(15), 15)
      setStoredLevel('group-1', GroupEnvironmentLevel.VILLAGE, 14)
      groupRepository.findByTelegramGroupId.mockResolvedValue({
        id: 'group-1',
        telegramGroupId: GROUP_ID,
        title: 'گروه قدیمی',
        type: GroupType.SUPERGROUP,
        memberCount: 15,
        realMemberCount: 15,
        gamePopulation: 14,
        environmentLevel: GroupEnvironmentLevel.VILLAGE,
        ownerTelegramUserId: undefined
      })

      const result = await service.ensureGroupUpdated({
        telegramGroupId: GROUP_ID,
        title: 'گروه قدیمی',
        type: GroupType.SUPERGROUP
      })

      expect(result.environmentChanged).toBe(true)
      expect(result.levelChangedFrom).toBe(GroupEnvironmentLevel.VILLAGE)
      expect(result.levelChangedAt).toBeInstanceOf(Date)
      expect(result.group.environmentLevel).toBe(GroupEnvironmentLevel.CITY)
    })
  })

  describe('refreshEnvironmentLevel — گذارِ خودکارِ سطح محیط', () => {
    test('۱۴ → ۱۵ منطقه را از روستا به شهر می‌برد', async () => {
      const { service, groupRepository, setStoredLevel } = makeGroupService(makeFakeProvider(1), 15)
      setStoredLevel('group-1', GroupEnvironmentLevel.VILLAGE, 14)

      const out = await service.refreshEnvironmentLevel('group-1')

      expect(out.gamePopulation).toBe(15)
      expect(out.environmentLevel).toBe(GroupEnvironmentLevel.CITY)
      expect(out.levelChangedFrom).toBe(GroupEnvironmentLevel.VILLAGE)
      expect(out.levelChangedAt).toBeInstanceOf(Date)
      expect(out.changed).toBe(true)
      expect(groupRepository.updateEnvironment).toHaveBeenCalledWith(
        'group-1',
        15,
        GroupEnvironmentLevel.CITY
      )
    })

    test('۱۵ → ۱۴ منطقه را به روستا برمی‌گرداند', async () => {
      const { service, setStoredLevel } = makeGroupService(makeFakeProvider(1), 14)
      setStoredLevel('group-1', GroupEnvironmentLevel.CITY, 15)

      const out = await service.refreshEnvironmentLevel('group-1')

      expect(out.environmentLevel).toBe(GroupEnvironmentLevel.VILLAGE)
      expect(out.levelChangedFrom).toBe(GroupEnvironmentLevel.CITY)
      expect(out.levelChangedAt).toBeInstanceOf(Date)
    })

    test('۱۴ → ۱۶ بدون توقف در شهر، مستقیم استان می‌شود', async () => {
      const { service, setStoredLevel } = makeGroupService(makeFakeProvider(1), 16)
      setStoredLevel('group-1', GroupEnvironmentLevel.VILLAGE, 14)

      const out = await service.refreshEnvironmentLevel('group-1')

      expect(out.environmentLevel).toBe(GroupEnvironmentLevel.CITY)
      expect(out.levelChangedFrom).toBe(GroupEnvironmentLevel.VILLAGE)
    })

    test('بدون تغییر واقعی، نه نوشتاری هست و نه مهری', async () => {
      const { service, setStoredLevel } = makeGroupService(makeFakeProvider(1), 15)
      setStoredLevel('group-1', GroupEnvironmentLevel.CITY, 15)

      const out = await service.refreshEnvironmentLevel('group-1')

      expect(out.changed).toBe(false)
      expect(out.levelChangedFrom).toBeNull()
      expect(out.levelChangedAt).toBeNull()
    })

    test('نوشتنِ شرطی: دو بازمحاسبهٔ پیاپی، فقط یکی را «تغییر» می‌داند', async () => {
      // هم‌زمانی: `updateEnvironment` فقط وقتی ردیف را عوض می‌کند که مقدارش
      // فرق کند، پس ارتقای هم‌زمانِ چند فراخوانی یک خبر می‌سازد، نه چند خبر.
      const { service, groupRepository, setStoredLevel } = makeGroupService(makeFakeProvider(1), 15)
      setStoredLevel('group-1', GroupEnvironmentLevel.VILLAGE, 14)

      const first = await service.refreshEnvironmentLevel('group-1')
      const second = await service.refreshEnvironmentLevel('group-1')

      expect(first.changed).toBe(true)
      expect(first.levelChangedAt).toBeInstanceOf(Date)
      expect(second.changed).toBe(false)
      expect(second.levelChangedAt).toBeNull()
      expect(groupRepository.updateEnvironment).toHaveBeenCalledTimes(2)
    })

    test('شهر → روستا → شهر: تغییرِ دوباره هم گزارش می‌شود (مهرِ تازه، نه کلیدِ کهنه)', async () => {
      // ریشهٔ باگ: کلیدِ ضدتکرار از *سطحِ مقصد* ساخته می‌شد و در دیتابیس ابدی
      // است؛ پس منطقه‌ای که به شهر می‌رسید، برمی‌گشت و دوباره شهر می‌شد، برای
      // بارِ دوم هیچ خبر و هیچ اعلانی نمی‌گرفت. حالا هر تغییر مهرِ خودش را دارد.
      const { service, setStoredLevel, playerGroupRepository } = makeGroupService(
        makeFakeProvider(1),
        16
      )
      setStoredLevel('group-1', GroupEnvironmentLevel.VILLAGE, 14)
      const up1 = await service.refreshEnvironmentLevel('group-1')

      // جمعیت می‌افتد → تنزل
      playerGroupRepository.countActivePlayers.mockResolvedValue(14)
      setStoredLevel('group-1', GroupEnvironmentLevel.CITY, 16)
      const down = await service.refreshEnvironmentLevel('group-1')

      // و دوباره بالا می‌رود → باید خبرِ تازه بگیرد
      playerGroupRepository.countActivePlayers.mockResolvedValue(16)
      setStoredLevel('group-1', GroupEnvironmentLevel.VILLAGE, 14)
      const up2 = await service.refreshEnvironmentLevel('group-1')

      expect(up1.levelChangedFrom).toBe(GroupEnvironmentLevel.VILLAGE)
      expect(down.levelChangedFrom).toBe(GroupEnvironmentLevel.CITY)
      expect(up2.levelChangedFrom).toBe(GroupEnvironmentLevel.VILLAGE)
      // هر تغییر مهرِ خودش را دارد؛ پس کلیدِ ضدتکرارِ بارِ دوم با بارِ اول یکی نیست
      // و پیامِ واقعی بلعیده نمی‌شود.
      expect(up1.levelChangedAt).toBeInstanceOf(Date)
      expect(up2.levelChangedAt).toBeInstanceOf(Date)
      expect(up2.levelChangedAt?.getTime()).toBeGreaterThan(up1.levelChangedAt?.getTime() ?? 0)
    })

    test('گروهِ ناشناخته خطا می‌دهد', async () => {
      const { service, groupRepository } = makeGroupService(makeFakeProvider(1), 0)
      groupRepository.findById.mockResolvedValue(null)
      await expect(service.refreshEnvironmentLevel('nope')).rejects.toThrow()
    })
  })

  describe('linkPlayerToGroup', () => {
    test('creates many-to-many membership for registered player', async () => {
      const { service, playerRepository, playerGroupRepository, groupRepository } =
        makeGroupService(makeFakeProvider(10))

      playerRepository.findByTelegramUserId.mockResolvedValue({ id: 'player-1' })
      groupRepository.findByTelegramGroupId.mockResolvedValue({
        id: 'group-1',
        ownerTelegramUserId: 7n
      })
      playerGroupRepository.upsert.mockResolvedValue({ id: 'pg-1' })

      await service.linkPlayerToGroup(42n, GROUP_ID)

      // نقش عمداً نوشته نمی‌شود تا «ادمین گروه» (همگام‌شده از تلگرام)
      // با هر پیام به «عضو» تنزل نیابد؛ نقش رهبری فقط از تلگرام می‌آید
      expect(playerGroupRepository.upsert).toHaveBeenCalledWith({
        playerId: 'player-1',
        groupId: 'group-1',
        status: 'ACTIVE'
      })
    })

    test('group owner is always upserted with the OWNER role', async () => {
      const { service, playerRepository, playerGroupRepository, groupRepository } =
        makeGroupService(makeFakeProvider(10))

      playerRepository.findByTelegramUserId.mockResolvedValue({ id: 'player-1' })
      groupRepository.findByTelegramGroupId.mockResolvedValue({
        id: 'group-1',
        ownerTelegramUserId: 42n
      })
      playerGroupRepository.upsert.mockResolvedValue({ id: 'pg-1' })

      await service.linkPlayerToGroup(42n, GROUP_ID)

      expect(playerGroupRepository.upsert).toHaveBeenCalledWith({
        playerId: 'player-1',
        groupId: 'group-1',
        role: 'OWNER',
        status: 'ACTIVE'
      })
    })

    test('throws when player is not registered', async () => {
      const { service, playerRepository, groupRepository } = makeGroupService(makeFakeProvider(10))

      playerRepository.findByTelegramUserId.mockResolvedValue(null)
      groupRepository.findByTelegramGroupId.mockResolvedValue({ id: 'group-1' })

      await expect(service.linkPlayerToGroup(42n, GROUP_ID)).rejects.toThrow()
    })

    test('throws when group is not registered', async () => {
      const { service, playerRepository, groupRepository } = makeGroupService(makeFakeProvider(10))

      playerRepository.findByTelegramUserId.mockResolvedValue({ id: 'player-1' })
      groupRepository.findByTelegramGroupId.mockResolvedValue(null)

      await expect(service.linkPlayerToGroup(42n, GROUP_ID)).rejects.toThrow()
    })
  })

  describe('getLocalRoleTitle', () => {
    test('maps owners and admins to local leadership titles by environment level', () => {
      expect(getLocalRoleTitle(GroupEnvironmentLevel.VILLAGE, PlayerGroupRole.OWNER)).toBe('دهیار')
      expect(getLocalRoleTitle(GroupEnvironmentLevel.VILLAGE, PlayerGroupRole.ADMIN)).toBe('کدخدا')
      expect(getLocalRoleTitle(GroupEnvironmentLevel.CITY, PlayerGroupRole.OWNER)).toBe('شهردار')
      expect(getLocalRoleTitle(GroupEnvironmentLevel.PROVINCE, PlayerGroupRole.OWNER)).toBe('فرماندار')
      expect(getLocalRoleTitle(GroupEnvironmentLevel.COUNTRY, PlayerGroupRole.OWNER)).toBe('وزیر')
    })

    test('returns null for regular members', () => {
      expect(getLocalRoleTitle(GroupEnvironmentLevel.CITY, PlayerGroupRole.MEMBER)).toBeNull()
    })
  })
})
