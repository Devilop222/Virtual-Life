import { STARTING_BALANCE, experienceTierLabel } from '../src/config/economy'
import { PART_TIME_JOBS, BUSINESS_BLUEPRINTS } from '../src/modules/occupation/work-blueprints'

describe('Economy starting conditions', () => {
  test('a new player starts with real but limited capital', () => {
    expect(STARTING_BALANCE).toBeGreaterThan(0)

    // سرمایهٔ اولیه نباید ارزان‌ترین ملک را بخرد، وگرنه پیشرفت بی‌معنا می‌شود
    expect(STARTING_BALANCE).toBeLessThan(3_000_000)
  })

  test('starting capital is worth only a few work sessions', () => {
    const cheapestPay = Math.min(...PART_TIME_JOBS.map((job) => job.basePayPerMinute))
    const sessionMinutes = 30
    const oneSession = cheapestPay * sessionMinutes

    // بین یک تا پنج نشست کاری؛ کمک شروع است، نه میان‌بر
    expect(STARTING_BALANCE / oneSession).toBeGreaterThanOrEqual(1)
    expect(STARTING_BALANCE / oneSession).toBeLessThanOrEqual(5)
  })
})

describe('Experience is shown as a persian tier, never a raw zero', () => {
  test('a brand new player reads as تازه‌کار', () => {
    expect(experienceTierLabel(0)).toBe('تازه‌کار')
  })

  test('tiers rise monotonically and never leak latin text', () => {
    const samples = [0, 9, 10, 49, 50, 149, 150, 399, 400, 999, 1_000, 50_000]
    const labels = samples.map(experienceTierLabel)

    for (const value of labels) {
      expect(/[\u0600-\u06FF]/.test(value)).toBe(true)
      expect(/[A-Za-z0-9]/.test(value)).toBe(false)
    }

    expect(labels[0]).toBe('تازه‌کار')
    expect(labels[labels.length - 1]).toBe('استاد')
  })

  test('invalid input degrades to the lowest tier instead of throwing', () => {
    expect(experienceTierLabel(-100)).toBe('تازه‌کار')
    expect(experienceTierLabel(Number.NaN)).toBe('تازه‌کار')
  })
})

describe('Job pay scales with difficulty', () => {
  test('every job has a positive pay, capacity and fatigue cost', () => {
    for (const job of PART_TIME_JOBS) {
      expect(job.basePayPerMinute).toBeGreaterThan(0)
      expect(job.baseCapacity).toBeGreaterThan(0)
      expect(job.fatigueRatePerMinute).toBeGreaterThan(0)
      expect(job.difficulty).toBeGreaterThanOrEqual(1)
      expect(job.difficulty).toBeLessThanOrEqual(5)
      expect(job.minimumAge).toBeGreaterThanOrEqual(16)
    }
  })

  test('harder work pays more on average', () => {
    const averageByDifficulty = new Map<number, number>()
    for (let difficulty = 1; difficulty <= 5; difficulty++) {
      const jobs = PART_TIME_JOBS.filter((job) => job.difficulty === difficulty)
      if (jobs.length === 0) continue
      const average = jobs.reduce((sum, job) => sum + job.basePayPerMinute, 0) / jobs.length
      averageByDifficulty.set(difficulty, average)
    }

    const levels = [...averageByDifficulty.keys()].sort((a, b) => a - b)
    for (let i = 1; i < levels.length; i++) {
      expect(averageByDifficulty.get(levels[i]!)!).toBeGreaterThan(
        averageByDifficulty.get(levels[i - 1]!)!
      )
    }
  })

  test('jobs that demand a degree or experience pay above the floor', () => {
    const floor = Math.min(...PART_TIME_JOBS.map((job) => job.basePayPerMinute))
    const gated = PART_TIME_JOBS.filter(
      (job) => job.requiredEducation !== undefined || (job.minExperience ?? 0) > 0
    )

    expect(gated.length).toBeGreaterThan(0)
    for (const job of gated) {
      expect(job.basePayPerMinute).toBeGreaterThan(floor)
    }
  })
})

describe('Businesses stay profitable but never instant', () => {
  test('every blueprint earns more than it costs to run', () => {
    for (const blueprint of BUSINESS_BLUEPRINTS) {
      expect(blueprint.baseRevenuePerMinute).toBeGreaterThan(blueprint.operatingCostPerMinute)
    }
  })

  test('payback takes real playtime, and pricier ventures take longer', () => {
    const paybacks = BUSINESS_BLUEPRINTS.map((blueprint) => {
      const net = blueprint.baseRevenuePerMinute - blueprint.operatingCostPerMinute
      return { startupCost: blueprint.startupCost, minutes: blueprint.startupCost / net }
    })

    for (const { minutes } of paybacks) {
      // حداقل ۲۴ ساعت فعالیت خالص تا بازگشت سرمایه
      expect(minutes).toBeGreaterThan(24 * 60)
    }

    const sorted = [...paybacks].sort((a, b) => a.startupCost - b.startupCost)
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i]!.minutes).toBeGreaterThan(sorted[i - 1]!.minutes)
    }
  })
})
