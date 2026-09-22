import {
  DEFAULT_CONTRACT_GAME_HOURS_PER_MONTH,
  MAX_CONTRACT_GAME_HOURS_PER_MONTH,
  MIN_CONTRACT_GAME_HOURS_PER_MONTH,
  contractGameHoursPerMonth,
  contractMinutesFromGameHours,
  contractValue,
  projectPayroll,
  remainingContractMinutes
} from '../src/modules/occupation/payroll-math'
import { GAME_MINUTES_PER_REAL_MINUTE, ratePerGameMinute } from '../src/utils/game-time'
import { BusinessService } from '../src/modules/occupation/business.service'
import { BusinessRepository } from '../src/database/repositories/business.repository'
import { PlayerRepository } from '../src/database/repositories/player.repository'
import { PayrollService } from '../src/modules/occupation/payroll.service'
import { BusinessStatus } from '@prisma/client'
import { ConflictError, NotFoundError, ValidationError } from '../src/utils/classes/errors'
import { renderJobDetailPanel, renderMyJobPanel } from '../src/bot/renders'
import { buildJobWizardKeyboard } from '../src/bot/keyboards/main.keyboard'

/**
 * قراردادِ حجمیِ کار — «چند ساعت کار در هر ماهِ بازی، با چه سقفی، با دستمزدِ
 * کارکردِ واقعی».
 *
 * چه چیزی اینجا محافظت می‌شود:
 *  • واحدِ قرارداد: کارفرما در «ساعت بازی در ماه» فکر می‌کند و ذخیره‌سازی در
 *    «دقیقهٔ بازی» است؛ یک جا ترجمه می‌شود.
 *  • سقفِ اجباری: کارمند نمی‌تواند بیش از حجمِ ماهانهٔ توافق‌شده پول بگیرد.
 *  • استقلال از تعداد تسویه: سقف تجمعیِ ماه است، پس پرداخت به این وابسته نیست
 *    که کارفرما یک‌بار تسویه کند یا هر ساعتِ بازی یک‌بار.
 */

/** یک بازهٔ تسویه با n دقیقهٔ کارکرد و k دقیقهٔ باقی‌ماندهٔ قرارداد. */
function settlement(workedMinutes: number, contractMinutesRemaining: number, rate = 1_000) {
  return projectPayroll({
    baseRevenuePerMinute: 0,
    operatingCostPerMinute: 0,
    activeEmployees: 1,
    capacity: 4,
    elapsedMinutes: 30 * 24 * 60,
    treasury: 10_000_000_000,
    deliveredMinutes: 0,
    lines: [
      {
        salaryPerMinute: rate,
        unpaidSalary: 0,
        anchorElapsedMinutes: 30 * 24 * 60,
        workedMinutes,
        contractMinutesRemaining
      }
    ]
  })
}

describe('نمایشِ قرارداد در پنل‌ها', () => {
  test('پنل «شغل من» حجم قرارداد، کارکردِ ماه و باقی‌مانده را نشان می‌دهد', () => {
    const text = renderMyJobPanel(
      [
        {
          businessName: 'سوپرمارکت مرکزی',
          title: 'فروشنده',
          salaryPerMinute: 1_200,
          contractMinutesPerMonth: 150 * 60,
          workedMinutes: 1_200,
          workedMinutesThisMonth: 1_200,
          remainingMinutesThisMonth: 150 * 60 - 1_200,
          accrued: 0,
          unpaid: 0,
          staffed: 1,
          capacity: 3
        }
      ],
      []
    )

    expect(text).toContain('قرارداد ماهانه')
    expect(text).toContain('کارکرد این ماه')
    expect(text).toContain('باقی‌مانده')
  })

  test('وقتی حجم ماه پر شده، پنل همان را صریح می‌گوید نه یک عدد تازه', () => {
    const text = renderMyJobPanel(
      [
        {
          businessName: 'سوپرمارکت مرکزی',
          title: 'فروشنده',
          salaryPerMinute: 1_200,
          contractMinutesPerMonth: 150 * 60,
          workedMinutes: 0,
          workedMinutesThisMonth: 150 * 60,
          remainingMinutesThisMonth: 0,
          accrued: 0,
          unpaid: 0,
          staffed: 1,
          capacity: 3
        }
      ],
      []
    )

    expect(text).toContain('حجم این ماه پر شده')
  })

  test('آگهی استخدام حجم ماهانهٔ خود را به متقاضی نشان می‌دهد', () => {
    const text = renderJobDetailPanel(
      {
        title: 'فروشنده',
        salaryPerMinute: 1_200,
        contractMinutesPerMonth: 150 * 60,
        capacity: 2,
        hiredCount: 0,
        minExperience: 0,
        minAge: null,
        maxAge: null,
        requiredDegree: 'DIPLOMA',
        requiredSkill: null,
        business: { name: 'سوپرمارکت مرکزی' }
      },
      []
    )

    expect(text).toContain('حجم ماهانه')
    expect(text).toContain('۱۵۰ ساعت بازی در ماه')
  })

  test('سازندهٔ آگهی دکمهٔ حجم قرارداد را دارد', () => {
    const callbacks = buildJobWizardKeyboard(true).inline_keyboard
      .flat()
      .flatMap((button) => ('callback_data' in button ? [button.callback_data] : []))

    expect(callbacks).toContain('biz:jf:hrs:-30')
    expect(callbacks).toContain('biz:jf:hrs:30')
  })
})

describe('تنظیم حجمِ قرارداد توسط کارفرما', () => {
  /** کارفرمای p1 که یک کارمند فعال دارد. */
  function makeService(overrides: Record<string, unknown> = {}) {
    const businessRepository = {
      findById: jest.fn().mockResolvedValue({
        id: 'b1',
        ownerId: 'p1',
        name: 'سوپرمارکت مرکزی',
        status: BusinessStatus.ACTIVE,
        employees: [
          {
            playerId: 'p2',
            isActive: true,
            title: 'فروشنده',
            salaryPerMinute: 1_200,
            contractMinutesPerMonth: 14_400,
            player: { firstName: 'آرش', lastName: null }
          }
        ],
        ...overrides
      }),
      updateEmployeeContract: jest.fn().mockResolvedValue(1)
    }
    const playerRepository = {
      findByTelegramUserId: jest.fn().mockResolvedValue({ id: 'p1', balance: 0, experience: 500 })
    }
    const payrollService = { settle: jest.fn(), previewSettlement: jest.fn() }
    const service = new BusinessService(
      businessRepository as unknown as BusinessRepository,
      playerRepository as unknown as PlayerRepository,
      payrollService as unknown as PayrollService
    )
    return { service, businessRepository }
  }

  test('حجم در واحدِ ذخیره‌سازی نوشته می‌شود و سقفِ تمام قرارداد برمی‌گردد', async () => {
    const { service, businessRepository } = makeService()

    const result = await service.setEmployeeContract(42n, 'b1', 'p2', 160)

    expect(businessRepository.updateEmployeeContract).toHaveBeenCalledWith('b1', 'p2', 160 * 60)
    expect(result.contractGameHoursPerMonth).toBe(160)
    expect(result.monthlyPayCeiling).toBe(contractValue(1_200, 160 * 60))
  })

  test('حجمِ بیرون از بازه رد می‌شود و هیچ نوشتاری رخ نمی‌دهد', async () => {
    const { service, businessRepository } = makeService()

    for (const bad of [0, -10, 3, 1_000, 12.5]) {
      await expect(service.setEmployeeContract(42n, 'b1', 'p2', bad)).rejects.toThrow(
        ValidationError
      )
    }
    expect(businessRepository.updateEmployeeContract).not.toHaveBeenCalled()
  })

  test('کارمندی که در تیم نیست، قرارداد نمی‌گیرد', async () => {
    const { service } = makeService()

    await expect(service.setEmployeeContract(42n, 'b1', 'ghost', 120)).rejects.toThrow(
      NotFoundError
    )
  })

  test('کسب‌وکارِ کسی دیگر قابل تغییر نیست', async () => {
    const { service } = makeService({ ownerId: 'someone-else' })

    await expect(service.setEmployeeContract(42n, 'b1', 'p2', 120)).rejects.toThrow(
      ConflictError
    )
  })

  test('اگر کارمند همان لحظه جدا شود، تغییر قرارداد شکست می‌خورد', async () => {
    const { service, businessRepository } = makeService()
    businessRepository.updateEmployeeContract.mockResolvedValue(0)

    await expect(service.setEmployeeContract(42n, 'b1', 'p2', 120)).rejects.toThrow(
      ConflictError
    )
  })
})

describe('واحدِ قرارداد حجمی', () => {
  test('کارفرما در «ساعت بازی در ماه» فکر می‌کند و ذخیره‌سازی در دقیقهٔ بازی است', () => {
    expect(contractMinutesFromGameHours(150)).toBe(150 * 60)
    expect(contractGameHoursPerMonth(150 * 60)).toBe(150)
    expect(contractGameHoursPerMonth(contractMinutesFromGameHours(160))).toBe(160)
  })

  test('حجم بیرون از بازهٔ منطقی، در بازه مهار می‌شود', () => {
    expect(contractMinutesFromGameHours(0)).toBe(MIN_CONTRACT_GAME_HOURS_PER_MONTH * 60)
    expect(contractMinutesFromGameHours(-5)).toBe(MIN_CONTRACT_GAME_HOURS_PER_MONTH * 60)
    expect(contractMinutesFromGameHours(9_999)).toBe(MAX_CONTRACT_GAME_HOURS_PER_MONTH * 60)
    // کار تمام‌وقت = ۸ ساعت در روزِ بازی × ۳۰ روز
    expect(DEFAULT_CONTRACT_GAME_HOURS_PER_MONTH).toBe(8 * 30)
  })

  test('سقفِ کاملِ یک قرارداد = نرخ × حجم، نه بیشتر', () => {
    const rate = 1_500
    expect(contractValue(rate, 150 * 60)).toBe(
      Math.round(ratePerGameMinute(rate) * 150 * 60)
    )
  })
})

describe('سقفِ تجمعیِ ماهانه', () => {
  test('کارکردِ پیشینِ ماه از حجم کم می‌کند', () => {
    expect(remainingContractMinutes(9_000, 0)).toBe(9_000)
    expect(remainingContractMinutes(9_000, 3_000)).toBe(6_000)
    expect(remainingContractMinutes(9_000, 9_000)).toBe(0)
    expect(remainingContractMinutes(9_000, 12_000)).toBe(0)
  })

  test('کارکردِ واقعی پایهٔ دستمزد است؛ کار نکرده، پول ندارد', () => {
    const none = settlement(0, 9_000)
    const some = settlement(300, 9_000)

    expect(none.totalPayroll).toBe(0)
    expect(some.totalPayroll).toBe(Math.round(ratePerGameMinute(1_000) * 300))
  })

  test('از حجمِ قرارداد یک دقیقه هم بیشتر پرداخت نمی‌شود', () => {
    const over = settlement(5_000, 1_200)

    expect(over.lines[0]!.paid).toBe(Math.round(ratePerGameMinute(1_000) * 1_200))
    expect(over.totalUnpaidDebt).toBe(0)
  })

  test('یک تسویه یا چند تسویه، جمعِ پرداختِ ماه یکی است', () => {
    // قرارداد ۶۰۰ دقیقه‌ای، ۸۰۰ دقیقه کارکرد: یک‌بار ۸۰۰، یک‌بار ۴۰۰+۴۰۰
    const once = settlement(800, 600)
    const first = settlement(400, 600)
    const second = settlement(400, 600 - 400)

    expect(once.totalPayroll).toBe(first.totalPayroll + second.totalPayroll)
  })

  test('کارفرمایی که در چند نوبت تسویه می‌کند، بیشتر از تسویهٔ یک‌ماهه نمی‌پردازد', () => {
    const inParts = [0, 1, 2].reduce((total, step) => {
      return total + settlement(200, Math.max(0, 600 - step * 200)).totalPayroll
    }, 0)
    const once = settlement(600, 600).totalPayroll

    // هر پرداخت یک مبلغِ سالم است، پس اختلافِ حداکثر یک تومان به‌ازای هر نوبت
    // فقط گردکردن است — نه اضافه‌پرداخت.
    expect(Math.abs(inParts - once)).toBeLessThanOrEqual(3)
  })

  test('سقفِ روزانه جلوی کارکردِ بیش از یک ماهِ کاری را می‌گیرد', () => {
    const oneGameMonth = 30 * 24 * 60
    // شیفتی که ادعای ده ماه کار در یک بازهٔ یک‌ماهه را دارد
    const runaway = settlement(oneGameMonth * 10, oneGameMonth)
    const perDay = Math.round(ratePerGameMinute(1_000) * 8 * 60)

    // ۸ ساعت در هر روزِ بازی × ۳۰ روز — نه ده ماه
    expect(runaway.lines[0]!.paid).toBe(perDay * 30)
  })

  test('نرخِ ذخیره‌شده در واحدِ دقیقهٔ واقعی است و ۳۰ برابر خوانده نمی‌شود', () => {
    const worked = 600
    const withRate = settlement(worked, 9_000, 300)
    expect(withRate.totalPayroll).toBe((300 / GAME_MINUTES_PER_REAL_MINUTE) * worked)
  })
})
