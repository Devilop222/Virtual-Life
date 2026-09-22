import { PrismaClient } from '@prisma/client'
import {
  employedPlayerFilter,
  isPlayerEmployed,
  countEmployedPlayers,
  currentJobOf
} from '../src/modules/occupation/employment'
import { CreditService } from '../src/modules/finance/credit.service'
import { MissionService } from '../src/modules/missions/mission.service'
import { StatisticsService } from '../src/modules/statistics/statistics.service'
import { PlayerService } from '../src/modules/identity/player.service'
import { PlayerRepository } from '../src/database/repositories/player.repository'

describe('employedPlayerFilter — the single definition of "employed"', () => {
  const filter = employedPlayerFilter()

  test('an active work session counts as employment', () => {
    expect(filter.OR).toEqual(
      expect.arrayContaining([{ workSessions: { some: { status: 'ACTIVE' } } }])
    )
  })

  test('being hired by another business counts as employment', () => {
    expect(filter.OR).toEqual(
      expect.arrayContaining([{ employments: { some: { isActive: true } } }])
    )
  })

  test('owning an active business counts as self-employment', () => {
    expect(filter.OR).toEqual(
      expect.arrayContaining([{ ownedBusinesses: { some: { status: 'ACTIVE' } } }])
    )
  })

  test('recent completed work keeps a player employed for a week', () => {
    const now = Date.now()
    const recent = employedPlayerFilter(now).OR?.find(
      (clause) =>
        typeof clause === 'object' &&
        clause !== null &&
        'workSessions' in clause &&
        JSON.stringify(clause).includes('COMPLETED')
    )

    expect(recent).toBeDefined()
    const cutoff = JSON.parse(JSON.stringify(recent)).workSessions.some.endedAt.gte
    const days = (now - new Date(cutoff).getTime()) / (24 * 60 * 60 * 1000)
    expect(days).toBeCloseTo(7, 3)
  })

  test('the filter never reads occupationId, which is never written anywhere', () => {
    expect(JSON.stringify(filter)).not.toContain('occupation')
  })
})

describe('isPlayerEmployed / countEmployedPlayers', () => {
  function makeDb(count: number) {
    return { player: { count: jest.fn().mockResolvedValue(count) } }
  }

  test('a matching player is reported as employed', async () => {
    const db = makeDb(1)
    await expect(isPlayerEmployed(db as unknown as PrismaClient, 'p1')).resolves.toBe(true)
  })

  test('a non-matching player is reported as unemployed', async () => {
    const db = makeDb(0)
    await expect(isPlayerEmployed(db as unknown as PrismaClient, 'p1')).resolves.toBe(false)
  })

  test('an empty region never touches the database', async () => {
    const db = makeDb(5)
    await expect(countEmployedPlayers(db as unknown as PrismaClient, [])).resolves.toBe(0)
    expect(db.player.count).not.toHaveBeenCalled()
  })

  test('counting employed players uses a single query', async () => {
    const db = makeDb(3)
    const result = await countEmployedPlayers(db as unknown as PrismaClient, ['p1', 'p2', 'p3'])

    expect(result).toBe(3)
    expect(db.player.count).toHaveBeenCalledTimes(1)
  })
})

describe('currentJobOf', () => {
  test('no work history means no job', () => {
    expect(currentJobOf([])).toBeNull()
  })

  test('an active session is reported as active', () => {
    expect(currentJobOf([{ jobTitle: 'پیک', status: 'ACTIVE' }])).toEqual({
      title: 'پیک',
      isActive: true
    })
  })

  test('a finished session is reported as past work', () => {
    expect(currentJobOf([{ jobTitle: 'پیک', status: 'COMPLETED' }])).toEqual({
      title: 'پیک',
      isActive: false
    })
  })
})

describe('Employment is consistent across every panel', () => {
  test('credit score reflects real employment, not the unused occupationId', async () => {
    const base = {
      player: { findUnique: jest.fn(), count: jest.fn().mockResolvedValue(0) },
      bankAccount: { findMany: jest.fn().mockResolvedValue([]) },
      property: { findMany: jest.fn().mockResolvedValue([]) },
      business: { findMany: jest.fn().mockResolvedValue([]) },
      loan: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
      playerLoan: { count: jest.fn().mockResolvedValue(0) },
      financialTransaction: { count: jest.fn().mockResolvedValue(0) }
    }
    base.player.findUnique.mockResolvedValue({
      id: 'p1',
      status: 'ACTIVE',
      experience: 0,
      balance: 0
    })

    const unemployed = await new CreditService(
      base as unknown as PrismaClient
    ).getCreditProfile(1n)

    base.player.count.mockResolvedValue(1)
    const employed = await new CreditService(base as unknown as PrismaClient).getCreditProfile(1n)

    expect(unemployed.hasJob).toBe(false)
    expect(employed.hasJob).toBe(true)
    expect(employed.score).toBeGreaterThan(unemployed.score)
  })

  test('the first-job mission completes on real employment, not only on raw experience', async () => {
    const db = {
      player: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'p1',
          age: 20,
          balance: 0,
          health: 100,
          fatigue: 0,
          experience: 0,
          currentDegree: 'DIPLOMA',
          isEnrolled: false
        }),
        count: jest.fn().mockResolvedValue(1)
      },
      bankAccount: { aggregate: jest.fn().mockResolvedValue({ _sum: { balance: null } }) },
      property: { count: jest.fn().mockResolvedValue(0) },
      business: { findMany: jest.fn().mockResolvedValue([]) },
      businessEmployee: { count: jest.fn().mockResolvedValue(0) },
      loan: { aggregate: jest.fn().mockResolvedValue({ _sum: { remainingAmount: null } }) },
      playerInventory: { count: jest.fn().mockResolvedValue(0) }
    }

    const board = await new MissionService(db as unknown as PrismaClient).getMissionBoard(1n)

    expect(board.missions.map((m) => m.key)).not.toContain('first_job')
    expect(board.completedCount).toBeGreaterThan(0)
  })

  test('the statistics panel shows the active job title', async () => {
    const db = {
      player: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'p1',
          age: 20,
          balance: 0,
          health: 100,
          fatigue: 0,
          experience: 0,
          currentDegree: 'DIPLOMA',
          graduationField: null,
          isEnrolled: false,
          startedAt: new Date(),
          homeGroup: null,
          workSessions: [{ jobTitle: 'مکانیک خودرو', status: 'ACTIVE' }],
          employments: [],
          ownedBusinesses: []
        })
      },
      bankAccount: { aggregate: jest.fn().mockResolvedValue({ _sum: { balance: null } }) },
      property: { findMany: jest.fn().mockResolvedValue([]) },
      business: { findMany: jest.fn().mockResolvedValue([]) },
      loan: { aggregate: jest.fn().mockResolvedValue({ _sum: { remainingAmount: null } }) },
      workSession: {
        count: jest.fn().mockResolvedValue(1),
        aggregate: jest.fn().mockResolvedValue({ _sum: { earnedMoney: 100 } })
      },
      playerSkill: { count: jest.fn().mockResolvedValue(0) },
      financialTransaction: { aggregate: jest.fn().mockResolvedValue({ _sum: { amount: null } }) },
      playerInventory: { findMany: jest.fn().mockResolvedValue([]) },
      gameEvent: { count: jest.fn().mockResolvedValue(0) }
    }

    const stats = await new StatisticsService(db as unknown as PrismaClient).getPlayerStatistics(1n)
    const jobStat = stats.groups
      .flatMap((g) => g.items)
      .find((i) => i.label.includes('شغل'))

    expect(jobStat?.display).toContain('مکانیک خودرو')
    expect(jobStat?.state).not.toBe('unset')
  })

  test('the identity card prefers the active session over employment and ownership', async () => {
    const repo = {
      findByTelegramUserIdWithRelations: jest.fn().mockResolvedValue({
        telegramUserId: 1n,
        firstName: 'علی',
        lastName: null,
        username: null,
        gender: 'MALE',
        age: 20,
        startedAt: new Date(),
        lifeStage: 'YOUTH',
        biography: 'زندگی',
        maritalStatus: 'SINGLE',
        socialLevel: 'LOW',
        health: 100,
        fatigue: 0,
        experience: 0,
        balance: 0,
        currentDegree: 'DIPLOMA',
        graduationField: null,
        occupation: null,
        homeGroup: null,
        skills: [],
        groupMemberships: [],
        workSessions: [{ jobTitle: 'پیک', status: 'ACTIVE' }],
        employments: [{ title: 'حسابدار', business: { name: 'الف' } }],
        ownedBusinesses: [{ name: 'ب' }]
      })
    }

    const profile = await new PlayerService(
      repo as unknown as PlayerRepository
    ).getProfile(1n)

    expect(profile.jobTitle).toBe('پیک')
    expect(profile.isWorkingNow).toBe(true)
  })

  test('a business owner without any session is shown as an employer', async () => {
    const repo = {
      findByTelegramUserIdWithRelations: jest.fn().mockResolvedValue({
        telegramUserId: 1n,
        firstName: 'علی',
        lastName: null,
        username: null,
        gender: 'MALE',
        age: 20,
        startedAt: new Date(),
        lifeStage: 'YOUTH',
        biography: 'زندگی',
        maritalStatus: 'SINGLE',
        socialLevel: 'LOW',
        health: 100,
        fatigue: 0,
        experience: 0,
        balance: 0,
        currentDegree: 'DIPLOMA',
        graduationField: null,
        occupation: null,
        homeGroup: null,
        skills: [],
        groupMemberships: [],
        workSessions: [],
        employments: [],
        ownedBusinesses: [{ name: 'کافه من' }]
      })
    }

    const profile = await new PlayerService(repo as unknown as PlayerRepository).getProfile(1n)

    expect(profile.jobTitle).toContain('کافه من')
    expect(profile.isWorkingNow).toBe(false)
  })

  test('a player with no work history at all is unemployed', async () => {
    const repo = {
      findByTelegramUserIdWithRelations: jest.fn().mockResolvedValue({
        telegramUserId: 1n,
        firstName: 'علی',
        lastName: null,
        username: null,
        gender: 'MALE',
        age: 20,
        startedAt: new Date(),
        lifeStage: 'YOUTH',
        biography: 'زندگی',
        maritalStatus: 'SINGLE',
        socialLevel: 'LOW',
        health: 100,
        fatigue: 0,
        experience: 0,
        balance: 0,
        currentDegree: 'DIPLOMA',
        graduationField: null,
        occupation: null,
        homeGroup: null,
        skills: [],
        groupMemberships: [],
        workSessions: [],
        employments: [],
        ownedBusinesses: []
      })
    }

    const profile = await new PlayerService(repo as unknown as PlayerRepository).getProfile(1n)

    expect(profile.jobTitle).toBeNull()
    expect(profile.isWorkingNow).toBe(false)
  })
})
