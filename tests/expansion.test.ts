/* eslint-disable @typescript-eslint/no-explicit-any */
import { PrismaClient } from '@prisma/client'
import { RewardsService } from '../src/modules/rewards/rewards.service'
import { OvertimeService } from '../src/modules/occupation/overtime.service'
import { PART_TIME_JOBS } from '../src/modules/occupation/work-blueprints'
import { MIN_HEALTH, MIN_WORK_HEALTH } from '../src/modules/life/life-core'
import { ConflictError } from '../src/utils/classes/errors'
import { ProjectsService } from '../src/modules/city/projects.service'
import { LotteryService } from '../src/modules/city/lottery.service'
import { TradeService } from '../src/modules/market/trade.service'

function makeEvents() {
  return {
    recordPlayerEvent: jest.fn().mockResolvedValue(undefined),
    recordRegionEvent: jest.fn().mockResolvedValue(undefined)
  }
}

// ---------- Streak ----------
describe('RewardsService — streak', () => {
  function makeDb(player: Record<string, unknown> | null) {
    return {
      player: {
        findUnique: jest.fn().mockResolvedValue(player),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockResolvedValue({})
      },
      financialTransaction: { create: jest.fn() },
      referral: { findUnique: jest.fn().mockResolvedValue(null), updateMany: jest.fn() },
      $transaction: jest.fn()
    }
  }

  const BASE = {
    id: 'p1',
    firstName: 'علی',
    lastName: null,
    balance: 0,
    streakCount: 0,
    lastStreakAt: null,
    referralCode: null
  }

  test('first day gives base reward with streak=1', async () => {
    const db = makeDb({ ...BASE })
    db.$transaction.mockImplementation(async (fn: any) => fn(db))
    const service = new RewardsService(db as unknown as PrismaClient, makeEvents() as any)

    const result = await service.claimDailyStreak(1n)
    expect(result.streak).toBe(1)
    expect(result.reward).toBeGreaterThan(0)
    // کسر/افزایش موجودی در همان updateMany انجام شد (اتمیک)
    expect(db.player.updateMany).toHaveBeenCalledTimes(1)
  })

  test('the streak feed event is recorded after the payment commits', async () => {
    const order: string[] = []
    const db = makeDb({ ...BASE })
    db.$transaction = jest.fn(async (fn: any) => {
      const paid = await fn(db)
      order.push('payment committed')
      return paid
    })
    const events = {
      recordPlayerEvent: jest.fn(async (_input: Record<string, unknown>) => {
        order.push('feed event')
      })
    }
    const service = new RewardsService(db as unknown as PrismaClient, events as any)

    const result = await service.claimDailyStreak(1n)

    // چرا ترتیب مهم است؟ خبرِ خوراک با کانکسیونی جدا از تراکنش نوشته می‌شود؛
    // اگر وسطِ تراکنش باشد، هم وسطِ کار کانکسیون دومی اشغال می‌کند و هم اگر
    // تراکنش برگشت، ردیفِ خبریِ بازمانده چیزی را روایت می‌کند که هرگز رخ نداده.
    expect(order).toEqual(['payment committed', 'feed event'])
    expect((events as { recordPlayerEvent: jest.Mock }).recordPlayerEvent.mock.calls[0][0]).toEqual(
      expect.objectContaining({ playerId: 'p1', amount: result.reward })
    )
  })

  test('claiming twice on same day throws ConflictError', async () => {
    const db = makeDb({
      ...BASE,
      streakCount: 3,
      lastStreakAt: new Date(Date.now() - 5 * 60 * 60 * 1000)
    })
    db.$transaction.mockImplementation(async (fn: any) => fn(db))
    const service = new RewardsService(db as unknown as PrismaClient, makeEvents() as any)

    // اگر امروز گرفته باشد باید خطا بدهد
    db.player.findUnique.mockResolvedValue({
      ...BASE,
      streakCount: 3,
      lastStreakAt: new Date()
    })

    await expect(service.claimDailyStreak(1n)).rejects.toThrow()
  })

  test('concurrent claim returns conflict via optimistic lock', async () => {
    const db = makeDb({ ...BASE })
    db.player.updateMany.mockResolvedValue({ count: 0 }) // قفل شکست خورد
    db.$transaction.mockImplementation(async (fn: any) => fn(db))
    const service = new RewardsService(db as unknown as PrismaClient, makeEvents() as any)

    await expect(service.claimDailyStreak(1n)).rejects.toThrow()
  })

  test('referral code generation is idempotent', async () => {
    const db = makeDb({ ...BASE, referralCode: 'ABC23456' })
    const service = new RewardsService(db as unknown as PrismaClient, makeEvents() as any)

    const code = await service.getReferralCode(1n)
    expect(code).toBe('ABC23456')
    expect(db.player.update).not.toHaveBeenCalled()
  })
})

// ---------- Overtime ----------
describe('OvertimeService', () => {
  function makeOvertimeDb(player: Record<string, unknown>, session?: Record<string, unknown>) {
    const tx = {
      player: {
        findUnique: jest.fn().mockResolvedValue(player),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockResolvedValue({})
      },
      workSession: { findFirst: jest.fn().mockResolvedValue(session ?? null) },
      financialTransaction: { create: jest.fn() },
      gameEvent: { create: jest.fn() }
    }
    const db = {
      $transaction: jest.fn(async (fn: any) => fn(tx)),
      player: { findUnique: jest.fn().mockResolvedValue(player) }
    }
    return { db, tx }
  }

  const WORKING = {
    id: 'p1',
    balance: 100_000,
    health: 80,
    fatigue: 30,
    experience: 50,
    currentDegree: 'DIPLOMA',
    activityState: 'WORKING',
    lastOvertimeAt: null
  }
  const SESSION = {
    id: 's1',
    playerId: 'p1',
    jobKey: 'construction',
    status: 'ACTIVE',
    jobTitle: 'کارگر ساختمان',
    payPerMinute: 5000
  }

  test('pays overtime at 1.5x the standard part-time formula when all conditions met', async () => {
    // توان بدنیِ کامل تا «ضریب کار» خنثی بماند و فقط فرمولِ پایه سنجیده شود
    const { db } = makeOvertimeDb({ ...WORKING, health: 100, fatigue: 0, experience: 0 }, SESSION)
    const events = makeEvents()
    const service = new OvertimeService(db as unknown as PrismaClient, events as any)

    const result = await service.startOvertime(42n)

    expect(result.skipped).toBeUndefined()
    expect(result.fatigueAdded).toBeGreaterThan(0)
    expect(result.healthLost).toBeGreaterThan(0)
    expect(result.conditionFactor).toBe(1)
    // فرمول استاندارد پاره‌وقت از هستهٔ زندگی: پایه ۵٬۰۰۰ × سختی ۳ (۱٫۳)
    // × ضریب کار (۱) = ۶٬۵۰۰ در دقیقه × ۱۰ دقیقه = ۶۵٬۰۰۰؛ اضافه‌کاری ×۱٫۵
    expect(result.grossEarned).toBe(97_650)
    // مالیات بر درآمد ۵٪ در مبدأ کسر می‌شود و بازیکن خالص را می‌گیرد
    expect(result.tax).toBe(4_883)
    expect(result.earned).toBe(92_767)
  })

  test('the overtime feed event waits for the payment transaction', async () => {
    const order: string[] = []
    const { db, tx } = makeOvertimeDb({ ...WORKING, health: 100, fatigue: 0 }, SESSION)
    db.$transaction = jest.fn(async (fn: any) => {
      const paid = await fn(tx)
      order.push('payment committed')
      return paid
    })
    const events = {
      recordPlayerEvent: jest.fn(async (_input: Record<string, unknown>) => {
        order.push('feed event')
      }),
      recordRegionEvent: jest.fn()
    }
    const service = new OvertimeService(db as unknown as PrismaClient, events as any)

    const result = await service.startOvertime(42n)
    await new Promise((resolve) => setImmediate(resolve))

    expect(result.skipped).toBeUndefined()
    expect(order).toEqual(['payment committed', 'feed event'])
    // مبلغِ خبر همان ناخالصِ پرداخت‌شده است، نه خالصِ پس از مالیات
    expect((events as { recordPlayerEvent: jest.Mock }).recordPlayerEvent.mock.calls[0][0]).toEqual(
      expect.objectContaining({ playerId: 'p1', amount: result.grossEarned })
    )
  })

  test('a skipped overtime records no feed event at all', async () => {
    const { db, tx } = makeOvertimeDb({ ...WORKING }, SESSION)
    // قفلِ lastOvertimeAt را درخواستِ دیگری برده است
    tx.player.updateMany.mockResolvedValue({ count: 0 })
    const events = makeEvents()
    const service = new OvertimeService(db as unknown as PrismaClient, events as any)

    const result = await service.startOvertime(42n)
    await new Promise((resolve) => setImmediate(resolve))

    expect(result.skipped).toBe(true)
    expect(result.earned).toBe(0)
    expect(events.recordPlayerEvent).not.toHaveBeenCalled()
  })

  test('a tired or unhealthy player earns less overtime — condition is no longer ignored', async () => {
    // رگرسیون واقعی: پیش‌تر سلامت و خستگی به محاسبهٔ اضافه‌کاری پاس داده
    // نمی‌شدند و بازیکنِ خسته/بیمار دقیقاً اندازهٔ بازیکنِ سرحال دستمزد می‌گرفت.
    const fresh = makeOvertimeDb({ ...WORKING, health: 100, fatigue: 0, experience: 0 }, SESSION)
    const worn = makeOvertimeDb({ ...WORKING, health: 40, fatigue: 90, experience: 0 }, SESSION)

    const freshResult = await new OvertimeService(
      fresh.db as unknown as PrismaClient,
      makeEvents() as any
    ).startOvertime(42n)
    const wornResult = await new OvertimeService(
      worn.db as unknown as PrismaClient,
      makeEvents() as any
    ).startOvertime(42n)

    expect(wornResult.conditionFactor!).toBeLessThan(1)
    expect(wornResult.grossEarned!).toBeLessThan(freshResult.grossEarned!)
    // کف ۰٫۵ رعایت می‌شود: کار حتی در بدترین حالت هم بی‌معنا نمی‌شود
    expect(wornResult.grossEarned!).toBeGreaterThanOrEqual(
      Math.round(freshResult.grossEarned! * 0.49)
    )
    // و هر دو پرداخت، مالیات در مبدأ خورده‌اند
    expect(wornResult.tax).toBeGreaterThan(0)
    expect(freshResult.earned).toBe((freshResult.grossEarned ?? 0) - (freshResult.tax ?? 0))
  })

  test('refuses overtime when the body is not up to it', async () => {
    const exhausted = makeOvertimeDb({ ...WORKING, fatigue: 100 }, SESSION)
    await expect(
      new OvertimeService(
        exhausted.db as unknown as PrismaClient,
        makeEvents() as any
      ).startOvertime(1n)
    ).rejects.toThrow(ConflictError)

    const critical = makeOvertimeDb({ ...WORKING, health: 10 }, SESSION)
    await expect(
      new OvertimeService(
        critical.db as unknown as PrismaClient,
        makeEvents() as any
      ).startOvertime(1n)
    ).rejects.toThrow(ConflictError)
  })

  test('overtime never drives health to zero in any job', async () => {
    // پیش‌تر `healthLost = min(health, …)` بود و اضافه‌کاری می‌توانست سلامت را
    // به صفر برساند؛ پنل آن را «فوت‌شده» می‌گفت در حالی که بازیکن زنده بود.
    for (const job of PART_TIME_JOBS) {
      const { db, tx } = makeOvertimeDb(
        { ...WORKING, health: MIN_WORK_HEALTH, fatigue: 0, experience: 0 },
        { ...SESSION, jobKey: job.key, payPerMinute: job.basePayPerMinute }
      )
      const service = new OvertimeService(db as unknown as PrismaClient, makeEvents() as any)

      const result = await service.startOvertime(42n)

      expect(MIN_WORK_HEALTH - result.healthLost).toBeGreaterThanOrEqual(MIN_HEALTH)
      expect(tx.player.update).toHaveBeenCalledTimes(1)
    }
  })

  test('rejects overtime when not working', async () => {
    const { db } = makeOvertimeDb({ ...WORKING, activityState: 'IDLE' })
    const service = new OvertimeService(db as unknown as PrismaClient, makeEvents() as any)

    await expect(service.startOvertime(1n)).rejects.toThrow()
  })

  test('rejects overtime during cooldown', async () => {
    const player = { ...WORKING, lastOvertimeAt: new Date(Date.now() - 10 * 60000) }
    const { db } = makeOvertimeDb(player, SESSION)
    const service = new OvertimeService(db as unknown as PrismaClient, makeEvents() as any)

    await expect(service.startOvertime(1n)).rejects.toThrow()
  })

  test('skips when optimistic lock fails (concurrent)', async () => {
    const { db, tx } = makeOvertimeDb(WORKING, SESSION)
    tx.player.updateMany.mockResolvedValue({ count: 0 })
    const service = new OvertimeService(db as unknown as PrismaClient, makeEvents() as any)

    const result = await service.startOvertime(42n)
    expect(result.skipped).toBe(true)
    expect(tx.financialTransaction.create).not.toHaveBeenCalled()
  })
})

// ---------- Projects ----------
describe('ProjectsService', () => {
  function makeProjectsDb(overrides: Record<string, unknown> = {}) {
    const db = {
      player: {
        findUnique: jest.fn().mockResolvedValue({ id: 'p1', status: 'ACTIVE' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn()
      },
      regionProject: {
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      },
      // رکورد هر مشارکت در همان تراکنش نوشته می‌شود؛ بدونش پول از کیف
      // بازیکن کم می‌شد ولی سابقه‌ای برای ممیزی نمی‌ماند.
      projectDonation: {
        create: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        aggregate: jest.fn().mockResolvedValue({ _sum: { amount: 0 } }),
        groupBy: jest.fn().mockResolvedValue([])
      },
      financialTransaction: { create: jest.fn() },
      ...overrides,
      $transaction:
        undefined as unknown as (fn: (t: unknown) => Promise<unknown>) => Promise<unknown>
    }
    // تراکنش ساختگی: donate حالا کسر/صندوق/دفتر را در یک $transaction نگه
    // می‌دارد؛ callback همان اشیای db را می‌گیرد تا فراخوانی‌ها ردیابی شوند.
    db.$transaction = jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(db as unknown))
    return db
  }

  test('donate debits balance conditionally', async () => {
    const project = {
      id: 'pr1',
      groupId: 'g1',
      key: 'park',
      title: 'پارک',
      targetAmount: 50_000_000,
      collectedAmount: 10_000_000,
      isCompleted: false
    }
    const db = makeProjectsDb({
      regionProject: {
        findUnique: jest.fn().mockResolvedValue(project),
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      }
    })
    const service = new ProjectsService(db as unknown as PrismaClient, makeEvents() as any)

    await service.donate(1n, 'g1', 'park', 500_000)
    expect(db.player.updateMany.mock.calls[0][0].where.balance.gte).toBe(500_000)
  })

  test('rejects donation exceeding balance', async () => {
    const project = {
      id: 'pr1',
      groupId: 'g1',
      key: 'park',
      targetAmount: 50_000_000,
      collectedAmount: 0,
      isCompleted: false
    }
    const db = makeProjectsDb({
      regionProject: { findUnique: jest.fn().mockResolvedValue(project) },
      player: {
        findUnique: jest.fn().mockResolvedValue({ id: 'p1' }),
        updateMany: jest.fn().mockResolvedValue({ count: 0 })
      }
    })
    const service = new ProjectsService(db as unknown as PrismaClient, makeEvents() as any)

    await expect(service.donate(1n, 'g1', 'park', 500_000)).rejects.toThrow()
  })

  test('marks project complete when target reached', async () => {
    const project = {
      id: 'pr1',
      groupId: 'g1',
      key: 'park',
      title: 'پارک',
      description: '',
      targetAmount: 50_000_000,
      collectedAmount: 49_800_000,
      isCompleted: false
    }
    const events = makeEvents()
    const db = makeProjectsDb({
      regionProject: {
        findUnique: jest.fn().mockResolvedValue(project),
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      }
    })
    const service = new ProjectsService(db as unknown as PrismaClient, events as any)

    const res = await service.donate(1n, 'g1', 'park', 500_000)
    expect(res.completedNow).toBe(true)
    // رخداد خبری با اولویت بالا ثبت شد
    expect(events.recordRegionEvent).toHaveBeenCalledWith(
      expect.objectContaining({ priority: 4, type: 'PROJECT_COMPLETED' })
    )
  })

  test('rolls back concurrent donation when state changed', async () => {
    const project = {
      id: 'pr1',
      groupId: 'g1',
      key: 'park',
      targetAmount: 50_000_000,
      collectedAmount: 10_000_000,
      isCompleted: false
    }
    const db = makeProjectsDb({
      regionProject: {
        findUnique: jest.fn().mockResolvedValue(project),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }) // قفل شکست خورد
      },
      player: {
        findUnique: jest.fn().mockResolvedValue({ id: 'p1' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockResolvedValue({})
      }
    })
    const service = new ProjectsService(db as unknown as PrismaClient, makeEvents() as any)

    // قفل شکست خورد → ConflictError و rollback خودکارِ تراکنش پول را
    // برمی‌گرداند؛ جبران دستی (player.update بیرون از تراکنش) دیگر نباید
    // باشد، چون دقیقاً همان جبران دستی بود که در خطای میانه پول می‌سوخت.
    await expect(service.donate(1n, 'g1', 'park', 500_000)).rejects.toThrow(ConflictError)
    expect(db.player.update).not.toHaveBeenCalled()
  })
})

// ---------- Lottery ----------
describe('LotteryService', () => {
  function makeLotteryDb(overrides: Record<string, unknown> = {}) {
    return {
      player: {
        findUnique: jest.fn().mockResolvedValue({ id: 'p1', balance: 10_000_000 }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn(),
        findUniqueOrThrow: jest.fn().mockResolvedValue({ firstName: 'برنده', lastName: null })
      },
      lotteryTicket: {
        create: jest.fn(),
        count: jest.fn().mockResolvedValue(3),
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([{ playerId: 'p1' }, { playerId: 'p2' }])
      },
      group: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'g1',
          lotteryLastWeek: null,
          lotteryLastWinnerId: null,
          lotteryLastPrize: null
        }),
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          lotteryLastWeek: null,
          lotteryLastWinnerId: null,
          lotteryLastPrize: null
        }),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      },
      financialTransaction: { create: jest.fn() },
      $transaction: jest.fn(),
      ...overrides
    }
  }

  test('buy ticket debits exact price', async () => {
    const innerTx = {
      player: {
        findUnique: jest.fn().mockResolvedValue({ id: 'p1', balance: 500_000 }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      },
      lotteryTicket: { create: jest.fn(), count: jest.fn().mockResolvedValue(3) },
      financialTransaction: { create: jest.fn() },
      regionStat: { upsert: jest.fn().mockResolvedValue({}) }
    }
    const db = makeLotteryDb()
    db.$transaction.mockImplementation(async (fn: any) => fn(innerTx))
    const service = new LotteryService(db as unknown as PrismaClient, makeEvents() as any)

    const result = await service.buyTicket(1n, 'g1')
    expect(innerTx.player.updateMany.mock.calls[0][0].data.balance.decrement).toBe(6_667)
    expect(result.participants).toBe(3)
    // پول بلیت به صندوق منطقه می‌رود تا جایزه از همان پرداخت شود
    expect(innerTx.regionStat.upsert.mock.calls[0][0].update.taxRevenue.increment).toBe(6_667)
  })

  test('the weekly prize is paid out of the region fund, never minted', async () => {
    const tx = {
      group: { updateMany: jest.fn().mockResolvedValue({ count: 1 }), update: jest.fn() },
      player: {
        update: jest.fn(),
        findUniqueOrThrow: jest.fn().mockResolvedValue({ firstName: 'برنده', lastName: null })
      },
      regionStat: {
        findUnique: jest.fn().mockResolvedValue({ taxRevenue: 1_000_000 }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      },
      financialTransaction: { create: jest.fn() }
    }
    const db = makeLotteryDb()
    db.$transaction.mockImplementation(async (fn: any) => fn(tx))
    const service = new LotteryService(db as unknown as PrismaClient, makeEvents() as any)

    const settled = await (service as any).settleLastWeek('g1')

    // دو بلیت × ۲۰۰٬۰۰۰ = ۴۰۰٬۰۰۰ صندوق؛ جایزه ۷۰٪ = ۲۸۰٬۰۰۰
    expect(settled.prize).toBe(9_333)
    expect(tx.regionStat.updateMany.mock.calls[0][0].data.taxRevenue.decrement).toBe(9_333)
    expect(tx.player.update.mock.calls[0][0].data.balance.increment).toBe(9_333)
  })

  test('an empty region fund leaves the week unsettled instead of minting a prize', async () => {
    const tx = {
      group: { updateMany: jest.fn().mockResolvedValue({ count: 1 }), update: jest.fn() },
      player: { update: jest.fn(), findUniqueOrThrow: jest.fn() },
      regionStat: {
        findUnique: jest.fn().mockResolvedValue({ taxRevenue: 0 }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      },
      financialTransaction: { create: jest.fn() }
    }
    const db = makeLotteryDb()
    db.$transaction.mockImplementation(async (fn: any) => fn(tx))
    const service = new LotteryService(db as unknown as PrismaClient, makeEvents() as any)

    const settled = await (service as any).settleLastWeek('g1')

    expect(settled).toBeNull()
    expect(tx.player.update).not.toHaveBeenCalled()
    expect(tx.financialTransaction.create).not.toHaveBeenCalled()
  })

  test('rejects duplicate ticket in same week', async () => {
    const db = makeLotteryDb()
    db.$transaction.mockImplementation(async (fn: any) => {
      const tx = {
        player: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        lotteryTicket: { create: jest.fn().mockRejectedValue(new Error('unique')) },
        financialTransaction: { create: jest.fn() },
        lotteryTicket_count: jest.fn().mockResolvedValue(1)
      }
      return fn(tx)
    })
    const service = new LotteryService(db as unknown as PrismaClient, makeEvents() as any)

    await expect(service.buyTicket(1n, 'g1')).rejects.toThrow()
  })
})

// ---------- Trade ----------
describe('TradeService', () => {
  function makeTradeDb(listing: Record<string, unknown> | null) {
    const tx = {
      player: {
        findUnique: jest.fn().mockResolvedValue({ id: 'buyer-1', balance: 10_000_000 }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockResolvedValue({}),
        findUniqueOrThrow: jest.fn().mockResolvedValue({ firstName: 'فروشنده', lastName: null })
      },
      marketListing: {
        findUnique: jest.fn().mockResolvedValue(listing),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      },
      playerInventory: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        deleteMany: jest.fn()
      },
      financialTransaction: { create: jest.fn() }
    }
    const db = {
      $transaction: jest.fn(async (fn: any) => fn(tx)),
      marketListing: {
        findUnique: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn()
      },
      playerInventory: {
        findUnique: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn()
      },
      player: { findUnique: jest.fn().mockResolvedValue({ id: 'seller-1' }) }
    }
    return { db, tx }
  }

  test('an expired listing releases the escrowed item back to the seller', async () => {
    const expired = {
      id: 'l-expired',
      sellerPlayerId: 'seller-1',
      itemId: 'i1',
      itemName: 'آب',
      quantity: 3,
      unitPrice: 15_000,
      status: 'ACTIVE',
      expiresAt: new Date(Date.now() - 60_000)
    }
    const tx = {
      marketListing: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn().mockResolvedValue(expired)
      },
      playerInventory: { upsert: jest.fn().mockResolvedValue({}) }
    }
    const db = {
      marketListing: { findMany: jest.fn().mockResolvedValue([{ id: 'l-expired' }]) },
      $transaction: jest.fn(async (fn: any) => fn(tx)),
      player: { findUnique: jest.fn() }
    }
    const service = new TradeService(db as unknown as PrismaClient, makeEvents() as any)

    const swept = await service.sweepExpired()

    expect(swept).toBe(1)
    // کالا دقیقاً یک‌بار و به انبار فروشنده برمی‌گردد
    expect(tx.playerInventory.upsert).toHaveBeenCalledTimes(1)
    const upsertArgs = tx.playerInventory.upsert.mock.calls[0][0]
    expect(upsertArgs.create.playerId).toBe('seller-1')
    expect(upsertArgs.create.quantity).toBe(3)
    // وضعیت آگهی منقضی می‌شود و شرط ادعا روی زمان انقضا قفل است
    const claim = tx.marketListing.updateMany.mock.calls[0][0]
    expect(claim.data.status).toBe('EXPIRED')
    expect(claim.where.expiresAt.lt).toBeInstanceOf(Date)
  })

  test('a losing sweep race never duplicates the returned goods', async () => {
    const tx = {
      marketListing: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        findUniqueOrThrow: jest.fn()
      },
      playerInventory: { upsert: jest.fn() }
    }
    const db = {
      marketListing: { findMany: jest.fn().mockResolvedValue([{ id: 'l-expired' }]) },
      $transaction: jest.fn(async (fn: any) => fn(tx)),
      player: { findUnique: jest.fn() }
    }
    const service = new TradeService(db as unknown as PrismaClient, makeEvents() as any)

    const swept = await service.sweepExpired()

    expect(swept).toBe(0)
    expect(tx.playerInventory.upsert).not.toHaveBeenCalled()
  })

  const ACTIVE_LISTING = {
    id: 'l1',
    sellerPlayerId: 'seller-1',
    itemId: 'i1',
    itemName: 'آب',
    quantity: 2,
    unitPrice: 15_000,
    status: 'ACTIVE',
    expiresAt: new Date(Date.now() + 48 * 3600 * 1000)
  }

  test('escrow purchase transfers item and money atomically', async () => {
    const listing = {
      ...ACTIVE_LISTING,
      sellerPlayerId: 'seller-other'
    }
    const { db, tx } = makeTradeDb(listing)
    tx.playerInventory.updateMany.mockResolvedValueOnce({ count: 1 }) // buyer debit ok
    tx.marketListing.findUnique.mockResolvedValue(listing)
    tx.playerInventory.updateMany.mockResolvedValueOnce({ count: 1 }) // seller stock ok

    const service = new TradeService(db as unknown as PrismaClient, makeEvents() as any)
    const result = await service.buyListing(1n, 'l1')

    expect(result.totalPrice).toBe(30_000)
    expect(tx.financialTransaction.create).toHaveBeenCalledTimes(1)
  })

  test('the sold-item feed event waits for the trade transaction', async () => {
    const order: string[] = []
    const listing = { ...ACTIVE_LISTING, sellerPlayerId: 'seller-other' }
    const { db, tx } = makeTradeDb(listing)
    db.$transaction = jest.fn(async (fn: any) => {
      const sold = await fn(tx)
      order.push('trade committed')
      return sold
    })
    const events = {
      recordPlayerEvent: jest.fn(async (_input: Record<string, unknown>) => {
        order.push('feed event')
      }),
      recordRegionEvent: jest.fn()
    }
    const service = new TradeService(db as unknown as PrismaClient, events as any)

    const result = await service.buyListing(1n, 'l1')
    await new Promise((resolve) => setImmediate(resolve))

    expect(order).toEqual(['trade committed', 'feed event'])
    expect((events as { recordPlayerEvent: jest.Mock }).recordPlayerEvent.mock.calls[0][0]).toEqual(
      expect.objectContaining({ playerId: 'seller-other', amount: 30_000 })
    )
    // شناسهٔ داخلی فروشنده فقط برای ثبتِ خبر لازم بود؛ به خریدار برنمی‌گردد.
    // موجودیِ پس از خرید برای پنل نتیجه است و می‌ماند.
    expect(Object.keys(result).sort()).toEqual([
      'buyerBalanceAfter',
      'itemName',
      'quantity',
      'sellerName',
      'totalPrice'
    ])
  })

  test('rolls back when seller no longer has items', async () => {
    const listing = { ...ACTIVE_LISTING, sellerPlayerId: 'seller-other' }
    const innerTx = {
      player: {
        findUnique: jest.fn().mockResolvedValue({ id: 'buyer-1', balance: 10_000_000 }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn(),
        findUniqueOrThrow: jest.fn().mockResolvedValue({ firstName: 'فروشنده', lastName: null })
      },
      marketListing: { findUnique: jest.fn().mockResolvedValue(listing), update: jest.fn() },
      playerInventory: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        upsert: jest.fn(),
        deleteMany: jest.fn()
      },
      financialTransaction: { create: jest.fn() }
    }
    const db = { $transaction: jest.fn(async (fn: any) => fn(innerTx)) }

    const service = new TradeService(db as unknown as PrismaClient, makeEvents() as any)

    await expect(service.buyListing(1n, 'l1')).rejects.toThrow()
    expect(innerTx.financialTransaction.create).not.toHaveBeenCalled()
  })

  test('rejects buying your own listing', async () => {
    const listing = { ...ACTIVE_LISTING, sellerPlayerId: 'buyer-1' } // خودش فروشنده است
    const { db } = makeTradeDb(listing)
    const service = new TradeService(db as unknown as PrismaClient, makeEvents() as any)

    await expect(service.buyListing(1n, 'l1')).rejects.toThrow()
  })
})
