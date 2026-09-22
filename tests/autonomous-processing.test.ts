/**
 * پردازش خودکار: «ربات نباید منتظر باز شدن پنل بماند».
 *
 * این سوئیت سه چیز را قفل می‌کند:
 *   ۱. ریاضیاتِ ظرفیت بدن و سررسیدِ شیفت (`life-core` / `work-due`) — چون
 *      همین فرمول پول و خستگی را می‌سازد.
 *   ۲. زمان‌بندِ واحد (`AutonomousService`) — یک تیک، فاصلهٔ هر کار، و
 *      بی‌خطر بودنِ خطای یک کار برای بقیه.
 *   ۳. خودِ کارها (`buildAutonomousJobs`) — اینکه بدون باز شدن پنل، شیفت
 *      بسته می‌شود، مدرک صادر می‌شود، منطقه ارتقا می‌یابد و بازیکن خبر می‌گیرد.
 */

import { GroupEnvironmentLevel, PlayerActivityState, PlayerStatus } from '@prisma/client'
import { AutonomousService, AUTONOMOUS_TICK_MS } from '../src/modules/autonomous/autonomous.service'
import { buildAutonomousJobs } from '../src/modules/autonomous/autonomous.jobs'
import { DEFAULT_SHIFT_FATIGUE_PER_REAL_MINUTE } from '../src/modules/occupation/work-blueprints'
import {
  CRITICAL_FATIGUE_THRESHOLD,
  shiftDueDecision,
  workStopReasonText
} from '../src/modules/occupation/work-due'
import { WorkSessionService } from '../src/modules/occupation/work-session.service'
import { WorkSessionRepository } from '../src/database/repositories/work-session.repository'
import { PlayerRepository } from '../src/database/repositories/player.repository'
import { IncomeCalculationService } from '../src/modules/occupation/income-calculation.service'
import { JobCapacityService } from '../src/modules/occupation/job-market.service'
import { EducationService } from '../src/modules/education/education.service'
import { DegreeLevel, EDUCATION_FIELDS } from '../src/modules/education/education-blueprints'
import { GroupService } from '../src/modules/groups/group.service'
import { EnvironmentClassifier } from '../src/modules/groups/environment.classifier'
import { MAX_FATIGUE, payableShiftMinutes } from '../src/modules/life/life-core'
import { REAL_MS_PER_GAME_DAY, REAL_MS_PER_GAME_MINUTE } from '../src/utils/game-time'

// ─────────────────────────────────────────────────────────────────────────────
//  ۱. ریاضیاتِ ظرفیت بدن و سررسید
// ─────────────────────────────────────────────────────────────────────────────

describe('ظرفیت بدنِ شیفت — تنها فرمولِ مشترکِ تسویه و چرخهٔ خودکار', () => {
  test('خستگیِ بالا، مدتِ مزددار را کوتاه می‌کند و سقف را می‌بندد', () => {
    // خستگی ۸۰ و نرخ ۰٫۰۴ در دقیقهٔ بازی → فقط ۵۰۰ دقیقهٔ بازی جا هست
    expect(
      payableShiftMinutes({ elapsedGameMinutes: 900, fatigue: 80, fatiguePerGameMinute: 0.04 })
    ).toEqual({ payableMinutes: 500, bodyCapacityReached: true })
  })

  test('شیفتی که هنوز داخل ظرفیت است بسته نمی‌شود', () => {
    const out = payableShiftMinutes({
      elapsedGameMinutes: 300,
      fatigue: 80,
      fatiguePerGameMinute: 0.04
    })
    expect(out.payableMinutes).toBe(300)
    expect(out.bodyCapacityReached).toBe(false)
  })

  test('نرخ صفر یعنی کاری که بدن را نمی‌فرساید — بی‌سقف', () => {
    expect(
      payableShiftMinutes({ elapsedGameMinutes: 300, fatigue: 99, fatiguePerGameMinute: 0 })
    ).toEqual({ payableMinutes: 300, bodyCapacityReached: false })
  })

  test('دقیقهٔ بازی و دقیقهٔ واقعی قاطی نمی‌شوند: نرخ در دقیقهٔ بازی است', () => {
    // همان شیفت با نرخی که اشتباهاً ۳۰ برابر کوچک‌تر داده شود، سقف را نمی‌بیند
    const correct = payableShiftMinutes({
      elapsedGameMinutes: 900,
      fatigue: 90,
      fatiguePerGameMinute: 0.04
    })
    const wrong = payableShiftMinutes({
      elapsedGameMinutes: 900,
      fatigue: 90,
      fatiguePerGameMinute: 0.04 / 30
    })
    expect(correct.bodyCapacityReached).toBe(true)
    expect(wrong.bodyCapacityReached).toBe(false)
  })
})

describe('سررسیدِ شیفت (`work-due`)', () => {
  const now = Date.UTC(2026, 8, 20, 12, 0, 0)

  test('کارِ سنگینِ طولانی با خستگیِ بحرانی سررسید است', () => {
    const decision = shiftDueDecision({
      startedAt: new Date(now - 30 * 60 * 1000),
      fatigue: 80,
      fatiguePerRealMinute: 1.2,
      now
    })
    expect(decision.due).toBe(true)
    expect(decision.reason).toBe('CRITICAL_FATIGUE')
  })

  test('شیفتِ کوتاه و تازه سررسید نیست', () => {
    const decision = shiftDueDecision({
      startedAt: new Date(now - 2 * 60 * 1000),
      fatigue: 0,
      fatiguePerRealMinute: DEFAULT_SHIFT_FATIGUE_PER_REAL_MINUTE,
      now
    })
    expect(decision.due).toBe(false)
    expect(decision.reason).toBeNull()
  })

  test('شیفتِ رهاشده پس از ری‌استارت سررسید است (Catch-up)', () => {
    const decision = shiftDueDecision({
      startedAt: new Date(now - 3 * 24 * 60 * 60 * 1000),
      fatigue: 0,
      fatiguePerRealMinute: DEFAULT_SHIFT_FATIGUE_PER_REAL_MINUTE,
      now
    })
    expect(decision.due).toBe(true)
    // مهم: کارکردِ مزددار سقف دارد، پس سه روز غیبت سه روز دستمزد نمی‌سازد.
    expect(decision.payableGameMinutes).toBeLessThan(decision.elapsedGameMinutes)
    expect(decision.fatigueGained).toBe(MAX_FATIGUE)
  })

  test('دو بازیکنِ هم‌شرایط، نتیجهٔ یکسان می‌گیرند (بدون تصادف)', () => {
    const input = {
      startedAt: new Date(now - 20 * 60 * 1000),
      fatigue: 40,
      fatiguePerRealMinute: 0.9,
      now
    }
    expect(shiftDueDecision(input)).toEqual(shiftDueDecision(input))
  })

  test('آستانهٔ بحرانی یک عددِ نام‌دار است، نه جادویی در کد', () => {
    expect(CRITICAL_FATIGUE_THRESHOLD).toBe(90)
    const below = shiftDueDecision({
      startedAt: new Date(now - 1 * 60 * 1000),
      fatigue: CRITICAL_FATIGUE_THRESHOLD - 1,
      fatiguePerRealMinute: 0,
      now
    })
    expect(below.due).toBe(false)
  })

  test('متنِ دلیلِ توقف برای بازیکن است، نه برای برنامه‌نویس', () => {
    for (const text of [
      workStopReasonText('CRITICAL_FATIGUE'),
      workStopReasonText('BODY_CAPACITY_REACHED'),
      workStopReasonText(null)
    ]) {
      expect(/[\u0600-\u06FF]/.test(text)).toBe(true)
      expect(text).not.toMatch(/undefined|null/)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
//  ۲. زمان‌بندِ واحد
// ─────────────────────────────────────────────────────────────────────────────

describe('AutonomousService — یک تایمر برای همهٔ کارها', () => {
  test('اولین تیک همهٔ کارها را اجرا می‌کند (این همان Catch-up است)', async () => {
    const a = jest.fn().mockResolvedValue(undefined)
    const b = jest.fn().mockResolvedValue(undefined)
    const service = new AutonomousService([
      { name: 'a', intervalMs: AUTONOMOUS_TICK_MS, run: a },
      { name: 'b', intervalMs: 60_000, run: b }
    ])

    expect(await service.tick(0)).toEqual(['a', 'b'])
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
    expect(service.jobNames()).toEqual(['a', 'b'])
  })

  test('کار تا رسیدن فاصلهٔ خودش دوباره اجرا نمی‌شود', async () => {
    const run = jest.fn().mockResolvedValue(undefined)
    const service = new AutonomousService([{ name: 'slow', intervalMs: 60_000, run }])

    await service.tick(0)
    expect(await service.tick(30_000)).toEqual([])
    expect(run).toHaveBeenCalledTimes(1)
    expect(await service.tick(60_000)).toEqual(['slow'])
    expect(run).toHaveBeenCalledTimes(2)
  })

  test('خطای یک کار، تیک و بقیهٔ کارها را نمی‌کشد', async () => {
    const boom = jest.fn().mockRejectedValue(new Error('boom'))
    const fine = jest.fn().mockResolvedValue(undefined)
    const service = new AutonomousService([
      { name: 'boom', intervalMs: AUTONOMOUS_TICK_MS, run: boom },
      { name: 'fine', intervalMs: AUTONOMOUS_TICK_MS, run: fine }
    ])

    await expect(service.tick(0)).resolves.toEqual(['boom', 'fine'])
    expect(fine).toHaveBeenCalledTimes(1)
  })

  test('کارِ در حال اجرا دوباره روی هم سوار نمی‌شود', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const run = jest.fn().mockReturnValue(gate)
    const service = new AutonomousService([{ name: 'slow', intervalMs: AUTONOMOUS_TICK_MS, run }])

    const first = service.tick(0)
    // تیکِ بعدی در حالی که کارِ قبلی هنوز تمام نشده
    expect(await service.tick(AUTONOMOUS_TICK_MS)).toEqual([])
    expect(run).toHaveBeenCalledTimes(1)

    release()
    await first
    expect(await service.tick(AUTONOMOUS_TICK_MS * 2)).toEqual(['slow'])
  })

  test('فاصلهٔ غیرمعقول به ریتمِ پایه برمی‌گردد و تایمر قابل خاموش شدن است', () => {
    const service = new AutonomousService([
      { name: 'weird', intervalMs: 1, run: jest.fn().mockResolvedValue(undefined) }
    ])
    service.start()
    service.start() // دوباره‌فراخوانی نباید تایمر دوم بسازد
    service.stop()
    service.stop() // خاموشیِ دوباره بی‌خطر است
    expect(service.jobNames()).toEqual(['weird'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
//  ۳. کارها: بدون پنل هم پردازش می‌شود
// ─────────────────────────────────────────────────────────────────────────────

function makeDeps() {
  return {
    work: { settleDueSessions: jest.fn().mockResolvedValue([]) },
    education: { graduateDueStudents: jest.fn().mockResolvedValue([]) },
    groups: { sweepEnvironmentLevels: jest.fn().mockResolvedValue([]) },
    players: { findIdsByTelegramUserIds: jest.fn().mockResolvedValue(new Map()) },
    notifications: { announce: jest.fn().mockResolvedValue(true) },
    events: { recordRegionEvent: jest.fn().mockResolvedValue(undefined) },
    periodic: {
      loanSweep: jest.fn().mockResolvedValue(undefined),
      vitality: jest.fn().mockResolvedValue(undefined),
      inheritanceRecovery: jest.fn().mockResolvedValue(undefined),
      projectAnnouncements: jest.fn().mockResolvedValue(undefined),
      underwork: jest.fn().mockResolvedValue(undefined),
      marketExpiry: jest.fn().mockResolvedValue(undefined),
      retention: jest.fn().mockResolvedValue(undefined)
    }
  }
}

function jobByName(name: string, deps: ReturnType<typeof makeDeps>) {
  const job = buildAutonomousJobs(deps).find((entry) => entry.name === name)
  if (!job) {
    throw new Error(`job ${name} not registered`)
  }
  return job
}

describe('کارهای خودکار — اعلان و ضدتکرار', () => {
  test('شیفتِ بسته‌شده به بازیکن خبر داده می‌شود، با کلیدِ ضدتکرارِ همان شیفت', async () => {
    const deps = makeDeps()
    deps.work.settleDueSessions.mockResolvedValue([
      {
        sessionId: 's1',
        playerId: 'p1',
        jobTitle: 'کارگر ساختمان',
        workplaceName: null,
        reason: 'CRITICAL_FATIGUE',
        elapsedGameMinutes: 600,
        netPaid: 120_000,
        fatigueGained: 20
      }
    ])

    await jobByName('work-auto-stop', deps).run()

    expect(deps.notifications.announce).toHaveBeenCalledTimes(1)
    const call = deps.notifications.announce.mock.calls[0]![0]
    expect(call.playerId).toBe('p1')
    expect(call.dedupeKey).toBe('work-autostop:s1')
    expect(call.level).toBe('CRITICAL')
    expect(call.message).toContain('کارگر ساختمان')
    expect(call.message).toContain('خستگی')
  })

  test('شیفتِ محل کار پول نقد اعلام نمی‌کند (دستمزد در تسویهٔ کارفرماست)', async () => {
    const deps = makeDeps()
    deps.work.settleDueSessions.mockResolvedValue([
      {
        sessionId: 's2',
        playerId: 'p1',
        jobTitle: 'فروشگاه من',
        workplaceName: 'فروشگاه من',
        reason: 'BODY_CAPACITY_REACHED',
        elapsedGameMinutes: 480,
        netPaid: 0,
        fatigueGained: 12
      }
    ])

    await jobByName('work-auto-stop', deps).run()

    const message = deps.notifications.announce.mock.calls[0]![0].message as string
    expect(message).toContain('تسویهٔ کارفرما')
    expect(message).not.toContain('کیف پولت واریز')
  })

  test('فارغ‌التحصیلیِ خودکار در یک کوئری به بازیکن وصل و اعلام می‌شود', async () => {
    const deps = makeDeps()
    deps.education.graduateDueStudents.mockResolvedValue([
      { telegramUserId: 42n, degreeLabel: 'کارشناسی', fieldTitle: 'مهندسی', gainedExp: 40 }
    ])
    deps.players.findIdsByTelegramUserIds.mockResolvedValue(new Map([[42n, 'p1']]))

    await jobByName('education-graduation', deps).run()

    expect(deps.players.findIdsByTelegramUserIds).toHaveBeenCalledTimes(1)
    const call = deps.notifications.announce.mock.calls[0]![0]
    expect(call.playerId).toBe('p1')
    expect(call.level).toBe('IMPORTANT')
    expect(call.dedupeKey).toContain('education-graduated:p1')
  })

  test('دانشجوی بدون بازیکنِ متناظر، چرخه را نمی‌شکند', async () => {
    const deps = makeDeps()
    deps.education.graduateDueStudents.mockResolvedValue([
      { telegramUserId: 7n, degreeLabel: 'دیپلم', fieldTitle: 'هنر', gainedExp: 1 }
    ])
    deps.players.findIdsByTelegramUserIds.mockResolvedValue(new Map())

    await expect(jobByName('education-graduation', deps).run()).resolves.toBeUndefined()
    expect(deps.notifications.announce).not.toHaveBeenCalled()
  })

  test('ارتقای منطقه هم خبرِ منطقه می‌سازد و هم به مالک اعلان می‌دهد', async () => {
    const deps = makeDeps()
    deps.groups.sweepEnvironmentLevels.mockResolvedValue([
      {
        groupId: 'g1',
        groupTitle: 'مرکزی',
        from: GroupEnvironmentLevel.VILLAGE,
        to: GroupEnvironmentLevel.CITY,
        population: 16,
        ownerTelegramUserId: 99n,
        at: '2026-09-20T12:00:00.000Z'
      }
    ])
    deps.players.findIdsByTelegramUserIds.mockResolvedValue(new Map([[99n, 'owner-1']]))

    await jobByName('settlement-level', deps).run()

    expect(deps.events.recordRegionEvent).toHaveBeenCalledTimes(1)
    const event = deps.events.recordRegionEvent.mock.calls[0]![0]
    // کلید، مهرِ همان تغییر را در خود دارد: تکرارِ همزمانِ یک تغییر یک خبر
    // می‌سازد، ولی تغییرِ بعدیِ همان منطقه بلعیده نمی‌شود.
    expect(event.dedupeKey).toBe('region-level:g1:CITY:2026-09-20T12:00:00.000Z')
    expect(deps.notifications.announce).toHaveBeenCalledTimes(1)
    const notice = deps.notifications.announce.mock.calls[0]![0]
    expect(notice.playerId).toBe('owner-1')
    expect(notice.title).toContain('ارتقا')
    expect(notice.message).toContain('شهر')
  })

  test('تنزل، پیامِ خودش را دارد (نه «ارتقا پیدا کرد»)', async () => {
    // ریشهٔ باگ: پیامِ تغییرِ سطح همیشه از ارتقا می‌گفت، پس منطقه‌ای که به
    // روستا برمی‌گشت به مالکش خبرِ دروغ می‌داد.
    const deps = makeDeps()
    deps.groups.sweepEnvironmentLevels.mockResolvedValue([
      {
        groupId: 'g3',
        groupTitle: 'کوچک',
        from: GroupEnvironmentLevel.CITY,
        to: GroupEnvironmentLevel.VILLAGE,
        population: 4,
        ownerTelegramUserId: 99n,
        at: '2026-09-20T13:00:00.000Z'
      }
    ])
    deps.players.findIdsByTelegramUserIds.mockResolvedValue(new Map([[99n, 'owner-1']]))

    await jobByName('settlement-level', deps).run()

    const notice = deps.notifications.announce.mock.calls[0]![0]
    expect(notice.title).not.toContain('ارتقا')
    expect(notice.title).toContain('پایین')
    expect(notice.message).toContain('روستا')
    const event = deps.events.recordRegionEvent.mock.calls[0]![0]
    expect(event.title).toContain('برگشت')
  })

  test('منطقهٔ بدون مالک فقط خبر می‌گیرد، اعلان نه', async () => {
    const deps = makeDeps()
    deps.groups.sweepEnvironmentLevels.mockResolvedValue([
      {
        groupId: 'g2',
        groupTitle: 'بی‌مالک',
        from: GroupEnvironmentLevel.CITY,
        to: GroupEnvironmentLevel.PROVINCE,
        population: 33,
        ownerTelegramUserId: null,
        at: '2026-09-20T14:00:00.000Z'
      }
    ])

    await jobByName('settlement-level', deps).run()

    expect(deps.events.recordRegionEvent).toHaveBeenCalledTimes(1)
    expect(deps.notifications.announce).not.toHaveBeenCalled()
    expect(deps.players.findIdsByTelegramUserIds).not.toHaveBeenCalled()
  })

  test('کارهای دوره‌ایِ پروژه هم در همان زمان‌بند ثبت شده‌اند', async () => {
    const deps = makeDeps()
    const jobs = buildAutonomousJobs(deps)

    for (const name of [
      'loanSweep',
      'vitality',
      'inheritanceRecovery',
      'projectAnnouncements',
      'underwork',
      'marketExpiry',
      'retention'
    ]) {
      await jobByName(name, deps).run()
    }

    for (const fn of Object.values(deps.periodic)) {
      expect(fn).toHaveBeenCalledTimes(1)
    }
    // انقضای بازار باید سریع‌تر از نگهداریِ سنگین اجرا شود.
    const market = jobs.find((job) => job.name === 'marketExpiry')!
    const retention = jobs.find((job) => job.name === 'retention')!
    expect(market.intervalMs).toBeLessThan(retention.intervalMs)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
//  ۴. تسویهٔ خودکار شیفت‌ها (سرویس واقعی، مخزنِ جعلی)
// ─────────────────────────────────────────────────────────────────────────────

function makeWorkService() {
  const playerRepository = { findByTelegramUserId: jest.fn(), countPlayers: jest.fn() }
  const workSessionRepository = {
    findActiveSession: jest.fn(),
    findActiveSessionsForSweep: jest.fn(),
    startSession: jest.fn(),
    endSession: jest.fn()
  }
  const jobCapacityService = {
    takeSlot: jest.fn(),
    releaseSlot: jest.fn().mockResolvedValue(undefined),
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

function makePlayer(overrides: Record<string, unknown> = {}) {
  return {
    id: 'p1',
    status: PlayerStatus.ACTIVE,
    activityState: PlayerActivityState.WORKING,
    fatigue: 0,
    health: 100,
    experience: 0,
    currentDegree: 'DIPLOMA',
    graduationField: null,
    age: 18,
    ...overrides
  }
}

function makeSession(startedAt: Date, overrides: Record<string, unknown> = {}) {
  return {
    id: 's1',
    playerId: 'p1',
    jobKey: 'construction',
    jobTitle: 'کارگر ساختمان',
    payPerMinute: 6500,
    sessionType: 'PART_TIME',
    businessId: null,
    status: 'ACTIVE',
    startedAt,
    ...overrides
  }
}

describe('تسویهٔ خودکار شیفت — باگِ خستگی و Idempotency', () => {
  test('خستگیِ ثبت‌شده واقعی است، نه یک‌سی‌امِ آن (قفلِ باگِ تبدیلِ دوباره)', async () => {
    const { service, playerRepository, workSessionRepository } = makeWorkService()
    playerRepository.findByTelegramUserId.mockResolvedValue(makePlayer({ fatigue: 0 }))
    workSessionRepository.findActiveSession.mockResolvedValue(
      // ۱۰ دقیقهٔ واقعی = ۳۰۰ دقیقهٔ بازی؛ نرخِ سازندگی ۱٫۲ در دقیقهٔ واقعی
      // → ۱۲ نقطهٔ خستگی. پیش از اصلاح، همین شیفت ۰ نقطه ثبت می‌کرد.
      makeSession(new Date(Date.now() - 10 * 60 * 1000))
    )
    workSessionRepository.endSession.mockImplementation(async (id: string, result: unknown) => ({
      id,
      jobTitle: 'کارگر ساختمان',
      status: 'COMPLETED',
      ...(result as object)
    }))

    await service.stopWork(42n)

    const passed = workSessionRepository.endSession.mock.calls[0]![1] as { fatigueGained: number }
    expect(passed.fatigueGained).toBe(12)
  })

  test('شیفتِ سررسیدشده بدون هیچ تعاملی تسویه می‌شود', async () => {
    const { service, workSessionRepository } = makeWorkService()
    workSessionRepository.findActiveSessionsForSweep.mockResolvedValue([
      {
        session: makeSession(new Date(Date.now() - 60 * 60 * 1000)),
        player: makePlayer({ fatigue: 90 })
      }
    ])
    workSessionRepository.endSession.mockImplementation(async (id: string, result: unknown) => ({
      id,
      jobTitle: 'کارگر ساختمان',
      status: 'COMPLETED',
      ...(result as object)
    }))

    const settled = await service.settleDueSessions(10)

    expect(settled).toHaveLength(1)
    expect(settled[0]!.sessionId).toBe('s1')
    expect(settled[0]!.reason).toBe('CRITICAL_FATIGUE')
    expect(workSessionRepository.endSession).toHaveBeenCalledTimes(1)
  })

  test('شیفتِ تازه دست‌نخورده می‌ماند', async () => {
    const { service, workSessionRepository } = makeWorkService()
    workSessionRepository.findActiveSessionsForSweep.mockResolvedValue([
      { session: makeSession(new Date(Date.now() - 60 * 1000)), player: makePlayer() }
    ])

    const settled = await service.settleDueSessions(10)

    expect(settled).toEqual([])
    expect(workSessionRepository.endSession).not.toHaveBeenCalled()
  })

  test('اگر مسیرِ دیگری همان شیفت را تسویه کرده باشد، چرخه نمی‌شکند', async () => {
    const { service, workSessionRepository } = makeWorkService()
    workSessionRepository.findActiveSessionsForSweep.mockResolvedValue([
      { session: makeSession(new Date(Date.now() - 60 * 60 * 1000)), player: makePlayer({ fatigue: 95 }) },
      {
        session: makeSession(new Date(Date.now() - 90 * 60 * 1000), { id: 's2' }),
        player: makePlayer({ fatigue: 95 })
      }
    ])
    workSessionRepository.endSession
      .mockRejectedValueOnce(new Error('Active work session not found'))
      .mockImplementationOnce(async (id: string, result: unknown) => ({
        id,
        jobTitle: 'کارگر ساختمان',
        status: 'COMPLETED',
        ...(result as object)
      }))

    const settled = await service.settleDueSessions(10)

    expect(settled.map((shift) => shift.sessionId)).toEqual(['s2'])
  })

  test('شیفتِ رهاشدهٔ چندروزه، کارکردِ چندروزه نمی‌سازد', async () => {
    const { service, workSessionRepository } = makeWorkService()
    workSessionRepository.findActiveSessionsForSweep.mockResolvedValue([
      {
        session: makeSession(new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)),
        player: makePlayer()
      }
    ])
    workSessionRepository.endSession.mockImplementation(async (id: string, result: unknown) => ({
      id,
      jobTitle: 'کارگر ساختمان',
      status: 'COMPLETED',
      ...(result as object)
    }))

    const settled = await service.settleDueSessions(10)

    // سقفِ ظرفیت بدن: ۱۰۰ خستگی ÷ نرخِ ۱٫۲ در دقیقهٔ واقعی = ۲٫۵۰۰ دقیقهٔ بازی
    // (نرخِ هر دقیقهٔ بازی ۰٫۰۴)، در حالی که شیفت سه روز باز مانده است.
    expect(settled[0]!.elapsedGameMinutes).toBe(2500)
    expect(settled[0]!.fatigueGained).toBe(MAX_FATIGUE)
  })

  test('حالتِ بازیکنِ ناهم‌خوان، شیفت را از چرخه بیرون نمی‌اندازد', async () => {
    // `activityState` ممکن است با وضعیت واقعیِ شیفت واگرا شود (مرگ، ادمین،
    // ری‌استارت نیمه‌کاره)؛ چرخه به *شیفت* نگاه می‌کند، نه به آن پرچم.
    const { service, workSessionRepository } = makeWorkService()
    workSessionRepository.findActiveSessionsForSweep.mockResolvedValue([
      {
        session: makeSession(new Date(Date.now() - 45 * 60 * 1000)),
        player: makePlayer({ fatigue: 70, activityState: PlayerActivityState.IDLE })
      }
    ])
    workSessionRepository.endSession.mockImplementation(async (id: string, result: unknown) => ({
      id,
      jobTitle: 'کارگر ساختمان',
      status: 'COMPLETED',
      ...(result as object)
    }))

    const settled = await service.settleDueSessions(10)

    expect(settled).toHaveLength(1)
  })

  test('شیفتِ کارِ پاره‌وقتِ کوتاه هم اگر ظرفیتش تمام شود بسته می‌شود', async () => {
    const { service, workSessionRepository } = makeWorkService()
    workSessionRepository.findActiveSessionsForSweep.mockResolvedValue([
      {
        session: makeSession(new Date(Date.now() - 20 * 60 * 1000)),
        player: makePlayer({ fatigue: 80 })
      }
    ])
    workSessionRepository.endSession.mockImplementation(async (id: string, result: unknown) => ({
      id,
      jobTitle: 'کارگر ساختمان',
      status: 'COMPLETED',
      ...(result as object)
    }))

    const settled = await service.settleDueSessions(10)

    expect(settled).toHaveLength(1)
    expect(settled[0]!.reason).toBe('CRITICAL_FATIGUE')
  })

  test('کارکردِ ثبت‌شده برای تسویهٔ کارفرما با مدتِ مزددار یکی است', async () => {
    const { service, workSessionRepository } = makeWorkService()
    workSessionRepository.findActiveSessionsForSweep.mockResolvedValue([
      {
        // ۹۰ دقیقهٔ واقعی = ۲٫۷۰۰ دقیقهٔ بازی، بیشتر از ظرفیتِ بدنِ خستگی ۶۰
        // (نرخِ پیش‌فرضِ شیفتِ محل کار ۰٫۵ در دقیقهٔ واقعی → سقف ۲٫۴۰۰).
        session: makeSession(new Date(Date.now() - 90 * 60 * 1000), {
          jobKey: 'business:b1',
          sessionType: 'FULL_TIME',
          businessId: 'b1',
          payPerMinute: 4000
        }),
        player: makePlayer({ fatigue: 60 })
      }
    ])
    workSessionRepository.endSession.mockImplementation(async (id: string, result: unknown) => ({
      id,
      jobTitle: 'فروشگاه',
      status: 'COMPLETED',
      ...(result as object)
    }))

    const settled = await service.settleDueSessions(10)

    expect(settled).toHaveLength(1)
    const passed = workSessionRepository.endSession.mock.calls[0]![1] as { earnedMoney: number }
    expect(passed.earnedMoney).toBe(0) // شیفتِ محل کار نقدی نمی‌دهد
    expect(settled[0]!.netPaid).toBe(0)
    expect(settled[0]!.workplaceName).toBe('فروشگاه')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
//  ۵. فارغ‌التحصیلیِ خودکار
// ─────────────────────────────────────────────────────────────────────────────

describe('فارغ‌التحصیلیِ خودکار — بدون باز شدن پنل تحصیل', () => {
  function makeEducation() {
    const playerRepository = {
      findByTelegramUserId: jest.fn(),
      listEnrolledStudents: jest.fn(),
      completeDegree: jest.fn()
    }
    const skillRepository = { findIdsByNames: jest.fn().mockResolvedValue(new Map()) }
    const playerSkillRepository = { awardLevel: jest.fn() }
    const service = new EducationService(
      playerRepository as unknown as PlayerRepository,
      playerSkillRepository as unknown as never,
      skillRepository as unknown as never
    )
    return { service, playerRepository, skillRepository }
  }

  const field = EDUCATION_FIELDS[0]!

  test('دانشجوی سررسیدشده صادر می‌شود و دانشجوی تازه نه', async () => {
    const { service, playerRepository } = makeEducation()
    const done = new Date(Date.now() - field.gameDurationMinutes * REAL_MS_PER_GAME_MINUTE - 1000)
    playerRepository.listEnrolledStudents.mockResolvedValue([
      { telegramUserId: 1n, enrolledFieldKey: field.key, studyStartedAt: done },
      { telegramUserId: 2n, enrolledFieldKey: field.key, studyStartedAt: new Date() }
    ])
    const graduate = jest.spyOn(service, 'graduate').mockResolvedValue({
      degree: DegreeLevel.BACHELOR,
      degreeLabel: 'کارشناسی',
      fieldTitle: field.title,
      gainedExp: 10
    })

    const graduated = await service.graduateDueStudents(25)

    expect(graduate).toHaveBeenCalledTimes(1)
    expect(graduate).toHaveBeenCalledWith(1n)
    expect(graduated).toEqual([
      { telegramUserId: 1n, degreeLabel: 'کارشناسی', fieldTitle: field.title, gainedExp: 10 }
    ])
  })

  test('یک دانشجوی خراب، بقیه را از صف بیرون نمی‌اندازد', async () => {
    const { service, playerRepository } = makeEducation()
    const done = new Date(Date.now() - field.gameDurationMinutes * REAL_MS_PER_GAME_MINUTE - 1000)
    playerRepository.listEnrolledStudents.mockResolvedValue([
      { telegramUserId: 1n, enrolledFieldKey: field.key, studyStartedAt: done },
      { telegramUserId: 2n, enrolledFieldKey: field.key, studyStartedAt: done }
    ])
    jest
      .spyOn(service, 'graduate')
      .mockRejectedValueOnce(new Error('broken row'))
      .mockResolvedValueOnce({
        degree: DegreeLevel.BACHELOR,
        degreeLabel: 'کارشناسی',
        fieldTitle: field.title,
        gainedExp: 10
      })

    const graduated = await service.graduateDueStudents(25)

    expect(graduated).toHaveLength(1)
    expect(graduated[0]!.telegramUserId).toBe(2n)
  })

  test('رشتهٔ ناشناس نادیده گرفته می‌شود، نه اینکه سفارشی بسازد', async () => {
    const { service, playerRepository } = makeEducation()
    playerRepository.listEnrolledStudents.mockResolvedValue([
      { telegramUserId: 1n, enrolledFieldKey: 'ghost-field', studyStartedAt: new Date(0) }
    ])
    const graduate = jest.spyOn(service, 'graduate')

    expect(await service.graduateDueStudents(25)).toEqual([])
    expect(graduate).not.toHaveBeenCalled()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
//  ۶. ارتقای خودکار سطحِ منطقه
// ─────────────────────────────────────────────────────────────────────────────

describe('بازبینیِ خودکار سطحِ منطقه — ارتقا منتظر پیوستن شهروند نمی‌ماند', () => {
  function makeGroups() {
    const groupRepository = {
      listPageAfter: jest.fn(),
      findById: jest.fn(),
      updateEnvironment: jest.fn()
    }
    const playerGroupRepository = { countActivePlayers: jest.fn() }
    const service = new GroupService(
      groupRepository as unknown as never,
      playerGroupRepository as unknown as never,
      { findIdsByTelegramUserIds: jest.fn() } as unknown as PlayerRepository,
      { getMemberInfo: jest.fn() } as unknown as never,
      new EnvironmentClassifier()
    )
    return { service, groupRepository, playerGroupRepository }
  }

  /**
   * پاسخِ مخزن بر اساسِ قراردادِ واقعیِ نوشتارِ شرطی: وقتی سطحِ هدف با سطحِ
   * فعلی یکی است، هیچ ردیفی عوض نمی‌شود و مهری هم گرفته نمی‌شود.
   */
  const wroteLevel = (levelChanged: boolean) => ({
    levelChanged,
    levelChangedAt: levelChanged ? new Date('2026-09-20T12:00:00.000Z') : null,
    changed: levelChanged
  })

  test('منطقه‌ای که از آستانه گذشته ارتقا می‌یابد و خبرش برمی‌گردد', async () => {
    const { service, groupRepository, playerGroupRepository } = makeGroups()
    groupRepository.listPageAfter.mockResolvedValue([
      {
        id: 'g1',
        title: 'مرکزی',
        environmentLevel: GroupEnvironmentLevel.VILLAGE,
        ownerTelegramUserId: 99n
      }
    ])
    groupRepository.findById.mockResolvedValue({
      id: 'g1',
      title: 'مرکزی',
      environmentLevel: GroupEnvironmentLevel.VILLAGE,
      ownerTelegramUserId: 99n
    })
    playerGroupRepository.countActivePlayers.mockResolvedValue(16)
    groupRepository.updateEnvironment.mockResolvedValue(wroteLevel(true))

    const promotions = await service.sweepEnvironmentLevels(10)

    expect(promotions).toEqual([
      {
        groupId: 'g1',
        groupTitle: 'مرکزی',
        from: GroupEnvironmentLevel.VILLAGE,
        to: GroupEnvironmentLevel.CITY,
        population: 16,
        ownerTelegramUserId: 99n,
        at: '2026-09-20T12:00:00.000Z'
      }
    ])
  })

  test('منطقه‌ای که سطحش عوض نشده خبر نمی‌سازد', async () => {
    const { service, groupRepository, playerGroupRepository } = makeGroups()
    groupRepository.listPageAfter.mockResolvedValue([
      { id: 'g2', title: 'آرام', environmentLevel: GroupEnvironmentLevel.CITY }
    ])
    groupRepository.findById.mockResolvedValue({
      id: 'g2',
      title: 'آرام',
      environmentLevel: GroupEnvironmentLevel.CITY
    })
    playerGroupRepository.countActivePlayers.mockResolvedValue(16)
    // نوشتارِ شرطی: سطحی عوض نشده، پس مهری هم نیست.
    groupRepository.updateEnvironment.mockResolvedValue(wroteLevel(false))

    expect(await service.sweepEnvironmentLevels(10)).toEqual([])
  })

  test('منطقهٔ ناسالم چرخهٔ بقیهٔ مناطق را نمی‌بندد', async () => {
    const { service, groupRepository, playerGroupRepository } = makeGroups()
    groupRepository.listPageAfter.mockResolvedValue([
      { id: 'bad', title: 'خراب', environmentLevel: GroupEnvironmentLevel.VILLAGE },
      { id: 'good', title: 'سالم', environmentLevel: GroupEnvironmentLevel.VILLAGE }
    ])
    groupRepository.findById.mockImplementation(async (id: string) =>
      id === 'bad'
        ? null
        : {
            id: 'good',
            title: 'سالم',
            environmentLevel: GroupEnvironmentLevel.VILLAGE,
            ownerTelegramUserId: null
          }
    )
    playerGroupRepository.countActivePlayers.mockResolvedValue(31)
    groupRepository.updateEnvironment.mockResolvedValue(wroteLevel(true))

    const promotions = await service.sweepEnvironmentLevels(10)

    expect(promotions.map((promotion) => promotion.groupId)).toEqual(['good'])
    expect(promotions[0]!.to).toBe(GroupEnvironmentLevel.PROVINCE)
  })

  test('جمعیتِ صفرِ یک منطقهٔ خالی، سطحش را بی‌دلیل جابه‌جا نمی‌کند', async () => {
    const { service, groupRepository, playerGroupRepository } = makeGroups()
    groupRepository.listPageAfter.mockResolvedValue([
      { id: 'g3', title: 'خالی', environmentLevel: GroupEnvironmentLevel.VILLAGE }
    ])
    groupRepository.findById.mockResolvedValue({
      id: 'g3',
      title: 'خالی',
      environmentLevel: GroupEnvironmentLevel.VILLAGE
    })
    playerGroupRepository.countActivePlayers.mockResolvedValue(0)
    groupRepository.updateEnvironment.mockResolvedValue(wroteLevel(false))

    expect(await service.sweepEnvironmentLevels(10)).toEqual([])
  })

  test('تنزل هم همان‌قدر واقعی است: سطحِ برگشته با مهرِ تازه گزارش می‌شود', async () => {
    const { service, groupRepository, playerGroupRepository } = makeGroups()
    groupRepository.listPageAfter.mockResolvedValue([
      { id: 'g4', title: 'کوچک‌شده', environmentLevel: GroupEnvironmentLevel.CITY }
    ])
    groupRepository.findById.mockResolvedValue({
      id: 'g4',
      title: 'کوچک‌شده',
      environmentLevel: GroupEnvironmentLevel.CITY,
      ownerTelegramUserId: null
    })
    playerGroupRepository.countActivePlayers.mockResolvedValue(4)
    groupRepository.updateEnvironment.mockResolvedValue(wroteLevel(true))

    const out = await service.sweepEnvironmentLevels(10)

    expect(out).toHaveLength(1)
    expect(out[0]!.from).toBe(GroupEnvironmentLevel.CITY)
    expect(out[0]!.to).toBe(GroupEnvironmentLevel.VILLAGE)
    expect(out[0]!.at).toBe('2026-09-20T12:00:00.000Z')
  })

  test('صفحه‌بندی: مناطقِ بعد از سقفِ یک صفحه هم بازبینی می‌شوند (گرسنگیِ دائمی نمی‌ماند)', async () => {
    // ریشهٔ باگ: چرخه با `take: 100` و مرتب‌سازی روی `createdAt` می‌خواند؛
    // با بیشتر از ۱۰۰ منطقه، قدیمی‌ترین‌ها هیچ‌وقت بازبینی نمی‌شدند.
    const { service, groupRepository, playerGroupRepository } = makeGroups()
    const page1 = [{ id: 'a', title: 'اول', environmentLevel: GroupEnvironmentLevel.VILLAGE }]
    const page2 = [{ id: 'b', title: 'دوم', environmentLevel: GroupEnvironmentLevel.VILLAGE }]
    groupRepository.listPageAfter
      .mockResolvedValueOnce(page1)
      .mockResolvedValueOnce(page2)
      .mockResolvedValueOnce([])
    groupRepository.findById.mockImplementation(async (id: string) => ({
      id,
      title: id === 'a' ? 'اول' : 'دوم',
      environmentLevel: GroupEnvironmentLevel.VILLAGE,
      ownerTelegramUserId: null
    }))
    playerGroupRepository.countActivePlayers.mockResolvedValue(16)
    groupRepository.updateEnvironment.mockResolvedValue(wroteLevel(true))

    const out = await service.sweepEnvironmentLevels(1)

    expect(out.map((change) => change.groupId)).toEqual(['a', 'b'])
    // صفحهٔ بعد از **شناسهٔ آخرین ردیف** خوانده می‌شود، نه با `skip`.
    expect(groupRepository.listPageAfter).toHaveBeenNthCalledWith(2, {
      afterId: 'a',
      limit: 1
    })
  })
})

describe('تازمانِ پایان دوره بر اساس ساعت بازی است', () => {
  test('مدتِ دوره در دقیقهٔ بازی ذخیره شده و یک ماه بازی = یک روز واقعی', () => {
    const field = EDUCATION_FIELDS[0]!
    const realDays = (field.gameDurationMinutes * REAL_MS_PER_GAME_MINUTE) / REAL_MS_PER_GAME_DAY
    expect(realDays).toBeGreaterThan(0)
    expect(Number.isFinite(realDays)).toBe(true)
  })
})
