/**
 * پنل وصیت و میراث.
 *
 * الگوی ثابت پروژه: یک عمل = یک پنل، همیشه ویرایش (نه پیام تازه)، خطا فقط از
 * مسیر مشترکِ خطا با پیام فارسی. جریان‌های ورودی متنی (انتخاب وارث، یادداشت)
 * با Context در `UserState` ثبت می‌شوند و در `text.handler` خوانده می‌شوند.
 *
 * چرا وارث از `callback_data` نمی‌آید؟ چون شناسهٔ بازیکن حساس است: اگر در
 * دکمه حمل شود، می‌شود با دستکاری آن دارایی را به حساب دلخواه فرستاد. پس
 * شناسه فقط در **payload تأییدِ سمت سرور** می‌نشیند (تک‌مصرف و متصل به
 * همان کاربر و همان چت).
 */
import { Bot, Context } from 'grammy'
import type { Container } from '../../services/container'
import { handleCallbackError } from '../handler-errors'
import type { PanelOptions } from '../panel'
import { ackCallback, editPanel, sendPanel } from '../panel'
import { fa, money, panel } from '../ui-kit'
import { renderWillPanel, renderWillRulesPanel } from '../renders'
import { buildWillInputCancelKeyboard, buildWillKeyboard } from '../keyboards/main.keyboard'
import { askForConfirmation } from '../confirm-action'
import { parseHeirInput } from '../../modules/inheritance/will-core'

type ShowPanelFn = (ctx: Context, options: PanelOptions) => Promise<void>

/** پنل وصیت — تنها نقطهٔ ساخت آن (هم دکمه، هم کلیدواژهٔ متنی). */
export async function showWillPanel(
  ctx: Context,
  container: Container,
  fromId: bigint,
  showPanel: ShowPanelFn = editPanel
): Promise<void> {
  const view = await container.willService.getView(fromId)
  await showPanel(ctx, {
    text: renderWillPanel(view),
    keyboard: buildWillKeyboard(view)
  })
}

/** پیام راهنمای دریافت وارث (ریپلای / نام‌کاربری / شناسهٔ عددی). */
const HEIR_INPUT_LINES = [
  'وارثت را یکی از این سه راه معرفی کن:',
  '• روی پیام خودِ بازیکن ریپلای کن و همین‌جا بنویس «او».',
  '• نام‌کاربری تلگرامش را با علامت @ بفرست.',
  '• یا شناسهٔ عددی تلگرامش را بفرست.',
  '',
  'بعد از آن، صفحهٔ تأیید با خلاصهٔ دارایی‌هایت نشان داده می‌شود.'
]

export function registerWillHandlers(bot: Bot, container: Container): void {
  // ---------- پنل اصلی ----------
  bot.callbackQuery('will:main', async (ctx) => {
    const fromId = BigInt(ctx.from.id)
    await ackCallback(ctx)
    try {
      await showWillPanel(ctx, container, fromId)
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'will',
        action: 'panel',
        fallback: 'پنل وصیت باز نشد.'
      })
    }
  })

  // ---------- قوانین ----------
  bot.callbackQuery('will:rules', async (ctx) => {
    await ackCallback(ctx)
    await editPanel(ctx, {
      text: renderWillRulesPanel(),
      keyboard: buildWillInputCancelKeyboard()
    })
  })

  // ---------- انتخاب/تغییر وارث: ورودی متنی ----------
  bot.callbackQuery('will:set', async (ctx) => {
    const fromId = BigInt(ctx.from.id)
    try {
      // پنل پیش از گرفتن ورودی، وضعیت واقعی را می‌خواند تا شخصیت مرده
      // نتواند وارد جریان شود (وصیت پس از مرگ قفل است).
      const view = await container.willService.getView(fromId)
      if (view.isDead) {
        await ackCallback(ctx, 'این شخصیت از دنیا رفته و وصیتش قفل شده است.', true)
        await showWillPanel(ctx, container, fromId)
        return
      }
      await container.userStateRepository.upsert(fromId, {
        currentContext: 'will_heir',
        stateData: {}
      })
      await ackCallback(ctx)
      await editPanel(ctx, {
        text: panel({
          icon: '👤',
          title: 'انتخاب وارث',
          sections: [{ lines: HEIR_INPUT_LINES }],
          footer: 'وصیت فقط زمانی اجرا می‌شود که شخصیتت از دنیا برود.'
        }),
        keyboard: buildWillInputCancelKeyboard()
      })
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'will',
        action: 'set',
        fallback: 'ورودی انتخاب وارث باز نشد.'
      })
    }
  })

  // ---------- یادداشت وصیت ----------
  bot.callbackQuery('will:note', async (ctx) => {
    const fromId = BigInt(ctx.from.id)
    try {
      const view = await container.willService.getView(fromId)
      if (!view.hasWill) {
        await ackCallback(ctx, 'اول وارثت را انتخاب کن؛ یادداشت بدون وارث معنا ندارد.', true)
        await showWillPanel(ctx, container, fromId)
        return
      }
      await container.userStateRepository.upsert(fromId, {
        currentContext: 'will_note',
        stateData: {}
      })
      await ackCallback(ctx)
      await editPanel(ctx, {
        text: panel({
          icon: '✍️',
          title: 'یادداشت وصیت',
          sections: [
            {
              lines: [
                `یک متن کوتاه برای وارثت بنویس (حداکثر ${fa(view.noteMaxLength)} نویسه).`,
                'این متن هنگام انتقال دارایی‌ها به او نشان داده می‌شود.'
              ]
            }
          ]
        }),
        keyboard: buildWillInputCancelKeyboard()
      })
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'will',
        action: 'note',
        fallback: 'ورودی یادداشت باز نشد.'
      })
    }
  })

  // ---------- لغو وصیت (عملیات حساس، پشتِ تأیید) ----------
  bot.callbackQuery('will:cancel', async (ctx) => {
    const fromId = BigInt(ctx.from.id)
    try {
      const view = await container.willService.getView(fromId)
      if (!view.hasWill) {
        await ackCallback(ctx, 'وصیتی برای لغو کردن نداری.', true)
        await showWillPanel(ctx, container, fromId)
        return
      }
      await ackCallback(ctx)
      await askForConfirmation(ctx, container, {
        kind: 'will_cancel',
        icon: '🗑️',
        title: 'لغو وصیت',
        rows: [{ label: '👤 وارث فعلی', value: `*${view.heirName}*` }],
        lines: [
          'با لغو وصیت، دیگر وارثی تعیین نشده است.',
          'اگر روزی این شخصیت از دنیا برود، دارایی‌ها بی‌صاحب می‌مانند.'
        ],
        confirmLabel: 'بله، وصیت را لغو کن',
        payload: {}
      })
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'will',
        action: 'cancel',
        fallback: 'لغو وصیت انجام نشد.'
      })
    }
  })
}

/**
 * ورودی متنیِ انتخاب وارث.
 *
 * سه مسیر پذیرفته می‌شود و هر سه به «شناسهٔ بازیکن» تبدیل می‌شوند:
 *   • ریپلای روی پیام بازیکن → شناسهٔ تلگرامِ صاحب همان پیام.
 *   • `@username` → جست‌وجوی بدون حساسیت به بزرگی/کوچکی حروف.
 *   • شناسهٔ عددی تلگرام.
 *
 * هیچ شناسه‌ای بدون خواندن از دیتابیس پذیرفته نمی‌شود؛ شناسهٔ نامعتبر یعنی
 * وارثی که لحظهٔ مرگ رد می‌شود و پول را بی‌صاحب می‌گذارد.
 */
export async function handleWillHeirText(ctx: Context, container: Container): Promise<void> {
  const fromId = BigInt(ctx.from!.id)
  const replyFrom = ctx.message?.reply_to_message?.from
  const input =
    replyFrom && !replyFrom.is_bot
      ? ({ kind: 'telegram_id', value: BigInt(replyFrom.id) } as const)
      : parseHeirInput(ctx.message?.text ?? '')

  try {
    const target = await container.willService.resolveTarget(fromId, input)
    const view = await container.willService.getView(fromId)
    await container.userStateRepository.clear(fromId)

    await askForConfirmation(ctx, container, {
      kind: 'will_set',
      icon: '📜',
      title: 'تأیید وصیت',
      rows: [
        { label: '👤 وارث', value: `*${target.name}*` },
        { label: '💰 کیف پول', value: money(view.estate.wallet) },
        {
          label: '💼 دارایی',
          value: `🏠 ${fa(view.estate.properties)}  ·  🏢 ${fa(view.estate.businesses)}`
        },
        ...(view.estate.loanDebt + view.estate.playerLoanDebt > 0
          ? [
              {
                label: '💳 بدهی',
                value: money(view.estate.loanDebt + view.estate.playerLoanDebt)
              }
            ]
          : [])
      ],
      lines: [
        'با تأیید، این بازیکن وارثِ دارایی‌های تو می‌شود.',
        'بدهی‌ها اول از پول نقد تسویه می‌شوند، بعد باقی به او می‌رسد.',
        'تا زنده‌ای می‌توانی وارث را عوض کنی.'
      ],
      payload: { heirId: target.id }
    })
  } catch (err) {
    if (ctx.callbackQuery) {
      await handleCallbackError(ctx, err, {
        feature: 'will',
        action: 'set_heir',
        fallback: 'ثبت وارث انجام نشد.'
      })
      return
    }
    // مسیر پیام متنی: پیام راهنمای انسان‌خوان + دکمهٔ تلاش دوباره
    await container.userStateRepository
      .upsert(fromId, { currentContext: 'will_heir', stateData: {} })
      .catch(() => undefined)
    await sendPanel(ctx, {
      text: panel({
        icon: '⚠️',
        title: 'این وارث پذیرفته نشد',
        sections: [
          { lines: [err instanceof Error ? err.message : 'ورودی قابل استفاده نبود.'] },
          { lines: HEIR_INPUT_LINES }
        ]
      }),
      keyboard: buildWillInputCancelKeyboard()
    })
  }
}

/** ورودی متنیِ یادداشت وصیت. */
export async function handleWillNoteText(ctx: Context, container: Container): Promise<void> {
  const fromId = BigInt(ctx.from!.id)
  try {
    await container.willService.setNote(fromId, ctx.message?.text ?? '')
    await container.userStateRepository.clear(fromId)
    const view = await container.willService.getView(fromId)
    // همان پنل با یادداشتِ تازه؛ پیام تأیید جدا لازم نیست چون خودِ پنل
    // نتیجه را نشان می‌دهد (قاعدهٔ «یک عمل = یک پنل»).
    await sendPanel(ctx, {
      text: renderWillPanel(view),
      keyboard: buildWillKeyboard(view)
    })
  } catch (err) {
    await container.userStateRepository.clear(fromId).catch(() => undefined)
    await handleCallbackError(ctx, err, {
      feature: 'will',
      action: 'note',
      fallback: 'ثبت یادداشت انجام نشد.'
    })
  }
}
