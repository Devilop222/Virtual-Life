import { Prisma, PrismaClient } from '@prisma/client'
import { DailyQuestService, QUEST_REWARDS } from '../src/modules/quests/daily-quest.service'
import { AchievementService, ACHIEVEMENTS } from '../src/modules/achievements/achievement.service'
import { FortuneService } from '../src/modules/rewards/fortune.service'
import { EventService } from '../src/modules/events/event.service'
import { ConflictError, NotFoundError } from '../src/utils/classes/errors'
import { dayIndex, weekIndex, stableHash } from '../src/utils/game-time'

function makeEvents() {
  return { recordPlayerEvent: jest.fn().mockResolvedValue(undefined) }
}

/** تراکنش ساختگی: همان اشیای db را به callback می‌دهد. */
function passthroughTransaction(db: Record<string, unknown>) {
  return jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(db))
}

describe('game-time units', () => {
  test('day and week indexes advance together', () => {
    const now = Date.UTC(2026, 0, 1)
    expect(dayIndex(now)).toBe(Math.floor(now / 86_400_000))
    expect(weekIndex(now)).toBe(Math.floor(dayIndex(now) / 7))
  })

  test('stableHash is deterministic and non-negative', () => {
    expect(stableHash('abc')).toBe(stableHash('abc'))
    expect(stableHash('abc')).not.toBe(stableHash('abd'))
    expect(stableHash('anything')).toBeGreaterThanOrEqual(0)
  })
})

function makeQuestDb(overrides: Record<string, unknown> = {}) {
  const db: Record<string, unknown> = {
    player: {
      findUnique: jest.fn().mockResolvedValue({ id: 'p1' }),
      update: jest.fn().mockResolvedValue({})
    },
    dailyQuest: {
      createMany: jest.fn().mockResolvedValue({ count: 3 }),
      // ردیفِ علامتِ پاداش «هر سه کارت» (ضد دوبارپرداختِ همزمان)
      create: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      count: jest.fn().mockResolvedValue(0)
    },
    weeklyChest: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({})
    },
    financialTransaction: { create: jest.fn().mockResolvedValue({}) },
    ...overrides
  }
  db.$transaction = passthroughTransaction(db)
  return db
}

describe('DailyQuestService — deterministic cards', () => {
  test('the same player gets the same three cards all day', async () => {
    const db = makeQuestDb()
    const service = new DailyQuestService(
      db as unknown as PrismaClient,
      makeEvents() as unknown as EventService
    )

    const first = await service.getBoard(1n)
    const second = await service.getBoard(1n)

    expect(first.cards).toHaveLength(QUEST_REWARDS.cardsPerDay)
    expect(second.cards.map((c) => c.key)).toEqual(first.cards.map((c) => c.key))
  })

  test('the three cards of a day are always distinct', async () => {
    const db = makeQuestDb()
    const service = new DailyQuestService(
      db as unknown as PrismaClient,
      makeEvents() as unknown as EventService
    )

    const board = await service.getBoard(1n)
    expect(new Set(board.cards.map((c) => c.key)).size).toBe(board.cards.length)
  })

  test('missing rows are created so later progress has somewhere to land', async () => {
    const db = makeQuestDb()
    const service = new DailyQuestService(
      db as unknown as PrismaClient,
      makeEvents() as unknown as EventService
    )

    await service.getBoard(1n)

    const call = (db.dailyQuest as { createMany: jest.Mock }).createMany.mock.calls[0][0]
    expect(call.skipDuplicates).toBe(true)
    expect(call.data).toHaveLength(QUEST_REWARDS.cardsPerDay)
  })

  test('unregistered player is rejected', async () => {
    const db = makeQuestDb({
      player: { findUnique: jest.fn().mockResolvedValue(null), update: jest.fn() }
    })
    const service = new DailyQuestService(
      db as unknown as PrismaClient,
      makeEvents() as unknown as EventService
    )

    await expect(service.getBoard(1n)).rejects.toThrow(NotFoundError)
  })
})

describe('DailyQuestService — progress tracking is cheap and safe', () => {
  test('a trigger that is not an active card today writes nothing', async () => {
    const db = makeQuestDb()
    const service = new DailyQuestService(
      db as unknown as PrismaClient,
      makeEvents() as unknown as EventService
    )

    // کارت‌های امروز این بازیکن را می‌خوانیم و یک trigger بیرون از آن انتخاب می‌کنیم
    const board = await service.getBoard(1n)
    const activeKeys = new Set(board.cards.map((c) => c.key))
    const allTriggers = [
      'work_shift',
      'shop_purchase',
      'bank_deposit',
      'item_used',
      'group_activity',
      'market_trade',
      'project_donation'
    ] as const
    const inactive = allTriggers.find((t) => !activeKeys.has(t))!

    ;(db.dailyQuest as { updateMany: jest.Mock }).updateMany.mockClear()
    await service.track('p1', inactive)

    expect((db.dailyQuest as { updateMany: jest.Mock }).updateMany).not.toHaveBeenCalled()
  })

  test('an active trigger increments progress and never touches claimed rows', async () => {
    const db = makeQuestDb()
    const service = new DailyQuestService(
      db as unknown as PrismaClient,
      makeEvents() as unknown as EventService
    )

    const board = await service.getBoard(1n)
    const active = board.cards[0]!.key

    ;(db.dailyQuest as { updateMany: jest.Mock }).updateMany.mockClear()
    await service.track('p1', active as never)

    const where = (db.dailyQuest as { updateMany: jest.Mock }).updateMany.mock.calls[0][0].where
    expect(where.questKey).toBe(active)
    expect(where.claimedAt).toBeNull()
  })

  test('tracking never throws even when the database fails', async () => {
    const db = makeQuestDb()
    const service = new DailyQuestService(
      db as unknown as PrismaClient,
      makeEvents() as unknown as EventService
    )
    const board = await service.getBoard(1n)
    ;(db.dailyQuest as { updateMany: jest.Mock }).updateMany.mockRejectedValue(new Error('db down'))

    await expect(service.track('p1', board.cards[0]!.key as never)).resolves.toBeUndefined()
  })

  test('trackByTelegramId ignores unknown players silently', async () => {
    const db = makeQuestDb({
      player: { findUnique: jest.fn().mockResolvedValue(null), update: jest.fn() }
    })
    const service = new DailyQuestService(
      db as unknown as PrismaClient,
      makeEvents() as unknown as EventService
    )

    await expect(service.trackByTelegramId(1n, 'work_shift')).resolves.toBeUndefined()
    expect((db.dailyQuest as { updateMany: jest.Mock }).updateMany).not.toHaveBeenCalled()
  })
})

describe('DailyQuestService — claiming pays exactly once', () => {
  async function activeKeyFor(db: Record<string, unknown>): Promise<string> {
    const service = new DailyQuestService(
      db as unknown as PrismaClient,
      makeEvents() as unknown as EventService
    )
    const board = await service.getBoard(1n)
    return board.cards[0]!.key
  }

  test('a completed card pays its reward', async () => {
    const db = makeQuestDb()
    const key = await activeKeyFor(db)
    ;(db.dailyQuest as { findUnique: jest.Mock }).findUnique.mockResolvedValue({
      id: 'q1',
      progress: 5,
      target: 1,
      claimedAt: null
    })
    const service = new DailyQuestService(
      db as unknown as PrismaClient,
      makeEvents() as unknown as EventService
    )

    const result = await service.claimCard(1n, key)

    expect(result.reward).toBe(QUEST_REWARDS.card)
    expect(result.allThreeBonus).toBe(0)
    expect(
      (db.player as { update: jest.Mock }).update.mock.calls[0][0].data.balance.increment
    ).toBe(QUEST_REWARDS.card)
  })

  test('the quest feed event is recorded after the payment commits', async () => {
    const order: string[] = []
    const db = makeQuestDb()
    const key = await activeKeyFor(db)
    ;(db.dailyQuest as { findUnique: jest.Mock }).findUnique.mockResolvedValue({
      id: 'q1',
      progress: 5,
      target: 1,
      claimedAt: null
    })
    db.$transaction = jest.fn(async (fn: (t: unknown) => Promise<unknown>) => {
      const paid = await fn(db)
      order.push('payment committed')
      return paid
    })
    const events = {
      recordPlayerEvent: jest.fn(async (_input: Record<string, unknown>) => {
        order.push('feed event')
      })
    }
    const service = new DailyQuestService(
      db as unknown as PrismaClient,
      events as unknown as EventService
    )

    const result = await service.claimCard(1n, key)

    // چرا ترتیب مهم است؟ خبرِ خوراک با کانکسیونی جدا از تراکنش نوشته می‌شود؛
    // اگر وسطِ تراکنش باشد، هم وسطِ کار کانکسیون دومی اشغال می‌کند و هم اگر
    // تراکنش برگشت، ردیفِ خبریِ بازمانده چیزی را روایت می‌کند که هرگز رخ نداده.
    expect(order).toEqual(['payment committed', 'feed event'])
    expect((events as { recordPlayerEvent: jest.Mock }).recordPlayerEvent.mock.calls[0][0]).toEqual(
      expect.objectContaining({ playerId: 'p1', amount: result.reward })
    )
  })

  test('the third claim of a day adds the all-three bonus', async () => {
    const db = makeQuestDb()
    const key = await activeKeyFor(db)
    ;(db.dailyQuest as { findUnique: jest.Mock }).findUnique.mockResolvedValue({
      id: 'q1',
      progress: 1,
      target: 1,
      claimedAt: null
    })
    ;(db.dailyQuest as { count: jest.Mock }).count.mockResolvedValue(QUEST_REWARDS.cardsPerDay)
    const service = new DailyQuestService(
      db as unknown as PrismaClient,
      makeEvents() as unknown as EventService
    )

    const result = await service.claimCard(1n, key)

    expect(result.allThreeBonus).toBe(QUEST_REWARDS.allThree)
    expect(
      (db.player as { update: jest.Mock }).update.mock.calls[0][0].data.balance.increment
    ).toBe(QUEST_REWARDS.card + QUEST_REWARDS.allThree)
  })

  test('an incomplete card cannot be claimed', async () => {
    const db = makeQuestDb()
    const key = await activeKeyFor(db)
    ;(db.dailyQuest as { findUnique: jest.Mock }).findUnique.mockResolvedValue({
      id: 'q1',
      progress: 0,
      target: 3,
      claimedAt: null
    })
    const service = new DailyQuestService(
      db as unknown as PrismaClient,
      makeEvents() as unknown as EventService
    )

    await expect(service.claimCard(1n, key)).rejects.toThrow(ConflictError)
    expect((db.player as { update: jest.Mock }).update).not.toHaveBeenCalled()
  })

  test('a card already claimed is rejected', async () => {
    const db = makeQuestDb()
    const key = await activeKeyFor(db)
    ;(db.dailyQuest as { findUnique: jest.Mock }).findUnique.mockResolvedValue({
      id: 'q1',
      progress: 1,
      target: 1,
      claimedAt: new Date()
    })
    const service = new DailyQuestService(
      db as unknown as PrismaClient,
      makeEvents() as unknown as EventService
    )

    await expect(service.claimCard(1n, key)).rejects.toThrow(ConflictError)
  })

  test('two concurrent claims result in one payment', async () => {
    const db = makeQuestDb()
    const key = await activeKeyFor(db)
    ;(db.dailyQuest as { findUnique: jest.Mock }).findUnique.mockResolvedValue({
      id: 'q1',
      progress: 1,
      target: 1,
      claimedAt: null
    })
    // بازندهٔ رقابت: شرط claimedAt هیچ ردیفی را نمی‌گیرد
    ;(db.dailyQuest as { updateMany: jest.Mock }).updateMany.mockResolvedValue({ count: 0 })
    const service = new DailyQuestService(
      db as unknown as PrismaClient,
      makeEvents() as unknown as EventService
    )

    await expect(service.claimCard(1n, key)).rejects.toThrow(ConflictError)
    expect((db.player as { update: jest.Mock }).update).not.toHaveBeenCalled()
  })

  test('an unknown card key is rejected', async () => {
    const db = makeQuestDb()
    const service = new DailyQuestService(
      db as unknown as PrismaClient,
      makeEvents() as unknown as EventService
    )

    await expect(service.claimCard(1n, 'not_a_card')).rejects.toThrow(NotFoundError)
  })
})

describe('DailyQuestService — weekly chest', () => {
  test('an imperfect week cannot open the chest', async () => {
    const db = makeQuestDb()
    ;(db.dailyQuest as { count: jest.Mock }).count.mockResolvedValue(QUEST_REWARDS.cardsPerWeek - 1)
    const service = new DailyQuestService(
      db as unknown as PrismaClient,
      makeEvents() as unknown as EventService
    )

    await expect(service.claimWeeklyChest(1n)).rejects.toThrow(ConflictError)
    expect((db.weeklyChest as { create: jest.Mock }).create).not.toHaveBeenCalled()
  })

  test('a perfect week pays the chest once', async () => {
    const db = makeQuestDb()
    ;(db.dailyQuest as { count: jest.Mock }).count.mockResolvedValue(QUEST_REWARDS.cardsPerWeek)
    const service = new DailyQuestService(
      db as unknown as PrismaClient,
      makeEvents() as unknown as EventService
    )

    const result = await service.claimWeeklyChest(1n)

    expect(result.amount).toBe(QUEST_REWARDS.chest)
    expect(
      (db.player as { update: jest.Mock }).update.mock.calls[0][0].data.balance.increment
    ).toBe(QUEST_REWARDS.chest)
  })

  test('the unique constraint blocks a second chest in the same week', async () => {
    const db = makeQuestDb()
    ;(db.dailyQuest as { count: jest.Mock }).count.mockResolvedValue(QUEST_REWARDS.cardsPerWeek)
    ;(db.weeklyChest as { create: jest.Mock }).create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError(
        'Unique constraint failed on the fields: (`player_id`, `week_index`)',
        { code: 'P2002', clientVersion: '6.19.3' }
      )
    )
    const service = new DailyQuestService(
      db as unknown as PrismaClient,
      makeEvents() as unknown as EventService
    )

    await expect(service.claimWeeklyChest(1n)).rejects.toThrow(ConflictError)
    expect((db.player as { update: jest.Mock }).update).not.toHaveBeenCalled()
  })
})

function makeAchievementDb(overrides: Record<string, unknown> = {}) {
  const db: Record<string, unknown> = {
    player: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'p1',
        currentDegree: 'DIPLOMA',
        streakCount: 0,
        balance: 0
      }),
      update: jest.fn().mockResolvedValue({}),
      count: jest.fn().mockResolvedValue(0)
    },
    achievementGrant: {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({}),
      count: jest.fn().mockResolvedValue(0)
    },
    workSession: { count: jest.fn().mockResolvedValue(0) },
    bankAccount: { aggregate: jest.fn().mockResolvedValue({ _sum: { balance: 0 } }) },
    property: { count: jest.fn().mockResolvedValue(0) },
    rentalContract: { count: jest.fn().mockResolvedValue(0) },
    business: { count: jest.fn().mockResolvedValue(0) },
    financialTransaction: {
      count: jest.fn().mockResolvedValue(0),
      aggregate: jest.fn().mockResolvedValue({ _sum: { amount: 0 } }),
      create: jest.fn().mockResolvedValue({})
    },
    referral: { count: jest.fn().mockResolvedValue(0) },
    travelStamp: { count: jest.fn().mockResolvedValue(0) },
    election: { count: jest.fn().mockResolvedValue(0) },
    loan: {
      count: jest.fn().mockResolvedValue(0),
      aggregate: jest.fn().mockResolvedValue({ _sum: { remainingAmount: 0 } })
    },
    ...overrides
  }
  db.$transaction = passthroughTransaction(db)
  return db
}

describe('AchievementService — evaluated from real state', () => {
  test('a brand new player has no unlocked badge', async () => {
    const db = makeAchievementDb()
    const service = new AchievementService(
      db as unknown as PrismaClient,
      makeEvents() as unknown as EventService
    )

    const board = await service.getBoard(1n)

    expect(board.total).toBe(ACHIEVEMENTS.length)
    expect(board.unlockedCount).toBe(0)
    expect(board.totalReward).toBe(0)
  })

  test('completing a shift unlocks and pays the first badge', async () => {
    const db = makeAchievementDb({
      workSession: { count: jest.fn().mockResolvedValue(1) }
    })
    const service = new AchievementService(
      db as unknown as PrismaClient,
      makeEvents() as unknown as EventService
    )

    const board = await service.getBoard(1n)
    const first = ACHIEVEMENTS.find((a) => a.key === 'first_shift')!

    expect(board.newlyUnlocked.map((i) => i.key)).toContain('first_shift')
    expect(
      (db.player as { update: jest.Mock }).update.mock.calls[0][0].data.balance.increment
    ).toBe(first.reward)
  })

  test('an already granted badge is never paid twice', async () => {
    const db = makeAchievementDb({
      workSession: { count: jest.fn().mockResolvedValue(1) },
      achievementGrant: {
        findMany: jest.fn().mockResolvedValue([{ key: 'first_shift', grantedAt: new Date() }]),
        create: jest.fn().mockResolvedValue({}),
        count: jest.fn().mockResolvedValue(1)
      }
    })
    const service = new AchievementService(
      db as unknown as PrismaClient,
      makeEvents() as unknown as EventService
    )

    const board = await service.getBoard(1n)

    expect(board.newlyUnlocked).toHaveLength(0)
    expect((db.achievementGrant as { create: jest.Mock }).create).not.toHaveBeenCalled()
    expect((db.player as { update: jest.Mock }).update).not.toHaveBeenCalled()
  })

  test('a unique collision during grant skips the payment', async () => {
    const db = makeAchievementDb({
      workSession: { count: jest.fn().mockResolvedValue(1) }
    })
    ;(db.achievementGrant as { create: jest.Mock }).create.mockRejectedValue(
      new Error('unique violation')
    )
    const service = new AchievementService(
      db as unknown as PrismaClient,
      makeEvents() as unknown as EventService
    )

    const board = await service.getBoard(1n)

    expect(board.newlyUnlocked).toHaveLength(0)
    expect((db.player as { update: jest.Mock }).update).not.toHaveBeenCalled()
  })

  test('net worth subtracts debt before judging the wealthy badge', async () => {
    const db = makeAchievementDb({
      player: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'p1',
          currentDegree: 'DIPLOMA',
          streakCount: 0,
          balance: 90_000_000
        }),
        update: jest.fn().mockResolvedValue({}),
        count: jest.fn().mockResolvedValue(0)
      },
      bankAccount: {
        aggregate: jest.fn().mockResolvedValue({ _sum: { balance: 50_000_000 } })
      },
      loan: {
        count: jest.fn().mockResolvedValue(0),
        aggregate: jest.fn().mockResolvedValue({ _sum: { remainingAmount: 60_000_000 } })
      }
    })
    const service = new AchievementService(
      db as unknown as PrismaClient,
      makeEvents() as unknown as EventService
    )

    const board = await service.getBoard(1n)
    // ۹۰ + ۵۰ − ۶۰ = ۸۰ میلیون، هنوز زیر آستانهٔ صد میلیون
    expect(board.items.find((i) => i.key === 'wealthy')?.unlocked).toBe(false)
    // اما پس‌انداز بانکی از ده میلیون گذشته است
    expect(board.items.find((i) => i.key === 'saver')?.unlocked).toBe(true)
  })

  test('an employed player without a completed shift still earns the first badge', async () => {
    const db = makeAchievementDb({
      player: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'p1',
          currentDegree: 'DIPLOMA',
          streakCount: 0,
          balance: 0
        }),
        update: jest.fn().mockResolvedValue({}),
        count: jest.fn().mockResolvedValue(1)
      }
    })
    const service = new AchievementService(
      db as unknown as PrismaClient,
      makeEvents() as unknown as EventService
    )

    const board = await service.getBoard(1n)
    expect(board.items.find((i) => i.key === 'first_shift')?.unlocked).toBe(true)
  })

  test('badge keys and rewards are unique and sane', () => {
    const keys = ACHIEVEMENTS.map((a) => a.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const badge of ACHIEVEMENTS) {
      expect(badge.reward).toBeGreaterThan(0)
      expect(badge.title.length).toBeGreaterThan(0)
      expect(/[\u0600-\u06FF]/.test(badge.description)).toBe(true)
    }
  })

  test('summary reports the stored count without re-evaluating', async () => {
    const db = makeAchievementDb({
      achievementGrant: {
        findMany: jest.fn().mockResolvedValue([{ key: 'first_shift' }]),
        create: jest.fn(),
        count: jest.fn().mockResolvedValue(1)
      }
    })
    const service = new AchievementService(
      db as unknown as PrismaClient,
      makeEvents() as unknown as EventService
    )

    const summary = await service.getSummary('p1')

    expect(summary.count).toBe(1)
    expect(summary.icons).toHaveLength(1)
    expect((db.workSession as { count: jest.Mock }).count).not.toHaveBeenCalled()
  })
})

function makeFortuneDb(playerId = 'p1', overrides: Record<string, unknown> = {}) {
  const db: Record<string, unknown> = {
    player: {
      findUnique: jest.fn().mockResolvedValue({ id: playerId }),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      count: jest.fn().mockResolvedValue(1)
    },
    dailyFortune: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({})
    },
    financialTransaction: { create: jest.fn().mockResolvedValue({}) },
    ...overrides
  }
  db.$transaction = passthroughTransaction(db)
  return db
}

/**
 * نتیجهٔ شانس به شناسهٔ داخلی بازیکن گره خورده است، پس برای تست هر حالت
 * (سود/ضرر/جایزه) شناسه‌ای پیدا می‌کنیم که امروز همان نتیجه را بدهد.
 */
async function findPlayerIdWithOutcome(kind: string): Promise<string> {
  for (let index = 0; index < 500; index++) {
    const playerId = `probe-${index}`
    const db = makeFortuneDb(playerId)
    const service = new FortuneService(db as unknown as PrismaClient)
    const outcome = await service.draw(1n)
    if (outcome.kind === kind) {
      return playerId
    }
  }
  throw new Error(`no player id produced outcome ${kind}`)
}

describe('FortuneService — one deterministic draw per day', () => {
  test('the same player draws the same outcome all day', async () => {
    const outcomes = new Set<string>()
    for (let attempt = 0; attempt < 3; attempt++) {
      const db = makeFortuneDb()
      const service = new FortuneService(db as unknown as PrismaClient)
      const outcome = await service.draw(1n)
      outcomes.add(`${outcome.kind}:${outcome.amount}`)
    }
    expect(outcomes.size).toBe(1)
  })

  test('a second draw the same day is rejected by the unique constraint', async () => {
    const db = makeFortuneDb()
    ;(db.dailyFortune as { create: jest.Mock }).create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError(
        'Unique constraint failed on the fields: (`player_id`, `day_index`)',
        { code: 'P2002', clientVersion: '6.19.3' }
      )
    )
    const service = new FortuneService(db as unknown as PrismaClient)

    // ادعا آخرین نوشتارِ تراکنش است؛ پس این پرتاب کل تراکنش را برمی‌گرداند و
    // کشیدنِ تکراری حتی یک ریال هم جابه‌جا نمی‌کند (روی دیتابیسِ زنده در
    // scripts/economy-race-smoke.cjs اندازه‌گیری می‌شود).
    await expect(service.draw(1n)).rejects.toThrow(ConflictError)
    expect(db.$transaction).toHaveBeenCalledTimes(1)
  })

  test('a real database error is not reported as an already-drawn day', async () => {
    const db = makeFortuneDb()
    const failure = new Error('connection lost')
    ;(db.dailyFortune as { create: jest.Mock }).create.mockRejectedValue(failure)
    const service = new FortuneService(db as unknown as PrismaClient)

    // اگر هر خطایی «قبلاً کشیده‌ای» ترجمه شود، بازیکن هم پیامِ غلط می‌بیند و هم
    // شانسِ روزش می‌سوزد؛ خطای واقعی باید بالا برود تا تراکنش برگردد.
    await expect(service.draw(1n)).rejects.toBe(failure)
  })

  test('the daily draw is claimed by the same transaction that pays it', async () => {
    const gainPlayerId = await findPlayerIdWithOutcome('gain')
    const fortuneCreate = jest.fn().mockResolvedValue({})
    const scoped = makeTransactionScopedDb(makeFortuneDb(gainPlayerId), 'dailyFortune', {
      findUnique: jest.fn().mockResolvedValue(null),
      create: fortuneCreate
    })
    const service = new FortuneService(scoped.db as unknown as PrismaClient)

    const outcome = await service.draw(1n)

    expect(outcome.kind).toBe('gain')
    expect(scoped.db.$transaction).toHaveBeenCalledTimes(1)
    expect(fortuneCreate).toHaveBeenCalledTimes(1)
    expect(fortuneCreate.mock.calls[0][0].data).toEqual(
      expect.objectContaining({ kind: 'gain', amount: outcome.amount })
    )
    expect(
      (scoped.tx.player as { update: jest.Mock }).update.mock.calls[0][0].data.balance.increment
    ).toBe(outcome.amount)
  })

  test('a loss is skipped entirely when the player cannot afford it', async () => {
    const lossPlayerId = await findPlayerIdWithOutcome('loss')

    const db = makeFortuneDb(lossPlayerId)
    // موجودی کافی نیست: گاردِ `balance >= amount` صفر ردیف می‌گیرد
    ;(db.player as { updateMany: jest.Mock }).updateMany.mockResolvedValue({ count: 0 })
    const service = new FortuneService(db as unknown as PrismaClient)

    const outcome = await service.draw(1n)

    expect(outcome.kind).toBe('neutral')
    expect(outcome.amount).toBe(0)
    // نه پولی کسر شد، نه ردیفی در دفتر کل، و آنچه ذخیره شد همان نتیجهٔ بی‌اثر است
    expect((db.financialTransaction as { create: jest.Mock }).create).not.toHaveBeenCalled()
    expect((db.dailyFortune as { create: jest.Mock }).create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ kind: 'neutral', amount: 0 })
      })
    )
  })

  test('a loss debits with a balance guard so money never goes negative', async () => {
    const lossPlayerId = await findPlayerIdWithOutcome('loss')

    const db = makeFortuneDb(lossPlayerId)
    const service = new FortuneService(db as unknown as PrismaClient)
    const outcome = await service.draw(1n)

    expect(outcome.kind).toBe('loss')
    const where = (db.player as { updateMany: jest.Mock }).updateMany.mock.calls[0][0].where
    expect(where.balance.gte).toBe(outcome.amount)
  })

  test('a gain credits the wallet without any balance condition', async () => {
    const gainPlayerId = await findPlayerIdWithOutcome('gain')

    const db = makeFortuneDb(gainPlayerId)
    const service = new FortuneService(db as unknown as PrismaClient)
    const outcome = await service.draw(1n)

    expect(outcome.kind).toBe('gain')
    expect(
      (db.player as { update: jest.Mock }).update.mock.calls[0][0].data.balance.increment
    ).toBe(outcome.amount)
  })

  test('a neutral outcome touches no money at all', async () => {
    const neutralPlayerId = await findPlayerIdWithOutcome('neutral')

    const db = makeFortuneDb(neutralPlayerId)
    const service = new FortuneService(db as unknown as PrismaClient)
    const outcome = await service.draw(1n)

    expect(outcome.amount).toBe(0)
    expect((db.player as { update: jest.Mock }).update).not.toHaveBeenCalled()
    expect((db.player as { updateMany: jest.Mock }).updateMany).not.toHaveBeenCalled()
    expect((db.financialTransaction as { create: jest.Mock }).create).not.toHaveBeenCalled()
  })

  test('status reports nothing before the first draw of the day', async () => {
    const db = makeFortuneDb()
    const service = new FortuneService(db as unknown as PrismaClient)

    const status = await service.getStatus(1n)

    expect(status.drawnToday).toBe(false)
    expect(status.message).toBeNull()
  })

  test('status echoes the stored outcome after drawing', async () => {
    const db = makeFortuneDb('p1', {
      dailyFortune: {
        findUnique: jest.fn().mockResolvedValue({
          kind: 'gain',
          amount: 40_000,
          message: 'پیام آزمایشی'
        }),
        create: jest.fn()
      }
    })
    const service = new FortuneService(db as unknown as PrismaClient)

    const status = await service.getStatus(1n)

    expect(status.drawnToday).toBe(true)
    expect(status.kind).toBe('gain')
    expect(status.amount).toBe(40_000)
  })

  test('unregistered players cannot draw', async () => {
    const db = makeFortuneDb('p1', {
      player: { findUnique: jest.fn().mockResolvedValue(null) }
    })
    const service = new FortuneService(db as unknown as PrismaClient)

    await expect(service.draw(1n)).rejects.toThrow(NotFoundError)
  })

  test('gain and jackpot amounts stay small compared to a work shift', async () => {
    for (let id = 1n; id < 60n; id++) {
      const db = makeFortuneDb()
      const service = new FortuneService(db as unknown as PrismaClient)
      const outcome = await service.draw(id)
      expect(outcome.amount).toBeLessThanOrEqual(250_000)
    }
  })
})

/**
 * دیتابی که در آن نوشتنِ «ادعا» فقط *داخل* تراکنشِ پرداخت ممکن است.
 *
 * چرا؟ اگر ردیفِ ادعا بیرون از تراکنشِ پرداخت نوشته شود، شکستِ پرداخت ادعا را
 * برای همیشه می‌سوزاند: بازیکن نه پول می‌گیرد و نه می‌تواند دوباره تلاش کند.
 * این mock همان اشتباه را با یک پرتابِ صریح لو می‌دهد.
 */
function makeTransactionScopedDb(
  db: Record<string, unknown>,
  delegate: string,
  txDelegate: Record<string, unknown>
) {
  const tx: Record<string, unknown> = { ...db, [delegate]: txDelegate }
  db[delegate] = {
    ...(db[delegate] as Record<string, unknown>),
    create: jest.fn(() => {
      throw new Error(`${delegate}.create must run inside the paying transaction`)
    })
  }
  db.$transaction = jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx))
  return { db, tx }
}

describe('DailyQuestService — the weekly chest claim and its payment are atomic', () => {
  function unlockedChestDb() {
    const db = makeQuestDb()
    ;(db.dailyQuest as { count: jest.Mock }).count.mockResolvedValue(QUEST_REWARDS.cardsPerWeek)
    const chestCreate = jest.fn().mockResolvedValue({})
    return {
      ...makeTransactionScopedDb(db, 'weeklyChest', {
        findUnique: jest.fn().mockResolvedValue(null),
        create: chestCreate
      }),
      chestCreate
    }
  }

  test('the chest row is written by the same transaction that pays it', async () => {
    const { db, chestCreate } = unlockedChestDb()
    const service = new DailyQuestService(
      db as unknown as PrismaClient,
      makeEvents() as unknown as EventService
    )

    const result = await service.claimWeeklyChest(1n)

    expect(result.amount).toBe(QUEST_REWARDS.chest)
    expect(chestCreate).toHaveBeenCalledTimes(1)
    expect(db.$transaction).toHaveBeenCalledTimes(1)
    expect(
      (db.player as { update: jest.Mock }).update.mock.calls[0][0].data.balance.increment
    ).toBe(QUEST_REWARDS.chest)
  })
})

describe('AchievementService — a badge is claimed only when it is paid', () => {
  function grantedDb(paymentFails = false) {
    const db = makeAchievementDb({ workSession: { count: jest.fn().mockResolvedValue(1) } })
    const grantCreate = jest.fn().mockResolvedValue({})
    const tx = {
      achievementGrant: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        create: grantCreate
      },
      player: {
        update: paymentFails
          ? jest.fn().mockRejectedValue(new Error('connection closed'))
          : jest.fn().mockResolvedValue({})
      },
      financialTransaction: { create: jest.fn().mockResolvedValue({}) }
    }
    const scoped = makeTransactionScopedDb(db, 'achievementGrant', tx.achievementGrant)
    // the payment writes go through the same transaction object
    ;(scoped.tx as Record<string, unknown>).player = tx.player
    ;(scoped.tx as Record<string, unknown>).financialTransaction = tx.financialTransaction
    return { ...scoped, grantCreate, payment: tx.player.update }
  }

  test('grant and reward share one transaction', async () => {
    const { db, grantCreate } = grantedDb()
    const service = new AchievementService(
      db as unknown as PrismaClient,
      makeEvents() as unknown as EventService
    )

    const board = await service.getBoard(1n)

    expect(board.newlyUnlocked.map((item) => item.key)).toContain('first_shift')
    expect(grantCreate).toHaveBeenCalledTimes(1)
    expect(db.$transaction).toHaveBeenCalledTimes(1)
  })

  test('a failed payment leaves the badge unclaimed, so the next visit retries', async () => {
    const { db, grantCreate } = grantedDb(true)
    const service = new AchievementService(
      db as unknown as PrismaClient,
      makeEvents() as unknown as EventService
    )

    const board = await service.getBoard(1n)

    // nothing is reported as unlocked and the board still opens
    expect(board.newlyUnlocked).toHaveLength(0)
    expect(board.unlockedCount).toBe(0)
    // the claim was attempted inside the transaction that failed → it rolls back
    expect(grantCreate).toHaveBeenCalledTimes(1)
  })
})
