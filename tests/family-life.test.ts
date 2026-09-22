import { FamilyLifeService, FAMILY_ACTIVITY_COST } from '../src/modules/family/family-life.service'
import { ConflictError, ValidationError } from '../src/utils/classes/errors'
import { dayIndex } from '../src/utils/game-time'
import { GIFT_MAX, GIFT_MIN } from '../src/modules/family/family-warmth'

const ME = { id: 'm1', telegramUserId: 10n }
const SPOUSE = { id: 'f1', telegramUserId: 20n }

function spouseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SPOUSE.id,
    firstName: 'سارا',
    lastName: 'م.',
    username: 'sara',
    privacy: 'PUBLIC',
    age: 24,
    startedAt: new Date('2026-01-01T00:00:00Z'),
    currentDegree: 'DIPLOMA',
    graduationField: null,
    balance: { toString: () => '900000' },
    health: 80,
    fatigue: 30,
    lastActivityAt: new Date(),
    homeGroup: { title: 'تهران' },
    ...overrides
  }
}

function marriageRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'g1',
    playerAId: ME.id,
    playerBId: SPOUSE.id,
    mahr: { toString: () => '20000000' },
    marriedAt: new Date(Date.now() - 3 * 86_400_000),
    lastWarmthAt: new Date(),
    lastActivityDayIndex: null,
    lastBonusDayIndex: null,
    ...overrides
  }
}

function makeService(opts: { married?: boolean; balanceGte?: boolean } = {}) {
  const { married = true, balanceGte = true } = opts

  const tx = {
    marriage: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({})
    },
    player: {
      updateMany: jest.fn().mockImplementation(async (args: { where: { balance?: unknown } }) =>
        args.where.balance ? { count: balanceGte ? 1 : 0 } : { count: 1 }
      ),
      update: jest.fn().mockResolvedValue({})
    },
    financialTransaction: { create: jest.fn().mockResolvedValue({ id: 'tx1' }) },
    relationship: {
      findFirst: jest.fn().mockResolvedValue({ strength: 100 }),
      updateMany: jest.fn().mockResolvedValue({ count: 2 })
    },
    gymMembership: { findFirst: jest.fn().mockResolvedValue(null) }
  }

  const db = {
    $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    player: {
      findUnique: jest.fn().mockResolvedValue({ ...ME, balance: { toString: () => '5000000' } }),
      count: jest.fn().mockResolvedValue(0)
    },
    marriage: {
      // آشتی‌دادنِ «ازدواجِ فوت‌شده» پیش از هر خواندن اجرا می‌شود؛ این فیکسچر
      // هیچ ازدواجِ فوت‌شده‌ای ندارد، پس فهرستِ خالی برمی‌گرداند.
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(
        married
          ? marriageRow({
              playerA: spouseRow({ id: ME.id, firstName: 'آرش', fatigue: 40 }),
              playerB: spouseRow()
            })
          : null
      )
    },
    property: { findMany: jest.fn().mockResolvedValue([]) },
    rentalContract: { findFirst: jest.fn().mockResolvedValue(null) },
    relationship: { findFirst: jest.fn().mockResolvedValue({ strength: 100 }) }
  }

  const events = { recordPlayerEvent: jest.fn().mockResolvedValue(undefined) }
  const notify = { notifyPlayerById: jest.fn().mockResolvedValue(true) }
  const service = new FamilyLifeService(db as never, events as never, notify as never)
  return { service, db, tx, events, notify }
}

describe('FamilyLifeService — quality time (shared activity)', () => {
  test('requires an active marriage', async () => {
    const { service } = makeService({ married: false })
    await expect(service.spendTimeTogether(ME.telegramUserId)).rejects.toThrow(ConflictError)
  })

  test('is once per day: the daily lock refuses a second session', async () => {
    const { service, db } = makeService()
    db.marriage.findFirst.mockResolvedValue(
      marriageRow({
        lastActivityDayIndex: dayIndex(),
        playerA: spouseRow({ id: ME.id }),
        playerB: spouseRow()
      })
    )
    await expect(service.spendTimeTogether(ME.telegramUserId)).rejects.toThrow(ConflictError)
  })

  test('needs a recently active spouse — you cannot spend time with an absent partner', async () => {
    const { service, db } = makeService()
    db.marriage.findFirst.mockResolvedValue(
      marriageRow({
        playerA: spouseRow({ id: ME.id }),
        playerB: spouseRow({ lastActivityAt: new Date(Date.now() - 3 * 86_400_000) })
      })
    )
    await expect(service.spendTimeTogether(ME.telegramUserId)).rejects.toThrow(ConflictError)
  })

  test('a lost balance race refuses the spend — no money is minted', async () => {
    const { service, tx } = makeService({ balanceGte: false })
    await expect(service.spendTimeTogether(ME.telegramUserId)).rejects.toThrow(ValidationError)
    // هیچ نوشت اثر جسمی یا گرمایی پس از شکستِ گارد موجودی اجرا نشده
    expect(tx.relationship.updateMany).not.toHaveBeenCalled()
  })

  test('a successful session: sink ledger, both partners recover, warmth rises', async () => {
    const { service, tx, notify } = makeService()
    await service.spendTimeTogether(ME.telegramUserId)

    // قفل روزانه در خود نوشتار است
    expect(tx.marriage.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'g1',
          OR: [{ lastActivityDayIndex: null }, { lastActivityDayIndex: { not: dayIndex() } }]
        }),
        data: { lastActivityDayIndex: dayIndex() }
      })
    )

    // خرج خانواده یک Sink واقعی با نوع اختصاصی خودش است
    expect(tx.financialTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        amount: FAMILY_ACTIVITY_COST,
        type: 'FAMILY_EXPENSE',
        sourcePlayerId: ME.id
      })
    })

    // اثر جسمی برای هر دو همسر: خستگی کمتر، سلامت بیشتر
    const updates = tx.player.update.mock.calls.map((c) => c[0])
    expect(updates).toHaveLength(2)
    const ids = updates.map((u: { where: { id: string } }) => u.where.id).sort()
    expect(ids).toEqual([ME.id, SPOUSE.id].sort())
    for (const u of updates) {
      expect(u.data.fatigue.decrement).toBeGreaterThan(0)
      expect(u.data.health).toBeGreaterThan(0)
    }

    // گرما هر دو طرف رابطه را لمس می‌کند
    expect(tx.relationship.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ strength: expect.any(Number) }) })
    )

    // همسر از اتفاق باخبر می‌شود
    expect(notify.notifyPlayerById).toHaveBeenCalledWith(
      SPOUSE.id,
      expect.any(String),
      expect.any(String),
      undefined,
      expect.stringContaining('family-activity-notify'),
      // وقت مشترک یک روال روزمره است: فقط در تختهٔ اعلان‌ها می‌ماند.
      'INFORMATIONAL'
    )
  })

  test('fatigue relief never goes negative', async () => {
    const { service, db, tx } = makeService()
    db.marriage.findFirst.mockResolvedValue(
      marriageRow({
        playerA: spouseRow({ id: ME.id, fatigue: 3 }),
        playerB: spouseRow({ fatigue: 0 })
      })
    )
    await service.spendTimeTogether(ME.telegramUserId)
    const decrements = tx.player.update.mock.calls.map(
      (c) => (c[0] as { data: { fatigue: { decrement: number } } }).data.fatigue.decrement
    )
    expect(decrements).toEqual([3, 0])
  })
})

describe('FamilyLifeService — gifts', () => {
  test('gift bounds are enforced server-side', async () => {
    const { service } = makeService()
    await expect(service.sendGiftToSpouse(ME.telegramUserId, GIFT_MIN - 1)).rejects.toThrow(ValidationError)
    await expect(service.sendGiftToSpouse(ME.telegramUserId, GIFT_MAX + 1)).rejects.toThrow(ValidationError)
    await expect(service.sendGiftToSpouse(ME.telegramUserId, 1.5)).rejects.toThrow(ValidationError)
  })

  test('a gift is a real transfer: debtor, creditor and one ledger row', async () => {
    const { service, tx } = makeService()
    const res = await service.sendGiftToSpouse(ME.telegramUserId, 1_000_000)
    expect(res.amount).toBe(1_000_000)
    expect(res.warmthGain).toBe(2)

    const debit = (tx.player.updateMany.mock.calls as Array<[never]>).find((c) =>
      (c[0] as { where: { balance?: unknown } }).where.balance
    )
    expect((debit![0] as { where: unknown }).where).toEqual({
      id: ME.id,
      balance: { gte: 1_000_000 }
    })
    expect(tx.player.update).toHaveBeenCalledWith({
      where: { id: SPOUSE.id },
      data: { balance: { increment: 1_000_000 } }
    })
    expect(tx.financialTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        amount: 1_000_000,
        type: 'TRANSFER',
        sourcePlayerId: ME.id,
        destinationPlayerId: SPOUSE.id
      })
    })
  })

  test('cannot gift what you do not have', async () => {
    const { service } = makeService({ balanceGte: false })
    await expect(service.sendGiftToSpouse(ME.telegramUserId, 1_000_000)).rejects.toThrow(ValidationError)
  })

  test('gifting requires a marriage', async () => {
    const { service } = makeService({ married: false })
    await expect(service.sendGiftToSpouse(ME.telegramUserId, 500_000)).rejects.toThrow(ConflictError)
  })
})

describe('FamilyLifeService — family detail view', () => {
  test('an unmarried player gets an honest empty view, not fake data', async () => {
    const { service } = makeService({ married: false })
    const view = await service.getFamilyDetail(ME.telegramUserId)
    expect(view.hasSpouse).toBe(false)
    expect(view.spouse).toBeNull()
    expect(view.warmth).toBeNull()
    expect(view.householdBalance).toBeNull()
  })

  test('spouse identity rows come from the real player record', async () => {
    const { service } = makeService()
    const view = await service.getFamilyDetail(ME.telegramUserId)
    expect(view.hasSpouse).toBe(true)
    expect(view.spouse?.name).toBe('سارا م.')
    expect(view.spouse?.username).toBe('sara')
    expect(view.spouse?.regionTitle).toBe('تهران')
    expect(view.warmth).toBe(100)
    expect(view.bonusMultiplier).toBe(1)
    expect(view.activityCost).toBe(FAMILY_ACTIVITY_COST)
  })

  test('a private spouse profile hides username and balance', async () => {
    const { service, db } = makeService()
    db.marriage.findFirst.mockResolvedValue(
      marriageRow({
        playerA: spouseRow({ id: ME.id }),
        playerB: spouseRow({ privacy: 'PRIVATE' })
      })
    )
    const view = await service.getFamilyDetail(ME.telegramUserId)
    expect(view.spouse?.username).toBeNull()
    expect(view.spouseBalance?.visible).toBe(false)
    expect(view.householdBalance).toBeNull()
  })

  test('the shared home reflects real housing: own, rented or spouse-owned', async () => {
    const { service, db } = makeService()
    db.property.findMany
      .mockResolvedValueOnce([{ title: 'آپارتمان ۶۰ متری' }])
      .mockResolvedValueOnce([])
    const owned = await service.getFamilyDetail(ME.telegramUserId)
    expect(owned.myHome).toBe('آپارتمان ۶۰ متری')
    expect(owned.sharedHome).toBe('آپارتمان ۶۰ متری')

    db.property.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([{ title: 'ویلای همسر' }])
    db.rentalContract.findFirst.mockResolvedValue({
      property: { title: 'خانهٔ اجاره‌ای' }
    })
    const rented = await service.getFamilyDetail(ME.telegramUserId)
    expect(rented.myHome).toBe('خانهٔ اجاره‌ای (اجاره‌ای)')
    expect(rented.spouseHome).toBe('ویلای همسر')
  })
})
