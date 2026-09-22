import { PrismaClient, GameEventType } from '@prisma/client'
import { RegionService } from '../src/modules/city/region.service'
import { EventService } from '../src/modules/events/event.service'
import { NotFoundError } from '../src/utils/classes/errors'

function makeDb(overrides: Record<string, unknown> = {}) {
  return {
    group: { findUnique: jest.fn() },
    playerGroup: { findMany: jest.fn().mockResolvedValue([]) },
    player: {
      count: jest.fn().mockResolvedValue(0),
      aggregate: jest.fn().mockResolvedValue({ _sum: { balance: null } })
    },
    bankAccount: { aggregate: jest.fn().mockResolvedValue({ _sum: { balance: null } }) },
    business: { count: jest.fn().mockResolvedValue(0) },
    property: { count: jest.fn().mockResolvedValue(0) },
    loan: { aggregate: jest.fn().mockResolvedValue({ _sum: { remainingAmount: null } }) },
    financialTransaction: {
      aggregate: jest.fn().mockResolvedValue({ _sum: { amount: null }, _count: { _all: 0 } })
    },
    regionStat: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn()
    },
    ...overrides
  }
}

function statFrom(partial: Record<string, unknown> = {}) {
  return {
    population: 0,
    employed: 0,
    companies: 0,
    properties: 0,
    totalWealth: 0,
    bankDeposits: 0,
    totalDebt: 0,
    averageIncome: 0,
    educatedCount: 0,
    transactionVolume: 0,
    transactionCount: 0,
    taxRevenue: 0,
    economicIndex: 0,
    previousIndex: 0,
    refreshedAt: new Date(),
    ...partial
  }
}

function makeEventService() {
  return {
    recordRegionEvent: jest.fn().mockResolvedValue(undefined),
    recordPlayerEvent: jest.fn().mockResolvedValue(undefined)
  }
}

describe('RegionService', () => {
  test('throws for an unregistered group', async () => {
    const db = makeDb()
    db.group.findUnique.mockResolvedValue(null)
    const service = new RegionService(
      db as unknown as PrismaClient,
      makeEventService() as unknown as EventService
    )

    await expect(service.getState(-100n)).rejects.toThrow(NotFoundError)
  })

  test('reads a fresh stat row from the database cache', async () => {
    const db = makeDb()
    db.group.findUnique.mockResolvedValue({
      id: 'g1',
      title: 'شهر تست',
      environmentLevel: 'CITY',
      stat: statFrom({ population: 20, employed: 15, economicIndex: 55 })
    })
    const service = new RegionService(
      db as unknown as PrismaClient,
      makeEventService() as unknown as EventService
    )

    const state = await service.getState(-100n)

    expect(state.population).toBe(20)
    expect(state.employmentRate).toBe(75)
    expect(state.economicIndex).toBe(55)
    // آمار تازه بود، پس هیچ Aggregate سنگینی اجرا نشد
    expect(db.playerGroup.findMany).not.toHaveBeenCalled()
  })

  test('recomputes when the stat row is stale', async () => {
    const stale = statFrom({ refreshedAt: new Date(Date.now() - 60 * 60 * 1000) })
    const db = makeDb()
    db.group.findUnique.mockResolvedValue({
      id: 'g1',
      title: 'شهر تست',
      environmentLevel: 'CITY',
      stat: stale
    })
    db.regionStat.upsert.mockResolvedValue(statFrom())
    const service = new RegionService(
      db as unknown as PrismaClient,
      makeEventService() as unknown as EventService
    )

    await service.getState(-100n)

    expect(db.playerGroup.findMany).toHaveBeenCalledTimes(1)
    expect(db.regionStat.upsert).toHaveBeenCalledTimes(1)
  })

  test('an empty region persists zeros without heavy aggregates', async () => {
    const db = makeDb()
    db.group.findUnique.mockResolvedValue({
      id: 'g1',
      title: 'شهر خالی',
      environmentLevel: 'VILLAGE',
      stat: null
    })
    db.regionStat.upsert.mockResolvedValue(statFrom())
    const service = new RegionService(
      db as unknown as PrismaClient,
      makeEventService() as unknown as EventService
    )

    const state = await service.getState(-100n)

    expect(state.population).toBe(0)
    expect(state.economicIndex).toBe(0)
    expect(db.player.aggregate).not.toHaveBeenCalled()
  })

  test('economic index stays inside 0..100 even with huge numbers', async () => {
    const db = makeDb()
    db.group.findUnique.mockResolvedValue({
      id: 'g1',
      title: 'ابرشهر',
      environmentLevel: 'COUNTRY',
      stat: null
    })
    db.playerGroup.findMany.mockResolvedValue(
      Array.from({ length: 100 }, (_, i) => ({ playerId: `p${i}` }))
    )
    db.player.count.mockResolvedValue(100)
    db.player.aggregate.mockResolvedValue({ _sum: { balance: 9_000_000_000_000 } })
    db.bankAccount.aggregate.mockResolvedValue({ _sum: { balance: 9_000_000_000_000 } })
    db.business.count.mockResolvedValue(500)
    db.property.count.mockResolvedValue(900)
    db.financialTransaction.aggregate.mockResolvedValue({
      _sum: { amount: 9_000_000_000_000 },
      _count: { _all: 90_000 }
    })
    db.regionStat.upsert.mockImplementation(({ create }: { create: Record<string, unknown> }) =>
      Promise.resolve(statFrom(create))
    )
    const service = new RegionService(
      db as unknown as PrismaClient,
      makeEventService() as unknown as EventService
    )

    const state = await service.getState(-100n)

    expect(state.economicIndex).toBeGreaterThanOrEqual(0)
    expect(state.economicIndex).toBeLessThanOrEqual(100)
  })

  test('smoothing prevents a sudden index jump', async () => {
    const db = makeDb()
    db.group.findUnique.mockResolvedValue({
      id: 'g1',
      title: 'شهر تست',
      environmentLevel: 'CITY',
      stat: null
    })
    db.playerGroup.findMany.mockResolvedValue([{ playerId: 'p1' }, { playerId: 'p2' }])
    db.player.count.mockResolvedValue(2)
    db.player.aggregate.mockResolvedValue({ _sum: { balance: 500_000_000 } })
    db.bankAccount.aggregate.mockResolvedValue({ _sum: { balance: 500_000_000 } })
    db.business.count.mockResolvedValue(10)
    db.property.count.mockResolvedValue(10)
    db.financialTransaction.aggregate.mockResolvedValue({
      _sum: { amount: 500_000_000 },
      _count: { _all: 100 }
    })
    // شاخص قبلی پایین بود
    db.regionStat.findUnique.mockResolvedValue({ economicIndex: 10 })
    let persisted: Record<string, unknown> = {}
    db.regionStat.upsert.mockImplementation(({ create }: { create: Record<string, unknown> }) => {
      persisted = create
      return Promise.resolve(statFrom(create))
    })
    const service = new RegionService(
      db as unknown as PrismaClient,
      makeEventService() as unknown as EventService
    )

    await service.getState(-100n)

    // با هموارسازی ۳۰٪، شاخص جدید نباید یک‌باره به مقدار خام برسد
    expect(Number(persisted.economicIndex)).toBeLessThan(60)
    expect(Number(persisted.previousIndex)).toBe(10)
  })

  test('emits a population milestone event', async () => {
    const events = makeEventService()
    const db = makeDb()
    db.group.findUnique.mockResolvedValue({
      id: 'g1',
      title: 'شهر تست',
      environmentLevel: 'CITY',
      stat: null
    })
    db.playerGroup.findMany.mockResolvedValue(
      Array.from({ length: 30 }, (_, i) => ({ playerId: `p${i}` }))
    )
    db.player.count.mockResolvedValue(20)
    db.regionStat.upsert.mockResolvedValue(statFrom({ population: 30 }))
    const service = new RegionService(
      db as unknown as PrismaClient,
      events as unknown as EventService
    )

    await service.getState(-100n)

    const calls = events.recordRegionEvent.mock.calls.map((c) => c[0].type)
    expect(calls).toContain(GameEventType.REGION_POPULATION_MILESTONE)
  })

  test('tax revenue is a real fund: transaction volume never invents it', async () => {
    const db = makeDb()
    db.group.findUnique.mockResolvedValue({
      id: 'g1',
      title: 'شهر تست',
      environmentLevel: 'CITY',
      stat: null
    })
    db.playerGroup.findMany.mockResolvedValue([{ playerId: 'p1' }])
    db.player.count.mockResolvedValue(1)
    db.financialTransaction.aggregate.mockResolvedValue({
      _sum: { amount: 100_000_000 },
      _count: { _all: 50 }
    })
    let persisted: Record<string, unknown> = {}
    db.regionStat.upsert.mockImplementation(({ create }: { create: Record<string, unknown> }) => {
      persisted = create
      return Promise.resolve(statFrom(create))
    })
    const service = new RegionService(
      db as unknown as PrismaClient,
      makeEventService() as unknown as EventService
    )

    await service.getState(-100n)

    // گردش مالی هفته هیچ مالیاتی «تولید» نمی‌کند؛ صندوق فقط با پرداخت
    // واقعی مالیات/بلیت پر می‌شود، پس اینجا صفر است.
    expect(Number(persisted.taxRevenue)).toBe(0)
  })

  test('refreshing the region never wipes the tax fund', async () => {
    const db = makeDb()
    db.group.findUnique.mockResolvedValue({
      id: 'g1',
      title: 'شهر تست',
      environmentLevel: 'CITY',
      stat: null
    })
    db.playerGroup.findMany.mockResolvedValue([{ playerId: 'p1' }])
    db.player.count.mockResolvedValue(1)
    // صندوق از قبل ۳٬۰۰۰٬۰۰۰ تومان مالیات واقعی دارد
    db.regionStat.findUnique.mockResolvedValue(statFrom({ taxRevenue: 3_000_000 }))
    let persisted: Record<string, unknown> = {}
    db.regionStat.upsert.mockImplementation(({ create }: { create: Record<string, unknown> }) => {
      persisted = create
      return Promise.resolve(statFrom(create))
    })
    const service = new RegionService(
      db as unknown as PrismaClient,
      makeEventService() as unknown as EventService
    )

    await service.getState(-100n)

    expect(Number(persisted.taxRevenue)).toBe(3_000_000)
  })

  test('an empty region keeps its tax fund, too', async () => {
    const db = makeDb()
    db.group.findUnique.mockResolvedValue({
      id: 'g1',
      title: 'شهر تست',
      environmentLevel: 'CITY',
      stat: null
    })
    db.playerGroup.findMany.mockResolvedValue([]) // منطقه هیچ عضو فعالی ندارد
    db.regionStat.findUnique.mockResolvedValue(statFrom({ taxRevenue: 250_000 }))
    let persisted: Record<string, unknown> = {}
    db.regionStat.upsert.mockImplementation(({ create }: { create: Record<string, unknown> }) => {
      persisted = create
      return Promise.resolve(statFrom(create))
    })
    const service = new RegionService(
      db as unknown as PrismaClient,
      makeEventService() as unknown as EventService
    )

    await service.getState(-100n)

    expect(Number(persisted.taxRevenue)).toBe(250_000)
  })
})
