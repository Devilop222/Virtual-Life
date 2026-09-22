import { HousingService } from '../src/modules/housing/housing.service'
import { HousingRepository } from '../src/database/repositories/housing.repository'
import { PlayerRepository } from '../src/database/repositories/player.repository'
import { ValidationError } from '../src/utils/classes/errors'
import { PropertyType } from '@prisma/client'

describe('Housing and Real Estate System', () => {
  let housingRepo: {
    listPlayerProperties: jest.Mock
    findActiveRental: jest.Mock
    buyProperty: jest.Mock
    startResting: jest.Mock
    stopResting: jest.Mock
  }
  let playerRepo: { findByTelegramUserId: jest.Mock }
  let service: HousingService

  beforeEach(() => {
    housingRepo = {
      listPlayerProperties: jest.fn(),
      findActiveRental: jest.fn(),
      buyProperty: jest.fn(),
      startResting: jest.fn(),
      stopResting: jest.fn()
    }
    playerRepo = { findByTelegramUserId: jest.fn() }
    service = new HousingService(
      housingRepo as unknown as HousingRepository,
      playerRepo as unknown as PlayerRepository
    )
  })

  test('prevents property purchase if balance is insufficient', async () => {
    playerRepo.findByTelegramUserId.mockResolvedValue({
      id: 'p1',
      balance: 1_000_000,
      status: 'ACTIVE'
    })

    await expect(
      service.buyPropertyByBlueprint(42n, PropertyType.APARTMENT)
    ).rejects.toThrow(ValidationError)
  })

  test('a homeless player rests in the starter shelter instead of being blocked', async () => {
    // رفتار عوض شد و این آزمون هم باید عوض شود — ولی دلیلش مهم است:
    // تا وقتی فرسودگیِ طبیعی وجود نداشت، «بی‌خانگی = بی‌استراحتی» فقط یک
    // محدودیت بود. حالا که سلامت با گذرِ زمان کم می‌شود و زیر ۱۱ کار ممکن
    // نیست، همان محدودیت به «مرگِ اجباری برای بازیکنِ کم‌پول» تبدیل می‌شد.
    // آلونک سرپناهِ ابتدایی است: رایگان، ضعیف، و کافی برای رفع خستگی.
    playerRepo.findByTelegramUserId.mockResolvedValue({
      id: 'p1',
      status: 'ACTIVE',
      activityState: 'IDLE'
    })
    housingRepo.listPlayerProperties.mockResolvedValue([])
    housingRepo.findActiveRental.mockResolvedValue(null)

    await service.startRestAtHome(42n)

    expect(housingRepo.startResting).toHaveBeenCalledWith('p1')
  })

  test('a player whose every property is rented out also falls back to the shelter', async () => {
    playerRepo.findByTelegramUserId.mockResolvedValue({
      id: 'p1',
      status: 'ACTIVE',
      activityState: 'IDLE'
    })
    // ملک دارد، ولی مستأجر در آن زندگی می‌کند؛ پس مالک در آن استراحت نمی‌کند.
    housingRepo.listPlayerProperties.mockResolvedValue([{ id: 'prop-1', title: 'آپارتمان', level: 3 }])
    housingRepo.findActiveRental.mockResolvedValue(null)
    ;(service as unknown as { liveOwned: (rows: unknown[]) => unknown[] }).liveOwned = () => []

    await service.startRestAtHome(42n)

    expect(housingRepo.startResting).toHaveBeenCalledWith('p1')
  })

  test('successfully starts resting when owning a house', async () => {
    playerRepo.findByTelegramUserId.mockResolvedValue({
      id: 'p1',
      status: 'ACTIVE',
      activityState: 'IDLE'
    })
    housingRepo.listPlayerProperties.mockResolvedValue([{ id: 'prop-1', title: 'آپارتمان' }])

    await service.startRestAtHome(42n)
    expect(housingRepo.startResting).toHaveBeenCalledWith('p1')
  })
})