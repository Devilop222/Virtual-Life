/**
 * «زندگی تازه» — حلقهٔ پایانیِ زنجیرهٔ میراث.
 *
 * چه چیزی این‌جا اثبات می‌شود؟
 *   ۱. تا وقتی امور زندگیِ گذشته تمام نشده، زندگی تازه آغاز نمی‌شود.
 *   ۲. شروع، اتمیک و یک‌باره است (دو کلیک = یک زندگی).
 *   ۳. شالودهٔ زندگیِ تازه واقعاً بازنشانی می‌شود (سن، سلامت، مهارت، پول).
 *   ۴. داراییِ بی‌وارث گم نمی‌شود: به صندوق منطقه می‌رسد و یک ردیف دفتری
 *      صریح می‌گیرد — بدون این، بی‌وصیتی «پول‌سوزی» می‌شد.
 *   ۵. زندگیِ دوم می‌تواند دوباره بمیرد و پروندهٔ دوم بگیرد (`lifeIndex`).
 */
import { InheritanceStatus, PlayerStatus, TransactionType } from '@prisma/client'
import { createFakeDb } from './helpers/fake-db'
import { RebirthService } from '../src/modules/inheritance/rebirth.service'
import { DeathService, DEATH_CAUSE } from '../src/modules/inheritance/death.service'
import { InheritanceService } from '../src/modules/inheritance/inheritance.service'
import { RegionFundService } from '../src/modules/economy/tax.service'
import { ConflictError } from '../src/utils/classes/errors'
import { BASE_MAX_HEALTH } from '../src/modules/health/max-health'
import { STARTING_BALANCE } from '../src/config/economy'

const PLAYER = 'p-1'
const GROUP = 'g-1'

const DEAD_PROFILE = {
  gender: 'MALE',
  biography: 'زندگی تازه‌ای برای ساختن.'
}

function playerById(fake: ReturnType<typeof createFakeDb>, id: string) {
  return fake.state.players.find((row) => row.id === id)!
}

function seed(
  caseOverrides: Record<string, unknown> = {},
  playerOverrides: Record<string, unknown> = {}
) {
  const fake = createFakeDb({
    players: [
      {
        id: PLAYER,
        telegramUserId: 1001n,
        firstName: 'آرش',
        status: PlayerStatus.DEAD,
        gender: 'MALE',
        biography: 'زندگی گذشته',
        health: 0,
        fatigue: 40,
        age: 60,
        lives: 1,
        experience: 900,
        startedAt: new Date(Date.now() - 500 * 24 * 60 * 60 * 1000),
        healthSyncedAt: new Date(),
        balance: 1_250_000,
        homeGroupId: GROUP,
        occupationId: 'job-1',
        maritalStatus: 'MARRIED',
        socialLevel: 'HIGH',
        currentDegree: 'MASTER',
        graduationField: 'پزشکی',
        isEnrolled: true,
        enrolledFieldKey: 'medicine',
        targetDegree: 'PHD',
        studyStartedAt: new Date(),
        activityState: 'IDLE',
        restStartedAt: null,
        streakCount: 9,
        ...playerOverrides
      }
    ],
    cases: [
      {
        id: 'case-1',
        deceasedId: PLAYER,
        lifeIndex: 1,
        status: InheritanceStatus.COMPLETED,
        cause: 'health',
        cashTransferred: 0,
        debtSettled: 0,
        debtUnpaid: 0,
        attempts: 0,
        ...caseOverrides
      }
    ],
    skills: [
      { id: 'sk-1', playerId: PLAYER, skillId: 's-1', level: 7 },
      { id: 'sk-2', playerId: PLAYER, skillId: 's-2', level: 3 }
    ],
    gymMemberships: [{ id: 'gm-1', playerId: PLAYER, status: 'ACTIVE' }],
    insurancePolicies: [{ id: 'ip-1', playerId: PLAYER, status: 'ACTIVE' }],
    regionStats: [{ id: 'rs-1', groupId: GROUP, taxRevenue: 0 }]
  })
  return fake
}

function services(fake: ReturnType<typeof createFakeDb>) {
  const eventStub = () => ({ recordPlayerEvent: jest.fn().mockResolvedValue(undefined) }) as never
  const inheritance = new InheritanceService(fake.db, eventStub(), fake.poolStub as never)
  const death = new DeathService(fake.db, inheritance, undefined, eventStub())
  const rebirth = new RebirthService(fake.db, new RegionFundService())
  return { inheritance, death, rebirth }
}

describe('شرایط زندگی تازه — بدون دور زدنِ میراث', () => {
  test('بازیکنِ زنده درخواست نمی‌گیرد', async () => {
    const fake = seed({}, { status: PlayerStatus.ACTIVE, health: 90 })
    const { rebirth } = services(fake)

    const readiness = await rebirth.readiness(PLAYER)

    expect(readiness.eligible).toBe(false)
    expect(readiness.nextLifeNumber).toBe(2)
  })

  test('تا وقتی پروندهٔ میراث در جریان است، زندگی تازه آغاز نمی‌شود', async () => {
    for (const status of [
      InheritanceStatus.PENDING,
      InheritanceStatus.SETTLED_DEBTS,
      InheritanceStatus.TRANSFERRED,
      InheritanceStatus.FAILED
    ]) {
      const fake = seed({ status })
      const { rebirth } = services(fake)
      const readiness = await rebirth.readiness(PLAYER)
      expect(readiness.eligible).toBe(false)
      expect(readiness.caseStatus).toBe(status)
    }
  })

  test('پروندهٔ تمام‌شده زندگی تازه را آزاد می‌کند', async () => {
    const fake = seed()
    const { rebirth } = services(fake)
    const readiness = await rebirth.readiness(PLAYER)
    expect(readiness.eligible).toBe(true)
    expect(readiness.reason).toBeNull()
    expect(readiness.nextLifeNumber).toBe(2)
  })
})

describe('شروع زندگی تازه — اتمیک، یک‌باره و کامل', () => {
  test('شالودهٔ زندگی تازه بازنشانی می‌شود و زندگیِ قبلی پاک', async () => {
    const fake = seed()
    const { rebirth } = services(fake)

    const result = await rebirth.startNewLife(PLAYER, DEAD_PROFILE)
    await rebirth.cleanupPreviousLife(PLAYER)

    expect(result.lifeNumber).toBe(2)
    const row = playerById(fake, PLAYER)
    expect(row.status).toBe(PlayerStatus.ACTIVE)
    expect(row.lives).toBe(2)
    expect(row.health).toBe(BASE_MAX_HEALTH)
    expect(row.fatigue).toBe(0)
    expect(row.experience).toBe(0)
    expect(row.balance).toBe(STARTING_BALANCE)
    expect(row.age).toBe(18)
    expect(row.currentDegree).toBe('DIPLOMA')
    expect(row.graduationField).toBeNull()
    expect(row.isEnrolled).toBe(false)
    expect(row.occupationId).toBeNull()
    expect(row.maritalStatus).toBe('SINGLE')
    expect(row.streakCount).toBe(0)
    expect(row.biography).toBe(DEAD_PROFILE.biography)
    // منطقه می‌ماند: دنیای بازی عوض نمی‌شود.
    expect(row.homeGroupId).toBe(GROUP)
    // پیوندهای چسبیده به شخصیت پاک شده‌اند.
    expect(fake.state.skills).toHaveLength(0)
    expect(fake.state.gymMemberships).toHaveLength(0)
    expect(fake.state.insurancePolicies).toHaveLength(0)
  })

  test('سرمایهٔ زندگی تازه ردیف دفتری دارد و هرگز دوبار ساخته نمی‌شود', async () => {
    const fake = seed()
    const { rebirth } = services(fake)

    await rebirth.startNewLife(PLAYER, DEAD_PROFILE)

    const capital = fake.state.transactions.filter((row) =>
      String(row.id ?? '').startsWith(`rebirth-capital:${PLAYER}:`)
    )
    expect(capital).toHaveLength(1)
    expect(Number(capital[0]!.amount)).toBe(STARTING_BALANCE)
  })

  test('اجرای دوبارهٔ همین درخواست، زندگی دوم نمی‌سازد', async () => {
    const fake = seed()
    const { rebirth } = services(fake)

    const first = await rebirth.startNewLife(PLAYER, DEAD_PROFILE)
    expect(first.lifeNumber).toBe(2)

    // درخواست دوباره (کلیک تکراری، تلاش مجدد پس از خطای شبکه) باید رد شود،
    // نه اینکه شمارندهٔ زندگی را جلو ببرد.
    await expect(rebirth.startNewLife(PLAYER, DEAD_PROFILE)).rejects.toThrow()

    expect(playerById(fake, PLAYER).lives).toBe(2)
    expect(
      fake.state.transactions.filter((row) =>
        String(row.id ?? '').startsWith(`rebirth-capital:${PLAYER}:`)
      )
    ).toHaveLength(1)
  })

  test('گاردِ نوشتارِ شرطی، بازنشانی دوباره روی وضعیتِ تازه را می‌بندد', async () => {
    const fake = seed()
    const { rebirth } = services(fake)

    await rebirth.startNewLife(PLAYER, DEAD_PROFILE)
    const row = playerById(fake, PLAYER)
    // اگر مسیر دیگری بین خواندن و نوشتن وضعیت را به ACTIVE بگرداند،
    // `where` شرطی صفر ردیف می‌زند و زندگی تازه دوباره اعمال نمی‌شود.
    row.status = PlayerStatus.ACTIVE
    row.lives = 1
    await expect(rebirth.startNewLife(PLAYER, DEAD_PROFILE)).rejects.toThrow()
    expect(playerById(fake, PLAYER).balance).toBe(STARTING_BALANCE)
  })

  test('ورودی نامعتبر (جنسیت/معرفی) هیچ زندگی‌ای نمی‌سازد', async () => {
    const fake = seed()
    const { rebirth } = services(fake)

    await expect(
      rebirth.startNewLife(PLAYER, { gender: 'X', biography: 'متن' })
    ).rejects.toThrow()
    await expect(
      rebirth.startNewLife(PLAYER, { gender: 'MALE', biography: 'ک' })
    ).rejects.toThrow()
    expect(playerById(fake, PLAYER).lives).toBe(1)
    expect(playerById(fake, PLAYER).status).toBe(PlayerStatus.DEAD)
  })
})

describe('داراییِ بی‌وارث — به صندوق منطقه، با ردیف دفتری', () => {
  test('باقی‌ماندهٔ دارایی به صندوق می‌رسد و پرونده بسته می‌شود', async () => {
    const fake = seed({ status: InheritanceStatus.NO_HEIR })
    const { rebirth } = services(fake)

    const readiness = await rebirth.readiness(PLAYER)
    expect(readiness.eligible).toBe(true)
    expect(readiness.residualEstate).toBe(1_250_000)

    const result = await rebirth.startNewLife(PLAYER, DEAD_PROFILE)

    expect(result.estateToRegion).toBe(1_250_000)
    expect(playerById(fake, PLAYER).balance).toBe(STARTING_BALANCE)
    expect(fake.state.regionStats[0]!.taxRevenue).toBe(1_250_000)
    expect(fake.state.cases[0]!.status).toBe(InheritanceStatus.COMPLETED)

    const sink = fake.state.transactions.find(
      (row) => row.type === TransactionType.UNCLAIMED_ESTATE
    )
    expect(sink).toBeDefined()
    expect(Number(sink!.amount)).toBe(1_250_000)
    // طرفِ مبدأ فقط: پول از بخش خصوصی بیرون رفته، به بخش عمومی رسیده.
    expect(sink!.sourcePlayerId).toBe(PLAYER)
    expect(sink!.destinationPlayerId ?? null).toBeNull()
  })

  test('بی‌وارثِ بی‌اقامت، بدون تصمیم انسانی زندگی تازه نمی‌گیرد', async () => {
    const fake = seed({ status: InheritanceStatus.NO_HEIR }, { homeGroupId: null })
    const { rebirth } = services(fake)

    const readiness = await rebirth.readiness(PLAYER)

    expect(readiness.eligible).toBe(false)
    expect(readiness.residualEstate).toBe(1_250_000)
    await expect(rebirth.startNewLife(PLAYER, DEAD_PROFILE)).rejects.toThrow()
    // پول دست‌نخورده مانده است — هیچ چیز بی‌ردیف از بین نرفت.
    expect(playerById(fake, PLAYER).balance).toBe(1_250_000)
  })

  test('بی‌وارثِ بی‌دارایی آزاد است و صندوق دست نمی‌خورد', async () => {
    const fake = seed({ status: InheritanceStatus.NO_HEIR }, { balance: 0, homeGroupId: null })
    const { rebirth } = services(fake)

    const result = await rebirth.startNewLife(PLAYER, DEAD_PROFILE)

    expect(result.estateToRegion).toBe(0)
    expect(fake.state.regionStats[0]!.taxRevenue).toBe(0)
  })
})

describe('چرخهٔ چندزندگی — مرگِ دوم پروندهٔ دوم می‌گیرد', () => {
  test('پس از زندگی تازه، مرگ بعدی lifeIndex را بالا می‌برد', async () => {
    const fake = seed()
    const { rebirth, death } = services(fake)

    await rebirth.startNewLife(PLAYER, DEAD_PROFILE)
    expect(playerById(fake, PLAYER).lives).toBe(2)

    const second = await death.registerDeath(PLAYER, DEATH_CAUSE.health, {
      skipInheritance: true
    })

    expect(second.newlyDead).toBe(true)
    expect(fake.state.cases).toHaveLength(2)
    expect(fake.state.cases[1]!.lifeIndex).toBe(2)
    expect(playerById(fake, PLAYER).status).toBe(PlayerStatus.DEAD)
  })

  test('پس از زندگی تازه، همگام‌سازی فرسودگی از مبدأ تازه می‌شمارد', async () => {
    const fake = seed()
    const { rebirth } = services(fake)

    await rebirth.startNewLife(PLAYER, DEAD_PROFILE)

    const syncedAt = playerById(fake, PLAYER).healthSyncedAt as Date
    expect(Date.now() - syncedAt.getTime()).toBeLessThan(5_000)
  })
})

describe('انتظارِ پس از مرگ — ۴۸ ساعتِ واقعی، با استثنای مدیر', () => {
  const HOUR = 60 * 60 * 1000
  const hoursAgo = (hours: number) => new Date(Date.now() - hours * HOUR)

  test('مرگِ تازه: بازگشت مجاز نیست و زمانِ باقی‌مانده گزارش می‌شود', async () => {
    const openedAt = new Date(Date.now() - 60_000)
    const fake = seed({ openedAt })
    const { rebirth } = services(fake)

    const readiness = await rebirth.readiness(PLAYER)

    expect(readiness.eligible).toBe(false)
    expect(readiness.remainingMs).toBeGreaterThan(47 * HOUR)
    expect(readiness.remainingMs).toBeLessThanOrEqual(48 * HOUR)
    expect(readiness.eligibleAt!.getTime()).toBe(openedAt.getTime() + 48 * HOUR)
  })

  test('۴۷ ساعت پس از مرگ هنوز نه، ۴۸ ساعت و یک دقیقه بعد بله', async () => {
    const waiting = services(seed({ openedAt: hoursAgo(47) }))
    expect((await waiting.rebirth.readiness(PLAYER)).eligible).toBe(false)

    const done = services(seed({ openedAt: hoursAgo(48.02) }))
    expect((await done.rebirth.readiness(PLAYER)).eligible).toBe(true)
  })

  test('واحدِ انتظار واقعی است، نه تقویم بازی', async () => {
    // ۴۸ ساعتِ بازی فقط ۹۶ دقیقهٔ واقعی است؛ اگر کسی واحد را اشتباه بگیرد
    // این تست سبز می‌شود و مرگ عملاً بی‌هزینه می‌شود.
    const { rebirth } = services(seed({ openedAt: new Date(Date.now() - 97 * 60_000) }))
    expect((await rebirth.readiness(PLAYER)).eligible).toBe(false)
  })

  test('متنِ انتظار هیچ اشاره‌ای به نقشِ مدیر ندارد', async () => {
    const { rebirth } = services(seed({ openedAt: hoursAgo(1) }))

    const reason = (await rebirth.readiness(PLAYER)).reason ?? ''

    expect(reason).toContain('سوگواری')
    expect(reason).not.toMatch(/مدیر|ادمین|admin/i)
  })

  test('بازیکنِ عادی در بازهٔ انتظار نمی‌تواند زندگی تازه بسازد', async () => {
    const fake = seed({ openedAt: hoursAgo(1) })
    const { rebirth } = services(fake)

    await expect(rebirth.startNewLife(PLAYER, DEAD_PROFILE)).rejects.toThrow(ConflictError)
    // وضعیت دست‌نخورده مانده: نه زندگی بالا رفته، نه شخصیت بازنشانی شده
    expect(playerById(fake, PLAYER).lives).toBe(1)
    expect(playerById(fake, PLAYER).status).toBe(PlayerStatus.DEAD)
  })

  test('مدیرِ واقعی بی‌درنگ می‌تواند زندگی تازه را شروع کند', async () => {
    const fake = seed({ openedAt: hoursAgo(1) })
    const { rebirth } = services(fake)

    expect((await rebirth.readiness(PLAYER, { adminOverride: true })).eligible).toBe(true)

    const result = await rebirth.startNewLife(PLAYER, DEAD_PROFILE, { adminOverride: true })
    expect(result.lifeNumber).toBe(2)
    expect(playerById(fake, PLAYER).lives).toBe(2)
    expect(playerById(fake, PLAYER).status).toBe(PlayerStatus.ACTIVE)
  })
})
