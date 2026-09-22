import { SkillService } from '../src/modules/skills/skill.service'
import { ConflictError, NotFoundError, ValidationError } from '../src/utils/classes/errors'
import { trainingSessionCost, TRAINING_FATIGUE } from '../src/modules/skills/skill-training'

const PLAYER = {
  id: 'p1',
  telegramUserId: 10n,
  status: 'ACTIVE',
  activityState: 'IDLE',
  balance: 5_000_000,
  fatigue: 20
}

function makeService(opts: { skillRow?: Record<string, unknown> | null; sessionsToday?: number; balanceGte?: boolean } = {}) {
  const { skillRow = null, sessionsToday = 0, balanceGte = true } = opts

  const tx = {
    player: {
      updateMany: jest.fn().mockImplementation(async (args: { where: { balance?: unknown } }) =>
        args.where.balance ? { count: balanceGte ? 1 : 0 } : { count: 1 }
      ),
      update: jest.fn().mockResolvedValue({})
    },
    playerSkill: { upsert: jest.fn().mockResolvedValue({}) },
    financialTransaction: { create: jest.fn().mockResolvedValue({}) }
  }

  const db = {
    $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    playerSkill: { findUnique: jest.fn().mockResolvedValue(skillRow) },
    financialTransaction: {
      count: jest.fn().mockResolvedValue(sessionsToday),
      findMany: jest.fn().mockResolvedValue([])
    },
    skill: {
      findUnique: jest.fn().mockResolvedValue({ id: 'sk1', name: 'برنامه‌نویسی', description: '', category: 'technical' }),
      findMany: jest.fn().mockResolvedValue([])
    }
  }

  const skillRepo = {
    list: jest.fn().mockResolvedValue([]),
    findByName: jest.fn(),
    findById: jest.fn().mockResolvedValue({ id: 'sk1', name: 'برنامه‌نویسی', description: '', category: 'technical' }),
    findIdsByNames: jest.fn().mockResolvedValue(new Map())
  }
  const playerSkillRepo = {
    listByPlayerId: jest.fn().mockResolvedValue([]),
    assign: jest.fn(),
    awardLevel: jest.fn(),
    addPracticePoints: jest.fn(),
    averageLevelForSkillNames: jest.fn()
  }
  const playerRepo = {
    findByTelegramUserId: jest.fn().mockResolvedValue(PLAYER)
  }

  const service = new SkillService(skillRepo as never, playerSkillRepo as never, playerRepo as never, db as never)
  return { service, db, tx, skillRepo, playerSkillRepo, playerRepo }
}

describe('SkillService.trainSkill — guards', () => {
  test('unknown skills cannot be trained', async () => {
    const { service, skillRepo } = makeService()
    skillRepo.findById.mockResolvedValue(null)
    await expect(service.trainSkill(PLAYER.telegramUserId, 'nope')).rejects.toThrow(NotFoundError)
  })

  test('a maxed skill refuses training — no sink without effect', async () => {
    const { service } = makeService({ skillRow: { level: 10, points: 500 } })
    await expect(service.trainSkill(PLAYER.telegramUserId, 'sk1')).rejects.toThrow(ConflictError)
  })

  test('training needs energy: too much fatigue is refused', async () => {
    const { service, playerRepo } = makeService()
    playerRepo.findByTelegramUserId.mockResolvedValue({ ...PLAYER, fatigue: 95 })
    await expect(service.trainSkill(PLAYER.telegramUserId, 'sk1')).rejects.toThrow(ValidationError)
  })

  test('the daily budget is counted from the real ledger, not a counter', async () => {
    const { service, db } = makeService({ sessionsToday: 4 })
    await expect(service.trainSkill(PLAYER.telegramUserId, 'sk1')).rejects.toThrow(ConflictError)
    expect(db.financialTransaction.count).toHaveBeenCalledWith({
      where: expect.objectContaining({ type: 'SKILL_TRAINING', sourcePlayerId: PLAYER.id })
    })
  })

  test('cannot train while a work shift is running', async () => {
    const { service, playerRepo } = makeService()
    playerRepo.findByTelegramUserId.mockResolvedValue({ ...PLAYER, activityState: 'WORKING' })
    await expect(service.trainSkill(PLAYER.telegramUserId, 'sk1')).rejects.toThrow(ConflictError)
  })
})

describe('SkillService.trainSkill — the transaction', () => {
  test('a session: money sink, points, fatigue and one ledger row', async () => {
    const { service, db, tx } = makeService({ skillRow: { level: 2, points: 10 } })
    const res = await service.trainSkill(PLAYER.telegramUserId, 'sk1')

    expect(res.skillName).toBe('برنامه‌نویسی')
    expect(res.points).toBe(22)
    expect(res.level).toBe(2)
    expect(res.leveledUp).toBe(false)

    // هزینه از فرمول عمومی می‌آید تا پنل و سرویس هرگز واگرا نشوند
    expect(res.cost).toBe(trainingSessionCost(2, 0))

    const debit = (tx.player.updateMany.mock.calls as Array<[never]>)[0]![0] as {
      where: unknown
    }
    expect(debit.where).toEqual({ id: PLAYER.id, balance: { gte: res.cost } })

    expect(tx.playerSkill.upsert).toHaveBeenCalledWith({
      where: { playerId_skillId: { playerId: PLAYER.id, skillId: 'sk1' } },
      create: expect.objectContaining({ points: 22, level: 2 }),
      update: expect.objectContaining({ points: 22, level: 2 })
    })

    expect(tx.player.update).toHaveBeenCalledWith({
      where: { id: PLAYER.id },
      data: { fatigue: PLAYER.fatigue + TRAINING_FATIGUE }
    })

    expect(tx.financialTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ type: 'SKILL_TRAINING', amount: res.cost })
    })
    expect(db.$transaction).toHaveBeenCalledTimes(1)
  })

  test('crossing the level boundary reports the level-up', async () => {
    const { service } = makeService({ skillRow: { level: 1, points: 42 } })
    const res = await service.trainSkill(PLAYER.telegramUserId, 'sk1')
    expect(res.level).toBe(2)
    expect(res.leveledUp).toBe(true)
    expect(res.pointsToNext).toBe(50 - 4) // 54 امتیاز = ۴ امتیاز در سطح ۲
  })

  test('a lost balance race fails cleanly with nothing written', async () => {
    const { service, tx } = makeService({ balanceGte: false })
    await expect(service.trainSkill(PLAYER.telegramUserId, 'sk1')).rejects.toThrow(ValidationError)
    expect(tx.playerSkill.upsert).not.toHaveBeenCalled()
    expect(tx.financialTransaction.create).not.toHaveBeenCalled()
  })

  test('same-day escalation uses the ledger count', async () => {
    const { service } = makeService({ sessionsToday: 2 })
    const res = await service.trainSkill(PLAYER.telegramUserId, 'sk1')
    expect(res.cost).toBe(trainingSessionCost(1, 2))
  })
})

describe('SkillService.getTrainingOverview', () => {
  test('shows real consumption: where each skill is actually used', async () => {
    const { service, skillRepo, playerSkillRepo } = makeService()
    skillRepo.list.mockResolvedValue([
      { id: 'sk1', name: 'برنامه‌نویسی', description: '', category: 'technical' },
      { id: 'sk2', name: 'ارتباطات', description: '', category: 'communication' }
    ])
    playerSkillRepo.listByPlayerId.mockResolvedValue([
      { skillId: 'sk1', level: 3, points: 20 }
    ])

    const overview = await service.getTrainingOverview(PLAYER.telegramUserId)
    expect(overview.skills).toHaveLength(2)

    const programming = overview.skills.find((s) => s.name === 'برنامه‌نویسی')!
    expect(programming.level).toBe(3)
    expect(programming.maxed).toBe(false)
    expect(programming.nextSessionCost).toBe(trainingSessionCost(3, 0))
    // مصرف واقعی: «برنامه‌نویسی» در کاتالوگ مشاغل/کسب‌وکارها استفاده می‌شود
    expect(programming.usedInJobs.length + programming.usedInBusinesses.length).toBeGreaterThan(0)

    const untrained = overview.skills.find((s) => s.name === 'ارتباطات')!
    expect(untrained.level).toBe(1)
    expect(untrained.points).toBe(0)
  })
})
