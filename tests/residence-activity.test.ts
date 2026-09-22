import { PrismaClient, MigrationReason, TransactionType } from '@prisma/client'
import { ResidenceService } from '../src/modules/residence/residence.service'
import { ActivityService, VALID_ACTIVITY_SECTIONS } from '../src/modules/activity/activity.service'
import { EventService } from '../src/modules/events/event.service'
import { RewardsService } from '../src/modules/rewards/rewards.service'
import { ConflictError, NotFoundError, ValidationError } from '../src/utils/classes/errors'

function makeEvents() {
  return {
    recordPlayerEvent: jest.fn().mockResolvedValue(undefined),
    recordRegionEvent: jest.fn().mockResolvedValue(undefined)
  }
}

function makeDb(overrides: Record<string, unknown> = {}) {
  return {
    player: {
      findUnique: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 })
    },
    group: { findUnique: jest.fn() },
    playerGroup: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({})
    },
    migration: { create: jest.fn().mockResolvedValue({}), count: jest.fn().mockResolvedValue(0) },
    loan: { count: jest.fn().mockResolvedValue(0) },
    business: { count: jest.fn().mockResolvedValue(0) },
    $transaction: jest.fn(),
    ...overrides
  }
}

const ACTIVE_PLAYER = {
  id: 'p1',
  balance: 50_000_000,
  homeGroupId: 'g1',
  lastMigrationAt: null,
  activityState: 'IDLE',
  isEnrolled: false
}

describe('ResidenceService — residence lifecycle', () => {
  test('throws when the player does not exist', async () => {
    const db = makeDb()
    db.player.findUnique.mockResolvedValue(null)
    const service = new ResidenceService(
      db as unknown as PrismaClient,
      makeEvents() as unknown as EventService
    )

    await expect(service.getResidenceInfo(1n)).rejects.toThrow(NotFoundError)
  })

  test('reports no residence for a fresh character', async () => {
    const db = makeDb()
    db.player.findUnique.mockResolvedValue({
      id: 'p1',
      residenceSince: null,
      lastMigrationAt: null,
      currentRegionId: null,
      homeGroup: null,
      currentRegion: null
    })
    const service = new ResidenceService(
      db as unknown as PrismaClient,
      makeEvents() as unknown as EventService
    )

    const info = await service.getResidenceInfo(1n)

    expect(info.hasResidence).toBe(false)
    expect(info.residenceGroupId).toBeNull()
    expect(info.isTraveling).toBe(false)
  })

  test('establishes the initial residence atomically only once', async () => {
    const events = makeEvents()
    const db = makeDb()
    db.player.updateMany.mockResolvedValue({ count: 1 })
    const service = new ResidenceService(
      db as unknown as PrismaClient,
      events as unknown as EventService
    )

    const result = await service.establishInitialResidence('p1', 'g1')

    expect(result.established).toBe(true)
    // شرط اتمیک: فقط وقتی homeGroupId خالی است
    expect(db.player.updateMany.mock.calls[0][0].where.homeGroupId).toBeNull()
    expect(db.migration.create.mock.calls[0][0].data.reason).toBe(
      MigrationReason.FIRST_SETTLEMENT
    )
    expect(events.recordPlayerEvent).toHaveBeenCalledTimes(1)
  })

  test('a concurrent second attempt does not create a second residence', async () => {
    const db = makeDb()
    db.player.updateMany.mockResolvedValue({ count: 0 })
    const service = new ResidenceService(
      db as unknown as PrismaClient,
      makeEvents() as unknown as EventService
    )

    const result = await service.establishInitialResidence('p1', 'g2')

    expect(result.established).toBe(false)
    expect(db.migration.create).not.toHaveBeenCalled()
  })

  test('travel never changes the main residence', async () => {
    const db = makeDb()
    const service = new ResidenceService(
      db as unknown as PrismaClient,
      makeEvents() as unknown as EventService
    )

    await service.trackPresence('p1', 'g2')

    const data = db.player.update.mock.calls[0][0].data
    expect(data.currentRegionId).toBe('g2')
    expect(data).not.toHaveProperty('homeGroupId')
  })

  test('detects travel state when current region differs from residence', async () => {
    const db = makeDb()
    db.player.findUnique.mockResolvedValue({
      id: 'p1',
      residenceSince: new Date(),
      lastMigrationAt: null,
      currentRegionId: 'g2',
      homeGroup: { id: 'g1', title: 'شهر الف', environmentLevel: 'CITY' },
      currentRegion: { id: 'g2', title: 'شهر ب' }
    })
    const service = new ResidenceService(
      db as unknown as PrismaClient,
      makeEvents() as unknown as EventService
    )

    const info = await service.getResidenceInfo(1n)

    expect(info.isTraveling).toBe(true)
    expect(info.residenceTitle).toBe('شهر الف')
    expect(info.currentRegionTitle).toBe('شهر ب')
  })
})

describe('ResidenceService — migration guards', () => {
  function migrationDb(playerOverrides: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
    const db = makeDb(extra)
    db.player.findUnique.mockResolvedValue({ ...ACTIVE_PLAYER, ...playerOverrides })
    db.group.findUnique.mockResolvedValue({
      id: 'g2',
      environmentLevel: 'CITY',
      status: 'ACTIVE'
    })
    return db
  }

  test('allows migration when every condition is met', async () => {
    const db = migrationDb()
    const service = new ResidenceService(
      db as unknown as PrismaClient,
      makeEvents() as unknown as EventService
    )

    const check = await service.checkMigration(1n, 'g2')

    expect(check.allowed).toBe(true)
    expect(check.blockers).toHaveLength(0)
    expect(check.cost).toBeGreaterThan(0)
  })

  test('blocks migrating to the current residence', async () => {
    const db = migrationDb({ homeGroupId: 'g2' })
    const service = new ResidenceService(
      db as unknown as PrismaClient,
      makeEvents() as unknown as EventService
    )

    const check = await service.checkMigration(1n, 'g2')
    expect(check.allowed).toBe(false)
  })

  test('blocks migration during the cooldown window', async () => {
    const db = migrationDb({ lastMigrationAt: new Date() })
    const service = new ResidenceService(
      db as unknown as PrismaClient,
      makeEvents() as unknown as EventService
    )

    const check = await service.checkMigration(1n, 'g2')
    expect(check.allowed).toBe(false)
    expect(check.blockers.join(' ')).toContain('ساعت')
  })

  test('blocks migration with insufficient balance', async () => {
    const db = migrationDb({ balance: 1000 })
    const service = new ResidenceService(
      db as unknown as PrismaClient,
      makeEvents() as unknown as EventService
    )

    const check = await service.checkMigration(1n, 'g2')
    expect(check.allowed).toBe(false)
  })

  test('blocks migration while working or studying', async () => {
    const working = new ResidenceService(
      migrationDb({ activityState: 'WORKING' }) as unknown as PrismaClient,
      makeEvents() as unknown as EventService
    )
    const studying = new ResidenceService(
      migrationDb({ isEnrolled: true }) as unknown as PrismaClient,
      makeEvents() as unknown as EventService
    )

    expect((await working.checkMigration(1n, 'g2')).allowed).toBe(false)
    expect((await studying.checkMigration(1n, 'g2')).allowed).toBe(false)
  })

  test('blocks migration with active loans or businesses', async () => {
    const loanDb = migrationDb({}, { loan: { count: jest.fn().mockResolvedValue(1) } })
    const bizDb = migrationDb({}, { business: { count: jest.fn().mockResolvedValue(1) } })

    const loanService = new ResidenceService(
      loanDb as unknown as PrismaClient,
      makeEvents() as unknown as EventService
    )
    const bizService = new ResidenceService(
      bizDb as unknown as PrismaClient,
      makeEvents() as unknown as EventService
    )

    expect((await loanService.checkMigration(1n, 'g2')).allowed).toBe(false)
    expect((await bizService.checkMigration(1n, 'g2')).allowed).toBe(false)
  })

  test('refuses to migrate when checks fail', async () => {
    const db = migrationDb({ homeGroupId: 'g2' })
    const service = new ResidenceService(
      db as unknown as PrismaClient,
      makeEvents() as unknown as EventService
    )

    await expect(service.migrate(1n, 'g2')).rejects.toThrow(ConflictError)
    expect(db.$transaction).not.toHaveBeenCalled()
  })

  test('migration debits the cost atomically', async () => {
    const db = migrationDb()
    const tx = {
      player: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'p1',
          homeGroupId: 'g1',
          lastMigrationAt: null
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      },
      migration: { create: jest.fn().mockResolvedValue({}) },
      financialTransaction: { create: jest.fn().mockResolvedValue({}) },
      regionStat: { upsert: jest.fn().mockResolvedValue({}) }
    }
    db.$transaction.mockImplementation(async (fn: (t: unknown) => Promise<unknown>) => fn(tx))
    db.group.findUnique.mockResolvedValue({
      id: 'g2',
      environmentLevel: 'CITY',
      status: 'ACTIVE',
      title: 'شهر ب'
    })
    const service = new ResidenceService(
      db as unknown as PrismaClient,
      makeEvents() as unknown as EventService
    )

    const result = await service.migrate(1n, 'g2')

    expect(result.cost).toBeGreaterThan(0)
    // اولین updateMany کسر شرطی موجودی است
    expect(tx.player.updateMany.mock.calls[0][0].where.balance).toBeDefined()
    expect(tx.migration.create.mock.calls[0][0].data.reason).toBe(MigrationReason.VOLUNTARY)
  })

  test('migration records the fee in the ledger and credits the destination fund', async () => {
    const db = migrationDb()
    const tx = {
      player: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'p1',
          homeGroupId: 'g1',
          lastMigrationAt: null
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      },
      migration: { create: jest.fn().mockResolvedValue({}) },
      financialTransaction: { create: jest.fn().mockResolvedValue({}) },
      regionStat: { upsert: jest.fn().mockResolvedValue({}) }
    }
    db.$transaction.mockImplementation(async (fn: (t: unknown) => Promise<unknown>) => fn(tx))
    db.group.findUnique.mockResolvedValue({
      id: 'g2',
      environmentLevel: 'CITY',
      status: 'ACTIVE',
      title: 'شهر ب'
    })
    const service = new ResidenceService(
      db as unknown as PrismaClient,
      makeEvents() as unknown as EventService
    )

    const result = await service.migrate(1n, 'g2')

    // کسر باید یک ردیفِ دفتری داشته باشد، نه اینکه بی‌ثبت از دفتر ناپدید شود
    const fee = tx.financialTransaction.create.mock.calls[0][0].data
    expect(fee.amount).toBe(result.cost)
    expect(fee.type).toBe(TransactionType.RESIDENCE_MIGRATION_FEE)
    expect(fee.sourcePlayerId).toBe('p1')

    // و همان مبلغ به صندوق منطقهٔ مقصد می‌رسد (همان کانالی که مالیات می‌رود)
    const credit = tx.regionStat.upsert.mock.calls[0][0]
    expect(credit.where.groupId).toBe('g2')
    expect(credit.update.taxRevenue.increment).toBe(result.cost)
  })

  test('a failed debit leaves no ledger row and no fund credit', async () => {
    const db = migrationDb()
    const tx = {
      player: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'p1',
          homeGroupId: 'g1',
          lastMigrationAt: null
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 0 })
      },
      migration: { create: jest.fn() },
      financialTransaction: { create: jest.fn() },
      regionStat: { upsert: jest.fn() }
    }
    db.$transaction.mockImplementation(async (fn: (t: unknown) => Promise<unknown>) => fn(tx))
    const service = new ResidenceService(
      db as unknown as PrismaClient,
      makeEvents() as unknown as EventService
    )

    await expect(service.migrate(1n, 'g2')).rejects.toThrow(ValidationError)
    expect(tx.financialTransaction.create).not.toHaveBeenCalled()
    expect(tx.regionStat.upsert).not.toHaveBeenCalled()
  })

  test('migration fails safely when the balance changes mid-transaction', async () => {
    const db = migrationDb()
    const tx = {
      player: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'p1',
          homeGroupId: 'g1',
          lastMigrationAt: null
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 0 })
      },
      migration: { create: jest.fn() }
    }
    db.$transaction.mockImplementation(async (fn: (t: unknown) => Promise<unknown>) => fn(tx))
    const service = new ResidenceService(
      db as unknown as PrismaClient,
      makeEvents() as unknown as EventService
    )

    await expect(service.migrate(1n, 'g2')).rejects.toThrow(ValidationError)
    expect(tx.migration.create).not.toHaveBeenCalled()
  })

  test('lists only active regions excluding the current residence', async () => {
    const db = makeDb()
    db.player.findUnique.mockResolvedValue({ id: 'p1', homeGroupId: 'g1' })
    db.playerGroup.findMany.mockResolvedValue([
      { group: { id: 'g1', title: 'خانه', environmentLevel: 'CITY', status: 'ACTIVE' } },
      { group: { id: 'g2', title: 'شهر ب', environmentLevel: 'CITY', status: 'ACTIVE' } },
      { group: { id: 'g3', title: 'غیرفعال', environmentLevel: 'CITY', status: 'INACTIVE' } }
    ])
    const service = new ResidenceService(
      db as unknown as PrismaClient,
      makeEvents() as unknown as EventService
    )

    const regions = await service.listAvailableRegions(1n)

    expect(regions).toHaveLength(1)
    expect(regions[0]?.id).toBe('g2')
  })
})

function makeRewards() {
  return {
    settleReferralResidenceBonus: jest.fn().mockResolvedValue(undefined)
  }
}

describe('ActivityService — first valid activity assigns residence', () => {
  function activityDb(overrides: Record<string, unknown> = {}) {
    return makeDb({
      player: {
        findUnique: jest.fn().mockResolvedValue({ id: 'p1', homeGroupId: null, status: 'ACTIVE' }),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      },
      group: {
        findUnique: jest.fn().mockResolvedValue({ id: 'g1', title: 'شهر الف', status: 'ACTIVE' })
      },
      ...overrides
    })
  }

  test('valid gameplay sections are whitelisted', () => {
    const db = activityDb()
    const residence = new ResidenceService(
      db as unknown as PrismaClient,
      makeEvents() as unknown as EventService
    )
    const service = new ActivityService(
      db as unknown as PrismaClient,
      residence,
      makeRewards() as unknown as RewardsService
    )

    expect(service.isValidActivity('identity')).toBe(true)
    expect(service.isValidActivity('banking')).toBe(true)
    // راهنما، خبر و رتبه فعالیت Gameplay محسوب نمی‌شوند
    expect(service.isValidActivity('help')).toBe(false)
    expect(service.isValidActivity('news')).toBe(false)
    expect(service.isValidActivity('rank')).toBe(false)
    expect(VALID_ACTIVITY_SECTIONS.has('manage')).toBe(false)
  })

  test('an invalid section never touches the database', async () => {
    const db = activityDb()
    const residence = new ResidenceService(
      db as unknown as PrismaClient,
      makeEvents() as unknown as EventService
    )
    const service = new ActivityService(
      db as unknown as PrismaClient,
      residence,
      makeRewards() as unknown as RewardsService
    )

    const result = await service.registerActivity(1n, -100n, 'help')

    expect(result.residenceEstablished).toBe(false)
    expect(db.player.findUnique).not.toHaveBeenCalled()
  })

  test('private chat activity never creates a residence', async () => {
    const db = activityDb()
    const residence = new ResidenceService(
      db as unknown as PrismaClient,
      makeEvents() as unknown as EventService
    )
    const service = new ActivityService(
      db as unknown as PrismaClient,
      residence,
      makeRewards() as unknown as RewardsService
    )

    const result = await service.registerActivity(1n, null, 'identity')

    expect(result.residenceEstablished).toBe(false)
    expect(db.player.findUnique).not.toHaveBeenCalled()
  })

  test('first valid group activity establishes the residence', async () => {
    const db = activityDb()
    const residence = new ResidenceService(
      db as unknown as PrismaClient,
      makeEvents() as unknown as EventService
    )
    const service = new ActivityService(
      db as unknown as PrismaClient,
      residence,
      makeRewards() as unknown as RewardsService
    )

    const result = await service.registerActivity(1n, -100n, 'identity')

    expect(result.residenceEstablished).toBe(true)
    expect(result.residenceTitle).toBe('شهر الف')
  })

  test('a player with a residence only records presence', async () => {
    const db = activityDb({
      player: {
        findUnique: jest.fn().mockResolvedValue({ id: 'p1', homeGroupId: 'g-old' }),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      }
    })
    const residence = new ResidenceService(
      db as unknown as PrismaClient,
      makeEvents() as unknown as EventService
    )
    const service = new ActivityService(
      db as unknown as PrismaClient,
      residence,
      makeRewards() as unknown as RewardsService
    )

    const result = await service.registerActivity(1n, -100n, 'banking')

    expect(result.residenceEstablished).toBe(false)
    // فقط حضور موقت ثبت شد و اقامت دست‌نخورده ماند
    expect(db.player.update).toHaveBeenCalledTimes(1)
    expect(db.player.updateMany).not.toHaveBeenCalled()
  })

  test('inactive groups never become a residence', async () => {
    const db = activityDb({
      group: {
        findUnique: jest.fn().mockResolvedValue({ id: 'g1', title: 'x', status: 'INACTIVE' })
      }
    })
    const residence = new ResidenceService(
      db as unknown as PrismaClient,
      makeEvents() as unknown as EventService
    )
    const service = new ActivityService(
      db as unknown as PrismaClient,
      residence,
      makeRewards() as unknown as RewardsService
    )

    const result = await service.registerActivity(1n, -100n, 'identity')
    expect(result.residenceEstablished).toBe(false)
  })

  test('database failures never break gameplay', async () => {
    const db = activityDb({
      player: { findUnique: jest.fn().mockRejectedValue(new Error('db down')) }
    })
    const residence = new ResidenceService(
      db as unknown as PrismaClient,
      makeEvents() as unknown as EventService
    )
    const service = new ActivityService(
      db as unknown as PrismaClient,
      residence,
      makeRewards() as unknown as RewardsService
    )

    await expect(service.registerActivity(1n, -100n, 'identity')).resolves.toEqual({
      residenceEstablished: false
    })
  })
})
