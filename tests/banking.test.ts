import { Prisma, PrismaClient } from '@prisma/client'
import { BankingService } from '../src/modules/banking/banking.service'
import { BankPoolService } from '../src/modules/banking/bank-pool.service'
import { BANK_POOL_ID, BANK_POOL_SEED } from '../src/config/economy'
import { BankingRepository } from '../src/database/repositories/banking.repository'
import { REAL_MS_PER_GAME_DAY, cycleRate } from '../src/utils/game-time'
import { PlayerRepository } from '../src/database/repositories/player.repository'
import { HousingRepository } from '../src/database/repositories/housing.repository'
import { BusinessRepository } from '../src/database/repositories/business.repository'
import { CreditService } from '../src/modules/finance/credit.service'
import { DEFAULT_ACCOUNT_ANNUAL_RATE } from '../src/modules/banking/interest-rate'
import { ValidationError, ConflictError } from '../src/utils/classes/errors'

describe('Banking & Loan Systems', () => {
  let bankingRepo: {
    findAccountByPlayerId: jest.Mock
    createAccount: jest.Mock
    deposit: jest.Mock
    withdraw: jest.Mock
    disburseLoan: jest.Mock
    listActiveLoans: jest.Mock
    settleInterest: jest.Mock
    repayLoan: jest.Mock
  }
  let playerRepo: { findByTelegramUserId: jest.Mock }
  let housingRepo: { findById: jest.Mock }
  let businessRepo: { findById: jest.Mock }
  let creditRepo: { getCreditProfile: jest.Mock }
  let service: BankingService

  beforeEach(() => {
    bankingRepo = {
      findAccountByPlayerId: jest.fn(),
      createAccount: jest.fn(),
      deposit: jest.fn(),
      withdraw: jest.fn(),
      disburseLoan: jest.fn(),
      listActiveLoans: jest.fn(),
      settleInterest: jest.fn(),
      repayLoan: jest.fn()
    }
    playerRepo = { findByTelegramUserId: jest.fn() }
    housingRepo = { findById: jest.fn() }
    businessRepo = { findById: jest.fn() }
    creditRepo = {
      getCreditProfile: jest.fn().mockResolvedValue({
        score: 700,
        grade: 'A',
        gradeLabel: 'عالی',
        cashBalance: 0,
        bankBalance: 0,
        assetValue: 20_000_000,
        totalDebt: 0,
        netWorth: 20_000_000,
        activeLoans: 0,
        repaidLoans: 0,
        hasJob: true,
        maxLoanAmount: 60_000_000,
        factors: []
      })
    }

    service = new BankingService(
      bankingRepo as unknown as BankingRepository,
      playerRepo as unknown as PlayerRepository,
      housingRepo as unknown as HousingRepository,
      businessRepo as unknown as BusinessRepository,
      creditRepo as unknown as CreditService
    )
  })

  describe('Card Number Generation', () => {
    test('generates valid 16-digit game card format', () => {
      const card = service.generateGameCardNumber()
      expect(card).toMatch(/^6037-\d{4}-\d{4}-\d{4}$/)
    })
  })

  describe('Deposits & Withdrawals', () => {
    test('rejects negative or zero deposit', async () => {
      await expect(service.deposit(42n, 0)).rejects.toThrow(ValidationError)
      await expect(service.deposit(42n, -500)).rejects.toThrow(ValidationError)
    })

    test('rejects non-integer or unsafe deposit amounts', async () => {
      await expect(service.deposit(42n, 1.5)).rejects.toThrow(ValidationError)
      await expect(service.deposit(42n, Number.NaN)).rejects.toThrow(ValidationError)
      await expect(service.deposit(42n, Number.POSITIVE_INFINITY)).rejects.toThrow(ValidationError)
    })

    test('delegates the balance check to the atomic repository layer', async () => {
      // بررسی موجودی به‌صورت اتمیک در Repository انجام می‌شود (محافظت Race Condition)
      playerRepo.findByTelegramUserId.mockResolvedValue({ id: 'p1', balance: 100 })
      bankingRepo.deposit.mockRejectedValue(
        new ValidationError('Insufficient wallet funds', 'موجودی کافی نیست.')
      )

      await expect(service.deposit(42n, 500)).rejects.toThrow(ValidationError)
      expect(bankingRepo.deposit).toHaveBeenCalledWith('p1', 500)
    })

    test('successfully processes valid deposit', async () => {
      playerRepo.findByTelegramUserId.mockResolvedValue({ id: 'p1', balance: 1000 })
      bankingRepo.deposit.mockResolvedValue({ walletBalance: 500, bankBalance: 500 })

      const res = await service.deposit(42n, 500)
      expect(res.walletBalance).toBe(500)
      expect(res.bankBalance).toBe(500)
    })
  })

  describe('Collateral Loans', () => {
    test('rejects loan request if an active loan is already outstanding', async () => {
      playerRepo.findByTelegramUserId.mockResolvedValue({ id: 'p1' })
      bankingRepo.listActiveLoans.mockResolvedValue([{ id: 'loan-1', remainingAmount: 5000 }])

      await expect(service.requestCollateralLoan(42n, 'prop-1')).rejects.toThrow(ConflictError)
    })

    test('rejects loan request without any collateral', async () => {
      playerRepo.findByTelegramUserId.mockResolvedValue({ id: 'p1' })
      bankingRepo.listActiveLoans.mockResolvedValue([])

      await expect(service.requestCollateralLoan(42n)).rejects.toThrow(ValidationError)
    })

    test('disburses loan against verified property asset', async () => {
      playerRepo.findByTelegramUserId.mockResolvedValue({ id: 'p1' })
      bankingRepo.listActiveLoans.mockResolvedValue([])
      housingRepo.findById.mockResolvedValue({
        id: 'prop-1',
        ownerId: 'p1',
        baseAssetValue: 20_000_000
      })
      bankingRepo.disburseLoan.mockResolvedValue({
        id: 'loan-1',
        principalAmount: 10_000_000,
        totalRepaymentAmount: 10_046_667
      })

      const loan = await service.requestCollateralLoan(42n, 'prop-1')
      // گرید اعتباری این پروفایل «A» است؛ نرخ ۱۴٪ روی دورهٔ بازی (هم‌تراز با ریتم تازه)
      expect(bankingRepo.disburseLoan).toHaveBeenCalledWith(
        'p1',
        10_000_000,
        10_046_667,
        cycleRate(14),
        30,
        'prop-1',
        undefined
      )
      expect(loan.principalAmount).toBe(10_000_000)
    })
  })

  describe('Interest Settlement & Loan Repayment', () => {
    test('settles accrued interest idempotently through repository', async () => {
      playerRepo.findByTelegramUserId.mockResolvedValue({ id: 'p1' })
      bankingRepo.findAccountByPlayerId.mockResolvedValue({
        id: 'acc-1',
        balance: 1_000_000
      })
      bankingRepo.settleInterest.mockResolvedValue({
        interestAccrued: 4_110,
        newBalance: 1_004_110
      })

      const res = await service.settleAccountInterest(42n)
      // نرخ دیگر از بیرون پاس داده نمی‌شود؛ منبعِ واحد نرخ، ستونِ خودِ حساب است.
      expect(bankingRepo.settleInterest).toHaveBeenCalledWith('p1')
      expect(res.interestAccrued).toBe(4110)
    })

    test('rejects loan repayment with missing loan id', async () => {
      await expect(service.repayLoan(42n, '')).rejects.toThrow(ValidationError)
    })

    test('repays loan and returns updated remaining balance', async () => {
      playerRepo.findByTelegramUserId.mockResolvedValue({ id: 'p1' })
      bankingRepo.repayLoan.mockResolvedValue({
        id: 'loan-1',
        remainingAmount: 10_000_000
      })

      const res = await service.repayLoan(42n, 'loan-1')
      expect(bankingRepo.repayLoan).toHaveBeenCalledWith('loan-1', 'p1', 1_000_000)
      expect(res.remainingAmount).toBe(10_000_000)
    })
  })
})

// ──────────────────────────────────────────────────────────────────────────────
//  صندوق بانک — ترازنامهٔ واقعی (پول وام و سود سپرده از هیچ ساخته نمی‌شود)
// ──────────────────────────────────────────────────────────────────────────────
describe('BankPoolService — real bank balance sheet', () => {
  const LOAN = {
    id: 'loan-1',
    playerId: 'p1',
    principalAmount: 10_000_000,
    totalRepaymentAmount: 11_800_000,
    remainingAmount: 11_800_000,
    interestRatePercent: 18,
    status: 'ACTIVE'
  }

  function makeRepoDb(poolBalance: number, debitCount = 1, loan: Record<string, unknown> = LOAN) {
    const tx = {
      loan: {
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn().mockResolvedValue(LOAN),
        findUnique: jest.fn().mockResolvedValue(loan),
        findUniqueOrThrow: jest.fn().mockResolvedValue(loan),
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      },
      player: {
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      },
      bankPool: {
        findUnique: jest.fn().mockResolvedValue({ balance: poolBalance }),
        upsert: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: debitCount })
      },
      financialTransaction: { create: jest.fn().mockResolvedValue({}) }
    }
    const db = { $transaction: jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx)) }
    return { db, tx }
  }

  test('a loan is paid out of the pool, not minted', async () => {
    const { db, tx } = makeRepoDb(500_000_000)
    const repo = new BankingRepository(db as unknown as PrismaClient)

    await repo.disburseLoan('p1', 10_000_000, 11_800_000, 18, 30)

    const debit = tx.bankPool.updateMany.mock.calls[0][0]
    expect(debit.where.id).toBe(BANK_POOL_ID)
    expect(debit.where.balance.gte).toBe(10_000_000)
    expect(debit.data.balance.decrement).toBe(10_000_000)
    expect(tx.player.update.mock.calls[0][0].data.balance.increment).toBe(10_000_000)
  })

  test('a loan is refused when the bank has no liquidity (no money from nothing)', async () => {
    const { db, tx } = makeRepoDb(0, 0)
    const repo = new BankingRepository(db as unknown as PrismaClient)

    await expect(repo.disburseLoan('p1', 10_000_000, 11_800_000, 18, 30)).rejects.toThrow(ConflictError)
    expect(tx.player.update).not.toHaveBeenCalled()
    expect(tx.financialTransaction.create).not.toHaveBeenCalled()
  })

  test('a repayment returns principal and interest to the pool with split ledger rows', async () => {
    const { db, tx } = makeRepoDb(0)
    const repo = new BankingRepository(db as unknown as PrismaClient)

    await repo.repayLoan('loan-1', 'p1', 1_180_000)

    // سهم سود = ۱٫۸ م از ۱۱٫۸ م ≈ ۱۵٫۲۵٪ ⇒ از ۱٬۱۸۰٬۰۰۰ قسط:
    // ۱۸۰٬۰۰۰ سود بانک و ۱٬۰۰۰٬۰۰۰ بازگشت اصل
    const credit = tx.bankPool.update.mock.calls[0][0]
    expect(credit.data.totalLoanInterest.increment).toBe(180_000)
    expect(credit.data.totalRepaid.increment).toBe(1_000_000)
    expect(credit.data.balance.increment).toBe(1_180_000)

    const rows = tx.financialTransaction.create.mock.calls.map((c) => c[0].data)
    const principalRow = rows.find((r) => r.type === 'LOAN_REPAYMENT')
    const interestRow = rows.find((r) => r.type === 'LOAN_INTEREST')
    expect(principalRow.amount + interestRow.amount).toBe(1_180_000)
  })

  test('the seed is one-time: ensure never adds it twice', async () => {
    const tx = {
      bankPool: {
        upsert: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn().mockResolvedValue({ balance: BANK_POOL_SEED })
      }
    }
    const pool = new BankPoolService()

    await pool.ensure(tx as never)
    await pool.ensure(tx as never)

    expect(tx.bankPool.upsert).toHaveBeenCalledTimes(2)
    for (const call of tx.bankPool.upsert.mock.calls) {
      expect(call[0].create.balance).toBe(BANK_POOL_SEED)
      // ردیف موجود فقط no-op می‌گیرد؛ بذر دوباره پاشیده نمی‌شود
      expect(call[0].update.balance.increment).toBe(0)
    }
  })

  test('a concurrent drain cannot take the pool below zero', async () => {
    const tx = {
      bankPool: {
        upsert: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn().mockResolvedValue({ balance: 5_000 }),
        updateMany: jest.fn().mockResolvedValue({ count: 0 })
      }
    }
    const pool = new BankPoolService()

    expect(await pool.debitUpTo(tx as never, 9_000)).toBe(0)
    expect(await pool.debit(tx as never, 9_000)).toBe(false)
  })
})

describe('BankingRepository — account interest is paid from the pool', () => {
  const TEN_DAYS_MS = 10 * 24 * 60 * 60 * 1000

  function makeInterestDb(poolPaid: number) {
    const lastInterestAt = new Date(Date.now() - TEN_DAYS_MS)
    const tx = {
      bankAccount: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'acc-1',
          playerId: 'p1',
          balance: 1_000_000,
          lastInterestAt,
          status: 'ACTIVE',
          // همان `@default(0.15)` اسکیما — حساب عادی سالانه ۱۵٪ سود می‌دهد
          interestRateAnnual: DEFAULT_ACCOUNT_ANNUAL_RATE
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn().mockResolvedValue({ balance: 1_000_000 + poolPaid })
      },
      bankPool: {
        findUnique: jest.fn().mockResolvedValue({ balance: poolPaid }),
        upsert: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: poolPaid > 0 ? 1 : 0 }),
        update: jest.fn().mockResolvedValue({})
      },
      financialTransaction: { create: jest.fn().mockResolvedValue({}) }
    }
    const db = { $transaction: jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx)) }
    return { repo: new BankingRepository(db as unknown as PrismaClient), tx }
  }

  test('a solvent bank pays the full daily interest from the pool', async () => {
    const { repo, tx } = makeInterestDb(100_000)
    // نرخ روزانه در سرویس بانک با ریتم تازهٔ بازی هم‌تراز می‌شود؛ تست هم همان مسیر را می‌رود.
    const result = await repo.settleInterest('p1')

    // جریان پولی در زمان واقعی ثابت است: ۱۰ روز واقعی × ۱٬۰۰۰٬۰۰۰ × ۰٬۰۰۰۴۱۱ = ۴٬۱۱۰.
    // عدد از نرخِ سالانهٔ حساب مشتق می‌شود (۱۵٪ ÷ ۳۶۵ ÷ ۳۰)، پس نتیجهٔ قبلی
    // دست‌نخورده مانده و فقط منبعِ نرخ یکی شده است.
    expect(result.interestAccrued).toBe(4_110)
    expect(tx.financialTransaction.create.mock.calls[0][0].data.type).toBe('DEPOSIT_INTEREST')
  })

  test('an empty pool pays nothing and does not advance the clock (retry later)', async () => {
    const { repo, tx } = makeInterestDb(0)
    const result = await repo.settleInterest('p1')

    expect(result.interestAccrued).toBe(0)
    expect(tx.bankAccount.updateMany).not.toHaveBeenCalled()
    expect(tx.financialTransaction.create).not.toHaveBeenCalled()
  })

describe('BankingRepository — one account per player', () => {
  function uniqueViolation(): unknown {
    return new Prisma.PrismaClientKnownRequestError(
      'Unique constraint failed on the fields: (`player_id`)',
      { code: 'P2002', clientVersion: '6.19.3' }
    )
  }

  function makeDb(createImpl: jest.Mock, existing: unknown) {
    const db = {
      bankAccount: {
        create: createImpl,
        findUnique: jest.fn().mockResolvedValue(existing)
      }
    }
    return { repo: new BankingRepository(db as unknown as PrismaClient), db }
  }

  test('the loser of a concurrent first-use returns the winner’s account', async () => {
    // کلیک دوبله روی «حساب بانکی»: دیتابیس حساب دوم را رد می‌کند و بازیکن
    // باید همان حسابِ ساخته‌شده را بگیرد — نه خطا، نه حسابِ دوم.
    const existing = { id: 'acc-1', playerId: 'p1', balance: 250_000 }
    const { repo, db } = makeDb(jest.fn().mockRejectedValue(uniqueViolation()), existing)

    await expect(repo.createAccount('p1', '6666666666666660')).resolves.toBe(existing)
    expect(db.bankAccount.findUnique).toHaveBeenCalledWith({ where: { playerId: 'p1' } })
  })

  test('a unique violation with nothing behind it is not swallowed', async () => {
    const { repo } = makeDb(jest.fn().mockRejectedValue(uniqueViolation()), null)
    await expect(repo.createAccount('p1', '6666666666666660')).rejects.toThrow(/P2002|Unique/i)
  })

  test('any other database error surfaces unchanged', async () => {
    const failure = new Error('connection closed')
    const { repo, db } = makeDb(jest.fn().mockRejectedValue(failure), { id: 'acc-1' })

    await expect(repo.createAccount('p1', '6666666666666660')).rejects.toBe(failure)
    expect(db.bankAccount.findUnique).not.toHaveBeenCalled()
  })

  test('the account is read through the unique key, so the answer is stable', async () => {
    const { repo, db } = makeDb(jest.fn(), { id: 'acc-1', playerId: 'p1' })

    await expect(repo.findAccountByPlayerId('p1')).resolves.toEqual({ id: 'acc-1', playerId: 'p1' })
    expect(db.bankAccount.findUnique).toHaveBeenCalledWith({ where: { playerId: 'p1' } })
  })
})

  test('a short pool pays what it can and settles only the covered days', async () => {
    const { repo, tx } = makeInterestDb(2_055) // نصف سود ده‌روزه
    const result = await repo.settleInterest('p1')

    expect(result.interestAccrued).toBe(2_055)
    const update = tx.bankAccount.updateMany.mock.calls[0][0]
    expect(update.data.balance.increment).toBe(2_055)
    // دورهٔ تسویه‌شده کمتر از ۱۰ روز است: باقی روزها بدهی صندوق می‌ماند
    const advancedDays =
      (update.data.lastInterestAt.getTime() - (Date.now() - TEN_DAYS_MS)) /
      REAL_MS_PER_GAME_DAY
    // فقط بخشِ پوشش‌داده‌شدهٔ بازه جلو می‌رود: نصف سود ۱۰ روز واقعی = ۱۵۰ روز بازی
    expect(advancedDays).toBeGreaterThanOrEqual(1)
    expect(advancedDays).toBeLessThanOrEqual(150)
  })
})
