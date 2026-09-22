import { PrismaClient, GameEventType, EventScope } from '@prisma/client'
import { EventService, historyEventLabels } from '../src/modules/events/event.service'
import { NewsService } from '../src/modules/news/news.service'

function makeDb() {
  return {
    gameEvent: {
      create: jest.fn().mockResolvedValue({}),
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 })
    },
    group: { findUnique: jest.fn() }
  }
}

describe('EventService', () => {
  test('records a player event with the resolved priority', async () => {
    const db = makeDb()
    const service = new EventService(db as unknown as PrismaClient)

    await service.recordPlayerEvent({
      playerId: 'p1',
      type: GameEventType.SALARY_RECEIVED,
      title: 'دریافت دستمزد',
      amount: 5000
    })

    expect(db.gameEvent.create).toHaveBeenCalledTimes(1)
    const arg = db.gameEvent.create.mock.calls[0][0].data
    expect(arg.scope).toBe(EventScope.PLAYER)
    expect(arg.playerId).toBe('p1')
    expect(arg.amount).toBe(5000)
  })

  test('region events get a higher default priority', async () => {
    const db = makeDb()
    const service = new EventService(db as unknown as PrismaClient)

    await service.recordRegionEvent({
      groupId: 'g1',
      type: GameEventType.REGION_REGISTERED,
      title: 'منطقه ثبت شد'
    })

    const arg = db.gameEvent.create.mock.calls[0][0].data
    expect(arg.scope).toBe(EventScope.REGION)
    expect(arg.priority).toBe(5)
  })

  test('a duplicate dedupe key never breaks gameplay', async () => {
    const db = makeDb()
    db.gameEvent.create.mockRejectedValue(new Error('unique constraint failed'))
    const service = new EventService(db as unknown as PrismaClient)

    await expect(
      service.recordRegionEvent({
        groupId: 'g1',
        type: GameEventType.REGION_WEALTH_RECORD,
        title: 'رکورد ثروت',
        dedupeKey: 'wealth:g1:1'
      })
    ).resolves.toBeUndefined()
  })

  test('priority is clamped to the 1..5 range', async () => {
    const db = makeDb()
    const service = new EventService(db as unknown as PrismaClient)

    await service.recordRegionEvent({
      groupId: 'g1',
      type: GameEventType.MARKET_TRANSACTION,
      title: 'معامله',
      priority: 99
    })
    expect(db.gameEvent.create.mock.calls[0][0].data.priority).toBe(5)

    await service.recordRegionEvent({
      groupId: 'g1',
      type: GameEventType.MARKET_TRANSACTION,
      title: 'معامله',
      priority: -5
    })
    expect(db.gameEvent.create.mock.calls[1][0].data.priority).toBe(1)
  })

  test('player history is paginated and normalizes decimal amounts', async () => {
    const db = makeDb()
    db.gameEvent.count.mockResolvedValue(20)
    db.gameEvent.findMany.mockResolvedValue([
      {
        id: 'e1',
        type: GameEventType.HOUSE_PURCHASED,
        title: 'خرید ملک',
        detail: null,
        amount: { toString: () => '15000000' },
        createdAt: new Date()
      }
    ])
    const service = new EventService(db as unknown as PrismaClient)

    const page = await service.getPlayerHistory('p1', 1)

    expect(page.total).toBe(20)
    expect(page.page).toBe(1)
    expect(page.entries[0]?.amount).toBe(15_000_000)
    expect(db.gameEvent.findMany.mock.calls[0][0].skip).toBe(page.pageSize)
  })

  test('every event type has a persian history label', () => {
    for (const value of Object.values(historyEventLabels)) {
      expect(/[\u0600-\u06FF]/.test(value)).toBe(true)
      expect(/[A-Za-z]/.test(value)).toBe(false)
    }
  })

  test('pruning keeps high priority events', async () => {
    const db = makeDb()
    db.gameEvent.deleteMany.mockResolvedValue({ count: 7 })
    const service = new EventService(db as unknown as PrismaClient)

    const removed = await service.pruneOldEvents(30)

    expect(removed).toBe(7)
    expect(db.gameEvent.deleteMany.mock.calls[0][0].where.priority).toEqual({ lt: 4 })
  })
})

describe('NewsService', () => {
  test('throws for an unregistered group', async () => {
    const db = makeDb()
    db.group.findUnique.mockResolvedValue(null)
    const service = new NewsService(db as unknown as PrismaClient)

    await expect(service.getFeed(-100n)).rejects.toThrow()
  })

  test('feed only includes events of the requested group', async () => {
    const db = makeDb()
    db.group.findUnique.mockResolvedValue({ id: 'g1', title: 'شهر تست' })
    db.gameEvent.count.mockResolvedValue(1)
    db.gameEvent.findMany.mockResolvedValue([
      {
        id: 'e1',
        type: GameEventType.REGION_ECONOMY_SHIFT,
        title: 'رونق اقتصادی',
        detail: null,
        amount: null,
        priority: 4,
        createdAt: new Date()
      }
    ])
    const service = new NewsService(db as unknown as PrismaClient)

    const feed = await service.getFeed(-100n, 0)

    expect(feed.groupTitle).toBe('شهر تست')
    expect(feed.items).toHaveLength(1)
    expect(db.gameEvent.findMany.mock.calls[0][0].where.groupId).toBe('g1')
    expect(db.gameEvent.findMany.mock.calls[0][0].where.scope).toBe(EventScope.REGION)
  })

  test('broadcast claims only unpublished high priority events', async () => {
    const db = makeDb()
    db.gameEvent.findMany.mockResolvedValue([
      {
        id: 'e1',
        type: GameEventType.REGION_WEALTH_RECORD,
        title: 'رکورد ثروت',
        detail: null,
        amount: null,
        priority: 4,
        createdAt: new Date()
      }
    ])
    db.gameEvent.updateMany.mockResolvedValue({ count: 1 })
    const service = new NewsService(db as unknown as PrismaClient)

    const claimed = await service.claimBroadcastableNews('group-broadcast-1')

    expect(claimed).toHaveLength(1)
    const where = db.gameEvent.findMany.mock.calls[0][0].where
    expect(where.publishedAt).toBeNull()
    expect(where.priority).toEqual({ gte: 4 })
  })

  test('cooldown prevents a second broadcast for the same group', async () => {
    const db = makeDb()
    db.gameEvent.findMany.mockResolvedValue([
      {
        id: 'e1',
        type: GameEventType.REGION_WEALTH_RECORD,
        title: 'رکورد',
        detail: null,
        amount: null,
        priority: 5,
        createdAt: new Date()
      }
    ])
    db.gameEvent.updateMany.mockResolvedValue({ count: 1 })
    const service = new NewsService(db as unknown as PrismaClient)

    const first = await service.claimBroadcastableNews('group-cooldown-1')
    const second = await service.claimBroadcastableNews('group-cooldown-1')

    expect(first).toHaveLength(1)
    expect(second).toHaveLength(0)
  })

  test('does not publish when the atomic claim fails', async () => {
    const db = makeDb()
    db.gameEvent.findMany.mockResolvedValue([
      {
        id: 'e1',
        type: GameEventType.REGION_WEALTH_RECORD,
        title: 'رکورد',
        detail: null,
        amount: null,
        priority: 5,
        createdAt: new Date()
      }
    ])
    db.gameEvent.updateMany.mockResolvedValue({ count: 0 })
    const service = new NewsService(db as unknown as PrismaClient)

    const claimed = await service.claimBroadcastableNews('group-race-1')
    expect(claimed).toHaveLength(0)
  })
})

describe('NewsService.claimForChat — automatic broadcast on the hot path', () => {
  function makeBroadcastDb(events: unknown[] = []) {
    return {
      gameEvent: {
        create: jest.fn(),
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue(events),
        updateMany: jest.fn().mockResolvedValue({ count: events.length }),
        deleteMany: jest.fn()
      },
      group: { findUnique: jest.fn().mockResolvedValue({ id: 'g-chat-1' }) }
    }
  }

  const EVENT = {
    id: 'e1',
    type: GameEventType.PROJECT_COMPLETED,
    title: 'پروژه تکمیل شد',
    detail: 'پارک مرکزی',
    amount: null,
    priority: 4,
    createdAt: new Date()
  }

  test('a high priority event is claimed and marked as published', async () => {
    const db = makeBroadcastDb([EVENT])
    const service = new NewsService(db as unknown as PrismaClient)

    const items = await service.claimForChat(-1001n)

    expect(items).toHaveLength(1)
    expect(db.gameEvent.updateMany.mock.calls[0][0].data.publishedAt).toBeInstanceOf(Date)
  })

  test('a second call in the cooldown window costs zero queries', async () => {
    const db = makeBroadcastDb([EVENT])
    const service = new NewsService(db as unknown as PrismaClient)

    await service.claimForChat(-1002n)
    const callsAfterFirst = db.group.findUnique.mock.calls.length
    const second = await service.claimForChat(-1002n)

    expect(second).toHaveLength(0)
    // مسیر داغ پیام‌ها نباید هر بار Query بزند
    expect(db.group.findUnique.mock.calls.length).toBe(callsAfterFirst)
  })

  test('an unregistered chat is ignored silently', async () => {
    const db = makeBroadcastDb([EVENT])
    db.group.findUnique.mockResolvedValue(null)
    const service = new NewsService(db as unknown as PrismaClient)

    await expect(service.claimForChat(-1003n)).resolves.toEqual([])
    expect(db.gameEvent.updateMany).not.toHaveBeenCalled()
  })

  test('nothing to broadcast returns an empty list without publishing', async () => {
    const db = makeBroadcastDb([])
    const service = new NewsService(db as unknown as PrismaClient)

    await expect(service.claimForChat(-1004n)).resolves.toEqual([])
    expect(db.gameEvent.updateMany).not.toHaveBeenCalled()
  })
})
