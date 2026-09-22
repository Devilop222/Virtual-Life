import { PrismaClient } from '@prisma/client'
import { MissionService } from '../src/modules/missions/mission.service'
import { RankingService } from '../src/modules/ranking/ranking.service'
import { NotFoundError } from '../src/utils/classes/errors'

function makeMissionDb(player: Record<string, unknown> | null, overrides: Record<string, unknown> = {}) {
  return {
    // count روی player پاسخ تعریف اشتغال است (۰ = بیکار)
    player: {
      findUnique: jest.fn().mockResolvedValue(player),
      count: jest.fn().mockResolvedValue(0)
    },
    bankAccount: { aggregate: jest.fn().mockResolvedValue({ _sum: { balance: null } }) },
    property: { count: jest.fn().mockResolvedValue(0) },
    business: { findMany: jest.fn().mockResolvedValue([]) },
    businessEmployee: { count: jest.fn().mockResolvedValue(0) },
    loan: { aggregate: jest.fn().mockResolvedValue({ _sum: { remainingAmount: null } }) },
    playerInventory: { count: jest.fn().mockResolvedValue(0) },
    ...overrides
  }
}

const BASE_PLAYER = {
  id: 'p1',
  age: 20,
  balance: 0,
  health: 100,
  fatigue: 0,
  experience: 0,
  currentDegree: 'DIPLOMA',
  isEnrolled: false
}

describe('MissionService', () => {
  test('throws when the player does not exist', async () => {
    const db = makeMissionDb(null)
    const service = new MissionService(db as unknown as PrismaClient)

    await expect(service.getMissionBoard(1n)).rejects.toThrow(NotFoundError)
  })

  test('a fresh player gets beginner missions only', async () => {
    const db = makeMissionDb(BASE_PLAYER)
    const service = new MissionService(db as unknown as PrismaClient)

    const board = await service.getMissionBoard(1n)

    expect(board.missions.length).toBeGreaterThan(0)
    expect(board.missions.length).toBeLessThanOrEqual(4)
    expect(board.missions.every((m) => !m.done)).toBe(true)
    // ماموریت‌های پیشرفتهٔ شرکت نباید برای بازیکن تازه باز شود
    expect(board.missions.map((m) => m.key)).not.toContain('hire_employee')
    expect(board.missions.map((m) => m.key)).not.toContain('upgrade_company')
  })

  test('marks completed missions and counts them', async () => {
    const db = makeMissionDb(
      { ...BASE_PLAYER, balance: 200_000_000, experience: 500 },
      {
        bankAccount: {
          aggregate: jest.fn().mockResolvedValue({ _sum: { balance: 50_000_000 } })
        },
        property: { count: jest.fn().mockResolvedValue(2) }
      }
    )
    const service = new MissionService(db as unknown as PrismaClient)

    const board = await service.getMissionBoard(1n)

    expect(board.completedCount).toBeGreaterThan(0)
    expect(board.totalTracked).toBeGreaterThan(board.completedCount - 1)
  })

  test('offers a health mission when health is low', async () => {
    const db = makeMissionDb({ ...BASE_PLAYER, health: 40 })
    const service = new MissionService(db as unknown as PrismaClient)

    const board = await service.getMissionBoard(1n)
    const keys = board.missions.map((m) => m.key)

    expect(keys).toContain('recover_health')
  })

  test('offers a fatigue mission when fatigue is high', async () => {
    const db = makeMissionDb({ ...BASE_PLAYER, fatigue: 80 })
    const service = new MissionService(db as unknown as PrismaClient)

    const board = await service.getMissionBoard(1n)
    const keys = board.missions.map((m) => m.key)

    expect(keys).toContain('reduce_fatigue')
  })

  test('offers company missions to a business owner', async () => {
    const db = makeMissionDb(
      { ...BASE_PLAYER, experience: 200, balance: 50_000_000 },
      {
        business: { findMany: jest.fn().mockResolvedValue([{ id: 'b1', level: 1 }]) },
        businessEmployee: { count: jest.fn().mockResolvedValue(1) },
        bankAccount: {
          aggregate: jest.fn().mockResolvedValue({ _sum: { balance: 20_000_000 } })
        }
      }
    )
    const service = new MissionService(db as unknown as PrismaClient)

    const board = await service.getMissionBoard(1n)
    const keys = board.missions.map((m) => m.key)

    expect(keys).toContain('hire_employee')
    expect(keys).not.toContain('found_company')
  })

  test('offers a debt mission when a loan is active', async () => {
    const db = makeMissionDb(BASE_PLAYER, {
      loan: { aggregate: jest.fn().mockResolvedValue({ _sum: { remainingAmount: 5_000_000 } }) }
    })
    const service = new MissionService(db as unknown as PrismaClient)

    const board = await service.getMissionBoard(1n)
    expect(board.missions.map((m) => m.key)).toContain('repay_loan')
  })

  test('every mission has persian text and a valid difficulty', async () => {
    const db = makeMissionDb(BASE_PLAYER)
    const service = new MissionService(db as unknown as PrismaClient)

    const board = await service.getMissionBoard(1n)
    for (const mission of board.missions) {
      expect(/[\u0600-\u06FF]/.test(mission.title)).toBe(true)
      expect(/[\u0600-\u06FF]/.test(mission.description)).toBe(true)
      expect([1, 2, 3]).toContain(mission.difficulty)
      expect(mission.target).toBeGreaterThan(0)
    }
  })
})

function makeRankingDb(overrides: Record<string, unknown> = {}) {
  return {
    group: { findUnique: jest.fn().mockResolvedValue({ id: 'g1' }) },
    playerGroup: { findMany: jest.fn().mockResolvedValue([{ playerId: 'p1' }, { playerId: 'p2' }]) },
    player: { findMany: jest.fn().mockResolvedValue([]) },
    property: { groupBy: jest.fn().mockResolvedValue([]) },
    regionStat: { findMany: jest.fn().mockResolvedValue([]) },
    rankingSnapshot: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({})
    },
    ...overrides
  }
}

describe('RankingService', () => {
  test('throws for an unregistered group', async () => {
    const db = makeRankingDb({ group: { findUnique: jest.fn().mockResolvedValue(null) } })
    const service = new RankingService(db as unknown as PrismaClient)

    await expect(service.getGroupRanking(-100n, 'wealth')).rejects.toThrow(NotFoundError)
  })

  test('computes a wealth ranking and stores a snapshot', async () => {
    const db = makeRankingDb({
      player: {
        findMany: jest.fn().mockResolvedValue([
          { firstName: 'علی', lastName: null, balance: 900, experience: 10 },
          { firstName: 'رضا', lastName: 'م', balance: 500, experience: 5 }
        ])
      }
    })
    const service = new RankingService(db as unknown as PrismaClient)

    const result = await service.getGroupRanking(-100n, 'wealth', 0)

    expect(result.scope).toBe('group')
    expect(result.rows[0]?.rank).toBe(1)
    expect(result.rows[0]?.name).toBe('علی')
    expect(result.cached).toBe(false)
    expect(db.rankingSnapshot.create).toHaveBeenCalledTimes(1)
  })

  test('reads a fresh snapshot from cache without recomputing', async () => {
    const rows = [{ rank: 1, name: 'علی', value: '۹۰۰ تومان', raw: 900 }]
    const db = makeRankingDb({
      rankingSnapshot: {
        findFirst: jest.fn().mockResolvedValue({
          id: 's1',
          payload: rows,
          computedAt: new Date()
        }),
        create: jest.fn(),
        update: jest.fn()
      }
    })
    const service = new RankingService(db as unknown as PrismaClient)

    const result = await service.getGlobalPlayerRanking('wealth', 0)

    expect(result.cached).toBe(true)
    expect(result.rows).toHaveLength(1)
    expect(db.player.findMany).not.toHaveBeenCalled()
  })

  test('an empty group returns no rows without extra queries', async () => {
    const db = makeRankingDb({ playerGroup: { findMany: jest.fn().mockResolvedValue([]) } })
    const service = new RankingService(db as unknown as PrismaClient)

    const result = await service.getGroupRanking(-100n, 'wealth', 0)

    expect(result.rows).toHaveLength(0)
    expect(result.total).toBe(0)
    expect(db.player.findMany).not.toHaveBeenCalled()
  })

  test('region ranking reads the aggregated region stats table', async () => {
    const db = makeRankingDb({
      regionStat: {
        findMany: jest.fn().mockResolvedValue([
          { population: 30, totalWealth: 5_000_000, economicIndex: 60, group: { title: 'شهر الف' } },
          { population: 10, totalWealth: 1_000_000, economicIndex: 30, group: { title: 'شهر ب' } }
        ])
      }
    })
    const service = new RankingService(db as unknown as PrismaClient)

    const result = await service.getRegionRanking('region_population', 0)

    expect(result.scope).toBe('region')
    expect(result.rows[0]?.name).toBe('شهر الف')
    expect(result.rows[0]?.value).toContain('بازیکن')
  })

  test('pagination slices the snapshot rows', async () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({
      rank: i + 1,
      name: `بازیکن ${i + 1}`,
      value: 'x',
      raw: 12 - i
    }))
    const db = makeRankingDb({
      rankingSnapshot: {
        findFirst: jest.fn().mockResolvedValue({ id: 's1', payload: rows, computedAt: new Date() }),
        create: jest.fn(),
        update: jest.fn()
      }
    })
    const service = new RankingService(db as unknown as PrismaClient)

    const page0 = await service.getGlobalPlayerRanking('wealth', 0)
    const page1 = await service.getGlobalPlayerRanking('wealth', 1)

    expect(page0.rows).toHaveLength(5)
    expect(page1.rows[0]?.rank).toBe(6)
    expect(page0.total).toBe(12)
  })
})
