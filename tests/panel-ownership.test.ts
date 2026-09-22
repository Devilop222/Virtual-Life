import { editPanel, sendPanel } from '../src/bot/panel'
import { ownsPanel } from '../src/bot/middleware/panel-owner.middleware'
import { GrammyError, InlineKeyboard } from 'grammy'

/**
 * ریشهٔ باگِ «این پنل مال تو نیست» روی پنلِ خودِ بازیکن.
 *
 * در گروه، مالکیتِ پنل از `reply_to_message` خوانده می‌شود. هر مسیری که پنل را
 * **بدون ریپلای به پیام بازیکن** بفرستد، پنلی بی‌صاحب می‌سازد و نگهبان —
 * به‌درستی — حتی مالک را رد می‌کند. این تست‌ها همان قراردادی را قفل می‌کنند
 * که جلوی تکرار باگ را می‌گیرد: هر پنلی که ربات می‌فرستد باید سند مالکیت داشته
 * باشد، چه ویرایش باشد، چه پیام تازه، چه تلاشِ آخرِ بی‌قالب‌بندی.
 */
describe('every panel the bot emits carries its ownership proof', () => {
  const keyboard = new InlineKeyboard().text('بستن', 'panel:close')

  function messageCtx(messageId = 7) {
    const reply = jest.fn().mockResolvedValue({})
    const editMessageText = jest.fn().mockResolvedValue({})
    const ctx = {
      reply,
      editMessageText,
      message: { message_id: messageId },
      chat: { id: -100, type: 'supergroup' },
      callbackQuery: undefined
    }
    return { ctx: ctx as never, reply, editMessageText }
  }

  function callbackCtx(overrides: Record<string, unknown> = {}) {
    const reply = jest.fn().mockResolvedValue({})
    const editMessageText = jest.fn().mockResolvedValue({})
    const ctx = {
      reply,
      editMessageText,
      chat: { id: -100, type: 'supergroup' },
      callbackQuery: {
        message: {
          message_id: 900,
          date: 1,
          chat: { id: -100, type: 'supergroup' },
          reply_to_message: { message_id: 55, from: { id: 4242 } }
        },
        ...overrides
      }
    }
    return { ctx: ctx as never, reply, editMessageText }
  }

  test('a text-input flow that cannot edit still replies to the player', async () => {
    // همان مسیری که «سازندهٔ آگهی استخدام» را در گروه می‌شکست: ورودی متنی است،
    // پس پیامی برای ویرایش نیست و پنل تازه باید به پیامِ خودِ بازیکن ریپلای شود.
    const { ctx, reply, editMessageText } = messageCtx(7)

    await editPanel(ctx, { text: 'پنل', keyboard })

    expect(editMessageText).not.toHaveBeenCalled()
    expect(reply).toHaveBeenCalledTimes(1)
    expect(reply.mock.calls[0][1].reply_parameters).toEqual({
      message_id: 7,
      allow_sending_without_reply: true
    })
    expect(reply.mock.calls[0][1].reply_markup).toBe(keyboard)
  })

  test('an inaccessible callback message falls back to a bound panel', async () => {
    // پیامِ بیش از ۴۸ ساعت `date === 0` است و ویرایش‌پذیر نیست
    const { ctx, reply, editMessageText } = callbackCtx({
      message: {
        message_id: 900,
        date: 0,
        chat: { id: -100, type: 'supergroup' },
        reply_to_message: { message_id: 55, from: { id: 4242 } }
      }
    })

    await editPanel(ctx, { text: 'پنل', keyboard })

    expect(editMessageText).not.toHaveBeenCalled()
    expect(reply.mock.calls[0][1].reply_parameters.message_id).toBe(55)
  })

  test('an editable callback message is edited in place (one action, one panel)', async () => {
    const { ctx, reply, editMessageText } = callbackCtx()

    await editPanel(ctx, { text: 'پنل', keyboard })

    expect(editMessageText).toHaveBeenCalledTimes(1)
    expect(reply).not.toHaveBeenCalled()
  })

  test('sendPanel in a group always answers on the player message', async () => {
    const { ctx, reply } = messageCtx(11)

    await sendPanel(ctx, { text: 'پنل', keyboard })

    expect(reply.mock.calls[0][1].reply_parameters.message_id).toBe(11)
  })

  test('the panel owner guard reads the reply chain, and fails closed without it', () => {
    const actor = 4242
    const owned = {
      callbackQuery: {
        message: {
          chat: { id: -100, type: 'supergroup' },
          reply_to_message: { from: { id: actor } }
        }
      },
      from: { id: actor }
    }
    const orphan = {
      callbackQuery: { message: { chat: { id: -100, type: 'supergroup' } } },
      from: { id: actor }
    }
    const someoneElse = {
      callbackQuery: {
        message: {
          chat: { id: -100, type: 'supergroup' },
          reply_to_message: { from: { id: 999 } }
        }
      },
      from: { id: actor }
    }

    expect(ownsPanel(owned as never)).toBe(true)
    // بدون سند مالکیت، حتی مالک رد می‌شود — پس ساختنِ پنلِ بی‌ریپلای باگ است
    expect(ownsPanel(orphan as never)).toBe(false)
    expect(ownsPanel(someoneElse as never)).toBe(false)
  })

  test('a Markdown parse error never costs the player their buttons', async () => {
    const parseError = () =>
      new GrammyError(
        "Bad Request: can't parse entities",
        { ok: false, error_code: 400, description: "Bad Request: can't parse entities" },
        'sendMessage',
        {}
      )
    const reply = jest.fn().mockRejectedValueOnce(parseError()).mockResolvedValueOnce({})
    const ctx = {
      reply,
      message: { message_id: 7 },
      chat: { id: -100, type: 'supergroup' },
      callbackQuery: undefined
    } as never

    await sendPanel(ctx, { text: 'نام: *علی', keyboard })

    expect(reply).toHaveBeenCalledTimes(2)
    // تلاش دوم بی‌قالب‌بندی است ولی کیبورد و سند مالکیت را نگه می‌دارد
    expect(reply.mock.calls[1][1].parse_mode).toBeUndefined()
    expect(reply.mock.calls[1][1].reply_markup).toBe(keyboard)
    expect(reply.mock.calls[1][1].reply_parameters.message_id).toBe(7)
  })
})
