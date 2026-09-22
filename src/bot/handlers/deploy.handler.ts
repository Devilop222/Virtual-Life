/**
 * پنلِ به‌روزرسانیِ سرور — بخشی از مرکز کنترلِ مالک (`/botupdate`) که در
 * `ops.handler` ثبت می‌شود و از همان‌جا باز می‌شود.
 *
 * ## مرزِ دسترسی
 * این تنها مسیری است که از یک پیامِ تلگرام به فرآیندِ shell روی سرور می‌رسد.
 * پس دسترسی **دو** لایه دارد و هر دو سرور-ساید است:
 *
 *   ۱. `adminService.isOwner` — فقط مالکِ واقعیِ ربات؛ نه ادمین، نه مالک گروه،
 *      نه هیچ‌کس دیگری. شناسه از `ctx.from.id` می‌آید که تلگرام امضا کرده است،
 *      پس قابل جعل نیست.
 *   ۲. `deployService.availability()` — اگر سرور بستهٔ رسمیِ استقرار را نداشته
 *      باشد (مثلاً محیط توسعه)، حتی مالک هم به هیچ فرآیندی دست نمی‌یابد.
 *
 * ## چرا دکمهٔ تأیید؟
 * به‌روزرسانی ربات را ری‌استارت می‌کند و برگشت‌پذیر نیست. یک لمسِ سهوی روی
 * فرمانی که متنش شبیه بقیهٔ فرمان‌هاست، پذیرفتنی نبود؛ پس پیش از اجرا یک
 * صفحهٔ تأیید کوتاه با نامِ نسخهٔ فعلی نشان داده می‌شود.
 *
 * ## چرا «موفق» گفته نمی‌شود؟
 * درخواست فقط فرآیند را **شروع** می‌کند و ربات چند لحظه بعد خاموش می‌شود. پس
 * پیام صریح می‌گوید که نتیجه پس از بالا آمدن دوباره معلوم می‌شود وگرنه کاربر
 * منتظر پاسخِ زندهٔ رباتی می‌ماند که دیگر آن‌جا نیست.
 */
import { Bot, Context, InlineKeyboard } from 'grammy'
import { Container } from '../../services/container'
import { editPanel, ackCallback } from '../panel'
import { handleCallbackError } from '../handler-errors'
import { requireOwner, isPrivateChat } from '../owner-guard'
import { momentFa } from '../ui-kit'

/** متنِ صفحهٔ اصلیِ پنلِ به‌روزرسانی. */
function renderDeployPanel(container: Container): string {
  const status = container.deployService.status()
  const lines = ['🚀 *به‌روزرسانی سرور*', '']

  if (!status.available) {
    lines.push(status.unavailableReason ?? 'این قابلیت روی این سرور در دسترس نیست.')
    lines.push('')
    lines.push('_این فرمان فقط روی سرورِ بازی کار می‌کند._')
    return lines.join('\n')
  }

  if (status.phase === 'running') {
    lines.push('⏳ یک به‌روزرسانی همین حالا در جریان است.')
    if (status.targetCommit) {
      lines.push(`نسخهٔ در حال استقرار: \`${status.targetCommit}\``)
    }
  } else if (status.phase === 'success') {
    lines.push('✅ آخرین به‌روزرسانی موفق بود.')
    if (status.finishedAt) {
      lines.push(`زمان: ${momentFa(status.finishedAt)}`)
    }
  } else if (status.phase === 'failed') {
    lines.push('⚠️ آخرین به‌روزرسانی کامل نشد.')
    if (status.message) {
      lines.push(status.message)
    }
  } else {
    const head = status.targetCommit ?? 'نامعلوم'
    lines.push(`نسخهٔ فعلی سرور: \`${head}\``)
  }

  lines.push('')
  lines.push('با زدن دکمه، سرور با آخرین نسخهٔ منتشرشده هماهنگ می‌شود. ربات')
  lines.push('چند لحظه قطع و دوباره روشن خواهد شد.')
  return lines.join('\n')
}

function buildDeployKeyboard(container: Container): InlineKeyboard {
  const status = container.deployService.status()
  const keyboard = new InlineKeyboard()

  if (!status.available) {
    keyboard.add({ text: 'بستن', callback_data: 'panel:close', style: 'danger' })
    return keyboard
  }

  if (status.phase === 'running') {
    // در حین اجرا هیچ کنشِ جدیدی مجاز نیست — فقط تازه‌سازی و بیرون‌رفتن.
    keyboard.text('🔄 بررسی وضعیت', 'deploy:panel').row()
    keyboard.add({ text: '⬅️ بازگشت', callback_data: 'op:panel', style: 'primary' }).row()
    return keyboard
  }

  keyboard
    .add({ text: '🚀 به‌روزرسانی', callback_data: 'deploy:confirm', style: 'primary' })
    .text('🔄 بررسی وضعیت', 'deploy:panel')
    .row()
    .add({ text: '⬅️ بازگشت', callback_data: 'op:panel', style: 'primary' })
  return keyboard
}

/** صفحهٔ تأیید — نامِ نسخهٔ فعلی پیش از کنشِ برگشت‌ناپذیر نشان داده می‌شود. */
function renderDeployConfirm(container: Container): string {
  const status = container.deployService.status()
  return [
    '🚀 *به‌روزرسانی سرور*',
    '',
    `نسخهٔ فعلی: \`${status.targetCommit ?? 'نامعلوم'}\``,
    `وضعیت: ${status.remoteReachable === false ? '📴 سرور الان به اینترنت دسترسی ندارد' : '🌐 آمادهٔ بررسی نسخهٔ تازه'}`,
    '',
    '⚠️ ربات چند لحظه قطع می‌شود.',
    '',
    'ادامه می‌دهی؟'
  ].join('\n')
}

function buildDeployConfirmKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .add({ text: '✅ شروع به‌روزرسانی', callback_data: 'deploy:run', style: 'success' })
    .row()
    .add({ text: 'انصراف', callback_data: 'deploy:panel', style: 'danger' })
}

async function openDeployPanel(ctx: Context, container: Container): Promise<void> {
  await editPanel(ctx, {
    text: renderDeployPanel(container),
    keyboard: buildDeployKeyboard(container)
  })
}

/**
 * مالکِ واقعی **و** چت خصوصی، در هر گام دوباره.
 *
 * چت خصوصی شرطِ واقعی است، نه آرایش: پنلی که سرور را خاموش می‌کند جایش در
 * گروه نیست، حتی اگر فرستنده مالک باشد — در گروه پیام‌ها دیده می‌شوند و
 * دکمه‌ها ممکن است توسط دیگری لمس شوند.
 */
async function gateDeploy(ctx: Context, container: Container) {
  if (!isPrivateChat(ctx)) {
    await ackCallback(ctx, 'این بخش فقط در چت خصوصی کار می‌کند.', true)
    return { ok: false } as const
  }
  return requireOwner(ctx, container)
}

/** ثبتِ callbackهای استقرار. */
export function registerDeployHandlers(bot: Bot, container: Container): void {
  bot.callbackQuery('deploy:panel', async (ctx) => {
    try {
      const gate = await gateDeploy(ctx, container)
      if (!gate.ok) {
        return
      }
      await ackCallback(ctx)
      await openDeployPanel(ctx, container)
    } catch (error) {
      await handleCallbackError(ctx, error, {
        feature: 'deploy',
        action: 'refresh',
        fallback: 'بررسی وضعیت ممکن نشد.'
      })
    }
  })

  bot.callbackQuery('deploy:confirm', async (ctx) => {
    try {
      const gate = await gateDeploy(ctx, container)
      if (!gate.ok) {
        return
      }
      const status = container.deployService.status()
      if (!status.available) {
        await ackCallback(ctx, status.unavailableReason ?? 'ممکن نیست.', true)
        return
      }
      await ackCallback(ctx)
      await editPanel(ctx, {
        text: renderDeployConfirm(container),
        keyboard: buildDeployConfirmKeyboard()
      })
    } catch (error) {
      await handleCallbackError(ctx, error, {
        feature: 'deploy',
        action: 'confirm',
        fallback: 'این مرحله ممکن نشد.'
      })
    }
  })

  bot.callbackQuery('deploy:run', async (ctx) => {
    try {
      // دسترسی **دوباره** سنجیده می‌شود: بین دیدنِ صفحهٔ تأیید و زدنِ دکمه
      // ممکن است نقش‌ها عوض شده باشد. یک بار سنجیدن کافی نیست.
      const gate = await gateDeploy(ctx, container)
      if (!gate.ok) {
        return
      }
      // بررسیِ نسخه و هماهنگی با مخزن چند لحظه طول می‌کشد؛ همان لحظه به
      // کاربر گفته می‌شود تا فکر نکند دکمه کار نکرده است.
      await ackCallback(ctx, 'در حال بررسی نسخهٔ تازه…')

      const result = await container.deployService.requestUpdate(gate.id)
      const keyboard = new InlineKeyboard().add({
        text: 'بستن',
        callback_data: 'panel:close',
        style: 'danger'
      })

      if (!result.started) {
        if (result.upToDate) {
          await ackCallback(ctx, 'سرور از قبل به‌روز بود', true)
          await openDeployPanel(ctx, container)
          return
        }
        await ackCallback(ctx, result.reason ?? 'شروع نشد.', true)
        await openDeployPanel(ctx, container)
        return
      }

      await ackCallback(ctx, 'به‌روزرسانی آغاز شد')
      await editPanel(ctx, {
        text: [
          '🚀 *به‌روزرسانی آغاز شد*',
          '',
          'سرور در حال دریافت و آماده‌سازی نسخهٔ تازه است. ربات چند لحظه',
          'قطعی خواهد داشت و بعد خودش برمی‌گردد.',
          '',
          'وقتی برگشت، اگر همه‌چیز درست پیش رفته باشد، همین‌جا پیام موفقیت',
          'می‌بینی. اگر ربات بالا نیامد، لاگ سرور را ببین.'
        ].join('\n'),
        keyboard
      })
    } catch (error) {
      await handleCallbackError(ctx, error, {
        feature: 'deploy',
        action: 'run',
        fallback: 'شروع به‌روزرسانی ممکن نشد.'
      })
    }
  })
}
