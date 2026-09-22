import { PrismaClient } from '@prisma/client'
import { LedgerService } from '../src/modules/finance/ledger.service'
import { CreditService } from '../src/modules/finance/credit.service'
import { NotFoundError } from '../src/utils/classes/errors'

function makeDb(overrides: Record<string, unknown> = {}) {
  return {
    // count روی player تعریف اشتغال را پاسخ می‌دهد (۱ = شاغل)
    player: { findUnique: jest.fn(), count: jest.fn().mockResolvedValue(0) },
    bankAccount: { findMany: jest.fn().mockResolvedValue([]), aggregate: jest.fn() },
    property: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn() },
    business: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn() },
    loan: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
    playerLoan: { count: jest.fn().mockResolvedValue(0) },
    financialTransaction: {
      count: jest.fn().mockResolvedValue(0),
      aggregate: jest.fn().mockResolvedValue({ _sum: { amount: null } }),
      findMany: jest.fn().mockResolvedValue([])
    },
    workSession: {
      aggregate: jest.fn().mockResolvedValue({ _sum: { earnedMoney: null } }),
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([])
    },
    playerSkill: { count: jest.fn().mockResolvedValue(0) },
    playerGroup: { findMany: jest.fn().mockResolvedValue([]) },
    group: { findUnique: jest.fn() },
    ...overrides
  }
}

describe('CreditService', () => {
  test('throws when the player does not exist', async () => {
    const db = makeDb()
    db.player.findUnique.mockResolvedValue(null)
    const service = new CreditService(db as unknown as PrismaClient)

    await expect(service.getCreditProfile(42n)).rejects.toThrow(NotFoundError)
  })

  test('computes a low score with debt and no assets', async () => {
    const db = makeDb()
    db.player.findUnique.mockResolvedValue({
      id: 'p1',
      status: 'ACTIVE',
      experience: 0,
      balance: 0
    })
    db.loan.findMany.mockResolvedValue([{ remainingAmount: 30_000_000 }])
    const service = new CreditService(db as unknown as PrismaClient)

    const profile = await service.getCreditProfile(42n)

    expect(profile.totalDebt).toBe(30_000_000)
    expect(profile.score).toBeLessThan(500)
    expect(profile.maxLoanAmount).toBe(0)
    expect(profile.hasJob).toBe(false)
  })

  test('computes a high score with assets, savings and repayment history', async () => {
    const db = makeDb()
    db.player.findUnique.mockResolvedValue({
      id: 'p1',
      status: 'ACTIVE',
      experience: 500,
      balance: 20_000_000
    })
    // بازیکن شاغل است: نوبت کاری یا کسب‌وکار فعال دارد
    db.player.count.mockResolvedValue(1)
    db.bankAccount.findMany.mockResolvedValue([{ balance: 30_000_000 }])
    db.property.findMany.mockResolvedValue([{ baseAssetValue: 60_000_000 }])
    db.loan.count.mockResolvedValue(2)
    db.financialTransaction.count.mockResolvedValue(40)
    const service = new CreditService(db as unknown as PrismaClient)

    const profile = await service.getCreditProfile(42n)

    expect(profile.score).toBeGreaterThan(700)
    expect(profile.assetValue).toBe(60_000_000)
    expect(profile.netWorth).toBe(110_000_000)
    expect(profile.maxLoanAmount).toBeGreaterThan(0)
    expect(profile.hasJob).toBe(true)
  })

  test('active employment adds a positive credit factor', async () => {
    const db = makeDb()
    db.player.findUnique.mockResolvedValue({
      id: 'p1',
      status: 'ACTIVE',
      experience: 0,
      balance: 0
    })
    db.player.count.mockResolvedValue(1)
    const service = new CreditService(db as unknown as PrismaClient)

    const profile = await service.getCreditProfile(42n)

    expect(profile.hasJob).toBe(true)
    expect(profile.factors.some((f) => f.label === 'اشتغال فعال' && f.impact > 0)).toBe(true)
  })

  test('score always stays inside the 300..900 range', async () => {
    const db = makeDb()
    db.player.findUnique.mockResolvedValue({
      id: 'p1',
      status: 'BANNED',
      experience: 0,
      balance: 0
    })
    db.loan.findMany.mockResolvedValue([{ remainingAmount: 900_000_000 }])
    const service = new CreditService(db as unknown as PrismaClient)

    const profile = await service.getCreditProfile(42n)
    expect(profile.score).toBeGreaterThanOrEqual(300)
    expect(profile.score).toBeLessThanOrEqual(900)
  })
})

describe('LedgerService', () => {
  test('marks incoming and outgoing entries correctly', async () => {
    const db = makeDb()
    db.player.findUnique.mockResolvedValue({
      id: 'p1',
      age: 20,
      balance: 1_000,
      experience: 0,
      currentDegree: 'DIPLOMA',
      startedAt: new Date()
    })
    db.financialTransaction.count.mockResolvedValue(2)
    db.financialTransaction.findMany.mockResolvedValue([
      {
        id: 't1',
        amount: 500,
        type: 'SALARY_PAYMENT',
        reference: 'حقوق',
        createdAt: new Date(),
        destinationPlayerId: 'p1'
      },
      {
        id: 't2',
        amount: 200,
        type: 'PROPERTY_PURCHASE',
        reference: 'خرید ملک',
        createdAt: new Date(),
        destinationPlayerId: null
      }
    ])
    const service = new LedgerService(db as unknown as PrismaClient)

    const page = await service.getLedger(42n, 0)

    expect(page.total).toBe(2)
    expect(page.entries[0]?.direction).toBe('in')
    expect(page.entries[1]?.direction).toBe('out')
  })

  test('throws when the player does not exist', async () => {
    const db = makeDb()
    db.player.findUnique.mockResolvedValue(null)
    const service = new LedgerService(db as unknown as PrismaClient)

    await expect(service.getLedger(42n)).rejects.toThrow(NotFoundError)
  })
})
