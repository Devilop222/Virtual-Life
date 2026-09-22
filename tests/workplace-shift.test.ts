import { PlayerActivityState, PlayerStatus } from '@prisma/client'
import { WorkSessionService } from '../src/modules/occupation/work-session.service'
import { IncomeCalculationService } from '../src/modules/occupation/income-calculation.service'
import type { WorkSessionRepository } from '../src/database/repositories/work-session.repository'
import type { PlayerRepository } from '../src/database/repositories/player.repository'
import type { JobCapacityService } from '../src/modules/occupation/job-market.service'
import { ConflictError } from '../src/utils/classes/errors'

/**
 * شیفتِ محل کار: کارمند در کسب‌وکار کارفرما (یا مالک در کسب‌وکار خودش).
 *
 * قراردادِ این مسیر: کارکرد ثبت می‌شود ولی **پول نقد جابه‌جا نمی‌شود** —
 * مزد در تسویهٔ کارفرما حساب می‌شود. اگر این تست بشکند، یعنی دستمزد
 * دو بار پرداخت می‌شود یا ظرفیتِ آگهیِ بازار بی‌دلیل مصرف می‌شود.
 */
describe('شیفت محل کار · کارکرد ثبت می‌شود، نه پرداخت نقدی', () => {
  function makeService() {
    const playerRepository = { findByTelegramUserId: jest.fn(), countPlayers: jest.fn() }
    const workSessionRepository = {
      findActiveSession: jest.fn(),
      startSession: jest.fn(),
      endSession: jest.fn().mockResolvedValue({ id: 's1' }),
      findWorkplace: jest.fn(),
      countActiveByJob: jest.fn().mockResolvedValue(new Map())
    }
    const jobCapacityService = {
      takeSlot: jest.fn().mockResolvedValue(true),
      releaseSlot: jest.fn(),
      getCapacityMap: jest.fn(),
      syncCapacities: jest.fn(),
      getCapacity: jest.fn()
    }
    const service = new WorkSessionService(
      workSessionRepository as unknown as WorkSessionRepository,
      playerRepository as unknown as PlayerRepository,
      new IncomeCalculationService(),
      jobCapacityService as unknown as JobCapacityService
    )
    return { service, playerRepository, workSessionRepository, jobCapacityService }
  }

  const IDLE = {
    id: 'p1',
    startedAt: new Date(),
    status: PlayerStatus.ACTIVE,
    activityState: PlayerActivityState.IDLE,
    age: 25,
    experience: 10,
    fatigue: 0,
    health: 100,
    currentDegree: 'DIPLOMA',
    graduationField: null
  }

  const WORKPLACE = {
    businessId: 'b1',
    businessName: 'سوپرمارکت مرکزی',
    title: 'فروشنده',
    payPerMinute: 3_333,
    isOwner: false,
    // قرارداد کار تمام‌وقت (۲۴۰ ساعت بازی در ماه) و ماهِ خالی
    contractMinutesPerMonth: 14_400,
    workedMinutesThisMonth: 0
  }

  test('شیفتِ کارمند با نوع FULL_TIME و شناسهٔ کسب‌وکار ثبت می‌شود', async () => {
    const { service, playerRepository, workSessionRepository } = makeService()
    playerRepository.findByTelegramUserId.mockResolvedValue(IDLE)
    workSessionRepository.findWorkplace.mockResolvedValue(WORKPLACE)
    workSessionRepository.startSession.mockResolvedValue({ id: 's9' })

    await service.startWorkplaceShift(42n)

    const input = workSessionRepository.startSession.mock.calls[0][0]
    expect(input.sessionType).toBe('FULL_TIME')
    expect(input.businessId).toBe('b1')
    expect(input.playerId).toBe('p1')
    expect(input.jobTitle).toBe('فروشنده')
  })

  test('مالکِ بدون استخدام، در کسب‌وکار خودش شیفت می‌گیرد و نرخ ساعتی ندارد', async () => {
    const { service, playerRepository, workSessionRepository } = makeService()
    playerRepository.findByTelegramUserId.mockResolvedValue(IDLE)
    workSessionRepository.findWorkplace.mockResolvedValue({
      businessId: 'b7',
      businessName: 'کافهٔ من',
      title: 'کافهٔ من',
      payPerMinute: 0,
      isOwner: true,
      contractMinutesPerMonth: null,
      workedMinutesThisMonth: 0
    })
    workSessionRepository.startSession.mockResolvedValue({ id: 's10' })

    const { workplace } = await service.startWorkplaceShift(42n)

    expect(workplace.isOwner).toBe(true)
    expect(workSessionRepository.startSession.mock.calls[0][0].payPerMinute).toBe(0)
  })

  test('کارمندی که حجم ماهانهٔ قرارداد را پر کرده اجازهٔ شیفت تازه ندارد', async () => {
    const { service, playerRepository, workSessionRepository } = makeService()
    playerRepository.findByTelegramUserId.mockResolvedValue(IDLE)
    workSessionRepository.findWorkplace.mockResolvedValue({
      ...WORKPLACE,
      contractMinutesPerMonth: 9_600,
      workedMinutesThisMonth: 9_600
    })

    await expect(service.startWorkplaceShift(42n)).rejects.toThrow(ConflictError)
    expect(workSessionRepository.startSession).not.toHaveBeenCalled()
  })

  test('حتی یک دقیقهٔ مانده هم شیفت را باز می‌کند (سقف، نه قفلِ ناگهانی)', async () => {
    const { service, playerRepository, workSessionRepository } = makeService()
    playerRepository.findByTelegramUserId.mockResolvedValue(IDLE)
    workSessionRepository.findWorkplace.mockResolvedValue({
      ...WORKPLACE,
      contractMinutesPerMonth: 9_600,
      workedMinutesThisMonth: 9_599
    })
    workSessionRepository.startSession.mockResolvedValue({ id: 's11' })

    await service.startWorkplaceShift(42n)
    expect(workSessionRepository.startSession).toHaveBeenCalledTimes(1)
  })

  test('مالکِ کسب‌وکار سقفِ قرارداد ندارد (سودش از خودِ کسب‌وکار می‌آید)', async () => {
    const { service, playerRepository, workSessionRepository } = makeService()
    playerRepository.findByTelegramUserId.mockResolvedValue(IDLE)
    workSessionRepository.findWorkplace.mockResolvedValue({
      ...WORKPLACE,
      isOwner: true,
      contractMinutesPerMonth: null,
      workedMinutesThisMonth: 0
    })
    workSessionRepository.startSession.mockResolvedValue({ id: 's12' })

    await service.startWorkplaceShift(42n)
    expect(workSessionRepository.startSession).toHaveBeenCalledTimes(1)
  })

  test('بدون محل کار، شیفت شروع نمی‌شود', async () => {
    const { service, playerRepository, workSessionRepository } = makeService()
    playerRepository.findByTelegramUserId.mockResolvedValue(IDLE)
    workSessionRepository.findWorkplace.mockResolvedValue(null)

    await expect(service.startWorkplaceShift(42n)).rejects.toThrow(ConflictError)
    expect(workSessionRepository.startSession).not.toHaveBeenCalled()
  })

  test('پایان شیفتِ محل کار هیچ پولی واریز نمی‌کند و ظرفیت آگهی را دست نمی‌زند', async () => {
    const { service, playerRepository, workSessionRepository, jobCapacityService } = makeService()
    playerRepository.findByTelegramUserId.mockResolvedValue({ ...IDLE, activityState: 'WORKING' })
    workSessionRepository.findActiveSession.mockResolvedValue({
      id: 's1',
      playerId: 'p1',
      jobKey: 'business:b1',
      jobTitle: 'فروشنده',
      sessionType: 'FULL_TIME',
      businessId: 'b1',
      payPerMinute: 3_333,
      startedAt: new Date(Date.now() - 20 * 60 * 1000),
      status: 'ACTIVE'
    })

    const result = await service.stopWork(42n)

    expect(workSessionRepository.endSession.mock.calls[0][1].earnedMoney).toBe(0)
    expect(result.workplace).not.toBeNull()
    expect(result.workplace!.businessId).toBe('b1')
    expect(result.summary.net).toBe(0)
    // شیفتِ محل کار صندلیِ آگهیِ بازار را اشغال نکرده، پس آزادکردنی هم نیست
    expect(jobCapacityService.releaseSlot).not.toHaveBeenCalled()
  })

  test('شیفتِ پاره‌وقت همان‌طور که بود نقد پرداخت می‌شود', async () => {
    const { service, playerRepository, workSessionRepository, jobCapacityService } = makeService()
    playerRepository.findByTelegramUserId.mockResolvedValue({ ...IDLE, activityState: 'WORKING' })
    workSessionRepository.findActiveSession.mockResolvedValue({
      id: 's2',
      playerId: 'p1',
      jobKey: 'courier',
      jobTitle: 'پیک',
      sessionType: 'PART_TIME',
      businessId: null,
      payPerMinute: 5_500,
      startedAt: new Date(Date.now() - 20 * 60 * 1000),
      status: 'ACTIVE'
    })

    const result = await service.stopWork(42n)

    expect(workSessionRepository.endSession.mock.calls[0][1].earnedMoney).toBeGreaterThan(0)
    expect(result.workplace).toBeNull()
    expect(result.summary.net).toBeGreaterThan(0)
    expect(jobCapacityService.releaseSlot).toHaveBeenCalledWith('courier')
  })

  test('پنل شیفت جاری برای شیفتِ محل کار پول نشان نمی‌دهد', async () => {
    const { service, playerRepository, workSessionRepository } = makeService()
    playerRepository.findByTelegramUserId.mockResolvedValue({ ...IDLE, activityState: 'WORKING' })
    workSessionRepository.findActiveSession.mockResolvedValue({
      id: 's3',
      playerId: 'p1',
      jobKey: 'business:b1',
      jobTitle: 'فروشنده',
      sessionType: 'FULL_TIME',
      businessId: 'b1',
      payPerMinute: 3_333,
      startedAt: new Date(Date.now() - 20 * 60 * 1000),
      status: 'ACTIVE'
    })

    const status = await service.getActiveSessionStatus(42n)

    expect(status?.workplaceShift).toBe(true)
    expect(status?.net).toBe(0)
    expect(status?.tax).toBe(0)
  })
})
