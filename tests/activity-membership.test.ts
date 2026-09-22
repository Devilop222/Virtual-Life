import { PrismaClient } from '@prisma/client'
import { ActivityService } from '../src/modules/activity/activity.service'
import { ResidenceService } from '../src/modules/residence/residence.service'
import type { EventService } from '../src/modules/events/event.service'
import type { RewardsService } from '../src/modules/rewards/rewards.service'

/**
 * تثبیت عضویت محلی: فعالیت واقعی در گروهِ فعال باید ردیف PlayerGroup بسازد.
 * این عضویت پیش‌شرط رأی در انتخابات، رتبهٔ گروه، مقاصد مهاجرت و جمعیت منطقه است؛
 * پیش‌تر فقط /startِ گروه آن را می‌ساخت و اکثر بازیکنان هرگز عضو نمی‌شدند.
 */

function makeDb(overrides: Record<string, unknown> = {}) {
  const playerGroupStore = new Map<string, { status: string }>()
  return {
    player: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ id: 'p1', homeGroupId: 'g-old', status: 'ACTIVE' }),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 })
    },
    group: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ id: 'g1', title: 'شهر آزمون', status: 'ACTIVE' })
    },
    playerGroup: {
      findUnique: jest.fn(async ({ where }: { where: { playerId_groupId: { playerId: string; groupId: string } } }) => {
        const key = `${where.playerId_groupId.playerId}:${where.playerId_groupId.groupId}`
        return playerGroupStore.get(key) ?? null
      }),
      create: jest.fn(async ({ data }: { data: { playerId: string; groupId: string } }) => {
        playerGroupStore.set(`${data.playerId}:${data.groupId}`, { status: 'ACTIVE' })
        return { ...data, status: 'ACTIVE' }
      }),
      update: jest.fn(async ({ where, data }: { where: { playerId_groupId: { playerId: string; groupId: string } }; data: { status: string } }) => {
        const key = `${where.playerId_groupId.playerId}:${where.playerId_groupId.groupId}`
        playerGroupStore.set(key, { status: data.status })
        return { ...data }
      }),
      findMany: jest.fn().mockResolvedValue([])
    },
    migration: { create: jest.fn().mockResolvedValue({}), count: jest.fn().mockResolvedValue(0) },
    loan: { count: jest.fn().mockResolvedValue(0) },
    business: { count: jest.fn().mockResolvedValue(0) },
    $transaction: jest.fn(),
    __store: playerGroupStore,
    ...overrides
  }
}

function makeService(db: ReturnType<typeof makeDb> = makeDb()) {
  const residence = new ResidenceService(
    db as unknown as PrismaClient,
    { recordPlayerEvent: jest.fn().mockResolvedValue(undefined) } as unknown as EventService
  )
  const rewards = { settleReferralResidenceBonus: jest.fn().mockResolvedValue(undefined) }
  const service = new ActivityService(
    db as unknown as PrismaClient,
    residence,
    rewards as unknown as RewardsService
  )
  return { service, db }
}

describe('membership consolidation on real activity', () => {
  test('first real activity in a group creates the local membership', async () => {
    const { service, db } = makeService()

    const result = await service.registerActivity(1n, -100n, 'identity')

    expect(result.playerId).toBe('p1')
    expect(result.groupId).toBe('g1')
    expect(db.playerGroup.create).toHaveBeenCalledTimes(1)
    expect(db.__store.get('p1:g1')).toEqual({ status: 'ACTIVE' })
  })

  test('a LEFT membership reactivates; KICKED stays untouched', async () => {
    const { service, db } = makeService()
    db.__store.set('p1:g1', { status: 'LEFT' })

    await service.registerActivity(1n, -100n, 'banking')

    expect(db.playerGroup.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'ACTIVE' } })
    )

    const kickedDb = makeServiceWithRow('KICKED')
    await kickedDb.service.registerActivity(1n, -100n, 'banking')
    expect(kickedDb.db.playerGroup.update).not.toHaveBeenCalled()
  })

  test('an existing ACTIVE membership is left as-is (no extra writes)', async () => {
    const { service, db } = makeService()
    db.__store.set('p1:g1', { status: 'ACTIVE' })

    await service.registerActivity(1n, -100n, 'banking')

    expect(db.playerGroup.create).not.toHaveBeenCalled()
    expect(db.playerGroup.update).not.toHaveBeenCalled()
  })

  test('dead or banned characters register nothing at all', async () => {
    for (const status of ['DEAD', 'BANNED']) {
      const { service, db } = makeService()
      db.player.findUnique.mockResolvedValue({ id: 'p1', homeGroupId: null, status })

      const result = await service.registerActivity(1n, -100n, 'identity')

      expect(result).toEqual({ residenceEstablished: false })
      expect(db.playerGroup.create).not.toHaveBeenCalled()
      expect(db.player.updateMany).not.toHaveBeenCalled()
    }
  })

  test('activity in an unregistered group still creates nothing', async () => {
    const { service, db } = makeService()
    db.group.findUnique.mockResolvedValue(null)

    const result = await service.registerActivity(1n, -100n, 'identity')

    expect(result).toEqual({ residenceEstablished: false })
    expect(db.playerGroup.create).not.toHaveBeenCalled()
  })
})

function makeServiceWithRow(status: string): ReturnType<typeof makeService> {
  const db = makeDb()
  db.__store.set('p1:g1', { status })
  return makeService(db)
}
