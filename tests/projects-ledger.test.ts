/**
 * پروژه‌های شهری ۲.۰ — مشارکتِ قابل‌ردیابی، جمعِ قابل‌آشتی و تکمیلِ یک‌باره.
 *
 * چه چیزی این‌جا اثبات می‌شود؟
 *   ۱. هر کمک یک رکوردِ مستقل می‌گیرد و در همان تراکنشِ پول نوشته می‌شود؛
 *      «پول کم شد ولی سابقه‌ای نماند» ناممکن است.
 *   ۲. اینورینتِ اقتصادی: `collectedAmount` دقیقاً برابر جمعِ رکوردهای کمک.
 *   ۳. سیاستِ «بیش از باقی‌مانده»: کسر فقط به‌اندازهٔ باقی‌مانده است.
 *   ۴. تکمیل فقط یک‌بار اجرا می‌شود و خبرش هم یک‌بار می‌رود.
 *   ۵. اگر ربات بین تکمیل و ثبت خبر پایین بیاید، چرخهٔ دوره‌ای خبر را می‌فرستد.
 *   ۶. شخصیتِ فوت‌شده نمی‌تواند کمک کند.
 */
import { PlayerStatus, TransactionType } from '@prisma/client'
import { createFakeDb } from './helpers/fake-db'
import { PROJECT_BLUEPRINTS, ProjectsService } from '../src/modules/city/projects.service'
import { EventService } from '../src/modules/events/event.service'

const DONOR = 'p-donor'
const OTHER = 'p-other'
const GROUP = 'g-1'

function makeEvents() {
  const events: Array<Record<string, unknown>> = []
  return {
    events,
    service: {
      recordRegionEvent: jest.fn(async (input: Record<string, unknown>) => {
        events.push(input)
        return { id: `ev-${events.length}` }
      }),
      recordPlayerEvent: jest.fn().mockResolvedValue(undefined)
    }
  }
}

function seed(playerOverrides: Record<string, unknown> = {}, project: Record<string, unknown> | null = null) {
  return createFakeDb({
    players: [
      {
        id: DONOR,
        telegramUserId: 1001n,
        firstName: 'آرش',
        lastName: 'ک.',
        status: PlayerStatus.ACTIVE,
        balance: 5_000_000,
        health: 100,
        age: 30,
        lives: 1,
        healthSyncedAt: new Date(),
        startedAt: new Date(),
        ...playerOverrides
      },
      {
        id: OTHER,
        telegramUserId: 1002n,
        firstName: 'سارا',
        lastName: 'م.',
        status: PlayerStatus.ACTIVE,
        balance: 5_000_000,
        health: 100,
        age: 30,
        lives: 1,
        healthSyncedAt: new Date(),
        startedAt: new Date()
      }
    ],
    projects: project ? [project] : [],
    regionStats: [{ id: 'rs-1', groupId: GROUP, taxRevenue: 0 }]
  })
}

function projectRow(collected: number, target: number = PROJECT_BLUEPRINTS.park.targetAmount) {
  return {
    id: 'pr-1',
    groupId: GROUP,
    key: 'park',
    title: PROJECT_BLUEPRINTS.park.title,
    description: PROJECT_BLUEPRINTS.park.description,
    targetAmount: target,
    collectedAmount: collected,
    isCompleted: false,
    completedAt: null,
    announcedAt: null,
    startedAt: null,
    startedByPlayerId: null
  }
}

function serviceOf(fake: ReturnType<typeof createFakeDb>) {
  const events = makeEvents()
  const service = new ProjectsService(fake.db, events.service as unknown as EventService)
  return { service, events }
}

describe('هر کمک یک رکوردِ مستقل می‌گیرد', () => {
  test('کمک موفق، رکوردِ مشارکت و ردیف دفتر کل هر دو را می‌سازد', async () => {
    const fake = seed()
    const { service } = serviceOf(fake)

    const result = await service.donate(1001n, GROUP, 'park', 250_000)

    expect(result.donated).toBe(250_000)
    expect(fake.state.projectDonations).toHaveLength(1)
    const donation = fake.state.projectDonations[0]!
    expect(Number(donation.amount)).toBe(250_000)
    expect(donation.donorId).toBe(DONOR)
    expect(donation.donorName).toContain('آرش')

    const ledger = fake.state.transactions.filter(
      (row) => row.type === TransactionType.PROJECT_DONATION
    )
    expect(ledger).toHaveLength(1)
    expect(Number(ledger[0]!.amount)).toBe(250_000)
  })

  test('موجودیِ ناکافی هیچ رکوردی نمی‌سازد و پول را دست نمی‌زند', async () => {
    const fake = seed({ balance: 10_000 })
    const { service } = serviceOf(fake)

    await expect(service.donate(1001n, GROUP, 'park', 250_000)).rejects.toThrow()

    expect(fake.state.projectDonations).toHaveLength(0)
    expect(playerById(fake, DONOR).balance).toBe(10_000)
  })

  test('شخصیتِ فوت‌شده نمی‌تواند کمک کند', async () => {
    const fake = seed({ status: PlayerStatus.DEAD })
    const { service } = serviceOf(fake)

    await expect(service.donate(1001n, GROUP, 'park', 100_000)).rejects.toThrow()
    expect(fake.state.projectDonations).toHaveLength(0)
    expect(playerById(fake, DONOR).balance).toBe(5_000_000)
  })

  test('مبلغِ صفر یا منفی هیچ نوشتاری نمی‌سازد', async () => {
    const fake = seed()
    const { service } = serviceOf(fake)
    await expect(service.donate(1001n, GROUP, 'park', 0)).rejects.toThrow()
    await expect(service.donate(1001n, GROUP, 'park', -5)).rejects.toThrow()
    expect(fake.state.projectDonations).toHaveLength(0)
  })
})

describe('اینورینتِ اقتصادی: جمعِ کمک‌ها = پیشرفت پروژه', () => {
  test('سه کمک از دو بازیکن، جمعِ پیشرفت را دقیقاً می‌سازد', async () => {
    const fake = seed()
    const { service } = serviceOf(fake)

    await service.donate(1001n, GROUP, 'park', 300_000)
    await service.donate(1002n, GROUP, 'park', 700_000)
    await service.donate(1001n, GROUP, 'park', 500_000)

    const collected = Number(fake.state.projects[0]!.collectedAmount)
    const donated = fake.state.projectDonations.reduce((sum, row) => sum + Number(row.amount), 0)

    expect(donated).toBe(1_500_000)
    expect(collected).toBe(donated)

    // و موجودیِ اهداکنندگان هم با همان اعداد کم شده است.
    expect(Number(playerById(fake, DONOR).balance)).toBe(5_000_000 - 800_000)
    expect(Number(playerById(fake, OTHER).balance)).toBe(5_000_000 - 700_000)
  })

  test('بیش از باقی‌مانده فقط به‌اندازهٔ باقی‌مانده کسر می‌شود', async () => {
    const fake = seed({}, projectRow(0, 1_000_000))
    const { service } = serviceOf(fake)

    const result = await service.donate(1001n, GROUP, 'park', 5_000_000)

    expect(result.donated).toBe(1_000_000)
    expect(Number(playerById(fake, DONOR).balance)).toBe(4_000_000)
    expect(fake.state.projectDonations).toHaveLength(1)
    expect(Number(fake.state.projectDonations[0]!.amount)).toBe(1_000_000)
  })
})

describe('تکمیل پروژه — یک‌بار، برای همیشه', () => {
  test('رسیدن به هدف، پروژه را می‌بندد و خبر می‌دهد', async () => {
    const fake = seed({}, projectRow(900_000, 1_000_000))
    const { service, events } = serviceOf(fake)

    const result = await service.donate(1001n, GROUP, 'park', 100_000)

    expect(result.completedNow).toBe(true)
    expect(fake.state.projects[0]!.isCompleted).toBe(true)
    expect(fake.state.projects[0]!.completedAt).toBeTruthy()
    expect(fake.state.projects[0]!.announcedAt).toBeTruthy()
    expect(events.events).toHaveLength(1)
  })

  test('کمک به پروژهٔ تکمیل‌شده رد می‌شود و پولی جابه‌جا نمی‌کند', async () => {
    const done = { ...projectRow(1_000_000, 1_000_000), isCompleted: true }
    const fake = seed({}, done)
    const { service } = serviceOf(fake)

    await expect(service.donate(1001n, GROUP, 'park', 100_000)).rejects.toThrow()

    expect(Number(playerById(fake, DONOR).balance)).toBe(5_000_000)
    expect(fake.state.projectDonations).toHaveLength(0)
  })

  test('خبرِ تکمیل دوبار فرستاده نمی‌شود (حتی با چند تناقض هم‌زمان)', async () => {
    const fake = seed({}, projectRow(900_000, 1_000_000))
    const { service, events } = serviceOf(fake)

    await service.donate(1001n, GROUP, 'park', 100_000)
    // اجرای دوبارهٔ چرخهٔ ترمیم روی همان پروژه: `announcedAt` پر است.
    const recovered = await service.recoverPendingAnnouncements(10)

    expect(recovered).toBe(0)
    expect(events.events).toHaveLength(1)
  })
})

describe('ترمیمِ خبرِ جامانده — مهم‌ترین حفرهٔ قبلی', () => {
  test('پروژهٔ تکمیل‌شدهٔ بی‌اعلام، توسط چرخه خبر می‌گیرد', async () => {
    // وضعیتی که پیش‌تر پایانی نداشت: ربات بین «تکمیل» و «ثبت خبر» خاموش
    // شده و پروژه تکمیل‌شدهٔ بی‌اعلام در دیتابیس مانده است.
    const orphan = { ...projectRow(1_000_000, 1_000_000), isCompleted: true, completedAt: new Date() }
    const fake = seed({}, orphan)
    const { service, events } = serviceOf(fake)

    const recovered = await service.recoverPendingAnnouncements(10)

    expect(recovered).toBe(1)
    expect(fake.state.projects[0]!.announcedAt).toBeTruthy()
    expect(events.events).toHaveLength(1)
    expect(String(events.events[0]!.dedupeKey)).toContain('project-done:pr-1')
  })

  test('اگر ثبت خبر شکست بخورد، حق اعلام آزاد می‌ماند تا بار بعد', async () => {
    const orphan = { ...projectRow(1_000_000, 1_000_000), isCompleted: true }
    const fake = seed({}, orphan)
    const failing = {
      recordRegionEvent: jest.fn().mockRejectedValue(new Error('news down')),
      recordPlayerEvent: jest.fn().mockResolvedValue(undefined)
    }
    const service = new ProjectsService(fake.db, failing as unknown as EventService)

    const recovered = await service.recoverPendingAnnouncements(10)

    expect(recovered).toBe(0)
    // کلید: پروژه «تکمیل‌شدهٔ بی‌اعلام» مانده تا تلاش دوباره ممکن باشد.
    expect(fake.state.projects[0]!.announcedAt).toBeFalsy()
  })

  test('پروژهٔ تکمیل‌نشده هرگز اعلام نمی‌شود', async () => {
    const fake = seed({}, projectRow(100_000, 1_000_000))
    const { service, events } = serviceOf(fake)

    const recovered = await service.recoverPendingAnnouncements(10)

    expect(recovered).toBe(0)
    expect(events.events).toHaveLength(0)
  })
})

describe('پنل و سوابق — داده‌های واقعی، بدون تکرار', () => {
  test('فهرست پروژه‌ها باقی‌مانده و تعداد مشارکت‌کننده را می‌دهد', async () => {
    const fake = seed()
    const { service } = serviceOf(fake)

    await service.donate(1001n, GROUP, 'park', 300_000)
    await service.donate(1002n, GROUP, 'park', 200_000)

    const projects = await service.listProjects(GROUP)
    const park = projects.find((p) => p.key === 'park')!

    expect(park.collectedAmount).toBe(500_000)
    expect(park.remainingAmount).toBe(park.targetAmount - 500_000)
    // دو نفر، سه کمک نه — «مشارکت‌کننده» آدم می‌شمارد، نه ردیف.
    expect(park.participantCount).toBe(2)
  })

  test('تاریخچهٔ کمک‌های بازیکن مجموع و صفحه‌بندی را درست می‌دهد', async () => {
    const fake = seed()
    const { service } = serviceOf(fake)

    await service.donate(1001n, GROUP, 'park', 300_000)
    await service.donate(1001n, GROUP, 'clinic', 150_000)
    await service.donate(1002n, GROUP, 'park', 900_000)

    const mine = await service.listMyDonations(DONOR, 0, 8)

    expect(mine.total).toBe(2)
    expect(mine.totalAmount).toBe(450_000)
    // پولِ بازیکنِ دیگر در سابقهٔ من دیده نمی‌شود.
    expect(mine.items.every((item) => item.amount <= 300_000)).toBe(true)
  })

  test('تاریخچهٔ پروژه نامِ اهداکننده را نشان می‌دهد و مبلغِ دیگری را لو نمی‌دهد جز همان کمک', async () => {
    const fake = seed()
    const { service } = serviceOf(fake)

    await service.donate(1001n, GROUP, 'park', 300_000)
    await service.donate(1002n, GROUP, 'park', 900_000)

    const board = await service.listProjectDonations(GROUP, 'park', 0, 8)

    expect(board.total).toBe(2)
    expect(board.items.map((item) => item.amount).sort((a, b) => a - b)).toEqual([300_000, 900_000])
    expect(board.items.every((item) => item.donorName.length > 0)).toBe(true)
  })
})

function playerById(fake: ReturnType<typeof createFakeDb>, id: string) {
  return fake.state.players.find((row) => row.id === id)!
}
