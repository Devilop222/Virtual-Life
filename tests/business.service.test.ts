import { BusinessService } from '../src/modules/occupation/business.service'
import { BusinessRepository } from '../src/database/repositories/business.repository'
import { PlayerRepository } from '../src/database/repositories/player.repository'
import { PayrollService } from '../src/modules/occupation/payroll.service'
import { ValidationError } from '../src/utils/classes/errors'

describe('BusinessService', () => {
  let businessRepository: {
    createBusinessWithStartupCost: jest.Mock
    countActiveByOwner: jest.Mock
  }
  let playerRepository: { findByTelegramUserId: jest.Mock }
  let payrollService: { settle: jest.Mock; previewSettlement: jest.Mock }
  let service: BusinessService

  beforeEach(() => {
    businessRepository = {
      createBusinessWithStartupCost: jest.fn(),
      countActiveByOwner: jest.fn().mockResolvedValue(0)
    }
    playerRepository = {
      findByTelegramUserId: jest.fn()
    }
    payrollService = {
      settle: jest.fn(),
      previewSettlement: jest.fn()
    }
    service = new BusinessService(
      businessRepository as unknown as BusinessRepository,
      playerRepository as unknown as PlayerRepository,
      payrollService as unknown as PayrollService
    )
  })

  test('prevents creating business if capital is insufficient', async () => {
    playerRepository.findByTelegramUserId.mockResolvedValue({
      id: 'p1',
      balance: 1000,
      experience: 50
    })

    await expect(
      service.createBusiness(42n, 'taekwondo_gym', 'باشگاه قهرمانان')
    ).rejects.toThrow(ValidationError)
  })

  test('prevents creating business if experience is insufficient', async () => {
    playerRepository.findByTelegramUserId.mockResolvedValue({
      id: 'p1',
      balance: 50_000_000,
      experience: 1
    })

    await expect(
      service.createBusiness(42n, 'taekwondo_gym', 'باشگاه قهرمانان')
    ).rejects.toThrow(ValidationError)
  })

  test('successfully creates business when capital and experience match', async () => {
    playerRepository.findByTelegramUserId.mockResolvedValue({
      id: 'p1',
      balance: 50_000_000,
      experience: 100
    })
    businessRepository.createBusinessWithStartupCost.mockResolvedValue({
      id: 'b1',
      name: 'باشگاه قهرمانان'
    })

    const result = await service.createBusiness(42n, 'taekwondo_gym', 'باشگاه قهرمانان')
    expect(result.business.id).toBe('b1')
    expect(businessRepository.createBusinessWithStartupCost).toHaveBeenCalled()
    // موجودی پس از تأسیس، در همان پاسخ برمی‌گردد تا پنل نتیجه بی‌کوئری اضافه بسازد
    expect(result.balanceAfter).toBe(50_000_000 - 8_000_000)
    expect(result.startupCost).toBe(8_000_000)
  })
})