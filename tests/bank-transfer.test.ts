import { Prisma, PrismaClient } from '@prisma/client'
import { BANK_TRANSFER, CASH_TRANSFER, bankTransferNetOf, bankTransferTaxOf } from '../src/config/economy'
import { BankTransferService } from '../src/modules/banking/bank-transfer.service'
import { MAX_TRANSFER_AMOUNT, MIN_TRANSFER_AMOUNT, TransferService } from '../src/modules/finance/transfer.service'
import { parseTransferCommand } from '../src/utils/commands'
import { ValidationError, ConflictError } from '../src/utils/classes/errors'
import { reconcilePrivateSector } from '../src/modules/economy/money-supply'

/**
 * دو مسیرِ پول: نقدی (کیف پول، سقفِ کوچک) و بانکی (حساب، سقفِ روزانهٔ جمعی + مالیات).
 *
 * این آزمون‌ها روی سه چیز متمرکزند — همان سه چیزی که این جداسازی برایشان ساخته شد:
 *  ۱. سقف‌ها دقیقاً در مرز رفتار کنند (۹۹٬۹۹۹٬۹۹۹ و ۱۰۰٬۰۰۰).
 *  ۲. سقفِ روزانهٔ بانکی *جمعی* باشد و روی ناخالص (نه خالص) اعمال شود.
 *  ۳. دفتر کل با موجودیِ هر دو طرف «ریال به ریال» بخواند — مالیات از هیچ طرفی
 *     گم یا دوبار شمرده نشود.
 */

interface FakeRow {
  amount: number
  type: string
  sourcePlayerId: string | null
  destinationPlayerId: string | null
  reference: string | null
  createdAt: Date
}

interface FakeAccount {
  id: string
  playerId: string
  balance: number
}

interface FakeDb {
  bankAccount: Record<string, jest.Mock>
  financialTransaction: Record<string, jest.Mock>
  player: Record<string, jest.Mock>
  regionStat: Record<string, jest.Mock>
  $transaction: jest.Mock
}

interface FakeWorld {
  db: FakeDb
  accounts: FakeAccount[]
  rows: FakeRow[]
  funds: Map<string, number>
}

/** یک دیتابیسِ کوچکِ درون‌حافظه‌ای با همان پرس‌وجوهایی که سرویسِ انتقال می‌زند. */
function makeWorld(seed: {
  accounts?: FakeAccount[]
  rows?: FakeRow[]
  regions?: Record<string, { homeGroupId: string | null; currentRegionId: string | null }>
} = {}): FakeWorld {
  const accounts: FakeAccount[] = seed.accounts ? [...seed.accounts] : []
  const rows: FakeRow[] = seed.rows ? [...seed.rows] : []
  const funds = new Map<string, number>()
  const regions = seed.regions ?? {}

  const db: FakeDb = {
    bankAccount: {
      findUnique: jest.fn(async ({ where }: { where: { playerId?: string; id?: string } }) => {
        const found = accounts.find((account) =>
          where.playerId !== undefined ? account.playerId === where.playerId : account.id === where.id
        )
        return found ? { ...found } : null
      }),
      findUniqueOrThrow: jest.fn(async ({ where }: { where: { id: string } }) => {
        const found = accounts.find((account) => account.id === where.id)
        if (!found) throw new Error('account not found')
        return { ...found }
      }),
      updateMany: jest.fn(
        async ({ where, data }: { where: { id: string; balance?: { gte: unknown } }; data: { balance: { decrement: unknown } } }) => {
          const account = accounts.find((item) => item.id === where.id)
          if (!account) return { count: 0 }
          const floor = where.balance?.gte === undefined ? null : Number(where.balance.gte)
          if (floor !== null && account.balance < floor) return { count: 0 }
          account.balance -= Number(data.balance.decrement)
          return { count: 1 }
        }
      ),
      update: jest.fn(
        async ({ where, data }: { where: { id: string }; data: { balance: { increment: unknown } } }) => {
          const account = accounts.find((item) => item.id === where.id)
          if (!account) throw new Error('account not found')
          account.balance += Number(data.balance.increment)
          return { ...account }
        }
      )
    },
    financialTransaction: {
      // همان فیلترهایی که سرویسِ سقفِ روزانه می‌فرستد
      aggregate: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const since = (where.createdAt as { gte?: Date } | undefined)?.gte
        const prefix = (where.reference as { startsWith?: string } | undefined)?.startsWith
        const total = rows
          .filter((row) => !where.type || row.type === where.type)
          .filter((row) => !where.sourcePlayerId || row.sourcePlayerId === where.sourcePlayerId)
          .filter((row) => !since || row.createdAt >= since)
          .filter((row) => !prefix || (row.reference ?? '').startsWith(prefix))
          .reduce((sum, row) => sum + row.amount, 0)
        return { _sum: { amount: total === 0 ? null : total } }
      }),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row: FakeRow = {
          amount: Number(data.amount),
          type: String(data.type),
          sourcePlayerId: (data.sourcePlayerId as string | null) ?? null,
          destinationPlayerId: (data.destinationPlayerId as string | null) ?? null,
          reference: (data.reference as string | null) ?? null,
          createdAt: new Date()
        }
        rows.push(row)
        return row
      })
    },
    player: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
        if (regions[where.id]) return regions[where.id]
        return { homeGroupId: null, currentRegionId: null }
      })
    },
    regionStat: {
      upsert: jest.fn(async ({ where, create, update }: { where: { groupId: string }; create: { taxRevenue: number }; update: { taxRevenue: { increment: number } } }) => {
        const existing = funds.get(where.groupId)
        const next = existing === undefined ? create.taxRevenue : existing + update.taxRevenue.increment
        funds.set(where.groupId, next)
        return { groupId: where.groupId, taxRevenue: next }
      })
    },
    $transaction: jest.fn(async (callback: (tx: FakeDb) => Promise<unknown>) => callback(db))
  }

  return { db, accounts, rows, funds }
}

function makeService(world: FakeWorld, players: Record<string, FakePlayer>) {
  const playerRepository = {
    findByTelegramUserId: jest.fn(async (telegramUserId: bigint) => players[String(telegramUserId)] ?? null)
  }
  const bankingService = {
    getOrCreateAccount: jest.fn(async (telegramUserId: bigint) => {
      const player = players[String(telegramUserId)]!
      const existing = world.accounts.find((account) => account.playerId === player.id)
      if (existing) return { ...existing }
      const created: FakeAccount = { id: `acc-${player.id}`, playerId: player.id, balance: 0 }
      world.accounts.push(created)
      return { ...created }
    })
  }
  const notificationService = { announce: jest.fn(async () => true) }

  return new BankTransferService(
    world.db as unknown as PrismaClient,
    playerRepository as never,
    notificationService as never,
    bankingService as never
  )
}

const SENDER = 's-1'
const RECEIVER = 'r-1'

interface FakePlayer {
  id: string
  firstName: string
  lastName: string | null
  status: string
}

const PLAYERS: Record<string, FakePlayer> = {
  '100': { id: SENDER, firstName: 'فرستنده', lastName: null, status: 'ACTIVE' },
  '200': { id: RECEIVER, firstName: 'گیرنده', lastName: null, status: 'ACTIVE' }
}

/** ردیفِ تأمینِ موجودیِ اولیه (مثلِ حقوق) تا آشتیِ دفتر کل معنادار باشد. */
function fundingRow(playerId: string, amount: number): FakeRow {
  return {
    amount,
    type: 'SALARY_PAYMENT',
    sourcePlayerId: null,
    destinationPlayerId: playerId,
    reference: 'تأمین اولیهٔ آزمون',
    createdAt: new Date()
  }
}

describe('parser: دو مسیرِ انتقال از یک کلیدواژه جدا می‌شوند', () => {
  test('«انتقال بانکی» به مسیرِ بانکی می‌رود و «انتقال» به نقدی', () => {
    expect(parseTransferCommand('انتقال بانکی ۵۰۰۰۰۰۰')).toEqual({
      kind: 'bank_transfer',
      amount: 5_000_000
    })
    expect(parseTransferCommand('انتقال ۵۰۰۰۰۰')).toEqual({ kind: 'transfer', amount: 500_000 })
  })

  test('«انتقال از بانک» هم مسیرِ بانکی است، نه نقدی', () => {
    expect(parseTransferCommand('انتقال از بانک ۱ میلیون')).toEqual({
      kind: 'bank_transfer',
      amount: 1_000_000
    })
  })

  test('کلیدواژهٔ بی‌مبلغ و متنِ بی‌ربط، انتقال نمی‌سازند', () => {
    expect(parseTransferCommand('انتقال بانکی')).toEqual({
      kind: 'transfer_invalid',
      reason: 'missing_amount'
    })
    expect(parseTransferCommand('سلام')).toEqual({ kind: 'none' })
  })
})

describe('config: سقف‌ها و مالیات', () => {
  test('نقدی ۱۰۰٬۰۰۰ و بانکی ۵۰ میلیون در روز است', () => {
    expect(CASH_TRANSFER.maxAmount).toBe(100_000)
    expect(BANK_TRANSFER.dailyOutgoingLimit).toBe(50_000_000)
    expect(MAX_TRANSFER_AMOUNT).toBe(100_000)
    expect(MIN_TRANSFER_AMOUNT).toBe(10_000)
  })

  test('مالیاتِ بانکی ۰٫۱٪ است و خالص + مالیات دقیقاً ناخالص می‌شود', () => {
    expect(bankTransferTaxOf(10_000_000)).toBe(10_000)
    for (const gross of [10_000, 999_999, 5_000_000, 50_000_000]) {
      expect(bankTransferNetOf(gross) + bankTransferTaxOf(gross)).toBe(gross)
    }
  })
})

describe('انتقالِ نقدی: سقفِ سخت‌گیرانه با راهِ جایگزین', () => {
  test('۱۰۰٬۰۰۰ می‌رود و ۱۰۰٬۰۰۱ رد می‌شود و مسیرِ بانکی را نشان می‌دهد', async () => {
    const world = makeWorld()
    const service = new TransferService(
      world.db as unknown as PrismaClient,
      { findByTelegramUserId: jest.fn(async (id: bigint) => PLAYERS[String(id)]) } as never,
      { announce: jest.fn(async () => true) } as never
    )

    // خطای انگلیسی برای لاگ است؛ بازیکن متنِ فارسی را می‌بیند و باید راهِ
    // جایگزین را در همان پیام داشته باشد.
    await expect(service.execute(100n, 200n, 100_001)).rejects.toThrow(ValidationError)
    const error = await service
      .execute(100n, 200n, 100_001)
      .then(() => null)
      .catch((err: ValidationError) => err)
    expect(error?.persianMessage).toContain('انتقالِ بانکی')
    expect(error?.persianMessage).toContain('۱۰۰٬۰۰۰')
  })
})

describe('انتقالِ بانکی: دو حسابِ واقعی، مالیات به منطقه', () => {
  test('ناخالص از حسابِ فرستنده کم و خالص به گیرنده می‌رسد', async () => {
    const world = makeWorld({
      accounts: [{ id: 'acc-s', playerId: SENDER, balance: 100_000_000 }],
      rows: [fundingRow(SENDER, 100_000_000)],
      regions: { [SENDER]: { homeGroupId: 'g-1', currentRegionId: 'g-1' } }
    })
    const service = makeService(world, PLAYERS)

    const result = await service.execute(100n, 200n, 10_000_000)

    expect(result.gross).toBe(10_000_000)
    expect(result.tax).toBe(10_000)
    expect(result.net).toBe(9_990_000)
    expect(result.senderBankBalance).toBe(90_000_000)
    expect(result.receiverBankBalance).toBe(9_990_000)
    expect(result.taxToRegion).toBe('g-1')
    expect(world.funds.get('g-1')).toBe(10_000)
  })

  test('حسابِ گیرنده اگر نبود ساخته می‌شود تا پول جایی برای نشستن داشته باشد', async () => {
    const world = makeWorld({
      accounts: [{ id: 'acc-s', playerId: SENDER, balance: 1_000_000 }]
    })
    const service = makeService(world, PLAYERS)

    const result = await service.execute(100n, 200n, 500_000)

    expect(result.receiverBankBalance).toBe(499_500)
    expect(world.accounts).toHaveLength(2)
  })

  test('موجودیِ ناکافی، هیچ ردیفی نمی‌نویسد و خطای روشن می‌دهد', async () => {
    const world = makeWorld({
      accounts: [{ id: 'acc-s', playerId: SENDER, balance: 5_000_000 }],
      rows: [fundingRow(SENDER, 5_000_000)]
    })
    const service = makeService(world, PLAYERS)

    await expect(service.execute(100n, 200n, 9_000_000)).rejects.toThrow(ConflictError)
    expect(world.rows.filter((row) => row.type === 'BANK_TRANSFER')).toHaveLength(0)
    expect(world.accounts[0]!.balance).toBe(5_000_000)
  })

  test('انتقال به خودِ بازیکن رد می‌شود', async () => {
    const world = makeWorld({ accounts: [{ id: 'acc-s', playerId: SENDER, balance: 1_000_000 }] })
    const service = makeService(world, PLAYERS)

    await expect(service.execute(100n, 100n, 500_000)).rejects.toThrow(ValidationError)
  })
})

describe('سقفِ روزانهٔ بانکی: جمعی و روی ناخالص', () => {
  /** سه انتقالِ ۲۰ + ۲۰ + ۱۰ میلیونی دقیقاً سقف را پر می‌کند. */
  function seededWorld() {
    const world = makeWorld({
      accounts: [{ id: 'acc-s', playerId: SENDER, balance: 200_000_000 }],
      rows: [fundingRow(SENDER, 200_000_000)]
    })
    return world
  }

  test('۲۰ + ۲۰ + ۱۰ = ۵۰ میلیون مجاز است و انتقالِ بعدی رد می‌شود', async () => {
    const world = seededWorld()
    const service = makeService(world, PLAYERS)

    await service.execute(100n, 200n, 20_000_000)
    await service.execute(100n, 200n, 20_000_000)
    const third = await service.execute(100n, 200n, 10_000_000)

    expect(world.rows.filter((row) => row.type === 'BANK_TRANSFER')).toHaveLength(3)
    expect(third.remainingToday).toBe(0)

    await expect(service.execute(100n, 200n, 10_000)).rejects.toThrow(ConflictError)
    expect(world.rows.filter((row) => row.type === 'BANK_TRANSFER')).toHaveLength(3)
  })

  test('سقف روی ناخالص است: مالیات آن را بزرگ‌تر از جمعِ خالص نمی‌کند', async () => {
    const world = seededWorld()
    const service = makeService(world, PLAYERS)

    // ۴۹ میلیون باقی نمی‌گذارد که با ۱ میلیون کامل شود؟ خیر: ۴۹ + ۱ = ۵۰ دقیقاً مجاز.
    await service.execute(100n, 200n, 49_000_000)
    const usage = await service.dailyUsage(SENDER)
    expect(usage.spent).toBe(49_000_000)
    expect(usage.remaining).toBe(1_000_000)

    await expect(service.execute(100n, 200n, 1_000_001)).rejects.toThrow(ConflictError)
    const exact = await service.execute(100n, 200n, 1_000_000)
    expect(exact.remainingToday).toBe(0)
  })
})

describe('دفتر کل: هیچ ریالی گم یا دوبار شمرده نمی‌شود', () => {
  test('داراییِ فرستنده و گیرنده با دفتر کل می‌خواند (مالیات = مصرفِ واقعی)', async () => {
    const world = makeWorld({
      accounts: [{ id: 'acc-s', playerId: SENDER, balance: 10_000_000 }]
    })
    world.rows.push(fundingRow(SENDER, 10_000_000))
    const service = makeService(world, PLAYERS)

    await service.execute(100n, 200n, 4_000_000)

    const senderAccount = world.accounts.find((account) => account.playerId === SENDER)!
    const receiverAccount = world.accounts.find((account) => account.playerId === RECEIVER)!

    const senderCheck = reconcilePrivateSector(SENDER, { wallet: 0, bankAccounts: [senderAccount.balance] }, world.rows)
    const receiverCheck = reconcilePrivateSector(RECEIVER, { wallet: 0, bankAccounts: [receiverAccount.balance] }, world.rows)

    expect(senderCheck.ok).toBe(true)
    expect(receiverCheck.ok).toBe(true)
    expect(receiverCheck.ledgerNet).toBe(3_996_000)

    // بدهیِ فرستنده = طلبِ گیرنده + مالیات (صندوق منطقه)
    const publicIncome = world.rows.filter((row) => row.type === 'TAX_PAYMENT').reduce((sum, row) => sum + row.amount, 0)
    expect(4_000_000).toBe(3_996_000 + publicIncome)
  })

  test('مالیاتِ انتقال با مالیاتِ حقوق اشتباه نمی‌شود (سقف فقط انتقال‌ها را می‌شمارد)', async () => {
    const world = makeWorld({
      accounts: [{ id: 'acc-s', playerId: SENDER, balance: 100_000_000 }],
      rows: [
        fundingRow(SENDER, 100_000_000),
        // مالیاتِ حقوقِ امروز: نباید در سقفِ *انتقال* شمرده شود
        {
          amount: 5_000_000,
          type: 'TAX_PAYMENT',
          sourcePlayerId: SENDER,
          destinationPlayerId: null,
          reference: 'مالیات بر درآمد — حقوق',
          createdAt: new Date()
        }
      ]
    })
    const service = makeService(world, PLAYERS)

    const usage = await service.dailyUsage(SENDER)
    expect(usage.spent).toBe(0)

    const result = await service.execute(100n, 200n, 10_000_000)
    expect(result.gross).toBe(10_000_000)
    expect(result.remainingToday).toBe(40_000_000)
  })
})

describe('پیش‌نمایش: همان عددی که بعداً کسر می‌شود', () => {
  test('پیش‌نمایش چیزی نمی‌نویسد و همان مالیات/خالصِ اجرا را نشان می‌دهد', async () => {
    const world = makeWorld({
      accounts: [{ id: 'acc-s', playerId: SENDER, balance: 30_000_000 }],
      rows: [fundingRow(SENDER, 30_000_000)]
    })
    const service = makeService(world, PLAYERS)

    const preview = await service.preview(100n, 200n, 7_000_000)
    expect(preview.gross).toBe(7_000_000)
    expect(preview.tax).toBe(7_000)
    expect(preview.net).toBe(6_993_000)
    expect(preview.affordable).toBe(true)
    expect(preview.remainingToday).toBe(50_000_000)
    expect(world.rows.filter((row) => row.type === 'BANK_TRANSFER')).toHaveLength(0)

    const executed = await service.execute(100n, 200n, 7_000_000)
    expect(executed.tax).toBe(preview.tax)
    expect(executed.net).toBe(preview.net)
  })
})

describe('مبالغِ نامعتبر', () => {
  test('زیرِ کف، اعشاری و نامتناهی رد می‌شوند', async () => {
    const world = makeWorld({ accounts: [{ id: 'acc-s', playerId: SENDER, balance: 1_000_000 }] })
    const service = makeService(world, PLAYERS)

    await expect(service.execute(100n, 200n, 1_000)).rejects.toThrow(ValidationError)
    await expect(service.execute(100n, 200n, 1_500.5)).rejects.toThrow(ValidationError)
    await expect(service.execute(100n, 200n, Number.POSITIVE_INFINITY)).rejects.toThrow(ValidationError)
    expect(world.rows).toHaveLength(0)
  })

  test('Decimal دقیقاً به عدد صحیح تبدیل می‌شود', () => {
    expect(Number(new Prisma.Decimal(9_990_000))).toBe(9_990_000)
  })
})
