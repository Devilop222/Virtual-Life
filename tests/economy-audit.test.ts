import { RegionFundService, TaxService } from '../src/modules/economy/tax.service'
import {
  auditBankPool,
  auditLedger,
  flowOf,
  INTERNAL_PRIVATE_TYPES,
  isInternalPrivateMove,
  moneyInExistence,
  moneySupply,
  publicSectorFlow,
  reconcilePlayer,
  reconcilePrivateSector
} from '../src/modules/economy/money-supply'
import { BANK_POOL_SEED, incomeTaxOf, netOfIncomeTax, TAX_RATES } from '../src/config/economy'

/**
 * ممیزی اقتصاد: مالیات، دفتر کل، عرضهٔ پول و ترازنامهٔ بانک.
 *
 * این آزمون‌ها «سیاست» را نمی‌سنجند؛ فقط تضمین‌های حسابداری را می‌سنجند:
 *   • مالیات درست و از منبع درست
 *   • هر تغییر موجودی، یک ردیف دفتر کل داشته باشد
 *   • پول از هیچ ساخته نشود و ترازنامهٔ بانک بسته بماند
 */

function makeRegionStatTx(balance: number, drainedCount = 1) {
  return {
    regionStat: {
      findUnique: jest.fn().mockResolvedValue({ taxRevenue: balance }),
      updateMany: jest.fn().mockResolvedValue({ count: drainedCount }),
      upsert: jest.fn().mockResolvedValue({})
    }
  }
}

describe('TaxService — income tax at source', () => {
  test('withholds 5% and credits the payer region fund', async () => {
    const tx = {
      player: { findUnique: jest.fn().mockResolvedValue({ homeGroupId: 'g1' }) },
      financialTransaction: { create: jest.fn().mockResolvedValue({}) },
      ...makeRegionStatTx(0)
    }
    const result = await new TaxService().withholdIncomeTax(tx as never, {
      playerId: 'p1',
      gross: 300_000,
      reference: 'حقوق شیفت'
    })

    expect(result.tax).toBe(15_000)
    expect(result.net).toBe(285_000)
    expect(result.groupId).toBe('g1')

    const taxRow = tx.financialTransaction.create.mock.calls[0][0].data
    expect(taxRow.type).toBe('TAX_PAYMENT')
    expect(taxRow.amount).toBe(15_000)
    expect(taxRow.sourcePlayerId).toBe('p1')

    // مالیات به صندوق همان منطقه می‌رود (نه به هیچ)
    const credit = tx.regionStat.upsert.mock.calls[0][0]
    expect(credit.update.taxRevenue.increment).toBe(15_000)
  })

  test('a homeless player pays tax into the global ledger only', async () => {
    const tx = {
      player: { findUnique: jest.fn().mockResolvedValue({ homeGroupId: null }) },
      financialTransaction: { create: jest.fn().mockResolvedValue({}) },
      ...makeRegionStatTx(0)
    }
    const result = await new TaxService().withholdIncomeTax(tx as never, {
      playerId: 'p1',
      gross: 100_000,
      reference: 'اضافه‌کاری'
    })

    expect(result.tax).toBe(5_000)
    expect(tx.regionStat.upsert).not.toHaveBeenCalled()
  })

  test('never taxes negative, NaN or overflowing amounts', () => {
    expect(incomeTaxOf(-100)).toBe(0)
    expect(incomeTaxOf(Number.NaN)).toBe(0)
    expect(incomeTaxOf(Number.POSITIVE_INFINITY)).toBe(0)
    expect(netOfIncomeTax(-5)).toBe(0)
    // سقف ایمنی: حتی با بزرگ‌ترین عدد ممکن، خروجی نامعتبر نمی‌شود
    expect(Number.isSafeInteger(incomeTaxOf(Number.MAX_SAFE_INTEGER))).toBe(true)
    expect(incomeTaxOf(Number.MAX_SAFE_INTEGER)).toBeLessThan(Number.MAX_SAFE_INTEGER)
  })

  test('the profit-tax rate is the single source of truth', () => {
    expect(TAX_RATES.incomeTaxRate).toBe(0.05)
    expect(TAX_RATES.businessProfitTaxRate).toBe(0.15)
    expect(TaxService.profitTax(1_000_000)).toBe(150_000)
    expect(TaxService.incomeTax(1_000_000)).toBe(50_000)
  })

  test('an unpaid profit tax is skipped instead of overdrawing the owner', async () => {
    const tx = {
      player: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      financialTransaction: { create: jest.fn() },
      ...makeRegionStatTx(0)
    }
    const tax = await new TaxService().takeProfitTax(tx as never, {
      playerId: 'p1',
      amount: 1_000_000,
      reference: 'درآمد شعبه',
      groupId: 'g1',
      fromPlayerBalance: true
    })

    expect(tax).toBe(0)
    expect(tx.financialTransaction.create).not.toHaveBeenCalled()
    expect(tx.regionStat.upsert).not.toHaveBeenCalled()
  })
})

describe('RegionFundService — the only writer of the region fund', () => {
  test('debitUpTo never goes below zero', async () => {
    const tx = makeRegionStatTx(200_000)
    const fund = new RegionFundService()

    expect(await fund.debitUpTo(tx as never, 'g1', 500_000)).toBe(200_000)
    expect(tx.regionStat.updateMany.mock.calls[0][0].data.taxRevenue.decrement).toBe(200_000)
  })

  test('a losing race returns zero instead of a negative fund', async () => {
    const tx = makeRegionStatTx(200_000, 0)
    const fund = new RegionFundService()

    expect(await fund.debitUpTo(tx as never, 'g1', 100_000)).toBe(0)
  })

  test('the fund ignores invalid amounts', async () => {
    const tx = makeRegionStatTx(100_000)
    const fund = new RegionFundService()

    expect(await fund.credit(tx as never, 'g1', Number.NaN)).toBe(0)
    expect(await fund.credit(tx as never, 'g1', -50)).toBe(0)
    expect(tx.regionStat.upsert).not.toHaveBeenCalled()
  })
})

describe('money-supply audit', () => {
  const rows = [
    // دستمزد: پول تازه از بخش عمومی
    { amount: 300_000, type: 'SALARY_PAYMENT', destinationPlayerId: 'p1' },
    // مالیات: برگشت به بخش عمومی
    { amount: 15_000, type: 'TAX_PAYMENT', sourcePlayerId: 'p1' },
    // خرید فروشگاه: خروج از گردش
    { amount: 50_000, type: 'TRANSFER', sourcePlayerId: 'p1' },
    // بازار بازیکنی: انتقال داخلی (پول از گردش خارج نمی‌شود)
    { amount: 20_000, type: 'MARKET_TRADE', sourcePlayerId: 'p1', destinationPlayerId: 'p2' }
  ]

  test('every row is classified by its parties, not by its type', () => {
    expect(flowOf(rows[0]!)).toBe('MINT')
    expect(flowOf(rows[1]!)).toBe('BURN')
    expect(flowOf(rows[2]!)).toBe('BURN')
    expect(flowOf(rows[3]!)).toBe('TRANSFER')
    expect(flowOf({ amount: 1_000 })).toBe('SHARED')
  })

  test('a wallet that matches its ledger is reconciled', () => {
    // موجودی p1 = ۳۰۰٬۰۰۰ − ۱۵٬۰۰۰ − ۵۰٬۰۰۰ − ۲۰٬۰۰۰
    const check = reconcilePlayer('p1', 215_000, rows)
    expect(check.ledgerNet).toBe(215_000)
    expect(check.ok).toBe(true)
  })

  test('a missing ledger row is reported as drift', () => {
    // پاداش ۱۰۰٬۰۰۰ بدون ردیف دفتر کل = همان باگ چالش منطقه
    const check = reconcilePlayer('p1', 315_000, rows)
    expect(check.ok).toBe(false)
    expect(check.difference).toBe(100_000)

    const audit = auditLedger(
      [
        { id: 'p1', balance: 315_000 },
        { id: 'p2', balance: 20_000 }
      ],
      rows
    )
    expect(audit.drifted).toBe(1)
    expect(audit.anomalies.some((a) => a.kind === 'LEDGER_DRIFT')).toBe(true)
  })

  test('a transaction with no party at all is an anomaly', () => {
    const audit = auditLedger([{ id: 'p1', balance: 0 }], [{ amount: 5_000, type: 'TRANSFER' }])
    expect(audit.anomalies.some((a) => a.kind === 'SHARED_ENTRY')).toBe(true)
  })

  test('public sector flow balances mints against burns', () => {
    const flow = publicSectorFlow(rows)
    expect(flow.spending).toBe(300_000)
    expect(flow.income).toBe(65_000)
    expect(flow.net).toBe(-235_000) // انقباض ۲۳۵ هزار تومان
  })

  test('money supply counts every place money can sit', () => {
    const supply = moneySupply({
      playerBalances: [100_000, 50_000],
      businessTreasuries: [10_000],
      bankBalances: [5_000],
      lockedDeposits: [1_000],
      regionFunds: [2_000],
      bankPool: 500
    })
    expect(supply.total).toBe(168_500)
    expect(supply.bankPool).toBe(500)
  })

  // ── کیف پول ↔ حسابِ بانکیِ خودِ بازیکن: جابه‌جاییِ داخلیِ بخش خصوصی ────────
  const bankRows = [
    { amount: 300_000, type: 'SALARY_PAYMENT', destinationPlayerId: 'p1' },
    // واریز به حسابِ خودِ بازیکن: در صورت‌حسابِ کیف پول «خروجی» است، ولی پول از
    // بخش خصوصی بیرون نرفته
    { amount: 100_000, type: 'BANK_DEPOSIT', sourcePlayerId: 'p1' },
    { amount: 5_000, type: 'DEPOSIT_INTEREST', destinationPlayerId: 'p1' }
  ]

  test('a bank deposit and withdrawal are not public-sector flows', () => {
    const withoutBank = publicSectorFlow([bankRows[0]!, bankRows[2]!])
    const withBank = publicSectorFlow([
      ...bankRows,
      { amount: 40_000, type: 'BANK_WITHDRAWAL', destinationPlayerId: 'p1' }
    ])

    expect(withBank.income).toBe(withoutBank.income)
    expect(withBank.spending).toBe(withoutBank.spending)
    expect(withBank.mintCount).toBe(withoutBank.mintCount)
    expect(withBank.burnCount).toBe(withoutBank.burnCount)
  })

  test('an internal move is recognised only when a player side exists', () => {
    expect(INTERNAL_PRIVATE_TYPES).toEqual(['BANK_DEPOSIT', 'BANK_WITHDRAWAL'])
    expect(isInternalPrivateMove({ amount: 1, type: 'BANK_DEPOSIT', sourcePlayerId: 'p1' })).toBe(
      true
    )
    // بدون طرف، همان بوی حسابداریِ همیشگی است و باید ناهنجاری شمرده شود
    expect(isInternalPrivateMove({ amount: 1, type: 'BANK_DEPOSIT' })).toBe(false)
    expect(isInternalPrivateMove({ amount: 1, type: 'TRANSFER', sourcePlayerId: 'p1' })).toBe(false)
    expect(isInternalPrivateMove({ amount: 1, sourcePlayerId: 'p1' })).toBe(false)
  })

  test('a player who uses the bank reconciles against total private holdings', () => {
    // کیف پول ۲۰۰٬۰۰۰ + حساب بانکی ۱۰۵٬۰۰۰ = ۳۰۵٬۰۰۰
    const check = reconcilePrivateSector(
      'p1',
      { wallet: 200_000, bankAccounts: [105_000] },
      bankRows
    )

    expect(check.ledgerNet).toBe(305_000)
    expect(check.balance).toBe(305_000)
    expect(check.ok).toBe(true)
  })

  test('a wallet-only reconciliation reports drift for a player who banks', () => {
    // همان داده، فقط با کیف پول: ۵٬۰۰۰ تومان سود به حسابِ بانکی رفته نه به کیف
    // پول، پس آشتیِ کیف‌پولی «اختلاف» می‌دهد در حالی که پولِ بازیکن سرِ جایش است.
    const check = reconcilePlayer('p1', 200_000, bankRows)

    // ledgerNet = ۳۰۰٬۰۰۰ (حقوق) − ۱۰۰٬۰۰۰ (واریز به حساب) + ۵٬۰۰۰ (سود)
    expect(check.ledgerNet).toBe(205_000)
    expect(check.ok).toBe(false)
    expect(check.difference).toBe(-5_000)
  })

  test('auditLedger counts bank balances when they are given', () => {
    const audited = auditLedger([{ id: 'p1', balance: 200_000, bankBalances: [105_000] }], bankRows)
    expect(audited.drifted).toBe(0)

    const walletOnly = auditLedger([{ id: 'p1', balance: 200_000 }], bankRows)
    expect(walletOnly.drifted).toBe(1)
    expect(walletOnly.anomalies.some((a) => a.kind === 'LEDGER_DRIFT')).toBe(true)
  })

  test('locked term deposits are counted once, not in the pool and in a wallet', () => {
    const supply = moneySupply({
      playerBalances: [100_000],
      bankBalances: [20_000],
      lockedDeposits: [50_000],
      bankPool: 500_000
    })

    // `total` جمعِ ادعاها و صندوق‌هاست؛ سپردهٔ مدت‌دار هم ادعاست و هم داخلِ صندوق
    expect(supply.total).toBe(670_000)
    expect(moneyInExistence(supply)).toBe(620_000)

    // اگر صندوق کوچک‌تر از سپرده‌ها باشد، فقط همان اندازه‌ای که پشتوانه دارد کسر می‌شود
    const thinPool = moneySupply({
      playerBalances: [100_000],
      lockedDeposits: [50_000],
      bankPool: 10_000
    })
    expect(moneyInExistence(thinPool)).toBe(160_000 - 10_000)
  })

  test('the bank balance sheet is a closed account', () => {
    const snapshot = {
      balance: BANK_POOL_SEED + 10_000_000 - 4_000_000 + 4_720_000 - 500_000,
      totalDeposited: 10_000_000,
      totalDisbursed: 4_000_000,
      totalRepaid: 4_000_000,
      totalLoanInterest: 720_000,
      totalDepositInterest: 500_000
    }
    expect(auditBankPool(snapshot, BANK_POOL_SEED).ok).toBe(true)

    const tampered = { ...snapshot, balance: snapshot.balance + 1 }
    const check = auditBankPool(tampered, BANK_POOL_SEED)
    expect(check.ok).toBe(false)
    expect(check.difference).toBe(1)
  })
})
