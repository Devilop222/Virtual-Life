/**
 * آزمون‌های هستهٔ زندگی بازیکن.
 *
 * هدف این فایل یک چیز است: هیچ عددی که به بازیکن نشان می‌دهیم تزئینی نباشد.
 * پس علاوه بر مرزهای هر ضریب، این‌ها هم سنجیده می‌شوند:
 *   • یکنواختی (هیچ‌وقت تلاشِ بیشتر، درآمد را کم نکند)
 *   • سقف‌ها (Power Creep نداشته باشیم)
 *   • کف‌ها (بازیکن تازه‌وارد نابود نشود)
 *   • یکی‌بودنِ «نمایش» و «واقعیت» (بهره‌وری = همان ضریبِ دستمزد)
 */

import {
  BASE_HEALTH_CAP,
  MAX_EDUCATION_FACTOR,
  MAX_EXPERIENCE_FACTOR,
  MAX_FATIGUE,
  MAX_SKILL_LEVEL,
  MAX_WORK_MULTIPLIER,
  MIN_CONDITION_FACTOR,
  MIN_HEALTH,
  ageFactor,
  canWorkWithBody,
  conditionFactor,
  educationFactor,
  educationRankOf,
  experienceFactor,
  fatigueFactor,
  fieldMatchesCategory,
  healthFactor,
  healthPercent,
  lifeStageFor,
  productivity,
  productivityHint,
  productivityLabel,
  skillFactor,
  workMultiplier
} from '../src/modules/life/life-core'
import { LifeStage } from '../src/modules/lifecycle/lifecycle.service'
import { EDUCATION_FIELDS } from '../src/modules/education/education-blueprints'
import { PART_TIME_JOBS } from '../src/modules/occupation/work-blueprints'
import { computeProductivity } from '../src/modules/identity/player.service'
import { IncomeCalculationService } from '../src/modules/occupation/income-calculation.service'

const income = new IncomeCalculationService()

/** بازیکن تازه‌وارد — مبنای همهٔ مقایسه‌ها. */
const NEWBIE = {
  health: 100,
  fatigue: 0,
  experience: 0,
  educationRank: 1,
  graduationField: null,
  jobCategory: null,
  age: 18
} as const

describe('life-core · توان بدنی', () => {
  test('سلامت کامل ضریب ۱ می‌دهد و سلامت صفر به کف ۰٫۵ می‌رسد', () => {
    expect(healthFactor(100)).toBe(1)
    expect(healthFactor(80)).toBe(1)
    expect(healthFactor(50)).toBeCloseTo(0.75, 5)
    expect(healthFactor(20)).toBeCloseTo(0.6, 5)
    expect(healthFactor(0)).toBeCloseTo(0.5, 5)
  })

  test('سلامت درصدی حساب می‌شود، نه مطلق — عضو باشگاه با ۱۰۰ از ۱۲۰ کامل نیست', () => {
    expect(healthPercent(100, 120)).toBe(83)
    // ۹۶ از ۱۲۰ یعنی ۸۰٪ → ضریب کامل
    expect(healthFactor(96, 120)).toBe(1)
    // ۶۰ از ۱۲۰ یعنی ۵۰٪ → همان ضریبی که بازیکن عادی با ۵۰ از ۱۰۰ می‌گیرد
    expect(healthFactor(60, 120)).toBeCloseTo(healthFactor(50, 100), 5)
    // و هرگز «سالم‌تر از سقف» حساب نمی‌شود
    expect(healthFactor(120, 120)).toBe(1)
  })

  test('خستگی تا ۲۰ بی‌اثر است و در ۱۰۰ به کف ۰٫۵ می‌رسد', () => {
    expect(fatigueFactor(0)).toBe(1)
    expect(fatigueFactor(20)).toBe(1)
    expect(fatigueFactor(60)).toBeCloseTo(0.75, 5)
    expect(fatigueFactor(90)).toBeCloseTo(0.55, 5)
    expect(fatigueFactor(100)).toBeCloseTo(0.5, 5)
  })

  test('ضریب توان بدنی هرگز زیر کف نمی‌رود و هرگز بالای ۱ نمی‌شود', () => {
    expect(conditionFactor(0, 100)).toBe(MIN_CONDITION_FACTOR)
    expect(conditionFactor(100, 0)).toBe(1)
    expect(conditionFactor(1, 99)).toBeGreaterThanOrEqual(MIN_CONDITION_FACTOR)
    // مقدارِ خارج از بازه هم clamp می‌شود
    expect(conditionFactor(500, -20)).toBe(1)
  })

  test('ورودیِ خراب «سالم کامل» فرض می‌شود، نه صفر', () => {
    expect(healthFactor(Number.NaN)).toBe(1)
    expect(fatigueFactor(Number.NaN)).toBe(1)
    expect(healthPercent(Number.NaN, 100)).toBe(100)
  })

  test('با سلامتِ زیر ۱۱ یا خستگیِ صد نمی‌شود کار کرد', () => {
    expect(canWorkWithBody(11, 0)).toBe(true)
    expect(canWorkWithBody(10, 0)).toBe(false)
    expect(canWorkWithBody(100, MAX_FATIGUE - 1)).toBe(true)
    expect(canWorkWithBody(100, MAX_FATIGUE)).toBe(false)
  })
})

describe('life-core · مهارت و سابقه', () => {
  test('هر سطح مهارت ۱۰٪ و سقفش سطح ۱۰ است', () => {
    expect(skillFactor(undefined)).toBe(1)
    expect(skillFactor(null)).toBe(1)
    expect(skillFactor(1)).toBe(1)
    expect(skillFactor(5)).toBeCloseTo(1.4, 5)
    expect(skillFactor(MAX_SKILL_LEVEL)).toBeCloseTo(1.9, 5)
    // مقدار خارج از بازه
    expect(skillFactor(99)).toBeCloseTo(1.9, 5)
    expect(skillFactor(0)).toBe(1)
  })

  test('سابقه تا ۱۰۰۰ امتیاز بالا می‌رود (نه فقط تا ۱۰۰) و سقفش ۱٫۲۰ است', () => {
    expect(experienceFactor(0)).toBe(1)
    expect(experienceFactor(10)).toBeCloseTo(1.04, 5)
    expect(experienceFactor(50)).toBeCloseTo(1.08, 5)
    // رگرسیون: سابقهٔ ۵۰۰ پیش‌تر اشباع شده بود؛ حالا هنوز در حال رشد است
    expect(experienceFactor(500)).toBeGreaterThan(experienceFactor(100))
    expect(experienceFactor(1000)).toBe(MAX_EXPERIENCE_FACTOR)
    expect(experienceFactor(1_000_000)).toBe(MAX_EXPERIENCE_FACTOR)
    expect(experienceFactor(-50)).toBe(1)
  })
})

describe('life-core · تحصیل و رشته', () => {
  test('رتبهٔ مدرک از کاتالوگ می‌آید و بی‌مدرک = دیپلم', () => {
    expect(educationRankOf(null)).toBe(1)
    expect(educationRankOf(undefined)).toBe(1)
    expect(educationRankOf('BACHELOR')).toBe(3)
    expect(educationRankOf('DOCTORATE')).toBe(5)
    expect(educationRankOf('چیزِ نامعتبر')).toBe(1)
  })

  test('هر پلهٔ مدرک ۵٪ و هم‌حوزه بودن رشته ۶٪ بیشتر می‌دهد، با سقف ۱٫۳۰', () => {
    expect(educationFactor(1)).toBe(1)
    expect(educationFactor(5)).toBeCloseTo(1.2, 5)
    expect(educationFactor(1, true)).toBeCloseTo(1.06, 5)
    expect(educationFactor(5, true)).toBeCloseTo(1.26, 5)
    expect(educationFactor(99, true)).toBeLessThanOrEqual(MAX_EDUCATION_FACTOR)
  })

  test('رشته فقط در دسته‌های هم‌حوزهٔ خودش اثر دارد', () => {
    const medicine = EDUCATION_FIELDS.find((f) => f.key === 'medicine')!
    expect(fieldMatchesCategory(medicine.title, 'درمانی')).toBe(true)
    expect(fieldMatchesCategory(medicine.title, 'رستوران و پذیرایی')).toBe(false)
    expect(fieldMatchesCategory(null, 'درمانی')).toBe(false)
    expect(fieldMatchesCategory('رشتهٔ ناموجود', 'درمانی')).toBe(false)
  })

  test('همهٔ دسته‌های هم‌حوزه، دستهٔ شغلیِ واقعی‌اند (نه کلمهٔ اختراعی)', () => {
    // دسته‌ها از خودِ کاتالوگ شغل‌ها خوانده می‌شوند، نه از یک فهرست دستی
    const realCategories = new Set<string>(PART_TIME_JOBS.map((job) => job.category))

    for (const field of EDUCATION_FIELDS) {
      for (const category of field.affinityCategories) {
        expect(realCategories.has(category)).toBe(true)
      }
    }
  })

  test('هر رشته حداقل یک دستهٔ هم‌حوزه دارد، وگرنه انتخابش بی‌پیامد است', () => {
    for (const field of EDUCATION_FIELDS) {
      expect(field.affinityCategories.length).toBeGreaterThan(0)
    }
  })
})

describe('life-core · سن و مرحلهٔ زندگی', () => {
  test('ضریب سن ملایم است و هرگز زیر ۰٫۹۰ نمی‌رود', () => {
    expect(ageFactor(17)).toBe(0.92)
    expect(ageFactor(18)).toBe(1)
    expect(ageFactor(49)).toBe(1)
    expect(ageFactor(50)).toBe(0.97)
    expect(ageFactor(64)).toBe(0.97)
    expect(ageFactor(65)).toBe(0.9)
    expect(ageFactor(120)).toBe(0.9)
  })

  test('مرحلهٔ زندگی از سن گرفته می‌شود', () => {
    expect(lifeStageFor(9)).toBe(LifeStage.CHILDHOOD)
    expect(lifeStageFor(16)).toBe(LifeStage.ADOLESCENCE)
    expect(lifeStageFor(30)).toBe(LifeStage.YOUTH)
    expect(lifeStageFor(45)).toBe(LifeStage.ADULTHOOD)
    expect(lifeStageFor(60)).toBe(LifeStage.MIDDLE_AGE)
    expect(lifeStageFor(80)).toBe(LifeStage.SENIORITY)
  })
})

describe('life-core · ضریب کار و توازن اقتصادی', () => {
  test('تازه‌وارد دقیقاً ضریب ۱ می‌گیرد — نه جریمه، نه پاداش', () => {
    expect(workMultiplier(NEWBIE).total).toBeCloseTo(1, 10)
  })

  test('قوی‌ترین بازیکنِ ممکن زیر ۳ برابرِ تازه‌وارد می‌گیرد (بدون Power Creep)', () => {
    const veteran = workMultiplier({
      health: 120,
      maxHealth: 120,
      fatigue: 0,
      experience: 50_000,
      educationRank: 5,
      graduationField: EDUCATION_FIELDS.find((f) => f.key === 'software_engineering')!.title,
      jobCategory: 'فناوری',
      skillLevelAverage: MAX_SKILL_LEVEL,
      age: 30
    })
    expect(veteran.total).toBeLessThan(3)
    expect(veteran.total).toBeCloseTo(MAX_WORK_MULTIPLIER, 5)
  })

  test('بازیکن سال‌خورده با همان مهارت، فقط کمی کمتر از جوان می‌گیرد', () => {
    const base = { ...NEWBIE, skillLevelAverage: 6, experience: 400, educationRank: 3 }
    const young = workMultiplier({ ...base, age: 30 }).total
    const senior = workMultiplier({ ...base, age: 70 }).total
    expect(senior).toBeLessThan(young)
    expect(senior / young).toBeGreaterThanOrEqual(0.89)
  })

  test('یکنواختی: بهتر شدن هیچ عاملی، درآمد را کم نمی‌کند', () => {
    const base = workMultiplier(NEWBIE).total
    expect(workMultiplier({ ...NEWBIE, health: 100, fatigue: 0 }).total).toBeGreaterThanOrEqual(base)
    expect(workMultiplier({ ...NEWBIE, experience: 900 }).total).toBeGreaterThan(base)
    expect(workMultiplier({ ...NEWBIE, skillLevelAverage: 7 }).total).toBeGreaterThan(base)
    expect(workMultiplier({ ...NEWBIE, educationRank: 4 }).total).toBeGreaterThan(base)
  })

  test('یکنواختی: هر واحد سلامتِ کمتر یا خستگیِ بیشتر، درآمد را کم می‌کند', () => {
    const at = (health: number, fatigue: number) =>
      workMultiplier({ ...NEWBIE, health, fatigue }).total
    expect(at(70, 0)).toBeLessThan(at(71, 0))
    expect(at(100, 40)).toBeLessThan(at(100, 39))
    // و در کف، دیگر پایین‌تر نمی‌رود
    expect(at(0, 100)).toBe(at(0, 100))
    expect(workMultiplier({ ...NEWBIE, health: 0, fatigue: 100 }).condition).toBe(
      MIN_CONDITION_FACTOR
    )
  })

  test('مقادیر حدی هیچ‌وقت NaN یا بی‌نهایت نمی‌سازند', () => {
    const extremes = [
      { health: -999, fatigue: 999, experience: -1, educationRank: -5, age: -1, skillLevelAverage: -3 },
      { health: 1e9, fatigue: -1e9, experience: 1e9, educationRank: 1e9, age: 1e9, skillLevelAverage: 1e9 },
      { health: Number.NaN, fatigue: Number.NaN, experience: Number.NaN, age: Number.NaN }
    ]
    for (const input of extremes) {
      const result = workMultiplier(input)
      expect(Number.isFinite(result.total)).toBe(true)
      expect(result.total).toBeGreaterThan(0)
      expect(Number.isFinite(productivity(result.total).score)).toBe(true)
    }
  })
})

describe('life-core · بهره‌وری همان ضریبِ دستمزد است', () => {
  test('تازه‌وارد ۴۰ و بهترین حالت ۱۰۰ می‌گیرد', () => {
    expect(productivity(1).score).toBe(40)
    expect(productivityLabel(40)).toBe('متوسط')
    expect(productivity(MAX_WORK_MULTIPLIER).score).toBe(100)
    expect(productivityLabel(100)).toBe('عالی')
  })

  test('توان بدنیِ از دست رفته، بهره‌وری را به «بحرانی» می‌رساند', () => {
    const broken = workMultiplier({ ...NEWBIE, health: 5, fatigue: 95 })
    expect(productivity(broken.total).score).toBeLessThan(25)
    expect(productivity(broken.total).label).toBe('بحرانی')
  })

  test('همهٔ برچسب‌ها دست‌یافتنی‌اند', () => {
    const seen = new Set<string>()
    for (let m = MIN_CONDITION_FACTOR; m <= MAX_WORK_MULTIPLIER; m += 0.01) {
      seen.add(productivityLabel(productivity(m).score))
    }
    for (const label of ['عالی', 'خوب', 'متوسط', 'پایین', 'بحرانی']) {
      expect(seen.has(label)).toBe(true)
    }
  })

  test('computeProductivity دیگر منحنیِ جداگانه ندارد و عینِ هسته رفتار می‌کند', () => {
    // سنِ هر مرحله، میانیِ همان مرحله است؛ پس دو مسیر باید عددِ یکی بدهند.
    const cases: Array<[number, number, number, number, LifeStage, number]> = [
      [100, 0, 0, 1, LifeStage.YOUTH, 26],
      [60, 45, 250, 3, LifeStage.MIDDLE_AGE, 57],
      [12, 92, 900, 5, LifeStage.SENIORITY, 70]
    ]
    for (const [health, fatigue, experience, educationRank, lifeStage, age] of cases) {
      const legacy = computeProductivity({
        health,
        maxHealth: BASE_HEALTH_CAP,
        fatigue,
        experience,
        educationRank,
        lifeStage
      })
      const direct = productivity(
        workMultiplier({
          health,
          fatigue,
          maxHealth: BASE_HEALTH_CAP,
          experience,
          educationRank,
          age
        }).total
      )
      expect(legacy.score).toBe(direct.score)
      expect(legacy.label).toBe(direct.label)
    }
  })

  test('عدد بهره‌وریِ پنل با ضریبِ واقعیِ دستمزدِ همان لحظه یکی است', () => {
    const input = {
      basePayPerMinute: 9_000,
      difficulty: 3,
      skillLevelAverage: 4,
      playerExperience: 300,
      educationRank: 3,
      graduationField: EDUCATION_FIELDS.find((f) => f.key === 'software_engineering')!.title,
      jobCategory: 'فناوری',
      age: 32,
      elapsedMinutes: 20,
      health: 72,
      fatigue: 55
    }
    const result = income.calculatePartTimeIncome(input, 0.1, 0.5, 0.2)
    const expected = productivity(
      workMultiplier({
        health: input.health,
        fatigue: input.fatigue,
        skillLevelAverage: input.skillLevelAverage,
        experience: input.playerExperience,
        educationRank: input.educationRank,
        graduationField: input.graduationField,
        jobCategory: input.jobCategory,
        age: input.age
      }).total
    )
    expect(result.productivityScore).toBe(expected.score)
  })

  test('راهنمای بهره‌وری فقط عامل‌های واقعاً پایین را نام می‌برد', () => {
    expect(productivityHint(workMultiplier({ ...NEWBIE, skillLevelAverage: 10, experience: 5000, educationRank: 5 }))).toBeNull()
    const tired = workMultiplier({ ...NEWBIE, fatigue: 90 })
    expect(productivityHint(tired)).toContain('توان بدنی')
    const unskilled = workMultiplier({ ...NEWBIE, skillLevelAverage: 1 })
    expect(productivityHint(unskilled)).toContain('مهارت')
  })
})

describe('life-core · درآمد واقعی از همان ضریب ساخته می‌شود', () => {
  test('دستمزد = پایه × سختی × ضریب کار', () => {
    const result = income.calculatePartTimeIncome(
      // ۱۰ دقیقهٔ واقعی = ۳۰۰ دقیقهٔ بازی؛ دستمزد مؤثر «در دقیقهٔ بازی» برمی‌گردد
      { ...NEWBIE, basePayPerMinute: 5_000, difficulty: 3, elapsedMinutes: 300 },
      0.3,
      1,
      0.4
    )
    expect(result.effectivePayPerMinute).toBe(Math.round((5_000 / 30) * 1.3 * 1))
    expect(result.totalEarnedMoney).toBe(result.effectivePayPerMinute * 300)
  })

  test('رشتهٔ هم‌حوزه واقعاً دستمزد را بالا می‌برد و رشتهٔ بی‌ربط نه', () => {
    const software = EDUCATION_FIELDS.find((f) => f.key === 'software_engineering')!.title
    const matched = income.calculatePartTimeIncome(
      {
        ...NEWBIE,
        basePayPerMinute: 9_000,
        difficulty: 3,
        educationRank: 3,
        graduationField: software,
        jobCategory: 'فناوری',
        elapsedMinutes: 30
      },
      0.1,
      0.5,
      0.2
    )
    const unmatched = income.calculatePartTimeIncome(
      {
        ...NEWBIE,
        basePayPerMinute: 9_000,
        difficulty: 3,
        educationRank: 3,
        graduationField: software,
        jobCategory: 'کشاورزی',
        elapsedMinutes: 30
      },
      0.1,
      0.5,
      0.2
    )
    const noDegree = income.calculatePartTimeIncome(
      {
        ...NEWBIE,
        basePayPerMinute: 9_000,
        difficulty: 3,
        graduationField: null,
        jobCategory: 'فناوری',
        elapsedMinutes: 30
      },
      0.1,
      0.5,
      0.2
    )

    expect(matched.fieldMatched).toBe(true)
    expect(unmatched.fieldMatched).toBe(false)
    expect(matched.totalEarnedMoney).toBeGreaterThan(unmatched.totalEarnedMoney)
    expect(unmatched.totalEarnedMoney).toBeGreaterThan(noDegree.totalEarnedMoney)
  })

  test('بازیکن خسته کمتر از بازیکن سرحال می‌گیرد، اما هیچ‌وقت صفر نمی‌گیرد', () => {
    const fresh = income.calculatePartTimeIncome(
      { ...NEWBIE, basePayPerMinute: 6_000, difficulty: 2, elapsedMinutes: 30, health: 100, fatigue: 0 },
      0.3,
      0.8,
      0.3
    )
    const worn = income.calculatePartTimeIncome(
      { ...NEWBIE, basePayPerMinute: 6_000, difficulty: 2, elapsedMinutes: 30, health: 30, fatigue: 95 },
      0.3,
      0.8,
      0.3
    )
    expect(worn.totalEarnedMoney).toBeLessThan(fresh.totalEarnedMoney)
    expect(worn.totalEarnedMoney).toBeGreaterThanOrEqual(fresh.totalEarnedMoney * 0.5)
    expect(worn.totalEarnedMoney).toBeGreaterThan(0)
  })

  test('کف سلامت هیچ‌وقت صفر نیست (پنل «فوت‌شده» دروغ نگوید)', () => {
    expect(MIN_HEALTH).toBeGreaterThan(0)
  })
})
