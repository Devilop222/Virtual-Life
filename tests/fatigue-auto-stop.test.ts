import { PlayerActivityState, PlayerStatus } from '@prisma/client'
import { WorkSessionService } from '../src/modules/occupation/work-session.service'
import { WorkSessionRepository } from '../src/database/repositories/work-session.repository'
import { PlayerRepository } from '../src/database/repositories/player.repository'
import { IncomeCalculationService } from '../src/modules/occupation/income-calculation.service'
import { JobCapacityService } from '../src/modules/occupation/job-market.service'

function makeService() {
  const playerRepository = { findByTelegramUserId: jest.fn(), countPlayers: jest.fn() }
  const workSessionRepository = {
    findActiveSession: jest.fn(),
    startSession: jest.fn(),
    endSession: jest.fn()
  }
  const jobCapacityService = {
    takeSlot: jest.fn(),
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

describe('WorkSessionService - critical fatigue auto stop', () => {
  test('stops work and settles salary when fatigue reaches the critical threshold', async () => {
    const { service, playerRepository, workSessionRepository } = makeService()

    playerRepository.findByTelegramUserId.mockResolvedValue({
      id: 'p1',
      status: PlayerStatus.ACTIVE,
      activityState: PlayerActivityState.WORKING,
      fatigue: 80,
      experience: 50
    })
    workSessionRepository.findActiveSession.mockResolvedValue({
      id: 's1',
      playerId: 'p1',
      jobKey: 'construction',
      jobTitle: 'کارگر ساختمان',
      payPerMinute: 6500,
      // ۲۰ دقیقهٔ واقعی = ۶۰۰ دقیقهٔ بازی؛ با نرخ خستگی سازندگی (۰٫۹ در دقیقهٔ
      // واقعی) یعنی ۱۸ واحد خستگی — کافی برای عبور از آستانهٔ بحرانی.
      startedAt: new Date(Date.now() - 20 * 60 * 1000),
      status: 'ACTIVE'
    })
    workSessionRepository.endSession.mockResolvedValue({
      id: 's1',
      jobTitle: 'کارگر ساختمان',
      status: 'COMPLETED'
    })

    const result = await service.autoStopIfCriticallyFatigued(42n)

    expect(result).not.toBeNull()
    expect(workSessionRepository.endSession).toHaveBeenCalledTimes(1)
  })

  test('does not stop work when fatigue stays below the critical threshold', async () => {
    const { service, playerRepository, workSessionRepository } = makeService()

    playerRepository.findByTelegramUserId.mockResolvedValue({
      id: 'p1',
      status: PlayerStatus.ACTIVE,
      activityState: PlayerActivityState.WORKING,
      fatigue: 40,
      experience: 50
    })
    workSessionRepository.findActiveSession.mockResolvedValue({
      id: 's1',
      playerId: 'p1',
      jobKey: 'construction',
      jobTitle: 'کارگر ساختمان',
      payPerMinute: 6500,
      // ۲۰ دقیقهٔ واقعی = ۶۰۰ دقیقهٔ بازی؛ با نرخ خستگی سازندگی (۰٫۹ در دقیقهٔ
      // واقعی) یعنی ۱۸ واحد خستگی — کافی برای عبور از آستانهٔ بحرانی.
      startedAt: new Date(Date.now() - 20 * 60 * 1000),
      status: 'ACTIVE'
    })

    const result = await service.autoStopIfCriticallyFatigued(42n)

    expect(result).toBeNull()
    expect(workSessionRepository.endSession).not.toHaveBeenCalled()
  })

  test('does nothing when the player is not working', async () => {
    const { service, playerRepository, workSessionRepository } = makeService()

    playerRepository.findByTelegramUserId.mockResolvedValue({
      id: 'p1',
      status: PlayerStatus.ACTIVE,
      activityState: PlayerActivityState.IDLE,
      fatigue: 0,
      experience: 0
    })

    const result = await service.autoStopIfCriticallyFatigued(42n)

    expect(result).toBeNull()
    expect(workSessionRepository.findActiveSession).not.toHaveBeenCalled()
  })
})