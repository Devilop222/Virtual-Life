import { BusinessService } from '../src/modules/occupation/business.service'
import { BusinessRepository } from '../src/database/repositories/business.repository'
import { PlayerRepository } from '../src/database/repositories/player.repository'
import { PayrollService } from '../src/modules/occupation/payroll.service'
import { ConflictError } from '../src/utils/classes/errors'

describe('Business Level Progression', () => {
  let businessRepo: {
    findById: jest.Mock
    upgradeBusiness: jest.Mock
  }
  let playerRepo: { findByTelegramUserId: jest.Mock }
  let payrollService: { settle: jest.Mock; previewSettlement: jest.Mock }
  let service: BusinessService

  beforeEach(() => {
    businessRepo = {
      findById: jest.fn(),
      upgradeBusiness: jest.fn()
    }
    playerRepo = { findByTelegramUserId: jest.fn() }
    payrollService = { settle: jest.fn(), previewSettlement: jest.fn() }
    service = new BusinessService(
      businessRepo as unknown as BusinessRepository,
      playerRepo as unknown as PlayerRepository,
      payrollService as unknown as PayrollService
    )
  })

  test('rejects upgrade attempt by a non-owner', async () => {
    playerRepo.findByTelegramUserId.mockResolvedValue({ id: 'p1' })
    businessRepo.findById.mockResolvedValue({
      id: 'b1',
      ownerId: 'other-owner'
    })

    await expect(service.upgradeBusiness(42n, 'b1')).rejects.toThrow(ConflictError)
    expect(businessRepo.upgradeBusiness).not.toHaveBeenCalled()
  })

  test('upgrades business only after verifying owner access', async () => {
    playerRepo.findByTelegramUserId.mockResolvedValue({ id: 'p1' })
    businessRepo.findById.mockResolvedValue({
      id: 'b1',
      ownerId: 'p1'
    })
    businessRepo.upgradeBusiness.mockResolvedValue({
      id: 'b1',
      level: 2,
      employeeCapacity: 10
    })

    const upgraded = await service.upgradeBusiness(42n, 'b1')
    expect(businessRepo.upgradeBusiness).toHaveBeenCalledWith('b1')
    expect(upgraded.level).toBe(2)
  })
})
