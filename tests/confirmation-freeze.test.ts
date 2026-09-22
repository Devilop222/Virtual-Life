/**
 * قفلِ لایهٔ تأییدِ دومرحله‌ای روی شخصیتِ فوت‌شده/مسدود.
 *
 * ## حفره‌ای که این آزمون‌ها می‌بندند
 * دکمه‌های تأیید (`act:go:<kind>:<token>`) هیچ «بخشی» ندارند، پس میان‌افزارِ
 * سراسریِ سیاست محیط — که تنها جایی بود که وضعیتِ فوت/مسدود را می‌سنجید —
 * از رویشان رد می‌شد. نتیجه یک نقصِ واقعی بود: بازیکنی که پس از دیدنِ صفحهٔ
 * تأیید می‌مرد (یا مسدود می‌شد) می‌توانست توکنِ باقی‌مانده را بزند و عملیات
 * اجرا می‌شد — مرگ در عمل «قفل» نبود، فقط «پنهان‌کاری» بود.
 *
 * ## چرا اینجا و نه در هر سرویس؟
 * هر سرویس به‌تنهایی می‌تواند وضعیت را بسنجد، ولی ۱۲ عملیاتِ تأییدشدنی
 * (خرید/فروش ملک، تأسیس و ارتقای کسب‌وکار، استخدام و اخراج، شعبه، پروژهٔ
 * شهری، تحصیل، وصیت) یعنی ۱۲ جای فراموش‌شدنی. قاعده در یک نقطه اعمال می‌شود
 * تا افزودنِ عملیاتِ تازه هم خودکار محافظت بگیرد.
 */
import type { Context } from 'grammy'
import type { Prisma } from '@prisma/client'
import { PlayerStatus } from '@prisma/client'
import { registerConfirmableAction, registerConfirmationHandlers } from '../src/bot/confirm-action'
import { actorStanding } from '../src/bot/chat-policy'
import { WillService } from '../src/modules/inheritance/will.service'
import type { Container } from '../src/services/container'

const TOKEN = '11111111-2222-3333-4444-555555555555'
const KIND = 'freeze_probe'
const TG_ID = 9001n

function containerOf(
  status: PlayerStatus,
  consume: () => Prisma.JsonObject | null
): Container {
  return {
    playerRepository: {
      findByTelegramUserId: jest.fn().mockResolvedValue({ id: 'p-1', status })
    },
    userStateRepository: {
      consumeScopedConfirmation: jest.fn().mockResolvedValue(
        consume() === null ? null : { payload: consume() }
      ),
      clear: jest.fn().mockResolvedValue(undefined)
    }
  } as unknown as Container
}

function makeCtx(data: string) {
  const editMessageText = jest.fn().mockResolvedValue({})
  const reply = jest.fn().mockResolvedValue({})
  const answerCallbackQuery = jest.fn().mockResolvedValue(true)
  const ctx = {
    from: { id: Number(TG_ID) },
    chat: { id: Number(TG_ID), type: 'private' },
    callbackQuery: {
      data,
      message: { message_id: 7, date: 1_700_000_000, chat: { id: Number(TG_ID) } }
    },
    answerCallbackQuery,
    editMessageText,
    reply,
    api: { editMessageText }
  }
  return { ctx: ctx as unknown as Context, editMessageText, answerCallbackQuery }
}

/** هندلرِ `act:go` را با یک زمینهٔ دست‌ساز اجرا می‌کند و نتیجه را برمی‌گرداند. */
async function runConfirm(container: Container): Promise<{
  runCalled: boolean
  consumed: boolean
  cleared: boolean
  answerCallbackQuery: jest.Mock
  editMessageText: jest.Mock
}> {
  const run = jest.fn().mockResolvedValue(undefined)
  registerConfirmableAction({ kind: KIND, run })

  const handlers: Array<{ pattern: RegExp; handler: (ctx: Context) => Promise<void> }> = []
  const bot = {
    callbackQuery: (pattern: RegExp, handler: (ctx: Context) => Promise<void>) => {
      handlers.push({ pattern, handler })
    }
  }
  registerConfirmationHandlers(bot as never, container)
  const target = handlers.find((h) => h.pattern.test(`act:go:${KIND}:${TOKEN}`))
  expect(target).toBeDefined()

  const { ctx, editMessageText, answerCallbackQuery } = makeCtx(`act:go:${KIND}:${TOKEN}`)
  await target!.handler(ctx)

  const state = container.userStateRepository as unknown as {
    consumeScopedConfirmation: jest.Mock
    clear: jest.Mock
  }
  return {
    runCalled: run.mock.calls.length > 0,
    consumed: state.consumeScopedConfirmation.mock.calls.length > 0,
    cleared: state.clear.mock.calls.length > 0,
    answerCallbackQuery,
    editMessageText
  }
}

describe('لایهٔ تأیید — شخصیتِ فوت‌شده نمی‌تواند عملیاتِ تأییدشده را اجرا کند', () => {
  test('توکنِ باقی‌مانده پس از مرگ اجرا نمی‌شود', async () => {
    const container = containerOf(PlayerStatus.DEAD, () => ({ modelType: 'SHOP' }))
    const result = await runConfirm(container)

    expect(result.runCalled).toBe(false)
    // و مهم‌تر: توکن حتی مصرف هم نمی‌شود؛ چون پاک می‌شود.
    expect(result.consumed).toBe(false)
    expect(result.cleared).toBe(true)
  })

  test('پیامِ بازیکن دربارهٔ پایانِ داستان است، نه یک خطای فنی', async () => {
    const container = containerOf(PlayerStatus.DEAD, () => ({}))
    const result = await runConfirm(container)

    const [options] = result.answerCallbackQuery.mock.calls[0] as [
      { text: string; show_alert: boolean }
    ]
    expect(options.text).toContain('پایان')
    expect(options.show_alert).toBe(true)
    // و پنل جانشین هم همان پیام را می‌دهد.
    const [text] = result.editMessageText.mock.calls[0] as [string]
    expect(text).toContain('پایان داستان')
  })

  test('حسابِ مسدود هم نمی‌تواند تأییدِ بازش را اجرا کند', async () => {
    const container = containerOf(PlayerStatus.BANNED, () => ({}))
    const result = await runConfirm(container)

    expect(result.runCalled).toBe(false)
    expect(result.cleared).toBe(true)
    const [options] = result.answerCallbackQuery.mock.calls[0] as [{ text: string }]
    expect(options.text).toContain('مسدود')
  })

  test('بازیکنِ زنده بدون تغییر رفتار قبلی کار می‌کند (بدون regression)', async () => {
    const container = containerOf(PlayerStatus.ACTIVE, () => ({ modelType: 'SHOP' }))
    const result = await runConfirm(container)

    expect(result.runCalled).toBe(true)
    expect(result.consumed).toBe(true)
    expect(result.cleared).toBe(false)
  })
})

describe('actorStanding — تک‌منبعِ حقیقتِ «چه کسی اجازهٔ کنش دارد»', () => {
  const standingOf = (player: unknown) =>
    actorStanding(
      {
        playerRepository: { findByTelegramUserId: jest.fn().mockResolvedValue(player) },
        groupRepository: { findByTelegramGroupId: jest.fn().mockResolvedValue(null) }
      } as unknown as Container,
      1n
    )

  test('بازیکنِ فعال', async () => {
    expect(await standingOf({ id: 'p', status: PlayerStatus.ACTIVE })).toBe('active')
  })

  test('شخصیتِ فوت‌شده', async () => {
    expect(await standingOf({ id: 'p', status: PlayerStatus.DEAD })).toBe('dead')
  })

  test('حسابِ مسدود', async () => {
    expect(await standingOf({ id: 'p', status: PlayerStatus.BANNED })).toBe('banned')
  })

  test('حسابِ ناشناس، کنش را نمی‌بندد (ثبت‌نام و راهنما باید باز بمانند)', async () => {
    expect(await standingOf(null)).toBe('active')
  })

  test('قاعدهٔ لایهٔ ربات از دامنه می‌آید و جداگانه بازتعریف نشده است', async () => {
    // تنها منبعِ تعریف باید `playerBlockReason` باشد. اگر روزی کسی دوباره
    // یک `if` محلی بنویسد، این آزمون با اولین وضعیتِ تازه شکسته می‌شود.
    const playerBlockReason = (await import('../src/modules/identity/player-state-machine'))
      .playerBlockReason
    const cases: Array<[PlayerStatus, 'active' | 'dead' | 'banned']> = [
      [PlayerStatus.ACTIVE, 'active'],
      [PlayerStatus.INACTIVE, 'active'],
      [PlayerStatus.DEAD, 'dead'],
      [PlayerStatus.BANNED, 'banned']
    ]
    for (const [status, expected] of cases) {
      expect(await standingOf({ id: 'p', status })).toBe(expected)
      expect(playerBlockReason(status) ?? 'active').toBe(expected)
    }
  })

  test('پیامِ هر دلیل در دامنه تعریف شده و به بازیکن گفته می‌شود', async () => {
    const { PLAYER_BLOCK_MESSAGES } = await import('../src/modules/identity/player-state-machine')
    expect(PLAYER_BLOCK_MESSAGES.dead.text).toContain('فوت')
    expect(PLAYER_BLOCK_MESSAGES.banned.text).toContain('مسدود')
  })
})

/**
 * یادداشتِ وصیت، متنِ آزادِ بازیکن است و بدون واسطه در پنل (Markdown)
 * نمایش داده می‌شود. یک `*` یا `_` جفتِ قالب‌بندی را باز و بی‌بسته می‌گذارد
 * و تلگرام کلِ پنل را رد می‌کند — یعنی از آن لحظه بازیکن پنلِ بی‌قالب می‌بیند.
 * قراردادِ جاافتادهٔ پروژه پاک‌سازی در مرزِ ورودی است.
 */
describe('یادداشتِ وصیت — متنِ بازیکن پنل را نمی‌شکند', () => {
  function willOf() {
    const db = {
      player: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'p-1',
          firstName: 'Ali',
          lastName: null,
          status: PlayerStatus.ACTIVE,
          health: 90
        })
      },
      will: {
        findUnique: jest.fn().mockResolvedValue({ id: 'w-1' }),
        update: jest.fn().mockResolvedValue({ note: null })
      }
    }
    const service = new WillService(
      db as never,
      { recordPlayerEvent: jest.fn() } as never,
      { settleIfDeceased: jest.fn().mockResolvedValue(null) } as never,
      {} as never
    )
    return { service, update: db.will.update }
  }

  /** یادداشتی که واقعاً ذخیره می‌شود (نه مقدار بازگشتیِ mock). */
  function savedNote(update: jest.Mock): string | null {
    // `will.update` یک آرگومان می‌گیرد: `{ where, data }`.
    const [arg] = update.mock.calls[0] as [{ data: { note: string | null } }]
    return arg.data.note
  }

  test('نشانه‌های قالب‌بندی از یادداشت برداشته می‌شوند', async () => {
    const { service, update } = willOf()
    await service.setNote(1n, 'سلام *دنیا* و _این_ و `کد` و [لینک]')
    const note = savedNote(update)
    expect(note).not.toMatch(/[*_`[\]]/)
    expect(note).toContain('سلام')
  })

  test('یادداشتِ سالم دست‌نخورده می‌ماند', async () => {
    const { service, update } = willOf()
    await service.setNote(1n, 'پول را برای بچه‌ها خرج کن')
    expect(savedNote(update)).toBe('پول را برای بچه‌ها خرج کن')
  })

  test('یادداشتی که فقط نشانهٔ قالب است، وصیت را به متنِ خالی تبدیل نمی‌کند', async () => {
    const { service, update } = willOf()
    await service.setNote(1n, '***')
    expect(savedNote(update)).toBeNull()
  })
})
