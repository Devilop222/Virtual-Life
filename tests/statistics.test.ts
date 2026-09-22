import { PrismaClient } from '@prisma/client'
import { StatisticsService } from '../src/modules/statistics/statistics.service'
import { NotFoundError } from '../src/utils/classes/errors'

function makeDb(player: Record<string, unknown> | null, overrides: Record<string, unknown> = {}) {
  return {
    player: { findUnique: jest.fn().mockResolvedValue(player) },
    bankAccount: { aggregate: jest.fn().mockResolvedValue({ _sum: { balance: null } }) },
    property: { findMany: jest.fn().mockResolvedValue([]) },
    business: { findMany: jest.fn().mockResolvedValue([]) },
    loan: { aggregate: jest.fn().mockResolvedValue({ _sum: { remainingAmount: null } }) },
    workSession: {
      count: jest.fn().mockResolvedValue(0),
      aggregate: jest.fn().mockResolvedValue({ _sum: { earnedMoney: null } })
    },
    playerSkill: { count: jest.fn().mockResolvedValue(0) },
    financialTransaction: {
      aggregate: jest.fn().mockResolvedValue({ _sum: { amount: null } })
    },
    playerInventory: { findMany: jest.fn().mockResolvedValue([]) },
    gameEvent: { count: jest.fn().mockResolvedValue(0) },
    ...overrides
  }
}

const FRESH_PLAYER = {
  id: 'p1',
  age: 18,
  balance: 0,
  health: 100,
  fatigue: 0,
  experience: 0,
  currentDegree: 'DIPLOMA',
  graduationField: null,
  isEnrolled: false,
  startedAt: new Date(),
  homeGroup: null,
  // شغل از این سه رابطه استخراج می‌شود، نه از occupationId
  workSessions: [],
  employments: [],
  ownedBusinesses: []
}

function findStat(
  stats: Awaited<ReturnType<StatisticsService['getPlayerStatistics']>>,
  label: string
) {
  for (const group of stats.groups) {
    const found = group.items.find((i) => i.label.includes(label))
    if (found) return found
  }
  return undefined
}

describe('StatisticsService — state awareness', () => {
  test('throws when the player does not exist', async () => {
    const db = makeDb(null)
    const service = new StatisticsService(db as unknown as PrismaClient)

    await expect(service.getPlayerStatistics(1n)).rejects.toThrow(NotFoundError)
  })

  test('a brand new player never sees a meaningless zero rank', async () => {
    const db = makeDb(FRESH_PLAYER)
    const service = new StatisticsService(db as unknown as PrismaClient)

    const stats = await service.getPlayerStatistics(1n)

    const eduRank = findStat(stats, 'رتبهٔ علمی')
    expect(eduRank?.state).toBe('unranked')
    expect(eduRank?.display).toBe('بدون رتبه')
    expect(eduRank?.display).not.toContain('۰')

    const wealthRank = findStat(stats, 'رتبهٔ ثروت')
    expect(wealthRank?.state).toBe('unranked')
    expect(wealthRank?.display).toBe('بدون رتبه')
  })

  test('unset text fields show a human message instead of empty output', async () => {
    const db = makeDb(FRESH_PLAYER)
    const service = new StatisticsService(db as unknown as PrismaClient)

    const stats = await service.getPlayerStatistics(1n)

    const job = findStat(stats, 'شغل')
    expect(job?.state).toBe('unset')
    expect(job?.display).toBe('هنوز شغلی نداری')

    const residence = findStat(stats, 'محل زندگی')
    expect(residence?.state).toBe('unset')
    expect(residence?.display).toBe('هنوز ثبت نشده')

    const field = findStat(stats, 'رشته')
    expect(field?.state).toBe('unset')
  })

  test('experience becomes ranked once the threshold is reached', async () => {
    const db = makeDb({ ...FRESH_PLAYER, experience: 120 })
    const service = new StatisticsService(db as unknown as PrismaClient)

    const stats = await service.getPlayerStatistics(1n)

    const expRank = findStat(stats, 'رتبهٔ تجربه')
    expect(expRank?.state).toBe('ranked')
    expect(expRank?.display).toBe('واجد شرایط رتبه‌بندی')
  })

  test('education rank unlocks from associate degree upward', async () => {
    const db = makeDb({ ...FRESH_PLAYER, currentDegree: 'BACHELOR' })
    const service = new StatisticsService(db as unknown as PrismaClient)

    const stats = await service.getPlayerStatistics(1n)
    expect(findStat(stats, 'رتبهٔ علمی')?.state).toBe('ranked')
  })

  test('net worth subtracts debt and never double counts treasury', async () => {
    const db = makeDb(
      { ...FRESH_PLAYER, balance: 20_000_000 },
      {
        bankAccount: { aggregate: jest.fn().mockResolvedValue({ _sum: { balance: 10_000_000 } }) },
        property: { findMany: jest.fn().mockResolvedValue([{ baseAssetValue: 30_000_000 }]) },
        business: {
          findMany: jest.fn().mockResolvedValue([{ level: 1, treasury: 5_000_000 }])
        },
        loan: {
          aggregate: jest.fn().mockResolvedValue({ _sum: { remainingAmount: 15_000_000 } })
        }
      }
    )
    const service = new StatisticsService(db as unknown as PrismaClient)

    const stats = await service.getPlayerStatistics(1n)

    // نقد ۲۰م + بانک ۱۰م + ملک ۳۰م + شرکت (۵م خزانه + ۱۰م سطح) − بدهی ۱۵م
    expect(stats.netWorth).toBe(60_000_000)
  })

  test('negative net worth is explained instead of shown as a raw number', async () => {
    const db = makeDb(FRESH_PLAYER, {
      loan: { aggregate: jest.fn().mockResolvedValue({ _sum: { remainingAmount: 5_000_000 } }) }
    })
    const service = new StatisticsService(db as unknown as PrismaClient)

    const stats = await service.getPlayerStatistics(1n)
    const netWorth = findStat(stats, 'خالص دارایی')

    expect(netWorth?.hint).toBe('بدهی‌ات از دارایی‌ات بیشتر است')
    expect(stats.netWorth).toBe(-5_000_000)
  })

  test('inventory value uses the current market price', async () => {
    const db = makeDb(FRESH_PLAYER, {
      playerInventory: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ quantity: 3, item: { price: 10_000, priceMultiplier: 1.5 } }])
      }
    })
    const service = new StatisticsService(db as unknown as PrismaClient)

    const stats = await service.getPlayerStatistics(1n)
    const inventory = findStat(stats, 'ارزش انبار')

    expect(inventory?.raw).toBe(45_000)
  })

  test('money tiers escalate with wealth', async () => {
    const poor = makeDb({ ...FRESH_PLAYER, balance: 500_000 })
    const rich = makeDb({ ...FRESH_PLAYER, balance: 200_000_000 })

    const poorStats = await new StatisticsService(
      poor as unknown as PrismaClient
    ).getPlayerStatistics(1n)
    const richStats = await new StatisticsService(
      rich as unknown as PrismaClient
    ).getPlayerStatistics(1n)

    expect(findStat(poorStats, 'پول نقد')?.state).toBe('growing')
    expect(findStat(richStats, 'پول نقد')?.state).toBe('elite')
  })

  test('every visible stat has persian text and no raw enum leaks', async () => {
    const db = makeDb({ ...FRESH_PLAYER, occupation: { name: 'کارگر' } })
    const service = new StatisticsService(db as unknown as PrismaClient)

    const stats = await service.getPlayerStatistics(1n)

    for (const group of stats.groups) {
      expect(/[\u0600-\u06FF]/.test(group.title)).toBe(true)
      for (const item of group.items) {
        expect(item.display.length).toBeGreaterThan(0)
        expect(item.display).not.toContain('undefined')
        expect(item.display).not.toContain('null')
        expect(item.display).not.toMatch(/^[A-Z_]+$/)
      }
    }
  })

  test('counts show a friendly message when nothing happened yet', async () => {
    const db = makeDb(FRESH_PLAYER)
    const service = new StatisticsService(db as unknown as PrismaClient)

    const stats = await service.getPlayerStatistics(1n)

    expect(findStat(stats, 'نوبت‌های کاری')?.display).toBe('هنوز کار نکرده‌ای')
    expect(findStat(stats, 'مهارت‌ها')?.display).toBe('هنوز مهارتی نیاموخته‌ای')
    expect(findStat(stats, '🏢 کسب‌وکار')?.display).toBe('کسب‌وکاری نداری')
  })

  test('groups cover every required category', async () => {
    const db = makeDb(FRESH_PLAYER)
    const service = new StatisticsService(db as unknown as PrismaClient)

    const stats = await service.getPlayerStatistics(1n)
    const titles = stats.groups.map((g) => g.title)

    expect(titles).toEqual(
      expect.arrayContaining([
        'اطلاعات کلی',
        'وضعیت اقتصادی',
        'جریان مالی',
        'وضعیت علمی',
        'وضعیت شغلی',
        'تجربه و مهارت',
        'رتبه‌بندی',
        'سابقهٔ فعالیت'
      ])
    )
  })
})
