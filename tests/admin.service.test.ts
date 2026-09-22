import { BotAdminRole, PlayerStatus, PrismaClient } from '@prisma/client'
import {
  ADMIN_FIELD_LIMITS,
  AdminService,
  BOOTSTRAP_ADMINS
} from '../src/modules/admin/admin.service'
import {
  ConflictError,
  NotFoundError,
  UnauthorizedError,
  ValidationError
} from '../src/utils/classes/errors'

const OWNER_ID = 6910416744n
const ADMIN_ID = 8369939024n
const STRANGER_ID = 123n
const TARGET_ID = 999n

const PLAYER_ROW = {
  id: 'p1',
  balance: 1_000_000n,
  health: 80,
  fatigue: 20,
  experience: 10,
  status: PlayerStatus.ACTIVE,
  activityState: 'WORKING',
  isEnrolled: false,
  enrolledFieldKey: null,
  streakCount: 3,
  currentDegree: 'BACHELOR'
}

/**
 * یک Prisma ماک که tx و db را از همان mockها می‌سازد تا بشود دقیقاً دید
 * کدام نوشتار داخل تراکنش انجام شده است.
 */
function makeDb() {
  const tx = {
    $queryRaw: jest.fn().mockImplementation((_query, actor: bigint) => Promise.resolve([
      { role: actor === OWNER_ID ? BotAdminRole.OWNER : BotAdminRole.ADMIN, isActive: true }
    ])),
    player: {
      findUnique: jest.fn().mockResolvedValue(PLAYER_ROW),
      update: jest.fn().mockResolvedValue(PLAYER_ROW),
      updateMany: jest.fn().mockResolvedValue({ count: 1 })
    },
    botAdmin: {
      upsert: jest.fn().mockImplementation(({ create }: { create: object }) => Promise.resolve(create)),
      updateMany: jest.fn().mockResolvedValue({ count: 1 })
    },
    playerSkill: {
      findFirst: jest.fn().mockResolvedValue({ id: 'sk1', level: 2, skill: { name: 'آشپزی' } }),
      update: jest.fn().mockResolvedValue({})
    },
    workSession: {
      findFirst: jest
        .fn()
        .mockResolvedValue({ id: 'w1', jobTitle: 'نانوایی', jobKey: 'bakery' }),
      findMany: jest.fn().mockResolvedValue([{ jobKey: 'bakery' }]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 })
    },
    financialTransaction: { create: jest.fn().mockResolvedValue({}) },
    adminLog: { create: jest.fn().mockResolvedValue({}) },
    $executeRaw: jest.fn().mockResolvedValue(1)
  }

  const db = {
    botAdmin: {
      // OWNER برای ادمین اصلی، ADMIN برای ادمین دوم، هیچ‌کس برای غریبه
      findUnique: jest.fn().mockImplementation(({ where }: { where: { telegramUserId: bigint } }) => {
        if (where.telegramUserId === OWNER_ID) {
          return Promise.resolve({
            telegramUserId: OWNER_ID,
            role: BotAdminRole.OWNER,
            isActive: true,
            firstName: 'اصلی'
          })
        }
        if (where.telegramUserId === ADMIN_ID) {
          return Promise.resolve({
            telegramUserId: ADMIN_ID,
            role: BotAdminRole.ADMIN,
            isActive: true,
            firstName: 'دوم'
          })
        }
        return Promise.resolve(null)
      }),
      upsert: tx.botAdmin.upsert,
      count: jest.fn().mockResolvedValue(2),
      findMany: jest.fn().mockResolvedValue([])
    },
    player: {
      count: jest.fn().mockResolvedValue(10),
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([])
    },
    group: { count: jest.fn().mockResolvedValue(2) },
    business: { count: jest.fn().mockResolvedValue(3) },
    bankAccount: { count: jest.fn().mockResolvedValue(8) },
    property: { count: jest.fn().mockResolvedValue(4) },
    loan: { count: jest.fn().mockResolvedValue(1) },
    financialTransaction: {
      aggregate: jest.fn().mockResolvedValue({ _sum: { amount: 5_000n } }),
      create: tx.financialTransaction.create
    },
    adminLog: {
      count: jest.fn().mockResolvedValue(4),
      create: tx.adminLog.create,
      findMany: jest.fn().mockResolvedValue([])
    },
    playerSkill: tx.playerSkill,
    workSession: tx.workSession,
    $executeRaw: tx.$executeRaw,
    $transaction: jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx))
  }

  return { db, tx }
}

function makeService() {
  const { db, tx } = makeDb()
  const service = new AdminService(db as unknown as PrismaClient)
  return { service, db, tx }
}

describe('Admin authorization comes from the database', () => {
  test('the seeded admins are exactly the two fixed IDs, one of them the owner', () => {
    expect(BOOTSTRAP_ADMINS).toEqual([
      { telegramUserId: 6910416744n, role: BotAdminRole.OWNER },
      { telegramUserId: 8369939024n, role: BotAdminRole.ADMIN }
    ])
  })

  test('isAdmin reads the bot_admins table, not an env list', async () => {
    const { service, db } = makeService()
    await expect(service.isAdmin(OWNER_ID)).resolves.toBe(true)
    await expect(service.isAdmin(ADMIN_ID)).resolves.toBe(true)
    await expect(service.isAdmin(STRANGER_ID)).resolves.toBe(false)
    expect(db.botAdmin.findUnique).toHaveBeenCalledWith({ where: { telegramUserId: STRANGER_ID } })
  })

  test('a deactivated admin loses access immediately', async () => {
    const { service, db } = makeService()
    db.botAdmin.findUnique.mockResolvedValue({
      telegramUserId: ADMIN_ID,
      role: BotAdminRole.ADMIN,
      isActive: false
    })
    await expect(service.isAdmin(ADMIN_ID)).resolves.toBe(false)
    await expect(service.getDashboardMetrics(ADMIN_ID)).rejects.toThrow(UnauthorizedError)
  })

  test('non-admin users are refused by every guarded method', async () => {
    const { service, db } = makeService()
    await expect(service.getDashboardMetrics(STRANGER_ID)).rejects.toThrow(UnauthorizedError)
    await expect(service.listPlayers(STRANGER_ID)).rejects.toThrow(UnauthorizedError)
    await expect(service.listGroups(STRANGER_ID)).rejects.toThrow(UnauthorizedError)
    await expect(service.adjustBalance(STRANGER_ID, TARGET_ID, 1000)).rejects.toThrow(
      UnauthorizedError
    )
    // هیچ نوشتاری در دیتابیس اتفاق نمی‌افتد
    expect(db.$transaction).not.toHaveBeenCalled()
  })

  test('admin management is owner-only', async () => {
    const { service } = makeService()
    await expect(service.listAdmins(ADMIN_ID)).rejects.toThrow(UnauthorizedError)
    await expect(service.addAdmin(ADMIN_ID, { telegramUserId: 555n })).rejects.toThrow(
      UnauthorizedError
    )
    await expect(service.removeAdmin(ADMIN_ID, 555n)).rejects.toThrow(UnauthorizedError)
  })
})

describe('Admin registry operations', () => {
  test('bootstrap is idempotent and never overwrites an existing row', async () => {
    const { service, db } = makeService()
    await service.bootstrap()
    await service.bootstrap()

    expect(db.botAdmin.upsert).toHaveBeenCalledTimes(BOOTSTRAP_ADMINS.length * 2)
    for (const [call] of db.botAdmin.upsert.mock.calls) {
      const arg = call as { update: unknown; create: { role: BotAdminRole; isActive: boolean } }
      // update خالی است: ادمینِ حذف‌شده با Bootstrap برنمی‌گردد
      expect(arg.update).toEqual({})
      expect(arg.create.isActive).toBe(true)
    }
  })

  test('adding an admin is logged', async () => {
    const { service, db } = makeService()
    const saved = await service.addAdmin(OWNER_ID, {
      telegramUserId: 555n,
      firstName: 'نگار',
      username: 'negar'
    })

    expect(saved).toMatchObject({
      telegramUserId: 555n,
      role: BotAdminRole.ADMIN,
      isActive: true,
      grantedBy: OWNER_ID
    })
    expect(db.adminLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'admin_add',
        actorUserId: OWNER_ID,
        targetUserId: 555n
      })
    })
  })

  test('an already-active admin cannot be added twice', async () => {
    const { service, db } = makeService()
    await expect(service.addAdmin(OWNER_ID, { telegramUserId: ADMIN_ID })).rejects.toThrow(
      ConflictError
    )
    expect(db.$transaction).not.toHaveBeenCalled()
  })

  test('removing an admin keeps the player data and is written to the audit log', async () => {
    const { service, db, tx } = makeService()

    const result = await service.removeAdmin(OWNER_ID, ADMIN_ID)

    // فقط isActive خاموش می‌شود؛ هیچ نوشتاری روی players اتفاق نمی‌افتد
    expect(tx.botAdmin.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ telegramUserId: ADMIN_ID, isActive: true }),
        data: { isActive: false }
      })
    )
    expect(tx.player.update).not.toHaveBeenCalled()
    expect(tx.player.updateMany).not.toHaveBeenCalled()
    expect(tx.player.findUnique).not.toHaveBeenCalled()
    expect(db.adminLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'admin_remove',
        targetUserId: ADMIN_ID,
        details: { keptPlayerData: true }
      })
    })
    expect(result.removedName).toBe('دوم')
  })

  test('the owner can never be removed', async () => {
    const { service, tx } = makeService()
    await expect(service.removeAdmin(OWNER_ID, OWNER_ID)).rejects.toThrow(ConflictError)
    expect(tx.botAdmin.updateMany).not.toHaveBeenCalled()
    expect(tx.adminLog.create).not.toHaveBeenCalled()
  })

  test('a non-owner cannot remove anyone, not even through a stale callback', async () => {
    const { service, tx } = makeService()
    await expect(service.removeAdmin(ADMIN_ID, ADMIN_ID)).rejects.toThrow(UnauthorizedError)
    await expect(service.removeAdmin(STRANGER_ID, ADMIN_ID)).rejects.toThrow(UnauthorizedError)
    expect(tx.botAdmin.updateMany).not.toHaveBeenCalled()
  })

  test('removing an unknown admin is a NotFoundError', async () => {
    const { service } = makeService()
    await expect(service.removeAdmin(OWNER_ID, 4242n)).rejects.toThrow(NotFoundError)
  })
})

describe('Player edits are validated, atomic and logged', () => {
  test('adding balance writes a conditional update so a concurrent change loses', async () => {
    const { service, db, tx } = makeService()

    const result = await service.adjustBalance(OWNER_ID, TARGET_ID, 500_000)

    expect(result).toEqual({ before: 1_000_000, after: 1_500_000 })
    expect(tx.player.updateMany).toHaveBeenCalledWith({
      where: { telegramUserId: TARGET_ID, balance: PLAYER_ROW.balance },
      data: { balance: 1_500_000 }
    })
    expect(db.adminLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'balance_add',
        targetUserId: TARGET_ID,
        details: { delta: 500_000, before: 1_000_000, after: 1_500_000 }
      })
    })
  })

  test('subtracting balance takes the negative delta path and logs balance_remove', async () => {
    const { service, db, tx } = makeService()

    const result = await service.adjustBalance(OWNER_ID, TARGET_ID, -400_000)

    expect(result).toEqual({ before: 1_000_000, after: 600_000 })
    expect(tx.financialTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        amount: 400_000,
        sourcePlayerId: 'p1',
        destinationPlayerId: undefined
      })
    })
    expect(db.adminLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'balance_remove' })
    })
  })

  test('a concurrent balance change aborts the whole adjustment', async () => {
    const { service, tx } = makeService()
    tx.player.updateMany.mockResolvedValue({ count: 0 })
    await expect(service.adjustBalance(OWNER_ID, TARGET_ID, 500_000)).rejects.toThrow(ConflictError)
  })

  test('the result may never leave the allowed balance range', async () => {
    const { service, tx } = makeService()
    await expect(
      service.adjustBalance(OWNER_ID, TARGET_ID, -2_000_000)
    ).rejects.toThrow(ValidationError)
    expect(tx.player.updateMany).not.toHaveBeenCalled()
  })

  test.each([
    [0],
    [-0.5],
    [1.5],
    [Number.MAX_SAFE_INTEGER + 1],
    [ADMIN_FIELD_LIMITS.balance.max + 1],
    [-(ADMIN_FIELD_LIMITS.balance.max + 1)]
  ])('amount %p is refused before touching the database', async (amount) => {
    const { service, db } = makeService()
    await expect(service.adjustBalance(OWNER_ID, TARGET_ID, amount)).rejects.toThrow(
      ValidationError
    )
    expect(db.$transaction).not.toHaveBeenCalled()
  })

  test('a missing player is a NotFoundError, never a crash', async () => {
    const { service, tx } = makeService()
    tx.player.findUnique.mockResolvedValue(null)
    await expect(service.adjustBalance(OWNER_ID, TARGET_ID, 1000)).rejects.toThrow(NotFoundError)
    await expect(service.setField(OWNER_ID, TARGET_ID, 'health', 10)).rejects.toThrow(NotFoundError)
    await expect(service.resetState(OWNER_ID, TARGET_ID)).rejects.toThrow(NotFoundError)
  })

  test.each([
    // سقف سلامتِ واقعی (عضو باشگاه = ۱۲۰)؛ پس ۱۰۱ معتبر است و مرز، سقف+۱ است
    ['health', ADMIN_FIELD_LIMITS.health.max + 1],
    ['health', -1],
    ['fatigue', 101],
    ['fatigue', 50.5],
    ['experience', ADMIN_FIELD_LIMITS.experience.max + 1]
  ] as Array<[keyof typeof ADMIN_FIELD_LIMITS, number]>)(
    'setField(%s, %p) is refused before touching the database',
    async (field, value) => {
      const { service, db, tx } = makeService()
      await expect(service.setField(OWNER_ID, TARGET_ID, field, value)).rejects.toThrow(
        ValidationError
      )
      expect(db.$transaction).not.toHaveBeenCalled()
      expect(tx.player.update).not.toHaveBeenCalled()
    }
  )

  test('setField stores in-range values as-is and logs before/after', async () => {
    const { service, db } = makeService()
    const result = await service.setField(OWNER_ID, TARGET_ID, 'health', 42)
    expect(result).toEqual({ before: 80, after: 42 })
    expect(db.adminLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'set_health',
        targetUserId: TARGET_ID,
        details: { before: 80, after: 42 }
      })
    })
  })

  test('an invalid account status never reaches the database', async () => {
    const { service, tx } = makeService()
    await expect(
      service.setAccountStatus(OWNER_ID, TARGET_ID, 'HACKED' as PlayerStatus)
    ).rejects.toThrow(ValidationError)
    expect(tx.player.update).not.toHaveBeenCalled()
  })

  test('banning also stops the activity, unrolls education and closes the shift', async () => {
    const { service, db, tx } = makeService()
    await service.setAccountStatus(OWNER_ID, TARGET_ID, PlayerStatus.BANNED)

    expect(tx.player.update).toHaveBeenCalledWith({
      where: { id: 'p1' },
      data: { status: PlayerStatus.BANNED, activityState: 'IDLE', isEnrolled: false, enrolledFieldKey: null, targetDegree: null, studyStartedAt: null, restStartedAt: null }
    })
    // نوبت کاری فعال همان‌جا بسته می‌شود و ظرفیت شغل آزاد می‌گردد
    expect(tx.workSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { playerId: 'p1', status: 'ACTIVE' },
        data: expect.objectContaining({ status: 'CANCELLED' })
      })
    )
    expect(tx.$executeRaw).toHaveBeenCalled()
    expect(db.adminLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'set_account_status',
        details: { before: PlayerStatus.ACTIVE, after: PlayerStatus.BANNED }
      })
    })
  })

  test('re-activating a player never touches their work session', async () => {
    const { service, tx } = makeService()
    await service.setAccountStatus(OWNER_ID, TARGET_ID, PlayerStatus.ACTIVE)
    expect(tx.workSession.updateMany).not.toHaveBeenCalled()
  })

  test('state reset frees the job slot of the shift it cancels', async () => {
    const { service, db, tx } = makeService()
    await service.resetState(OWNER_ID, TARGET_ID)

    expect(tx.workSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { playerId: 'p1', status: 'ACTIVE' },
        data: expect.objectContaining({ status: 'CANCELLED' })
      })
    )
    expect(tx.$executeRaw).toHaveBeenCalled()
    expect(db.adminLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'reset_state' })
    })
  })

  test('stopping work closes the shift, frees the job slot and idles the player', async () => {
    const { service, db, tx } = makeService()
    const result = await service.stopActiveWork(OWNER_ID, TARGET_ID)

    expect(result).toEqual({ jobTitle: 'نانوایی' })
    expect(tx.workSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'w1', status: 'ACTIVE' },
        data: expect.objectContaining({ status: 'CANCELLED' })
      })
    )
    expect(tx.player.updateMany).toHaveBeenCalledWith({
      where: { id: 'p1', activityState: 'WORKING' },
      data: { activityState: 'IDLE' }
    })
    expect(db.adminLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'stop_work' })
    })
  })

  test('stopping work on an idle player is a conflict, not a silent success', async () => {
    const { service, tx } = makeService()
    tx.workSession.findFirst.mockResolvedValue(null)
    await expect(service.stopActiveWork(OWNER_ID, TARGET_ID)).rejects.toThrow(ConflictError)
  })

  test('stopping education on a non-student is refused', async () => {
    const { service } = makeService()
    await expect(service.stopEducation(OWNER_ID, TARGET_ID)).rejects.toThrow(ConflictError)
  })

  test('skill level is bounded by the same limits the panel shows', async () => {
    const { service, db, tx } = makeService()
    await expect(service.setSkillLevel(OWNER_ID, TARGET_ID, 'sk1', 0)).rejects.toThrow(
      ValidationError
    )
    await expect(
      service.setSkillLevel(OWNER_ID, TARGET_ID, 'sk1', ADMIN_FIELD_LIMITS.skillLevel.max + 1)
    ).rejects.toThrow(ValidationError)
    expect(db.$transaction).not.toHaveBeenCalled()

    await service.setSkillLevel(OWNER_ID, TARGET_ID, 'sk1', 7)
    expect(tx.playerSkill.update).toHaveBeenCalledWith({ where: { id: 'sk1' }, data: { level: 7 } })
  })

  test('a skill belonging to another player cannot be edited through its id', async () => {
    const { service, tx } = makeService()
    tx.playerSkill.findFirst.mockResolvedValue(null)
    await expect(service.setSkillLevel(OWNER_ID, TARGET_ID, 'sk1', 5)).rejects.toThrow(
      NotFoundError
    )
  })
})

describe('Dashboard metrics', () => {
  test('economy volume is summed in the database, not by reading rows', async () => {
    const { service, db } = makeService()
    const metrics = await service.getDashboardMetrics(OWNER_ID)

    expect(metrics).toMatchObject({
      totalPlayers: 10,
      totalEconomyVolume: 5000,
      totalAdmins: 2,
      totalGroups: 2,
      adminLogCount: 4
    })
    expect(db.financialTransaction.aggregate).toHaveBeenCalledWith({ _sum: { amount: true } })
    expect(db.player.findMany).not.toHaveBeenCalled()
  })
})

describe('Admin list is paginated so the panel fits Telegram', () => {
  test('listAdmins bounds the page instead of returning every row', async () => {
    const { service, db } = makeService()
    db.botAdmin.findMany.mockResolvedValue([])

    const result = await service.listAdmins(OWNER_ID, 0)

    expect(result).toMatchObject({ total: 2, page: 0, pageSize: 10 })
    expect(db.botAdmin.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 0, take: 10 })
    )
  })

  test('page 2 skips a full page', async () => {
    const { service, db } = makeService()
    await service.listAdmins(OWNER_ID, 2)
    expect(db.botAdmin.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 20, take: 10 })
    )
  })

  test('a negative or fractional page cannot produce a negative skip', async () => {
    const { service, db } = makeService()
    await service.listAdmins(OWNER_ID, -3)
    expect(db.botAdmin.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 0 })
    )
  })

  test('one page of admins stays well under the 4096-character Telegram limit', async () => {
    // هر ادمین چهار خط می‌گیرد؛ سقف تلگرام ۴۰۹۶ نویسه است
    const { service, db } = makeService()
    db.botAdmin.findMany.mockResolvedValue(
      Array.from({ length: 10 }, (_, i) => ({
        id: `a${i}`,
        telegramUserId: BigInt(6_900_000_000 + i),
        firstName: 'کاربر آزمایشی با نام نسبتاً طولانی',
        username: 'sample_user',
        role: BotAdminRole.ADMIN,
        isActive: true,
        createdAt: new Date('2026-09-01T00:00:00Z'),
        updatedAt: new Date('2026-09-01T00:00:00Z'),
        grantedBy: null
      }))
    )
    db.player.findMany.mockResolvedValue([])

    const result = await service.listAdmins(OWNER_ID, 0)
    const chars = result.items.reduce(
      (acc, row) => acc + (row.playerName ?? row.admin.firstName ?? '').length + 80,
      0
    )
    expect(result.items.length).toBeLessThanOrEqual(10)
    expect(chars).toBeLessThan(4096)
  })
})

describe('Administrative privilege and concurrency regressions', () => {
  test('an OWNER role on the secondary ID still cannot manage admins', async () => {
    const { service, db } = makeService()
    db.botAdmin.findUnique.mockResolvedValue({ telegramUserId: ADMIN_ID, role: BotAdminRole.OWNER, isActive: true, firstName: 'ثانویه' })
    expect(await service.isOwner(ADMIN_ID)).toBe(false)
    await expect(service.addAdmin(ADMIN_ID, { telegramUserId: TARGET_ID })).rejects.toBeInstanceOf(UnauthorizedError)
    await expect(service.removeAdmin(ADMIN_ID, OWNER_ID)).rejects.toBeInstanceOf(UnauthorizedError)
  })

  test('main ID cannot be removed even if its stored role is wrong', async () => {
    const { service, db, tx } = makeService()
    db.botAdmin.findUnique.mockResolvedValueOnce({ telegramUserId: OWNER_ID, role: BotAdminRole.OWNER, isActive: true, firstName: 'اصلی' })
      .mockResolvedValueOnce({ telegramUserId: OWNER_ID, role: BotAdminRole.ADMIN, isActive: true, firstName: 'اصلی' })
    await expect(service.removeAdmin(OWNER_ID, OWNER_ID)).rejects.toBeInstanceOf(ConflictError)
    expect(tx.botAdmin.updateMany).not.toHaveBeenCalled()
  })

  test('privilege revoked between preflight and transaction prevents the write', async () => {
    const { service, tx } = makeService()
    tx.$queryRaw.mockResolvedValue([])
    await expect(service.adjustBalance(ADMIN_ID, TARGET_ID, 500)).rejects.toBeInstanceOf(UnauthorizedError)
    expect(tx.player.updateMany).not.toHaveBeenCalled()
    expect(tx.adminLog.create).not.toHaveBeenCalled()
  })

  test('a concurrently closed shift never releases another player slot', async () => {
    const { service, tx } = makeService()
    tx.workSession.updateMany.mockResolvedValue({ count: 0 })
    await service.resetState(ADMIN_ID, TARGET_ID)
    expect(tx.$executeRaw).not.toHaveBeenCalled()
  })

  test('invalid field is a validation error, not an internal TypeError', async () => {
    const { service } = makeService()
    await expect(service.setField(OWNER_ID, TARGET_ID, 'sql' as never, 10)).rejects.toBeInstanceOf(ValidationError)
  })

  test('search by Persian numeric ID uses the exact Telegram identifier', async () => {
    const { service, db } = makeService()
    await service.listPlayers(OWNER_ID, 0, '۸۳۶۹۹۳۹۰۲۴')
    expect(db.player.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { telegramUserId: ADMIN_ID } }))
  })
})
