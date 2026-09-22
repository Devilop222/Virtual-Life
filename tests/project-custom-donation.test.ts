/**
 * کمک به پروژهٔ شهر با «مبلغ دلخواه».
 *
 * چه چیزی این‌جا اثبات می‌شود؟
 *   ۱. مبلغِ کوتاه («۱۰۰ میلیون») از همان راهِ عددیِ ساده، پول را جابه‌جا می‌کند.
 *   ۲. کمک بیش از باقی‌مانده فقط به‌اندازهٔ باقی‌مانده کسر می‌شود.
 *   ۳. تخلف از سقف، هیچ پولی جابه‌جا نمی‌کند و جریان را باز نگه می‌دارد (پس
 *      بازیکن می‌تواند دوباره تلاش کند).
 *   ۴. لغو، گروهِ وصل‌نشده و شخصیتِ فوت‌شده هیچ نوشتاری در دیتابیس نمی‌گذارند
 *      و state را پاک می‌کنند تا پیامِ بعدی ناخواسته کمک ثبت نکند.
 *   ۵. سقفِ اعلام‌شده در UI و سقفِ سرویس یک عدد است (بدون رانش).
 *   ۶. مسیرها و نگهبانِ جریانِ ورودی واقعاً وصل‌اند.
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { PlayerStatus } from '@prisma/client'
import { createFakeDb } from './helpers/fake-db'
import { MAX_PROJECT_DONATION, PROJECT_BLUEPRINTS, ProjectsService } from '../src/modules/city/projects.service'
import { EventService } from '../src/modules/events/event.service'
import { handleProjectDonationAmountText } from '../src/bot/handlers/expansion.handler'
import { isMutatingInputFlow } from '../src/bot/handlers/text.handler'

const DONOR = 'p-donor'
const GROUP = 'g-1'
const TELEGRAM_ID = 1001n

function seed(balance = 5_000_000, status: PlayerStatus = PlayerStatus.ACTIVE) {
  return createFakeDb({
    players: [
      {
        id: DONOR,
        telegramUserId: TELEGRAM_ID,
        firstName: 'آرش',
        lastName: 'ک.',
        status,
        balance,
        health: 100,
        age: 30,
        lives: 1,
        healthSyncedAt: new Date(),
        startedAt: new Date()
      }
    ],
    projects: [],
    regionStats: [{ id: 'rs-1', groupId: GROUP, taxRevenue: 0 }]
  })
}

function containerOf(fake: ReturnType<typeof createFakeDb>, groupFound = true) {
  const events = { recordRegionEvent: jest.fn().mockResolvedValue({ id: 'ev-1' }) }
  const service = new ProjectsService(fake.db, events as unknown as EventService)
  const sent: string[] = []
  const ctx = {
    from: { id: Number(TELEGRAM_ID) },
    chat: { id: 900, type: 'supergroup' },
    message: { message_id: 5, text: '' },
    reply: jest.fn(async (text: string) => {
      sent.push(text)
      return {}
    })
  }
  const container = {
    projectsService: service,
    groupRepository: {
      findByTelegramGroupId: jest
        .fn()
        .mockResolvedValue(groupFound ? { id: GROUP } : null)
    },
    userStateRepository: {
      upsert: jest.fn().mockResolvedValue(undefined),
      clear: jest.fn().mockResolvedValue(undefined)
    },
    dailyQuestService: { trackByTelegramId: jest.fn().mockResolvedValue(undefined) }
  }
  return { ctx, container, sent, events }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asCtx = (ctx: unknown) => ctx as any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asContainer = (container: unknown) => container as any

function balanceOf(fake: ReturnType<typeof createFakeDb>): number {
  return Number(fake.state.players.find((p) => p.id === DONOR)!.balance)
}

describe('مبلغِ کوتاه در کمک به پروژه', () => {
  test('«۱۰۰ میلیون» همان پول را جابه‌جا می‌کند که «100000000»', async () => {
    const fake = seed(500_000_000)
    const { ctx, container, sent } = containerOf(fake)

    // پروژهٔ «بازارچهٔ محلی» هدفش ۱۲۰ میلیون است، پس کمکِ ۱۰۰ میلیونی کامل
    // کسر می‌شود و سقفِ باقی‌مانده وسط آزمون نمی‌آید.
    const handled = await handleProjectDonationAmountText(
      asCtx(ctx),
      asContainer(container),
      'bazaar',
      '۱۰۰ میلیون'
    )

    expect(handled).toBe(true)
    expect(balanceOf(fake)).toBe(400_000_000)
    expect(fake.state.projectDonations).toHaveLength(1)
    expect(Number(fake.state.projectDonations[0]!.amount)).toBe(100_000_000)
    expect(sent.join('\n')).toMatch(/۱۰۰[\u066c٬,]?۰۰۰[\u066c٬,]?۰۰۰ تومان/)
    expect(container.userStateRepository.clear).toHaveBeenCalled()

    // همان ورودی با رقمِ خام، همان نتیجه: پارسر دو رفتار ندارد.
    const plain = seed(500_000_000)
    const plainRun = containerOf(plain)
    await handleProjectDonationAmountText(
      asCtx(plainRun.ctx),
      asContainer(plainRun.container),
      'bazaar',
      '۱۰۰۰۰۰۰۰۰'
    )
    expect(balanceOf(plain)).toBe(400_000_000)
  })

  test('کمک بیش از باقی‌مانده، فقط به‌اندازهٔ باقی‌مانده کسر می‌شود', async () => {
    const fake = seed(500_000_000)
    const { ctx, container } = containerOf(fake)

    await handleProjectDonationAmountText(asCtx(ctx), asContainer(container), 'park', '100 میلیون')

    // پروژهٔ پارک هدفش ۵۰ میلیون است؛ کمکِ ۱۰۰ میلیونی باید ۵۰ میلیون کسر کند.
    const target = PROJECT_BLUEPRINTS.park.targetAmount
    expect(balanceOf(fake)).toBe(500_000_000 - target)
    expect(fake.state.projects[0]!.isCompleted).toBe(true)
  })

  test('تخلف از سقف: نه پولی جابه‌جا می‌شود، نه جریان بسته می‌شود', async () => {
    const fake = seed(5_000_000_000)
    const { ctx, container, sent } = containerOf(fake)

    await handleProjectDonationAmountText(
      asCtx(ctx),
      asContainer(container),
      'park',
      '2 میلیارد'
    )

    expect(balanceOf(fake)).toBe(5_000_000_000)
    expect(fake.state.projectDonations).toHaveLength(0)
    expect(sent.join('\n')).toContain('سقف')
    // «تلاش دوباره» یعنی state پاک نشود.
    expect(container.userStateRepository.clear).not.toHaveBeenCalled()
  })

  test('مبلغِ ناخوانا: هیچ تغییری در دیتابیس، ولی جریان باز می‌ماند', async () => {
    const fake = seed()
    const { ctx, container, sent } = containerOf(fake)

    await handleProjectDonationAmountText(
      asCtx(ctx),
      asContainer(container),
      'park',
      'صد میلیون'
    )

    expect(balanceOf(fake)).toBe(5_000_000)
    expect(fake.state.projectDonations).toHaveLength(0)
    expect(sent.join('\n')).toContain('مبلغ نامعتبر')
    expect(container.userStateRepository.clear).not.toHaveBeenCalled()
  })

  test('لغو: نه پولی جابه‌جا می‌شود، نه state می‌ماند', async () => {
    const fake = seed()
    const { ctx, container, sent } = containerOf(fake)

    await handleProjectDonationAmountText(asCtx(ctx), asContainer(container), 'park', 'لغو')

    expect(balanceOf(fake)).toBe(5_000_000)
    expect(fake.state.projectDonations).toHaveLength(0)
    expect(sent.join('\n')).toContain('لغو')
    expect(container.userStateRepository.clear).toHaveBeenCalled()
  })

  test('گروهِ وصل‌نشده: پیام روشن و state پاک، بدون لمس پول', async () => {
    const fake = seed()
    const { ctx, container, sent } = containerOf(fake, false)

    await handleProjectDonationAmountText(asCtx(ctx), asContainer(container), 'park', '۱۰۰ هزار')

    expect(sent.join('\n')).toContain('وصل نشده')
    expect(container.userStateRepository.clear).toHaveBeenCalled()
    expect(fake.state.projectDonations).toHaveLength(0)
  })

  test('شخصیتِ فوت‌شده: خطای سرویس، بدون کمک و بدون stateِ جامانده', async () => {
    const fake = seed(5_000_000_000, PlayerStatus.DEAD)
    const { ctx, container } = containerOf(fake)

    await handleProjectDonationAmountText(
      asCtx(ctx),
      asContainer(container),
      'park',
      '۱۰۰ میلیون'
    )

    expect(balanceOf(fake)).toBe(5_000_000_000)
    expect(fake.state.projectDonations).toHaveLength(0)
    expect(container.userStateRepository.clear).toHaveBeenCalled()
  })
})

describe('قراردادِ سقف و مسیرها', () => {
  const expansion = readFileSync(
    join(__dirname, '..', 'src', 'bot', 'handlers', 'expansion.handler.ts'),
    'utf8'
  )
  const textHandler = readFileSync(
    join(__dirname, '..', 'src', 'bot', 'handlers', 'text.handler.ts'),
    'utf8'
  )

  test('سقف، یک عدد است و پیام خطا از همان می‌خواند', () => {
    expect(MAX_PROJECT_DONATION).toBe(500_000_000)
    const service = readFileSync(
      join(__dirname, '..', 'src', 'modules', 'city', 'projects.service.ts'),
      'utf8'
    )
    expect(service).toContain('amount > MAX_PROJECT_DONATION')
    expect(service).not.toMatch(/amount > 500_000_000/)
  })

  test('هر پروژهٔ بلوپرینت دکمهٔ «مبلغ دلخواه» و هندلر دارد', () => {
    expect(expansion).toContain('`project:custom:${p.key}`')
    expect(expansion).toContain("bot.callbackQuery(/^project:custom:/")
    for (const key of Object.keys(PROJECT_BLUEPRINTS)) {
      expect(key).toBeTruthy()
    }
  })

  test('مبلغِ دلخواه از نگهبانِ جریانِ ورودی رد نمی‌شود', () => {
    expect(isMutatingInputFlow('project_amount:park')).toBe(true)
    expect(textHandler).toContain("pendingContext?.startsWith('project_amount:')")
    expect(textHandler).toContain("'project_amount:'")
  })

  test('کمکِ یک‌کلیکی هم دست‌نخورده مانده', () => {
    expect(expansion).toContain("bot.callbackQuery(/^project:donate:/")
    expect(expansion).toContain('project:donate:${p.key}:${amount}')
  })
})
