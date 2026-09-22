import type { Bot, Context } from 'grammy'
import type { Prisma } from '@prisma/client'
import type { Container } from '../services/container'
import { panel } from './ui-kit'
import { ackCallback, editPanel } from './panel'
import { handleCallbackError } from './handler-errors'
import { actorStanding, blockedActorPanel, denyBlockedActor } from './chat-policy'
import { InlineKeyboard } from 'grammy'

/**
 * لایهٔ واحدِ «تأیید دومرحله‌ای» برای عملیاتِ حساس و برگشت‌ناپذیر.
 *
 * چرا یک لایهٔ مشترک و نه یک دکمهٔ «بله» در هر handler؟
 *  • یک قرارداد: انتخاب → صفحهٔ تأیید → تأیید/انصراف → اجرا.
 *  • Replay-safe بودن در یک جا اثبات می‌شود: توکنِ تأیید **تک‌مصرف** است و با
 *    compare-and-delete مصرف می‌شود، پس دوبارزدن یا کلیکِ کهنه عملیات را
 *    تکرار نمی‌کند.
 *  • انصراف واقعاً لغو می‌کند (state پاک می‌شود) و به بازیکن گفته می‌شود.
 *  • payload سمت سرور بسته می‌شود؛ `callback_data` فقط نوع و توکن را حمل
 *    می‌کند، پس بازیکن نمی‌تواند مبلغ یا شناسه را دستکاری کند.
 */
export interface ConfirmableAction {
  /** شناسهٔ کوتاه و ثابتِ عملیات؛ در callback_data می‌نشیند. */
  kind: string
  /** اجرای واقعی عملیات + نمایش نتیجه روی همان پنل. */
  run(ctx: Context, container: Container, payload: Prisma.JsonObject): Promise<void>
}

export interface ConfirmationSpec {
  kind: string
  icon: string
  title: string
  rows?: Array<{ label: string; value: string }>
  lines?: string[]
  footer?: string
  confirmLabel?: string
  payload: Prisma.InputJsonObject
}

const REGISTRY = new Map<string, ConfirmableAction>()

/** ثبت یک عملیات تأییدشدنی. در `bot.ts` یک‌بار صدا زده می‌شود. */
export function registerConfirmableAction(action: ConfirmableAction): void {
  REGISTRY.set(action.kind, action)
}

/** آیا این نوع ثبت شده است؟ (برای آزمون) */
export function hasConfirmableAction(kind: string): boolean {
  return REGISTRY.has(kind)
}

/** کیبورد تأیید: هیچ دادهٔ حساسی در دکمه‌ها نیست. */
export function buildConfirmationKeyboard(kind: string, token: string): InlineKeyboard {
  return new InlineKeyboard()
    .add({ text: '✅ تأیید', callback_data: `act:go:${kind}:${token}`, style: 'success' })
    .text('انصراف', `act:no:${kind}`)
}

/**
 * نمایش صفحهٔ تأیید. هیچ عملیاتی در این مرحله اجرا نمی‌شود.
 */
export async function askForConfirmation(
  ctx: Context,
  container: Container,
  spec: ConfirmationSpec
): Promise<void> {
  const token = await container.userStateRepository.issueScopedConfirmation(
    BigInt(ctx.from!.id),
    ctx.chat!.id,
    'act',
    { kind: spec.kind, payload: spec.payload }
  )

  await editPanel(ctx, {
    text: panel({
      icon: spec.icon,
      title: spec.title,
      sections: [
        ...(spec.rows && spec.rows.length > 0 ? [{ rows: spec.rows }] : []),
        ...(spec.lines && spec.lines.length > 0 ? [{ lines: spec.lines }] : [])
      ],
      footer: spec.footer
    }),
    keyboard: buildConfirmationKeyboard(spec.kind, token)
  })
}

/** پیام «این تأیید دیگر فعال نیست» — برای کلیک کهنه یا دوبارزدن. */
function staleConfirmationText(): string {
  return panel({
    icon: '⏳',
    title: 'این تأیید دیگر فعال نیست',
    sections: [
      {
        lines: [
          'هر صفحهٔ تأیید فقط یک بار مصرف می‌شود تا عملیاتی دوباره اجرا نشود.',
          'اگر لازم است، همان گزینه را دوباره از پنل انتخاب کن.'
        ]
      }
    ]
  })
}

/** ثبت هندلرهای تأیید روی ربات. */
export function registerConfirmationHandlers(bot: Bot, container: Container): void {
  bot.callbackQuery(/^act:go:[a-z_]+:[a-f0-9-]{36}$/, async (ctx) => {
    const [, , kind, token] = ctx.callbackQuery.data.split(':')
    const fromId = BigInt(ctx.from.id)

    const action = REGISTRY.get(kind!)
    if (!action) {
      await ackCallback(ctx, 'این عملیات شناخته‌شده نیست؛ پنل را تازه کن.', true)
      return
    }

    // ── نگهبانِ وضعیتِ کنشگر ──
    // این دکمه‌ها هیچ بخشی ندارند، پس میان‌افزارِ سیاستِ محیط از آن‌ها
    // نمی‌گذرد و پیش‌تر هیچ‌کس وضعیتِ بازیکن را نمی‌سنجید. نتیجه یک حفرهٔ
    // واقعی بود: کسی که پس از دیدنِ صفحهٔ تأیید می‌مرد یا مسدود می‌شد،
    // توکنِ باقی‌مانده را می‌زد و پول خرج می‌شد یا مالکیت عوض می‌شد.
    //
    // ترتیب مهم است: پیش از مصرفِ توکن سنجیده می‌شود تا در همان لحظه هم
    // معلوم باشد، ولی با بلاک‌شدن، توکن **پاک** می‌شود. اگر پاک نشود،
    // زندگیِ تازهٔ همان حساب می‌تواند تأییدِ زندگیِ قبلی را اجرا کند —
    // یعنی یک عملیاتِ متعلق به شخصیتِ مرده به نامِ شخصیتِ زنده.
    const standing = await actorStanding(container, fromId)
    if (standing !== 'active') {
      await container.userStateRepository.clear(fromId)
      await denyBlockedActor(ctx, standing)
      await editPanel(ctx, {
        text: blockedActorPanel(standing),
        keyboard: new InlineKeyboard().text('بستن', 'panel:close')
      })
      return
    }

    // ادعای اتمیکِ تک‌مصرف پیش از هر نوشتاری
    const stored = await container.userStateRepository.consumeScopedConfirmation(
      fromId,
      ctx.chat!.id,
      'act',
      token!
    )
    if (!stored) {
      await ackCallback(ctx, 'این تأیید پیش‌تر استفاده شده یا منقضی شده است.', true)
      await editPanel(ctx, {
        text: staleConfirmationText(),
        keyboard: new InlineKeyboard().text('بستن', 'panel:close')
      })
      return
    }

    const payload = (stored.payload ?? {}) as Prisma.JsonObject
    try {
      await action.run(ctx, container, payload)
    } catch (error) {
      // خطا را به مسیر مشترک خطای هندلر می‌سپاریم تا پیام انسانی بدهد؛
      // چون state پیش‌تر مصرف شده، تکرارِ ناخواسته ممکن نیست.
      await handleCallbackError(ctx, error, {
        feature: kind!,
        action: 'confirm',
        fallback: 'این عملیات انجام نشد.'
      })
    }
  })

  bot.callbackQuery(/^act:no:[a-z_]+$/, async (ctx) => {
    await container.userStateRepository.clear(BigInt(ctx.from.id))
    await ackCallback(ctx, 'لغو شد')
    await editPanel(ctx, {
      text: panel({
        icon: '✖️',
        title: 'لغو شد',
        sections: [{ lines: ['هیچ تغییری ثبت نشد.'] }]
      }),
      keyboard: new InlineKeyboard().text('بستن', 'panel:close')
    })
  })
}
