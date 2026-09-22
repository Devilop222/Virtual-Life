import {
  applyTrainingPoints,
  canTrainToday,
  isMaxLevel,
  MAX_TRAINING_SESSIONS_PER_DAY,
  pointsToNextLevel,
  SKILL_MAX_LEVEL,
  SKILL_POINTS_PER_LEVEL,
  TRAINING_BASE_COST,
  TRAINING_POINTS_PER_SESSION,
  trainingSessionCost
} from '../src/modules/skills/skill-training'

describe('Skill training — session cost', () => {
  test('first session of a level-1 skill costs the base price', () => {
    expect(trainingSessionCost(1, 0)).toBe(TRAINING_BASE_COST)
  })

  test('higher levels train more expensively', () => {
    const c1 = trainingSessionCost(1, 0)
    const c5 = trainingSessionCost(5, 0)
    const c9 = trainingSessionCost(9, 0)
    expect(c5).toBeGreaterThan(c1)
    expect(c9).toBeGreaterThan(c5)
    // رشد قیمت با سطح، خطی و قابل پیش‌بینی است
    expect(trainingSessionCost(5, 0)).toBe(Math.round((TRAINING_BASE_COST * 1.6) / 10_000) * 10_000)
  })

  test('same-day sessions escalate so one-day money dumping is not optimal', () => {
    const first = trainingSessionCost(1, 0)
    const second = trainingSessionCost(1, 1)
    const third = trainingSessionCost(1, 2)
    expect(second).toBeGreaterThan(first)
    expect(third).toBeGreaterThan(second)
  })

  test('cost is always a clean multiple of ten thousand tomans', () => {
    for (let level = 1; level <= SKILL_MAX_LEVEL; level++) {
      for (let sessions = 0; sessions <= MAX_TRAINING_SESSIONS_PER_DAY; sessions++) {
        expect(trainingSessionCost(level, sessions) % 10_000).toBe(0)
      }
    }
  })
})

describe('Skill training — applying points', () => {
  test('a session adds its points; under 50 points no level is gained', () => {
    const res = applyTrainingPoints(1, 0)
    expect(res.points).toBe(TRAINING_POINTS_PER_SESSION)
    expect(res.level).toBe(1)
    expect(res.leveledUp).toBe(false)
  })

  test('crossing the 50-point boundary levels the skill up', () => {
    const res = applyTrainingPoints(1, 40) // 40 + 12 = 52
    expect(res.points).toBe(52)
    expect(res.level).toBe(2)
    expect(res.leveledUp).toBe(true)
  })

  test('a level earned elsewhere (education) is never lowered by training', () => {
    // بازیکنی با سطح اهدایی ۵ و امتیاز صفر: تمرین امتیاز جمع می‌کند،
    // اما تا عبور از ۲۵۰ امتیاز سطح از ۵ پایین‌تر نمی‌آید
    const res = applyTrainingPoints(5, 0)
    expect(res.level).toBe(5)
    expect(res.leveledUp).toBe(false)
  })

  test('training can never pass the level cap', () => {
    const res = applyTrainingPoints(SKILL_MAX_LEVEL, 10_000)
    expect(res.level).toBe(SKILL_MAX_LEVEL)
    expect(isMaxLevel(res.level)).toBe(true)
  })

  test('points to next level always stays inside one level span', () => {
    expect(pointsToNextLevel(0)).toBe(SKILL_POINTS_PER_LEVEL)
    expect(pointsToNextLevel(49)).toBe(1)
    expect(pointsToNextLevel(50)).toBe(SKILL_POINTS_PER_LEVEL)
    expect(pointsToNextLevel(-5)).toBe(SKILL_POINTS_PER_LEVEL)
  })
})

describe('Skill training — daily rhythm', () => {
  test('the day has a training budget; after it, rest is the right answer', () => {
    expect(canTrainToday(0)).toBe(true)
    expect(canTrainToday(MAX_TRAINING_SESSIONS_PER_DAY - 1)).toBe(true)
    expect(canTrainToday(MAX_TRAINING_SESSIONS_PER_DAY)).toBe(false)
  })
})
