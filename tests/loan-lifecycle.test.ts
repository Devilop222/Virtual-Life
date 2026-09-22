import { BankingRepository } from '../src/database/repositories/banking.repository'
import {
  LOAN_GRACE_DAYS,
  defaultDeadline,
  loanLifecycle,
  loanWarningText
} from '../src/modules/banking/loan-lifecycle'
import { REAL_MS_PER_GAME_DAY, gameDays } from '../src/utils/game-time'
import { createFakeDb } from './helpers/fake-db'

/**
 * چرخهٔ عمر وام بانکی — آزمونِ دو لایه:
 *
 *  ۱. منطقِ خالص (`loanLifecycle`) که پنل، Sweep و هشدار از آن می‌خوانند.
 *  ۲. نکولِ واقعی روی یک دیتابیس درون‌حافظه‌ای با تراکنشِ برگشت‌پذیر.
 *
 * چرا این دو با هم؟ چون خطر اصلی این قابلیت «سبز بودنِ بی‌معنا» است: می‌توان
 * خروجیِ درستِ یک تابع را آزمود در حالی که وثیقه هرگز تملک نمی‌شود. لایهٔ دوم
 * حالتِ نهاییِ واقعی (مالکیت، خزانه، صندوق، دفتر کل) را می‌سنجد.
 */
describe('loanLifecycle — وضعیت مشتق‌شدهٔ وام', () => {
  const day = REAL_MS_PER_GAME_DAY
  const now = 1_800_000_000_000

  test('وامِ دور از سررسید «فعال» است و روزهای باقی‌مانده را می‌دهد', () => {
    const state = loanLifecycle({ status: 'ACTIVE', dueAt: now + 20 * day, now })
    expect(state.state).toBe('ACTIVE')
    expect(state.daysUntilDue).toBe(20)
    expect(state.shouldDefault).toBe(false)
    expect(state.isTerminal).toBe(false)
  })

  test('چند روز مانده به سررسید، هشدارِ «نزدیک سررسید» می‌دهد', () => {
    const state = loanLifecycle({ status: 'ACTIVE', dueAt: now + 2 * day, now })
    expect(state.state).toBe('DUE_SOON')
    expect(loanWarningText(state)).not.toBeNull()
  })

  test('سررسیدگذشته ولی داخل مهلت: معوق است، ولی هنوز نکول نمی‌شود', () => {
    const state = loanLifecycle({ status: 'ACTIVE', dueAt: now - 3 * day, now })
    expect(state.state).toBe('OVERDUE')
    expect(state.daysPastDue).toBe(3)
    expect(state.shouldDefault).toBe(false)
    expect(state.graceDaysLeft).toBe(LOAN_GRACE_DAYS - 3)
    expect(loanWarningText(state)).not.toBeNull()
  })

  test('گذشتنِ مهلت یعنی نکولِ واجب — دقیقاً یک میلی‌ثانیه بعد از پایان مهلت', () => {
    // یک میلی‌ثانیه پیش از پایان مهلت: هنوز واجدِ شرایط نیست
    const justInside = loanLifecycle({
      status: 'ACTIVE',
      dueAt: now - gameDays(LOAN_GRACE_DAYS) + 1,
      now
    })
    expect(justInside.shouldDefault).toBe(false)

    // خودِ لحظهٔ پایان مهلت: واجدِ شرایط است
    const justOutside = loanLifecycle({
      status: 'ACTIVE',
      dueAt: now - gameDays(LOAN_GRACE_DAYS),
      now
    })
    expect(justOutside.shouldDefault).toBe(true)
    expect(loanWarningText(justOutside)).toContain('آستانهٔ نکول')
  })

  test('وضعیت‌های پایانی هرگز دوباره نکول نمی‌شوند', () => {
    for (const status of ['PAID', 'DEFAULTED', 'CLOSED']) {
      const state = loanLifecycle({ status, dueAt: now - 100 * day, now })
      expect(state.isTerminal).toBe(true)
      expect(state.shouldDefault).toBe(false)
      expect(loanWarningText(state)).toBeNull()
    }
  })

  test('روزها روی تقویمِ بازی شمرده می‌شوند (هر روزِ بازی = ۴۸ دقیقهٔ واقعی)', () => {
    // سه «روزِ بازی» جلوتر: عددی که به بازیکن نشان داده می‌شود هم همان ۳ است،
    // نه ۳ روزِ واقعی — یعنی نمایش با ساعتِ مرکزی بازی یکی است.
    const state = loanLifecycle({ status: 'ACTIVE', dueAt: now + gameDays(3), now })
    expect(state.daysUntilDue).toBe(3)
    expect(REAL_MS_PER_GAME_DAY).toBe(2_880_000)
  })

  test('مهلت دقیقاً ۷ روزِ بازی است و از `gameDays` مشتق می‌شود', () => {
    expect(defaultDeadline(now) - now).toBe(gameDays(LOAN_GRACE_DAYS))
    expect(LOAN_GRACE_DAYS).toBe(7)
  })
})

describe('BankingRepository — نکول و تملک وثیقه', () => {
  const now = 1_800_000_000_000
  /** سررسیدی که از مهلت گذشته — یعنی واجدِ شرایطِ نکول. */
  const longOverdue = new Date(now - gameDays(LOAN_GRACE_DAYS + 2))

  function seedLoan(overrides: Record<string, unknown> = {}) {
    return {
      id: 'loan-1',
      playerId: 'player-1',
      principalAmount: 5_000_000,
      totalRepaymentAmount: 5_900_000,
      remainingAmount: 5_900_000,
      interestRatePercent: 18,
      status: 'ACTIVE',
      dueAt: longOverdue,
      collateralPropertyId: null,
      collateralBusinessId: null,
      ...overrides
    }
  }

  function build(seed: Parameters<typeof createFakeDb>[0]) {
    const fake = createFakeDb(seed)
    const repo = new BankingRepository(fake.db)
    return { fake, repo }
  }

  test('هنوز سررسید نرسیده: هیچ تغییری رخ نمی‌دهد', async () => {
    const { fake, repo } = build({
      players: [{ id: 'player-1', balance: 1_000_000, status: 'ACTIVE' }],
      loans: [seedLoan({ dueAt: new Date(now + 5 * REAL_MS_PER_GAME_DAY) })],
      properties: [
        { id: 'prop-1', ownerId: 'player-1', title: 'خانه', status: 'OWNED', baseAssetValue: 6_000_000 }
      ],
      businesses: []
    })
    fake.state.loans[0]!.collateralPropertyId = 'prop-1'

    const outcome = await repo.defaultLoan('loan-1', now)

    expect(outcome).toBeNull()
    expect(fake.state.loans[0]!.status).toBe('ACTIVE')
    expect(fake.state.properties[0]!.ownerId).toBe('player-1')
  })

  test('وثیقهٔ ملکی: ملک تملک و به بازار برمی‌گردد، اجاره بسته می‌شود، کیف پول دست نمی‌خورد', async () => {
    const { fake, repo } = build({
      players: [{ id: 'player-1', balance: 2_500_000, status: 'ACTIVE' }],
      loans: [seedLoan({ collateralPropertyId: 'prop-1' })],
      properties: [
        {
          id: 'prop-1',
          ownerId: 'player-1',
          title: 'خانه ویلایی',
          status: 'OWNED',
          baseAssetValue: 25_000_000,
          isListedForRent: true,
          isFurnished: true
        }
      ]
    })
    // جدول rentalContract در fake نیست؛ برای همین از یک شیء با همان رفتار استفاده
    // می‌کنیم: نکول باید قرارداد اجارهٔ فعال را ببندد تا مستأجر در ملکِ
    // تملک‌شده نماند.
    ;(fake.db as unknown as { rentalContract: unknown }).rentalContract = {
      updateMany: jest.fn(async () => ({ count: 1 }))
    }

    const outcome = await repo.defaultLoan('loan-1', now)

    expect(outcome).not.toBeNull()
    expect(outcome!.collateral).toBe('PROPERTY')
    expect(outcome!.collateralTitle).toBe('خانه ویلایی')
    // ملک از مالکیت خارج و قابل خرید مجدد شده است
    const property = fake.state.properties[0]!
    expect(property.ownerId).toBeNull()
    expect(property.status).toBe('AVAILABLE')
    expect(property.isListedForRent).toBe(false)
    expect(property.isFurnished).toBe(false)
    // قرارداد اجارهٔ فعال بسته شده تا مستأجر در ملکِ تملک‌شده نماند
    const rentalContract = (fake.db as unknown as { rentalContract: { updateMany: jest.Mock } })
      .rentalContract
    expect(rentalContract.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { propertyId: 'prop-1', isActive: true } })
    )
    // هیچ پولی ساخته یا سوزانده نشد: ملک بخشی از عرضهٔ پول نبود
    expect(outcome!.recovered).toBe(0)
    expect(fake.state.pool[0]!.balance).toBe(0)
    // کیف پول و دفتر بازیکن دست‌نخورده: نکول فقط داراییِ وثیقه‌ای را می‌گیرد
    expect(fake.state.players[0]!.balance).toBe(2_500_000)
    expect(fake.state.transactions).toHaveLength(0)
    // بدهیِ وصول‌نشده ناپدید نمی‌شود
    expect(outcome!.writtenOff).toBe(5_900_000)
    expect(Number(fake.state.loans[0]!.remainingAmount)).toBe(5_900_000)
    expect(fake.state.loans[0]!.status).toBe('DEFAULTED')
    // هرگز اجارهٔ پرداخت‌شده پس گرفته نمی‌شود (هیچ ردیفِ اضافه‌ای ساخته نشده)
    expect(fake.state.transactions).toHaveLength(0)
  })

  test('وثیقهٔ شرکتی: خزانه به صندوق بانک می‌رسد، شرکت ورشکسته و کارمندان/شعبه/آگهی بسته می‌شوند', async () => {
    const { fake, repo } = build({
      players: [{ id: 'player-1', balance: 700_000, status: 'ACTIVE' }],
      loans: [seedLoan({ collateralBusinessId: 'biz-1' })],
      businesses: [
        {
          id: 'biz-1',
          ownerId: 'player-1',
          name: 'فروشگاه محلی',
          treasury: 3_000_000,
          status: 'ACTIVE',
          activeEmployees: 3
        }
      ]
    })
    const calls = {
      employee: jest.fn(async () => ({ count: 3 })),
      posting: jest.fn(async () => ({ count: 2 })),
      branch: jest.fn(async () => ({ count: 1 })),
      session: jest.fn(async () => ({ count: 1 }))
    }
    Object.assign(fake.db as unknown as Record<string, unknown>, {
      businessEmployee: { updateMany: calls.employee },
      jobPosting: { updateMany: calls.posting },
      businessBranch: { updateMany: calls.branch },
      workSession: { updateMany: calls.session }
    })

    const outcome = await repo.defaultLoan('loan-1', now)

    expect(outcome!.collateral).toBe('BUSINESS')
    expect(outcome!.recovered).toBe(3_000_000)
    expect(outcome!.writtenOff).toBe(2_900_000)

    // خزانه تخلیه شد و پول به صندوق بانک رسید (جابه‌جاییِ واقعی، بدون ساخت پول)
    expect(fake.state.businesses[0]!.treasury).toBe(0)
    expect(fake.state.businesses[0]!.status).toBe('BANKRUPT')
    expect(fake.state.businesses[0]!.activeEmployees).toBe(0)
    expect(fake.state.pool[0]!.balance).toBe(3_000_000)
    expect(fake.state.pool[0]!.totalRepaid).toBe(3_000_000)

    // ردیف دفتریِ تملک با مبدأ کسب‌وکار (نه بازیکن): دفترِ بازیکن آلوده نمی‌شود
    expect(fake.state.transactions).toHaveLength(1)
    const row = fake.state.transactions[0]!
    expect(row.type).toBe('LOAN_COLLATERAL_SEIZED')
    expect(row.sourceBusinessId).toBe('biz-1')
    expect(row.sourcePlayerId).toBeUndefined()
    expect(Number(row.amount)).toBe(3_000_000)

    // بستنِ کاملِ کسب‌وکار
    for (const call of Object.values(calls)) {
      expect(call).toHaveBeenCalledTimes(1)
    }
    expect(calls.session).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'CANCELLED' }) })
    )

    // کیف پول بازیکن دست‌نخورده (نکول از داراییِ وثیقه می‌گیرد، نه از کیف)
    expect(fake.state.players[0]!.balance).toBe(700_000)
    expect(fake.state.transactions.some((r) => r.sourcePlayerId === 'player-1')).toBe(false)
  })

  test('هرگز دوبار نکول نمی‌شود — اجرای دوباره هیچ اثری ندارد', async () => {
    const { fake, repo } = build({
      players: [{ id: 'player-1', balance: 0, status: 'ACTIVE' }],
      loans: [seedLoan({ collateralBusinessId: 'biz-1' })],
      businesses: [
        { id: 'biz-1', ownerId: 'player-1', name: 'کارگاه', treasury: 2_000_000, status: 'ACTIVE' }
      ]
    })
    Object.assign(fake.db as unknown as Record<string, unknown>, {
      businessEmployee: { updateMany: jest.fn(async () => ({ count: 1 })) },
      jobPosting: { updateMany: jest.fn(async () => ({ count: 0 })) },
      businessBranch: { updateMany: jest.fn(async () => ({ count: 0 })) },
      workSession: { updateMany: jest.fn(async () => ({ count: 0 })) }
    })

    const first = await repo.defaultLoan('loan-1', now)
    const poolAfterFirst = fake.state.pool[0]!.balance
    const second = await repo.defaultLoan('loan-1', now)

    expect(first).not.toBeNull()
    expect(second).toBeNull()
    // پول دوبار به صندوق نرسیده و ردیف دفتری تکراری ساخته نشده
    expect(fake.state.pool[0]!.balance).toBe(poolAfterFirst)
    expect(fake.state.transactions).toHaveLength(1)
    expect(fake.state.loans[0]!.status).toBe('DEFAULTED')
  })

  test('چرخه فقط وام‌های سررسیدگذشته را برمی‌دارد و برای هر کدام نتیجه می‌دهد', async () => {
    const { fake, repo } = build({
      players: [
        { id: 'player-1', balance: 0, status: 'ACTIVE' },
        { id: 'player-2', balance: 0, status: 'ACTIVE' }
      ],
      loans: [
        seedLoan({ id: 'loan-1', playerId: 'player-1' }),
        seedLoan({ id: 'loan-2', playerId: 'player-2' }),
        seedLoan({ id: 'loan-3', playerId: 'player-2', dueAt: new Date(now + REAL_MS_PER_GAME_DAY) }),
        seedLoan({ id: 'loan-4', playerId: 'player-2', status: 'PAID' })
      ]
    })

    const outcomes = await repo.defaultOverdueLoans(20, now)

    expect(outcomes.map((o) => o.loanId).sort()).toEqual(['loan-1', 'loan-2'])
    expect(fake.state.loans.find((l) => l.id === 'loan-3')!.status).toBe('ACTIVE')
    expect(fake.state.loans.find((l) => l.id === 'loan-4')!.status).toBe('PAID')
  })

  test('محدودسازی به یک بازیکن: پنل بانک فقط وامِ خودش را نکول می‌کند', async () => {
    const { fake, repo } = build({
      players: [
        { id: 'player-1', balance: 0, status: 'ACTIVE' },
        { id: 'player-2', balance: 0, status: 'ACTIVE' }
      ],
      loans: [
        seedLoan({ id: 'loan-1', playerId: 'player-1' }),
        seedLoan({ id: 'loan-2', playerId: 'player-2' })
      ]
    })

    const outcomes = await repo.defaultOverdueLoans(20, now, 'player-1')

    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]!.playerId).toBe('player-1')
    expect(fake.state.loans.find((l) => l.id === 'loan-2')!.status).toBe('ACTIVE')
  })

  test('آشتی صندوق: موجودی صندوق دقیقاً به‌اندازهٔ خزانهٔ تملک‌شده بالا می‌رود', async () => {
    const { fake, repo } = build({
      players: [{ id: 'player-1', balance: 0, status: 'ACTIVE' }],
      loans: [seedLoan({ collateralBusinessId: 'biz-1' })],
      businesses: [
        { id: 'biz-1', ownerId: 'player-1', name: 'شرکت', treasury: 1_250_000, status: 'ACTIVE' }
      ]
    })
    Object.assign(fake.db as unknown as Record<string, unknown>, {
      businessEmployee: { updateMany: jest.fn(async () => ({ count: 0 })) },
      jobPosting: { updateMany: jest.fn(async () => ({ count: 0 })) },
      businessBranch: { updateMany: jest.fn(async () => ({ count: 0 })) },
      workSession: { updateMany: jest.fn(async () => ({ count: 0 })) }
    })
    const poolBefore = Number(fake.state.pool[0]!.balance)

    await repo.defaultLoan('loan-1', now)

    const poolAfter = Number(fake.state.pool[0]!.balance)
    const ledger = fake.state.transactions.reduce((sum, r) => sum + Number(r.amount), 0)
    // افزایش صندوق = ردیف دفتری = مقدار تخلیه‌شدهٔ خزانه (هیچ پولِ بی‌ثبتی)
    expect(poolAfter - poolBefore).toBe(1_250_000)
    expect(ledger).toBe(1_250_000)
  })
})
