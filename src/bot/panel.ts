import { Context, InlineKeyboard } from 'grammy'
import { GrammyError } from 'grammy'
import { logger } from '../utils/logger'

export interface PanelOptions {
  text: string
  keyboard?: InlineKeyboard
  parseMode?: 'Markdown' | 'HTML'
}

/**
 * پیامی که این پنل باید به آن ریپلای شود — یعنی «سندِ مالکیت» پنل.
 *
 * چرا حیاتی است؟ در گروه، `panelOwnerMiddleware` مالک پنل را از
 * `reply_to_message.from.id` می‌خواند. پنلی که بدون ریپلای به پیامِ بازیکن
 * ارسال شود **هیچ سندی از مالکیت ندارد** و نگهبان به‌درستی آن را رد می‌کند؛
 * نتیجه چیزی است که بازیکن «این پنل مال تو نیست» روی پنلِ خودش می‌بیند.
 *
 * دو مسیر وجود دارد و هر دو باید به سند مالکیت برسند:
 *  • مسیر پیام متنی → خودِ پیام بازیکن.
 *  • مسیر دکمه → همان پیامی که پنلِ فعلی به آن ریپلای شده است (زنجیرهٔ
 *    مالکیت از اولین پنل تا آخرین ویرایش حفظ می‌شود).
 */
function ownerMessageId(ctx: Context): number | undefined {
  const callbackMessage = ctx.callbackQuery?.message
  if (
    callbackMessage &&
    'reply_to_message' in callbackMessage &&
    callbackMessage.reply_to_message
  ) {
    return callbackMessage.reply_to_message.message_id
  }
  if (ctx.message && 'message_id' in ctx.message) {
    return ctx.message.message_id
  }
  return undefined
}

/** پارامترهای ریپلای برای همهٔ ارسال‌ها؛ هرگز سند مالکیت را از دست نده. */
function replyParams(ctx: Context) {
  const id = ownerMessageId(ctx)
  return id
    ? { reply_parameters: { message_id: id, allow_sending_without_reply: true } }
    : {}
}

/**
 * ارسال پنل تازه، همیشه با سند مالکیت.
 * اگر متن Parser را بشکند (نامی که ستاره دارد، ...) همان متن بدون
 * قالب‌بندی می‌رود تا پنل هرگز از بین نرود.
 */
/**
 * @param plain اگر متن پیش‌تر Parser را شکسته باشد، تلاشِ دوبارهٔ Markdown
 *   فقط یک درخواستِ محکوم‌به‌شکست به تلگرام می‌فرستد؛ پس مستقیم بی‌قالب می‌رویم.
 */
async function sendFreshPanel(
  ctx: Context,
  options: PanelOptions,
  plain = false
): Promise<void> {
  const parseMode = plain ? undefined : (options.parseMode ?? 'Markdown')
  const reply = replyParams(ctx)

  try {
    await ctx.reply(options.text, {
      parse_mode: parseMode,
      reply_markup: options.keyboard,
      ...reply
    })
    return
  } catch (error) {
    if (!isParseError(error)) {
      logger.warn({ err: error }, 'sendFreshPanel failed')
      return
    }
  }

  // متنِ بی‌قالب‌بندی، همان ریپلای، همان کیبورد: دکمه‌ها و سندِ مالکیتِ پنل
  // در آخرین تلاش هم حفظ می‌شوند تا بازیکن پنلِ بی‌دکمه در گروه نگیرد.
  try {
    await ctx.reply(options.text, { reply_markup: options.keyboard, ...reply })
  } catch (error) {
    logger.warn({ err: error }, 'sendFreshPanel plain fallback failed')
  }
}

/**
 * ارسال یک پنل جدید در پاسخ (Reply) به پیام کاربر.
 * همیشه روی پیام خود کاربر ریپلای می‌زند تا در گروه گم نشود و مالکیتش
 * قابل اثبات بماند.
 */
export async function sendPanel(ctx: Context, options: PanelOptions): Promise<void> {
  // مسیر دکمه: همان پیام را ویرایش کن (ONE ACTION = ONE PANEL)
  if (ctx.callbackQuery?.message) return editPanel(ctx, options)
  await sendFreshPanel(ctx, options)
}

/**
 * آیا پیامی برای ویرایش هست؟
 *  • بدون callback (جریانِ ورودیِ متنی) → چیزی برای ویرایش نیست.
 *  • پیامِ دسترسی‌ناپذیر (بیش از ۴۸ ساعت؛ `date === 0`) → ویرایش‌پذیر نیست.
 * در هر دو حالت پنلِ تازه می‌فرستیم، با همان سندِ مالکیت.
 */
function editableCallbackMessage(ctx: Context): boolean {
  const message = ctx.callbackQuery?.message
  if (!message) return false
  return message.date !== 0
}

/**
 * ویرایش پنل موجود (همان پیامی که دکمه روی آن زده شده).
 * خطاهای بی‌خطر تلگرام مثل «message is not modified» نادیده گرفته می‌شوند.
 *
 * اگر پیامی برای ویرایش نباشد (جریانِ ورودیِ متنی، پیام حذف‌شده، پیام
 * دسترسی‌ناپذیر) پنل تازه‌ای با **همان سند مالکیت** فرستاده می‌شود؛ بی‌صدا
 * چیزی از دست نمی‌رود و بازیکن هرگز روی پنلِ بی‌صاحب نمی‌ماند.
 */
export async function editPanel(ctx: Context, options: PanelOptions): Promise<void> {
  if (!editableCallbackMessage(ctx)) {
    await sendFreshPanel(ctx, options)
    return
  }

  const parseMode = options.parseMode ?? 'Markdown'
  try {
    await ctx.editMessageText(options.text, {
      parse_mode: parseMode,
      reply_markup: options.keyboard
    })
    return
  } catch (error) {
    if (isIgnorableEditError(error)) {
      return
    }

    // اگر Parser شکسته باشد (متن پویا مثل نامِ حاوی ستاره)، همان ویرایش را
    // بدون قالب‌بندی تکرار می‌کنیم؛ پیام همان‌جا است و نباید پنل جدید ساخته
    // شود. پیش‌تر این خطا فقط لاگ می‌شد و کاربر هیچ پنلی نمی‌دید.
    if (isParseError(error)) {
      try {
        await ctx.editMessageText(options.text, {
          parse_mode: undefined,
          reply_markup: options.keyboard
        })
        return
      } catch (retryError) {
        // اگر ویرایشِ ساده هم نشد (مثلاً پیام حذف شده)، به fallbackِ reply برو
        logger.warn({ err: retryError }, 'editPanel plain retry failed')
      }
    }

    // پیام قابل ویرایش نبود (حذف‌شده یا عکس) → پنل تازه، با سند مالکیت
    logger.warn({ err: error }, 'editPanel fell back to a fresh panel')
    await sendFreshPanel(ctx, options, isParseError(error))
  }
}

/**
 * ویرایش فقط کیبورد پنل موجود.
 */
export async function editPanelKeyboard(ctx: Context, keyboard: InlineKeyboard): Promise<void> {
  try {
    await ctx.editMessageReplyMarkup({ reply_markup: keyboard })
  } catch (error) {
    if (!isIgnorableEditError(error)) {
      logger.warn({ err: error }, 'editPanelKeyboard failed')
    }
  }
}

/**
 * پاسخ کوتاه به کاربر — در مسیر دکمه «توست»، در مسیر فرمان «پیام».
 *
 * ## چرا این تفکیک حیاتی است؟
 * `answerCallbackQuery` فقط برای Callback معنا دارد. اگر همین تابع در پاسخ
 * به یک **فرمان/پیام متنی** صدا زده شود، تلگرام آن را رد می‌کند و چون
 * خطا اینجا بی‌صدا گرفته می‌شود، کاربر **هیچ پاسخی نمی‌گیرد**. این دقیقاً
 * همان «شکستِ خاموش» بود: `/botupdate` در مسیر خطا (دسترسی، تغییراتِ محلی،
 * خطای غیرمنتظره) از همین کانال استفاده می‌کرد و مالک ربات فکر می‌کرد دکمه
 * کار نمی‌کند، در حالی که فقط پیامش جایی برای رفتن نداشت.
 *
 * قاعده: هیچ اطلاعی نباید بی‌صدا دور ریخته شود. اگر Callbackی نیست، همان
 * متن به‌عنوان پیام می‌رود؛ اگر متنی هم نیست (مثل توستِ خالیِ جریانِ دکمه)
 * کاری برای انجام‌دادن وجود ندارد و سکوت درست است.
 */
export async function ackCallback(ctx: Context, text?: string, alert = false): Promise<void> {
  if (!ctx.callbackQuery) {
    if (text) {
      await sendPanel(ctx, { text })
    }
    return
  }
  try {
    await ctx.answerCallbackQuery(
      text ? { text: [...text].slice(0, 200).join(''), show_alert: alert } : undefined
    )
  } catch {
    // Callbackهای منقضی‌شده را نادیده می‌گیریم
  }
}

function isIgnorableEditError(error: unknown): boolean {
  if (!(error instanceof GrammyError)) {
    return false
  }
  // `description` در تایپ grammy رشته است، ولی `toGrammyError` آن را مستقیم از
  // پاسخ تلگرام برمی‌دارد؛ اگر بدنهٔ خطا description نداشته باشد `undefined`
  // می‌شود. بدون این محافظ، خودِ مدیریت خطا با TypeError می‌ترکد.
  const description = (error.description ?? '').toLowerCase()
  return description.includes('message is not modified') || description.includes('query is too old')
}

/**
 * آیا خطا از شکستنِ Parserِ Markdown تلگرام است؟
 *
 * پنل‌ها با `parse_mode: Markdown` فرستاده می‌شوند و `*` را بولد می‌کنند.
 * متن‌های پویا (نام بازیکن از تلگرام، عنوان آگهی، ...) می‌توانند خودشان
 * `*` یا `_` یا `[` داشته باشند و کل پیام را «can't parse entities» کنند.
 * اگر این خطا را فقط لاگ کنیم، کاربر *هیچ* پنلی نمی‌بیند — پس نسخهٔ
 * ساده (بدون parse_mode) باید جایگزین شود، نه بی‌صدا دور بریزد.
 */
export function isParseError(error: unknown): boolean {
  return (
    error instanceof GrammyError &&
    error.error_code === 400 &&
    (error.description ?? '').toLowerCase().includes("can't parse")
  )
}
