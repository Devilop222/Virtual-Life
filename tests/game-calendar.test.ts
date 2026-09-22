import {
  effectiveAge,
  daysToNextBirthday,
  playedYears
} from '../src/modules/lifecycle/game-calendar'
import { WorkSessionService } from '../src/modules/occupation/work-session.service'
import type { WorkSessionRepository } from '../src/database/repositories/work-session.repository'
import type { PlayerRepository } from '../src/database/repositories/player.repository'
import { IncomeCalculationService } from '../src/modules/occupation/income-calculation.service'
import type { JobCapacityService } from '../src/modules/occupation/job-market.service'
import { GAME_DAYS_PER_YEAR, REAL_MS_PER_GAME_YEAR } from '../src/utils/game-time'

const DAY = 24 * 60 * 60 * 1000
/** یک سال بازی = ۱۲ روز واقعی (قرارداد ساعت مرکزی بازی). */
const GAME_YEAR = REAL_MS_PER_GAME_YEAR

describe('Game calendar — game years', () => {
  test('each 12 real days adds exactly one year of age', () => {
    const start = new Date(Date.now() - 3 * GAME_YEAR)
    expect(effectiveAge(start, 18)).toBe(21)
  })

  test('a partial game year does not add a year yet', () => {
    const start = new Date(Date.now() - (11 * DAY + 12 * 60 * 60 * 1000))
    expect(effectiveAge(start, 18)).toBe(18)
  })

  test('age never exceeds the configured maximum', () => {
    const start = new Date(Date.now() - 500 * GAME_YEAR)
    expect(effectiveAge(start, 18)).toBeLessThanOrEqual(120)
  })

  test('a missing start date falls back to the base age safely', () => {
    expect(effectiveAge(null, 25)).toBe(25)
    expect(effectiveAge(undefined, 30)).toBe(30)
  })

  test('played years counts full game years only', () => {
    expect(playedYears(new Date(Date.now() - 10 * GAME_YEAR))).toBe(10)
    expect(playedYears(new Date(Date.now() - 10 * DAY))).toBe(0)
    expect(playedYears(null)).toBe(0)
  })

  test('birthday countdown stays inside one game year', () => {
    const days = daysToNextBirthday(new Date(Date.now() - 2 * GAME_YEAR))
    expect(days).toBeGreaterThanOrEqual(1)
    expect(days).toBeLessThanOrEqual(GAME_DAYS_PER_YEAR)

    // دقیقاً وسط سال بازی: حدود نیم‌سال (۱۸۰ روز بازی) مانده
    const mid = new Date(Date.now() - (5 * GAME_YEAR + GAME_YEAR / 2))
    const midDays = daysToNextBirthday(mid)
    expect(midDays).toBeGreaterThanOrEqual(170)
    expect(midDays).toBeLessThanOrEqual(190)
  })

  test('birthday countdown is null-safe', () => {
    expect(daysToNextBirthday(null)).toBe(GAME_DAYS_PER_YEAR)
  })

  test('job age requirement uses the game calendar age', async () => {
    // شبیه‌سازی: بازیکنی که ۳ سال بازی (۳۶ روز واقعی) پیش ثبت‌نام کرده → ۳ سال پیرتر شده
    const playerRepository = {
      findByTelegramUserId: jest.fn().mockResolvedValue({
        id: 'p1',
        status: 'ACTIVE',
        activityState: 'IDLE',
        startedAt: new Date(Date.now() - 3 * GAME_YEAR),
        age: 16, // سال پایه؛ با تقویم بازی ۱۹ ساله شده
        experience: 5,
        fatigue: 0,
        currentDegree: 'DIPLOMA'
      })
    }
    const workSessionRepository = { startSession: jest.fn(), findActiveSession: jest.fn() }
    const jobCapacityService = { takeSlot: jest.fn().mockResolvedValue(true), releaseSlot: jest.fn() }

    const service = new WorkSessionService(
      workSessionRepository as unknown as WorkSessionRepository,
      playerRepository as unknown as PlayerRepository,
      new IncomeCalculationService(),
      jobCapacityService as unknown as JobCapacityService
    )

    // شغل «آشپز» حداقل سن ۲۰ و سابقهٔ ۱ دارد → سن مؤثر ۱۹ هنوز کافی نیست
    await expect(service.startPartTimeWork(1n, 'cook')).rejects.toThrow()
    // ولی شرط سن برای «سازندگی» (حداقل ۱۸) با سن مؤثر پاس می‌شود
    playerRepository.findByTelegramUserId.mockResolvedValue({
      id: 'p1',
      status: 'ACTIVE',
      activityState: 'IDLE',
      startedAt: new Date(Date.now() - 3 * GAME_YEAR),
      age: 16,
      experience: 0,
      fatigue: 0,
      currentDegree: 'DIPLOMA'
    })
    workSessionRepository.startSession.mockResolvedValue({ id: 's1', jobTitle: 'کارگر ساختمان' })

    const session = await service.startPartTimeWork(1n, 'construction')
    expect(session.jobTitle).toBe('کارگر ساختمان')
  })
})
