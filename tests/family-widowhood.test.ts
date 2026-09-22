import { MarriageEndReason, NotificationType, PlayerStatus, PrismaClient } from '@prisma/client'
import {
  closeWidowedMarriages,
  settleWidowhood,
  widowhoodNotice
} from '../src/modules/family/widowhood'
import { renderFamilyPanel } from '../src/bot/renders'

const SURVIVOR = {
  id: 'w1',
  firstName: 'آرش',
  lastName: 'ک.',
  status: PlayerStatus.ACTIVE
}
const DECEASED = {
  id: 'd1',
  firstName: 'سارا',
  lastName: 'م.',
  status: PlayerStatus.DEAD
}

function marriageRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'g1',
    playerAId: SURVIVOR.id,
    playerBId: DECEASED.id,
    isActive: true,
    mahr: { toString: () => '20000000' },
    marriedAt: new Date('2026-01-01T00:00:00Z'),
    divorcedAt: null,
    endedAt: null,
    endReason: null,
    lastWarmthAt: new Date(),
    lastActivityDayIndex: null,
    lastBonusDayIndex: null,
    playerA: SURVIVOR,
    playerB: DECEASED,
    ...overrides
  }
}

/**
 * یک دیتابیسِ حداقلی برای مسیرِ فوتِ همسر.
 * `findMany` همان ردیف‌های ازدواجِ فعال را می‌دهد و نوشتارها با شمارنده
 * قابل بازبینی‌اند.
 */
function makeDb(rows: unknown[]) {
  const tx = {
    marriage: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    player: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    relationship: { upsert: jest.fn().mockResolvedValue({}) }
  }
  const db = {
    $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    marriage: { findMany: jest.fn().mockResolvedValue(rows) }
  }
  return { db: db as unknown as PrismaClient, tx, raw: db }
}

describe('Widowhood — بسته‌شدنِ ازدواج با فوتِ همسر', () => {
  test('a dead spouse closes the marriage with reason WIDOWED and frees the survivor', async () => {
    const { db, tx } = makeDb([marriageRow()])

    const closures = await closeWidowedMarriages(db, SURVIVOR.id)

    expect(closures).toEqual([
      {
        marriageId: 'g1',
        survivorId: SURVIVOR.id,
        deceasedId: DECEASED.id,
        deceasedName: 'سارا م.'
      }
    ])
    // پایانِ صریحِ ازدواج: علت و زمان ثبت می‌شود، نه فقط isActive=false
    expect(tx.marriage.updateMany).toHaveBeenCalledWith({
      where: { id: 'g1', isActive: true },
      data: {
        isActive: false,
        endedAt: expect.any(Date),
        endReason: MarriageEndReason.WIDOWED
      }
    })
    // وضعیتِ بازمانده آزاد می‌شود تا بتواند دوباره ازدواج کند
    expect(tx.player.updateMany).toHaveBeenCalledWith({
      where: { id: SURVIVOR.id, maritalStatus: 'MARRIED' },
      data: { maritalStatus: 'WIDOWED' }
    })
    // پیوندِ همسری «پایان‌یافته» می‌شود (نه «مسدود» که معنای دشمنیِ طلاق دارد)
    expect(tx.relationship.upsert).toHaveBeenCalledTimes(2)
    for (const call of tx.relationship.upsert.mock.calls) {
      expect(call[0].update).toEqual({ status: 'ENDED', strength: 10 })
    }
  })

  test('a living (or merely inactive) spouse never touches the marriage', async () => {
    const { db, raw } = makeDb([
      marriageRow({ playerB: { ...DECEASED, status: PlayerStatus.ACTIVE } })
    ])

    const closures = await closeWidowedMarriages(db, SURVIVOR.id)

    expect(closures).toEqual([])
    expect(raw.$transaction).not.toHaveBeenCalled()
  })

  test('the marriage is closed from the survivor side, not from the deceased account', async () => {
    // تصمیمِ آگاهانه: بازیکنِ فوت‌شده هیچ‌وقت وارد بازی نمی‌شود، پس آشتیِ چرخه
    // از سمتِ بازمانده انجام می‌شود (همان‌جا که پیام و اعلان معنا دارد).
    // پنلِ مدیریت و مسیرهای حسابِ فوت‌شده هیچ نوشتاری روی ازدواجِ بازمانده نمی‌زنند.
    const { db, raw } = makeDb([marriageRow()])

    const closures = await closeWidowedMarriages(db, DECEASED.id)

    expect(closures).toEqual([])
    expect(raw.$transaction).not.toHaveBeenCalled()
  })

  test('a concurrent writer that already closed the marriage does not double-close it', async () => {
    const { db, tx } = makeDb([marriageRow()])
    tx.marriage.updateMany.mockResolvedValue({ count: 0 })

    const closures = await closeWidowedMarriages(db, SURVIVOR.id)

    // نوشتارِ شرطی (isActive: true) جلوی پایانِ دوباره را می‌گیرد
    expect(closures).toEqual([])
    expect(tx.player.updateMany).not.toHaveBeenCalled()
  })

  test('the survivor is told exactly once — notification and history share one dedupe key', async () => {
    const { db } = makeDb([marriageRow()])
    const notify = jest.fn().mockResolvedValue(true)
    const recordEvent = jest.fn().mockResolvedValue(undefined)

    const first = await settleWidowhood(db, SURVIVOR.id, {
      notify,
      recordEvent
    })

    expect(first).toHaveLength(1)
    expect(notify).toHaveBeenCalledTimes(1)
    const [playerId, title, message, type, dedupeKey, level] = notify.mock.calls[0]!
    expect(playerId).toBe(SURVIVOR.id)
    expect(title).toContain('تسلیت')
    expect(message).toContain('سارا م.')
    expect(message).toContain('می‌توانی دوباره زندگی مشترک بسازی')
    expect(type).toBe(NotificationType.WARNING)
    expect(level).toBe('CRITICAL')
    expect(dedupeKey).toBe('widowhood:g1:w1')
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        playerId: SURVIVOR.id,
        title: '🕯️ فوت همسر',
        dedupeKey: 'widowhood:g1:w1'
      })
    )

    // دومین فراخوانی: هیچ ازدواجِ فعالی با همسرِ فوت‌شده نمانده → نه اعلان، نه رخداد
    notify.mockClear()
    recordEvent.mockClear()
    const { db: freshDb } = makeDb([])
    const second = await settleWidowhood(freshDb, SURVIVOR.id, { notify, recordEvent })
    expect(second).toEqual([])
    expect(notify).not.toHaveBeenCalled()
    expect(recordEvent).not.toHaveBeenCalled()
  })

  test('a failing notification never undoes the recorded state', async () => {
    const { db, tx } = makeDb([marriageRow()])
    const notify = jest.fn().mockRejectedValue(new Error('telegram down'))

    const closures = await settleWidowhood(db, SURVIVOR.id, { notify })

    expect(closures).toHaveLength(1)
    expect(tx.marriage.updateMany).toHaveBeenCalled()
    expect(tx.player.updateMany).toHaveBeenCalled()
  })

  test('the notice carries no internal term and always names the way forward', () => {
    const notice = widowhoodNotice({
      marriageId: 'g1',
      survivorId: 'w1',
      deceasedId: 'd1',
      deceasedName: 'سارا م.'
    })
    for (const word of ['Service', 'Database', 'Handler', 'undefined', 'null', 'NaN']) {
      expect(notice.message).not.toContain(word)
    }
    expect(notice.message).toContain('پنل «خانواده»')
  })
})

describe('Family panel — نمای بازمانده', () => {
  const baseView = {
    genderIsMale: true,
    hasSpouse: false,
    spouseName: null,
    marriedAt: null,
    mahr: 0,
    daysMarried: 0,
    bonusReady: false,
    bonusAmount: 50_000,
    activityDoneToday: false,
    incomingProposals: [],
    outgoingProposals: []
  }

  test('a widowed player is not shown the «never married» panel', () => {
    const text = renderFamilyPanel({ ...baseView, isWidowed: true })

    expect(text).toContain('فوت')
    expect(text).not.toContain('هنوز متأهل نشده‌ای')
    expect(text).toContain('دوباره')
  })

  test('a single player still gets the proposal instructions', () => {
    const text = renderFamilyPanel({ ...baseView })

    expect(text).toContain('هنوز متأهل نشده‌ای')
    expect(text).not.toContain('🕯️ همسرت فوت شده')
  })
})
