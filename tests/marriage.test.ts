import {
  Gender,
  MaritalStatus,
  PlayerStatus,
  PrismaClient
} from '@prisma/client'
import { MarriageService, DIVORCE_COST } from '../src/modules/family/marriage.service'
import {
  MAHR_RULES,
  describeMahr,
  mahrRangeError,
  normalizeMahrOffer,
  parseMahrInput
} from '../src/modules/family/mahr'
import { ConflictError, NotFoundError, ValidationError } from '../src/utils/classes/errors'

const MALE = {
  id: 'm1',
  telegramUserId: 10n,
  firstName: 'آرش',
  lastName: 'ک.',
  gender: Gender.MALE,
  maritalStatus: MaritalStatus.SINGLE,
  status: PlayerStatus.ACTIVE
}
const FEMALE = {
  id: 'f1',
  telegramUserId: 20n,
  firstName: 'سارا',
  lastName: 'م.',
  gender: Gender.FEMALE,
  maritalStatus: MaritalStatus.SINGLE,
  status: PlayerStatus.ACTIVE
}

function makeService() {
  const tx = {
    marriageProposal: {
      findUnique: jest.fn().mockResolvedValue(null),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      // گارد «یک پیشنهاد باز» حالا داخل تراکنش Serializable اجرا می‌شود
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockResolvedValue({ id: 'p1' })
    },
    player: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({})
    },
    financialTransaction: { create: jest.fn().mockResolvedValue({}) },
    marriage: {
      create: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 })
    },
    relationship: {
      upsert: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 2 })
    }
  }
  const db = {
    $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    player: {
      findUnique: jest.fn().mockResolvedValue({ id: 'f1' }),
      findMany: jest.fn().mockResolvedValue([MALE, FEMALE])
    },
    marriageProposal: {
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockResolvedValue({ id: 'p1' }),
      findUnique: jest.fn().mockResolvedValue(null),
      findUniqueOrThrow: jest.fn().mockResolvedValue({ proposerId: 'm1' }),
      findFirst: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 })
    },
    marriage: {
      // هیچ ازدواجِ فوت‌شده‌ای در این فیکسچر نیست؛ فقط مسیرِ آشتی‌دادن باید
      // بدون اثر اجرا شود.
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null)
    }
  }
  const events = { recordPlayerEvent: jest.fn().mockResolvedValue(undefined) }
  const notify = { notifyPlayerById: jest.fn().mockResolvedValue(true) }
  const service = new MarriageService(
    db as unknown as PrismaClient,
    events as never,
    notify as never
  )
  return { service, db, tx, events, notify }
}

describe('MarriageService — propose gatekeeping', () => {
  test('rejects a proposal to oneself', async () => {
    const { service } = makeService()
    await expect(service.propose(10n, 10n, 1_000_000)).rejects.toThrow(ValidationError)
  })

  test('rejects amounts beyond the overflow guard before any DB touch', async () => {
    const { service, db } = makeService()
    await expect(service.propose(10n, 20n, 2_000_000_000_000)).rejects.toThrow(ValidationError)
    expect(db.marriageProposal.count).not.toHaveBeenCalled()
  })

  test('the game sets no artificial floor: any positive whole toman is a valid mahr', async () => {
    const { service, tx } = makeService()
    await service.propose(10n, 20n, 1)
    expect(tx.marriageProposal.create).toHaveBeenCalledWith({
      data: { proposerId: 'm1', targetId: 'f1', mahr: 1 }
    })
  })

  test('rejects negative and non-integer mahr (zero is «unset», not an amount)', async () => {
    const { service } = makeService()
    await expect(service.propose(10n, 20n, -500_000)).rejects.toThrow(ValidationError)
    await expect(service.propose(10n, 20n, 500_000.5)).rejects.toThrow(ValidationError)
    await expect(service.propose(10n, 20n, MAHR_RULES.max + 1)).rejects.toThrow(ValidationError)
  })

  test('women cannot start the proposal (they answer instead)', async () => {
    const { service, db } = makeService()
    db.player.findMany.mockResolvedValue([
      { ...FEMALE, telegramUserId: 10n },
      { ...MALE, telegramUserId: 20n, id: 'm2' }
    ])
    await expect(service.propose(10n, 20n, 1_000_000)).rejects.toThrow(ValidationError)
  })

  test('a married proposer or target is refused', async () => {
    const { service, db } = makeService()
    db.player.findMany.mockResolvedValue([{ ...MALE, maritalStatus: MaritalStatus.MARRIED }, FEMALE])
    await expect(service.propose(10n, 20n, 1_000_000)).rejects.toThrow(ConflictError)

    const second = makeService()
    second.db.player.findMany.mockResolvedValue([
      MALE,
      { ...FEMALE, maritalStatus: MaritalStatus.MARRIED }
    ])
    await expect(second.service.propose(10n, 20n, 1_000_000)).rejects.toThrow(ConflictError)
  })

  test('an open proposal anywhere blocks a new one (no spam, no parallel courts)', async () => {
    const { service, tx } = makeService()
    tx.marriageProposal.count.mockResolvedValue(1)
    await expect(service.propose(10n, 20n, 1_000_000)).rejects.toThrow(ConflictError)
    expect(tx.marriageProposal.count).toHaveBeenCalled()
    expect(tx.marriageProposal.create).not.toHaveBeenCalled()
  })

  test('a successful proposal records it and notifies the woman', async () => {
    const { service, tx, notify } = makeService()
    const result = await service.propose(10n, 20n, 8_000_000)
    expect(result).toEqual({ targetName: 'سارا م.', mahr: 8_000_000 })
    expect(tx.marriageProposal.create).toHaveBeenCalledWith({
      data: { proposerId: 'm1', targetId: 'f1', mahr: 8_000_000 }
    })
    expect(notify.notifyPlayerById).toHaveBeenCalledWith(
      'f1',
      expect.any(String),
      expect.stringContaining('آرش'),
      undefined,
      expect.stringContaining('marriage-propose'),
      // پیشنهاد ازدواج یک اتفاق تعیین‌کننده است: باید به چت خصوصی هم برود.
      'CRITICAL'
    )
  })

  test('mahr=null means “not set yet” and is stored as 0', async () => {
    const { service, tx } = makeService()
    const result = await service.propose(10n, 20n, null)
    expect(result.mahr).toBe(0)
    expect(tx.marriageProposal.create).toHaveBeenCalledWith({
      data: { proposerId: 'm1', targetId: 'f1', mahr: 0 }
    })
  })

  test('stale proposals are lazily expired on every entry point (no timers)', async () => {
    const { service, db } = makeService()
    await service.propose(10n, 20n, 1_000_000)
    expect(db.marriageProposal.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: 'EXPIRED' },
        where: expect.objectContaining({ status: { in: ['PENDING', 'MAHR_SET'] } })
      })
    )
  })

  test('unknown target player is a not-found, not a crash', async () => {
    const { service, db } = makeService()
    db.player.findMany.mockResolvedValue([MALE])
    await expect(service.propose(10n, 99n, 1_000_000)).rejects.toThrow(NotFoundError)
  })
})

describe('MarriageService — mahr negotiation', () => {
  test('the woman can set mahr on an open proposal and it moves to MAHR_SET', async () => {
    const { service, db, notify } = makeService()
    db.marriageProposal.findUnique.mockResolvedValue({ proposerId: 'm1' })
    await service.setMahr(20n, 'p1', 12_000_000)
    expect(db.marriageProposal.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'p1',
          targetId: 'f1',
          status: { in: ['PENDING', 'MAHR_SET'] },
          createdAt: expect.any(Object)
        }),
        data: { mahr: 12_000_000, status: 'MAHR_SET' }
      })
    )
    expect(notify.notifyPlayerById).toHaveBeenCalledWith(
      'm1',
      expect.any(String),
      expect.stringContaining('همسرِ آینده'),
      undefined,
      expect.stringContaining('marriage-mahr'),
      // توافق روی مهریه منتظر پاسخ است، اما تعیین‌کنندهٔ نهایی نیست.
      'IMPORTANT'
    )
  })

  test('setting mahr on an answered/expired proposal fails atomically', async () => {
    const { service, db } = makeService()
    db.marriageProposal.updateMany.mockResolvedValue({ count: 0 })
    await expect(service.setMahr(20n, 'p1', 12_000_000)).rejects.toThrow(ConflictError)
  })

  test('the woman cannot accept a proposal that is already in the confirm stage', async () => {
    const { service } = makeService()
    // findFirst با فیلتر status=PENDING چیزی پیدا نمی‌کند چون پیشنهاد MAHR_SET است
    await expect(service.acceptProposal(20n, 'p1')).rejects.toThrow(ConflictError)
  })

  test('accepting a zero-mahr proposal is refused (she must set it first)', async () => {
    const { service, db } = makeService()
    db.marriageProposal.findFirst.mockResolvedValue({ id: 'p1', mahr: 0 })
    await expect(service.acceptProposal(20n, 'p1')).rejects.toThrow(ValidationError)
  })
})

describe('MarriageService — finalize in one transaction', () => {
  function readyProposal(status: 'PENDING' | 'MAHR_SET', mahr: number) {
    return {
      id: 'p1',
      status,
      mahr,
      proposerId: 'm1',
      targetId: 'f1',
      proposer: { ...MALE, balance: 100_000_000 },
      target: { ...FEMALE }
    }
  }

  test('marriage, mahr transfer and ledger rows all happen inside the lock', async () => {
    const { service, db, tx } = makeService()
    db.player.findUnique.mockResolvedValue({ id: 'm1' })
    tx.marriageProposal.findUnique.mockResolvedValue(readyProposal('MAHR_SET', 20_000_000))
    await service.confirmProposal(10n, 'p1')

    const lock = tx.marriageProposal.updateMany.mock.calls[0]![0]
    expect(lock.where).toEqual({ id: 'p1', status: 'MAHR_SET' })

    const debit = (tx.player.updateMany.mock.calls as Array<[never]>).find(
      (c) => (c[0] as { data?: { balance?: { decrement?: number } } }).data?.balance?.decrement
    )
    expect(
      (debit![0] as { where: unknown }).where
    ).toEqual({ id: 'm1', balance: { gte: 20_000_000 } })
    expect(tx.financialTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ type: 'MAHR_PAYMENT', amount: 20_000_000 })
    })
    expect(tx.marriage.create).toHaveBeenCalledWith({
      data: {
        playerAId: 'm1',
        playerBId: 'f1',
        mahr: 20_000_000,
        // لنگر گرما از لحظهٔ عقد ثبت می‌شود
        lastWarmthAt: expect.any(Date)
      }
    })
    expect(tx.relationship.upsert).toHaveBeenCalledTimes(2) // پیوند دوسویهٔ همسری
  })

  test('a man can only CONFIRM a mahr the woman set — not accept his own offer', async () => {
    const { service, db, tx } = makeService()
    db.player.findUnique.mockResolvedValue({ id: 'm1' })
    tx.marriageProposal.findUnique.mockResolvedValue(readyProposal('PENDING', 20_000_000))
    await expect(service.confirmProposal(10n, 'p1')).rejects.toThrow(ConflictError)
    expect(tx.marriage.create).not.toHaveBeenCalled()
  })

  test('insufficient balance aborts the whole marriage atomically', async () => {
    const { service, db, tx } = makeService()
    db.player.findUnique.mockResolvedValue({ id: 'm1' })
    tx.marriageProposal.findUnique.mockResolvedValue(readyProposal('MAHR_SET', 20_000_000))
    tx.player.updateMany.mockImplementation(async (args: { where: { balance?: unknown } }) =>
      args.where.balance ? { count: 0 } : { count: 1 }
    )
    await expect(service.confirmProposal(10n, 'p1')).rejects.toThrow(ConflictError)
    expect(tx.marriage.create).not.toHaveBeenCalled()
  })

  test('a concurrent answer loses the race and pays nothing', async () => {
    const { service, tx } = makeService()
    tx.marriageProposal.findUnique.mockResolvedValue(readyProposal('PENDING', 5_000_000))
    tx.marriageProposal.updateMany.mockResolvedValue({ count: 0 })
    await expect(service.acceptProposal(20n, 'p1')).rejects.toThrow(ConflictError)
    expect(tx.financialTransaction.create).not.toHaveBeenCalled()
  })

  test('a stranger cannot finalize someone else’s proposal', async () => {
    const { service, db } = makeService()
    // findUnique بازیکنِ غریبه وجود ندارد → NotFound قبل از هر اثری
    db.player.findUnique.mockResolvedValue(null)
    await expect(service.confirmProposal(77n, 'p1')).rejects.toThrow(NotFoundError)
  })
})

describe('MarriageService — rejection, withdrawal, divorce, bonus', () => {
  test('rejecting an already answered proposal fails', async () => {
    const { service, db } = makeService()
    db.marriageProposal.updateMany.mockResolvedValue({ count: 0 })
    await expect(service.rejectProposal(20n, 'p1')).rejects.toThrow(ConflictError)
  })

  test('withdrawal before the answer cancels; after a mahr counter it declines', async () => {
    const pending = makeService()
    pending.db.player.findUnique.mockResolvedValue({ id: 'm1' })
    pending.db.marriageProposal.findFirst.mockResolvedValue({ status: 'PENDING', targetId: 'f1' })
    await pending.service.withdrawProposal(10n, 'p1')
    // نوشتار شرطی: همان وضعیتِ خوانده‌شده در where می‌آید تا پاسخِ همزمان
    // نتیجهٔ عقد را بازنویسی نکند
    expect(pending.db.marriageProposal.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'p1', proposerId: 'm1', status: 'PENDING' }),
        data: { status: 'CANCELLED' }
      })
    )
    expect(pending.db.marriageProposal.update).not.toHaveBeenCalled()

    const countered = makeService()
    countered.db.player.findUnique.mockResolvedValue({ id: 'm1' })
    countered.db.marriageProposal.findFirst.mockResolvedValue({ status: 'MAHR_SET', targetId: 'f1' })
    await countered.service.withdrawProposal(10n, 'p1')
    expect(countered.db.marriageProposal.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'p1', proposerId: 'm1', status: 'MAHR_SET' }),
        data: { status: 'DECLINED' }
      })
    )
  })

  test('a withdrawal that lost the race to an acceptance cannot rewrite the answer', async () => {
    const { service, db, tx } = makeService()
    db.player.findUnique.mockResolvedValue({ id: 'm1' })
    db.marriageProposal.findFirst.mockResolvedValue({ status: 'PENDING', targetId: 'f1' })
    // پذیرش همزمان برنده شده: نوشتارِ انصراف هیچ ردیفی را نمی‌گیرد
    db.marriageProposal.updateMany.mockResolvedValue({ count: 0 })

    await expect(service.withdrawProposal(10n, 'p1')).rejects.toThrow(ConflictError)
    expect(tx.marriage.create).not.toHaveBeenCalled()
    expect(tx.player.updateMany).not.toHaveBeenCalled()
    expect(db.marriageProposal.update).not.toHaveBeenCalled()
  })

  test('divorce is a pure 5M fee sink: mahr stays with the wife', async () => {
    const { service, db, tx } = makeService()
    db.player.findUnique.mockResolvedValue({ id: 'm1' })
    db.marriage.findFirst.mockResolvedValue({
      id: 'g1',
      playerAId: 'm1',
      playerBId: 'f1',
      playerA: { id: 'm1', firstName: 'آرش', lastName: 'ک.' },
      playerB: { id: 'f1', firstName: 'سارا', lastName: 'م.' }
    })
    const result = await service.divorce(10n)
    expect(result.paidFee).toBe(DIVORCE_COST)
    expect(tx.player.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'm1', balance: { gte: DIVORCE_COST } },
        data: { balance: { decrement: DIVORCE_COST } }
      })
    )
    // هیچ واریزی به هیچ‌کس در طلاق انجام نمی‌شود — مهریه جابه‌جا نمی‌شود
    expect(tx.player.update).not.toHaveBeenCalled()
    expect(tx.relationship.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'BLOCKED', strength: 10 } })
    )
  })

  test('divorce without the fee balance is refused as a validation error', async () => {
    const { service, db, tx } = makeService()
    db.player.findUnique.mockResolvedValue({ id: 'm1' })
    db.marriage.findFirst.mockResolvedValue({
      id: 'g1',
      playerAId: 'm1',
      playerBId: 'f1',
      playerA: { id: 'm1', firstName: 'آ', lastName: null },
      playerB: { id: 'f1', firstName: 'س', lastName: null }
    })
    tx.player.updateMany.mockImplementation(async (args: { where: { balance?: unknown } }) =>
      args.where.balance ? { count: 0 } : { count: 1 }
    )
    await expect(service.divorce(10n)).rejects.toThrow(ValidationError)
  })

  test('the daily couple bonus requires a recently active spouse', async () => {
    const { service, db } = makeService()
    db.player.findUnique.mockResolvedValue({ id: 'm1' })
    const yearAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    db.marriage.findFirst.mockResolvedValue({
      id: 'g1',
      playerAId: 'm1',
      playerBId: 'f1',
      lastBonusDayIndex: -1,
      playerA: { id: 'm1', firstName: 'آ', lastName: null, lastActivityAt: new Date() },
      playerB: { id: 'f1', firstName: 'س', lastName: null, lastActivityAt: yearAgo }
    })
    await expect(service.claimCoupleBonus(10n)).rejects.toThrow(ConflictError)
  })
})

describe('MarriageService — couple bonus scales with relationship warmth', () => {
  function bonusSetup(storedWarmth: number, lastWarmthAt: Date | null) {
    const marriage = {
      id: 'g1',
      playerAId: 'm1',
      playerBId: 'f1',
      mahr: { toString: () => '1' },
      marriedAt: new Date(),
      lastWarmthAt,
      lastActivityDayIndex: null,
      lastBonusDayIndex: null,
      playerA: { id: 'm1', firstName: 'آ', lastName: null, lastActivityAt: new Date() },
      playerB: { id: 'f1', firstName: 'س', lastName: null, lastActivityAt: new Date() }
    }
    const tx = {
      marriage: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockResolvedValue({})
      },
      player: { update: jest.fn().mockResolvedValue({}) },
      financialTransaction: { create: jest.fn().mockResolvedValue({}) },
      relationship: {
        findFirst: jest.fn().mockResolvedValue({ strength: storedWarmth }),
        updateMany: jest.fn().mockResolvedValue({ count: 2 })
      }
    }
    const db = {
      $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
      player: { findUnique: jest.fn().mockResolvedValue({ id: 'm1' }) },
      marriage: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(marriage)
      }
    }
    const service = new MarriageService(db as never, eventsStub(), notifyStub())
    return { service, db, tx }
  }

  function eventsStub() {
    return { recordPlayerEvent: jest.fn().mockResolvedValue(undefined) } as never
  }
  function notifyStub() {
    return { notifyPlayerById: jest.fn().mockResolvedValue(true) } as never
  }

  test('a warm marriage still pays the historical full bonus', async () => {
    const { service, tx } = bonusSetup(100, new Date())
    const res = await service.claimCoupleBonus(10n)
    // پاداش روزانه روی «روز بازی» هم‌تراز شده است (۵۰٬۰۰۰ ÷ ۳۰ ≈ ۱٬۶۶۷)
    expect(res.amount).toBe(1_667)
    expect(res.multiplier).toBe(1)
    // گرفتن پاداش خودش کمی گرما برمی‌گرداند
    expect(res.warmth).toBeGreaterThan(100 - 1)
    expect(tx.player.update).toHaveBeenCalledWith({
      where: { id: 'm1' },
      data: { balance: { increment: 1_667 } }
    })
  })

  test('a cooled marriage pays less — neglect has a real price', async () => {
    const { service, tx } = bonusSetup(50, new Date())
    const res = await service.claimCoupleBonus(10n)
    expect(res.multiplier).toBe(0.6)
    expect(res.amount).toBe(1_000)
    expect(tx.financialTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ amount: 1_000, type: 'REWARD_PAYOUT' })
    })
  })

  test('warmth decay applies from the last touch before the multiplier', async () => {
    // ده روز بی‌خبری: ۸۰ ذخیره‌شده → ۷۰ واقعی → ضریب ۰٫۸
    const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000)
    const { service, tx } = bonusSetup(80, tenDaysAgo)
    const res = await service.claimCoupleBonus(10n)
    expect(res.multiplier).toBe(0.8)
    expect(res.amount).toBe(1_334)
    // گرمای فرسایش‌یافته به‌عنوان مقدار پایه ذخیره می‌شود (+۲ پاداش)
    expect(tx.relationship.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { strength: 72 } })
    )
  })

  test('missing relationship rows never punish: warmth reads as full', async () => {
    const { service, tx } = bonusSetup(100, new Date())
    tx.relationship.findFirst.mockResolvedValue(null)
    const res = await service.claimCoupleBonus(10n)
    expect(res.multiplier).toBe(1)
    expect(res.amount).toBe(1_667)
  })
})

describe('Mahr rules have a single source of truth', () => {
  test('«unset» has one canonical value and both spellings normalize to it', async () => {
    // دامنهٔ ورودی و خروجیِ propose باید با هم بخوانند؛ قبلاً `۰` استثنا می‌داد
    // در حالی که `null` کار می‌کرد، ولی خروجی هر دو `۰` بود.
    expect(normalizeMahrOffer(null)).toBe(MAHR_RULES.unset)
    expect(normalizeMahrOffer(0)).toBe(MAHR_RULES.unset)
    expect(normalizeMahrOffer(1)).toBe(1)
  })

  test('propose accepts 0 as well as null for «she decides»', async () => {
    const { service, tx } = makeService()
    const result = await service.propose(10n, 20n, 0)
    expect(result.mahr).toBe(MAHR_RULES.unset)
    expect(tx.marriageProposal.create).toHaveBeenCalledWith({
      data: { proposerId: 'm1', targetId: 'f1', mahr: 0 }
    })
  })

  test('the parser and the validator agree on the boundaries', () => {
    expect(parseMahrInput('0', true)).toEqual({ kind: 'unset' })
    expect(parseMahrInput('0', false).kind).toBe('invalid')
    expect(parseMahrInput('1', true)).toEqual({ kind: 'amount', amount: 1 })
    expect(parseMahrInput('-5', true).kind).toBe('invalid')
    expect(parseMahrInput(String(MAHR_RULES.max), true)).toEqual({
      kind: 'amount',
      amount: MAHR_RULES.max
    })
    expect(parseMahrInput(String(MAHR_RULES.max + 1), true)).toEqual({
      kind: 'invalid',
      message: mahrRangeError()
    })
    expect(() => normalizeMahrOffer(MAHR_RULES.max + 1)).toThrow(ValidationError)
  })

  test('no artificial floor: any whole toman the couple agrees on is valid', () => {
    for (const amount of [1, 2, 999, 500_000, 499_999]) {
      expect(normalizeMahrOffer(amount)).toBe(amount)
    }
  })

  test('persian digits, separators and suffixes all parse to the same number', () => {
    for (const raw of ['۵۰۰۰۰۰', '500,000', '۵۰۰ هزار', '500k', '0.5M']) {
      const parsed = parseMahrInput(raw, true)
      expect(parsed).toEqual({ kind: 'amount', amount: 500_000 })
    }
  })

  test('zero always reads as «unset», never as a zero-toman mahr', () => {
    expect(describeMahr(0)).toBe('تعیین‌نشده')
    expect(describeMahr(0)).not.toContain('۰')
  })
})
