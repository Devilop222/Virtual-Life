/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * تست‌های بازگشتی (Regression) رفع‌های Production — هر تست دقیقاً روی باگی
 * که رفع شد قفل می‌کند تا بازگشت رفتار قدیمی (و پول‌سازی/سرریز آن) ممکن
 * نباشد.
 */
import { GrammyError } from 'grammy'
import { Prisma, PrismaClient } from '@prisma/client'
import { ConflictError, NotFoundError } from '../src/utils/classes/errors'
import { AuctionService } from '../src/modules/auction/auction.service'
import { PlayerLoanService } from '../src/modules/lending/player-loan.service'
import { DailyQuestService, QUEST_REWARDS } from '../src/modules/quests/daily-quest.service'
import { ClinicService } from '../src/modules/health/clinic.service'
import { ShopService } from '../src/modules/shop/shop.service'
import { RegionService } from '../src/modules/city/region.service'
import { ElectionsService } from '../src/modules/city/elections.service'
import { CreditService } from '../src/modules/finance/credit.service'
import { editPanel, sendPanel } from '../src/bot/panel'
import { panelOwnerMiddleware } from '../src/bot/middleware/panel-owner.middleware'
import { weekIndex } from '../src/utils/game-time'

function makeEvents() {
  return {
    recordPlayerEvent: jest.fn().mockResolvedValue(undefined),
    recordRegionEvent: jest.fn().mockResolvedValue(undefined)
  }
}

function txOf(db: Record<string, unknown>): (fn: (t: unknown) => Promise<unknown>) => Promise<unknown> {
  return async (fn: (t: unknown) => Promise<unknown>) => fn(db)
}

function p2002(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    'Unique constraint failed',
    { code: 'P2002', clientVersion: '6.19.3' }
  )
}

// ─────────────────────────── Auction ───────────────────────────

describe('AuctionService — self-bid guard', () => {
  function makeDb() {
    const db: Record<string, any> = {
      player: {
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      },
      auction: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        create: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      },
      auctionBid: { create: jest.fn() },
      playerInventory: { upsert: jest.fn() },
      financialTransaction: { create: jest.fn() },
      shopItem: {
        findUnique: jest.fn().mockResolvedValue({ id: 'item1' }),
        create: jest.fn()
      },
      regionStat: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn(),
        updateMany: jest.fn()
      }
    }
    db.$transaction = jest.fn(txOf(db))
    return db
  }

  const week = weekIndex()

  test('the current leader cannot bid on their own auction (server-side)', async () => {
    const db = makeDb()
    const auctionRow = {
      id: 'a1',
      isClosed: false,
      weekKey: week,
      currentBid: 5_000_000,
      startingBid: 5_000_000,
      highestBidderId: 'p1',
      itemName: 'مجسمهٔ طلایی شهر'
    }
    db.auction.findUnique.mockResolvedValue(auctionRow)
    db.player.findUnique.mockResolvedValue({ id: 'p1' })
    const service = new AuctionService(db as unknown as PrismaClient, makeEvents() as never)

    // رهبر فعلی روی پیشنهاد خودش بالا بزند → باید Reject شود، نه پول کسر شود
    await expect(service.placeBid(1n, 'a1', 6_000_000)).rejects.toThrow(ConflictError)
    expect(db.player.updateMany).not.toHaveBeenCalled()
    expect(db.auction.updateMany).not.toHaveBeenCalled()
  })

  test('a different player can outbid the leader and the old bid is refunded', async () => {
    const db = makeDb()
    const auctionRow = {
      id: 'a1',
      isClosed: false,
      weekKey: week,
      currentBid: 5_000_000,
      startingBid: 5_000_000,
      highestBidderId: 'p2',
      itemName: 'مجسمهٔ طلایی شهر'
    }
    db.auction.findUnique.mockResolvedValue(auctionRow)
    db.player.findUnique.mockResolvedValue({ id: 'p1' })
    const service = new AuctionService(db as unknown as PrismaClient, makeEvents() as never)

    await expect(service.placeBid(1n, 'a1', 6_000_000)).resolves.toBeDefined()
    // کسر از خریدار
    expect(db.player.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 'p1' }) })
    )
    // بازگشتِ امانیِ قبلی به p2
    expect(db.player.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'p2' }, data: { balance: { increment: 5_000_000 } } })
    )
  })

  test('getView reports amILeader for the leader and false for others', async () => {
    const db = makeDb()
    db.auction.findFirst.mockResolvedValue({ id: 'a1' })
    db.auction.findUniqueOrThrow.mockResolvedValue({
      id: 'a1',
      itemName: 'مجسمهٔ طلایی شهر',
      itemKey: 'golden_statue',
      startingBid: 5_000_000,
      currentBid: 6_000_000,
      highestBidderId: 'p1',
      isClosed: false,
      _count: { bids: 1 }
    })
    const playerRow: Record<string, unknown> = { firstName: 'الف', lastName: null }
    db.player.findUnique.mockImplementation(({ where }: { where: { telegramUserId: bigint } }) =>
      Promise.resolve(where.telegramUserId === 1n ? { id: 'p1' } : { id: 'p9' })
    )
    void playerRow
    const service = new AuctionService(db as unknown as PrismaClient, makeEvents() as never)

    const leaderView = await service.getView('g1', 1n)
    expect(leaderView.amILeader).toBe(true)

    const otherView = await service.getView('g1', 9n)
    expect(otherView.amILeader).toBe(false)
  })
})

// ─────────────────────────── Auction settlement ───────────────────────────

describe('AuctionService — تسویه به شهر می‌رسد و برنده دوبار بدهکار نمی‌شود', () => {
  function makeDb() {
    const db: Record<string, any> = {
      player: {
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      },
      auction: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      },
      playerInventory: { upsert: jest.fn().mockResolvedValue({}) },
      financialTransaction: { create: jest.fn().mockResolvedValue({}) },
      shopItem: {
        findUnique: jest.fn().mockResolvedValue({ id: 'item1' }),
        create: jest.fn()
      },
      regionStat: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({})
      }
    }
    db.$transaction = jest.fn(txOf(db))
    return db
  }

  const due = {
    id: 'a1',
    groupId: 'g1',
    isClosed: false,
    weekKey: weekIndex() - 1,
    currentBid: 5_200_000,
    startingBid: 5_000_000,
    highestBidderId: 'p1',
    itemKey: 'golden_statue',
    itemName: 'مجسمهٔ طلایی شهر'
  }

  test('مبلغ حراجی به صندوق منطقه (فروشندهٔ شهر) می‌رسد', async () => {
    const db = makeDb()
    db.auction.findMany.mockResolvedValue([due])
    const service = new AuctionService(db as unknown as PrismaClient, makeEvents() as never)

    const closed = await service.closeDue('g1')

    expect(closed).toBe(1)
    expect(db.playerInventory.upsert).toHaveBeenCalled()
    const credit = db.regionStat.upsert.mock.calls[0][0]
    expect(credit.where.groupId).toBe('g1')
    expect(credit.update.taxRevenue.increment).toBe(5_200_000)
  })

  test('دفتر بازیکن برای یک آیتم دو بار خروج ثبت نمی‌کند', async () => {
    const db = makeDb()
    db.auction.findMany.mockResolvedValue([due])
    const service = new AuctionService(db as unknown as PrismaClient, makeEvents() as never)

    await service.closeDue('g1')

    // ودیه در لحظهٔ پیشنهاد کسر و ثبت شده است؛ تسویه نباید ردیف خروجِ دومی بنویسد
    expect(db.financialTransaction.create).not.toHaveBeenCalled()
  })
})

// ─────────────────────────── P2P Loan default ───────────────────────────

describe('PlayerLoanService — default no longer keeps the money free', () => {
  function makeDb() {
    const db: Record<string, any> = {
      player: {
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        count: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockResolvedValue({})
      },
      playerLoan: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      },
      financialTransaction: { create: jest.fn() },
      notification: undefined
    }
    db.$transaction = jest.fn(txOf(db))
    return db
  }

  const loan = {
    id: 'l1',
    lenderId: 'lend1',
    borrowerId: 'bor1',
    principal: 1_000_000,
    totalRepay: 1_003_333,
    status: 'ACTIVE',
    dueAt: new Date(Date.now() - 3_600_000)
  }

  test('default claws back up to the balance; lender gets its share', async () => {
    const db = makeDb()
    db.playerLoan.findMany.mockResolvedValue([loan])
    // موجودی کافی برای کل قرارداد نیست → نکول
    db.player.count.mockResolvedValue(0)
    // موجودی ۵۰ هزار (کمتر از .۱ میلیون)
    db.player.findUnique.mockResolvedValue({ balance: 500_000 })
    const service = new PlayerLoanService(db as unknown as PrismaClient, makeEvents() as never)

    const res = await service.settleDueLoans('bor1')

    expect(res.defaulted).toBe(1)
    expect(res.repaid).toBe(0)
    // وضعیت نکول ثبت شد
    expect(db.playerLoan.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'l1', status: 'ACTIVE' }, data: { status: 'DEFAULTED' } })
    )
    // کل موجودی وصول شد
    expect(db.player.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'bor1', balance: { gte: 500_000 } }),
        data: { balance: { decrement: 500_000 } }
      })
    )
    // ۵۰۰ هزار کمتر از سهم وام‌دهنده (۱.۰۸ میلیون) است → کل آن به وام‌دهنده
    expect(db.player.update).toHaveBeenCalledWith({
      where: { id: 'lend1' },
      data: { balance: { increment: 500_000 } }
    })
    // دفتر کل: یک ردیف انتقال به وام‌دهنده به همان مبلغ
    expect(db.financialTransaction.create).toHaveBeenCalledTimes(1)
    expect(db.financialTransaction.create.mock.calls[0][0].data).toEqual(
      expect.objectContaining({
        amount: 500_000,
        type: 'P2P_LOAN_REPAY',
        sourcePlayerId: 'bor1',
        destinationPlayerId: 'lend1'
      })
    )
  })

  test('default splits recovered amount: lender share first, rest to system fee', async () => {
    const db = makeDb()
    db.playerLoan.findMany.mockResolvedValue([loan])
    db.player.count.mockResolvedValue(0)
    // موجودی ۱.۲ میلیون > کل قرارداد ۱.۱ میلیون → ولی count گفت ناکافی؟
    // (count بر اساس totalRepay است؛ ۱.۲ > ۱.۱ پس count=1 و مسیر repay می‌رود؛
    //  برای تستِ split، موجودی را بین lenderShare و totalRepay نگه می‌داریم)
    db.player.count.mockResolvedValue(0)
    db.player.findUnique.mockResolvedValue({ balance: 1_100_000 })
    const service = new PlayerLoanService(db as unknown as PrismaClient, makeEvents() as never)

    await service.settleDueLoans('bor1')

    // وصول: سهم وام‌دهنده + کارمزد سیستم (نرخ‌ها روی دورهٔ بازی هم‌تراز شده‌اند)
    expect(db.player.update).toHaveBeenCalledWith({
      where: { id: 'lend1' },
      data: { balance: { increment: 1_002_667 } }
    })
    const rows = db.financialTransaction.create.mock.calls.map((c: any) => c[0].data)
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          amount: 1_002_667,
          destinationPlayerId: 'lend1',
          type: 'P2P_LOAN_REPAY'
        }),
        expect.objectContaining({
          amount: 666,
          sourcePlayerId: 'bor1'
        })
      ])
    )
  })

  test('default with an empty wallet claws back nothing (no negative balance)', async () => {
    const db = makeDb()
    db.playerLoan.findMany.mockResolvedValue([loan])
    db.player.count.mockResolvedValue(0)
    db.player.findUnique.mockResolvedValue({ balance: 0 })
    const service = new PlayerLoanService(db as unknown as PrismaClient, makeEvents() as never)

    const res = await service.settleDueLoans('bor1')

    expect(res.defaulted).toBe(1)
    expect(db.player.updateMany).not.toHaveBeenCalled()
    expect(db.player.update).not.toHaveBeenCalled()
    expect(db.financialTransaction.create).not.toHaveBeenCalled()
  })

  test('a concurrent repayment wins: no default, no clawback', async () => {
    const db = makeDb()
    db.playerLoan.findMany.mockResolvedValue([loan])
    db.player.count.mockResolvedValue(0)
    // قفل شکست — تسویهٔ همزمان برنده شد
    db.playerLoan.updateMany.mockResolvedValue({ count: 0 })
    const service = new PlayerLoanService(db as unknown as PrismaClient, makeEvents() as never)

    const res = await service.settleDueLoans('bor1')

    expect(res.defaulted).toBe(0)
    expect(db.player.findUnique).not.toHaveBeenCalled()
  })

  test('an affordable loan is repaid in full automatically', async () => {
    const db = makeDb()
    db.playerLoan.findMany.mockResolvedValue([loan])
    db.player.count.mockResolvedValue(1)
    db.playerLoan.findUnique.mockResolvedValue(loan)
    db.playerLoan.findUniqueOrThrow.mockResolvedValue(loan)
    const service = new PlayerLoanService(db as unknown as PrismaClient, makeEvents() as never)

    const res = await service.settleDueLoans('bor1')

    expect(res.repaid).toBe(1)
    expect(db.player.update).toHaveBeenCalledWith({
      where: { id: 'lend1' },
      data: { balance: { increment: 1_002_667 } }
    })
  })
})

// ─────────────────────────── Credit penalty ───────────────────────────

describe('CreditService — P2P defaults lower the score', () => {
  function makeCreditDb(defaults: number) {
    return {
      player: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'p1',
          status: 'ACTIVE',
          experience: 0,
          balance: 0
        }),
        count: jest.fn().mockResolvedValue(0)
      },
      bankAccount: { findMany: jest.fn().mockResolvedValue([]) },
      property: { findMany: jest.fn().mockResolvedValue([]) },
      business: { findMany: jest.fn().mockResolvedValue([]) },
      loan: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
      playerLoan: { count: jest.fn().mockResolvedValue(defaults) },
      financialTransaction: { count: jest.fn().mockResolvedValue(0) }
    }
  }

  test('each default subtracts 50 points (capped at 200)', async () => {
    const clean = await new CreditService(makeCreditDb(0) as unknown as PrismaClient).getCreditProfile(1n)
    const oneDefault = await new CreditService(makeCreditDb(1) as unknown as PrismaClient).getCreditProfile(1n)
    const sixDefaults = await new CreditService(makeCreditDb(6) as unknown as PrismaClient).getCreditProfile(1n)

    expect(oneDefault.score).toBe(clean.score - 50)
    expect(sixDefaults.score).toBe(clean.score - 200)
    expect(oneDefault.factors).toEqual(
      expect.arrayContaining([expect.objectContaining({ impact: -50 })])
    )
  })
})

// ─────────────────────────── Quest all-three bonus ───────────────────────────

describe('DailyQuestService — all-three bonus is paid exactly once', () => {
  function makeDb() {
    const db: Record<string, any> = {
      player: { findUnique: jest.fn().mockResolvedValue({ id: 'p1' }), update: jest.fn() },
      dailyQuest: {
        findUnique: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        count: jest.fn(),
        create: jest.fn(),
        createMany: jest.fn(),
        findMany: jest.fn()
      },
      weeklyChest: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn() },
      financialTransaction: { create: jest.fn() }
    }
    db.$transaction = jest.fn(txOf(db))
    return db
  }

  function prime(db: Record<string, any>) {
    db.dailyQuest.findUnique.mockResolvedValue({
      id: 'q3',
      progress: 1,
      target: 1,
      claimedAt: null
    })
    // این سومین کارتِ امروز است
    db.dailyQuest.count.mockResolvedValue(QUEST_REWARDS.cardsPerDay)
  }

  test('the third claim writes the bonus marker and pays the bonus', async () => {
    const db = makeDb()
    prime(db)
    const service = new DailyQuestService(db as unknown as PrismaClient, makeEvents() as never)

    const result = await service.claimCard(1n, 'work_shift')

    expect(result.allThreeBonus).toBe(QUEST_REWARDS.allThree)
    expect(db.dailyQuest.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          playerId: 'p1',
          questKey: 'ALL_THREE_BONUS'
        })
      })
    )
    expect(db.player.update).toHaveBeenCalledWith({
      where: { id: 'p1' },
      data: { balance: { increment: QUEST_REWARDS.card + QUEST_REWARDS.allThree } }
    })
  })

  test('a concurrent marker (P2002) skips the bonus but keeps the card reward', async () => {
    const db = makeDb()
    prime(db)
    // درخواستِ موازی علامت را قبلاً ساخته است
    db.dailyQuest.create.mockRejectedValue(p2002())
    const service = new DailyQuestService(db as unknown as PrismaClient, makeEvents() as never)

    const result = await service.claimCard(1n, 'work_shift')

    expect(result.allThreeBonus).toBe(0)
    expect(db.player.update).toHaveBeenCalledWith({
      where: { id: 'p1' },
      data: { balance: { increment: QUEST_REWARDS.card } }
    })
  })

  test('non-unique errors still roll back the claim', async () => {
    const db = makeDb()
    prime(db)
    db.dailyQuest.create.mockRejectedValue(new Error('db down'))
    const service = new DailyQuestService(db as unknown as PrismaClient, makeEvents() as never)

    await expect(service.claimCard(1n, 'work_shift')).rejects.toThrow('db down')
  })
})

// ─────────────────────────── Clinic insurance ───────────────────────────

describe('ClinicService — insurance extension base is read inside the transaction', () => {
  function makeDb(existingCoversUntil: Date | null) {
    const db: Record<string, any> = {
      player: {
        findUnique: jest.fn().mockResolvedValue({ id: 'p1' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      },
      insurancePolicy: {
        findFirst: jest.fn().mockResolvedValue(
          existingCoversUntil
            ? { coversUntil: existingCoversUntil }
            : null
        ),
        create: jest.fn()
      },
      financialTransaction: { create: jest.fn() }
    }
    db.$transaction = jest.fn(txOf(db))
    return db
  }

  test('with an active policy, the new term extends from the policy end (not now)', async () => {
    const existingEnd = new Date(Date.now() + 3 * 86_400_000)
    const db = makeDb(existingEnd)
    const service = new ClinicService(
      db as unknown as PrismaClient,
      makeEvents() as never,
      { notifyPlayerById: jest.fn() } as never
    )

    const res = await service.buyInsurance(1n)

    expect(res.extended).toBe(true)
    // ۷ روزِ تازه روی انتهای بیمهٔ موجود — نه روی «الان»
    expect(res.coversUntil.getTime()).toBe(existingEnd.getTime() + 7 * 48 * 60 * 1000)
    expect(db.insurancePolicy.create.mock.calls[0][0].data.coversUntil.getTime()).toBe(
      existingEnd.getTime() + 7 * 48 * 60 * 1000
    )
  })

  test('without a policy, the term starts from now', async () => {
    const db = makeDb(null)
    const service = new ClinicService(
      db as unknown as PrismaClient,
      makeEvents() as never,
      { notifyPlayerById: jest.fn() } as never
    )

    const before = Date.now()
    const res = await service.buyInsurance(1n)
    const after = Date.now()

    expect(res.extended).toBe(false)
    expect(res.coversUntil.getTime()).toBeGreaterThanOrEqual(before + 7 * 48 * 60 * 1000)
    expect(res.coversUntil.getTime()).toBeLessThanOrEqual(after + 7 * 48 * 60 * 1000)
  })
})

// ─────────────────────────── Shop seed ───────────────────────────

describe('ShopService — seeding never resets limited stock', () => {
  test('the update branch of upsert has no stock field', async () => {
    const upsert = jest.fn().mockResolvedValue({})
    const db = { shopItem: { upsert } }
    const service = new ShopService(db as unknown as PrismaClient)

    await service.ensureSeeded(true)

    expect(upsert).toHaveBeenCalled()
    const [first] = upsert.mock.calls[0]
    expect(first.update).not.toHaveProperty('stock')
    // در ساختِ اولیه موجودیِ کاتالوگ نوشته می‌شود
    expect(first.create).toHaveProperty('stock')
  })
})

// ─────────────────────────── Region refresh ───────────────────────────

describe('RegionService — refresh never overwrites the region fund', () => {
  test('the update payload has no taxRevenue; the create payload keeps it', async () => {
    const upsert = jest.fn().mockResolvedValue({})
    const db: Record<string, any> = {
      regionStat: {
        findUnique: jest.fn().mockResolvedValue({ economicIndex: 50, taxRevenue: 7_777_000 }),
        upsert
      },
      playerGroup: { findMany: jest.fn().mockResolvedValue([]) }
    }
    const service = new RegionService(db as unknown as PrismaClient, makeEvents() as never)

    await service.refresh('g1')

    expect(upsert).toHaveBeenCalled()
    const [arg] = upsert.mock.calls[0]
    expect(arg.update).not.toHaveProperty('taxRevenue')
    expect(arg.create).toHaveProperty('taxRevenue', 7_777_000)
  })
})

// ─────────────────────────── Elections ───────────────────────────

describe('ElectionsService — one OPEN election per group (P2002 path)', () => {
  test('a concurrent creation falls back to the existing open election', async () => {
    const findFirst = jest
      .fn()
      .mockResolvedValueOnce(null) // خواندنِ اولیه: انتخاباتی نیست
      .mockResolvedValue({ id: 'winner-election' }) // بعد از P2002: همانِ موجود
    const db: Record<string, any> = {
      election: {
        findFirst,
        create: jest.fn().mockRejectedValue(p2002())
      }
    }
    const service = new ElectionsService(db as unknown as PrismaClient, makeEvents() as never)
    const anyService = service as unknown as {
      getOrCreateOpenElection: (groupId: string) => Promise<{ id: string }>
    }

    const election = await anyService.getOrCreateOpenElection('g1')

    expect(election.id).toBe('winner-election')
  })

  test('a real failure still propagates', async () => {
    const db: Record<string, any> = {
      election: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockRejectedValue(new Error('db down'))
      }
    }
    const service = new ElectionsService(db as unknown as PrismaClient, makeEvents() as never)
    const anyService = service as unknown as {
      getOrCreateOpenElection: (groupId: string) => Promise<{ id: string }>
    }

    await expect(anyService.getOrCreateOpenElection('g1')).rejects.toThrow('db down')
  })
})

// ─────────────────────────── Panel parse-error fallback ───────────────────────────

function parseError(): GrammyError {
  return new GrammyError(
    "Bad Request: can't parse entities: Sequence must not be empty",
    { ok: false, error_code: 400, description: "Bad Request: can't parse entities" },
    'editMessageText',
    {}
  )
}

describe('panel — Markdown parse errors never swallow the panel', () => {
  test('editPanel retries in plain text when the parser rejects the message', async () => {
    const editMessageText = jest
      .fn()
      .mockRejectedValueOnce(parseError())
      .mockResolvedValueOnce({})
    const reply = jest.fn()
    const ctx = {
      editMessageText,
      reply,
      callbackQuery: { message: { chat: { type: 'private' }, reply_to_message: undefined } }
    } as never

    await editPanel(ctx as never, { text: 'نام: علی *ستاره', keyboard: undefined })

    // ویرایش دوم بدون parse_mode — پنل همان‌جا به‌روز می‌شود، پیام تازه نمی‌سازد
    expect(editMessageText).toHaveBeenCalledTimes(2)
    expect(editMessageText.mock.calls[1][1].parse_mode).toBeUndefined()
    expect(reply).not.toHaveBeenCalled()
  })

  test('when even the plain edit fails, the fallback reply goes out plain', async () => {
    const editMessageText = jest
      .fn()
      .mockRejectedValueOnce(parseError())
      .mockRejectedValueOnce(
        new GrammyError(
          'message to edit not found',
          { ok: false, error_code: 400, description: 'Bad Request: message to edit not found' },
          'editMessageText',
          {}
        )
      )
    // reply هم parse را رد می‌کند؛ پس آخرین دفاع (reply بی‌parse) باید بماند
    const reply = jest
      .fn()
      .mockRejectedValueOnce(parseError())
      .mockResolvedValueOnce({})
    const ctx = {
      editMessageText,
      reply,
      callbackQuery: {
        message: {
          chat: { type: 'group' },
          reply_to_message: { message_id: 42 }
        }
      }
    } as never

    await editPanel(ctx as never, { text: 'x * y', keyboard: undefined })

    // ویرایشِ ساده شکست خورد → fallback به reply
    expect(reply).toHaveBeenCalled()
    // و چون خطای اصلی parse بود، fallback بدون parse_mode می‌رود
    expect(reply.mock.calls[0][1].parse_mode).toBeUndefined()
    // دفاع آخر: reply بی‌قالب‌بندی، ولی **با** کیبورد و سندِ مالکیت؛
    // پنلِ بی‌دکمه یا بی‌ریپلای در گروه یعنی پنلی که مالکش هم نمی‌تواند ببندد.
    expect(reply).toHaveBeenCalledTimes(2)
    expect(reply.mock.calls[1][1].parse_mode).toBeUndefined()
    expect(reply.mock.calls[1][1].reply_parameters).toEqual({
      message_id: 42,
      allow_sending_without_reply: true
    })
  })

  test('sendPanel keeps working and falls back to plain on parse errors', async () => {
    const reply = jest.fn().mockResolvedValue({})
    const ctx = {
      reply,
      message: { message_id: 7 },
      chat: { type: 'private' },
      callbackQuery: undefined
    } as never

    await sendPanel(ctx as never, { text: 'متن *نامعتبر', keyboard: undefined })

    expect(reply).toHaveBeenCalledTimes(1)
    expect(reply.mock.calls[0][1].parse_mode).toBe('Markdown')
  })

  test('sendPanel parse error retries plain without reply', async () => {
    const reply = jest
      .fn()
      .mockRejectedValueOnce(parseError())
      .mockResolvedValueOnce({})
    const ctx = {
      reply,
      message: { message_id: 7 },
      chat: { type: 'private' },
      callbackQuery: undefined
    } as never

    await sendPanel(ctx as never, { text: 'متن *نامعتبر', keyboard: undefined })

    expect(reply).toHaveBeenCalledTimes(2)
    expect(reply.mock.calls[1][1].parse_mode).toBeUndefined()
  })
})

// ─────────────────────────── panel-owner middleware ───────────────────────────

describe('panelOwnerMiddleware — adm: buttons with a missing actor', () => {
  function makeCtx(from: unknown, data: string) {
    const ctx: Record<string, any> = {
      callbackQuery: {
        data,
        // پنل گروهیِ بازیکنِ خودش؛ ownsPanel باید عبور کند
        message: {
          chat: { type: 'group', id: 1 },
          reply_to_message: { message_id: 7, from: { id: 5 } }
        }
      },
      from,
      answerCallbackQuery: jest.fn().mockResolvedValue({})
    }
    return ctx
  }

  const container = {
    adminService: { isAdmin: jest.fn().mockResolvedValue(true) }
  } as unknown as Parameters<typeof panelOwnerMiddleware>[0]
  const middleware = panelOwnerMiddleware(container)

  test('missing ctx.from on an adm: button is acked, not a TypeError', async () => {
    const ctx = makeCtx(undefined, 'adm:home')
    const next = jest.fn()

    await expect(middleware(ctx as never, next as never)).resolves.toBeUndefined()

    expect(ctx.answerCallbackQuery).toHaveBeenCalled()
    expect(next).not.toHaveBeenCalled()
  })

  test('non-admin actor on adm: is silently acked', async () => {
    ;(container.adminService.isAdmin as jest.Mock).mockResolvedValue(false)
    const ctx = makeCtx({ id: 5 }, 'adm:home')
    const next = jest.fn()

    await middleware(ctx as never, next as never)

    expect(ctx.answerCallbackQuery).toHaveBeenCalled()
    expect(next).not.toHaveBeenCalled()
  })

  test('admin actor on adm: passes through', async () => {
    ;(container.adminService.isAdmin as jest.Mock).mockResolvedValue(true)
    const ctx = makeCtx({ id: 5 }, 'adm:home')
    const next = jest.fn().mockResolvedValue(undefined)

    await middleware(ctx as never, next as never)

    expect(next).toHaveBeenCalled()
    expect(ctx.answerCallbackQuery).not.toHaveBeenCalled()
  })

  test('a normal panel callback without adm: prefix needs no admin lookup', async () => {
    ;(container.adminService.isAdmin as jest.Mock).mockReset()
    const ctx: Record<string, any> = {
      callbackQuery: {
        data: 'id:main',
        message: { chat: { type: 'private', id: 5 }, reply_to_message: undefined }
      },
      from: { id: 5 }
    }
    const next = jest.fn().mockResolvedValue(undefined)

    await middleware(ctx as never, next as never)

    expect(container.adminService.isAdmin).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalled()
  })
})

// ─────────────────────────── misc invariants ───────────────────────────

describe('misc — service invariants', () => {
  test('a closed auction rejects new bids', async () => {
    const db: Record<string, any> = {
      player: { findUnique: jest.fn().mockResolvedValue({ id: 'p1' }) },
      auction: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'a1',
          isClosed: true,
          weekKey: weekIndex(),
          currentBid: 5_000_000,
          startingBid: 5_000_000,
          highestBidderId: null,
          itemName: 'x'
        })
      },
      $transaction: jest.fn()
    }
    const service = new AuctionService(db as unknown as PrismaClient, makeEvents() as never)

    await expect(service.placeBid(1n, 'a1', 6_000_000)).rejects.toThrow(ConflictError)
  })

  test('an unregistered viewer never throws from getView', async () => {
    const db: Record<string, any> = {
      player: { findUnique: jest.fn().mockResolvedValue(null) },
      auction: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue({ id: 'a1' }),
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          id: 'a1',
          itemName: 'x',
          itemKey: 'golden_statue',
          startingBid: 5_000_000,
          currentBid: 5_000_000,
          highestBidderId: 'p1',
          isClosed: false,
          _count: { bids: 0 }
        })
      }
    }
    const service = new AuctionService(db as unknown as PrismaClient, makeEvents() as never)

    const view = await service.getView('g1', 999n)

    expect(view.amILeader).toBe(false)
  })
})

// NotFoundError import sanity (used above via rejects types)
void NotFoundError
