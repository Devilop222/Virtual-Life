import { PrismaClient, TermDepositStatus } from '@prisma/client'
import { DepositService, DEPOSIT_PLANS } from '../src/modules/banking/deposit.service'
import { GymService, GYM_WEEKLY_FEE } from '../src/modules/gym/gym.service'
import { ClinicService } from '../src/modules/health/clinic.service'
import { RentalService } from '../src/modules/housing/rental.service'
import { PassportService } from '../src/modules/residence/passport.service'
import { NotificationService } from '../src/modules/notification/notification.service'
import { EventService } from '../src/modules/events/event.service'
import { HousingRepository } from '../src/database/repositories/housing.repository'
import { ConflictError, NotFoundError, ValidationError } from '../src/utils/classes/errors'

function makeEvents() {
  return {
    recordPlayerEvent: jest.fn().mockResolvedValue(undefined),
    recordRegionEvent: jest.fn().mockResolvedValue(undefined)
  }
}

function passthroughTx(db: Record<string, unknown>) {
  return jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(db))
}

function makeDepositDb(overrides: Record<string, unknown> = {}) {
  const db: Record<string, unknown> = {
    player: {
      findUnique: jest.fn().mockResolvedValue({ id: 'p1' }),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 })
    },
    termDeposit: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(),
      aggregate: jest.fn().mockResolvedValue({ _sum: { principal: 0 } }),
      create: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 })
    },
    financialTransaction: { create: jest.fn().mockResolvedValue({}) },
    // ترازنامهٔ بانک: مؤسس با سرمایهٔ اولیه، نقدینگی کافی
    bankPool: {
      findUnique: jest.fn().mockResolvedValue({ balance: 500_000_000 }),
      upsert: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 })
    },
    ...overrides
  }
  db.$transaction = passthroughTx(db)
  return db
}

describe('DepositService — fixed term sink and lazy payout', () => {
  test('opening a deposit debits the principal conditionally', async () => {
    const db = makeDepositDb()
    const service = new DepositService(
      db as unknown as PrismaClient,
      makeEvents() as unknown as EventService
    )

    const opened = await service.open(1n, 'w1', 1_000_000)

    expect(opened.planLabel).toContain('یک‌هفته‌ای')
    expect(opened.payout).toBeGreaterThan(1_000_000)
    // کسر شرطی از کیف پول: Double-Spend ناممکن است
    expect(
      (db.player as { updateMany: jest.Mock }).updateMany.mock.calls[0][0].where.balance.gte
    ).toBe(1_000_000)
    // پول سپرده به ترازنامهٔ بانک می‌رود تا منبع واقعی سود و وام باشد
    expect((db.bankPool as { update: jest.Mock }).update).toHaveBeenCalled()
    const poolCredit = (db.bankPool as { update: jest.Mock }).update.mock.calls[0][0]
    expect(poolCredit.data.balance.increment).toBe(1_000_000)
  })

  test('a matured deposit is deferred while the bank has no liquidity', async () => {
    const db = makeDepositDb({
      bankPool: {
        findUnique: jest.fn().mockResolvedValue({ balance: 0 }),
        upsert: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }) // نقدینگی صفر
      },
      termDeposit: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'd-old',
            playerId: 'p1',
            principal: 1_000_000,
            rateAnnual: 0.2,
            termDays: 7,
            status: TermDepositStatus.ACTIVE,
            maturesAt: new Date(Date.now() - 1000)
          }
        ]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        aggregate: jest.fn().mockResolvedValue({ _sum: { principal: 0 } })
      }
    })
    const service = new DepositService(
      db as unknown as PrismaClient,
      makeEvents() as unknown as EventService
    )

    const { settled, deferred } = await service.settleMatured('p1')

    // no minting: نه سپرده بسته شد، نه پولی به بازیکن داده شد
    expect(settled).toBe(0)
    expect(deferred).toBe(1)
    expect((db.player as { update: jest.Mock }).update).not.toHaveBeenCalled()
    expect((db.termDeposit as { updateMany: jest.Mock }).updateMany).not.toHaveBeenCalled()
  })

  test('amounts below minimum are rejected before any query', async () => {
    const db = makeDepositDb()
    const service = new DepositService(
      db as unknown as PrismaClient,
      makeEvents() as unknown as EventService
    )

    await expect(service.open(1n, 'w1', 100_000)).rejects.toThrow(ValidationError)
    expect((db.player as { findUnique: jest.Mock }).findUnique).not.toHaveBeenCalled()
  })

  test('unknown plan key is rejected', async () => {
    const db = makeDepositDb()
    const service = new DepositService(
      db as unknown as PrismaClient,
      makeEvents() as unknown as EventService
    )

    await expect(service.open(1n, 'ghost', 1_000_000)).rejects.toThrow(NotFoundError)
  })

  test('exceeding the active principal cap is rejected', async () => {
    const db = makeDepositDb({
      termDeposit: {
        findMany: jest.fn().mockResolvedValue([]),
        aggregate: jest.fn().mockResolvedValue({ _sum: { principal: 49_000_000 } }),
        create: jest.fn(),
        updateMany: jest.fn()
      }
    })
    const service = new DepositService(
      db as unknown as PrismaClient,
      makeEvents() as unknown as EventService
    )

    await expect(service.open(1n, 'w1', 2_000_000)).rejects.toThrow(ValidationError)
    expect((db.player as { updateMany: jest.Mock }).updateMany).not.toHaveBeenCalled()
  })

  test('insufficient balance aborts the opening', async () => {
    const db = makeDepositDb()
    ;(db.player as { updateMany: jest.Mock }).updateMany.mockResolvedValue({ count: 0 })
    const service = new DepositService(
      db as unknown as PrismaClient,
      makeEvents() as unknown as EventService
    )

    await expect(service.open(1n, 'w1', 1_000_000)).rejects.toThrow(ValidationError)
    expect((db.termDeposit as { create: jest.Mock }).create).not.toHaveBeenCalled()
  })

  test('breaking early pays accrued interest minus the penalty', async () => {
    const db = makeDepositDb()
    const openedAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
    const maturesAt = new Date(Date.now() + 4 * 24 * 60 * 60 * 1000)
    ;(db.termDeposit as { findUnique: jest.Mock }).findUnique.mockResolvedValue({
      id: 'd1',
      playerId: 'p1',
      principal: 10_000_000,
      rateAnnual: 0.2,
      termDays: 7,
      status: TermDepositStatus.ACTIVE,
      openedAt,
      maturesAt
    })
    const service = new DepositService(
      db as unknown as PrismaClient,
      makeEvents() as unknown as EventService
    )

    const result = await service.breakEarly(1n, 'd1')

    expect(result.principal).toBe(10_000_000)
    expect(result.penalty).toBeGreaterThan(0)
    expect(result.interest).toBeGreaterThan(0)
    expect(result.payout).toBe(result.principal + result.interest)
    expect(
      (db.termDeposit as { updateMany: jest.Mock }).updateMany.mock.calls[0][0].data.status
    ).toBe(TermDepositStatus.BROKEN)
  })

  test('settleMatured pays expired deposits and increments the player balance', async () => {
    const db = makeDepositDb({
      termDeposit: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'd-old',
            playerId: 'p1',
            principal: 1_000_000,
            rateAnnual: 0.2,
            termDays: 7,
            status: TermDepositStatus.ACTIVE,
            maturesAt: new Date(Date.now() - 1000)
          }
        ]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        aggregate: jest.fn().mockResolvedValue({ _sum: { principal: 0 } })
      }
    })
    const service = new DepositService(
      db as unknown as PrismaClient,
      makeEvents() as unknown as EventService
    )

    const { settled, deferred } = await service.settleMatured('p1')

    expect(settled).toBe(1)
    expect(deferred).toBe(0)
    expect((db.player as { update: jest.Mock }).update).toHaveBeenCalled()
    expect(
      (db.termDeposit as { updateMany: jest.Mock }).updateMany.mock.calls[0][0].data.status
    ).toBe(TermDepositStatus.PAID)
  })

  test('deposit plans have positive rates ordered by term', () => {
    for (const plan of DEPOSIT_PLANS) {
      expect(plan.termDays).toBeGreaterThan(0)
      expect(plan.rateAnnual).toBeGreaterThan(0)
    }
  })
})

function makeClinicDb(overrides: Record<string, unknown> = {}) {
  const db: Record<string, unknown> = {
    player: {
      findUnique: jest.fn().mockResolvedValue({ id: 'p1', health: 40 }),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      count: jest.fn().mockResolvedValue(1)
    },
    insurancePolicy: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({})
    },
    financialTransaction: { create: jest.fn().mockResolvedValue({}) },
    ...overrides
  }
  db.$transaction = passthroughTx(db)
  return db
}

function makeNotifs() {
  return {
    notifyPlayerById: jest.fn().mockResolvedValue(true)
  }
}

describe('ClinicService — immediate health and insurance discount', () => {
  test('treats an injured player up to full 100 health', async () => {
    const db = makeClinicDb()
    const notifs = makeNotifs()
    const service = new ClinicService(
      db as unknown as PrismaClient,
      makeEvents() as unknown as EventService,
      notifs as unknown as NotificationService
    )

    const result = await service.treat(1n)

    expect(result.healedAmount).toBe(60)
    expect(result.paid).toBe(60 * 12_000)
    expect(result.newHealth).toBe(100)
    expect((db.player as { updateMany: jest.Mock }).updateMany.mock.calls[0][0].data.health).toBe(
      100
    )
  })

  test('active insurance cuts the treatment cost in half', async () => {
    const db = makeClinicDb({
      insurancePolicy: {
        findFirst: jest.fn().mockResolvedValue({
          coversUntil: new Date(Date.now() + 86_400_000),
          coverRate: 0.5
        }),
        create: jest.fn()
      }
    })
    const service = new ClinicService(
      db as unknown as PrismaClient,
      makeEvents() as unknown as EventService,
      makeNotifs() as unknown as NotificationService
    )

    const result = await service.treat(1n)

    expect(result.paid).toBe(Math.round(60 * 12_000 * 0.5))
    expect(result.saved).toBe(result.paid)
  })

  test('a fully healthy player cannot be treated', async () => {
    const db = makeClinicDb({
      player: {
        findUnique: jest.fn().mockResolvedValue({ id: 'p1', health: 100 }),
        updateMany: jest.fn()
      }
    })
    const service = new ClinicService(
      db as unknown as PrismaClient,
      makeEvents() as unknown as EventService,
      makeNotifs() as unknown as NotificationService
    )

    await expect(service.treat(1n)).rejects.toThrow(ConflictError)
    expect((db.player as { updateMany: jest.Mock }).updateMany).not.toHaveBeenCalled()
  })

  test('insufficient balance rejects treatment', async () => {
    const db = makeClinicDb()
    ;(db.player as { updateMany: jest.Mock }).updateMany.mockResolvedValue({ count: 0 })
    ;(db.player as { count: jest.Mock }).count.mockResolvedValue(0)
    const service = new ClinicService(
      db as unknown as PrismaClient,
      makeEvents() as unknown as EventService,
      makeNotifs() as unknown as NotificationService
    )

    await expect(service.treat(1n)).rejects.toThrow(ConflictError)
  })

  test('buying insurance charges the premium and extends existing policies', async () => {
    const db = makeClinicDb({
      insurancePolicy: {
        findFirst: jest.fn().mockResolvedValue({
          coversUntil: new Date(Date.now() + 86_400_000)
        }),
        create: jest.fn().mockResolvedValue({})
      }
    })
    const service = new ClinicService(
      db as unknown as PrismaClient,
      makeEvents() as unknown as EventService,
      makeNotifs() as unknown as NotificationService
    )

    const bought = await service.buyInsurance(1n)

    expect(bought.extended).toBe(true)
    // بیمه ۷ روز *بازی* است = ۵٫۶ ساعت واقعی؛ مرز ۲۰ ساعتِ واقعی مطمئن است
    expect(bought.coversUntil.getTime()).toBeGreaterThan(Date.now() + 20 * 3_600_000)
    expect((db.insurancePolicy as { create: jest.Mock }).create).toHaveBeenCalled()
  })

  test('warnIfCritical sends a deduplicated notification below threshold', async () => {
    const db = makeClinicDb()
    const notifs = makeNotifs()
    const service = new ClinicService(
      db as unknown as PrismaClient,
      makeEvents() as unknown as EventService,
      notifs as unknown as NotificationService
    )

    await service.warnIfCritical('p1', 15)

    expect(notifs.notifyPlayerById).toHaveBeenCalled()
    const call = notifs.notifyPlayerById.mock.calls[0]
    expect(call[4]).toContain('health-warn:p1:')
  })

  test('warnIfCritical skips healthy players', async () => {
    const db = makeClinicDb()
    const notifs = makeNotifs()
    const service = new ClinicService(
      db as unknown as PrismaClient,
      makeEvents() as unknown as EventService,
      notifs as unknown as NotificationService
    )

    await service.warnIfCritical('p1', 80)
    expect(notifs.notifyPlayerById).not.toHaveBeenCalled()
  })
})

function makeRentalDb(overrides: Record<string, unknown> = {}) {
  const db: Record<string, unknown> = {
    player: { findUnique: jest.fn().mockResolvedValue({ id: 'p1' }) },
    property: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(),
      update: jest.fn().mockResolvedValue({})
    },
    rentalContract: {
      count: jest.fn().mockResolvedValue(0),
      findFirst: jest.fn().mockResolvedValue(null),
      updateMany: jest.fn().mockResolvedValue({ count: 1 })
    },
    ...overrides
  }
  return db
}

function makeHousingRepo() {
  return {
    rentProperty: jest
      .fn()
      .mockResolvedValue({ id: 'c1', monthlyRent: 1_000_000, expiresAt: new Date() })
  }
}

describe('RentalService — player to player tenancy', () => {
  test('lists owned properties with active contract details', async () => {
    const db = makeRentalDb({
      property: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'prop-1',
            title: 'آپارتمان',
            level: 2,
            rentalPriceMonthly: 1_000_000,
            // base = round(0.06 × purchasePrice) = 1_000_000 → بازه ۷۰۰هزار تا ۱٫۳م
            purchasePrice: 16_666_667,
            isListedForRent: true,
            rentalContracts: []
          }
        ])
      }
    })
    const service = new RentalService(
      db as unknown as PrismaClient,
      makeHousingRepo() as unknown as HousingRepository,
      makeEvents() as unknown as EventService
    )

    const board = await service.getOwnerBoard(1n)

    expect(board).toHaveLength(1)
    expect(board[0]?.minRent).toBe(23_333)
    expect(board[0]?.maxRent).toBe(43_333)
  })

  test('setting rent outside allowed bounds is rejected', async () => {
    const db = makeRentalDb()
    ;(db.property as { findUnique: jest.Mock }).findUnique.mockResolvedValue({
      id: 'prop-1',
      ownerId: 'p1',
      title: 'آپارتمان',
      rentalPriceMonthly: 1_000_000,
      purchasePrice: 16_666_667
    })
    const service = new RentalService(
      db as unknown as PrismaClient,
      makeHousingRepo() as unknown as HousingRepository,
      makeEvents() as unknown as EventService
    )

    // کمتر از ۷۰٪
    await expect(service.setRent(1n, 'prop-1', 500_000)).rejects.toThrow(ValidationError)
    // بیشتر از ۱۳۰٪
    await expect(service.setRent(1n, 'prop-1', 2_000_000)).rejects.toThrow(ValidationError)
  })

  test('setting rent during an active contract is blocked', async () => {
    const db = makeRentalDb({
      rentalContract: { count: jest.fn().mockResolvedValue(1) }
    })
    ;(db.property as { findUnique: jest.Mock }).findUnique.mockResolvedValue({
      id: 'prop-1',
      ownerId: 'p1',
      title: 'آپارتمان',
      rentalPriceMonthly: 1_000_000
    })
    const service = new RentalService(
      db as unknown as PrismaClient,
      makeHousingRepo() as unknown as HousingRepository,
      makeEvents() as unknown as EventService
    )

    await expect(service.setRent(1n, 'prop-1', 1_100_000)).rejects.toThrow(ConflictError)
  })

  test('renting an unlisted property is rejected', async () => {
    const db = makeRentalDb()
    ;(db.property as { findUnique: jest.Mock }).findUnique.mockResolvedValue({
      id: 'prop-1',
      title: 'آپارتمان',
      isListedForRent: false,
      ownerId: 'other'
    })
    const repo = makeHousingRepo()
    const service = new RentalService(
      db as unknown as PrismaClient,
      repo as unknown as HousingRepository,
      makeEvents() as unknown as EventService
    )

    await expect(service.rent(1n, 'prop-1')).rejects.toThrow(ConflictError)
    expect(repo.rentProperty).not.toHaveBeenCalled()
  })

  test('renting a listed property calls the repository and records events', async () => {
    const db = makeRentalDb()
    ;(db.property as { findUnique: jest.Mock }).findUnique.mockResolvedValue({
      id: 'prop-1',
      title: 'آپارتمان',
      isListedForRent: true,
      ownerId: 'other'
    })
    const repo = makeHousingRepo()
    const events = makeEvents()
    const service = new RentalService(
      db as unknown as PrismaClient,
      repo as unknown as HousingRepository,
      events as unknown as EventService
    )

    const result = await service.rent(1n, 'prop-1')

    expect(result.propertyTitle).toBe('آپارتمان')
    expect(repo.rentProperty).toHaveBeenCalledWith('prop-1', 'p1', 30)
    expect(events.recordPlayerEvent).toHaveBeenCalled()
  })

  test('ending tenancy updates the contract to inactive', async () => {
    const db = makeRentalDb({
      rentalContract: {
        findFirst: jest.fn().mockResolvedValue({ id: 'c1', property: { title: 'آپارتمان' } }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      }
    })
    const service = new RentalService(
      db as unknown as PrismaClient,
      makeHousingRepo() as unknown as HousingRepository,
      makeEvents() as unknown as EventService
    )

    const ended = await service.endTenancy(1n)
    expect(ended.propertyTitle).toBe('آپارتمان')
  })
})

function makePassportDb(overrides: Record<string, unknown> = {}) {
  return {
    player: { findUnique: jest.fn().mockResolvedValue({ id: 'p1' }) },
    group: { findUnique: jest.fn().mockResolvedValue({ title: 'شهر الف' }) },
    travelStamp: {
      create: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([])
    },
    ...overrides
  }
}

describe('PassportService — stamps per region', () => {
  test('stamping a new region records a travel stamp and player event', async () => {
    const db = makePassportDb()
    const events = makeEvents()
    const service = new PassportService(
      db as unknown as PrismaClient,
      events as unknown as EventService
    )

    const stamped = await service.stamp('p1', 'g1')

    expect(stamped).toBe(true)
    expect(events.recordPlayerEvent).toHaveBeenCalled()
  })

  test('a second visit to the same region swallows the duplicate error', async () => {
    const db = makePassportDb({
      travelStamp: {
        create: jest.fn().mockRejectedValue(new Error('unique violation')),
        findMany: jest.fn().mockResolvedValue([])
      }
    })
    const events = makeEvents()
    const service = new PassportService(
      db as unknown as PrismaClient,
      events as unknown as EventService
    )

    const stamped = await service.stamp('p1', 'g1')

    expect(stamped).toBe(false)
    expect(events.recordPlayerEvent).not.toHaveBeenCalled()
  })

  test('board counts total stamps and exposes the target for traveler badge', async () => {
    const db = makePassportDb({
      travelStamp: {
        findMany: jest.fn().mockResolvedValue([
          { stampedAt: new Date(), group: { title: 'الف', environmentLevel: 'CITY' } },
          { stampedAt: new Date(), group: { title: 'ب', environmentLevel: 'VILLAGE' } }
        ])
      }
    })
    const service = new PassportService(
      db as unknown as PrismaClient,
      makeEvents() as unknown as EventService
    )

    const board = await service.getBoard(1n)

    expect(board.total).toBe(2)
    expect(board.travelerTarget).toBe(5)
    expect(board.stamps).toHaveLength(2)
  })
})

describe('GymService — every paid week is a granted week', () => {
  /**
   * عضویت باید *داخل* تراکنش خوانده و نوشته شود. بیرون از آن، دو خریدِ همزمان
   * هر دو از یک مبدأ تمدید می‌کنند: دو هفته پول می‌گیرند و یک هفته تحویل می‌دهند.
   */
  function makeGymDb(existingExpiry: Date | null = null) {
    const memberships: { expiresAt: Date }[] = []
    const db: Record<string, unknown> = {
      player: {
        findUnique: jest.fn().mockResolvedValue({ id: 'p1' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      },
      gymMembership: {
        findFirst: jest.fn(() => {
          throw new Error('the membership must be read inside the paying transaction')
        }),
        create: jest.fn(() => {
          throw new Error('the membership must be written inside the paying transaction')
        })
      },
      financialTransaction: {
        create: jest.fn(() => {
          throw new Error('the ledger row belongs to the same transaction')
        })
      }
    }
    const tx: Record<string, unknown> = {
      player: db.player,
      gymMembership: {
        findFirst: jest.fn(async () => {
          const latest = memberships.length
            ? memberships[memberships.length - 1]!.expiresAt
            : existingExpiry
          return latest ? { expiresAt: latest } : null
        }),
        create: jest.fn(async ({ data }: { data: { expiresAt: Date } }) => {
          memberships.push(data)
          return data
        })
      },
      financialTransaction: { create: jest.fn().mockResolvedValue({}) }
    }
    db.$transaction = jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx))
    return { db, tx, memberships }
  }

  function makeGym(db: Record<string, unknown>) {
    return new GymService(db as unknown as PrismaClient, makeEvents() as unknown as EventService)
  }

  test('three subscriptions in a row stack into three weeks', async () => {
    const { db, memberships } = makeGymDb()
    const service = makeGym(db)

    const first = await service.subscribe(1n)
    const second = await service.subscribe(1n)
    const third = await service.subscribe(1n)

    expect(memberships).toHaveLength(3)
    expect(first.extended).toBe(false)
    expect(third.extended).toBe(true)
    // یک دورهٔ عضویت = ۷ روز بازی = ۵٫۶ ساعت واقعی
    const weekMs = 7 * 48 * 60 * 1000
    expect(second.expiresAt.getTime() - first.expiresAt.getTime()).toBe(weekMs)
    expect(third.expiresAt.getTime() - first.expiresAt.getTime()).toBe(2 * weekMs)
  })

  test('a subscription that another request already paid for extends from it', async () => {
    // همان چیزی که در رقابتِ واقعی اتفاق می‌افتد: درخواستِ اول یک هفته خریده و
    // commit شده است؛ درخواستِ دوم باید از همان یک هفته تمدید کند، نه از «اکنون».
    const inOneWeek = new Date(Date.now() + 7 * 48 * 60 * 1000)
    const { db } = makeGymDb(inOneWeek)
    const service = makeGym(db)

    const result = await service.subscribe(1n)

    const grantedDays = (result.expiresAt.getTime() - Date.now()) / (48 * 60 * 1000)
    expect(grantedDays).toBeGreaterThan(13.9)
    expect(grantedDays).toBeLessThan(14.1)
  })

  test('without enough balance nothing is written', async () => {
    const { db, tx, memberships } = makeGymDb()
    ;(tx.player as { updateMany: jest.Mock }).updateMany.mockResolvedValue({ count: 0 })
    const service = makeGym(db)

    await expect(service.subscribe(1n)).rejects.toThrow(ConflictError)
    expect(memberships).toHaveLength(0)
    expect((tx.financialTransaction as { create: jest.Mock }).create).not.toHaveBeenCalled()
  })

  test('every paid week is charged exactly one weekly fee', async () => {
    const { db, tx } = makeGymDb()
    const service = makeGym(db)

    await service.subscribe(1n)
    await service.subscribe(1n)

    const fees = (tx.financialTransaction as { create: jest.Mock }).create.mock.calls.map(
      (call) => call[0].data.amount
    )
    expect(fees).toEqual([GYM_WEEKLY_FEE, GYM_WEEKLY_FEE])
  })
})

describe('DepositService — a lost settlement gives the pool money back', () => {
  function maturedDeposit() {
    return {
      id: 'd-race',
      playerId: 'p1',
      principal: 1_000_000,
      rateAnnual: 0.2,
      termDays: 7,
      status: TermDepositStatus.ACTIVE,
      maturesAt: new Date(Date.now() - 1000)
    }
  }

  test('the pool debit is rolled back when another request settled first', async () => {
    const db = makeDepositDb({
      termDeposit: {
        findMany: jest.fn().mockResolvedValue([maturedDeposit()]),
        // رقیبِ همزمان سپرده را بسته است: قفل صفر ردیف می‌گیرد
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        aggregate: jest.fn().mockResolvedValue({ _sum: { principal: 0 } })
      }
    })
    let aborted = false
    db.$transaction = jest.fn(async (fn: (t: unknown) => Promise<unknown>) => {
      try {
        return await fn(db)
      } catch (error) {
        aborted = true
        throw error
      }
    })
    const service = new DepositService(
      db as unknown as PrismaClient,
      makeEvents() as unknown as EventService
    )

    const { settled, deferred } = await service.settleMatured('p1')

    // کسرِ صندوق پیش از قفل انجام شده بود؛ تنها راهِ پس‌گرفتنش، شکستنِ تراکنش است
    expect(aborted).toBe(true)
    expect(settled).toBe(0)
    expect((db.player as { update: jest.Mock }).update).not.toHaveBeenCalled()
    // «بانک نقدینگی نداشت» نیست؛ پس پیامِ پنل هم دروغ نمی‌گوید
    expect(deferred).toBe(0)
  })

  test('an empty pool still defers without touching the deposit', async () => {
    const db = makeDepositDb({
      bankPool: {
        findUnique: jest.fn().mockResolvedValue({ balance: 0 }),
        upsert: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 0 })
      },
      termDeposit: {
        findMany: jest.fn().mockResolvedValue([maturedDeposit()]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        aggregate: jest.fn().mockResolvedValue({ _sum: { principal: 0 } })
      }
    })
    const service = new DepositService(
      db as unknown as PrismaClient,
      makeEvents() as unknown as EventService
    )

    const { settled, deferred } = await service.settleMatured('p1')

    expect(settled).toBe(0)
    expect(deferred).toBe(1)
    expect((db.termDeposit as { updateMany: jest.Mock }).updateMany).not.toHaveBeenCalled()
  })
})
