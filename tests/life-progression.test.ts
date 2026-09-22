/**
 * آزمون‌های «پیامدِ تصمیم» در هستهٔ زندگی.
 *
 * هر آزمون اینجا یک باگِ واقعیِ اصلاح‌شده را نگهبانی می‌کند؛ کنارِ هر بلوک
 * نوشته شده که پیش‌تر چه اتفاقی می‌افتاد.
 */

import {
  DegreeLevel,
  PlayerActivityState,
  PlayerStatus,
  PrismaClient
} from '@prisma/client'
import { PlayerService } from '../src/modules/identity/player.service'
import { PlayerRepository } from '../src/database/repositories/player.repository'
import { EducationService } from '../src/modules/education/education.service'
import { PlayerSkillRepository } from '../src/database/repositories/player-skill.repository'
import { SkillRepository } from '../src/database/repositories/skill.repository'
import { WorkSessionService } from '../src/modules/occupation/work-session.service'
import {
  WorkSessionRepository,
  isActiveSessionConflict
} from '../src/database/repositories/work-session.repository'
import { IncomeCalculationService } from '../src/modules/occupation/income-calculation.service'
import { JobCapacityService } from '../src/modules/occupation/job-market.service'
import { JobCapacityRepository } from '../src/database/repositories/job-capacity.repository'
import { PlayerStateMachine } from '../src/modules/identity/player-state-machine'
import { LifeStage } from '../src/modules/lifecycle/lifecycle.service'
import { ConflictError } from '../src/utils/classes/errors'
import { parseAmountDetailed } from '../src/utils/commands'

/** یک سال بازی = ۱۲ روز واقعی (ساعت مرکزی بازی). نام WEEK در تست‌ها مانده تا کد کم‌تغییر بماند. */
const WEEK = 12 * 24 * 60 * 60 * 1000
const DAY = 24 * 60 * 60 * 1000

function profileRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'p1',
    telegramUserId: 1n,
    firstName: 'علی',
    lastName: null,
    username: null,
    gender: 'MALE',
    age: 20,
    startedAt: new Date(),
    lifeStage: 'YOUTH',
    biography: 'زندگی',
    maritalStatus: 'SINGLE',
    socialLevel: 'LOW',
    health: 100,
    fatigue: 0,
    experience: 0,
    balance: 0,
    currentDegree: 'DIPLOMA',
    graduationField: null,
    occupation: null,
    homeGroup: null,
    skills: [],
    groupMemberships: [],
    gymMemberships: [],
    workSessions: [],
    employments: [],
    ownedBusinesses: [],
    ...overrides
  }
}

function makeProfileRepo(row: Record<string, unknown>) {
  return {
    findByTelegramUserIdWithRelations: jest.fn().mockResolvedValue(row),
    syncLifeStage: jest.fn().mockResolvedValue(1)
  }
}

describe('مرحلهٔ زندگی · ستونِ دیتابیس دیگر منبع حقیقت نیست', () => {
  test('پیش‌تر ستون همیشه «جوانی» بود؛ حالا مرحله از سنِ مؤثر گرفته می‌شود', async () => {
    // شخصیت ۲۰ هفته بازی‌کرده = ۴۰ سال؛ ستونِ دیتابیس هنوز YOUTH مانده
    const repo = makeProfileRepo(
      profileRow({ age: 20, startedAt: new Date(Date.now() - 20 * WEEK), lifeStage: 'YOUTH' })
    )

    const profile = await new PlayerService(repo as unknown as PlayerRepository).getProfile(1n)

    expect(profile.age).toBe(40)
    expect(profile.lifeStage).toBe(LifeStage.ADULTHOOD)
    expect(profile.lifeStageLabel).toBe('بزرگسالی')
  })

  test('ستونِ مانده تنبل و شرطی با سن هم‌راستا می‌شود', async () => {
    const repo = makeProfileRepo(
      profileRow({ age: 20, startedAt: new Date(Date.now() - 60 * WEEK), lifeStage: 'YOUTH' })
    )

    await new PlayerService(repo as unknown as PlayerRepository).getProfile(1n)

    expect(repo.syncLifeStage).toHaveBeenCalledWith('p1', LifeStage.SENIORITY, 'YOUTH')
  })

  test('وقتی مرحله درست است، نوشتاری انجام نمی‌شود', async () => {
    const repo = makeProfileRepo(profileRow({ age: 20, lifeStage: 'YOUTH' }))

    await new PlayerService(repo as unknown as PlayerRepository).getProfile(1n)

    expect(repo.syncLifeStage).not.toHaveBeenCalled()
  })

  test('خطای هم‌راستاسازی، شناسنامه را نمی‌شکند', async () => {
    const repo = {
      findByTelegramUserIdWithRelations: jest
        .fn()
        // ۲۵ هفته = ۲۵ سال؛ ۲۰ + ۲۵ = ۴۵ سال یعنی بزرگسالی
        .mockResolvedValue(profileRow({ age: 20, startedAt: new Date(Date.now() - 25 * WEEK) })),
      syncLifeStage: jest.fn().mockImplementation(() => {
        throw new Error('db down')
      })
    }

    const profile = await new PlayerService(repo as unknown as PlayerRepository).getProfile(1n)
    expect(profile.lifeStage).toBe(LifeStage.ADULTHOOD)
  })
})

describe('بهره‌وری · روی شناسنامه دروغ نمی‌گوید', () => {
  test('مهارتِ مرتبطِ آخرین شغل، بهره‌وری را بالا می‌برد', async () => {
    const unskilled = makeProfileRepo(
      profileRow({ workSessions: [{ jobKey: 'programmer', jobTitle: 'برنامه‌نویس', status: 'ACTIVE' }] })
    )
    const skilled = makeProfileRepo(
      profileRow({
        workSessions: [{ jobKey: 'programmer', jobTitle: 'برنامه‌نویس', status: 'ACTIVE' }],
        skills: [{ level: 9, skill: { name: 'برنامه‌نویسی' } }]
      })
    )

    const low = await new PlayerService(unskilled as unknown as PlayerRepository).getProfile(1n)
    const high = await new PlayerService(skilled as unknown as PlayerRepository).getProfile(1n)

    expect(high.productivityScore).toBeGreaterThan(low.productivityScore)
    expect(high.productivityMultiplier).toBeGreaterThan(low.productivityMultiplier)
  })

  test('خستگی و سلامتِ بد، بهره‌وری را پایین می‌آورد', async () => {
    const fresh = makeProfileRepo(profileRow({ health: 100, fatigue: 0 }))
    const worn = makeProfileRepo(profileRow({ health: 35, fatigue: 88 }))

    const a = await new PlayerService(fresh as unknown as PlayerRepository).getProfile(1n)
    const b = await new PlayerService(worn as unknown as PlayerRepository).getProfile(1n)

    expect(b.productivityScore).toBeLessThan(a.productivityScore)
  })

  test('سنِ بالا بهره‌وری را کمی کم می‌کند، اما صفر نمی‌کند', async () => {
    const young = makeProfileRepo(profileRow({ age: 18, startedAt: new Date() }))
    const senior = makeProfileRepo(
      profileRow({ age: 18, startedAt: new Date(Date.now() - 52 * WEEK) })
    )

    const a = await new PlayerService(young as unknown as PlayerRepository).getProfile(1n)
    const b = await new PlayerService(senior as unknown as PlayerRepository).getProfile(1n)

    expect(a.age).toBe(18)
    expect(b.age).toBe(70)
    expect(b.productivityMultiplier).toBeLessThan(a.productivityMultiplier)
    expect(b.productivityMultiplier).toBeGreaterThan(0)
  })
})

describe('فارغ‌التحصیلی · اتمیک و بدونِ پسرفتِ مهارت', () => {
  function makeEducation(player: Record<string, unknown>) {
    const playerRepo = {
      findByTelegramUserId: jest.fn().mockResolvedValue(player),
      update: jest.fn(),
      enrollStudent: jest.fn().mockResolvedValue(1),
      completeDegree: jest.fn().mockResolvedValue(1)
    }
    const playerSkillRepo = { assign: jest.fn(), awardLevel: jest.fn() }
    const skillRepo = {
      findByName: jest.fn().mockImplementation(async (name: string) => ({ id: `sk-${name}`, name })),
      findIdsByNames: jest
        .fn()
        .mockImplementation(async (names: readonly string[]) => new Map(names.map((n) => [n, `sk-${n}`])))
    }
    const service = new EducationService(
      playerRepo as unknown as PlayerRepository,
      playerSkillRepo as unknown as PlayerSkillRepository,
      skillRepo as unknown as SkillRepository
    )
    return { service, playerRepo, playerSkillRepo }
  }

  const STUDENT = {
    id: 'p1',
    age: 22,
    startedAt: new Date(),
    isEnrolled: true,
    enrolledFieldKey: 'software_engineering',
    targetDegree: DegreeLevel.BACHELOR,
    studyStartedAt: new Date(Date.now() - 200 * 60 * 1000), // دورهٔ ۱۲۰ دقیقه‌ای تمام شده
    currentDegree: DegreeLevel.DIPLOMA
  }

  test('مدرک با نوشتارِ شرطی صادر می‌شود، نه read-then-write', async () => {
    const { service, playerRepo, playerSkillRepo } = makeEducation(STUDENT)

    const result = await service.graduate(42n)

    expect(playerRepo.completeDegree).toHaveBeenCalledTimes(1)
    expect(playerRepo.update).not.toHaveBeenCalled()
    expect(playerRepo.completeDegree.mock.calls[0][1]).toMatchObject({
      enrolledFieldKey: 'software_engineering',
      degree: DegreeLevel.BACHELOR,
      graduationField: 'مهندسی کامپیوتر و نرم‌افزار'
    })
    expect(result.degreeLabel).toContain('کارشناسی')
    expect(playerSkillRepo.awardLevel).toHaveBeenCalled()
    // پیش‌تر از `assign` استفاده می‌شد که سطح را بازنویسی می‌کرد
    expect(playerSkillRepo.assign).not.toHaveBeenCalled()
  })

  test('دو کلیک همزمان روی «دریافت مدرک» فقط یک بار مدرک می‌دهد', async () => {
    const { service, playerRepo } = makeEducation(STUDENT)
    // نوشتارِ شرطی هیچ ردیفی را پیدا نمی‌کند → یعنی قبلاً صادر شده
    playerRepo.completeDegree.mockResolvedValue(0)

    await expect(service.graduate(42n)).rejects.toThrow(ConflictError)
  })

  test('پیش از پایانِ دوره، مدرکی صادر نمی‌شود', async () => {
    const { service, playerRepo } = makeEducation({
      ...STUDENT,
      // یک دقیقهٔ واقعی = ۳۰ دقیقهٔ بازی؛ کمتر از طول هر دورهٔ تحصیلی
      studyStartedAt: new Date(Date.now() - 60 * 1000)
    })

    await expect(service.graduate(42n)).rejects.toThrow()
    expect(playerRepo.completeDegree).not.toHaveBeenCalled()
  })

  test('awardLevel هرگز سطحِ کسب‌شده با کار را پایین نمی‌آورد', async () => {
    const rows = new Map<string, { id: string; level: number }>()
    rows.set('p1|sk1', { id: 'r1', level: 7 })

    const tx = {
      playerSkill: {
        findUnique: jest.fn().mockResolvedValue(rows.get('p1|sk1') ?? null),
        create: jest.fn(),
        update: jest.fn().mockResolvedValue({ id: 'r1', level: 7 })
      }
    }
    const repo = new PlayerSkillRepository(tx as unknown as PrismaClient)

    const result = await repo.awardLevel('p1', 'sk1', 2)

    // سطح ۷ حفظ می‌شود و هیچ نوشتاری انجام نمی‌شود
    expect(result.level).toBe(7)
    expect(tx.playerSkill.update).not.toHaveBeenCalled()
    expect(tx.playerSkill.create).not.toHaveBeenCalled()
  })

  test('awardLevel برای مهارتِ ثبت‌نشده، ردیف می‌سازد', async () => {
    const tx = {
      playerSkill: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'new', level: 2 }),
        update: jest.fn()
      }
    }
    const repo = new PlayerSkillRepository(tx as unknown as PrismaClient)

    const result = await repo.awardLevel('p1', 'sk1', 2)

    expect(result.level).toBe(2)
    expect(tx.playerSkill.create).toHaveBeenCalledTimes(1)
  })

  test('awardLevel از سقفِ سطح مهارت بالاتر نمی‌رود', async () => {
    const tx = {
      playerSkill: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation(async (args: { data: { level: number } }) => ({
          id: 'new',
          level: args.data.level
        })),
        update: jest.fn()
      }
    }
    const repo = new PlayerSkillRepository(tx as unknown as PrismaClient)

    const result = await repo.awardLevel('p1', 'sk1', 99)
    expect(result.level).toBe(10)
  })
})

describe('نوبت کاری · یک شیفت فعال، بدونِ نشتیِ ظرفیت', () => {
  function makeWorkSession() {
    const playerRepository = { findByTelegramUserId: jest.fn(), countPlayers: jest.fn() }
    const workSessionRepository = {
      findActiveSession: jest.fn(),
      startSession: jest.fn(),
      endSession: jest.fn(),
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

  test('رقابت روی «شروع کار» پیامِ انسانی می‌دهد و ظرفیت را آزاد می‌کند', async () => {
    const { service, playerRepository, workSessionRepository, jobCapacityService } = makeWorkSession()
    playerRepository.findByTelegramUserId.mockResolvedValue(IDLE)
    // نقضِ شاخصِ یکتای one_active_work_session_per_player
    workSessionRepository.startSession.mockRejectedValue({
      code: 'P2002',
      meta: { target: ['one_active_work_session_per_player'] }
    })

    await expect(service.startPartTimeWork(42n, 'courier')).rejects.toThrow(ConflictError)
    expect(jobCapacityService.releaseSlot).toHaveBeenCalledWith('courier')
  })

  test('پیامِ داخلیِ «شیفت فعال داری» هم به همان خطا نگاشت می‌شود', () => {
    expect(isActiveSessionConflict(new Error('Player already has an active work session'))).toBe(true)
    expect(isActiveSessionConflict(new Error('چیز دیگر'))).toBe(false)
    expect(isActiveSessionConflict(null)).toBe(false)
  })

  test('با سلامتِ خیلی پایین یا خستگیِ کامل، شیفت تازه شروع نمی‌شود', async () => {
    const { service, playerRepository, workSessionRepository } = makeWorkSession()

    playerRepository.findByTelegramUserId.mockResolvedValue({ ...IDLE, health: 5 })
    await expect(service.startPartTimeWork(42n, 'courier')).rejects.toThrow(ConflictError)

    playerRepository.findByTelegramUserId.mockResolvedValue({ ...IDLE, fatigue: 100 })
    await expect(service.startPartTimeWork(42n, 'courier')).rejects.toThrow(ConflictError)

    expect(workSessionRepository.startSession).not.toHaveBeenCalled()
  })

  test('توقفِ کار، ظرفیت را آزاد و دستمزد را یک بار تسویه می‌کند', async () => {
    const { service, playerRepository, workSessionRepository, jobCapacityService } = makeWorkSession()
    playerRepository.findByTelegramUserId.mockResolvedValue({ ...IDLE, activityState: 'WORKING' })
    workSessionRepository.findActiveSession.mockResolvedValue({
      id: 's1',
      playerId: 'p1',
      jobKey: 'courier',
      jobTitle: 'پیک',
      payPerMinute: 5500,
      startedAt: new Date(Date.now() - 20 * 60 * 1000),
      status: 'ACTIVE'
    })
    workSessionRepository.endSession.mockResolvedValue({ id: 's1', jobTitle: 'پیک' })

    const result = await service.stopWork(42n)

    expect(result.summary.totalEarnedMoney).toBeGreaterThan(0)
    expect(workSessionRepository.endSession).toHaveBeenCalledTimes(1)
    expect(jobCapacityService.releaseSlot).toHaveBeenCalledWith('courier')
  })

  test('رشتهٔ هم‌حوزه، دستمزدِ همان شیفت را بالا می‌برد', async () => {
    const software = 'مهندسی کامپیوتر و نرم‌افزار'
    const run = async (graduationField: string | null) => {
      const { service, playerRepository, workSessionRepository } = makeWorkSession()
      playerRepository.findByTelegramUserId.mockResolvedValue({
        ...IDLE,
        activityState: 'WORKING',
        currentDegree: 'BACHELOR',
        graduationField
      })
      workSessionRepository.findActiveSession.mockResolvedValue({
        id: 's1',
        playerId: 'p1',
        jobKey: 'programmer',
        jobTitle: 'برنامه‌نویس',
        payPerMinute: 9000,
        startedAt: new Date(Date.now() - 30 * 60 * 1000),
        status: 'ACTIVE'
      })
      workSessionRepository.endSession.mockResolvedValue({ id: 's1', jobTitle: 'برنامه‌نویس' })
      return service.stopWork(42n)
    }

    const matched = await run(software)
    const unmatched = await run(null)

    expect(matched.summary.fieldMatched).toBe(true)
    expect(unmatched.summary.fieldMatched).toBe(false)
    expect(matched.summary.totalEarnedMoney).toBeGreaterThan(unmatched.summary.totalEarnedMoney)
  })
})

describe('ظرفیت شغل · نشتیِ شمارنده بسته می‌شود', () => {
  test('همگام‌سازی، شمارندهٔ اشغال را با شیفت‌های فعالِ واقعی آشتی می‌دهد', async () => {
    const jobCapacityRepository = {
      listAll: jest
        .fn()
        .mockResolvedValue([
          { jobKey: 'courier', capacity: 10, occupied: 6 },
          { jobKey: 'cook', capacity: 8, occupied: 0 }
        ]),
      upsertCapacity: jest.fn(),
      reconcileOccupied: jest.fn().mockResolvedValue(1),
      findByJobKey: jest.fn()
    }
    const playerRepository = { countPlayers: jest.fn().mockResolvedValue(10) }
    const workSessionRepository = {
      // واقعیت: فقط ۲ شیفت فعال روی courier و هیچ‌کدام روی cook
      countActiveByJob: jest.fn().mockResolvedValue(new Map([['courier', 2]]))
    }

    const service = new JobCapacityService(
      jobCapacityRepository as unknown as JobCapacityRepository,
      playerRepository as unknown as PlayerRepository,
      workSessionRepository as unknown as WorkSessionRepository
    )

    await service.syncCapacities()

    expect(workSessionRepository.countActiveByJob).toHaveBeenCalledTimes(1)
    // ظرفیتِ نشت‌کردهٔ courier برگردانده می‌شود
    expect(jobCapacityRepository.reconcileOccupied).toHaveBeenCalledWith('courier', 2)
    // cook درست بود؛ نوشتارِ بی‌اثر انجام نمی‌شود
    expect(jobCapacityRepository.reconcileOccupied).not.toHaveBeenCalledWith('cook', 0)
  })

  test('بدونِ ریپازیتوریِ نوبت کاری، همگام‌سازی مثل قبل کار می‌کند', async () => {
    const jobCapacityRepository = {
      listAll: jest.fn().mockResolvedValue([{ jobKey: 'courier', capacity: 10, occupied: 6 }]),
      upsertCapacity: jest.fn(),
      reconcileOccupied: jest.fn()
    }
    const service = new JobCapacityService(
      jobCapacityRepository as unknown as JobCapacityRepository,
      { countPlayers: jest.fn().mockResolvedValue(10) } as unknown as PlayerRepository
    )

    await expect(service.syncCapacities()).resolves.toBeUndefined()
    expect(jobCapacityRepository.reconcileOccupied).not.toHaveBeenCalled()
  })
})

describe('ماشین حالت · تحصیل، بازیابیِ توان را قفل نمی‌کند', () => {
  test('استراحت در دوران تحصیل مجاز است', () => {
    expect(() =>
      PlayerStateMachine.assertCanStartActivity(
        PlayerStatus.ACTIVE,
        PlayerActivityState.STUDYING,
        PlayerActivityState.RESTING
      )
    ).not.toThrow()
  })

  test('کار در دوران تحصیل همچنان ممنوع است', () => {
    expect(() =>
      PlayerStateMachine.assertCanStartActivity(
        PlayerStatus.ACTIVE,
        PlayerActivityState.STUDYING,
        PlayerActivityState.WORKING
      )
    ).toThrow(ConflictError)
  })

  test('انتقال‌های نامعتبر همچنان رد می‌شوند', () => {
    expect(() =>
      PlayerStateMachine.assertCanStartActivity(
        PlayerStatus.ACTIVE,
        PlayerActivityState.RESTING,
        PlayerActivityState.STUDYING
      )
    ).toThrow(ConflictError)
    expect(() =>
      PlayerStateMachine.assertCanStartActivity(
        PlayerStatus.ACTIVE,
        PlayerActivityState.TRAVELING,
        PlayerActivityState.WORKING
      )
    ).toThrow(ConflictError)
    expect(() =>
      PlayerStateMachine.assertCanStartActivity(
        PlayerStatus.DEAD,
        PlayerActivityState.IDLE,
        PlayerActivityState.RESTING
      )
    ).toThrow(ConflictError)
  })

  test('پایانِ استراحت، بازیکنِ در حال تحصیل را «آزاد» نمی‌کند', () => {
    expect(PlayerStateMachine.activityAfterRest(true)).toBe(PlayerActivityState.STUDYING)
    expect(PlayerStateMachine.activityAfterRest(false)).toBe(PlayerActivityState.IDLE)
  })
})

describe('ورودی عددی · رقم‌های فارسی و انگلیسی', () => {
  test('تنظیم سلامت/خستگی با رقم فارسی و انگلیسی یکی می‌شود', () => {
    const persian = parseAmountDetailed('۸۰', { allowZero: true, max: 100 })
    const english = parseAmountDetailed('80', { allowZero: true, max: 100 })

    expect(persian.ok).toBe(true)
    expect(english.ok).toBe(true)
    if (persian.ok && english.ok) {
      expect(persian.value).toBe(english.value)
      expect(persian.value).toBe(80)
    }
  })

  test('مقدارِ خارج از بازه رد می‌شود، نه اینکه بی‌صدا clamp شود', () => {
    const tooHigh = parseAmountDetailed('۵۰۰', { allowZero: true, max: 100 })
    expect(tooHigh.ok).toBe(false)

    const garbage = parseAmountDetailed('سلام', { allowZero: true, max: 100 })
    expect(garbage.ok).toBe(false)
  })

  test('صفر فقط با allowZero پذیرفته می‌شود', () => {
    expect(parseAmountDetailed('۰', { allowZero: true, max: 100 }).ok).toBe(true)
    expect(parseAmountDetailed('۰', { allowZero: false, max: 100 }).ok).toBe(false)
  })
})

describe('تقویم بازی · سن در مرزها', () => {
  test('کمترین سنِ شغل‌ها با سنِ مؤثر سنجیده می‌شود، نه سنِ ثبت‌نام', async () => {
    // بازیکنی که ۵ هفته بازی کرده = ۲۱ سال؛ شغلِ ۲۱ سال به بالا برایش باز است
    const playerRepository = { findByTelegramUserId: jest.fn(), countPlayers: jest.fn() }
    const workSessionRepository = {
      findActiveSession: jest.fn(),
      startSession: jest.fn().mockResolvedValue({ id: 's1', jobTitle: 'مترجم' }),
      endSession: jest.fn()
    }
    const jobCapacityService = {
      takeSlot: jest.fn().mockResolvedValue(true),
      releaseSlot: jest.fn()
    }
    const service = new WorkSessionService(
      workSessionRepository as unknown as WorkSessionRepository,
      playerRepository as unknown as PlayerRepository,
      new IncomeCalculationService(),
      jobCapacityService as unknown as JobCapacityService
    )

    // translator حداقل سن ۲۱ و مدرک کارشناسی می‌خواهد
    playerRepository.findByTelegramUserId.mockResolvedValue({
      id: 'p1',
      age: 18,
      startedAt: new Date(Date.now() - 3 * WEEK), // ۲۱ سال
      status: PlayerStatus.ACTIVE,
      activityState: PlayerActivityState.IDLE,
      experience: 0,
      fatigue: 0,
      health: 100,
      currentDegree: 'BACHELOR',
      graduationField: null
    })

    const session = await service.startPartTimeWork(42n, 'translator')
    expect(session.jobTitle).toBe('مترجم')

    // و یک روز کمتر از ۲۱ سال → رد
    playerRepository.findByTelegramUserId.mockResolvedValue({
      id: 'p1',
      age: 18,
      startedAt: new Date(Date.now() - 2 * DAY),
      status: PlayerStatus.ACTIVE,
      activityState: PlayerActivityState.IDLE,
      experience: 0,
      fatigue: 0,
      health: 100,
      currentDegree: 'BACHELOR',
      graduationField: null
    })
    await expect(service.startPartTimeWork(42n, 'translator')).rejects.toThrow(ConflictError)
  })
})
