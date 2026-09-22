import { PlayerActivityState, PlayerStatus } from '@prisma/client'
import { WorkSessionService } from '../src/modules/occupation/work-session.service'
import { WorkSessionRepository } from '../src/database/repositories/work-session.repository'
import { PlayerRepository } from '../src/database/repositories/player.repository'
import { IncomeCalculationService } from '../src/modules/occupation/income-calculation.service'
import { JobCapacityService } from '../src/modules/occupation/job-market.service'
import { ConflictError, ValidationError } from '../src/utils/classes/errors'

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

const ACTIVE_IDLE_PLAYER = {
  id: 'p1',
  startedAt: new Date(),
  status: PlayerStatus.ACTIVE,
  activityState: PlayerActivityState.IDLE,
  age: 25,
  experience: 10,
  fatigue: 0,
  currentDegree: 'DIPLOMA'
}

describe('Job capacity and requirements', () => {
  test('rejects starting a job when its capacity is full', async () => {
    const { service, playerRepository, workSessionRepository, jobCapacityService } = makeService()

    playerRepository.findByTelegramUserId.mockResolvedValue(ACTIVE_IDLE_PLAYER)
    jobCapacityService.takeSlot.mockResolvedValue(false)

    await expect(service.startPartTimeWork(42n, 'construction')).rejects.toThrow(ConflictError)
    expect(workSessionRepository.startSession).not.toHaveBeenCalled()
  })

  test('releases a taken slot when session creation fails', async () => {
    const { service, playerRepository, workSessionRepository, jobCapacityService } = makeService()

    playerRepository.findByTelegramUserId.mockResolvedValue(ACTIVE_IDLE_PLAYER)
    jobCapacityService.takeSlot.mockResolvedValue(true)
    workSessionRepository.startSession.mockRejectedValue(new Error('concurrent work session'))

    await expect(service.startPartTimeWork(42n, 'construction')).rejects.toThrow(Error)
    expect(jobCapacityService.releaseSlot).toHaveBeenCalledWith('construction')
  })

  test('rejects jobs with unmet education requirement', async () => {
    const { service, playerRepository } = makeService()

    playerRepository.findByTelegramUserId.mockResolvedValue({
      ...ACTIVE_IDLE_PLAYER,
      currentDegree: 'DIPLOMA'
    })

    await expect(service.startPartTimeWork(42n, 'nurse')).rejects.toThrow(ValidationError)
  })

  test('rejects jobs with unmet experience requirement', async () => {
    const { service, playerRepository } = makeService()

    playerRepository.findByTelegramUserId.mockResolvedValue({
      ...ACTIVE_IDLE_PLAYER,
      experience: 0
    })

    await expect(service.startPartTimeWork(42n, 'cook')).rejects.toThrow(ValidationError)
  })

  test('allows starting a job when requirements are met and capacity is available', async () => {
    const { service, playerRepository, workSessionRepository, jobCapacityService } = makeService()

    playerRepository.findByTelegramUserId.mockResolvedValue({
      ...ACTIVE_IDLE_PLAYER,
      experience: 5
    })
    jobCapacityService.takeSlot.mockResolvedValue(true)
    workSessionRepository.startSession.mockResolvedValue({
      id: 's1',
      jobTitle: 'کارگر ساختمان'
    })

    const session = await service.startPartTimeWork(42n, 'construction')
    expect(session.jobTitle).toBe('کارگر ساختمان')
    expect(jobCapacityService.takeSlot).toHaveBeenCalledWith('construction')
    expect(workSessionRepository.startSession).toHaveBeenCalledTimes(1)
  })
})