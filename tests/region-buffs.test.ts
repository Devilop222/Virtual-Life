import { PrismaClient } from '@prisma/client'
import { ProjectsService, PROJECT_BLUEPRINTS } from '../src/modules/city/projects.service'
import { HousingService } from '../src/modules/housing/housing.service'
import { ShopService } from '../src/modules/shop/shop.service'
import { ResidenceService } from '../src/modules/residence/residence.service'
import { HousingRepository } from '../src/database/repositories/housing.repository'
import { PlayerRepository } from '../src/database/repositories/player.repository'
import { EventService } from '../src/modules/events/event.service'

function makeEvents() {
  return {
    recordPlayerEvent: jest.fn().mockResolvedValue(undefined),
    recordRegionEvent: jest.fn().mockResolvedValue(undefined)
  }
}

function buffsOf(overrides: Record<string, number> = {}) {
  return {
    getRegionBuffs: jest.fn().mockResolvedValue({
      restFatigueMultiplier: 1,
      restHealthMultiplier: 1,
      shopDiscount: 0,
      migrationDiscount: 0,
      ...overrides
    })
  }
}

describe('ProjectsService — region buffs', () => {
  function makeDb(completedKeys: string[]) {
    const db = {
      regionProject: {
        findMany: jest.fn().mockResolvedValue(completedKeys.map((key) => ({ key }))),
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      },
      player: {
        findUnique: jest.fn().mockResolvedValue({ id: 'p1', status: 'ACTIVE' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn()
      },
      // رکورد مشارکت: هر کمک یک ردیفِ قابل‌ردیابی می‌گیرد.
      projectDonation: {
        create: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        aggregate: jest.fn().mockResolvedValue({ _sum: { amount: 0 } }),
        groupBy: jest.fn().mockResolvedValue([])
      },
      // سیاست فعال شهردار؛ بدون سیاست (null) بافرها خنثی می‌مانند
      group: { findUnique: jest.fn().mockResolvedValue({ activePolicy: null }) },
      financialTransaction: { create: jest.fn() },
      $transaction:
        undefined as unknown as (fn: (t: unknown) => Promise<unknown>) => Promise<unknown>
    }
    // donate در یک $transaction انجام می‌شود؛ callback همان اشیای db را می‌گیرد
    db.$transaction = jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(db as unknown))
    return db
  }

  test('no completed project means every buff is neutral', async () => {
    const db = makeDb([])
    const service = new ProjectsService(db as unknown as PrismaClient, makeEvents() as never)

    const buffs = await service.getRegionBuffs('g1')

    expect(buffs.restFatigueMultiplier).toBe(1)
    expect(buffs.restHealthMultiplier).toBe(1)
    expect(buffs.shopDiscount).toBe(0)
    expect(buffs.migrationDiscount).toBe(0)
  })

  test('each project maps to its own gameplay buff', async () => {
    const db = makeDb(['park', 'clinic', 'bazaar', 'terminal'])
    const service = new ProjectsService(db as unknown as PrismaClient, makeEvents() as never)

    const buffs = await service.getRegionBuffs('g1')

    expect(buffs.restFatigueMultiplier).toBeCloseTo(1.25)
    expect(buffs.restHealthMultiplier).toBeCloseTo(1.25)
    expect(buffs.shopDiscount).toBeCloseTo(0.1)
    expect(buffs.migrationDiscount).toBeCloseTo(0.3)
  })

  test('a player without residence never queries the database', async () => {
    const db = makeDb(['park'])
    const service = new ProjectsService(db as unknown as PrismaClient, makeEvents() as never)

    const buffs = await service.getRegionBuffs(null)

    expect(buffs.restFatigueMultiplier).toBe(1)
    expect(db.regionProject.findMany).not.toHaveBeenCalled()
  })

  test('repeated buff lookups are served from the cache', async () => {
    const db = makeDb(['bazaar'])
    const service = new ProjectsService(db as unknown as PrismaClient, makeEvents() as never)

    await service.getRegionBuffs('g1')
    await service.getRegionBuffs('g1')

    expect(db.regionProject.findMany).toHaveBeenCalledTimes(1)

    // کش به هر منطقه جدا تعلق دارد؛ منطقهٔ دوم نباید جواب منطقهٔ اول را
    // ببیند، وگرنه میان‌گیری یک منطقه از خودِ کش می‌آمد.
    await service.getRegionBuffs('g2')
    expect(db.regionProject.findMany).toHaveBeenCalledTimes(2)
  })

  test('the first donation creates the project row itself', async () => {
    const db = makeDb([])
    db.regionProject.create.mockResolvedValue({
      id: 'pr1',
      groupId: 'g1',
      key: 'park',
      title: PROJECT_BLUEPRINTS.park.title,
      description: PROJECT_BLUEPRINTS.park.description,
      targetAmount: PROJECT_BLUEPRINTS.park.targetAmount,
      collectedAmount: 0,
      isCompleted: false
    })
    const service = new ProjectsService(db as unknown as PrismaClient, makeEvents() as never)

    const result = await service.donate(1n, 'g1', 'park', 100_000)

    expect(db.regionProject.create).toHaveBeenCalled()
    expect(result.donated).toBe(100_000)
  })

  test('donating to an unknown project is rejected before any write', async () => {
    const db = makeDb([])
    const service = new ProjectsService(db as unknown as PrismaClient, makeEvents() as never)

    await expect(service.donate(1n, 'g1', 'stadium', 100_000)).rejects.toThrow()
    expect(db.player.updateMany).not.toHaveBeenCalled()
  })
})

describe('HousingService — city projects boost resting', () => {
  function makeRepos(fatigue = 100, health = 40) {
    const housingRepo = {
      listPlayerProperties: jest.fn().mockResolvedValue([{ id: 'prop1', title: 'آپارتمان', level: 1 }]),
      findActiveRental: jest.fn().mockResolvedValue(null),
      startResting: jest.fn(),
      stopResting: jest.fn().mockResolvedValue({})
    }
    const playerRepo = {
      findByTelegramUserId: jest.fn().mockResolvedValue({
        id: 'p1',
        status: 'ACTIVE',
        activityState: 'RESTING',
        restStartedAt: new Date(Date.now() - 60 * 60 * 1000),
        fatigue,
        health,
        homeGroupId: 'g1'
      })
    }
    return { housingRepo, playerRepo }
  }

  function build(
    repos: ReturnType<typeof makeRepos>,
    projects?: { getRegionBuffs: jest.Mock }
  ) {
    return new HousingService(
      repos.housingRepo as unknown as HousingRepository,
      repos.playerRepo as unknown as PlayerRepository,
      projects as never
    )
  }

  test('a completed park recovers more fatigue than the baseline', async () => {
    const plain = makeRepos()
    const withPark = makeRepos()

    const baseline = await build(plain).stopRestAtHome(1n)
    const boosted = await build(withPark, buffsOf({ restFatigueMultiplier: 1.25 })).stopRestAtHome(1n)

    expect(boosted.fatigueRecovered).toBeGreaterThan(baseline.fatigueRecovered)
    expect(boosted.regionBonusApplied).toBe(true)
    expect(baseline.regionBonusApplied).toBe(false)
  })

  test('a completed clinic recovers more health than the baseline', async () => {
    const plain = makeRepos()
    const withClinic = makeRepos()

    const baseline = await build(plain).stopRestAtHome(1n)
    const boosted = await build(withClinic, buffsOf({ restHealthMultiplier: 1.25 })).stopRestAtHome(1n)

    expect(boosted.healthRecovered).toBeGreaterThan(baseline.healthRecovered)
  })

  test('recovery never exceeds the missing amount', async () => {
    const repos = makeRepos(5, 98)
    const result = await build(repos, buffsOf({ restFatigueMultiplier: 1.25, restHealthMultiplier: 1.25 }))
      .stopRestAtHome(1n)

    expect(result.fatigueRecovered).toBeLessThanOrEqual(5)
    expect(result.healthRecovered).toBeLessThanOrEqual(2)
  })

  test('a failing projects lookup never blocks the rest', async () => {
    const repos = makeRepos()
    const failing = { getRegionBuffs: jest.fn().mockRejectedValue(new Error('db down')) }

    const result = await build(repos, failing).stopRestAtHome(1n)

    expect(result.isResting).toBe(false)
    expect(result.regionBonusApplied).toBe(false)
    expect(repos.housingRepo.stopResting).toHaveBeenCalled()
  })
})

describe('ShopService — bazaar discount', () => {
  function makeShopDb() {
    const tx = {
      shopItem: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'i1',
          key: 'water',
          name: 'آب',
          price: 10_000,
          priceMultiplier: 1,
          stock: -1,
          active: true
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockResolvedValue({})
      },
      player: {
        findUnique: jest.fn().mockResolvedValue({ id: 'p1', balance: 100_000_000 }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      },
      playerInventory: { upsert: jest.fn().mockResolvedValue({ id: 'inv1' }) },
      financialTransaction: { create: jest.fn() }
    }
    const db = {
      shopItem: {
        upsert: jest.fn().mockResolvedValue({}),
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'i1',
            key: 'water',
            name: 'آب',
            description: '',
            category: 'خوراکی',
            rarity: 'common',
            stock: -1,
            effects: {},
            price: 10_000,
            priceMultiplier: 1,
            previousMultiplier: 1
          }
        ]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      },
      player: { findUnique: jest.fn().mockResolvedValue({ id: 'p1', homeGroupId: 'g1' }) },
      regionStat: { aggregate: jest.fn().mockResolvedValue({ _avg: { economicIndex: 50 } }) },
      $transaction: jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx))
    }
    return { db, tx }
  }

  test('purchase price drops by the bazaar discount', async () => {
    const { db, tx } = makeShopDb()
    const service = new ShopService(
      db as unknown as PrismaClient,
      buffsOf({ shopDiscount: 0.1 }) as never
    )

    const result = await service.buyItem(1n, 'water')

    expect(result.price).toBe(9_000)
    expect(tx.player.updateMany.mock.calls[0][0].data.balance.decrement).toBe(9_000)
  })

  test('the catalog shows the same discounted price that will be charged', async () => {
    const { db } = makeShopDb()
    const service = new ShopService(
      db as unknown as PrismaClient,
      buffsOf({ shopDiscount: 0.1 }) as never
    )

    const catalog = await service.getCatalog('خوراکی', 1n)
    const purchase = await service.buyItem(1n, 'water')

    expect(catalog[0]?.currentPrice).toBe(purchase.price)
  })

  test('without the bazaar the market price is charged unchanged', async () => {
    const { db } = makeShopDb()
    const service = new ShopService(db as unknown as PrismaClient, buffsOf() as never)

    const result = await service.buyItem(1n, 'water')

    expect(result.price).toBe(10_000)
  })
})

describe('ResidenceService — terminal discount', () => {
  function makeMigrationDb() {
    return {
      player: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'p1',
          balance: 50_000_000,
          homeGroupId: 'g1',
          lastMigrationAt: null,
          activityState: 'IDLE',
          isEnrolled: false
        })
      },
      group: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'g2',
          environmentLevel: 'CITY',
          status: 'ACTIVE'
        })
      },
      migration: { count: jest.fn().mockResolvedValue(0) },
      loan: { count: jest.fn().mockResolvedValue(0) },
      business: { count: jest.fn().mockResolvedValue(0) },
      $transaction: jest.fn()
    }
  }

  test('a completed terminal lowers the migration cost', async () => {
    const plain = new ResidenceService(
      makeMigrationDb() as unknown as PrismaClient,
      makeEvents() as unknown as EventService
    )
    const discounted = new ResidenceService(
      makeMigrationDb() as unknown as PrismaClient,
      makeEvents() as unknown as EventService,
      buffsOf({ migrationDiscount: 0.3 }) as never
    )

    const base = await plain.checkMigration(1n, 'g2')
    const cheaper = await discounted.checkMigration(1n, 'g2')

    expect(cheaper.cost).toBeLessThan(base.cost)
    expect(cheaper.cost).toBe(Math.round(base.cost * 0.7))
  })

  test('a failing projects lookup falls back to the full cost', async () => {
    const failing = { getRegionBuffs: jest.fn().mockRejectedValue(new Error('db down')) }
    const service = new ResidenceService(
      makeMigrationDb() as unknown as PrismaClient,
      makeEvents() as unknown as EventService,
      failing as never
    )
    const plain = new ResidenceService(
      makeMigrationDb() as unknown as PrismaClient,
      makeEvents() as unknown as EventService
    )

    const check = await service.checkMigration(1n, 'g2')
    const base = await plain.checkMigration(1n, 'g2')

    expect(check.cost).toBe(base.cost)
    expect(check.allowed).toBe(true)
  })
})
