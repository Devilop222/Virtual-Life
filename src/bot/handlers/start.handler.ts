import { Bot, Context } from 'grammy'
import { RegistrationState } from '@prisma/client'
import { Container } from '../../services/container'
import { texts } from '../../utils/classes/texts'
import { InlineKeyboard } from 'grammy'
import { menu } from '../../utils/classes/texts'
import {
  buildRegistrationCancelKeyboard,
  buildClosePanelKeyboard,
} from '../keyboards/main.keyboard'
import { HELP_MAIN_TEXT } from '../help-content'
import { helpMainKeyboardFor } from '../help-entry'
import { config } from '../../config/env'
import { isCancelWord, normalizePersianText, validateGenderArg } from '../../utils/commands'
import { getStartingAge } from '../../modules/identity/player.service'
import type { RebirthAccess } from '../../modules/inheritance/rebirth.service'
import { handleGroupContext, renderGroupInfoPanel, renderGroupNotSetupPanel } from './group.handler'
import { sendPanel, editPanel, ackCallback } from '../panel'
import { handleCallbackError } from '../handler-errors'
import { panel } from '../ui-kit'
import { GAME_TIME_INTRO_LINES } from '../../utils/game-time'
import { logger } from '../../utils/logger'
import { openStartGuide, registerStartGuideCallbacks } from '../start-guide'
import { handleAdminHelpCommand } from './admin.handler'
import { renderRebirthPanel } from '../renders'
import { PlayerStatus } from '@prisma/client'

/** کیبورد انتخاب جنسیت با دکمه‌های رنگی رسمی تلگرام. */
function buildGenderStyledKeyboard() {
  return new InlineKeyboard()
    .add({ text: menu.genderMale, callback_data: 'reg:gender:MALE', style: 'primary' })
    .add({ text: menu.genderFemale, callback_data: 'reg:gender:FEMALE', style: 'primary' })
    .row()
    .add({ text: menu.cancel, callback_data: 'reg:cancel', style: 'danger' })
}

/**
 * کیبورد لحظهٔ تولد شخصیت: سه قدم اول، بدون گشتن در منوها.
 *
 * چرا لازم است؟ پیش‌تر این کیبورد فقط «راهنمای شروع / شناسنامه / راهنما» بود
 * و بازیکن بعد از ثبت‌نام نمی‌دانست *اولین کار واقعی* چیست. حالا دکمه‌های زیر
 * از همان لحظه، سه کار اول را با یک کلیک در دسترس می‌گذارند: دیدنِ خود،
 * کارت روزانه (اولین پاداش نقدی) و راهنمای گام‌به‌گام.
 *
 * فقط بخش‌هایی انتخاب شده‌اند که در چت خصوصی هم باز می‌شوند
 * (`سياست BOTH` در command-catalog) — وگرنه بازیکن تازه‌وارد به پیام
 * «این بخش در گروه باز می‌شود» می‌خورد که برای اولین تجربه بد است.
 */
function buildWelcomeKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .add({ text: '🪪 شناسنامهٔ من', callback_data: 'id:main', style: 'primary' })
    .text('🎯 کارت روزانه', 'quest:main')
    .row()
    .text('📊 وضعیت زندگی', 'stats:main')
    .text('🚀 راهنمای شروع', 'guide:page:0')
    .row()
    .text('❓ راهنما', 'help:main')
    .add({ text: 'بستن', callback_data: 'panel:close', style: 'danger' })
}

function profileFrom(ctx: Context) {
  const from = ctx.from
  if (!from) {
    return null
  }

  return {
    telegramUserId: BigInt(from.id),
    firstName: from.first_name,
    lastName: from.last_name ?? null,
    username: from.username ?? null
  }
}

/**
 * استخراج کد معرف از پارامتر /start.
 *
 * تلگرام لینک `?start=REFXXXX` را به‌صورت `/start REFXXXX` تحویل می‌دهد.
 * هر ورودی دیگری نادیده گرفته می‌شود تا کاربر با پیام خطا مواجه نشود.
 */
function referralCodeFrom(ctx: Context): string | undefined {
  const payload = ctx.match
  const raw = typeof payload === 'string' ? payload.trim() : ''
  if (!raw.toUpperCase().startsWith('REF')) {
    return undefined
  }
  const code = raw.slice(3).toUpperCase()
  return /^[A-Z0-9]{4,16}$/.test(code) ? code : undefined
}

/**
 * پنل «زندگی تازه» — متن و کیبورد، بر اساس وضعیت واقعی حساب.
 *
 * یک سازنده برای هر دو مسیر (`/start` و دکمهٔ «بررسی دوباره») تا متن پنل
 * هیچ‌وقت با منطق تصمیم‌گیری واگرا نشود.
 */
export async function rebirthPanelPayload(
  container: Container,
  playerId: string,
  access: RebirthAccess = {}
): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const readiness = await container.rebirthService.readiness(playerId, access)
  const text = renderRebirthPanel({
    eligible: readiness.eligible,
    reason: readiness.reason,
    nextLifeNumber: readiness.nextLifeNumber,
    residualEstate: readiness.residualEstate,
    regionTitle: null
  })
  const keyboard = new InlineKeyboard()
  // رنگِ رسمی تلگرام (Bot API 9): «شروع» کنشِ اصلی و برگشت‌ناپذیر است،
  // «بررسی دوباره» فقط تازه‌سازی و «بستن» بیرون‌رفتن. هر سه یک‌رنگ
  // نبودن‌اند تا چشم بداند کدام را باید انتخاب کند.
  if (readiness.eligible) {
    keyboard.add({ text: '🌱 شروع زندگی تازه', callback_data: 'rebirth:start', style: 'success' })
  } else {
    keyboard.text('🔄 بررسی دوباره', 'rebirth:panel')
  }
  keyboard.row().add({ text: 'بستن', callback_data: 'panel:close', style: 'danger' })
  return { text, keyboard }
}

/**
 * دسترسیِ «زندگی تازه» برای یک کاربر.
 *
 * تنها جایی که پرچمِ مدیر از آن می‌آید: جدولِ مدیرانِ ربات. هیچ متن یا
 * کالک‌بکی این را پر نمی‌کند، و اگر خواندنِ جدول خطا بدهد نتیجه «مدیر نیست»
 * است (سمتِ ایمن).
 */
async function rebirthAccess(container: Container, telegramUserId: bigint): Promise<RebirthAccess> {
  const adminOverride = await container.adminService
    .isAdmin(telegramUserId)
    .catch(() => false)
  return { adminOverride }
}

export function registerStartHandler(bot: Bot, container: Container): void {
  registerStartGuideCallbacks(bot, container)

  // ── زندگی تازه ──
  bot.callbackQuery(['rebirth:panel', 'rebirth:start'], async (ctx) => {
    const data = ctx.callbackQuery?.data ?? ''
    const player = await container.playerRepository.findByTelegramUserId(BigInt(ctx.from.id))
    if (!player) {
      await ackCallback(ctx, 'حساب پیدا نشد.', true)
      return
    }

    const access = await rebirthAccess(container, BigInt(ctx.from.id))

    if (data === 'rebirth:panel') {
      await ackCallback(ctx)
      await editPanel(ctx, await rebirthPanelPayload(container, player.id, access))
      return
    }

    // `rebirth:start` — دروازهٔ برگشت‌ناپذیر. عمدا دوباره سنجيده می‌شود، چون
    // ممکن است از لحظهٔ رندرِ پنل، پروندهٔ میراث جلو رفته باشد.
    const readiness = await container.rebirthService.readiness(player.id, access)
    if (!readiness.eligible) {
      await ackCallback(ctx, readiness.reason ?? 'زندگی تازه هنوز ممکن نیست.', true)
      return
    }
    await container.registrationService.beginRebirth(BigInt(ctx.from.id), player.id)
    await ackCallback(ctx, 'بزن بریم')
    await editPanel(ctx, { text: texts.chooseGender, keyboard: buildGenderStyledKeyboard() })
  })

  bot.command('admin_help', async (ctx) => {
    await handleAdminHelpCommand(ctx, container)
  })

  bot.command('start', async (ctx) => {
    const chatType = ctx.chat?.type

    if (chatType === 'private') {
      await handlePrivateStart(ctx, container)
      return
    }

    if (chatType === 'group' || chatType === 'supergroup') {
      // راه‌اندازی محیط فقط با فرمان مدیر گروه انجام می‌شود؛ /start کاربر عادی
      // یا گروه را فعال می‌کند (اگر مدیر باشد) یا وضعیت واقعی را می‌گوید.
      const senderId = ctx.from?.id === undefined ? undefined : BigInt(ctx.from.id)
      const result = await handleGroupContext(ctx, container, { setupByUserId: senderId })

      if (!result.registered) {
        await sendPanel(ctx, {
          text: renderGroupNotSetupPanel(result.syncFailed),
          keyboard: buildClosePanelKeyboard()
        })
        return
      }

      // گروه از قبل ثبت بوده؟ همان اطلاعات واقعی دیتابیس نشان داده می‌شود،
      // نه پیامی که هر بار وانمود کند گروه تازه ثبت شده است.
      await sendPanel(ctx, {
        text: renderGroupInfoPanel(result),
        keyboard: new InlineKeyboard()
          .text('🚀 راهنمای شروع', 'guide:page:0')
          .text('راهنمای گروه', 'help:topic:group')
          .row()
          .add({ text: 'بستن', callback_data: 'panel:close', style: 'danger' })
      })
    }
  })

  bot.callbackQuery(/^reg:gender:/, async (ctx) => {
    const data = (ctx.callbackQuery?.data ?? '').split(':')
    const gender = validateGenderArg(data[2] ?? '')

    if (!gender) {
      await ackCallback(ctx, 'ورودی نامعتبر است.', true)
      return
    }

    const profile = profileFrom(ctx)
    if (!profile) {
      await ackCallback(ctx)
      return
    }

    try {
      await container.registrationService.selectGender(profile.telegramUserId, gender)
      await ackCallback(ctx, 'جنسیت ثبت شد')
      await editPanel(ctx, {
        text: texts.chooseBiography,
        keyboard: buildRegistrationCancelKeyboard()
      })
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'registration',
        action: 'select_gender',
        fallback: 'ثبت‌نام فعال نیست. دستور /start را بفرست.'
      })
    }
  })

  bot.callbackQuery('reg:cancel', async (ctx) => {
    const profile = profileFrom(ctx)
    if (!profile) {
      await ackCallback(ctx)
      return
    }
    await container.registrationService.cancel(profile.telegramUserId)
    await ackCallback(ctx, 'ثبت‌نام لغو شد')
    await editPanel(ctx, {
      text: texts.registrationCancelled,
      keyboard: buildClosePanelKeyboard()
    })
  })
}

async function handlePrivateStart(ctx: Context, container: Container): Promise<void> {
  const profile = profileFrom(ctx)
  if (!profile) {
    return
  }

  const referralCode = referralCodeFrom(ctx)
  const outcome = await container.registrationService.start(profile, referralCode)

  if (!outcome.started) {
    // شخصیتِ فوت‌شده راهنمای شروع نمی‌خواهد؛ او باید بتواند زندگیِ تازه‌ای
    // آغاز کند. پیش از این /start برای او هم فقط راهنما را باز می‌کرد و
    // عملاً حسابش برای همیشه قفل می‌ماند (چون ثبت‌نامِ دوباره ممکن نیست).
    // `playerRepository` در مسیرهای سبک/تستی ممکن است تعریف نشده باشد؛
    // آن‌وقت رفتار قبلی (بازشدن راهنما) حفظ می‌شود.
    const existing = await container.playerRepository
      ?.findByTelegramUserId(profile.telegramUserId)
      .catch(() => null)
    if (existing?.status === PlayerStatus.DEAD) {
      await sendPanel(
        ctx,
        await rebirthPanelPayload(container, existing.id, await rebirthAccess(container, profile.telegramUserId))
      )
      return
    }

    // ورود دوباره ثبت‌نام نمی‌سازد؛ به‌جای «شخصیتت را بساز»، راهنمای شروع
    // چندصفحه‌ای باز می‌شود: نقشهٔ مسیر برای بازیکنی که شخصیت دارد.
    await openStartGuide(ctx, 0, 'send')
    return
  }

  if (outcome.step === RegistrationState.AWAITING_BIOGRAPHY) {
    await sendPanel(ctx, { text: texts.chooseBiography, keyboard: buildRegistrationCancelKeyboard() })
    return
  }
  await sendPanel(ctx, { text: texts.welcomeNew, keyboard: buildGenderStyledKeyboard() })
}

export async function handleRegistrationText(
  ctx: Context,
  container: Container,
  text: string
): Promise<boolean> {
  if (ctx.chat?.type !== 'private') {
    await sendPanel(ctx, { text: 'ثبت‌نام در چت خصوصی ربات ادامه پیدا می‌کند. آنجا /start را بفرست.' })
    return true
  }
  const profile = profileFrom(ctx)
  if (!profile) {
    return false
  }

  // واژه‌های لغوی مشترک همهٔ جریان‌ها («انصراف»، «لغو»، «بستن»، «بیخیال»)
  if (isCancelWord(text)) {
    await container.registrationService.cancel(profile.telegramUserId)
    await sendPanel(ctx, { text: texts.registrationCancelled })
    return true
  }

  const step = await container.registrationService.currentStep(profile.telegramUserId)
  if (step === null || step === RegistrationState.COMPLETED) {
    return false
  }

  // راهنما همیشه کار می‌کند؛ حتی وسط ثبت‌نام. بدون این استثنا، بازیکنِ
  // سردرگمی که «راهنما» می‌نوشت صاحب بیوگرافی «راهنما» می‌شد!
  const normalized = normalizePersianText(text)
  if (normalized === 'راهنما' || normalized === 'کمک') {
    await sendPanel(ctx, {
      text: HELP_MAIN_TEXT,
      keyboard: await helpMainKeyboardFor(container, BigInt(ctx.from!.id))
    })
    return true
  }

  if (step !== RegistrationState.AWAITING_BIOGRAPHY) {
    await sendPanel(ctx, { text: texts.chooseGender, keyboard: buildGenderStyledKeyboard() })
    return true
  }

  // ── مسیر «زندگی تازه» ──
  // همان مراحلِ جنسیت و معرفی، ولی پایانش ساختنِ شخصیت تازه نیست؛ ردیفِ
  // موجود به زندگیِ بعدی می‌رود. پیش از این گارد، `submitBiography` یک ردیفِ
  // دوم نمی‌ساخت (upsert بود) و بازیکن در حالتِ مرده قفل می‌ماند.
  const rebirthTarget = await container.registrationService.currentRebirthTarget(
    profile.telegramUserId
  )
  if (rebirthTarget) {
    const gender = await container.registrationService.storedGender(profile.telegramUserId)
    const result = await container.rebirthService.startNewLife(
      rebirthTarget,
      {
        gender,
        biography: text
      },
      await rebirthAccess(container, profile.telegramUserId)
    )
    await container.registrationService.cancel(profile.telegramUserId)
    // پاک‌سازی پیوندهای زندگی گذشته جدا و بی‌خطر است: خطایش هرگز نباید
    // شروع زندگی تازه را خنثی کند.
    await container.rebirthService.cleanupPreviousLife(rebirthTarget)

    await sendPanel(ctx, {
      text: panel({
        icon: '🌱',
        title: `زندگی تازه — شمارهٔ ${result.lifeNumber.toLocaleString('fa-IR')}`,
        sections: [
          {
            lines: [
              'چشم باز می‌کنی و دنیا همان‌جاست که بود، اما تو شخصیت تازه‌ای هستی.',
              'قوانین زندگی را از "راهنمای شروع" یک بار مرور کن.',
              ...(result.estateToRegion > 0
                ? [
                    `دارایی بی‌وارثِ باقی‌مانده به صندوق منطقه‌ات رسید (${result.estateToRegion.toLocaleString('fa-IR')} تومان).`
                  ]
                : [])
            ]
          }
        ],
        footer: 'سابقهٔ مالی و پرونده‌های گذشته محفوظ‌اند.'
      }),
      keyboard: buildWelcomeKeyboard()
    })
    await sendPanel(ctx, {
      text: panel({
        icon: '⏳',
        title: 'ساعت دنیای میراث',
        sections: [{ lines: [...GAME_TIME_INTRO_LINES] }],
        footer: 'ساعت دقیق بازی همیشه در «وضعیت من» و «شناسنامه» دیده می‌شود.'
      })
    })
    return true
  }

  const outcome = await container.registrationService.submitBiography(
    profile,
    text,
    getStartingAge()
  )

  if (!outcome.player) {
    return true
  }

  // پاداش معرفی: هرگز نباید مسیر ثبت‌نام را بشکند
  let referralRewarded = false
  if (outcome.referralCode) {
    referralRewarded = await settleReferral(
      container,
      outcome.player.id,
      profile.telegramUserId,
      outcome.referralCode
    )
  }

  await sendPanel(ctx, {
    text: texts.registrationComplete,
    keyboard: buildWelcomeKeyboard()
  })

  // آموزش کوتاه ساعت دنیا برای بازیکن تازه — دقیقاً بعد از ساخت شخصیت.
  // متن کاملاً برای بازیکن نوشته شده و هیچ اصطلاح داخلی/فنی در آن نیست.
  await sendPanel(ctx, {
    text: panel({
      icon: '⏳',
      title: 'ساعت دنیای میراث',
      sections: [{ lines: [...GAME_TIME_INTRO_LINES] }],
      footer: 'ساعت دقیق بازی همیشه در «وضعیت من» و «شناسنامه» دیده می‌شود.'
    })
  })

  // لحظهٔ تولد شخصیت: اگر استیکر مراسم تنظیم شده باشد، یک قاب جشن؛
  // خطای آن هرگز نباید مسیر ثبت‌نام را بشکند.
  if (config.MILESTONE_STICKER_FILE_ID) {
    await ctx.replyWithSticker(config.MILESTONE_STICKER_FILE_ID).catch(() => undefined)
  }

  if (referralRewarded) {
    await sendPanel(ctx, {
      text: panel({
        icon: '🎁',
        title: 'هدیهٔ پیوستن با معرفی',
        sections: [{ lines: ['۱۵۰٬۰۰۰ تومان به کیف پولت اضافه شد.'] }],
        footer: '💡 معرف تو هم پاداش گرفت.'
      })
    })
  }

  return true
}

/** اتصال معرفی و تسویهٔ پاداش مرحلهٔ اول. خطا هرگز به بازیکن نشان داده نمی‌شود. */
async function settleReferral(
  container: Container,
  refereePlayerId: string,
  refereeTelegramUserId: bigint,
  referralCode: string
): Promise<boolean> {
  try {
    const linked = await container.rewardsService.linkReferral(refereePlayerId, referralCode)
    if (!linked) {
      return false
    }
    const result = await container.rewardsService.settleReferralSignup(refereeTelegramUserId)
    return result.referrerRewarded
  } catch (error) {
    logger.warn(
      { err: error, feature: 'referral', action: 'settle_signup' },
      'referral settlement failed'
    )
    return false
  }
}
