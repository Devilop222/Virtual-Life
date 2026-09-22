/**
 * رگرسیون race condition اجاره: «هر ملک/هر مستأجر یک قرارداد فعال»
 * با یونیک‌ایندکس partial تضمین می‌شود؛ چک‌های read-then-create قبلی
 * دو درخواست همزمان را رد نمی‌کردند و دو قرارداد + دو پرداخت می‌ساختند.
 *
 * این فایل حالا مسیرهای تازه را هم پوشش می‌دهد:
 *  • تمدید (پرداخت اجاره) — race دوپرداختی با CAS روی expiresAt + جریان پول
 *  • فروش ملک — race دوفروشی + محافظت‌های اجاره/وثیقه + عدم خلق پول
 *  • انقضای Lazy قرارداد + اعلان هر دو طرف
 */
import { Prisma, PrismaClient, PropertyStatus, RentalContract, TransactionType } from '@prisma/client'
import { HousingRepository } from '../src/database/repositories/housing.repository'
import { RentalService } from '../src/modules/housing/rental.service'
import { ConflictError, ValidationError } from '../src/utils/classes/errors'

const PROPERTY = {
  id: 'prop1',
  title: 'ویلای شمالی',
  status: PropertyStatus.OWNED,
  ownerId: 'owner1',
  isListedForRent: true,
  rentalPriceMonthly: 1_500_000
}

function p2002(indexName: string) {
  return new Prisma.PrismaClientKnownRequestError(
    `duplicate key value violates unique constraint "${indexName}"`,
    {
      code: 'P2002',
      clientVersion: 'test',
      meta: { message: `duplicate key value violates unique constraint "${indexName}"` }
    }
  )
}

function makeRepo(
  createResult: Promise<RentalContract> | Promise<never>,
  txOverrides: Record<string, unknown> = {}
) {
  const tx = {
    property: {
      findUnique: jest.fn().mockResolvedValue(PROPERTY),
      updateMany: jest.fn().mockResolvedValue({ count: 1 })
    },
    rentalContract: {
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue(null),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      create: jest.fn().mockReturnValue(createResult)
    },
    loan: { findFirst: jest.fn().mockResolvedValue(null) },
    player: {
      findUnique: jest.fn().mockResolvedValue({ id: 'owner1' }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({})
    },
    financialTransaction: { create: jest.fn().mockResolvedValue({}) },
    ...txOverrides
  }
  const db = { $transaction: jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx)) }
  return { repo: new HousingRepository(db as unknown as PrismaClient), tx }
}

describe('RentalContract uniqueness — the database, not the check, decides', () => {
  test('the loser of a property-side race gets a precise persian message', async () => {
    const { repo } = makeRepo(Promise.reject(p2002('one_active_rental_per_property')))

    const err = await repo
      .rentProperty('prop1', 'tenant1')
      .then(() => null, (e: Error & { persianMessage?: string }) => e)

    expect(err).toBeInstanceOf(ConflictError)
    expect(err?.persianMessage).toContain('این ملک')
  })

  test('the loser of a tenant-side race is told they already rent somewhere', async () => {
    const { repo } = makeRepo(Promise.reject(p2002('one_active_rental_per_tenant')))

    const err = await repo
      .rentProperty('prop1', 'tenant1')
      .then(() => null, (e: Error & { persianMessage?: string }) => e)

    expect(err).toBeInstanceOf(ConflictError)
    expect(err?.persianMessage).toContain('یک قرارداد اجارهٔ فعال داری')
  })

  test('a unique violation with an unknown index still becomes a conflict, never a crash', async () => {
    const { repo } = makeRepo(Promise.reject(p2002('some_future_index')))

    const err = await repo
      .rentProperty('prop1', 'tenant1')
      .then(() => null, (e: Error & { persianMessage?: string }) => e)

    expect(err).toBeInstanceOf(ConflictError)
  })

  test('expired-but-active contracts are lazily closed inside the same transaction', async () => {
    const contract = {
      id: 'c1',
      propertyId: 'prop1',
      tenantId: 'tenant1',
      monthlyRent: 1_500_000,
      startedAt: new Date(),
      expiresAt: new Date(Date.now() + 30 * 86_400_000),
      isActive: true
    } as unknown as RentalContract
    const { repo, tx } = makeRepo(Promise.resolve(contract))

    await repo.rentProperty('prop1', 'tenant1')

    // بستن تنبلِ منقضی‌ها باید قبل از create و با شرط expiresAt آمده باشد
    expect(tx.rentalContract.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          isActive: true,
          expiresAt: { lte: expect.any(Date) }
        }),
        data: { isActive: false }
      })
    )
    expect(tx.rentalContract.create).toHaveBeenCalled()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// تمدید (پرداخت اجاره): race دوپرداختی + جریان پول واقعی
// ─────────────────────────────────────────────────────────────────────────────

const CONTRACT_ROW = {
  id: 'c1',
  tenantId: 'tenant1',
  isActive: true,
  monthlyRent: 1_500_000,
  property: {
    id: 'prop1',
    title: 'ویلای شمالی',
    owner: { id: 'owner1' }
  }
} as unknown as RentalContract & { property: { id: string; title: string; owner: { id: string } } }

function makeRenewRepo(renewUpdateCount: number, tenantBalanceOk = true) {
  const tx = {
    rentalContract: {
      findUnique: jest.fn().mockResolvedValue(CONTRACT_ROW),
      updateMany: jest.fn().mockResolvedValue({ count: renewUpdateCount })
    },
    player: {
      // اولین updateMany = کسرِ شرطی از مستأجر
      updateMany: jest.fn().mockResolvedValue({ count: tenantBalanceOk ? 1 : 0 }),
      update: jest.fn().mockResolvedValue({})
    },
    financialTransaction: { create: jest.fn().mockResolvedValue({}) }
  }
  const db = { $transaction: jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx)) }
  return { repo: new HousingRepository(db as unknown as PrismaClient), tx }
}

describe('renewRental — one payment, one extension', () => {
  const oldExp = new Date(Date.now() + 5 * 86_400_000)

  test('winner: money moves tenant→owner, ledger row has both sides, 30-day extension', async () => {
    const { repo, tx } = makeRenewRepo(1)

    const result = await repo.renewRental('c1', 'tenant1', 1_500_000, oldExp, new Date(oldExp.getTime() + 30 * 86_400_000))

    expect(result.ownerId).toBe('owner1')
    // کسر شرطی از مستأجر (guard against double-spend)
    expect(tx.player.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'tenant1', balance: { gte: 1_500_000 } },
        data: { balance: { decrement: 1_500_000 } }
      })
    )
    // واریز دقیقاً به مالک — نه بیشتر، نه کمتر
    expect(tx.player.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'owner1' },
        data: { balance: { increment: 1_500_000 } }
      })
    )
    // یک ردیف واحد PROPERTY_RENT با هر دو طرف
    expect(tx.financialTransaction.create).toHaveBeenCalledWith({
      data: {
        amount: 1_500_000,
        type: TransactionType.PROPERTY_RENT,
        sourcePlayerId: 'tenant1',
        destinationPlayerId: 'owner1',
        reference: expect.any(String)
      }
    })
  })

  test('loser of the double-click race gets a clean conflict, no money moves', async () => {
    const { repo, tx } = makeRenewRepo(0)

    const err = await repo
      .renewRental('c1', 'tenant1', 1_500_000, oldExp, new Date())
      .then(() => null, (e: Error) => e)

    expect(err).toBeInstanceOf(ConflictError)
    // هیچ پولی جابه‌جا نشده: نه کسر، نه واریز، نه تراکنش
    expect(tx.player.updateMany).not.toHaveBeenCalled()
    expect(tx.player.update).not.toHaveBeenCalled()
    expect(tx.financialTransaction.create).not.toHaveBeenCalled()
  })

  test('insufficient tenant balance: conflict, contract untouched', async () => {
    const { repo, tx } = makeRenewRepo(1, false)

    const err = await repo
      .renewRental('c1', 'tenant1', 1_500_000, oldExp, new Date())
      .then(() => null, (e: Error) => e)

    expect(err).toBeInstanceOf(ValidationError)
    expect(tx.player.update).not.toHaveBeenCalled()
    expect(tx.financialTransaction.create).not.toHaveBeenCalled()
  })

  test('CAS must key on the old expiresAt (stale callback rejected)', async () => {
    const { repo, tx } = makeRenewRepo(1)

    await repo.renewRental('c1', 'tenant1', 1_500_000, oldExp, new Date())

    expect(tx.rentalContract.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'c1', isActive: true, tenantId: 'tenant1', expiresAt: oldExp })
      })
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// فروش ملک: race دوفروشی + بدون خلق پول
// ─────────────────────────────────────────────────────────────────────────────

describe('sellProperty — one sale, real cash-out', () => {
  test('winner: ownership released, balance credited, dest-only ledger row', async () => {
    const { repo, tx } = makeRepo(Promise.resolve({} as RentalContract))

    const result = await repo.sellProperty('prop1', 'owner1', 900_000)

    expect(result).toEqual({ title: 'ویلای شمالی' })
    expect(tx.property.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'prop1', ownerId: 'owner1' },
        data: expect.objectContaining({ ownerId: null, status: PropertyStatus.AVAILABLE, isListedForRent: false })
      })
    )
    expect(tx.player.update).toHaveBeenCalledWith({
      where: { id: 'owner1' },
      data: { balance: { increment: 900_000 } }
    })
    expect(tx.financialTransaction.create).toHaveBeenCalledWith({
      data: {
        amount: 900_000,
        type: TransactionType.PROPERTY_SALE,
        destinationPlayerId: 'owner1',
        reference: expect.any(String)
      }
    })
  })

  test('loser of a double-click sale: no money, clean conflict', async () => {
    const { repo, tx } = makeRepo(
      Promise.resolve({} as RentalContract),
      { property: { findUnique: jest.fn().mockResolvedValue(PROPERTY), updateMany: jest.fn().mockResolvedValue({ count: 0 }) } }
    )

    const err = await repo.sellProperty('prop1', 'owner1', 900_000).then(() => null, (e: Error) => e)

    expect(err).toBeInstanceOf(ConflictError)
    expect(tx.player.update).not.toHaveBeenCalled()
    expect(tx.financialTransaction.create).not.toHaveBeenCalled()
  })

  test('a rented-out property cannot be sold', async () => {
    const { repo, tx } = makeRepo(
      Promise.resolve({} as RentalContract),
      {
        rentalContract: {
          findFirst: jest.fn().mockResolvedValue({ id: 'c1', isActive: true, expiresAt: new Date(Date.now() + 86_400_000) }),
          findUnique: jest.fn().mockResolvedValue(null),
          updateMany: jest.fn().mockResolvedValue({ count: 0 }),
          create: jest.fn()
        }
      }
    )

    const err = await repo.sellProperty('prop1', 'owner1', 900_000).then(() => null, (e: Error) => e)

    expect(err).toBeInstanceOf(ConflictError)
    expect(tx.player.update).not.toHaveBeenCalled()
  })

  test('a property pledged as loan collateral cannot be sold', async () => {
    const { repo, tx } = makeRepo(
      Promise.resolve({} as RentalContract),
      { loan: { findFirst: jest.fn().mockResolvedValue({ id: 'loan1', status: 'ACTIVE' }) } }
    )

    const err = await repo.sellProperty('prop1', 'owner1', 900_000).then(() => null, (e: Error) => e)

    expect(err).toBeInstanceOf(ConflictError)
    expect(tx.player.update).not.toHaveBeenCalled()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// سرویس: تمدید با اعلان هر دو طرف + انقضای Lazy
// ─────────────────────────────────────────────────────────────────────────────

function makeService(
  dbMock: Record<string, unknown>,
  repoMock: Record<string, unknown>,
  extra?: { notify?: (playerId: string, title: string, message: string, type?: unknown, dedupeKey?: string, level?: string) => Promise<boolean> }
) {
  const eventService = { recordPlayerEvent: jest.fn().mockResolvedValue(undefined) }
  const service = new RentalService(
    dbMock as unknown as PrismaClient,
    repoMock as unknown as HousingRepository,
    eventService as never,
    extra?.notify
      ? {
          notifyPlayerById: (playerId: string, title: string, message: string, type?: unknown, dedupeKey?: string, level?: string) =>
            extra.notify!(playerId, title, message, type, dedupeKey, level)
        }
      : undefined
  )
  return { service, eventService }
}

describe('RentalService.renewRental — notifications and guardrails', () => {
  const oldExp = new Date(Date.now() + 5 * 86_400_000)

  test('success: repo called with CAS args, both parties notified with dedupe keys', async () => {
    const repoMock = {
      renewRental: jest
        .fn()
        .mockResolvedValue({ ownerId: 'owner1' })
    }
    const calls: Array<{ playerId: string; dedupeKey: string; level: string }> = []
    const dbMock = {
      player: {
        findUnique: jest.fn().mockResolvedValue({ id: 'tenant1', firstName: 'مستأجر', lastName: 'تست' })
      },
      rentalContract: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'c1',
          monthlyRent: 1_500_000,
          expiresAt: oldExp,
          property: { id: 'prop1', title: 'ویلای شمالی', ownerId: 'owner1' }
        })
      }
    }
    const notify = jest.fn(async (playerId: string, _title: string, _message: string, _type?: unknown, dedupeKey?: string, level?: string) => {
      calls.push({ playerId, dedupeKey: dedupeKey ?? '', level: level ?? '' })
      return true
    })
    const { service } = makeService(dbMock, repoMock, { notify })

    const result = await service.renewRental(1n)

    expect(result.propertyTitle).toBe('ویلای شمالی')
    expect(result.monthlyRent).toBe(1_500_000)
    expect(result.daysLeft).toBeGreaterThanOrEqual(29)
    expect(result.daysLeft).toBeLessThanOrEqual(31)

    expect(repoMock.renewRental).toHaveBeenCalledWith(
      'c1',
      'tenant1',
      1_500_000,
      oldExp,
      expect.any(Date)
    )
    // موعد جدید ≈ ۳۰ روز از الآن
    const newExp = (repoMock.renewRental as jest.Mock).mock.calls[0][4] as Date
    // قرارداد تازه یک ماه بازی است؛ هر ماه بازی یک روز واقعی = ۳۰ روز بازی
    expect(newExp.getTime() - Date.now()).toBeGreaterThan(29 * 48 * 60 * 1000)

    const ownerCall = calls.find((c) => c.playerId === 'owner1')
    const tenantCall = calls.find((c) => c.playerId === 'tenant1')
    expect(ownerCall).toMatchObject({ level: 'CRITICAL' })
    expect(ownerCall?.dedupeKey).toMatch(/^rent-payment-owner:c1:\d+$/)
    expect(tenantCall).toMatchObject({ level: 'IMPORTANT' })
    expect(tenantCall?.dedupeKey).toMatch(/^rent-payment-tenant:c1:\d+$/)
  })

  test('without an active tenancy: clean conflict, no repo call', async () => {
    const repoMock = { renewRental: jest.fn() }
    const dbMock = {
      player: { findUnique: jest.fn().mockResolvedValue({ id: 'tenant1' }) },
      rentalContract: { findFirst: jest.fn().mockResolvedValue(null) }
    }
    const { service } = makeService(dbMock, repoMock)

    await expect(service.renewRental(1n)).rejects.toBeInstanceOf(ConflictError)
    expect(repoMock.renewRental).not.toHaveBeenCalled()
  })
})

describe('RentalService — lazy expiry notifies both parties once', () => {
  test('expired contract is closed on tenant visit and both are notified', async () => {
    const calls: Array<{ playerId: string; dedupeKey: string }> = []
    const notify = jest.fn(async (playerId: string, _title: string, _message: string, _type?: unknown, dedupeKey?: string) => {
      calls.push({ playerId, dedupeKey: dedupeKey ?? '' })
      return true
    })
    const dbMock = {
      player: { findUnique: jest.fn().mockResolvedValue({ id: 'tenant1' }) },
      rentalContract: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'c1',
            tenant: { firstName: 'مستأجر' },
            property: { title: 'ویلای شمالی', ownerId: 'owner1' }
          }
        ]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findFirst: jest.fn().mockResolvedValue(null)
      }
    }
    const { service } = makeService(dbMock, {}, { notify })

    const tenancy = await service.getTenancy(1n)

    expect(tenancy).toBeNull()
    expect(dbMock.rentalContract.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'c1', isActive: true, expiresAt: { lte: expect.any(Date) } }),
        data: { isActive: false }
      })
    )
    const tenantNotify = calls.find((c) => c.playerId === 'tenant1')
    const ownerNotify = calls.find((c) => c.playerId === 'owner1')
    expect(tenantNotify?.dedupeKey).toBe('rental-expired-tenant:c1')
    expect(ownerNotify?.dedupeKey).toBe('rental-expired-owner:c1')
  })
})
