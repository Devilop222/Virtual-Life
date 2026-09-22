import { join } from 'path'
import { PrismaClient } from '@prisma/client'
import { PayrollService } from '../src/modules/occupation/payroll.service'
import {
  GAME_DAYS_PER_MONTH,
  GAME_HOURS_PER_DAY,
  GAME_MINUTES_PER_HOUR,
  REAL_MS_PER_GAME_MINUTE,
  ratePerGameHour
} from '../src/utils/game-time'
import {
  DEFAULT_CONTRACT_GAME_HOURS_PER_MONTH,
  MAX_ACCRUAL_MINUTES,
  MAX_EMPLOYEE_PRODUCTIVITY,
  MIN_EMPLOYEE_PRODUCTIVITY,
  SALARY_MINUTES_PER_DAY,
  creditedWorkMinutes,
  employeeProductivity,
  monthlySalaryFor,
  projectPayroll,
  salaryFromGameHourInput,
  staffPower,
  staffingFactorFromPower
} from '../src/modules/occupation/payroll-math'
import {
  creditedMinutesOf,
  deliveredMinutes,
  type WorkShift
} from '../src/modules/occupation/work-minutes'
import { POST_SALARY_MAX, POST_SALARY_MIN } from '../src/modules/occupation/business.service'
import { readText } from './helpers/source'
import { ConflictError, NotFoundError } from '../src/utils/classes/errors'

/**
 * بازهٔ کوتاه روی ساعت بازی: n دقیقهٔ بازی.
 * تست‌ها با «دقیقهٔ بازی» کار می‌کنند — همان واحدی که دستمزد و درآمد با آن حساب می‌شود.
 */
function minutesAgo(minutes: number): Date {
  return new Date(Date.now() - minutes * REAL_MS_PER_GAME_MINUTE)
}

/** یک شیفتِ تمام‌شده: `minutes` دقیقهٔ بازی کار، که `endedMinutesAgo` دقیقهٔ بازی پیش تمام شده. */
function shift(playerId: string, minutes: number, endedMinutesAgo = 0): WorkShift {
  const endedAt = minutesAgo(endedMinutesAgo)
  return {
    playerId,
    startedAt: new Date(endedAt.getTime() - minutes * REAL_MS_PER_GAME_MINUTE),
    endedAt
  }
}

function makeBusiness(overrides: Record<string, unknown> = {}) {
  const { employees = [], ...rest } = overrides
  return {
    id: 'b1',
    ownerId: 'owner-1',
    name: 'شرکت تست',
    status: 'ACTIVE',
    treasury: 10_000_000,
    baseRevenuePerMinute: 5_000,
    operatingCostPerMinute: 1_000,
    lastPayrollAt: minutesAgo(60),
    // ظرفیت ۴ ⇒ نیروی لازم ۲
    activeEmployees: 2,
    employeeCapacity: 4,
    employees: (employees as Array<Record<string, unknown>>).map((e) => ({
      isActive: true,
      hiredAt: minutesAgo(24 * 60),
      paidUntilAt: null,
      // قراردادِ پیش‌فرض = کار تمام‌وقت؛ تست‌هایی که سقفِ دیگری می‌خواهند
      // خودشان همان فیلد را روی همان کارمند بازنویسی می‌کنند.
      contractMinutesPerMonth: DEFAULT_CONTRACT_GAME_HOURS_PER_MONTH * 60,
      ...e
    })),
    ...rest
  }
}

/**
 * ردیف بازیکنِ پیش‌فرض کارمند: سلامت کامل، بدون خستگی و سابقه، دیپلم.
 * ضریب کارش دقیقاً ۱ می‌شود، پس انتظارهای عددی ساده می‌مانند.
 */
function makePlayerRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    health: 100,
    fatigue: 0,
    experience: 0,
    currentDegree: 'DIPLOMA',
    graduationField: null,
    age: 30,
    // تقویم بازی «هر هفته = یک سال» است؛ شروع از همین حالا ⇒ سن مؤثر = ۳۰
    startedAt: new Date(),
    homeGroupId: 'g1',
    ...overrides
  }
}

function makeTx(
  business: Record<string, unknown>,
  players?: Array<Record<string, unknown>>,
  shifts: WorkShift[] = []
) {
  const rows = players ?? [makePlayerRow('p1'), makePlayerRow('p2')]
  return {
    business: {
      findUnique: jest.fn().mockResolvedValue(business),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({})
    },
    businessEmployee: { update: jest.fn().mockResolvedValue({}) },
    player: {
      update: jest.fn().mockResolvedValue({}),
      // منطقهٔ کارمند + ورودی‌های بهره‌وری، یک‌جا
      findMany: jest.fn().mockResolvedValue(rows)
    },
    playerSkill: { findMany: jest.fn().mockResolvedValue([]) },
    workSession: { findMany: jest.fn().mockResolvedValue(shifts) },
    regionStat: { upsert: jest.fn().mockResolvedValue({}) },
    financialTransaction: { create: jest.fn().mockResolvedValue({}) }
  }
}

function makeDb(
  business: Record<string, unknown>,
  players?: Array<Record<string, unknown>>,
  shifts: WorkShift[] = []
) {
  const tx = makeTx(business, players, shifts)
  const db = {
    business: { findUnique: jest.fn().mockResolvedValue(business) },
    player: {
      findMany: jest.fn().mockResolvedValue(players ?? [makePlayerRow('p1'), makePlayerRow('p2')])
    },
    playerSkill: { findMany: jest.fn().mockResolvedValue([]) },
    workSession: { findMany: jest.fn().mockResolvedValue(shifts) },
    $transaction: jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx))
  }
  return { db, tx }
}

/** دو کارمند با حقوق ۱٬۰۰۰ در دقیقهٔ واقعی که هر دو ۶۰ دقیقهٔ بازی کار کرده‌اند. */
function twoWorkers(overrides: Record<string, unknown> = {}) {
  return makeBusiness({
    employees: [
      { id: 'e1', playerId: 'p1', title: 'کارمند اول', salaryPerMinute: 1_000, unpaidSalary: 0 },
      { id: 'e2', playerId: 'p2', title: 'کارمند دوم', salaryPerMinute: 1_000, unpaidSalary: 0 }
    ],
    ...overrides
  })
}

const TWO_WORKING: WorkShift[] = [shift('p1', 60), shift('p2', 60)]

describe('PayrollService — access control', () => {
  test('throws when the business does not exist', async () => {
    const { db } = makeDb(makeBusiness())
    db.business.findUnique.mockResolvedValue(null)
    const service = new PayrollService(db as unknown as PrismaClient)

    await expect(service.previewSettlement('b1', 'owner-1')).rejects.toThrow(NotFoundError)
  })

  test('rejects a non-owner preview', async () => {
    const { db } = makeDb(makeBusiness())
    const service = new PayrollService(db as unknown as PrismaClient)

    await expect(service.previewSettlement('b1', 'someone-else')).rejects.toThrow(ConflictError)
  })

  test('rejects a non-owner settlement inside the transaction', async () => {
    const { db, tx } = makeDb(makeBusiness())
    const service = new PayrollService(db as unknown as PrismaClient)

    await expect(service.settle('b1', 'someone-else')).rejects.toThrow(ConflictError)
    expect(tx.player.update).not.toHaveBeenCalled()
  })

  test('rejects settlement for an inactive business', async () => {
    const { db } = makeDb(makeBusiness({ status: 'BANKRUPTCY' }))
    const service = new PayrollService(db as unknown as PrismaClient)

    await expect(service.settle('b1', 'owner-1')).rejects.toThrow(ConflictError)
  })
})

describe('کارکرد، نه گذشت زمان: تنها منبع درآمد و حقوق', () => {
  test('کارمندی که در این دوره کار نکرده، حقوقی نمی‌گیرد', async () => {
    // p1 کار کرده، p2 نکرده — با حقوق یکسان
    const { db } = makeDb(twoWorkers(), undefined, [shift('p1', 60)])
    const service = new PayrollService(db as unknown as PrismaClient)

    const result = await service.settle('b1', 'owner-1')

    // ۶۰ دقیقهٔ بازی × ۱٬۰۰۰/۳۰ = ۲٬۰۰۰ برای کارکرده، صفر برای بیکار
    expect(result.lines[0]!.owed).toBe(2_000)
    expect(result.lines[1]!.owed).toBe(0)
    expect(result.paidEmployees).toBe(1)
  })

  test('حقوق به‌ازای کارکرد پاره‌وقت متناسب است، نه تمام‌یا‌هیچ', async () => {
    const { db } = makeDb(twoWorkers(), undefined, [shift('p1', 15), shift('p2', 45)])
    const service = new PayrollService(db as unknown as PrismaClient)

    const result = await service.settle('b1', 'owner-1')

    expect(result.lines[0]!.owed).toBe(500) // ۱۵ × ۱۰۰۰/۳۰
    expect(result.lines[1]!.owed).toBe(1_500) // ۴۵ × ۱۰۰۰/۳۰
  })

  test('کسب‌وکارِ بی‌کارکرد نه درآمدی می‌سازد و نه حقوقی بدهکار می‌شود', async () => {
    const { db } = makeDb(twoWorkers(), undefined, [])
    const service = new PayrollService(db as unknown as PrismaClient)

    const result = await service.settle('b1', 'owner-1')

    expect(result.deliveredMinutes).toBe(0)
    expect(result.grossRevenue).toBe(0)
    expect(result.totalPayroll).toBe(0)
    expect(result.staffPower).toBe(0)
    expect(result.staffingFactor).toBe(0)
  })

  test('مالکِ حاضر در شیفت هم توان تولید می‌سازد', async () => {
    const { db } = makeDb(twoWorkers({ ownerId: 'owner-1' }), undefined, [
      shift('p1', 30),
      shift('owner-1', 30)
    ])
    const service = new PayrollService(db as unknown as PrismaClient)

    const result = await service.settle('b1', 'owner-1')

    // کارمند (۱) + مالکِ شیفت‌دار (۱) = ۲ = نیاز نیرویی ⇒ ضریب کامل
    expect(result.staffPower).toBe(2)
    expect(result.staffingFactor).toBe(1)
  })
})

describe('سقف کارکرد: یک شیفتِ رهاشده ماشین پول نمی‌سازد', () => {
  test('کارکردِ یک شیفت حداکثر یک روزِ کارِ کامل است', () => {
    const endedAt = new Date()
    const startedAt = new Date(endedAt.getTime() - 100 * 60 * REAL_MS_PER_GAME_MINUTE)
    expect(creditedWorkMinutes(startedAt, endedAt)).toBe(SALARY_MINUTES_PER_DAY)
  })

  test('شیفتِ بی‌مدت کارکرد نمی‌سازد و شیفتِ وارونه منفی نمی‌شود', () => {
    const now = new Date()
    expect(creditedWorkMinutes(now, now)).toBe(0)
    expect(creditedWorkMinutes(now, new Date(now.getTime() - 60_000))).toBe(0)
  })

  test('دقیقه‌های کارِ فراتر از سقف روزانه پرداخت نمی‌شوند', async () => {
    const business = makeBusiness({
      // پنجرهٔ یک روزِ کاملِ بازی، تا سقفِ شیفت چیزی باشد که واقعاً محدود می‌کند
      lastPayrollAt: minutesAgo(GAME_HOURS_PER_DAY * GAME_MINUTES_PER_HOUR),
      employees: [
        { id: 'e1', playerId: 'p1', title: 'کارمند', salaryPerMinute: 1_000, unpaidSalary: 0 }
      ]
    })
    // بیست ساعت بازی کار در یک شیفت واحد
    const { db } = makeDb(business, undefined, [shift('p1', 20 * 60, 5)])
    const service = new PayrollService(db as unknown as PrismaClient)

    const result = await service.settle('b1', 'owner-1')

    // ۸ ساعت بازی (۴۸۰ دقیقه) سقف است: ۴۸۰ × ۱۰۰۰/۳۰ = ۱۶٬۰۰۰
    expect(result.lines[0]!.owed).toBe(16_000)
  })

  test('درآمد از ساعت کاریِ کسب‌وکار بیشتر نمی‌شود، حتی اگر کارکرد زیاد باشد', () => {
    const projection = projectPayroll({
      baseRevenuePerMinute: 5_000,
      operatingCostPerMinute: 0,
      activeEmployees: 2,
      capacity: 4,
      // بزرگ‌تر از پنجرهٔ تسویه؛ `projectPayroll` خودش سقف را اعمال می‌کند
      elapsedMinutes: MAX_ACCRUAL_MINUTES * 5,
      treasury: 0,
      deliveredMinutes: 100_000_000,
      // مالک هم شیفت داشته، ولی نیرو نصف نیازِ ظرفیت ۴ است ⇒ ضریب ۰٫۵
      ownerWorkedMinutes: 480,
      lines: []
    })

    // ۷ روز واقعی = ۲۱۰ روز بازی ⇒ سقف ۱۲ ساعت در روز
    expect(projection.deliveredMinutes).toBe(7 * 30 * 12 * 60)
    expect(projection.staffingFactor).toBe(0.5)
    expect(projection.grossRevenue).toBe(Math.round((5_000 / 30) * 7 * 30 * 12 * 60 * 0.5))
  })
})

describe('PayrollService — preview', () => {
  test('computes revenue, cost and owed salary without mutating anything', async () => {
    const business = makeBusiness({
      employees: [
        { playerId: 'p1', title: 'کارمند اول', salaryPerMinute: 1_000, unpaidSalary: 0 },
        { playerId: 'p2', title: 'کارمند دوم', salaryPerMinute: 500, unpaidSalary: 2_000 }
      ]
    })
    const { db } = makeDb(business, undefined, [shift('p1', 60), shift('p2', 60)])
    const service = new PayrollService(db as unknown as PrismaClient)

    const preview = await service.previewSettlement('b1', 'owner-1')

    expect(preview.elapsedMinutes).toBe(60)
    // نرخ‌ها در دیتابیس «در دقیقهٔ واقعی»اند و روی دقیقهٔ بازی ترجمه می‌شوند (÷۳۰):
    // دو کارمند × ۶۰ دقیقهٔ کار = ۱۲۰ دقیقهٔ تحویل‌شده؛ سقف بازه ۶۰ دقیقه است ⇒ ۶۰
    expect(preview.deliveredMinutes).toBe(60)
    // توان = کارمند اول (۱) + کارمند دوم (۱) = ۲ = نیاز ⇒ ضریب ۱
    expect(preview.staffingFactor).toBe(1)
    expect(preview.grossRevenue).toBe(10_000)
    expect(preview.operatingCost).toBe(2_000)
    // دومی بدهی معوق دارد ولی کارکردش ۲٬۰۰۰ می‌شود + ۲٬۰۰۰ ارثی
    expect(preview.totalPayroll).toBe(2_000 + 1_000 + 2_000)
    expect(preview.lines).toHaveLength(2)
    expect(db.$transaction).not.toHaveBeenCalled()
  })

  test('marks the preview as skipped when no time has passed', async () => {
    const { db } = makeDb(makeBusiness({ lastPayrollAt: new Date() }))
    const service = new PayrollService(db as unknown as PrismaClient)

    const preview = await service.previewSettlement('b1', 'owner-1')
    expect(preview.skipped).toBe(true)
    expect(preview.elapsedMinutes).toBe(0)
  })
})

describe('PayrollService — settlement money safety', () => {
  test('pays every employee when the treasury is sufficient', async () => {
    const { db, tx } = makeDb(twoWorkers(), undefined, TWO_WORKING)
    const service = new PayrollService(db as unknown as PrismaClient)

    const result = await service.settle('b1', 'owner-1')

    expect(result.paidEmployees).toBe(2)
    expect(result.unpaidEmployees).toBe(0)
    expect(result.totalUnpaidDebt).toBe(0)
    expect(result.totalPayroll).toBe(4_000)
    expect(tx.player.update).toHaveBeenCalledTimes(2)
  })

  test('never creates money: unpaid salary becomes debt when the treasury is short', async () => {
    const business = twoWorkers({
      treasury: 3_000,
      baseRevenuePerMinute: 0,
      operatingCostPerMinute: 0
    })
    const { db, tx } = makeDb(business, undefined, TWO_WORKING)
    const service = new PayrollService(db as unknown as PrismaClient)

    const result = await service.settle('b1', 'owner-1')

    // مجموع حقوق ۴٬۰۰۰ بود اما خزانه فقط ۳٬۰۰۰ داشت
    expect(result.totalPayroll).toBe(3_000)
    expect(result.totalUnpaidDebt).toBe(1_000)
    expect(result.treasuryAfter).toBe(0)
    expect(tx.businessEmployee.update).toHaveBeenCalled()
  })

  test('treasury never goes negative from operating cost', async () => {
    const business = makeBusiness({
      treasury: 1_000,
      baseRevenuePerMinute: 0,
      operatingCostPerMinute: 10_000,
      employees: []
    })
    const { db } = makeDb(business)
    const service = new PayrollService(db as unknown as PrismaClient)

    const result = await service.settle('b1', 'owner-1')
    expect(result.treasuryAfter).toBe(0)
  })

  test('carries an existing unpaid salary into the next settlement', async () => {
    const business = makeBusiness({
      treasury: 1_000_000,
      baseRevenuePerMinute: 0,
      operatingCostPerMinute: 0,
      employees: [
        { id: 'e1', playerId: 'p1', title: 'کارمند', salaryPerMinute: 100, unpaidSalary: 500_000 }
      ]
    })
    const { db } = makeDb(business, undefined, [shift('p1', 60)])
    const service = new PayrollService(db as unknown as PrismaClient)

    const result = await service.settle('b1', 'owner-1')

    // ۶۰ دقیقهٔ کار × ۱۰۰/۳۰ + ۵۰۰٬۰۰۰ بدهی قبلی
    expect(result.totalPayroll).toBe(500_200)
    expect(result.totalUnpaidDebt).toBe(0)
  })
})

describe('PayrollService — idempotency and concurrency', () => {
  test('a second concurrent settlement is skipped by the optimistic lock', async () => {
    const business = makeBusiness({
      employees: [
        { id: 'e1', playerId: 'p1', title: 'کارمند', salaryPerMinute: 1_000, unpaidSalary: 0 }
      ]
    })
    const { db, tx } = makeDb(business, undefined, [shift('p1', 60)])
    // شبیه‌سازی مسابقه: قفل خوش‌بینانه شکست می‌خورد
    tx.business.updateMany.mockResolvedValue({ count: 0 })
    const service = new PayrollService(db as unknown as PrismaClient)

    const result = await service.settle('b1', 'owner-1')

    expect(result.skipped).toBe(true)
    expect(result.totalPayroll).toBe(0)
    expect(tx.player.update).not.toHaveBeenCalled()
    expect(tx.financialTransaction.create).not.toHaveBeenCalled()
  })

  test('settlement is skipped when called twice within a minute', async () => {
    const { db, tx } = makeDb(makeBusiness({ lastPayrollAt: new Date() }))
    const service = new PayrollService(db as unknown as PrismaClient)

    const result = await service.settle('b1', 'owner-1')

    expect(result.skipped).toBe(true)
    expect(tx.business.updateMany).not.toHaveBeenCalled()
  })

  test('the optimistic lock is scoped to the previous timestamp', async () => {
    const lastPayrollAt = minutesAgo(30)
    const { db, tx } = makeDb(makeBusiness({ lastPayrollAt }))
    const service = new PayrollService(db as unknown as PrismaClient)

    await service.settle('b1', 'owner-1')

    expect(tx.business.updateMany.mock.calls[0][0].where.lastPayrollAt).toBe(lastPayrollAt)
  })

  test('شیفتی که پیش از لنگر کارمند تمام شده دوباره پرداخت نمی‌شود', () => {
    const shifts = [shift('p1', 60, 120), shift('p1', 60, 10)]
    // لنگر ۳۰ دقیقه پیش ⇒ فقط شیفتِ تازه‌تر از لنگر می‌ماند
    expect(creditedMinutesOf(shifts, 'p1', minutesAgo(30))).toBe(60)
    expect(creditedMinutesOf(shifts, 'p1', minutesAgo(300))).toBe(120)
  })

  test('revenue is recorded as a business transaction', async () => {
    const business = makeBusiness({
      employees: [
        { id: 'e1', playerId: 'p1', title: 'کارمند', salaryPerMinute: 100, unpaidSalary: 0 }
      ]
    })
    const { db, tx } = makeDb(business, undefined, [shift('p1', 60)])
    const service = new PayrollService(db as unknown as PrismaClient)

    await service.settle('b1', 'owner-1')

    const types = tx.financialTransaction.create.mock.calls.map((c) => c[0].data.type)
    expect(types).toContain('BUSINESS_REVENUE')
  })

  test('salary payments are recorded per employee', async () => {
    const { db, tx } = makeDb(twoWorkers(), undefined, TWO_WORKING)
    const service = new PayrollService(db as unknown as PrismaClient)

    await service.settle('b1', 'owner-1')

    const salaryCalls = tx.financialTransaction.create.mock.calls.filter(
      (c) => c[0].data.type === 'SALARY_PAYMENT'
    )
    expect(salaryCalls).toHaveLength(2)
  })
})

describe('PayrollService — income tax at source', () => {
  test('withholds 5% income tax from every paid salary and keeps gross as the business expense', async () => {
    const business = makeBusiness({
      treasury: 10_000_000,
      employees: [
        { id: 'e1', playerId: 'p1', title: 'کارمند', salaryPerMinute: 1_000, unpaidSalary: 0 }
      ]
    })
    const { db, tx } = makeDb(business, undefined, [shift('p1', 60)])
    const service = new PayrollService(db as unknown as PrismaClient)

    const result = await service.settle('b1', 'owner-1')

    const gross = 2_000 // ۶۰ دقیقهٔ کار × ۱٬۰۰۰/۳۰ (پیش از مالیات)
    const tax = 100 // ۵٪
    expect(result.totalPayroll).toBe(gross)
    expect(result.totalTax).toBe(tax)
    expect(result.lines[0]!.net).toBe(gross - tax)

    // کیف پول کارمند فقط خالص را می‌گیرد
    expect(tx.player.update.mock.calls[0][0].data.balance.increment).toBe(gross - tax)

    // دفتر کل: حقوق ناخالص + یک ردیف مالیات با نوع TAX_PAYMENT
    const types = tx.financialTransaction.create.mock.calls.map((c) => c[0].data.type)
    expect(types.filter((t) => t === 'SALARY_PAYMENT')).toHaveLength(1)
    expect(types.filter((t) => t === 'TAX_PAYMENT')).toHaveLength(1)

    // مالیات به صندوق منطقهٔ کارمند واریز شد
    expect(tx.regionStat.upsert).toHaveBeenCalledTimes(1)
    expect(tx.regionStat.upsert.mock.calls[0][0].update.taxRevenue.increment).toBe(tax)
  })

  test('when the treasury pays nothing there is no tax row', async () => {
    const business = makeBusiness({
      treasury: 0,
      baseRevenuePerMinute: 0,
      operatingCostPerMinute: 0,
      employees: [
        { id: 'e1', playerId: 'p1', title: 'کارمند', salaryPerMinute: 1_000, unpaidSalary: 0 }
      ]
    })
    const { db, tx } = makeDb(business, undefined, [shift('p1', 60)])
    const service = new PayrollService(db as unknown as PrismaClient)

    const result = await service.settle('b1', 'owner-1')

    expect(result.totalPayroll).toBe(0)
    expect(result.totalTax).toBe(0)
    expect(tx.financialTransaction.create).not.toHaveBeenCalled()
  })
})

describe('PayrollService — real employee productivity', () => {
  test('a tired, unhealthy employee produces less revenue than a fresh one', async () => {
    const employee = {
      id: 'e1',
      playerId: 'p1',
      title: 'کارمند',
      salaryPerMinute: 100,
      unpaidSalary: 0
    }
    const business = makeBusiness({ employees: [employee] })
    // هر دو حالت کار کرده‌اند؛ تفاوت فقط در توان بدنی است
    const shifts = [shift('p1', 60), shift('owner-1', 60)]

    const fresh = makeDb(business, [makePlayerRow('p1')], shifts)
    const worn = makeDb(business, [makePlayerRow('p1', { health: 12, fatigue: 95 })], shifts)

    const freshResult = await new PayrollService(
      fresh.db as unknown as PrismaClient
    ).settle('b1', 'owner-1')
    const wornResult = await new PayrollService(
      worn.db as unknown as PrismaClient
    ).settle('b1', 'owner-1')

    // مالک (۱) + کارمند (۱) = ۲ از نیاز ۲ ⇒ ضریب ۱
    expect(freshResult.staffPower).toBe(2)
    // کف توان کارمند ۰٫۶ ⇒ ۱٫۶ از نیاز ۲ ⇒ ۰٫۸
    expect(wornResult.staffPower).toBe(1.6)
    expect(wornResult.staffingFactor).toBe(0.8)
    expect(wornResult.grossRevenue).toBeLessThan(freshResult.grossRevenue)
  })

  test('a veteran employee with degree and skills raises the staffing power', async () => {
    const employee = {
      id: 'e1',
      playerId: 'p1',
      title: 'کارمند',
      salaryPerMinute: 100,
      unpaidSalary: 0
    }
    const business = makeBusiness({ employees: [employee], employeeCapacity: 8 })
    const shifts = [shift('p1', 60)]
    const veteran = makePlayerRow('p1', {
      health: 100,
      fatigue: 0,
      experience: 1_000,
      currentDegree: 'DOCTORATE',
      graduationField: 'پزشکی',
      age: 35
    })

    const freshResult = await new PayrollService(
      makeDb(business, [makePlayerRow('p1')], shifts).db as unknown as PrismaClient
    ).settle('b1', 'owner-1')
    const veteranResult = await new PayrollService(
      makeDb(business, [veteran], shifts).db as unknown as PrismaClient
    ).settle('b1', 'owner-1')

    // تازه‌کار: توان ۱ از نیاز ۴ = ۲۵٪
    // کهنه‌کار: ۱٫۲ (سابقه) × ۱٫۲ (دکتری) = ۱٫۴۴ ⇒ ۳۶٪
    expect(freshResult.staffingFactor).toBe(0.25)
    expect(veteranResult.staffingFactor).toBeCloseTo(0.36, 2)
    expect(veteranResult.grossRevenue).toBeGreaterThan(freshResult.grossRevenue)
  })

  test('employee productivity is clamped so one star hire cannot inflate revenue', () => {
    expect(employeeProductivity(9)).toBe(MAX_EMPLOYEE_PRODUCTIVITY)
    expect(employeeProductivity(0.05)).toBe(MIN_EMPLOYEE_PRODUCTIVITY)
    expect(employeeProductivity(Number.NaN)).toBe(1)
    expect(staffingFactorFromPower(1, 4)).toBe(0.5)
    expect(staffingFactorFromPower(2, 4)).toBe(1)
    expect(staffingFactorFromPower(4, 8)).toBe(1)
  })

  test('توان فقط از کارکنندگانِ حاضر ساخته می‌شود', () => {
    const worked = [{ productivity: 1.5, workedMinutes: 480 }]
    const idle = [{ productivity: 1.5, workedMinutes: 0 }]
    const departed = [{ productivity: 1.5, isActive: false, workedMinutes: 480 }]

    expect(staffPower(worked)).toBe(1.5)
    expect(staffPower(idle)).toBe(0)
    expect(staffPower(departed)).toBe(0)
    // مالک فقط وقتی در توان می‌آید که خودش شیفت گرفته باشد
    expect(staffPower(worked, 60)).toBe(2.5)
    expect(staffPower(worked, 0)).toBe(1.5)
  })

  test('کارکرد تحویل‌شده با بهره‌وری هر کس وزن می‌خورد', () => {
    const shifts = [shift('p1', 60), shift('p2', 60)]
    expect(deliveredMinutes(shifts, () => 1)).toBe(120)
    expect(deliveredMinutes(shifts, (id) => (id === 'p1' ? 1.5 : 0.5))).toBe(120)
    // کسی که در نقشه نیست، عدد خنثی می‌گیرد
    expect(deliveredMinutes(shifts, () => 2)).toBe(240)
  })
})

describe('معادل ماهانهٔ حقوق یک روایت دارد، نه سه تا', () => {
  const RATES = [12_000, 25_000, 80_000]

  test('نرخ ساعت بازی × ۸ ساعت کار روزانه × ۳۰ روز ماه بازی', () => {
    for (const rate of RATES) {
      expect(monthlySalaryFor(rate)).toBe(ratePerGameHour(rate) * 8 * GAME_DAYS_PER_MONTH)
    }
  })

  test('همان عددی است که projectPayroll در یک ماه بازی کارِ کامل می‌دهد', () => {
    const oneGameMonth = GAME_DAYS_PER_MONTH * GAME_HOURS_PER_DAY * GAME_MINUTES_PER_HOUR

    for (const rate of RATES) {
      const projection = projectPayroll({
        baseRevenuePerMinute: 0,
        operatingCostPerMinute: 0,
        activeEmployees: 1,
        capacity: 1,
        elapsedMinutes: oneGameMonth,
        treasury: 1_000_000_000,
        deliveredMinutes: 0,
        lines: [
          {
            salaryPerMinute: rate,
            unpaidSalary: 0,
            anchorElapsedMinutes: oneGameMonth,
            workedMinutes: oneGameMonth,
            // قراردادِ پیش‌فرض (کار تمام‌وقت) و هیچ کارکردی پیش از این بازه
            contractMinutesRemaining: DEFAULT_CONTRACT_GAME_HOURS_PER_MONTH * 60
          }
        ]
      })

      // عددی که پنل به کارفرما نشان می‌دهد باید دقیقاً همان پولی باشد که در یک ماه
      // بازی از خزانه بیرون می‌رود؛ وگرنه کارفرما بر اساس عددی تصمیم می‌گیرد که وجود ندارد.
      expect(projection.lines[0]!.owed).toBe(monthlySalaryFor(rate))
      expect(projection.totalPayroll).toBe(monthlySalaryFor(rate))
    }
  })

  test('هیچ پنلی فرمول ماهانهٔ مستقل خودش را ندارد', () => {
    const sources = [
      readText(join(__dirname, '..', 'src', 'bot', 'renders.ts')),
      readText(join(__dirname, '..', 'src', 'bot', 'handlers', 'text.handler.ts'))
    ]

    for (const source of sources) {
      // دو فرمول بازمانده از مدل‌های قدیمی زمان: ۲۴ ساعتهٔ شبانه‌روزی و ضریب ۴۸۰×۳۰
      expect(source).not.toContain('* 24 * 30')
      expect(source).not.toContain('* 480 * 30')
    }
    expect(sources.join('\n')).toContain('monthlySalaryFor')
  })
})

describe('واحد دستمزد در ورودی، ذخیره و نمایش یکی است', () => {
  /** همان عددی که کارفرما در پنل می‌بیند و در ذهن دارد. */
  const GAME_HOUR_INPUTS = [200, 500, 1_200, 3_000, 6_000]

  test('هر عدد در «تومان در ساعت بازی» به نرخ ذخیره‌شده تبدیل و همان‌طور بازخوانی می‌شود', () => {
    for (const perGameHour of GAME_HOUR_INPUTS) {
      const stored = salaryFromGameHourInput(perGameHour)
      expect(Number.isInteger(stored)).toBe(true)
      // رفت‌وبرگشت: عددِ نوشته‌شده پس از ذخیره و رندر، دقیقاً همان می‌ماند
      expect(ratePerGameHour(stored)).toBe(perGameHour)
    }
  })

  test('بازهٔ رسمی آگهی در هر دو واحد درست است', () => {
    expect(ratePerGameHour(POST_SALARY_MIN)).toBe(200)
    expect(ratePerGameHour(POST_SALARY_MAX)).toBe(6_000)
    expect(salaryFromGameHourInput(ratePerGameHour(POST_SALARY_MIN))).toBe(POST_SALARY_MIN)
    expect(salaryFromGameHourInput(ratePerGameHour(POST_SALARY_MAX))).toBe(POST_SALARY_MAX)
  })

  test('هر دو مسیر ورودی حقوق، عدد را پیش از ثبت تبدیل می‌کنند', () => {
    const handler = readText(join(__dirname, '..', 'src', 'bot', 'handlers', 'text.handler.ts'))
    // یکی تغییر حقوق کارمند، یکی «حقوق دلخواه» سازندهٔ آگهی
    expect(handler.match(/salaryFromGameHourInput\(amount\)/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
  })

  test('هیچ متن بازیکن‌محوری حقوق را با واحدِ داخلی «دقیقه» نمی‌گوید', () => {
    const playerFacing = [
      readText(join(__dirname, '..', 'src', 'bot', 'help-content.ts')),
      readText(join(__dirname, '..', 'src', 'bot', 'renders.ts')),
      readText(join(__dirname, '..', 'src', 'bot', 'handlers', 'text.handler.ts')),
      readText(join(__dirname, '..', 'src', 'modules', 'occupation', 'business.service.ts')),
      readText(join(__dirname, '..', 'src', 'modules', 'identity', 'player-state-machine.ts'))
    ]
    const joined = playerFacing.join('\n')

    // سه جملهٔ بازمانده از مدل قدیمی که عدد/واحدِ داخلی را به بازیکن نشان می‌دادند
    expect(joined).not.toContain('حقوق دقیقه‌ای')
    expect(joined).not.toContain('در دقیقه استخدام')
    expect(joined).not.toContain('تومان در دقیقه باشد')
  })
})
