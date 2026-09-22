/**
 * رگرسیون اصلاحات ممیزی کامل (شهریور ۱۴۰۵).
 *
 * هر تست یک باگ واقعیِ تأییدشده در بازبینی را قفل می‌کند:
 *  ۱. شمارندهٔ «تسویهٔ معوق» سپرده بین بازیکنان مشترک بود (آلودگی پنل).
 *  ۲. ردیف دفتر کلِ بازپرداخت قرض بازیکنی از واریزی واقعی وام‌دهنده بیشتر بود.
 *  ۳. Cooldown خبر در دو فضای کلید جدا نگه داشته می‌شد (چت / گروه داخلی).
 *  ۴. کلید ضدتکرار اعلان درخواست قرض (`Date.now()`) هرگز تکرار نمی‌شد.
 *  ۵. استراحتِ عضو باشگاه با سلامت بالای ۱۰۰، سلامت را *کم* می‌کرد.
 */
import { PlayerActivityState, PrismaClient, TermDepositStatus } from '@prisma/client'
import { SkillRepository } from '../src/database/repositories/skill.repository'
import { DepositService } from '../src/modules/banking/deposit.service'
import { PlayerLoanService } from '../src/modules/lending/player-loan.service'
import { NewsService } from '../src/modules/news/news.service'
import { HousingService } from '../src/modules/housing/housing.service'
import { PRIMARY_OWNER_TELEGRAM_ID } from '../src/modules/admin/admin.service'
import { EventService } from '../src/modules/events/event.service'
import { GameEventType } from '@prisma/client'

function makeEvents() {
  return {
    recordPlayerEvent: jest.fn().mockResolvedValue(undefined),
    recordRegionEvent: jest.fn().mockResolvedValue(undefined)
  }
}

describe('Audit fix 1 — deferred deposit count is per-call, never shared', () => {
  function makeDb(balance: number, deposits: unknown[]) {
    const db: Record<string, unknown> = {
      player: {
        findUnique: jest.fn().mockResolvedValue({ id: 'p1' }),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      },
      termDeposit: {
        findMany: jest.fn().mockResolvedValue(deposits),
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      },
      financialTransaction: { create: jest.fn().mockResolvedValue({}) },
      bankPool: {
        findUnique: jest.fn().mockResolvedValue({ balance }),
        upsert: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: balance > 0 ? 1 : 0 })
      },
      travelStamp: { count: jest.fn().mockResolvedValue(0) }
    }
    db.$transaction = jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(db))
    return db
  }

  const matured = {
    id: 'd1',
    playerId: 'p1',
    principal: 1_000_000,
    rateAnnual: 0.2,
    termDays: 7,
    status: TermDepositStatus.ACTIVE,
    maturesAt: new Date(Date.now() - 1000)
  }

  test('a settled player sees zero pending even after another player deferred', async () => {
    // نمونهٔ سرویس در کل فرایند مشترک است؛ پس هر دو بازیکن از یک نمونه می‌خوانند
    const poorDb = makeDb(0, [matured])
    const service = new DepositService(
      poorDb as unknown as PrismaClient,
      makeEvents() as unknown as EventService
    )

    const first = await service.settleMatured('p1')
    expect(first).toEqual({ settled: 0, deferred: 1 })

    // بازیکن دوم با دیتابیس خودش و بدون سپردهٔ سررسیده
    const richDb = makeDb(500_000_000, [])
    const service2 = new DepositService(
      richDb as unknown as PrismaClient,
      makeEvents() as unknown as EventService
    )
    // همان نمونهٔ اشتراکی در دنیای واقعی؛ اینجا با تعویض db شبیه‌سازی می‌شود
    ;(service as unknown as { db: unknown }).db = richDb
    void service2

    const second = await service.settleMatured('p2')
    expect(second).toEqual({ settled: 0, deferred: 0 })
  })
})

describe('Audit fix 2 — P2P repay ledger matches the real payout', () => {
  function makeLoanDb() {
    const created: Array<{ data: Record<string, unknown> }> = []
    const tx = {
      playerLoan: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      player: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockResolvedValue({})
      },
      financialTransaction: {
        create: jest.fn(async (arg: { data: Record<string, unknown> }) => {
          created.push(arg)
          return arg.data
        })
      }
    }
    const db = {
      player: { findUnique: jest.fn().mockResolvedValue({ id: 'borrower-1' }) },
      playerLoan: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'loan-1',
          borrowerId: 'borrower-1',
          lenderId: 'lender-1',
          principal: 1_000_000,
          totalRepay: 1_003_333,
          status: 'ACTIVE'
        })
      },
      $transaction: jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx))
    }
    return { db, tx, created }
  }

  test('lender income row equals the credited 108%, fee is a separate sink row', async () => {
    const { db, tx, created } = makeLoanDb()
    const service = new PlayerLoanService(
      db as unknown as PrismaClient,
      makeEvents() as unknown as EventService
    )

    const { paid } = await service.repay(7n, 'loan-1')
    expect(paid).toBe(1_003_333)

    // واریزی واقعی به وام‌دهنده
    expect(tx.player.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'lender-1' },
        data: { balance: { increment: 1_002_667 } }
      })
    )

    // دو ردیف دفتر کل: انتقال واقعی + کارمزد سوخته
    expect(created).toHaveLength(2)
    const [transfer, fee] = created.map((c) => c.data)
    expect(transfer).toBeDefined()
    expect(fee).toBeDefined()
    const t = transfer as Record<string, unknown>
    const f = fee as Record<string, unknown>
    void transfer
    void fee
    expect(t.amount).toBe(1_002_667)
    expect(t.sourcePlayerId).toBe('borrower-1')
    expect(t.destinationPlayerId).toBe('lender-1')
    expect(f.amount).toBe(666)
    expect(f.sourcePlayerId).toBe('borrower-1')
    expect(f.destinationPlayerId).toBeUndefined()
    // جمع خروجی وام‌گیرنده همان کل قرارداد است
    expect(Number(t.amount) + Number(f.amount)).toBe(1_003_333)
  })
})

describe('Audit fix 3 — news cooldown lives in one key space', () => {
  const EVENT = {
    id: 'e-fix-3',
    type: GameEventType.PROJECT_COMPLETED,
    title: 'پروژه تکمیل شد',
    detail: 'پارک مرکزی',
    amount: null,
    priority: 4,
    createdAt: new Date()
  }

  function makeDb(groupId: string) {
    return {
      group: { findUnique: jest.fn().mockResolvedValue({ id: groupId }) },
      gameEvent: {
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 0 })
      }
    }
  }

  test('a broadcast via chat id also cools down the direct group path', async () => {
    const db = makeDb('g-fix-3')
    db.gameEvent.findMany.mockResolvedValueOnce([EVENT])
    db.gameEvent.updateMany.mockResolvedValueOnce({ count: 1 })
    const service = new NewsService(db as unknown as PrismaClient)

    const viaChat = await service.claimForChat(-90031n)
    expect(viaChat).toHaveLength(1)

    // همان گروه از مسیر مستقیم: باید در Cooldown باشد، بدون Query تازه
    const findManyCalls = db.gameEvent.findMany.mock.calls.length
    const direct = await service.claimBroadcastableNews('g-fix-3')
    expect(direct).toHaveLength(0)
    expect(db.gameEvent.findMany.mock.calls.length).toBe(findManyCalls)
  })

  test('an empty check throttles repeats briefly, without a 30-minute suppression', async () => {
    const db = makeDb('g-fix-3b')
    const service = new NewsService(db as unknown as PrismaClient)

    await expect(service.claimForChat(-90032n)).resolves.toEqual([])

    // تکرار فوری Query تازه نمی‌زند (نگهبان «بی‌خبر»)
    const groupCalls = db.group.findUnique.mock.calls.length
    const eventCalls = db.gameEvent.findMany.mock.calls.length
    await expect(service.claimForChat(-90032n)).resolves.toEqual([])
    expect(db.group.findUnique.mock.calls.length).toBe(groupCalls)
    expect(db.gameEvent.findMany.mock.calls.length).toBe(eventCalls)

    // ولی Cooldownِ ۳۰دقیقه‌ای انتشار فعال نشده است: خبر تازه از مسیر
    // مستقیم گروه بلافاصله claim می‌شود.
    db.gameEvent.findMany.mockResolvedValueOnce([EVENT])
    db.gameEvent.updateMany.mockResolvedValueOnce({ count: 1 })
    const direct = await service.claimBroadcastableNews('g-fix-3b')
    expect(direct).toHaveLength(1)
  })
})

describe('Audit fix 4 — loan request notification dedupes per contract', () => {
  test('dedupe key is the stable loan id, not a timestamp', async () => {
    const notifyPlayerById = jest.fn().mockResolvedValue(true)
    const db = {
      player: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce({ id: 'borrower-9' })
          .mockResolvedValueOnce({ id: 'lender-9', firstName: 'وام', lastName: 'دهنده' })
      },
      playerLoan: {
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn().mockResolvedValue({ id: 'loan-9' })
      }
    }
    const service = new PlayerLoanService(
      db as unknown as PrismaClient,
      makeEvents() as unknown as EventService,
      { notifyPlayerById }
    )

    await service.request(9n, 'lender-9', 500_000)

    expect(notifyPlayerById).toHaveBeenCalledWith(
      'lender-9',
      expect.any(String),
      expect.any(String),
      undefined,
      'ploan-req:loan-9',
      // وام بین بازیکنان مستقیماً روی پول اثر می‌گذارد: اعلان حیاتی است.
      'CRITICAL'
    )
  })
})

describe('Audit fix 5 — rest never lowers a gym member above 100 health', () => {
  function makeHousingDb(health: number, isMember: boolean) {
    const playerRepo = {
      findByTelegramUserId: jest.fn().mockResolvedValue({
        id: 'p-rest',
        health,
        fatigue: 40,
        activityState: PlayerActivityState.RESTING,
        restStartedAt: new Date(Date.now() - 60 * 60 * 1000),
        homeGroupId: null,
        isEnrolled: false
      })
    }
    const housingRepo = {
      listPlayerProperties: jest.fn().mockResolvedValue([{ level: 1, isFurnished: false, title: 'سوئیت' }]),
      findActiveRental: jest.fn().mockResolvedValue(null),
      stopResting: jest.fn().mockResolvedValue(undefined)
    }
    const db = {
      gymMembership: {
        findFirst: jest.fn().mockResolvedValue(isMember ? { id: 'gym-1' } : null)
      }
    }
    return { playerRepo, housingRepo, db }
  }

  test('gym member at 110 health recovers toward 120, never downward', async () => {
    const { playerRepo, housingRepo, db } = makeHousingDb(110, true)
    const service = new HousingService(
      housingRepo as never,
      playerRepo as never,
      undefined,
      db as unknown as PrismaClient
    )

    const status = await service.stopRestAtHome(42n)

    expect(status.healthRecovered).toBeGreaterThanOrEqual(0)
    expect(housingRepo.stopResting).toHaveBeenCalledWith(
      'p-rest',
      expect.any(Number),
      expect.any(Number)
    )
    const passed = (housingRepo.stopResting.mock.calls[0] as unknown[])[2] as number
    expect(passed).toBeGreaterThanOrEqual(0)
  })

  test('non-member is still capped at the base 100', async () => {
    const { playerRepo, housingRepo, db } = makeHousingDb(95, false)
    const service = new HousingService(
      housingRepo as never,
      playerRepo as never,
      undefined,
      db as unknown as PrismaClient
    )

    const status = await service.stopRestAtHome(42n)

    expect(status.healthRecovered).toBeGreaterThanOrEqual(0)
    expect(status.healthRecovered).toBeLessThanOrEqual(5)
  })
})

describe('Audit fix 6 — primary owner id has a single source', () => {
  test('the constant keeps the production owner id', () => {
    expect(PRIMARY_OWNER_TELEGRAM_ID).toBe(6910416744n)
  })
})

describe('Audit optimization — skill names resolve in one query', () => {
  test('findIdsByNames maps every name with a single findMany', async () => {
    const findMany = jest.fn().mockResolvedValue([
      { id: 'sk-a', name: 'a' },
      { id: 'sk-b', name: 'b' }
    ])
    const repo = new SkillRepository({ skill: { findMany } } as unknown as PrismaClient)

    const map = await repo.findIdsByNames(['a', 'b', 'missing'])

    expect(findMany).toHaveBeenCalledTimes(1)
    expect(findMany).toHaveBeenCalledWith({
      where: { name: { in: ['a', 'b', 'missing'] } },
      select: { id: true, name: true }
    })
    expect(map.get('a')).toBe('sk-a')
    expect(map.get('b')).toBe('sk-b')
    expect(map.has('missing')).toBe(false)
  })

  test('empty input costs zero queries', async () => {
    const findMany = jest.fn()
    const repo = new SkillRepository({ skill: { findMany } } as unknown as PrismaClient)

    await expect(repo.findIdsByNames([])).resolves.toEqual(new Map())
    expect(findMany).not.toHaveBeenCalled()
  })
})
