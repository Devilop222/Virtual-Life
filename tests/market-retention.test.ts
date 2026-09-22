import { PrismaClient } from '@prisma/client'
import { ShopService } from '../src/modules/shop/shop.service'
import { RetentionService } from '../src/modules/maintenance/retention.service'
import { computePriceMultiplier, priceTrendOf, MARKET_CONFIG } from '../src/config/market.config'
import { ConflictError, NotFoundError, ValidationError } from '../src/utils/classes/errors'

describe('Dynamic market pricing formula', () => {
  test('price stays inside the configured bounds', () => {
    const extremeUp = computePriceMultiplier({
      currentMultiplier: MARKET_CONFIG.maxPriceMultiplier,
      recentPurchases: 100_000,
      stock: 0,
      economicIndex: 100
    })
    const extremeDown = computePriceMultiplier({
      currentMultiplier: MARKET_CONFIG.minPriceMultiplier,
      recentPurchases: 0,
      stock: 999,
      economicIndex: 0
    })

    expect(extremeUp).toBeLessThanOrEqual(MARKET_CONFIG.maxPriceMultiplier)
    expect(extremeDown).toBeGreaterThanOrEqual(MARKET_CONFIG.minPriceMultiplier)
  })

  test('a single step never moves more than the configured max', () => {
    const next = computePriceMultiplier({
      currentMultiplier: 1,
      recentPurchases: 100_000,
      stock: 0,
      economicIndex: 100
    })
    expect(next - 1).toBeLessThanOrEqual(MARKET_CONFIG.maxStepChange + 1e-9)
  })

  test('high demand pushes the price up', () => {
    const next = computePriceMultiplier({
      currentMultiplier: 1,
      recentPurchases: 50,
      stock: -1,
      economicIndex: 50
    })
    expect(next).toBeGreaterThan(1)
  })

  test('no demand pushes the price down', () => {
    const next = computePriceMultiplier({
      currentMultiplier: 1.2,
      recentPurchases: 0,
      stock: -1,
      economicIndex: 50
    })
    expect(next).toBeLessThan(1.2)
  })

  test('unlimited stock ignores the scarcity factor', () => {
    const unlimited = computePriceMultiplier({
      currentMultiplier: 1,
      recentPurchases: MARKET_CONFIG.neutralDemand,
      stock: -1,
      economicIndex: 50
    })
    expect(unlimited).toBeCloseTo(1, 5)
  })

  test('scarce limited stock raises the price', () => {
    const scarce = computePriceMultiplier({
      currentMultiplier: 1,
      recentPurchases: MARKET_CONFIG.neutralDemand,
      stock: 0,
      economicIndex: 50
    })
    expect(scarce).toBeGreaterThan(1)
  })

  test('trend detection reports direction correctly', () => {
    expect(priceTrendOf(1.1, 1.0)).toBe('up')
    expect(priceTrendOf(0.9, 1.0)).toBe('down')
    expect(priceTrendOf(1.0, 1.0)).toBe('stable')
  })
})

function makeShopDb(overrides: Record<string, unknown> = {}) {
  const tx = {
    shopItem: {
      findUnique: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({})
    },
    player: {
      findUnique: jest.fn().mockResolvedValue({ id: 'p1', balance: 100_000_000 }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({})
    },
    playerInventory: {
      upsert: jest.fn().mockResolvedValue({ id: 'inv1', quantity: 1 }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn()
    },
    financialTransaction: { create: jest.fn().mockResolvedValue({}) }
  }

  const db = {
    shopItem: {
      upsert: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 })
    },
    player: { findUnique: jest.fn().mockResolvedValue({ id: 'p1' }) },
    playerInventory: {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([])
    },
    regionStat: { aggregate: jest.fn().mockResolvedValue({ _avg: { economicIndex: 50 } }) },
    $transaction: jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx)),
    ...overrides
  }

  return { db, tx }
}

describe('ShopService — dynamic price purchase', () => {
  test('charges the market price, not the base price', async () => {
    const { db, tx } = makeShopDb()
    tx.shopItem.findUnique.mockResolvedValue({
      id: 'i1',
      key: 'water',
      name: 'آب',
      price: 10_000,
      priceMultiplier: 1.5,
      stock: -1,
      active: true
    })
    const service = new ShopService(db as unknown as PrismaClient)

    const result = await service.buyItem(1n, 'water')

    expect(result.price).toBe(15_000)
    // کسر موجودی با قیمت بازار و به‌شکل شرطی انجام شد
    expect(tx.player.updateMany.mock.calls[0][0].data.balance.decrement).toBe(15_000)
    expect(tx.player.updateMany.mock.calls[0][0].where.balance.gte).toBe(15_000)
  })

  test('records demand for future price recalculation', async () => {
    const { db, tx } = makeShopDb()
    tx.shopItem.findUnique.mockResolvedValue({
      id: 'i1',
      key: 'water',
      name: 'آب',
      price: 10_000,
      priceMultiplier: 1,
      stock: -1,
      active: true
    })
    const service = new ShopService(db as unknown as PrismaClient)

    await service.buyItem(1n, 'water')

    const data = tx.shopItem.update.mock.calls[0][0].data
    expect(data.purchaseCount.increment).toBe(1)
    expect(data.recentPurchases.increment).toBe(1)
  })

  test('rejects the purchase when stock is exhausted', async () => {
    const { db, tx } = makeShopDb()
    tx.shopItem.findUnique.mockResolvedValue({
      id: 'i1',
      key: 'elixir',
      name: 'اکسیر',
      price: 1_000,
      priceMultiplier: 1,
      stock: 3,
      active: true
    })
    tx.shopItem.updateMany.mockResolvedValue({ count: 0 })
    const service = new ShopService(db as unknown as PrismaClient)

    await expect(service.buyItem(1n, 'elixir')).rejects.toThrow(ConflictError)
    expect(tx.player.updateMany).not.toHaveBeenCalled()
  })

  test('rejects the purchase when the balance is short', async () => {
    const { db, tx } = makeShopDb()
    tx.shopItem.findUnique.mockResolvedValue({
      id: 'i1',
      key: 'water',
      name: 'آب',
      price: 10_000,
      priceMultiplier: 1,
      stock: -1,
      active: true
    })
    tx.player.updateMany.mockResolvedValue({ count: 0 })
    const service = new ShopService(db as unknown as PrismaClient)

    await expect(service.buyItem(1n, 'water')).rejects.toThrow(ValidationError)
    expect(tx.playerInventory.upsert).not.toHaveBeenCalled()
  })

  test('rejects an unknown or inactive item', async () => {
    const { db, tx } = makeShopDb()
    tx.shopItem.findUnique.mockResolvedValue(null)
    const service = new ShopService(db as unknown as PrismaClient)

    await expect(service.buyItem(1n, 'ghost')).rejects.toThrow(NotFoundError)
  })

  test('catalog exposes base price, current price and trend', async () => {
    const { db } = makeShopDb()
    db.shopItem.findMany.mockResolvedValue([
      {
        id: 'i1',
        key: 'water',
        name: 'آب',
        description: 'توضیح',
        category: 'خوراکی',
        rarity: 'common',
        stock: -1,
        effects: {},
        price: 10_000,
        priceMultiplier: 1.2,
        previousMultiplier: 1.0
      }
    ])
    const service = new ShopService(db as unknown as PrismaClient)

    const catalog = await service.getCatalog('خوراکی')

    expect(catalog[0]?.basePrice).toBe(10_000)
    expect(catalog[0]?.currentPrice).toBe(12_000)
    expect(catalog[0]?.trend).toBe('up')
  })

  test('price refresh only touches stale items and clears the demand counter', async () => {
    const { db } = makeShopDb()
    db.shopItem.findMany.mockResolvedValue([
      { id: 'i1', stock: -1, priceMultiplier: 1, recentPurchases: 30 }
    ])
    const service = new ShopService(db as unknown as PrismaClient)

    const updated = await service.refreshPrices()

    expect(updated).toBe(1)
    const data = db.shopItem.updateMany.mock.calls[0][0].data
    expect(data.recentPurchases).toBe(0)
    expect(data.previousMultiplier).toBe(1)
  })

  test('inventory value uses the current market price', async () => {
    const { db } = makeShopDb()
    db.playerInventory.findMany.mockResolvedValue([
      { quantity: 2, item: { price: 10_000, priceMultiplier: 1.5 } }
    ])
    const service = new ShopService(db as unknown as PrismaClient)

    const value = await service.getInventoryValue('p1')
    expect(value).toBe(30_000)
  })
})

describe('RetentionService', () => {
  function makeDb() {
    return {
      userState: { deleteMany: jest.fn().mockResolvedValue({ count: 3 }) },
      gameEvent: { deleteMany: jest.fn().mockResolvedValue({ count: 5 }) },
      rankingSnapshot: { deleteMany: jest.fn().mockResolvedValue({ count: 2 }) }
    }
  }

  test('prunes temporary data and reports the totals', async () => {
    const db = makeDb()
    const service = new RetentionService(db as unknown as PrismaClient)

    const result = await service.runAll()

    expect(result.expiredUserStates).toBe(3)
    expect(result.oldEvents).toBe(5)
    expect(result.staleRankingSnapshots).toBe(2)
    expect(result.totalRemoved).toBe(10)
  })

  test('never deletes important high priority events', async () => {
    const db = makeDb()
    const service = new RetentionService(db as unknown as PrismaClient)

    await service.pruneOldEvents(30)

    expect(db.gameEvent.deleteMany.mock.calls[0][0].where.priority).toEqual({ lt: 4 })
  })

  test('a failing step never aborts the whole cycle', async () => {
    const db = makeDb()
    db.userState.deleteMany.mockRejectedValue(new Error('db down'))
    const service = new RetentionService(db as unknown as PrismaClient)

    const result = await service.runAll()

    expect(result.expiredUserStates).toBe(0)
    expect(result.oldEvents).toBe(5)
    expect(result.staleRankingSnapshots).toBe(2)
  })

  test('financial and audit tables are never touched', async () => {
    const db = {
      userState: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      gameEvent: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      rankingSnapshot: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      financialTransaction: { deleteMany: jest.fn() },
      adminLog: { deleteMany: jest.fn() },
      migration: { deleteMany: jest.fn() },
      property: { deleteMany: jest.fn() },
      business: { deleteMany: jest.fn() },
      loan: { deleteMany: jest.fn() }
    }
    const service = new RetentionService(db as unknown as PrismaClient)

    await service.runAll()

    expect(db.financialTransaction.deleteMany).not.toHaveBeenCalled()
    expect(db.adminLog.deleteMany).not.toHaveBeenCalled()
    expect(db.migration.deleteMany).not.toHaveBeenCalled()
    expect(db.property.deleteMany).not.toHaveBeenCalled()
    expect(db.business.deleteMany).not.toHaveBeenCalled()
    expect(db.loan.deleteMany).not.toHaveBeenCalled()
  })
})
