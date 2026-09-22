/**
 * فرسودگیِ طبیعیِ بدن — آزمونِ حلقهٔ گم‌شدهٔ زنجیرهٔ «زندگی → مرگ → میراث».
 *
 * چه چیزی این‌جا اثبات می‌شود؟
 *   ۱. منحنیِ فرسودگی با سن بالا می‌رود و هرگز ناپیوسته یا تصادفی نیست.
 *   ۲. سلامت واقعاً می‌تواند به صفر برسد — چیزی که تا امروز ممکن نبود.
 *   ۳. صفرشدن، مرگ را از همان مسیرِ واحدِ `DeathService` ثبت می‌کند.
 *   ۴. کسرِ زمان گم نمی‌شود: هزار همگام‌سازی پشت‌سرهم دقیقاً همان چیزی را
 *      کم می‌کند که یک همگام‌سازیِ بلند.
 *   ۵. مرگ قبلاً ثبت‌شده دوبار پرونده نمی‌سازد؛ شخصیتِ مرده فرسوده نمی‌شود.
 */
import { NotificationType, PlayerActivityState, PlayerStatus } from '@prisma/client'
import { createFakeDb } from './helpers/fake-db'
import {
  MAX_DECAY_PER_GAME_MONTH,
  MIN_DECAY_PER_GAME_MONTH,
  VITALITY_CRITICAL_HEALTH,
  VITALITY_REST_FACTOR,
  VITALITY_WARNING_HEALTH,
  vitalityDecayAmount,
  vitalityDecayPerGameMonth,
  vitalityRateHint
} from '../src/modules/health/vitality'
import { VitalityService } from '../src/modules/health/vitality.service'
import { DeathService, DEATH_CAUSE } from '../src/modules/inheritance/death.service'
import { InheritanceService } from '../src/modules/inheritance/inheritance.service'
import { effectiveAge } from '../src/modules/lifecycle/game-calendar'
import { REAL_MS_PER_GAME_MONTH } from '../src/utils/game-time'

const PLAYER = 'p-1'
const HEIR = 'p-2'

function playerById(fake: ReturnType<typeof createFakeDb>, id: string) {
  return fake.state.players.find((row) => row.id === id)!
}

function seed(overrides: Record<string, unknown> = {}) {
  return createFakeDb({
    players: [
      {
        id: PLAYER,
        telegramUserId: 1001n,
        firstName: 'آرش',
        status: PlayerStatus.ACTIVE,
        health: 100,
        fatigue: 0,
        age: 18,
        lives: 1,
        // «شروع زندگی» گذشته است؛ سن مؤثر از همین محاسبه می‌شود.
        startedAt: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000),
        healthSyncedAt: new Date(),
        activityState: PlayerActivityState.IDLE,
        balance: 0,
        homeGroupId: 'g-1',
        ...overrides
      },
      {
        id: HEIR,
        telegramUserId: 1002n,
        firstName: 'سارا',
        status: PlayerStatus.ACTIVE,
        health: 100,
        age: 20,
        lives: 1,
        startedAt: new Date(),
        healthSyncedAt: new Date(),
        balance: 0
      }
    ],
    wills: [{ id: 'w-1', ownerId: PLAYER, heirId: HEIR, note: null }]
  })
}

function services(fake: ReturnType<typeof createFakeDb>) {
  // stubها باید Promise بدهند؛ `jest.fn()` بی‌پیاده‌سازی `undefined` می‌دهد و
  // زنجیرهٔ `?.recordPlayerEvent(...).catch(...)` روی undefined می‌شکند.
  const eventStub = () => ({ recordPlayerEvent: jest.fn().mockResolvedValue(undefined) }) as never
  const inheritance = new InheritanceService(fake.db, eventStub(), fake.poolStub as never)
  const death = new DeathService(fake.db, inheritance, undefined, eventStub())
  const notifications: { title: string; level: string | undefined }[] = []
  const notifyStub = {
    notifyPlayerById: jest.fn(
      async (
        _playerId: string,
        title: string,
        _message: string,
        _type?: NotificationType,
        _dedupe?: string,
        level?: string
      ) => {
        notifications.push({ title, level })
        return true
      }
    )
  }
  const vitality = new VitalityService(fake.db, death, notifyStub as never)
  return { inheritance, death, vitality, notifications, notifyStub }
}

describe('منحنیِ فرسودگی — پله‌ای، صعودی و کران‌دار', () => {
  test('با بالا رفتن سن نرخ فرسودگی هرگز کم نمی‌شود', () => {
    let previous = 0
    for (let age = 0; age <= 120; age += 1) {
      const rate = vitalityDecayPerGameMonth(age)
      expect(rate).toBeGreaterThanOrEqual(previous)
      expect(rate).toBeGreaterThanOrEqual(MIN_DECAY_PER_GAME_MONTH)
      expect(rate).toBeLessThanOrEqual(MAX_DECAY_PER_GAME_MONTH)
      previous = rate
    }
  })

  test('سنِ نامعتبر جوان‌ترین پله را می‌گیرد، نه سنگین‌ترین', () => {
    // دادهٔ خراب نباید بی‌صدا بازیکن را بکشد.
    expect(vitalityDecayPerGameMonth(Number.NaN)).toBe(MIN_DECAY_PER_GAME_MONTH)
    expect(vitalityDecayPerGameMonth(-5)).toBe(MIN_DECAY_PER_GAME_MONTH)
  })

  test('مقدار فرسودگی دقیقاً با زمان نسبت دارد و استراحت آن را نصف می‌کند', () => {
    const rate = 4
    const oneMonth = vitalityDecayAmount(REAL_MS_PER_GAME_MONTH, rate)
    expect(oneMonth).toBeCloseTo(4, 6)
    expect(vitalityDecayAmount(REAL_MS_PER_GAME_MONTH * 2, rate)).toBeCloseTo(8, 6)
    expect(vitalityDecayAmount(REAL_MS_PER_GAME_MONTH, rate, true)).toBeCloseTo(
      4 * VITALITY_REST_FACTOR,
      6
    )
    expect(vitalityDecayAmount(-100, rate)).toBe(0)
  })

  test('هر سنی راهنمای انسانی مخصوص خودش دارد', () => {
    for (const age of [18, 35, 50, 70, 90]) {
      expect(vitalityRateHint(age).length).toBeGreaterThan(10)
    }
    expect(vitalityRateHint(18)).not.toBe(vitalityRateHint(90))
  })
})

describe('همگام‌سازیِ فرسودگی — Lazy، دقیق و بی‌کسرِ گم‌شده', () => {
  test('سلامت به‌اندازهٔ زمانِ سپری‌شده کم می‌شود', async () => {
    const fake = seed()
    // مبدأ را یک ماه بازی (یک روز واقعی) عقب می‌بریم.
    playerById(fake, PLAYER).healthSyncedAt = new Date(Date.now() - REAL_MS_PER_GAME_MONTH)
    const { vitality } = services(fake)

    // سن مؤثر از تقویم بازی می‌آید، نه از ستون خام `age`.
    const row = playerById(fake, PLAYER)
    const rate = vitalityDecayPerGameMonth(
      effectiveAge(row.startedAt as Date, row.age as number)
    )
    const result = await vitality.syncPlayer(PLAYER)

    expect(result?.changed).toBe(true)
    expect(result?.healthAfter).toBe(100 - Math.floor(rate))
    expect(playerById(fake, PLAYER).health).toBe(100 - Math.floor(rate))
  })

  test('کسر زمان گم نمی‌شود: صد همگام‌سازی کوتاه = یک همگام‌سازی بلند', async () => {
    // دو بازیکن یکسان؛ یکی در یک پرش و دیگری در صد گام.
    const long = seed()
    playerById(long, PLAYER).healthSyncedAt = new Date(
      Date.now() - REAL_MS_PER_GAME_MONTH * 10
    )
    const longServices = services(long)
    await longServices.vitality.syncPlayer(PLAYER)

    const stepped = seed()
    const steppedServices = services(stepped)
    const start = Date.now() - REAL_MS_PER_GAME_MONTH * 10
    playerById(stepped, PLAYER).healthSyncedAt = new Date(start)
    // هر گام فقط ساعتِ سیستم را جلو می‌برد؛ مبدأ را سرویس خودش حمل می‌کند
    // (باقی‌ماندهٔ کسری). پس مجموعِ گام‌ها باید با پرشِ یک‌باره یکی باشد.
    for (let i = 1; i <= 100; i += 1) {
      await steppedServices.vitality.syncPlayer(PLAYER, {
        force: true,
        now: start + (i / 100) * REAL_MS_PER_GAME_MONTH * 10
      })
    }

    expect(playerById(stepped, PLAYER).health).toBe(playerById(long, PLAYER).health)
  })

  test('سلامت به صفر که برسد، مرگ از مسیر واحد ثبت می‌شود', async () => {
    const fake = seed({ health: 3 })
    // سه ماه بازی در غیاب بازیکن — کافی برای رساندن سلامت به صفر.
    playerById(fake, PLAYER).healthSyncedAt = new Date(
      Date.now() - REAL_MS_PER_GAME_MONTH * 30
    )
    const { vitality } = services(fake)

    const result = await vitality.syncPlayer(PLAYER)

    expect(result?.died).toBe(true)
    expect(playerById(fake, PLAYER).health).toBe(0)
    expect(playerById(fake, PLAYER).status).toBe(PlayerStatus.DEAD)
    expect(fake.state.cases).toHaveLength(1)
    expect(fake.state.cases[0]!.cause).toBe(DEATH_CAUSE.health)
  })

  test('شخصیتِ فوت‌شده دیگر فرسوده نمی‌شود و پروندهٔ دوم نمی‌گیرد', async () => {
    const fake = seed({ health: 0, status: PlayerStatus.DEAD })
    playerById(fake, PLAYER).healthSyncedAt = new Date(
      Date.now() - REAL_MS_PER_GAME_MONTH * 30
    )
    const { vitality } = services(fake)

    const result = await vitality.syncPlayer(PLAYER)

    expect(result).toBeNull()
    expect(fake.state.cases).toHaveLength(0)
  })

  test('فاصلهٔ کمتر از نیم‌ساعت هیچ نوشتنی نمی‌سازد', async () => {
    const fake = seed()
    const { vitality } = services(fake)
    const result = await vitality.syncPlayer(PLAYER)
    expect(result).toBeNull()
  })

  test('استراحت فرسودگی را کند می‌کند', async () => {
    const resting = seed({ activityState: PlayerActivityState.RESTING })
    playerById(resting, PLAYER).healthSyncedAt = new Date(Date.now() - REAL_MS_PER_GAME_MONTH)
    const awake = seed()
    playerById(awake, PLAYER).healthSyncedAt = new Date(Date.now() - REAL_MS_PER_GAME_MONTH)

    await services(resting).vitality.syncPlayer(PLAYER)
    await services(awake).vitality.syncPlayer(PLAYER)

    expect(playerById(resting, PLAYER).health).toBeGreaterThan(
      playerById(awake, PLAYER).health as number
    )
  })
})

describe('هشدارهای فرسودگی — دو پله، بی‌تکرار', () => {
  test('عبور از نصف، هشدار «نصف» می‌دهد و عبور از بحرانی، هشدار جدی', async () => {
    const half = seed({ health: 52 })
    playerById(half, PLAYER).healthSyncedAt = new Date(Date.now() - REAL_MS_PER_GAME_MONTH)
    const halfServices = services(half)
    await halfServices.vitality.syncPlayer(PLAYER)
    const halfHealth = playerById(half, PLAYER).health as number
    expect(halfHealth).toBeLessThanOrEqual(VITALITY_WARNING_HEALTH)
    const halfNotice = halfServices.notifications.find((notice) => notice.title.includes('نصف'))
    expect(halfNotice).toBeDefined()
    expect(halfNotice!.level).toBe('IMPORTANT')

    const critical = seed({ health: 22 })
    playerById(critical, PLAYER).healthSyncedAt = new Date(Date.now() - REAL_MS_PER_GAME_MONTH)
    const criticalServices = services(critical)
    await criticalServices.vitality.syncPlayer(PLAYER)
    const after = playerById(critical, PLAYER).health as number
    expect(after).toBeLessThanOrEqual(VITALITY_CRITICAL_HEALTH)
    const criticalNotice = criticalServices.notifications.find((notice) =>
      notice.title.includes('بحرانی')
    )
    expect(criticalNotice).toBeDefined()
    expect(criticalNotice!.level).toBe('CRITICAL')
  })
})

describe('چرخهٔ دوره‌ای فرسودگی — بی‌تایمر، کران‌دار و مقاوم', () => {
  test('فقط بازیکنانِ همگام‌نشده را برمی‌دارد و قدیمی‌ترین را اول', async () => {
    const fake = createFakeDb({
      players: [
        {
          id: 'p-old',
          status: PlayerStatus.ACTIVE,
          health: 100,
          age: 18,
          startedAt: new Date(),
          healthSyncedAt: new Date(Date.now() - REAL_MS_PER_GAME_MONTH * 5),
          activityState: PlayerActivityState.IDLE
        },
        {
          id: 'p-fresh',
          status: PlayerStatus.ACTIVE,
          health: 100,
          age: 18,
          startedAt: new Date(),
          healthSyncedAt: new Date(),
          activityState: PlayerActivityState.IDLE
        },
        {
          id: 'p-dead',
          status: PlayerStatus.DEAD,
          health: 0,
          age: 18,
          startedAt: new Date(),
          healthSyncedAt: new Date(Date.now() - REAL_MS_PER_GAME_MONTH * 5)
        }
      ]
    })
    const { vitality } = services(fake)

    const result = await vitality.sweep(10)

    expect(result.processed).toBe(1)
    expect(result.changed).toBe(1)
    expect(playerById(fake, 'p-fresh').health).toBe(100)
    expect(playerById(fake, 'p-old').health).toBeLessThan(100)
  })
})
