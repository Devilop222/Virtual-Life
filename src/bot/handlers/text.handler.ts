import { Bot, Context } from 'grammy'
import type { InlineKeyboard } from 'grammy'
import { Container } from '../../services/container'
import {
  isCancelWord,
  parseTransferCommand,
  TRANSFER_EXAMPLE,
  BANK_TRANSFER_EXAMPLE,
  type TransferCommand,
  normalizePersianText,
  parseAmountDetailed,
  parseAmountInput
} from '../../utils/commands'
import { describeMahr, mahrRuleLines, parseMahrInput } from '../../modules/family/mahr'
import { helpMainKeyboardFor, isNewcomer } from '../help-entry'
import {
  MAX_CONTRACT_GAME_HOURS_PER_MONTH,
  MIN_CONTRACT_GAME_HOURS_PER_MONTH,
  monthlySalaryFor,
  salaryFromGameHourInput
} from '../../modules/occupation/payroll-math'
import { POST_SALARY_MAX, POST_SALARY_MIN } from '../../modules/occupation/business.service'
import { GIFT_MAX, GIFT_MIN } from '../../modules/family/family-warmth'
import {
  historyFilterLabel,
  historyFilterTypes,
  isHistoryFilterKey
} from '../../modules/events/history-filters'
import { handleRegistrationText, rebirthPanelPayload } from './start.handler'
import { handleGroupContext, renderGroupInfoPanel } from './group.handler'
import { adminPhraseOf, handleAdminInputText, handleAdminPhrase } from './admin.handler'
import {
  handleMarketSellText,
  handleDepositAmountText,
  handleRentalPriceText,
  handleProjectDonationAmountText,
  showStreakPanel,
  showLotteryPanel,
  showInvitePanel,
  showMarketPanel
} from './expansion.handler'
import {
  actorStanding,
  bannedNotice,
  blockedActorPanel,
  checkSectionEntry,
  deadNotice,
  groupOnlyNotice,
  isSectionAllowedHere,
  notSetupNotice,
  privateOnlyNotice,
  sectionPolicy
} from '../chat-policy'
// جدول کلیدواژه‌ها در کاتالوگ مرکزی زندگی می‌کند؛ راهنما و سیاست محیط هم
// از همان‌جا می‌خوانند تا هیچ‌وقت سه نسخهٔ متفاوت از یک جدول نداشته باشیم.
import { EXACT_SECTIONS } from '../command-catalog'
import { openFeaturePanel } from './features.handler'
import { handleWillHeirText, handleWillNoteText } from './will.handler'
import { texts } from '../../utils/classes/texts'
import { logger } from '../../utils/logger'
import { AppError, ValidationError } from '../../utils/classes/errors'
import {
  renderIdentityCard,
  renderStatusPanel,
  renderNotificationsList,
  renderRelationshipsList,
  renderSkillsTrainingPanel,
  renderEducationPanel,
  renderLeaderboard,
  renderHousingPanel,
  renderBankPanel,
  renderWorkPanel,
  renderBusinessList,
  renderShopMainPanel,
  renderShopCategoryPanel,
  renderInventoryPanel,
  renderCreditPanel,
  renderLedgerPanel,
  renderNewsPanel,
  renderRegionPanel,
  renderRankingPanel,
  renderMissionPanel,
  renderHistoryPanel,
  renderRegionManagementPanel,
  renderResidencePanel,
  renderMigrationCheckPanel,
  renderPayrollPanel,
  renderStatisticsPanel,
  renderQuestPanel,
  renderAchievementPanel,
  renderDepositPanel,
  renderClinicPanel,
  renderRentalOwnerPanel,
  renderPassportPanel,
  renderFortunePanel,
  renderJobPostingsPanel,
  renderJobDetailPanel,
  renderMyJobPanel,
  renderBusinessStaffPanel,
  renderFamilyPanel,
  renderPetAdoptedPanel,
  renderSupportPanel,
  renderSupportSubmitted
} from '../renders'
import {
  buildIdentityPrivacyKeyboard,
  buildWorkMenuKeyboard,
  buildPartTimeCategoriesKeyboard,
  buildPartTimeJobsByCategoryKeyboard,
  buildActiveWorkKeyboard,
  buildFullTimeMenuKeyboard,
  buildBusinessBlueprintsKeyboard,
  buildEducationMenuKeyboard,
  buildEducationFieldsKeyboard,
  buildHousingMenuKeyboard,
  buildPropertyCatalogKeyboard,
  buildBankingMenuKeyboard,
  buildBankCancelKeyboard,
  buildBankSettleConfirmKeyboard,
  buildHelpCategoryKeyboard,
  buildHelpTopicKeyboard,
  buildHousingBackKeyboard,
  buildMyPropertiesKeyboard,
  buildWorkBackKeyboard,
  buildBankBackKeyboard,
  buildEducationBackKeyboard,
  buildShopBackKeyboard,
  buildClosePanelKeyboard,
  buildFamilyCancelKeyboard,
  buildFamilyGiftCancelKeyboard,
  buildFamilyKeyboard,
  buildPetKeyboard,
  buildPetRecoveryKeyboard,
  buildTransferConfirmKeyboard,
  buildTransferHelpKeyboard,
  buildTransferDoneKeyboard,
  buildTransferCancelledKeyboard,
  buildLoanRequestCancelKeyboard,
  buildAuctionCancelKeyboard,
  buildAdsCancelKeyboard,
  buildShopCategoriesKeyboard,
  buildShopCategoryItemsKeyboard,
  buildInventoryListKeyboard,
  buildLeaderboardKeyboard,
  buildCreditKeyboard,
  buildLedgerKeyboard,
  buildStatsKeyboard,
  buildLifeMenuKeyboard,
  buildNotificationsKeyboard,
  buildCityKeyboard,
  buildNewsKeyboard,
  buildRegionKeyboard,
  buildRankingKeyboard,
  buildMissionKeyboard,
  buildHistoryKeyboard,
  buildSkillsTrainingKeyboard,
  buildManagementKeyboard,
  buildResidenceKeyboard,
  buildMigrationConfirmKeyboard,
  buildBusinessManageKeyboard,
  buildBusinessSelectKeyboard,
  buildPayrollConfirmKeyboard,
  buildPayrollDoneKeyboard,
  buildQuestKeyboard,
  buildAchievementKeyboard,
  buildFortuneKeyboard,
  buildDepositKeyboard,
  buildClinicKeyboard,
  buildRentalOwnerKeyboard,
  buildPassportKeyboard,
  buildJobPostingsKeyboard,
  buildJobDetailKeyboard,
  buildMyApplicationsKeyboard,
  buildMyJobKeyboard,
  buildQuitConfirmKeyboard,
  buildBusinessStaffKeyboard,
  buildJobWizardKeyboard,
  buildFlowCancelKeyboard,
  buildLoanCollateralKeyboard,
  buildLoanConfirmKeyboard,
  buildSupportKeyboard,
  buildSupportCancelKeyboard
} from '../keyboards/main.keyboard'
import {
  DegreeLevel,
  EDUCATION_FIELDS,
  degreeLabels,
  nextEnrollableDegree
} from '../../modules/education/education-blueprints'
import { FURNISH_COST } from '../../modules/housing/housing.service'
import { LeaderboardMetric, LEADERBOARD_METRICS as _LEADERBOARD_METRICS } from '../../modules/ranking/leaderboard.service'
import { getLocalRoleTitle, playerGroupLabels } from '../../modules/groups/group.service'
import { maritalStatusLabels } from '../../modules/identity/player.service'
import { panel, fa, money, barWithPercent, plainInput } from '../ui-kit'
import { fieldMatchesCategory, productivityHint } from '../../modules/life/life-core'
import { daysUntil, formatGameMinutes, ratePerGameHour } from '../../utils/game-time'
import { GameEventType, PlayerGroupRole } from '@prisma/client'
import type { PlayerReportCategory } from '@prisma/client'
import { MIN_LOAN_AMOUNT, EARLY_REPAY_DISCOUNT_RATE } from '../../modules/banking/banking.service'
import { PET_INFO } from '../../modules/pets/pet.service'
import {
  OPEN_REPORT_CAP,
  REPORT_BODY_LIMITS,
  reportCategoryLabels,
  reportStatusLabels
} from '../../modules/support/support.service'
import { businessCollateralValue, loanPrincipalCap } from '../../modules/banking/collateral'
import { loanWarningText } from '../../modules/banking/loan-lifecycle'
import { sendPanel, editPanel, editPanelKeyboard, ackCallback } from '../panel'
import { handleCallbackError, handleCommandError } from '../handler-errors'
import { askForConfirmation } from '../confirm-action'
import { confirmationPreviews } from '../confirmations'
import { transferHowToLines, transferLimitsText } from '../../modules/finance/transfer.service'
import { bankTransferLimitsText } from '../../modules/banking/bank-transfer.service'
import {
  HELP_MAIN_TEXT,
  HELP_CATEGORIES,
  getHelpTopic,
  getHelpCategory,
  renderCategoryPanel
} from '../help-content'

/**
 * جریان‌های ورودیِ آزاد که **موجودی/مالکیت** را عوض می‌کنند.
 *
 * این کلیدها پیشوندِ callback نیستند؛ در `UserState.currentContext` می‌نشینند و
 * ورودیِ بعدیِ بازیکن را مصرف می‌کنند. پس میان‌افزارِ سراسریِ سیاست محیط — که
 * تنها مرگ را در مسیر دکمه‌ها می‌گیرد — آن‌ها را نمی‌بیند. این فهرست همان
 * حلقهٔ گم‌شده است: اگر شخصیت بین بازکردن و تمام‌کردنِ جریان بمیرد، پیامِ
 * بعدی دیگر نباید آن جریان را اجرا کند.
 *
 * `support_text` عمداً در فهرست نیست: ثبت اعتراض حقِ بازیکن است و هیچ اثر
 * اقتصادی ندارد.
 */
const MUTATING_INPUT_FLOWS: ReadonlySet<string> = new Set([
  'bank_deposit',
  'bank_withdraw',
  'family_mahr',
  'family_gift',
  'loan_request',
  'will_heir',
  'will_note',
  'ad_text'
])

/** همان فهرست، ولی برای جریان‌هایی که شناسهٔ هدف را در خودِ کلید دارند. */
const MUTATING_INPUT_PREFIXES: readonly string[] = [
  'family_set_mahr:',
  'biz_job_title:',
  'biz_jobsal:',
  'biz_profit:',
  'biz_salary:',
  'pet_name:',
  'auction_bid:',
  'market_sell:',
  'deposit_open:',
  'rental_price:',
  'project_amount:'
]

/** آیا این جریانِ ورودی، پول یا مالکیت را عوض می‌کند؟ */
export function isMutatingInputFlow(context: string): boolean {
  return (
    MUTATING_INPUT_FLOWS.has(context) ||
    MUTATING_INPUT_PREFIXES.some((prefix) => context.startsWith(prefix))
  )
}

export function registerTextHandlers(bot: Bot, container: Container): void {
  // Panel Close Handler
  bot.callbackQuery('panel:close', async (ctx) => {
    // ack اول، تا حتی اگر پاک‌سازی state شکست بخورد، اسپینر تلگرام
    // هرگز روشن نماند.
    await ackCallback(ctx)
    const from = ctx.from
    if (from) {
      await container.userStateRepository.clear(BigInt(from.id)).catch(() => undefined)
    }
    await ctx.deleteMessage().catch(() => {})
  })

  bot.callbackQuery('id:main', async (ctx) => {
    await ackCallback(ctx)
    await handleSection(ctx, container, 'identity', { edit: true })
  })

  // Privacy Toggle Callback
  bot.callbackQuery('id:toggle_privacy', async (ctx) => {
    const fromId = BigInt(ctx.from.id)
    const newPrivacy = await container.identityPrivacyService.togglePrivacy(fromId)
    await ackCallback(
      ctx,
      newPrivacy === 'PUBLIC' ? 'اطلاعاتت عمومی شد' : 'اطلاعاتت خصوصی شد'
    )
    await editPanelKeyboard(ctx, buildIdentityPrivacyKeyboard(newPrivacy))
  })

  // Housing Callbacks
  // توجه: هندلر 'house:main' در ادامهٔ همین فایل (بخش «بازگشت به خانه») ثبت شده است؛
  // ثبت تکراری آن در اینجا حذف شد تا مسیر یکتا باشد.

  bot.callbackQuery('house:buy_catalog', async (ctx) => {
    await ackCallback(ctx)
    await editPanel(ctx, {
      text: panel({
        icon: '🛒',
        title: 'خرید ملک',
        sections: [{ lines: ['یکی از املاک زیر را انتخاب کن.'] }],
        footer: '💡 هرچه سطح ملک بالاتر باشد، استراحت سریع‌تر خستگی را رفع می‌کند.'
      }),
      keyboard: buildPropertyCatalogKeyboard()
    })
  })

  bot.callbackQuery(/^house:buy:/, async (ctx) => {
    const typeKey = ctx.callbackQuery.data.split(':')[2]!
    await ackCallback(ctx)
    try {
      // خرید ملک هزینهٔ سنگین و برگشت‌ناپذیر دارد؛ تأیید پیش از کسر پول.
      await askForConfirmation(ctx, container, {
        kind: 'house_buy',
        ...confirmationPreviews.property(typeKey),
        payload: { typeKey }
      })
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'housing',
        action: 'buy_property',
        fallback: 'صفحهٔ تأیید خرید باز نشد.'
      })
    }
  })

  bot.callbackQuery('house:start_rest', async (ctx) => {
    const fromId = BigInt(ctx.from.id)
    try {
      await container.housingService.startRestAtHome(fromId)
      await ackCallback(ctx, 'استراحت آغاز شد')
      await editPanel(ctx, {
        text: panel({
          icon: '🛌',
          title: 'در حال استراحت',
          sections: [{ lines: ['خستگی‌ات کم‌کم رفع می‌شود.'] }],
          footer: '💡 هر چه بیشتر استراحت کنی، خستگی بیشتری رفع می‌شود.'
        }),
        keyboard: buildHousingMenuKeyboard(true)
      })
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'housing',
        action: 'start_rest',
        fallback: 'شروع استراحت ممکن نشد.'
      })
    }
  })

  bot.callbackQuery('house:stop_rest', async (ctx) => {
    const fromId = BigInt(ctx.from.id)
    try {
      const rest = await container.housingService.stopRestAtHome(fromId)
      await ackCallback(ctx, 'استراحت به پایان رسید')
      await editPanel(ctx, {
        text: panel({
          icon: '🌅',
          title: 'پایان استراحت',
          sections: [
            {
              rows: [
                { label: '🏡 اقامتگاه', value: rest.propertyTitle },
                { label: '⏱️ مدت', value: `${fa(rest.elapsedMinutes)} دقیقهٔ بازی` },
                { label: '⚡ خستگی رفع‌شده', value: `−${fa(rest.fatigueRecovered)}٪` },
                { label: '❤️ سلامت بازیابی‌شده', value: `+${fa(rest.healthRecovered)}٪` }
              ]
            }
          ]
        }),
        keyboard: buildHousingBackKeyboard()
      })
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'housing',
        action: 'stop_rest',
        fallback: 'پایان استراحت ممکن نشد.'
      })
    }
  })

  bot.callbackQuery('house:my_list', async (ctx) => {
    const fromId = BigInt(ctx.from.id)
    try {
      const realEstate = await container.housingService.listPlayerRealEstate(fromId)
      await ackCallback(ctx)

      // وضعیت هر ملک: کدام خالی است، کدام عرضه شده، کدام مستأجر دارد —
      // مالک باید ببیند دقیقاً کدام املاکش الان *خانهٔ خودش* هستند.
      const now = Date.now()
      const rows = realEstate.owned.map((p) => {
        const contract = (p.rentalContracts ?? []).find(
          (c) => c.isActive && c.expiresAt.getTime() > now
        )
        const status = contract
          ? `👤 اجاره‌داده‌شده به *${contract.tenant?.firstName ?? 'مستأجر'}* (${fa(daysUntil(contract.expiresAt))} روز مانده)`
          : p.isListedForRent
            ? '📣 در بازار اجاره عرضه شده'
            : '🏠 خالی — محل استراحت تو'
        return {
          id: p.id,
          line: `🏠 *${p.title}* — سطح ${fa(p.level)}${p.isFurnished ? ' · 🛋️ مبله' : ''}\n   ${status}`,
          rentedOut: Boolean(contract)
        }
      })

      const sections: Parameters<typeof panel>[0]['sections'] = [
        {
          lines:
            realEstate.owned.length === 0
              ? ['هیچ ملکی به نامت ثبت نشده است.', 'از «خرید ملک» یک خانه بخر تا بتوانی استراحت کنی.']
              : rows.map((r) => r.line)
        },
        {
          lines: [
            `💡 مبله‌کردن، کیفیت استراحت را بهتر می‌کند (هزینه: ${money(FURNISH_COST)}).`,
            '💸 فروش ملک ۶۰٪ ارزش پایهٔ دارایی برمی‌گرداند؛ ملکِ اجاره‌داده‌شده یا وثیقهٔ وام باز، قابل فروش نیست.'
          ]
        }
      ]

      await editPanel(ctx, {
        text: panel({ icon: '📋', title: 'املاک مسکونی من', sections }),
        keyboard: buildMyPropertiesKeyboard(
          realEstate.owned.map((p) => ({
            id: p.id,
            title: p.title,
            isFurnished: p.isFurnished,
            rentedOut: rows.find((r) => r.id === p.id)?.rentedOut ?? false
          }))
        )
      })
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'housing',
        action: 'my_list',
        fallback: 'فهرست املاک باز نشد.'
      })
    }
  })

  // فروش ملک: برگشت‌ناپذیر است؛ پشتِ صفحهٔ تأیید، قیمت دقیق و با شرایط منطقی
  bot.callbackQuery(/^house:sell:/, async (ctx) => {
    const propertyId = ctx.callbackQuery.data.split(':')[2]!
    const fromId = BigInt(ctx.from.id)
    await ackCallback(ctx)
    try {
      const realEstate = await container.housingService.listPlayerRealEstate(fromId)
      const property = realEstate.owned.find((p) => p.id === propertyId)
      if (!property) {
        await editPanel(ctx, {
          text: panel({
            icon: '⚠️',
            title: 'ملک در دسترس نیست',
            sections: [{ lines: ['این ملک دیگر در فهرست تو نیست.'] }]
          }),
          keyboard: buildHousingBackKeyboard()
        })
        return
      }
      const salePrice = await container.housingService.getSalePrice(fromId, propertyId)
      await askForConfirmation(ctx, container, {
        kind: 'house_sell',
        ...confirmationPreviews.propertySale(property.title, Number(property.baseAssetValue), salePrice),
        payload: { propertyId }
      })
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'housing',
        action: 'sell_property',
        fallback: 'صفحهٔ تأیید فروش باز نشد.'
      })
    }
  })

  bot.callbackQuery(/^house:furnish:/, async (ctx) => {
    const fromId = BigInt(ctx.from.id)
    const propertyId = ctx.callbackQuery.data.split(':')[2]!
    try {
      const res = await container.housingService.furnishProperty(fromId, propertyId)
      await ackCallback(ctx, `🛋️ ${res.title} مبله شد`)
      await editPanel(ctx, {
        text: panel({
          icon: '🛋️',
          title: 'ملک مبله شد',
          sections: [
            {
              rows: [
                { label: '🏠 ملک', value: res.title },
                { label: '💵 هزینه', value: money(res.cost) }
              ]
            }
          ],
          footer: '💡 استراحت در خانهٔ مبله، خستگی را بهتر در می‌کند.'
        }),
        keyboard: buildHousingBackKeyboard()
      })
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'housing',
        action: 'furnish',
        fallback: 'مبله‌کردن ملک انجام نشد.'
      })
    }
  })

  // Banking Callbacks
  bot.callbackQuery('bank:deposit_prompt', async (ctx) => {
    const fromId = BigInt(ctx.from.id)
    await ackCallback(ctx)
    const [account, player] = await Promise.all([
      container.bankingService.getOrCreateAccount(fromId),
      container.playerRepository.findByTelegramUserId(fromId)
    ])
    await container.userStateRepository.upsert(fromId, { currentContext: 'bank_deposit', stateData: {} })
    await editPanel(ctx, {
      text: panel({
        icon: '📥',
        title: 'واریز به حساب',
        sections: [
          {
            rows: [
              { label: '💵 کیف پول', value: money(Number(player?.balance ?? 0)) },
              { label: '💳 حساب بانکی', value: money(Number(account.balance)) }
            ]
          },
          { lines: ['✍️ مبلغ موردنظر را بنویس.'] }
        ],
        footer: '💡 نمونه‌های مجاز: ۵۰۰۰۰۰ یا 500,000 یا 110k'
      }),
      keyboard: buildBankCancelKeyboard()
    })
  })

  bot.callbackQuery('bank:withdraw_prompt', async (ctx) => {
    const fromId = BigInt(ctx.from.id)
    await ackCallback(ctx)
    const account = await container.bankingService.getOrCreateAccount(fromId)
    await container.userStateRepository.upsert(fromId, {
      currentContext: 'bank_withdraw',
      stateData: {}
    })
    await editPanel(ctx, {
      text: panel({
        icon: '📤',
        title: 'برداشت از حساب',
        sections: [
          { rows: [{ label: '💳 حساب بانکی', value: money(Number(account.balance)) }] },
          { lines: ['✍️ مبلغ موردنظر را بنویس.'] }
        ],
        footer: '💡 نمونه‌های مجاز: ۲۰۰۰۰۰ یا 200,000 یا 110k'
      }),
      keyboard: buildBankCancelKeyboard()
    })
  })

  bot.callbackQuery('bank:cancel', async (ctx) => {
    const fromId = BigInt(ctx.from.id)
    await container.userStateRepository.clear(fromId)
    await ackCallback(ctx, 'عملیات بانکی لغو شد')
    await editPanel(ctx, { text: texts.bankCancel, keyboard: buildBankBackKeyboard() })
  })

  // ── پشتیبانی و گزارش مشکل (فقط چت خصوصی؛ نگهبانِ محیط در chat-policy)
  bot.callbackQuery('sup:main', async (ctx) => {
    const fromId = BigInt(ctx.from.id)
    await ackCallback(ctx)
    try {
      await showSupportPanel(ctx, container, fromId, editPanel)
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'support',
        action: 'panel',
        fallback: 'پنل پشتیبانی باز نشد.'
      })
    }
  })

  bot.callbackQuery(/^sup:new:/, async (ctx) => {
    const categoryKey = ctx.callbackQuery.data.split(':')[2] ?? ''
    const category: PlayerReportCategory = isReportCategory(categoryKey) ? categoryKey : 'OTHER'
    const fromId = BigInt(ctx.from.id)

    try {
      // سقفِ گزارش‌های بی‌پاسخ *پیش* از ورود به حالتِ ورودی سنجیده می‌شود:
      // بازیکن نباید اول متن بنویسد و بعد بشنود جا ندارد.
      const reports = await container.supportService.listMine(fromId)
      const openCount = reports.filter((report) => report.status === 'OPEN').length
      if (openCount >= OPEN_REPORT_CAP) {
        await ackCallback(
          ctx,
          `همین حالا ${fa(openCount)} گزارشِ بی‌پاسخ داری؛ تا رسیدگی‌شان گزارش تازه ثبت نمی‌شود.`,
          true
        )
        await showSupportPanel(ctx, container, fromId, editPanel)
        return
      }

      await ackCallback(ctx)
      await container.userStateRepository.upsert(fromId, {
        currentContext: `support_text:${category}`,
        stateData: { chatId: ctx.chat!.id }
      })

      await editPanel(ctx, {
        text: panel({
          icon: '📝',
          title: `گزارش ${reportCategoryLabels[category]}`,
          sections: [
            {
              lines: [
                'همین‌جا بنویس چه اتفاقی افتاد. جزئیات و زمان وقوع بیشترین کمک را می‌کند.',
                '',
                `متن باید بین ${fa(REPORT_BODY_LIMITS.min)} و ${fa(REPORT_BODY_LIMITS.max)} نویسه باشد.`,
                'هر وقت خواستی «انصراف» را بفرست یا دکمهٔ انصراف را بزن.'
              ]
            }
          ],
          footer: '💡 این متن فقط برای تیم مدیریت ثبت می‌شود؛ در گروه نمایش داده نمی‌شود.'
        }),
        keyboard: buildSupportCancelKeyboard()
      })
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'support',
        action: 'start_report',
        fallback: 'شروع ثبت گزارش انجام نشد.'
      })
    }
  })

  bot.callbackQuery('sup:cancel', async (ctx) => {
    const fromId = BigInt(ctx.from.id)
    await ackCallback(ctx)
    try {
      // پاک‌سازی state پیش از نمایش پنل؛ هیچ چیزی ذخیره نشده است.
      await container.userStateRepository.clear(fromId)
      await showSupportPanel(ctx, container, fromId, editPanel)
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'support',
        action: 'cancel',
        fallback: 'انصراف از گزارش انجام نشد.'
      })
    }
  })

  // ── وام با وثیقه: انتخاب وثیقه ← پنل تأیید ← پرداخت (دیگر خودکار نیست) ──
  bot.callbackQuery('bank:loan_menu', async (ctx) => {
    const fromId = BigInt(ctx.from.id)
    await ackCallback(ctx)
    const [realEstate, businesses] = await Promise.all([
      container.housingService.listPlayerRealEstate(fromId),
      container.businessService.listOwnerBusinesses(fromId)
    ])
    if (realEstate.owned.length === 0 && businesses.length === 0) {
      await editPanel(ctx, {
        text: panel({
          icon: '⚠️',
          title: 'درخواست وام',
          sections: [
            { lines: ['برای وام باید یک ملک یا کسب‌وکار به‌عنوان وثیقه داشته باشی.'] }
          ],
          footer: '💡 از بخش «خانه» می‌توانی ملک بخری.'
        }),
        keyboard: buildBankBackKeyboard()
      })
      return
    }

    await editPanel(ctx, {
      text: panel({
        icon: '🏦',
        title: 'انتخاب وثیقهٔ وام',
        sections: [
          {
            lines: [
              'وثیقه را انتخاب کن؛ مبلغ و شرایط در پنل بعدی تأیید می‌شود.',
              'هیچ وامی پیش از تأیید صریح تو پرداخت نمی‌شود.'
            ]
          }
        ],
        footer: '💡 سقف وام: نصف ارزش وثیقه، تا سقف اعتبار مالی.'
      }),
      keyboard: buildLoanCollateralKeyboard(
        realEstate.owned.map((p) => ({ id: p.id, title: p.title })),
        businesses.map((b) => ({ id: b.id, name: b.name }))
      )
    })
  })

  const showLoanConfirm = async (
    ctx: Context,
    collateralKind: 'property' | 'business',
    collateralId: string,
    collateralTitle: string,
    collateralValue: number
  ): Promise<void> => {
    const fromId = BigInt(ctx.from!.id)
    // ترازنامهٔ بانک پیش از تأیید خوانده می‌شود؛ نگهبانِ نهایی همان تراکنش
    // پرداخت است، ولی دکمه‌ای که از قبل می‌داند شکست می‌خورد نباید ساخته شود.
    const [credit, pool] = await Promise.all([
      container.bankingService.getCreditProfile(fromId),
      container.bankingService.getPoolSnapshot().catch(() => null)
    ])
    // همان فرمول سرویس وام — منبع واحد، بدون نسخهٔ محلی
    const principal = loanPrincipalCap(collateralValue, credit.maxLoanAmount)

    if (principal < MIN_LOAN_AMOUNT) {
      // دکمه‌ای که می‌داند شکست می‌خورد نباید وجود داشته باشد
      await editPanel(ctx, {
        text: panel({
          icon: '🧾',
          title: 'وام از این وثیقه ممکن نیست',
          sections: [
            {
              lines: [
                `حداقل مبلغ وام ${money(MIN_LOAN_AMOUNT)} است، اما سقف تو با این وثیقه ${money(principal)} می‌شود.`,
                'اعتبارت را با تسویه بدهی‌ها و رفتار مالی منظم بالا ببر، یا وثیقهٔ بزرگ‌تری انتخاب کن.'
              ]
            }
          ]
        }),
        keyboard: buildBankBackKeyboard()
      })
      return
    }

    // صندوق واقعیِ بانک سقفِ ناگفتهٔ وام است: اگر نقدینگی کمتر از مبلغ درخواستی
    // باشد، درخواست رد می‌شود. همان واقعیت را پیش از تأیید نشان بده تا بازیکن
    // بداند چرا و چه گزینه‌ای دارد (وثیقهٔ کوچک‌تر یا تلاش بعدی).
    if (pool && principal > pool.liquidity) {
      await editPanel(ctx, {
        text: panel({
          icon: '🏛️',
          title: 'صندوق بانک فعلاً این مبلغ را ندارد',
          sections: [
            {
              rows: [
                { label: '💰 وام قابل دریافت', value: money(principal) },
                { label: '🏛️ نقدینگی صندوق', value: money(pool.liquidity) }
              ]
            },
            {
              lines: [
                'وام از پول واقعیِ صندوق بانک پرداخت می‌شود؛ وقتی سپرده‌ها و بازپرداخت‌ها کم باشد، سقف پرداخت پایین می‌آید.',
                'می‌توانی وثیقهٔ کوچک‌تری انتخاب کنی یا چند روز بعد دوباره تلاش کنی.'
              ]
            }
          ],
          footer: '💡 نقدینگی صندوق در پنل بانک، بخش «پشتوانهٔ بانک» به‌روز است.'
        }),
        keyboard: buildBankBackKeyboard()
      })
      return
    }

    await editPanel(ctx, {
      text: panel({
        icon: '🧾',
        title: 'تأیید وام',
        sections: [
          {
            rows: [
              {
                label: collateralKind === 'property' ? '🏡 وثیقه' : '🏢 وثیقه',
                value: collateralTitle
              },
              { label: '💎 ارزش وثیقه', value: money(collateralValue) },
              { label: '💰 مبلغ قابل دریافت', value: money(principal) },
              { label: '📊 امتیاز اعتباری', value: fa(credit.score) },
              ...(pool ? [{ label: '🏛️ نقدینگی صندوق', value: money(pool.liquidity) }] : [])
            ]
          },
          {
            lines: [
              'اصل و کارمزد در پنل بانک قابل پیگیری است؛ بازپرداخت ۳۰ روزه است.',
              'با وثیقه‌گذاری، ملک/شرکت تا تسویهٔ کامل در گرو بانک می‌ماند.'
            ]
          }
        ]
      }),
      keyboard: buildLoanConfirmKeyboard(collateralKind, collateralId)
    })
  }

  bot.callbackQuery(/^bank:loan_p:/, async (ctx) => {
    const propertyId = ctx.callbackQuery.data.split(':')[2]!
    const fromId = BigInt(ctx.from.id)
    await ackCallback(ctx)
    try {
      const realEstate = await container.housingService.listPlayerRealEstate(fromId)
      const property = realEstate.owned.find((p) => p.id === propertyId)
      if (!property) {
        await editPanel(ctx, {
          text: '⚠️ این ملک دیگر در فهرست تو نیست.',
          keyboard: buildBankBackKeyboard()
        })
        return
      }
      await showLoanConfirm(
        ctx,
        'property',
        property.id,
        property.title,
        Number((property as { baseAssetValue?: { toString(): string } }).baseAssetValue ?? 0)
      )
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'banking',
        action: 'loan_collateral',
        fallback: 'بررسی وثیقه انجام نشد.'
      })
    }
  })

  bot.callbackQuery(/^bank:loan_b:/, async (ctx) => {
    const businessId = ctx.callbackQuery.data.split(':')[2]!
    const fromId = BigInt(ctx.from.id)
    await ackCallback(ctx)
    try {
      const businesses = await container.businessService.listOwnerBusinesses(fromId)
      const business = businesses.find((b) => b.id === businessId)
      if (!business) {
        await editPanel(ctx, {
          text: '⚠️ این کسب‌وکار دیگر در فهرست تو نیست.',
          keyboard: buildBankBackKeyboard()
        })
        return
      }
      await showLoanConfirm(
        ctx,
        'business',
        business.id,
        business.name,
        businessCollateralValue(Number(business.treasury), business.level)
      )
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'banking',
        action: 'loan_collateral',
        fallback: 'بررسی وثیقه انجام نشد.'
      })
    }
  })

  bot.callbackQuery(/^bank:loan_go:/, async (ctx) => {
    const [, , kind, id] = ctx.callbackQuery.data.split(':')
    const fromId = BigInt(ctx.from.id)
    try {
      const loan =
        kind === 'business'
          ? await container.bankingService.requestCollateralLoan(fromId, undefined, id)
          : await container.bankingService.requestCollateralLoan(fromId, id)
      await logPlayerEvent(container, fromId, GameEventType.LOAN_CREATED, 'دریافت وام بانکی', {
        amount: Number(loan.principalAmount)
      })
      await ackCallback(ctx, 'وام پرداخت شد')
      await editPanel(ctx, {
        text: panel({
          icon: '🎉',
          title: 'وام پرداخت شد',
          sections: [
            {
              rows: [
                { label: '💰 اصل وام', value: money(Number(loan.principalAmount)) },
                { label: '📑 کل بازپرداخت', value: money(Number(loan.totalRepaymentAmount)) }
              ]
            }
          ],
          footer: '💡 اقساط را از همین پنل بانک پرداخت کن.'
        }),
        keyboard: buildBankBackKeyboard()
      })
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'banking',
        action: 'request_loan',
        fallback: 'ثبت درخواست وام انجام نشد.'
      })
    }
  })

  bot.callbackQuery('bank:interest', async (ctx) => {
    const fromId = BigInt(ctx.from.id)
    try {
      const res = await container.bankingService.settleAccountInterest(fromId)
      await ackCallback(ctx, res.interestAccrued > 0 ? 'سود سپرده تسویه شد' : 'سود جدیدی نداری')
      await editPanel(ctx, {
        text:
          res.interestAccrued > 0
            ? `💰 *سود سپرده*\n\nمبلغ ${res.interestAccrued.toLocaleString('fa-IR')} تومان به حسابت واریز شد.`
            : '💰 *سود سپرده*\n\nهنوز سود جدیدی محقق نشده است.\nسود بر اساس تعداد روزهای سپرده محاسبه می‌شود.',
        keyboard: buildBankBackKeyboard()
      })
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'banking',
        action: 'claim_interest',
        fallback: 'واریز سود سپرده انجام نشد.'
      })
    }
  })

  bot.callbackQuery('bank:loan_repay', async (ctx) => {
    const fromId = BigInt(ctx.from.id)
    try {
      const loans = await container.bankingService.listLoans(fromId)
      await ackCallback(ctx)
      if (loans.length === 0) {
        await editPanel(ctx, {
          text: panel({
          icon: '💳',
          title: 'بازپرداخت وام',
          sections: [{ lines: ['وام فعالی برای بازپرداخت نداری.'] }]
        }),
          keyboard: buildBankBackKeyboard()
        })
        return
      }
      const loan = loans[0]!
      const repaid = await container.bankingService.repayLoan(fromId, loan.id)
      // مبلغ واقعی پرداخت‌شده = کمینهٔ قسط و ماندهٔ بدهی پیش از پرداخت؛
      // در قسط آخر ممکن است کمتر از سقف یک میلیون باشد.
      const installmentPaid = Math.min(1_000_000, Number(loan.remainingAmount))
      await editPanel(ctx, {
        text: panel({
          icon: '💳',
          title: 'پرداخت قسط',
          sections: [
            {
              rows: [
                { label: '💰 قسط پرداخت‌شده', value: money(installmentPaid) },
                { label: '📑 باقیماندهٔ بدهی', value: money(Number(repaid.remainingAmount)) }
              ]
            }
          ]
        }),
        keyboard: buildBankBackKeyboard()
      })
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'banking',
        action: 'repay_loan',
        fallback: 'بازپرداخت قسط انجام نشد.'
      })
    }
  })

  // تسویهٔ کامل وام با تخفیف زودهنگام — سرویس و مخزن کامل داشتند اما این
  // تنها راهش از هیچ‌جا وصل نبود؛ بازیکن مجبور بود قسط‌به‌قسط بپردازد.
  bot.callbackQuery('bank:loan_settle', async (ctx) => {
    const fromId = BigInt(ctx.from.id)
    try {
      const loans = await container.bankingService.listLoans(fromId)
      await ackCallback(ctx)
      if (loans.length === 0) {
        await editPanel(ctx, {
          text: panel({
            icon: '💳',
            title: 'تسویهٔ کامل وام',
            sections: [{ lines: ['وام فعالی برای تسویه نداری.'] }]
          }),
          keyboard: buildBankBackKeyboard()
        })
        return
      }
      // یک وام فعال به‌ازای هر بازیکن (یونیک partial)؛ اولی یعنی تنها بودن.
      const loan = loans[0]!
      const remaining = Math.round(Number(loan.remainingAmount))
      // همان فرمول سرویس تسویهٔ زودهنگام — منبع واحد نرخ تخفیف
      const saved = Math.round(remaining * EARLY_REPAY_DISCOUNT_RATE)
      await editPanel(ctx, {
        text: panel({
          icon: '🧾',
          title: 'تأیید تسویهٔ کامل وام',
          sections: [
            {
              rows: [
                { label: '📑 ماندهٔ بدهی', value: money(remaining) },
                { label: '✅ تخفیف تسویهٔ زودهنگام', value: `−${money(saved)}` },
                { label: '💰 مبلغ قابل پرداخت', value: `*${money(remaining - saved)}*` }
              ]
            },
            {
              lines: [
                'با تسویهٔ کامل، وثیقه‌ات (ملک یا شرکت) آزاد می‌شود',
                'و دیگر بهره‌ای نمی‌پردازی.'
              ]
            }
          ]
        }),
        keyboard: buildBankSettleConfirmKeyboard(loan.id)
      })
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'banking',
        action: 'settle_preview',
        fallback: 'بازکردن صفحهٔ تسویهٔ وام ممکن نشد.'
      })
    }
  })

  bot.callbackQuery(/^bank:loan_settle_go:/, async (ctx) => {
    const loanId = ctx.callbackQuery.data.split(':')[2]!
    const fromId = BigInt(ctx.from.id)
    try {
      const result = await container.bankingService.repayLoanEarly(fromId, loanId)
      await ackCallback(ctx, 'وام کامل تسویه شد')
      await editPanel(ctx, {
        text: panel({
          icon: '🎉',
          title: 'وام تسویه شد',
          sections: [
            {
              rows: [
                { label: '💰 مبلغ پرداختی', value: money(result.paid) },
                { label: '✅ صرفه‌جویی در بهره', value: money(result.saved) }
              ]
            }
          ],
          footer: '💡 تسویهٔ به‌موقع، امتیاز اعتباری‌ات را بالا می‌برد.'
        }),
        keyboard: buildBankBackKeyboard()
      })
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'banking',
        action: 'settle_loan',
        fallback: 'تسویهٔ زودهنگام انجام نشد. موجودی کیفت را بررسی کن.'
      })
    }
  })

  bot.callbackQuery(/^biz:upgrade:/, async (ctx) => {
    const businessId = ctx.callbackQuery.data.split(':')[2]!
    const fromId = BigInt(ctx.from.id)
    await ackCallback(ctx)
    try {
      const businesses = await container.businessService.listOwnerBusinesses(fromId)
      const business = businesses.find((b) => b.id === businessId)
      if (!business) {
        await editPanel(ctx, {
          text: panel({
            icon: '⚠️',
            title: 'کسب‌وکار در دسترس نیست',
            sections: [{ lines: ['این کسب‌وکار دیگر در فهرست تو نیست.'] }]
          }),
          keyboard: buildWorkBackKeyboard()
        })
        return
      }
      // ارتقا هزینهٔ خزانه را می‌برد و برگشت‌پذیر نیست؛ تأیید لازم است.
      await askForConfirmation(ctx, container, {
        kind: 'biz_upgrade',
        ...confirmationPreviews.businessUpgrade(business.name),
        payload: { businessId }
      })
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'business',
        action: 'upgrade',
        fallback: 'صفحهٔ تأیید ارتقا باز نشد.'
      })
    }
  })

  bot.callbackQuery('help:main', async (ctx) => {
    await ackCallback(ctx)
    await openHelpMain(ctx, container, true)
  })

  bot.callbackQuery(/^help:cat:/, async (ctx) => {
    const categoryKey = ctx.callbackQuery.data.split(':')[2] ?? ''
    await ackCallback(ctx)
    const newcomer = await isNewcomer(container, BigInt(ctx.from!.id))
    if (!getHelpCategory(categoryKey)) {
      await openHelpMain(ctx, container, true)
      return
    }
    await editPanel(ctx, {
      text: renderCategoryPanel(categoryKey),
      keyboard: buildHelpCategoryKeyboard(categoryKey, { newcomer })
    })
  })

  bot.callbackQuery(/^help:topic:/, async (ctx) => {
    const parts = ctx.callbackQuery.data.split(':')
    const topicKey = parts[3] ?? parts[2] ?? ''
    const categoryKey = HELP_CATEGORIES.find(category => category.topicKeys.includes(topicKey))?.key
    const topic = getHelpTopic(topicKey)
    await ackCallback(ctx)
    const newcomer = await isNewcomer(container, BigInt(ctx.from!.id))
    // دکمهٔ کهنه در چت: بازیکنی که شخصیت دارد با متنِ «ساخت شخصیت» رو‌به‌رو
    // نمی‌شود؛ همان صفحهٔ راهنما را می‌بیند.
    if (!topic || (topicKey === 'start' && !newcomer)) {
      await openHelpMain(ctx, container, true)
      return
    }
    await editPanel(ctx, {
      text: topic.body,
      keyboard: buildHelpTopicKeyboard(categoryKey)
    })
  })

  // اعتبار مالی
  bot.callbackQuery('credit:refresh', async (ctx) => {
    await ackCallback(ctx, 'به‌روزرسانی شد')
    await handleSection(ctx, container, 'credit', { edit: true })
  })

  // دفتر مالی با صفحه‌بندی
  bot.callbackQuery(/^ledger:\d+$/, async (ctx) => {
    const fromId = BigInt(ctx.from.id)
    const page = Number(ctx.callbackQuery.data.split(':')[1]) || 0
    await ackCallback(ctx)
    try {
      const ledger = await container.ledgerService.getLedger(fromId, page)
      const totalPages = Math.max(1, Math.ceil(ledger.total / ledger.pageSize))
      await editPanel(ctx, {
        text: renderLedgerPanel(ledger),
        keyboard: buildLedgerKeyboard(page, totalPages)
      })
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'ledger',
        action: 'open_page',
        fallback: 'خواندن دفتر مالی ممکن نشد.'
      })
    }
  })

  // آمار زندگی
  bot.callbackQuery('stats:main', async (ctx) => {
    await ackCallback(ctx, 'به‌روزرسانی شد')
    await handleSection(ctx, container, 'stats', { edit: true })
  })

  // اقتصاد شهر
  bot.callbackQuery('city:refresh', async (ctx) => {
    await ackCallback(ctx, 'به‌روزرسانی شد')
    // بازمحاسبهٔ اجباری آمار منطقه
    if (isGroupContext(ctx.chat?.type) && ctx.chat) {
      await container.regionService.getState(BigInt(ctx.chat.id), true).catch(() => null)
    }
    await handleSection(ctx, container, 'city', { edit: true })
  })

  // بازگشت به بانک
  bot.callbackQuery('bank:main', async (ctx) => {
    await ackCallback(ctx)
    await handleSection(ctx, container, 'banking', { edit: true })
  })

  // بازگشت به خانه
  bot.callbackQuery('house:main', async (ctx) => {
    await ackCallback(ctx)
    await handleSection(ctx, container, 'housing', { edit: true })
  })

  // اخبار منطقه
  bot.callbackQuery(/^news:\d+$/, async (ctx) => {
    const page = Number(ctx.callbackQuery.data.split(':')[1]) || 0
    // گارد پیش از اولین ack؛ تلگرام فقط اولین پاسخِ هر callback را نشان می‌دهد
    if (!isGroupContext(ctx.chat?.type)) {
      await ackCallback(ctx, 'این بخش فقط در گروه در دسترس است.', true)
      return
    }
    await ackCallback(ctx)
    try {
      const feed = await container.newsService.getFeed(BigInt(ctx.chat!.id), page)
      const totalPages = Math.max(1, Math.ceil(feed.total / feed.pageSize))
      await editPanel(ctx, {
        text: renderNewsPanel(feed),
        keyboard: buildNewsKeyboard(page, totalPages)
      })
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'news',
        action: 'open_page',
        fallback: 'خواندن اخبار منطقه ممکن نشد.',
        meta: { page }
      })
    }
  })

  // وضعیت منطقه
  bot.callbackQuery('region:refresh', async (ctx) => {
    await ackCallback(ctx, 'به‌روزرسانی شد')
    await handleSection(ctx, container, 'region', { edit: true })
  })

  // رتبه‌بندی
  bot.callbackQuery(/^rank:(group|global|region):[a-z_]+:\d+$/, async (ctx) => {
    const [, scope, category, pageRaw] = ctx.callbackQuery.data.split(':')
    const page = Number(pageRaw) || 0
    const inGroup = isGroupContext(ctx.chat?.type)
    // گارد پیش از اولین ack؛ ack دوم به کاربر نمی‌رسد
    if (scope === 'group' && !inGroup) {
      await ackCallback(ctx, 'رتبه‌بندی منطقه فقط در گروه در دسترس است.', true)
      return
    }
    await ackCallback(ctx)

    try {
      let result
      if (scope === 'region') {
        result = await container.rankingService.getRegionRanking(category as never, page)
      } else if (scope === 'group') {
        result = await container.rankingService.getGroupRanking(
          BigInt(ctx.chat!.id),
          category as never,
          page
        )
      } else {
        result = await container.rankingService.getGlobalPlayerRanking(category as never, page)
      }

      const totalPages = Math.max(1, Math.ceil(result.total / result.pageSize))
      await editPanel(ctx, {
        text: renderRankingPanel(result),
        keyboard: buildRankingKeyboard(result.scope, result.category, page, totalPages, inGroup)
      })
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'ranking',
        action: 'open_page',
        fallback: 'باز کردن جدول رتبه‌بندی ممکن نشد.',
        meta: { scope, category, page }
      })
    }
  })

  // مأموریت‌ها
  bot.callbackQuery('mission:refresh', async (ctx) => {
    await ackCallback(ctx, 'به‌روزرسانی شد')
    await handleSection(ctx, container, 'mission', { edit: true })
  })

  // تاریخچه
  bot.callbackQuery(/^history:\d+$/, async (ctx) => {
    const fromId = BigInt(ctx.from.id)
    const page = Number(ctx.callbackQuery.data.split(':')[1]) || 0
    try {
      const player = await container.playerRepository.findByTelegramUserId(fromId)
      if (!player) {
        await ackCallback(ctx, texts.noProfile, true)
        return
      }
      await ackCallback(ctx)
      const history = await container.eventService.getPlayerHistory(player.id, page)
      const totalPages = Math.max(1, Math.ceil(history.total / history.pageSize))
      await editPanel(ctx, {
        text: renderHistoryPanel(history),
        keyboard: buildHistoryKeyboard(page, totalPages, 'all')
      })
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'history',
        action: 'open_page',
        fallback: 'خواندن تاریخچه ممکن نشد.',
        meta: { page }
      })
    }
  })

  // تاریخچه با فیلتر موضوعی: همان دادهٔ واقعی، برش‌های مختلف
  bot.callbackQuery(/^history:f:[a-z]+:\d+$/, async (ctx) => {
    const fromId = BigInt(ctx.from.id)
    const [, , rawKey, rawPage] = ctx.callbackQuery.data.split(':')
    const key = isHistoryFilterKey(rawKey!) ? rawKey! : 'all'
    const page = Number(rawPage) || 0
    try {
      const player = await container.playerRepository.findByTelegramUserId(fromId)
      if (!player) {
        await ackCallback(ctx, texts.noProfile, true)
        return
      }
      await ackCallback(ctx)
      const types = historyFilterTypes(key)
      const history = await container.eventService.getPlayerHistory(player.id, page, types)
      const totalPages = Math.max(1, Math.ceil(history.total / history.pageSize))
      await editPanel(ctx, {
        text: renderHistoryPanel(history, historyFilterLabel(key)),
        keyboard: buildHistoryKeyboard(history.page, totalPages, key)
      })
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'history',
        action: 'filter_page',
        fallback: 'خواندن تاریخچه ممکن نشد.',
        meta: { key, page }
      })
    }
  })

  // تمرین مهارت: پول + خستگی در برابر امتیاز؛ نتیجه همان لحظه نشان داده می‌شود
  bot.callbackQuery(/^skill:train:[\w-]+$/, async (ctx) => {
    const fromId = BigInt(ctx.from.id)
    const skillId = ctx.callbackQuery.data.split(':')[2]!
    try {
      const res = await container.skillService.trainSkill(fromId, skillId)
      await ackCallback(
        ctx,
        res.leveledUp
          ? `🎉 مهارت ${res.skillName} به سطح ${fa(res.level)} رسید!`
          : `🏋️ تمرین ثبت شد (+۱۲ امتیاز، ${money(res.cost)})`
      )
      const overview = await container.skillService.getTrainingOverview(fromId)
      await editPanel(ctx, {
        text: renderSkillsTrainingPanel(overview),
        keyboard: buildSkillsTrainingKeyboard(overview)
      })
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'skills',
        action: 'train',
        fallback: 'تمرین مهارت انجام نشد.',
        meta: { skillId }
      })
    }
  })

  // صندوق اعلان — تنها کنشِ نوشتاری، علامت‌زدنِ خوانده‌هاست و فقط روی
  // اعلان‌های خودِ بازیکن اثر دارد؛ هیچ وضعیتِ بازی را تغییر نمی‌دهد، پس
  // برای حسابِ مسدود/پایان‌یافته هم بی‌خطر است.
  bot.callbackQuery('notif:refresh', async (ctx) => {
    await ackCallback(ctx, 'به‌روزرسانی شد')
    try {
      const board = await container.notificationService.getBoard(BigInt(ctx.from.id), 10)
      await editPanel(ctx, {
        text: renderNotificationsList(board),
        keyboard: buildNotificationsKeyboard(board.unreadCount)
      })
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'notifications',
        action: 'refresh',
        fallback: 'خواندن اعلان‌ها ممکن نشد.'
      })
    }
  })

  bot.callbackQuery('notif:read_all', async (ctx) => {
    const fromId = BigInt(ctx.from.id)
    try {
      const marked = await container.notificationService.markAllAsRead(fromId)
      // پنل پس از نوشتن دوباره از دیتابیس خوانده می‌شود (نه با تغییرِ متنِ
      // صفحهٔ قبلی) تا همان چیزی نشان داده شود که واقعاً ذخیره شده.
      const board = await container.notificationService.getBoard(fromId, 10)
      await ackCallback(
        ctx,
        marked > 0 ? `${fa(marked)} اعلان خوانده شد` : 'اعلان خوانده‌نشده‌ای نبود'
      )
      await editPanel(ctx, {
        text: renderNotificationsList(board),
        keyboard: buildNotificationsKeyboard(board.unreadCount)
      })
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'notifications',
        action: 'mark_all_read',
        fallback: 'خوانده‌شدن اعلان‌ها ثبت نشد.'
      })
    }
  })

  // به‌روزرسانی پنل مهارت‌ها
  bot.callbackQuery('skills:refresh', async (ctx) => {
    const fromId = BigInt(ctx.from.id)
    await ackCallback(ctx, 'به‌روزرسانی شد')
    try {
      const overview = await container.skillService.getTrainingOverview(fromId)
      await editPanel(ctx, {
        text: renderSkillsTrainingPanel(overview),
        keyboard: buildSkillsTrainingKeyboard(overview)
      })
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'skills',
        action: 'refresh',
        fallback: 'پنل مهارت‌ها باز نشد.'
      })
    }
  })

  // مدیریت منطقه — بررسی مجدد دسترسی در هر Callback
  bot.callbackQuery('manage:main', async (ctx) => {
    if (!isGroupContext(ctx.chat?.type)) {
      await ackCallback(ctx, 'این پنل فقط در گروه در دسترس است.', true)
      return
    }
    const manager = await resolveRegionRole(ctx, container)
    if (!manager.allowed) {
      await ackCallback(ctx, texts.noAccess, true)
      return
    }
    await ackCallback(ctx, 'به‌روزرسانی شد')
    await handleSection(ctx, container, 'manage', { edit: true })
  })

  // پیش‌نمایش تسویه حقوق
  bot.callbackQuery(/^payroll:preview:/, async (ctx) => {
    const businessId = ctx.callbackQuery.data.split(':')[2] ?? ''
    const fromId = BigInt(ctx.from.id)
    await ackCallback(ctx)
    try {
      const preview = await container.businessService.previewPayroll(fromId, businessId)
      await editPanel(ctx, {
        text: renderPayrollPanel(preview, true),
        keyboard: buildPayrollConfirmKeyboard(businessId, !preview.skipped)
      })
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'payroll',
        action: 'preview',
        fallback: 'محاسبهٔ پیش‌نمایش حقوق ممکن نشد.'
      })
    }
  })

  // انجام تسویه حقوق
  bot.callbackQuery(/^payroll:settle:/, async (ctx) => {
    const businessId = ctx.callbackQuery.data.split(':')[2] ?? ''
    const fromId = BigInt(ctx.from.id)
    try {
      const result = await container.businessService.settlePayroll(fromId, businessId)
      await ackCallback(
        ctx,
        result.skipped ? 'چیزی برای تسویه نبود' : 'تسویه انجام شد'
      )

      if (!result.skipped) {
        await logPlayerEvent(
          container,
          fromId,
          result.totalUnpaidDebt > 0
            ? GameEventType.PAYROLL_DEBT
            : GameEventType.PAYROLL_SETTLED,
          `تسویه حقوق ${result.businessName}`,
          {
            detail: `${result.paidEmployees} کارمند پرداخت شد`,
            amount: result.totalPayroll
          }
        )
      }

      await editPanel(ctx, {
        text: renderPayrollPanel(result, false),
        keyboard: buildPayrollDoneKeyboard(businessId)
      })
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'payroll',
        action: 'settle',
        fallback: 'تسویهٔ حقوق انجام نشد. موجودی خزانه را بررسی کن.'
      })
    }
  })

  // محل زندگی
  bot.callbackQuery('residence:main', async (ctx) => {
    await ackCallback(ctx, 'به‌روزرسانی شد')
    await handleSection(ctx, container, 'home', { edit: true })
  })

  // بررسی امکان مهاجرت (مرحلهٔ تأیید)
  bot.callbackQuery(/^residence:check:/, async (ctx) => {
    const targetGroupId = ctx.callbackQuery.data.split(':')[2] ?? ''
    const fromId = BigInt(ctx.from.id)
    await ackCallback(ctx)
    try {
      const [check, group] = await Promise.all([
        container.residenceService.checkMigration(fromId, targetGroupId),
        container.groupRepository.findById(targetGroupId)
      ])
      await editPanel(ctx, {
        text: renderMigrationCheckPanel(group?.title ?? 'منطقهٔ مقصد', check),
        keyboard: buildMigrationConfirmKeyboard(targetGroupId, check.allowed)
      })
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'residence',
        action: 'check_migration',
        fallback: 'بررسی شرایط مهاجرت ممکن نشد.'
      })
    }
  })

  // انجام مهاجرت
  bot.callbackQuery(/^residence:migrate:/, async (ctx) => {
    const targetGroupId = ctx.callbackQuery.data.split(':')[2] ?? ''
    const fromId = BigInt(ctx.from.id)
    try {
      const result = await container.residenceService.migrate(fromId, targetGroupId)
      await ackCallback(ctx, 'مهاجرت انجام شد')
      await editPanel(ctx, {
        text: panel({
          icon: '✅',
          title: 'مهاجرت انجام شد',
          sections: [
            {
              rows: [
                { label: '🏡 محل اقامت جدید', value: result.targetTitle ?? 'منطقهٔ جدید' },
                { label: '💰 هزینهٔ پرداختی', value: money(result.cost) }
              ]
            }
          ],
          footer: '⏳ تا ۷۲ ساعت آینده نمی‌توانی دوباره مهاجرت کنی.'
        }),
        keyboard: buildClosePanelKeyboard()
      })
    } catch (err) {
      if (err instanceof AppError) {
        await ackCallback(ctx, 'مهاجرت انجام نشد', true)
        await editPanel(ctx, {
          text: panel({
            icon: '⚠️',
            title: 'مهاجرت انجام نشد',
            sections: [{ lines: err.persianMessage.split('\n') }]
          }),
          keyboard: buildClosePanelKeyboard()
        })
        return
      }
      await handleCallbackError(ctx, err, {
        feature: 'residence',
        action: 'migrate',
        fallback: 'مهاجرت انجام نشد.'
      })
    }
  })

  // Shop / Inventory / Leaderboard callbacks
  bot.callbackQuery(/^shop:cat:/, async (ctx) => {
    await ackCallback(ctx)
    const category = ctx.callbackQuery.data.split(':')[2]!
    const items = await container.shopService.getCatalog(category, BigInt(ctx.from.id))
    await editPanel(ctx, {
      text: renderShopCategoryPanel(category, items as never),
      keyboard: buildShopCategoryItemsKeyboard(category, items)
    })
  })

  bot.callbackQuery('shop:main', async (ctx) => {
    await ackCallback(ctx)
    await editPanel(ctx, {
      text: renderShopMainPanel(),
      keyboard: buildShopCategoriesKeyboard()
    })
  })

  bot.callbackQuery(/^shop:buy:/, async (ctx) => {
    const fromId = BigInt(ctx.from.id)
    const itemKey = ctx.callbackQuery.data.split(':')[2]!
    try {
      const res = await container.shopService.buyItem(fromId, itemKey)
      await logPlayerEvent(container, fromId, GameEventType.MARKET_TRANSACTION, `خرید ${res.item.name}`)
      await container.dailyQuestService
        .trackByTelegramId(fromId, 'shop_purchase')
        .catch(() => undefined)
      await ackCallback(ctx, `${res.item.name} خریداری شد`)
      await editPanel(ctx, {
        text: panel({
          icon: '✅',
          title: 'خرید موفق',
          sections: [{ rows: [{ label: '🛒 کالا', value: res.item.name }] }],
          footer: '💡 کالا به انبارت اضافه شد.'
        }),
        keyboard: buildShopBackKeyboard()
      })
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'shop',
        action: 'buy_item',
        fallback: 'خرید این کالا انجام نشد.'
      })
    }
  })

  bot.callbackQuery(/^inv:list:\d+$/, async (ctx) => {
    const fromId = BigInt(ctx.from.id)
    await ackCallback(ctx)
    const page = Number(ctx.callbackQuery.data.split(':').pop()) || 0
    const result = await container.shopService.listInventory(fromId, page)
      const totalPages = Math.ceil(result.total / result.pageSize)
      await editPanel(ctx, {
        text: renderInventoryPanel(result.rows as never, page, result.totalValue),
      keyboard: buildInventoryListKeyboard(
        result.rows.map((r) => ({ id: r.id, name: r.item.name })),
        page,
        totalPages
      )
    })
  })

  bot.callbackQuery(/^inv:use:/, async (ctx) => {
    const inventoryId = ctx.callbackQuery.data.split(':')[2]!
    const fromId = BigInt(ctx.from.id)
    try {
      const res = await container.shopService.useItem(inventoryId, fromId)
      await container.dailyQuestService
        .trackByTelegramId(fromId, 'item_used')
        .catch(() => undefined)
      await ackCallback(ctx, `${res.itemName} استفاده شد`)
      await editPanel(ctx, {
        text: panel({
          icon: '✅',
          title: 'استفاده از کالا',
          sections: [
            {
              rows: [
                { label: '🎒 کالا', value: res.itemName },
                ...(res.effects.health
                  ? [{ label: '❤️ سلامت', value: `+${fa(res.effects.health)}٪` }]
                  : []),
                ...(res.effects.fatigue
                  ? [{ label: '⚡ خستگی', value: `${fa(res.effects.fatigue)}٪` }]
                  : []),
                ...(res.effects.experience
                  ? [{ label: '⭐ تجربه', value: `+${fa(res.effects.experience)}` }]
                  : [])
              ]
            },
            {
              title: 'وضعیت فعلی',
              lines: [
                `❤️ سلامت · ${fa(res.health)}/${fa(res.maxHealth)} (${barWithPercent(
                  Math.round((res.health / res.maxHealth) * 100)
                )})`,
                `⚡ خستگی · ${barWithPercent(res.fatigue)}`
              ]
            }
          ]
        }),
        keyboard: buildShopBackKeyboard()
      })
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'inventory',
        action: 'use_item',
        fallback: 'استفاده از این کالا ممکن نشد.'
      })
    }
  })

  bot.callbackQuery(/^lb:group:[a-z]+:\d+$|^lb:global:[a-z]+:\d+$/, async (ctx) => {
    const parts = ctx.callbackQuery.data.split(':')
    const scope = parts[1] as 'group' | 'global'
    const metric = parts[2] as LeaderboardMetric
    const page = Number(parts[3]) || 0
    const fromId = BigInt(ctx.from.id)

    try {
      const isInGroup = ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup'
      const result =
        scope === 'group'
          ? await container.leaderboardService.groupTop(BigInt(ctx.chat!.id), metric, page)
          : await container.leaderboardService.globalTop(metric, page)
      await ackCallback(ctx)
      await editPanel(ctx, {
        text: renderLeaderboard(result.title, result.rows as never, scope, metric, page),
        keyboard: buildLeaderboardKeyboard(scope, metric, page, isInGroup, result.hasNextPage)
      })
    } catch (err) {
      void fromId
      // فقط خطای «گروه ثبت‌نشده» پیام خودش را دارد؛ بقیهٔ خطاها پیام عمومی می‌گیرند
      // تا کاربر دلیل واقعی را ببیند و خطای شبکه به‌اشتباک «ثبت نشده» خوانده نشود.
      await ackCallback(
        ctx,
        err instanceof AppError ? err.persianMessage : 'نمایش رتبه‌بندی ممکن نشد.',
        true
      )
    }
  })

  // Work Callbacks
  bot.callbackQuery('work:main', async (ctx) => {
    await ackCallback(ctx)
    await handleSection(ctx, container, 'occupation', { edit: true })
  })

  bot.callbackQuery('work:menu:part_time', async (ctx) => {
    await ackCallback(ctx)
    await editPanel(ctx, {
      text: panel({
        icon: '🕐',
        title: 'کار پاره‌وقت',
        sections: [
          {
            lines: [
              'دسته‌بندی موردنظر را انتخاب کن.',
              'عدد داخل پرانتز، تعداد شغل‌های آن دسته است.'
            ]
          },
          {
            title: 'راهنمای نشانگرها',
            lines: ['🎓 نیاز به مدرک', '⭐ نیاز به سابقهٔ کاری', '🔴 ظرفیت تکمیل شده']
          }
        ]
      }),
      keyboard: buildPartTimeCategoriesKeyboard()
    })
  })

  bot.callbackQuery(/^work:pt:cat:/, async (ctx) => {
    const category = ctx.callbackQuery.data.split(':')[3]!
    const fromId = BigInt(ctx.from.id)
    await ackCallback(ctx)
    const [capacityMap, player] = await Promise.all([
      container.jobCapacityService.getCapacityMap(),
      container.playerRepository.findByTelegramUserId(fromId).catch(() => null)
    ])
    // هم‌حوزه بودنِ رشتهٔ تحصیلی با این دسته — همان پاداشی که واقعاً در
    // فرمول دستمزد اعمال می‌شود، پس اینجا هم دیده می‌شود.
    const fieldMatched = fieldMatchesCategory(player?.graduationField ?? null, category)
    await editPanel(ctx, {
      text: panel({
        icon: '🕐',
        title: category,
        sections: [
          {
            lines: [
              'روی شغل موردنظر بزن تا کار شروع شود.',
              'عدد اول دستمزد پایه (تومان در ساعت بازی) است',
              'و عدد آخر ظرفیت اشغال‌شده از کل ظرفیت.'
            ]
          },
          ...(fieldMatched
            ? [
                {
                  lines: [
                    `✨ رشتهٔ «${player?.graduationField ?? ''}» با این دسته هم‌حوزه است؛`,
                    'دستمزدت در این شغل‌ها بیشتر از بقیه است.'
                  ]
                }
              ]
            : [])
        ],
        footer: fieldMatched
          ? '🎓 مدرک لازم · ⭐ سابقه لازم · ✨ هم‌حوزهٔ رشتهٔ تو · 🔴 ظرفیت تکمیل'
          : '🎓 مدرک لازم · ⭐ سابقه لازم · 🔴 ظرفیت تکمیل'
      }),
      keyboard: buildPartTimeJobsByCategoryKeyboard(category, capacityMap, { fieldMatched })
    })
  })

  bot.callbackQuery(/^work:start_pt:/, async (ctx) => {
    const jobKey = ctx.callbackQuery.data.split(':')[2]!
    const fromId = BigInt(ctx.from.id)
    try {
      const session = await container.workSessionService.startPartTimeWork(fromId, jobKey)
      await logPlayerEvent(container, fromId, GameEventType.JOB_STARTED, `شروع کار: ${session.jobTitle}`)
      await ackCallback(ctx, 'کار آغاز شد')
      await editPanel(ctx, {
        text: panel({
          icon: '✅',
          title: 'کار شروع شد',
          sections: [
            {
              rows: [
                { label: '💼 شغل', value: session.jobTitle },
                { label: '💰 دستمزد پایه', value: `${money(ratePerGameHour(Number(session.payPerMinute)))} در ساعت بازی` }
              ]
            }
          ],
          footer: '💡 هرچه بیشتر کار کنی دستمزد بیشتر می‌شود، اما خستگی هم بالا می‌رود.'
        }),
        keyboard: buildActiveWorkKeyboard()
      })
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'occupation',
        action: 'start_part_time',
        fallback: 'شروع این کار ممکن نشد.',
        meta: { jobKey }
      })
    }
  })

  /**
   * شیفت در محل کار: کسب‌وکار کارفرما یا کسب‌وکار خودِ بازیکن.
   *
   * این شیفت پول نقد نمی‌دهد؛ کارکرد را برای تسویهٔ کارفرما ثبت می‌کند، پس
   * پنلِ بعدی هم دستمزد فوری نشان نمی‌دهد.
   */
  bot.callbackQuery('work:start_wp', async (ctx) => {
    const fromId = BigInt(ctx.from.id)
    try {
      const { session, workplace } = await container.workSessionService.startWorkplaceShift(fromId)
      await logPlayerEvent(container, fromId, GameEventType.JOB_STARTED, `شروع شیفت: ${workplace.businessName}`)
      await ackCallback(ctx, 'شیفت آغاز شد')
      await editPanel(ctx, {
        text: panel({
          icon: '✅',
          title: 'شیفت شروع شد',
          sections: [
            {
              rows: [
                { label: '🏢 محل کار', value: workplace.businessName },
                { label: '💼 سمت', value: session.jobTitle },
                ...(workplace.payPerMinute > 0
                  ? [
                      {
                        label: '💰 حقوق',
                        value: `${money(ratePerGameHour(workplace.payPerMinute))} در ساعت بازی`
                      }
                    ]
                  : [])
              ]
            }
          ],
          footer:
            '💡 کارکردت ثبت می‌شود و حقوق در «تسویهٔ حقوق» کارفرما پرداخت می‌گردد.'
        }),
        keyboard: buildActiveWorkKeyboard(false, true)
      })
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'occupation',
        action: 'start_workplace_shift',
        fallback: 'شروع شیفت ممکن نشد.'
      })
    }
  })

  bot.callbackQuery('work:status', async (ctx) => {
    const fromId = BigInt(ctx.from.id)
    const [status, overtime] = await Promise.all([
      container.workSessionService.getActiveSessionStatus(fromId),
      container.overtimeService.getOvertimeStatus(fromId)
    ])
    if (!status) {
      await ackCallback(ctx, 'شیفت کاری فعالی نداری')
      await handleSection(ctx, container, 'occupation', { edit: true })
      return
    }

    await ackCallback(ctx, 'به‌روزرسانی شد')
    const breakdown = status.calculation.breakdown
    const hint = productivityHint(breakdown)
    await editPanel(ctx, {
      text: panel({
        icon: '📊',
        title: 'شیفت جاری',
        sections: [
          {
            rows: [
              { label: '💼 شغل', value: status.session.jobTitle },
              { label: '⏱️ مدت کار', value: formatGameMinutes(status.calculation.elapsedMinutes) },
              ...(status.workplaceShift
                ? [
                    {
                      label: '💰 دستمزد',
                      value: 'در تسویهٔ کارفرما'
                    }
                  ]
                : [
                    { label: '💰 دستمزد ناخالص', value: money(status.calculation.totalEarnedMoney) },
                    { label: '🧾 مالیات (۵٪)', value: money(status.tax) },
                    { label: '💵 خالص تا این لحظه', value: `*${money(status.net)}*` },
                    {
                      label: '💵 دستمزد هر ساعت بازی',
                      value: money(ratePerGameHour(status.calculation.effectivePayPerMinute / 2))
                    }
                  ]),
              { label: '⭐ تجربه', value: `+${fa(status.calculation.earnedExperience)}` },
              { label: '⚡ خستگی', value: `+${fa(status.calculation.fatigueGained)}٪` }
            ]
          },
          {
            title: '⚙️ بهره‌وری این شیفت',
            lines: [
              `${barWithPercent(status.calculation.productivityScore, 8)}`,
              ...(status.calculation.fieldMatched
                ? ['✨ رشتهٔ تحصیلی‌ات با این کار هم‌حوزه است و دستمزدت را بالا برده.']
                : []),
              ...(hint ? [hint] : ['💪 همهٔ عامل‌ها در بهترین حالت‌اند.'])
            ]
          },
          // صادق‌بودنِ عدد: وقتی بدن به سقفش رسیده، عددِ "مدت کار" دیگر
          // جلو نمی‌رود. اگر این توضیح نباشد، بازیکنی که ساعت‌ها کار کرده و
          // همان عدد تکراری را می‌بیند فکر می‌کند بازی خراب است — در حالی
          // که دقیقاً همان لحظه، چرخهٔ خودکار شیفت را می‌بندد.
          ...(status.fatigueCapped
            ? [
                {
                  title: '⚠️ ظرفیت بدن تمام شد',
                  lines: [
                    'تمام توان بدنیِ این شیفت مصرف شد؛ بیش از این مزد ندارد.',
                    'چرخهٔ خودکار شیفت را می‌بندد و نتیجه‌اش را به تو خبر می‌دهد.',
                    'برای شیفت تازه، اول کمی استراحت کن.'
                  ]
                }
              ]
            : [])
        ],
        footer: status.fatigueCapped
          ? '⚡ بدن دیگر کار نمی‌کند؛ همین حالا «پایان کار» را بزن یا بگذار خودکار بسته شود.'
          : status.workplaceShift
          ? '💡 کارکرد این شیفت ثبت می‌شود و کارفرما در «تسویهٔ حقوق» پرداخت می‌کند.'
          : overtime.available
            ? `🔥 می‌توانی سخت‌تر کار کنی: دستمزد ۱٫۵ برابر، خستگی ۲ برابر (توان فعلی‌ات ${fa(Math.round(overtime.conditionFactor * 100))}٪).`
            : overtime.cooldownRemainingMin > 0
              ? `⏳ ${fa(overtime.cooldownRemainingMin)} دقیقه تا فشار بعدی.`
              : '⚡ اول کمی استراحت کن؛ با این توان فشارِ بیشتر فایده‌ای ندارد.'
      }),
      keyboard: buildActiveWorkKeyboard(overtime.available, status.workplaceShift)
    })
  })

  bot.callbackQuery('work:stop', async (ctx) => {
    const fromId = BigInt(ctx.from.id)
    try {
      const result = await container.workSessionService.stopWork(fromId)
      const workplaceEnded = result.workplace !== null
      await logPlayerEvent(
        container,
        fromId,
        GameEventType.SALARY_RECEIVED,
        workplaceEnded
          ? `پایان شیفت محل کار: ${result.session.jobTitle}`
          : `دریافت دستمزد از ${result.session.jobTitle}`,
        {
          detail: `${result.summary.elapsedMinutes.toLocaleString('fa-IR')} دقیقهٔ بازی کار`,
          amount: result.summary.totalEarnedMoney
        }
      )
      await ackCallback(ctx, workplaceEnded ? 'کارکرد ثبت شد' : 'دستمزد واریز شد')
      // کارت «نوبت کاری» و هشدار سلامت هر دو Lazy و بی‌خطر برای مسیر اصلی‌اند
      await container.dailyQuestService
        .trackByTelegramId(fromId, 'work_shift')
        .catch(() => undefined)
      await warnLowHealth(container, fromId)
      await editPanel(ctx, {
        text: panel({
          icon: '🛑',
          title: workplaceEnded ? 'پایان شیفت' : 'پایان کار',
          sections: [
            {
              rows: [
                { label: '💼 شغل', value: result.session.jobTitle },
                { label: '⏱️ مدت کار', value: formatGameMinutes(result.summary.elapsedMinutes) },
                ...(result.workplace
                  ? [
                      {
                        label: '🕐 کارکرد ثبت‌شده',
                        value: formatGameMinutes(result.workplace.workedMinutes)
                      },
                      { label: '💰 دستمزد', value: 'در تسویهٔ کارفرما' }
                    ]
                  : [
                      { label: '💰 دستمزد ناخالص', value: money(result.summary.totalEarnedMoney) },
                      { label: '🧾 مالیات (۵٪)', value: money(result.summary.tax ?? 0) },
                      {
                        label: '💵 خالص واریزشده',
                        value: `*${money(result.summary.net ?? result.summary.totalEarnedMoney)}*`
                      }
                    ]),
                { label: '⭐ تجربه', value: `+${fa(result.summary.earnedExperience)}` },
                { label: '⚡ خستگی', value: `+${fa(result.summary.fatigueGained)}٪` }
              ]
            }
          ],
          footer: workplaceEnded
            ? '💡 کارکردت در پنل «شغل من» دیده می‌شود و در تسویهٔ کارفرما پرداخت می‌گردد.'
            : '💡 برای رفع خستگی از بخش «خانه» استراحت کن.'
        }),
        keyboard: buildWorkBackKeyboard()
      })
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'occupation',
        action: 'stop_work',
        fallback: 'پایان کار ثبت نشد. دوباره تلاش کن.'
      })
    }
  })

  bot.callbackQuery('work:menu:full_time', async (ctx) => {
    await ackCallback(ctx)
    await editPanel(ctx, {
      text: panel({
        icon: '🏢',
        title: 'کار تمام‌وقت',
        sections: [
          {
            lines: [
              'دو مسیر داری:',
              '',
              '🔎 استخدام در شرکت دیگران با حقوق ثابت',
              '🏢 تأسیس کسب‌وکار خودت با سرمایه و سابقهٔ کافی'
            ]
          }
        ]
      }),
      keyboard: buildFullTimeMenuKeyboard()
    })
  })

  bot.callbackQuery('work:ft:new_biz', async (ctx) => {
    await ackCallback(ctx)
    await editPanel(ctx, {
      text: panel({
        icon: '🏢',
        title: 'تأسیس کسب‌وکار',
        sections: [
          {
            lines: [
              'یک مدل کسب‌وکار انتخاب کن.',
              'عدد روی هر دکمه، هزینهٔ راه‌اندازی است.'
            ]
          }
        ],
        footer: '💡 هزینه از کیف پول کسر می‌شود و به سابقهٔ کاری هم نیاز داری.'
      }),
      keyboard: buildBusinessBlueprintsKeyboard()
    })
  })

  bot.callbackQuery('work:ft:find_jobs', async (ctx) => {
    await ackCallback(ctx)
    await showJobPostingsPanel(ctx, container, 1)
  })

  bot.callbackQuery(/^job:page:/, async (ctx) => {
    const raw = parseInt(ctx.callbackQuery.data.split(':')[2] ?? '1', 10)
    await ackCallback(ctx)
    await showJobPostingsPanel(ctx, container, Number.isFinite(raw) && raw > 0 ? raw : 1)
  })

  // دکمهٔ اطلاع‌رسانی بدون عمل (وضعیت درخواست/رد خودکار)
  bot.callbackQuery('job:noop', async (ctx) => {
    await ackCallback(ctx)
  })

  bot.callbackQuery(/^job:open:/, async (ctx) => {
    await ackCallback(ctx)
    await showJobDetailPanel(ctx, container, ctx.callbackQuery.data.split(':')[2]!)
  })

  bot.callbackQuery(/^job:apply:/, async (ctx) => {
    const postingId = ctx.callbackQuery.data.split(':')[2]!
    const fromId = BigInt(ctx.from.id)
    try {
      await container.businessService.applyForJob(fromId, postingId)
      await ackCallback(ctx, '📨 درخواستت برای کارفرما ارسال شد')
      // پیش‌تر با JOB_STARTED ثبت می‌شد و بازیکن در تاریخچه «شروع کار» را
      // زیرِ «ارسال درخواست استخدام» می‌دید — درخواست که شروعِ کار نیست.
      await logPlayerEvent(container, fromId, GameEventType.JOB_APPLIED, 'ارسال درخواست استخدام')
      await showJobDetailPanel(ctx, container, postingId)
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'jobs',
        action: 'apply',
        fallback: 'ارسال درخواست انجام نشد.'
      })
    }
  })

  bot.callbackQuery('job:mine', async (ctx) => {
    await ackCallback(ctx)
    await showMyJobPanel(ctx, container)
  })

  bot.callbackQuery(/^job:withdraw:/, async (ctx) => {
    const applicationId = ctx.callbackQuery.data.split(':')[2]!
    const fromId = BigInt(ctx.from.id)
    try {
      await container.businessService.withdrawApplication(fromId, applicationId)
      await ackCallback(ctx, 'درخواستت پس گرفته شد')
      await showMyJobPanel(ctx, container)
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'jobs',
        action: 'withdraw',
        fallback: 'انصراف از درخواست انجام نشد.'
      })
    }
  })

  bot.callbackQuery('job:quit', async (ctx) => {
    const fromId = BigInt(ctx.from.id)
    await ackCallback(ctx)
    const jobs = await container.businessService.getMyJobView(fromId)
    if (jobs.length === 0) {
      await showMyJobPanel(ctx, container)
      return
    }
    await editPanel(ctx, {
      text: panel({
        icon: '🚪',
        title: 'تأیید استعفا',
        sections: [
          {
            lines: [
              `شغل فعلی: ${jobs[0]!.title} — ${jobs[0]!.businessName}`,
              'با استعفا، معوقات حقوقی‌ات همان‌جا از خزانه پرداخت می‌شود.',
              'اگر خزانه کافی نباشد، باقیمانده به‌عنوان بدهی کارفرما می‌ماند.'
            ]
          }
        ]
      }),
      keyboard: buildQuitConfirmKeyboard(jobs[0]!.id)
    })
  })

  bot.callbackQuery(/^job:quit_go:/, async (ctx) => {
    const employmentId = ctx.callbackQuery.data.split(':')[2]!
    const fromId = BigInt(ctx.from.id)
    try {
      const res = await container.businessService.resign(fromId, employmentId)
      await ackCallback(ctx, 'استعفا ثبت شد')
      await logPlayerEvent(container, fromId, GameEventType.JOB_FINISHED, 'استعفا از شغل', {
        amount: res.paid
      })
      await editPanel(ctx, {
        text: panel({
          icon: '📄',
          title: 'استعفا ثبت شد',
          sections: [
            {
              rows: [
                { label: '🏢 کارفرما', value: res.businessName },
                { label: '💰 تسویه‌شده', value: money(res.paid) },
                ...(res.unpaid > 0
                  ? [{ label: '🧾 باقیمانده به‌عنوان بدهی', value: money(res.unpaid) }]
                  : [])
              ]
            }
          ],
          footer: '💡 می‌توانی دوباره به آگهی‌ها سر بزنی.'
        }),
        keyboard: buildMyApplicationsKeyboard([])
      })
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'jobs',
        action: 'resign',
        fallback: 'استعفا ثبت نشد.'
      })
    }
  })

  // ── پنل‌های کارفرما: درخواست‌ها، کارمندان، آگهی‌سازی، برداشت سود ──
  bot.callbackQuery(/^biz:apps:/, async (ctx) => {
    await ackCallback(ctx)
    await showApplicationsPanel(ctx, container, ctx.callbackQuery.data.split(':')[2]!)
  })

  bot.callbackQuery(/^biz:emps:/, async (ctx) => {
    await ackCallback(ctx)
    await showEmployeesPanel(ctx, container, ctx.callbackQuery.data.split(':')[2]!)
  })

  // ── تغییر حقوق کارمند: سرویس کامل داشتیم اما هیچ مسیری به آن وصل نبود ──
  bot.callbackQuery(/^biz:setsal:/, async (ctx) => {
    const [, , businessId, employeePlayerId] = ctx.callbackQuery.data.split(':')
    const fromId = BigInt(ctx.from.id)
    try {
      const employees = await container.businessService.listEmployees(fromId, businessId!)
      const employee = employees.find((e) => e.playerId === employeePlayerId)
      if (!employee) {
        await ackCallback(ctx, 'این کارمند دیگر در تیم تو نیست؛ فهرست را به‌روزرسانی کن.', true)
        return
      }
      await ackCallback(ctx)
      await container.userStateRepository.upsert(fromId, {
        currentContext: `biz_salary:${businessId}:${employeePlayerId}`,
        stateData: { currentSalary: employee.salaryPerMinute, name: employee.name, title: employee.title }
      })
      await editPanel(ctx, {
        text: panel({
          icon: '💰',
          title: 'تغییر حقوق کارمند',
          sections: [
            {
              rows: [
                { label: '👷 کارمند', value: employee.name },
                { label: '💼 شغل', value: employee.title },
                {
                  label: '💵 حقوق فعلی',
                  value: `${money(ratePerGameHour(Number(employee.salaryPerMinute)))} در ساعت بازی`
                }
              ]
            },
            {
              lines: [
                'حقوق جدید را به «تومان در هر ساعت بازی» بنویس؛ همان واحدی که در فهرست کارکنان می‌بینی.',
                `مجاز: بین ${money(ratePerGameHour(POST_SALARY_MIN))} تا ${money(ratePerGameHour(POST_SALARY_MAX))} تومان در ساعت بازی؛ در هر نوبت حداکثر ۳ برابر یا نصفِ فعلی.`
              ]
            }
          ]
        }),
        keyboard: buildFlowCancelKeyboard(`biz:emps:${businessId}`)
      })
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'business',
        action: 'set_salary_start',
        fallback: 'بازکردن صفحهٔ تغییر حقوق ممکن نشد.'
      })
    }
  })

  // ── تغییر حجمِ قراردادِ کارمند: کارفرما تعیین می‌کند در هر ماه چند ساعت کار باشد ──
  bot.callbackQuery(/^biz:setvol:/, async (ctx) => {
    const [, , businessId, employeePlayerId] = ctx.callbackQuery.data.split(':')
    const fromId = BigInt(ctx.from.id)
    try {
      const employees = await container.businessService.listEmployees(fromId, businessId!)
      const employee = employees.find((e) => e.playerId === employeePlayerId)
      if (!employee) {
        await ackCallback(ctx, 'این کارمند دیگر در تیم تو نیست؛ فهرست را به‌روزرسانی کن.', true)
        return
      }
      await ackCallback(ctx)
      await container.userStateRepository.upsert(fromId, {
        currentContext: `biz_volume:${businessId}:${employeePlayerId}`,
        stateData: {
          currentHours: Math.round(employee.contractMinutesPerMonth / 60),
          name: employee.name,
          title: employee.title
        }
      })
      await editPanel(ctx, {
        text: panel({
          icon: '⏱',
          title: 'حجم قرارداد کارمند',
          sections: [
            {
              rows: [
                { label: '👷 کارمند', value: employee.name },
                { label: '💼 شغل', value: employee.title },
                {
                  label: '⏱ حجم فعلی',
                  value: `${fa(Math.round(employee.contractMinutesPerMonth / 60))} ساعت بازی در ماه`
                }
              ]
            },
            {
              lines: [
                'حجم را به «ساعت بازی در ماه» بنویس — یعنی کارمند در هر ماهِ بازی چند',
                'ساعت کار تحویل می‌دهد. حقوق فقط برای همان کارکرد پرداخت می‌شود.',
                `بازهٔ مجاز: ${fa(MIN_CONTRACT_GAME_HOURS_PER_MONTH)} تا ${fa(MAX_CONTRACT_GAME_HOURS_PER_MONTH)} ساعت در ماه.`,
                'مثال: `160` یا `۱۶۰`'
              ]
            }
          ]
        }),
        keyboard: buildFlowCancelKeyboard(`biz:emps:${businessId}`)
      })
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'business',
        action: 'set_contract_start',
        fallback: 'بازکردن صفحهٔ تغییر قرارداد ممکن نشد.'
      })
    }
  })

  // ── آگهی‌های بازِ کسب‌وکار + بستن دستی ──
  bot.callbackQuery(/^biz:postings:/, async (ctx) => {
    await ackCallback(ctx)
    await showPostingsPanel(ctx, container, ctx.callbackQuery.data.split(':')[2]!)
  })

  // بستن آگهی برگشت‌پذیر نیست (خودکار دوباره باز نمی‌شود)؛ پس پشت تأیید است.
  bot.callbackQuery(/^job:posting_close:/, async (ctx) => {
    const [, , businessId, postingId] = ctx.callbackQuery.data.split(':')
    const fromId = BigInt(ctx.from.id)
    try {
      const postings = await container.businessService.listOpenPostings(fromId, businessId!)
      const posting = postings.find((p) => p.id === postingId)
      if (!posting) {
        await ackCallback(ctx, 'این آگهی دیگر باز نیست؛ فهرست را به‌روزرسانی کن.', true)
        return
      }
      await ackCallback(ctx)
      await askForConfirmation(ctx, container, {
        kind: 'job_posting_close',
        payload: { businessId, postingId },
        icon: '🚫',
        title: 'تأیید بستن آگهی',
        rows: [
          { label: '📢 آگهی', value: posting.title },
          {
            label: '💵 حقوق',
            value: `${money(ratePerGameHour(Number(posting.salaryPerMinute)))} در ساعت بازی`
          },
          { label: '📨 درخواست‌های در انتظار', value: fa(posting._count.applications) }
        ],
        lines: [
          'آگهی بسته می‌شود و دیگر کسی نمی‌تواند درخواست بدهد.',
          'برای جذب دوباره باید آگهی تازه بسازی.'
        ],
        footer: '⚠️ بستن آگهی با پرشدن ظرفیت فرق دارد؛ آگهیِ دستی دوباره باز نمی‌شود.'
      })
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'business',
        action: 'posting_close',
        fallback: 'بستن آگهی انجام نشد.'
      })
    }
  })

  // استخدام یک تعهد مالیِ جاری می‌سازد؛ مثلِ استعفا و اخراج پشتِ تأیید است.
  bot.callbackQuery(/^job:hire:/, async (ctx) => {
    const applicationId = ctx.callbackQuery.data.split(':')[2]!
    const fromId = BigInt(ctx.from.id)
    try {
      const businessId = await container.businessService.getApplicationBusinessId(applicationId)
      // listApplications مالکیت کسب‌وکار را هم احراز می‌کند
      const applications = await container.businessService.listApplications(fromId, businessId)
      const application = applications.find((a) => a.id === applicationId)
      if (!application) {
        await ackCallback(ctx, 'این درخواست دیگر باز نیست؛ فهرست را به‌روزرسانی کن.', true)
        return
      }
      await ackCallback(ctx)
      await askForConfirmation(ctx, container, {
        kind: 'job_hire',
        payload: { applicationId },
        ...confirmationPreviews.jobHire(
          `${application.player.firstName} ${application.player.lastName ?? ''}`.trim(),
          application.jobPosting.title,
          Number(application.jobPosting.salaryPerMinute)
        )
      })
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'business',
        action: 'hire',
        fallback: 'پذیرش درخواست انجام نشد.'
      })
    }
  })

  bot.callbackQuery(/^job:rej:/, async (ctx) => {
    const applicationId = ctx.callbackQuery.data.split(':')[2]!
    const fromId = BigInt(ctx.from.id)
    try {
      const businessId = await container.businessService.getApplicationBusinessId(applicationId)
      await container.businessService.rejectApplication(fromId, applicationId)
      await ackCallback(ctx, 'درخواست رد شد')
      await showApplicationsPanel(ctx, container, businessId)
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'business',
        action: 'reject',
        fallback: 'رد درخواست انجام نشد.'
      })
    }
  })

  // اخراج هم پول می‌دهد هم پلِ پشت سر را خراب می‌کند؛ پس تأیید می‌خواهد.
  bot.callbackQuery(/^job:fire:/, async (ctx) => {
    const [, , businessId, employeePlayerId] = ctx.callbackQuery.data.split(':')
    const fromId = BigInt(ctx.from.id)
    try {
      const employees = await container.businessService.listEmployees(fromId, businessId!)
      const employee = employees.find((e) => e.playerId === employeePlayerId)
      if (!employee) {
        await ackCallback(ctx, 'این کارمند دیگر در تیم تو نیست؛ فهرست را به‌روزرسانی کن.', true)
        return
      }
      await ackCallback(ctx)
      await askForConfirmation(ctx, container, {
        kind: 'job_fire',
        payload: { businessId, employeePlayerId },
        ...confirmationPreviews.jobFire(employee.name, employee.title, employee.unpaidSalary)
      })
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'business',
        action: 'fire',
        fallback: 'اخراج انجام نشد.'
      })
    }
  })

  bot.callbackQuery(/^biz:postjob:/, async (ctx) => {
    const businessId = ctx.callbackQuery.data.split(':')[2]!
    const fromId = BigInt(ctx.from.id)
    await ackCallback(ctx)
    try {
      const businesses = await container.businessService.listOwnerBusinesses(fromId)
      const business = businesses.find((b) => b.id === businessId)
      if (!business) {
        await editPanel(ctx, {
          text: '⚠️ این کسب‌وکار دیگر در فهرست تو نیست.',
          keyboard: buildWorkBackKeyboard()
        })
        return
      }
      await container.userStateRepository.upsert(fromId, {
        currentContext: `biz_job_title:${businessId}`,
        stateData: bizJobDraftToState(bizJobDraftDefaults(business.name))
      })
      await editPanel(ctx, {
        text: panel({
          icon: '📢',
          title: 'عنوان شغل',
          sections: [
            {
              lines: [
                'عنوان آگهی را بنویس (بین ۳ تا ۴۰ نویسه).',
                'مثال: فروشنده، برنامه‌نویس، حسابدار.'
              ]
            }
          ]
        }),
        keyboard: buildFlowCancelKeyboard('biz:jf:cancel')
      })
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'business',
        action: 'postjob_start',
        fallback: 'سازندهٔ آگهی باز نشد.'
      })
    }
  })

  const adjustWizard = async (ctx: Context): Promise<void> => {
    const parts = (ctx.callbackQuery?.data ?? '').split(':')
    const action = parts[2] ?? ''
    const fromId = BigInt(ctx.from!.id)
    await ackCallback(ctx)
    try {
      const state = await container.userStateRepository.findByTelegramUserId(fromId)
      const businessId =
        state?.currentContext && state.currentContext.startsWith('biz_job:')
          ? state.currentContext.slice('biz_job:'.length)
          : null
      if (!businessId) {
        await editPanel(ctx, {
          text: '⏳ سازندهٔ آگهی فعال نیست؛ از پنل کسب‌وکار دوباره شروع کن.',
          keyboard: buildWorkBackKeyboard()
        })
        return
      }
      const businesses = await container.businessService.listOwnerBusinesses(fromId)
      const business = businesses.find((b) => b.id === businessId)
      if (!business) {
        await editPanel(ctx, {
          text: '⚠️ کسب‌وکار یافت نشد.',
          keyboard: buildWorkBackKeyboard()
        })
        return
      }
      const draft = bizJobDraftOf(state?.stateData, business.name)

      if (action === 'sal') {
        const delta = parseInt(parts[3] ?? '0', 10)
        draft.salary = Math.min(3_000, Math.max(100, draft.salary + delta))
      } else if (action === 'hrs') {
        const delta = parseInt(parts[3] ?? '0', 10)
        draft.contractHours = clampContractHours(draft.contractHours + delta)
      } else if (action === 'salin') {
        // عدد دلخواه: بازیکن در «تومان در ساعت بازی» می‌نویسد و فقط همین‌جا به
        // واحدِ ذخیره‌سازی تبدیل می‌شود؛ دکمه‌های ± فقط برای تنظیم دقیق می‌مانند.
        await container.userStateRepository.upsert(fromId, {
          currentContext: `biz_jobsal:${businessId}`,
          stateData: bizJobDraftToState(draft)
        })
        await editPanel(ctx, {
          text: panel({
            icon: '💰',
            title: 'حقوق دلخواه',
            sections: [
              {
                rows: [
                  {
                    label: '💵 حقوق فعلی',
                    value: `${money(ratePerGameHour(draft.salary))} در ساعت بازی`
                  }
                ]
              },
              {
                lines: [
                  'حقوق را به «تومان در هر ساعت بازی» بنویس؛ همان واحدی که در پیش‌نمایش می‌بینی.',
                  `بازهٔ مجاز: ${money(ratePerGameHour(POST_SALARY_MIN))} تا ${money(ratePerGameHour(POST_SALARY_MAX))} تومان در ساعت بازی.`,
                  'مثال: `1500` یا `۱٬۵۰۰` یا `۱٫۵ هزار`'
                ]
              }
            ]
          }),
          keyboard: buildFlowCancelKeyboard('biz:jf:cancel')
        })
        return
      } else if (action === 'cap') {
        const delta = parseInt(parts[3] ?? '0', 10)
        const capLimit = Math.min(20, business.employeeCapacity)
        draft.capacity = Math.min(capLimit, Math.max(1, draft.capacity + delta))
      } else if (action === 'exp') {
        const delta = parseInt(parts[3] ?? '0', 10)
        draft.minExp = Math.min(5_000, Math.max(0, draft.minExp + delta))
      } else if (action === 'deg') {
        draft.degreeIdx = (draft.degreeIdx + 1) % BIZ_DEGREE_CYCLE.length
      } else if (action === 'age') {
        draft.ageIdx = (draft.ageIdx + 1) % BIZ_AGE_BANDS.length
      } else if (action === 'save') {
        const band = BIZ_AGE_BANDS[draft.ageIdx] ?? BIZ_AGE_BANDS[0]!

        // ادعای اتمیک: دو کلیکِ همزمانِ «ذخیره» هر دو پیش‌نویس را می‌خوانند
        // ولی فقط یکی state را می‌بَرد و آگهی ثبت می‌کند (پیش‌تر `postJob`
        // بدون کلید ضدتکرار بود و دوبارزدن، آگهیِ یکسان دوم می‌ساخت).
        const claimed = await container.userStateRepository.claimContext(fromId, `biz_job:${businessId}`)
        if (!claimed) {
          await editPanel(ctx, {
            text: panel({
              icon: '⏳',
              title: 'در حال ثبت',
              sections: [
                {
                  lines: [
                    'دوباره زدی؛ وضعیت آگهی را از پنل کسب‌وکار ببین.',
                    'اگر ثبت با خطا مواجه شد، دوباره آگهی را بساز.'
                  ]
                }
              ]
            }),
            keyboard: buildBusinessManageKeyboard(businessId)
          })
          return
        }

        try {
          const posting = await container.businessService.postJob(fromId, businessId, {
            title: draft.title,
            salaryPerMinute: draft.salary,
            capacity: draft.capacity,
            minExperience: draft.minExp,
            minAge: band.min,
            maxAge: band.max,
            requiredDegree: BIZ_DEGREE_CYCLE[draft.degreeIdx]!,
            requiredSkill: null,
            contractGameHoursPerMonth: draft.contractHours
          })
          await editPanel(ctx, {
            text: panel({
              icon: '📣',
              title: 'آگهی ثبت شد',
              sections: [
                {
                  rows: [
                    { label: '📄 شغل', value: posting.title },
                    {
                      label: '💰 حقوق',
                      value: `${money(ratePerGameHour(Number(posting.salaryPerMinute)))} در ساعت بازی`
                    },
                    {
                      label: '⏱ حجم ماهانه',
                      value: `${fa(Math.round(posting.contractMinutesPerMonth / 60))} ساعت بازی در ماه`
                    },
                    { label: '👥 ظرفیت', value: `${fa(posting.capacity)} نفر` }
                  ]
                }
              ],
              footer: '💡 درخواست‌ها از پنل کسب‌وکار ← «درخواست‌ها» رسیدگی می‌شوند.'
            }),
            keyboard: buildBusinessManageKeyboard(businessId)
          })
        } catch (saveError) {
          // خطا (مثلاً سقف آگهی‌های باز): پیش‌نویس را برگردان تا جریان ادامه
          // پیدا کند و فقط بعد از حل مشکل دوباره ثبت شود.
          await container.userStateRepository
            .upsert(fromId, { currentContext: `biz_job:${businessId}`, stateData: bizJobDraftToState(draft) })
            .catch(() => undefined)
          throw saveError
        }
        return
      }

      await container.userStateRepository.upsert(fromId, {
        currentContext: `biz_job:${businessId}`,
        stateData: bizJobDraftToState(draft)
      })
      await renderBizJobWizard(ctx, draft, business.employeeCapacity)
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'business',
        action: 'postjob_wizard',
        fallback: 'تنظیم آگهی انجام نشد.'
      })
    }
  }

  // «حقوق دلخواه» جریان متنی دارد و الگوی `sal:` آن را نمی‌گیرد (بدون دونقطه).
  bot.callbackQuery('biz:jf:salin', adjustWizard)
  bot.callbackQuery(/^biz:jf:sal:/, adjustWizard)
  bot.callbackQuery(/^biz:jf:cap:/, adjustWizard)
  bot.callbackQuery(/^biz:jf:hrs:/, adjustWizard)
  bot.callbackQuery(/^biz:jf:exp:/, adjustWizard)
  bot.callbackQuery('biz:jf:deg', adjustWizard)
  bot.callbackQuery('biz:jf:age', adjustWizard)
  bot.callbackQuery('biz:jf:save', adjustWizard)

  bot.callbackQuery('biz:jf:cancel', async (ctx) => {
    const fromId = BigInt(ctx.from.id)
    await ackCallback(ctx, 'آگهی ساخته نشد')
    await container.userStateRepository.clear(fromId)
    await handleSection(ctx, container, 'my_biz', { edit: true })
  })

  bot.callbackQuery('biz:jf:title', async (ctx) => {
    const fromId = BigInt(ctx.from.id)
    await ackCallback(ctx)
    const state = await container.userStateRepository.findByTelegramUserId(fromId)
    const businessId =
      state?.currentContext && state.currentContext.startsWith('biz_job:')
        ? state.currentContext.slice('biz_job:'.length)
        : null
    if (!businessId) {
      await editPanel(ctx, {
        text: '⏳ سازندهٔ آگهی فعال نیست؛ از پنل کسب‌وکار دوباره شروع کن.',
        keyboard: buildWorkBackKeyboard()
      })
      return
    }
    await container.userStateRepository.upsert(fromId, {
      currentContext: `biz_job_title:${businessId}`,
      stateData: state?.stateData ?? bizJobDraftToState(bizJobDraftDefaults('کسب‌وکار'))
    })
    await editPanel(ctx, {
      text: '✏️ عنوان تازهٔ آگهی را بنویس (بین ۳ تا ۴۰ نویسه):',
      keyboard: buildFlowCancelKeyboard('biz:jf:cancel')
    })
  })

  bot.callbackQuery(/^biz:profit_all:/, async (ctx) => {
    const businessId = ctx.callbackQuery.data.split(':')[2]!
    const fromId = BigInt(ctx.from.id)
    try {
      const res = await container.businessService.withdrawProfit(fromId, businessId, null)
      await ackCallback(ctx, 'سود به کیف پول رسید')
      await editPanel(ctx, {
        text: panel({
          icon: '💵',
          title: 'برداشت سود',
          sections: [
            {
              rows: [
                { label: '🧾 از خزانه', value: money(res.gross) },
                { label: '🏛️ مالیات ۱۵٪', value: money(res.tax) },
                { label: '💰 به کیف تو', value: money(res.net) },
                { label: '🏦 خزانه پس از برداشت', value: money(res.treasuryAfter) }
              ]
            }
          ],
          footer: '💡 برای پرداخت حقوق، همیشه چیزی در خزانه بگذار.'
        }),
        keyboard: buildBusinessManageKeyboard(businessId)
      })
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'business',
        action: 'withdraw_profit',
        fallback: 'برداشت سود انجام نشد.'
      })
    }
  })

  bot.callbackQuery(/^biz:profit:/, async (ctx) => {
    const businessId = ctx.callbackQuery.data.split(':')[2]!
    const fromId = BigInt(ctx.from.id)
    await ackCallback(ctx)
    try {
      const businesses = await container.businessService.listOwnerBusinesses(fromId)
      const business = businesses.find((b) => b.id === businessId)
      const treasury = business ? Number(business.treasury) : 0
      await container.userStateRepository.upsert(fromId, {
        currentContext: `biz_profit:${businessId}`,
        stateData: {}
      })
      await editPanel(ctx, {
        text: panel({
          icon: '💵',
          title: 'برداشت سود',
          sections: [
            {
              lines: [
                `موجودی خزانه: ${money(treasury)}`,
                'مبلغ برداشت را عددی بفرست (تومان).',
                '۱۵٪ مالیات بر درآمد شرکت کسر می‌شود.',
                'برداشتِ کل، خزانه را برای حقوق کارمندان خالی می‌کند.'
              ]
            }
          ]
        }),
        keyboard: buildFlowCancelKeyboard('work:menu:my_biz')
      })
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'business',
        action: 'withdraw_prompt',
        fallback: 'درخواست برداشت باز نشد.'
      })
    }
  })

  bot.callbackQuery('work:menu:my_biz', async (ctx) => {
    const fromId = BigInt(ctx.from.id)
    // این دکمه هدف «انصراف» جریان‌های متنی کسب‌وکار هم هست؛ state باید پاک شود
    // تا پیام بعدی بازیکن به‌عنوان مبلغ/عنوان مصرف نشود.
    await container.userStateRepository.clear(fromId)
    const businesses = await container.businessService.listOwnerBusinesses(fromId)
    await ackCallback(ctx)

    if (businesses.length === 0) {
      await editPanel(ctx, {
        text: renderBusinessList([]),
        keyboard: buildWorkBackKeyboard()
      })
      return
    }

    // تک‌شرکتی: مستقیم پنل مدیریت؛ چندشرکتی: اول انتخاب شرکت
    if (businesses.length === 1) {
      await editPanel(ctx, {
        text: renderBusinessList(businesses as never),
        keyboard: buildBusinessManageKeyboard(businesses[0]!.id)
      })
      return
    }

    await editPanel(ctx, {
      text: renderBusinessList(businesses as never),
      keyboard: buildBusinessSelectKeyboard(
        businesses.map((b) => ({ id: b.id, name: b.name }))
      )
    })
  })

  // انتخاب یک شرکت از فهرست چندشرکتی و باز کردن پنل مدیریت آن
  bot.callbackQuery(/^biz:manage:/, async (ctx) => {
    const businessId = ctx.callbackQuery.data.split(':')[2]!
    const fromId = BigInt(ctx.from.id)
    try {
      const businesses = await container.businessService.listOwnerBusinesses(fromId)
      const business = businesses.find((b) => b.id === businessId)
      await ackCallback(ctx)
      if (!business) {
        await editPanel(ctx, {
          text: renderBusinessList(businesses as never),
          keyboard: buildBusinessSelectKeyboard(
            businesses.map((b) => ({ id: b.id, name: b.name }))
          )
        })
        return
      }
      await editPanel(ctx, {
        text: renderBusinessList([business] as never),
        keyboard: buildBusinessManageKeyboard(business.id)
      })
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'business',
        action: 'manage_select',
        fallback: 'باز کردن پنل کسب‌وکار ممکن نشد.'
      })
    }
  })

  bot.callbackQuery(/^biz:create:/, async (ctx) => {
    const modelType = ctx.callbackQuery.data.split(':')[2]!
    await ackCallback(ctx)
    const blueprint = container.businessService.getBlueprints().find((b) => b.modelType === modelType)
    if (!blueprint) {
      await ackCallback(ctx, 'این نوع کسب‌وکار موجود نیست؛ پنل را به‌روزرسانی کن.', true)
      return
    }
    try {
      // تأسیس کسب‌وکار هزینهٔ راه‌اندازیِ سنگین دارد و تعطیل‌کردنش هزینهٔ
      // راه‌اندازی را برنمی‌گرداند؛ پس پیش از کسر پول تأیید می‌گیریم.
      await askForConfirmation(ctx, container, {
        kind: 'biz_create',
        ...confirmationPreviews.businessBlueprint(modelType, container),
        payload: { modelType, title: blueprint.title }
      })
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'business',
        action: 'create',
        fallback: 'صفحهٔ تأیید تأسیس باز نشد.'
      })
    }
  })

  // ---------- انتقال پول بین بازیکنان ----------
  bot.callbackQuery(/^transfer:confirm:/, async (ctx) => {
    const token = ctx.callbackQuery.data.split(':')[2]!
    const fromId = BigInt(ctx.from.id)
    try {
      // ادعای اتمیکِ تک‌مصرف: دو کلیکِ پشت‌سرهم هر دو این‌جا می‌رسند، ولی فقط
      // یکی state را می‌بَرد. دومی پیام «دیگر فعال نیست» می‌بیند، نه انتقال دوم.
      const payload = await container.userStateRepository.consumeScopedConfirmation(
        fromId,
        ctx.chat!.id,
        'act',
        token
      )
      if (!payload) {
        await ackCallback(ctx, 'این تأیید پیش‌تر استفاده شده یا منقضی شده است.', true)
        await editPanel(ctx, {
          text: panel({
            icon: '⏳',
            title: 'این تأیید دیگر فعال نیست',
            sections: [
              {
                lines: [
                  'اگر انتقال انجام شده، در «دفتر مالی» می‌بینیش.',
                  'برای انتقال تازه، دوباره روی پیام بازیکن ریپلای کن.'
                ]
              }
            ]
          }),
          // قدمِ بعدی در خودِ چت است، نه در پنل بانک؛ پس فقط «بستن» می‌ماند.
          keyboard: buildClosePanelKeyboard()
        })
        return
      }

      const receiverTelegramId = BigInt(String(payload.receiverTelegramId))
      const amount = Number(payload.amount)
      const rail = payload.rail === 'bank' ? 'bank' : 'cash'

      if (rail === 'bank') {
        const result = await container.bankTransferService.execute(
          fromId,
          receiverTelegramId,
          amount
        )
        await ackCallback(ctx, '🏦 انتقال بانکی انجام شد')
        await editPanel(ctx, {
          text: panel({
            icon: '✅',
            title: 'انتقال بانکی انجام شد',
            sections: [
              {
                rows: [
                  { label: '👤 گیرنده', value: result.receiverName },
                  { label: '💵 مبلغ', value: `*${money(result.gross)}*` },
                  { label: '🧾 مالیات', value: money(result.tax) },
                  { label: '✅ رسیده به گیرنده', value: money(result.net) },
                  { label: '🏦 موجودی تازهٔ تو', value: money(result.senderBankBalance) }
                ]
              },
              {
                lines: [
                  `📊 سقفِ باقی‌ماندهٔ امروز: ${money(result.remainingToday)}`,
                  result.taxToRegion
                    ? '💡 مالیات به صندوق منطقه رسید.'
                    : '💡 مالیات در دفتر جهانی ثبت شد.'
                ]
              }
            ],
            footer: result.receiverNotified
              ? '💡 به گیرنده پیام داده شد و در «اعلان‌های» او هم ثبت شد.'
              : '💡 در «اعلان‌های» گیرنده ثبت شد.'
          }),
          keyboard: buildTransferDoneKeyboard()
        })
        return
      }

      const result = await container.transferService.execute(fromId, receiverTelegramId, amount)
      await ackCallback(ctx, '💸 انتقال انجام شد')

      await editPanel(ctx, {
        text: panel({
          icon: '✅',
          title: 'انتقال انجام شد',
          sections: [
            {
              rows: [
                { label: '👤 گیرنده', value: result.receiverName },
                { label: '💵 مبلغ', value: `*${money(result.amount)}*` },
                { label: '👛 موجودی تازهٔ تو', value: money(result.senderBalance) }
              ]
            }
          ],
          footer: result.receiverNotified
            ? '💡 به گیرنده پیام داده شد و در «اعلان‌های» او هم ثبت شد.'
            : '💡 در «اعلان‌های» گیرنده ثبت شد.'
        }),
        keyboard: buildTransferDoneKeyboard()
      })
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'transfer',
        action: 'confirm',
        fallback: 'انتقال پول انجام نشد.'
      })
    }
  })

  bot.callbackQuery('transfer:help', async (ctx) => {
    await ackCallback(ctx)
    await editPanel(ctx, {
      text: panel({
        icon: '💸',
        title: 'انتقال پول به بازیکن',
        sections: [
          { lines: transferHowToLines() },
          {
            title: 'قانون‌ها',
            lines: [
              '• انتقال نقدی از کیف پول تو می‌رود؛ بانکی دست‌نخورده می‌ماند.',
              `• ${transferLimitsText()}`,
              `• ${bankTransferLimitsText()}`,
              '• هر انتقال در «دفتر مالی» هر دو نفر ثبت می‌شود.',
              '• گیرنده پیام خصوصی می‌گیرد و در «اعلان‌های» او می‌نشیند.'
            ]
          }
        ]
      }),
      keyboard: buildTransferHelpKeyboard()
    })
  })

  bot.callbackQuery('transfer:cancel', async (ctx) => {
    await container.userStateRepository.clear(BigInt(ctx.from.id))
    await ackCallback(ctx, 'انتقال لغو شد')
    await editPanel(ctx, {
      text: panel({
        icon: '✖️',
        title: 'انتقال لغو شد',
        sections: [{ lines: ['پولی جابه‌جا نشد.'] }]
      }),
      keyboard: buildTransferCancelledKeyboard()
    })
  })

  // Education Callbacks
  bot.callbackQuery('edu:main', async (ctx) => {
    const fromId = BigInt(ctx.from.id)
    const eduStatus = await container.educationService.getPlayerEducationStatus(fromId)
    await ackCallback(ctx)
    await editPanel(ctx, {
      text: renderEducationPanel(eduStatus),
      keyboard: buildEducationMenuKeyboard(
        eduStatus.enrollment.canGraduate,
        eduStatus.enrollment.isStudying
      )
    })
  })

  bot.callbackQuery('edu:refresh', async (ctx) => {
    const fromId = BigInt(ctx.from.id)
    const eduStatus = await container.educationService.getPlayerEducationStatus(fromId)
    await ackCallback(ctx, 'وضعیت تحصیلی به‌روزرسانی شد')
    await editPanel(ctx, {
      text: renderEducationPanel(eduStatus),
      keyboard: buildEducationMenuKeyboard(
        eduStatus.enrollment.canGraduate,
        eduStatus.enrollment.isStudying
      )
    })
  })

  bot.callbackQuery('edu:choose_field', async (ctx) => {
    const fromId = BigInt(ctx.from.id)
    await ackCallback(ctx)

    // «مقطع بعدی» برای هر رشته از مدرک فعلی همین بازیکن محاسبه می‌شود؛
    // رشته‌ای که مقطع بالاتری ندارد اصلاً دکمه نمی‌گیرد تا بازیکن دکمهٔ
    // بی‌اثر نبیند (پیش‌تر همهٔ دکمه‌ها فقط کارشناسی می‌دادند).
    const player = await container.playerRepository.findByTelegramUserId(fromId)
    if (!player) {
      await sendPanel(ctx, { text: texts.noProfile })
      return
    }
    const currentDegree = (player.currentDegree as DegreeLevel) ?? DegreeLevel.DIPLOMA
    const entries = EDUCATION_FIELDS.flatMap((field) => {
      const degree = nextEnrollableDegree(currentDegree, field)
      return degree
        ? [{ key: field.key, degree, title: field.title, baseTuitionCost: field.baseTuitionCost }]
        : []
    })

    if (entries.length === 0) {
      await editPanel(ctx, {
        text: panel({
          icon: '🎓',
          title: 'پایان نردبان تحصیلی',
          sections: [
            {
              lines: [
                `مدرک فعلی‌ات «${degreeLabels[currentDegree]}» است و دیگر مقطعی بالاتر از آن ارائه نمی‌شود.`,
                'امتیاز اعتباری و درآمدت از همین مدرک بهره می‌برد.'
              ]
            }
          ],
          footer: '💡 می‌توانی به «وضعیت من» یا «آمار» برگردی.'
        }),
        keyboard: buildEducationBackKeyboard()
      })
      return
    }

    await editPanel(ctx, {
      text: panel({
        icon: '📚',
        title: 'انتخاب رشته',
        sections: [
          { lines: ['برای هر رشته، مقطع بعدیِ قابل‌ثبت‌نامت را می‌بینی.', 'رشتهٔ موردنظرت را انتخاب کن.'] }
        ],
        footer: '💡 شهریه از کیف پول کسر می‌شود و مدرک بالاتر درآمد بیشتری می‌آورد.'
      }),
      keyboard: buildEducationFieldsKeyboard(entries)
    })
  })

  bot.callbackQuery(/^edu:enroll:/, async (ctx) => {
    const [, , fieldKey, degree] = ctx.callbackQuery.data.split(':')
    await ackCallback(ctx)
    try {
      // انتخاب رشته مسیر تحصیلی و شغلی بازیکن را عوض می‌کند؛ پس پیش از اجرا
      // صفحهٔ تأیید می‌آید (لایهٔ مشترک `confirm-action`).
      await askForConfirmation(ctx, container, {
        kind: 'edu_enroll',
        ...confirmationPreviews.educationField(fieldKey!, degree!),
        payload: { fieldKey: fieldKey!, degree: degree! }
      })
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'education',
        action: 'enroll',
        fallback: 'صفحهٔ تأیید ثبت‌نام باز نشد.'
      })
    }
  })

  bot.callbackQuery('edu:graduate', async (ctx) => {
    const fromId = BigInt(ctx.from.id)
    try {
      const grad = await container.educationService.graduate(fromId)
      await logPlayerEvent(
        container,
        fromId,
        GameEventType.EDUCATION_COMPLETED,
        `فارغ‌التحصیلی: ${grad.degreeLabel} ${grad.fieldTitle}`
      )
      await ackCallback(ctx, 'مدرک صادر شد')
      await editPanel(ctx, {
        text: panel({
          icon: '🎉',
          title: 'فارغ‌التحصیلی',
          sections: [
            {
              rows: [
                { label: '📚 رشته', value: grad.fieldTitle },
                { label: '🎓 مدرک', value: grad.degreeLabel },
                { label: '⭐ تجربه', value: `+${fa(grad.gainedExp)}` }
              ]
            }
          ],
          footer: '💡 مهارت‌های مرتبط هم به شخصیتت اضافه شد.'
        }),
        keyboard: buildEducationBackKeyboard()
      })
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'education',
        action: 'graduate',
        fallback: 'صدور مدرک انجام نشد.'
      })
    }
  })

  // Text message Router — سریع و کم‌هزینه
  bot.on('message:text', async (ctx) => {
    const raw = ctx.message.text
    if (!raw || raw.startsWith('/')) {
      return
    }

    const trimmed = raw.trim()
    const normalized = normalizePersianText(raw)
    const fromIdForOps = BigInt(ctx.from!.id)

    // عبارت‌های مدیریتی پیش از هر چیز دیگری سنجیده می‌شوند: نوشتن عینِ
    // «پنل ادمین» هیچ‌وقت ورودی معتبرِ جریان دیگری نیست. کاربر غیرادمین
    // کاملاً بی‌پاسخ می‌ماند تا وجود پنل مدیریت فاش نشود.
    const adminPhrase = adminPhraseOf(normalized)
    if (adminPhrase) {
      await handleAdminPhrase(ctx, container, adminPhrase)
      return
    }

    // State پیش از نرمال‌سازی بررسی می‌شود چون ورودی‌های آزاد (مبلغ، قیمت)
    // ممکن است فقط رقم لاتین باشند و نرمال‌ساز آن‌ها را خالی می‌کند
    // TTL فقط در مخزن تعریف می‌شود (تا پیش‌تر یک کپیِ هم‌عدد ولی
    // ناسازگار همین‌جا بود). انقضاء گزارش می‌شود تا پایین‌تر بتوان به
    // بازیکن گفت جریانِ قبلی تمام شده، نه اینکه ساکت بمانیم.
    const { state: pendingState, expiredContext } =
      await container.userStateRepository.findByTelegramUserIdWithExpiry(fromIdForOps)
    let pendingContext = pendingState?.currentContext ?? null

    // ناوبری صریح بر جریانِ نیمه‌کاره اولویت دارد: اگر متن دقیقاً یک کلیدواژهٔ
    // بخش باشد، یعنی بازیکن آگاهانه می‌خواهد جابه‌جا شود و نباید پیامش به‌عنوان
    // «ورودی» جریان قبلی مصرف شود. ثبت‌نام مستثناست (آنبوردینگ مسدودکننده با
    // لغو صریح). نام حیوان/آگهی که عیناً کلیدواژه باشد قربانی این قاعده است؛
    // رفتار قابل‌پیش‌بینی به‌مراتب ارزشمندتر از نام‌گذاری «کار» برای حیوان است.
    const explicitNavigation = normalized ? EXACT_SECTIONS[normalized] : undefined
    if (explicitNavigation && pendingContext && pendingContext !== 'registration') {
      await container.userStateRepository.clear(fromIdForOps)
      pendingContext = null
    }

    // ── گاردِ «شخصیت فوت‌شده» روی جریان‌های ورودی ──
    //
    // جریان‌های «ورودیِ آزاد» (نامِ حیوان، قیمتِ اجاره، پیشنهاد حراجی، مبلغ
    // سپرده، سودِ کسب‌وکار و…) با یک `currentContext` در UserState کار
    // می‌کنند و ورودی بعدیِ بازیکن را مصرف می‌کنند. این کلیدها پیشوندِ
    // callback نیستند، پس میان‌افزارِ سراسریِ سیاست محیط — که مرگ را می‌گیرد —
    // آن‌ها را نمی‌بیند. نتیجه: بازیکنی که *پیش از مرگ* یکی از این جریان‌ها
    // را باز کرده بود، می‌توانست بعد از مرگ با یک پیام ساده آن را تمام کند و
    // مثلاً برای شخصیتِ فوت‌شده حیوان بخرد یا آگهی بگذارد.
    //
    // این‌جا یک نقطهٔ مرکزی است: اگر شخصیت مرده باشد، جریانِ نیمه‌کاره
    // پاک می‌شود و به‌جای اجرا، همان پیامِ «پایان داستان» نشان داده می‌شود.
    // `support_text` عمداً مستثناست (اعتراض باید ثبت شود) و مسیر مدیریت هم
    // دست‌نخورده می‌ماند تا اختیار ادمین سلب نشود.
    if (pendingContext && isMutatingInputFlow(pendingContext)) {
      // `actorStanding` و نه یک مقایسهٔ دستیِ وضعیت: قاعدهٔ «چه کسی اجازهٔ
      // کنش دارد» یک منبع دارد و مسدودها هم مشمول همین قفل‌اند.
      // پیش‌تر این‌جا فقط `DEAD` سنجیده می‌شد و حسابِ مسدود از همان حفره
      // رد می‌شد: مسدودسازی، `UserState` را پاک نمی‌کند، پس جریانی که
      // *پیش از* مسدودشدن باز شده بود با یک پیام ساده تمام می‌شد.
      const standing = await actorStanding(container, fromIdForOps)
      if (standing !== 'active') {
        await container.userStateRepository.clear(fromIdForOps)
        await sendPanel(ctx, {
          text: blockedActorPanel(standing),
          keyboard: buildClosePanelKeyboard()
        })
        return
      }
    }

    if (pendingContext === 'bank_deposit' || pendingContext === 'bank_withdraw') {
      await handleBankAmountText(ctx, container, pendingContext)
      return
    }

    // جریان‌های ورودی سیستم‌های تکمیل‌شده (مهریه، نام حیوان، قرض، حراج، آگهی)
    if (pendingContext === 'family_mahr') {
      await handleFamilyProposeText(ctx, container)
      return
    }
    if (pendingContext?.startsWith('family_set_mahr:')) {
      await handleFamilySetMahrText(ctx, container, pendingContext.slice('family_set_mahr:'.length))
      return
    }
    if (pendingContext === 'family_gift') {
      await handleFamilyGiftText(ctx, container)
      return
    }
    if (pendingContext?.startsWith('biz_job_title:')) {
      await handleBizJobTitleText(ctx, container, pendingContext.slice('biz_job_title:'.length))
      return
    }
    if (pendingContext?.startsWith('biz_jobsal:')) {
      await handleBizJobSalaryText(ctx, container, pendingContext.slice('biz_jobsal:'.length))
      return
    }
    if (pendingContext?.startsWith('biz_profit:')) {
      await handleBizProfitText(ctx, container, pendingContext.slice('biz_profit:'.length))
      return
    }
    if (pendingContext?.startsWith('biz_volume:')) {
      const [, , businessId, employeePlayerId] = pendingContext.split(':')
      await handleSetContractText(ctx, container, businessId!, employeePlayerId!)
      return
    }

    if (pendingContext?.startsWith('biz_salary:')) {
      const [, businessId, employeePlayerId] = pendingContext.split(':')
      await handleBizSalaryText(ctx, container, businessId!, employeePlayerId!)
      return
    }
    if (pendingContext?.startsWith('pet_name:')) {
      await handlePetNameText(ctx, container, pendingContext.slice('pet_name:'.length))
      return
    }
    if (pendingContext === 'loan_request') {
      await handleLoanRequestText(ctx, container)
      return
    }
    // وصیت: انتخاب وارث (ریپلای/یوزرنیم/شناسهٔ عددی) و یادداشت آزاد
    if (pendingContext === 'will_heir') {
      await handleWillHeirText(ctx, container)
      return
    }
    if (pendingContext === 'will_note') {
      await handleWillNoteText(ctx, container)
      return
    }
    if (pendingContext?.startsWith('auction_bid:')) {
      await handleAuctionBidText(ctx, container, pendingContext.slice('auction_bid:'.length))
      return
    }
    if (pendingContext === 'ad_text') {
      await handleAdText(ctx, container)
      return
    }
    // گزارش پشتیبانی: متنِ آزاد است و می‌تواند فقط رقم یا لاتین باشد، پس پیش
    // از گاردِ `!normalized` بررسی می‌شود.
    if (pendingContext?.startsWith('support_text:')) {
      await handleSupportText(ctx, container, pendingContext.slice('support_text:'.length))
      return
    }

    // جریان‌های ورودی پنل ادمین (جست‌وجو، مبلغ، سطح مهارت)
    if (pendingContext?.startsWith('adm:')) {
      const handled = await handleAdminInputText(ctx, container, pendingContext, trimmed)
      if (handled) {
        return
      }
    }


    // ثبت آگهی بازار: شناسهٔ کالا در خود Context حمل می‌شود
    if (pendingContext?.startsWith('market_sell:')) {
      const inventoryId = pendingContext.slice('market_sell:'.length)
      const handled = await handleMarketSellText(ctx, container, inventoryId, trimmed)
      if (handled) {
        return
      }
    }

    // افتتاح سپرده: کلید پلن در خود Context حمل می‌شود
    if (pendingContext?.startsWith('deposit_open:')) {
      const planKey = pendingContext.slice('deposit_open:'.length)
      const handled = await handleDepositAmountText(ctx, container, planKey, trimmed)
      if (handled) {
        return
      }
    }

    // تعیین اجاره‌بها: شناسهٔ ملک در خود Context حمل می‌شود
    if (pendingContext?.startsWith('rental_price:')) {
      const propertyId = pendingContext.slice('rental_price:'.length)
      const handled = await handleRentalPriceText(ctx, container, propertyId, trimmed)
      if (handled) {
        return
      }
    }

    // کمک به پروژهٔ شهر با مبلغ دلخواه: کلیدِ پروژه در خود Context حمل می‌شود
    if (pendingContext?.startsWith('project_amount:')) {
      const projectKey = pendingContext.slice('project_amount:'.length)
      const handled = await handleProjectDonationAmountText(
        ctx,
        container,
        projectKey,
        trimmed
      )
      if (handled) {
        return
      }
    }

    // ثبت‌نام پیش از گارد `!normalized` بررسی می‌شود: بیوگرافیِ فقط-ایموجی،
    // فقط-عدد یا فقط-لاتین نرمال‌ساز فارسی را خالی برمی‌گرداند و اگر گارد
    // زودتر می‌زد، متن خام هرگز به `handleRegistrationText` نمی‌رسید و
    // بازیکن بی‌صدا در مرحلهٔ بیوگرافی گیر می‌ماند.
    if (pendingContext === 'registration') {
      // متن خام (نه نرمال‌شده) به ثبت‌نام می‌رسد تا بیوگرافی ایموجی، عدد و
      // حروف لاتین خودش را از دست ندهد. لغو با همان متن خام سنجیده می‌شود.
      const handled = await handleRegistrationText(ctx, container, trimmed)
      if (handled) {
        return
      }
    }

    if (!normalized) {
      return
    }

    // شناسایی سریع Intent قبل از هر Query دیتابیس (پرفورمنس گروه)
    const section = explicitNavigation
    const isCancel = isCancelWord(normalized)
    const isIdentityReply =
      normalized === 'شناسنامه' && Boolean(ctx.message.reply_to_message?.from)

    // انتقال پول با ریپلای روی پیام بازیکن مقصد: «انتقال ۵۰۰۰۰۰».
    // مبلغ از متنِ خام خوانده می‌شود، چون نرمال‌ساز فارسی رقم‌ها را دور می‌ریزد.
    const transferCommand: TransferCommand = ctx.message.reply_to_message?.from
      ? parseTransferCommand(raw)
      : { kind: 'none' }
    const isTransferReply = transferCommand.kind !== 'none'

    // اگر متن هیچ Intent معتبری ندارد، بی‌صدا نادیده گرفته می‌شود — مگر
    // اینکه بازیکن همین حالا از یک جریانِ ورودیِ منقضی برگشته باشد. در آن
    // حالت سکوت یعنی بن‌بست: ربات از او ورودی خواسته، او نوشته، و هیچ
    // اتفاقی نیفتاده. پس یک‌بار روشن گفته می‌شود که آن جریان تمام شده.
    if (!section && !isCancel && !isIdentityReply && !isTransferReply) {
      if (expiredContext) {
        await container.userStateRepository.clear(fromIdForOps)
        await sendPanel(ctx, {
          text: panel({
            icon: '⏳',
            title: 'آن جریان تمام شده بود',
            sections: [
              {
                lines: [
                  'مدتی از آخرین مرحله گذشته بود، پس ورودیِ نیمه‌تمام حفظ نشد.',
                  'چه چیزی را می‌خواستی کامل کنی؟ دوباره از پنلِ همان بخش شروع کن.',
                  '',
                  expiredFlowHint(expiredContext)
                ]
              }
            ]
          }),
          keyboard: buildClosePanelKeyboard()
        })
        return
      }
      return
    }

    if (isCancel) {
      // همهٔ جریان‌های مصرف‌کننده لغوِ خودشان را بالاتر مدیریت کرده‌اند؛ این‌جا
      // فقط stateهای غیرمصرف‌کننده (پیش‌نویس آگهی، state کهنه) می‌ماند. بدون
      // state باز، «انصراف» اتفاقی بی‌صدا رد می‌شود تا پیام گمراه‌کننده ندهد.
      if (!pendingContext) {
        return
      }
      await container.userStateRepository.clear(fromIdForOps)
      await sendPanel(ctx, {
        text: panel({
          icon: '✖️',
          title: 'لغو شد',
          sections: [{ lines: ['جریان نیمه‌کاره بسته شد و هیچ تغییری ثبت نشد.'] }]
        })
      })
      return
    }

    // توقف خودکار کار در صورت خستگی بحرانی (فقط برای Intentهای معتبر)
    const fatigueStop = await container.workSessionService.autoStopIfCriticallyFatigued(
      fromIdForOps
    )
    if (fatigueStop) {
      await sendPanel(ctx, {
        text: panel({
          icon: '⚠️',
          title: 'خستگی بحرانی',
          sections: [
            {
              lines: ['خستگی‌ات به مرز بحرانی رسید و کار خودکار متوقف شد.']
            },
            {
              rows: [
                { label: '💼 شغل', value: fatigueStop.session.jobTitle },
                { label: '⏱️ مدت کار', value: `${fa(fatigueStop.summary.elapsedMinutes)} دقیقهٔ بازی` },
                { label: '💰 دستمزد ناخالص', value: money(fatigueStop.summary.totalEarnedMoney) },
                { label: '🧾 مالیات (۵٪)', value: money(fatigueStop.summary.tax ?? 0) },
                { label: '💵 خالص واریزشده', value: `*${money(fatigueStop.summary.net ?? fatigueStop.summary.totalEarnedMoney)}*` },
                { label: '⚡ خستگی', value: `+${fa(fatigueStop.summary.fatigueGained)}٪` }
              ]
            }
          ],
          footer: isGroupContext(ctx.chat?.type)
            ? '💡 برای رفع خستگی از بخش «خانه» استراحت کن.'
            : '💡 برای رفع خستگی، در گروه منطقه‌ات از بخش «خانه» استراحت کن.'
        })
      })
    }

    if (isIdentityReply) {
      await handleReplyIdentity(ctx, container)
      return
    }

    if (isTransferReply) {
      await handleTransferReply(ctx, container, transferCommand)
      return
    }

    if (section) {
      // همگام‌سازی گروه (بدون ساختن): گروهِ ثبت‌نشده هرگز از مسیر کلیدواژهٔ
      // بازیکن ساخته نمی‌شود؛ راه‌اندازی فقط با /start مدیر است. این فراخوانی
      // فقط گروهِ موجود را تازه می‌کند (Cooldown یک‌دقیقه‌ای) و برای گروهِ
      // ثبت‌نشده، گارد بخش‌های گروهی پیام «راه‌اندازی نشده» نشان می‌دهد.
      if (isGroupContext(ctx.chat?.type)) {
        await handleGroupContext(ctx, container)
      }

      // موتور فعالیت: اولین فعالیت معتبر در گروه، اقامت اولیه را ثبت می‌کند
      const activity = await container.activityService.registerActivity(
        fromIdForOps,
        isGroupContext(ctx.chat?.type) && ctx.chat ? BigInt(ctx.chat.id) : null,
        section
      )

      if (activity.residenceEstablished) {
        await sendPanel(ctx, {
          text: panel({
            icon: '🏡',
            title: 'محل اقامت ثبت شد',
            sections: [
              {
                lines: [
                  `از این پس «${activity.residenceTitle ?? 'همین منطقه'}» محل زندگی تو است.`,
                  '',
                  'حضور در گروه‌های دیگر اقامتت را تغییر نمی‌دهد.',
                  'برای تغییر رسمی محل زندگی از بخش «محل زندگی» استفاده کن.'
                ]
              }
            ]
          })
        })
      }

      // مُهر سفر و کارت «فعالیت گروهی» فقط با شناسه‌های آماده جلو می‌روند
      // (بدون Query تازه) و هیچ‌کدام مسیر اصلی را نمی‌شکنند
      if (activity.playerId && activity.groupId) {
        await trackGroupActivity(container, activity.playerId, activity.groupId, ctx)
      }

      await handleSection(ctx, container, section)

      // انتشار خودکار خبرهای مهم منطقه؛ Cooldown داخلی سرویس مانع Spam است
      await broadcastRegionNews(ctx, container)
    }
  })
}

/**
 * مُهر سفر + پیشرفت کارت «فعالیت گروهی».
 *
 * مُهر تازه پیام کوتاه جشن می‌گیرد چون یک‌بار در عمر هر منطقه رخ می‌دهد.
 * هر دو مسیر خطاهایشان را می‌بلعند تا فعالیت بازیکن هرگز شکست نخورد.
 */
async function trackGroupActivity(
  container: Container,
  playerId: string,
  groupId: string,
  ctx: Context
): Promise<void> {
  const [stamped] = await Promise.all([
    container.passportService.stamp(playerId, groupId).catch(() => false),
    container.dailyQuestService.track(playerId, 'group_activity').catch(() => undefined),
    // چالش هفتگی منطقه با هر فعالیت معتبر جمعی جلو می‌رود
    container.challengeService.addProgress(groupId, playerId).catch(() => undefined)
  ])

  if (!stamped) {
    return
  }

  try {
    const board = await container.passportService.getBoard(BigInt(ctx.from!.id))
    await ctx.reply(
      panel({
        icon: '🧿',
        title: 'مُهر تازه در گذرنامه',
        sections: [
          {
            lines: [
              'اولین فعالیتت در این منطقه ثبت شد و مُهر سفر گرفتی!',
              `🧭 مجموع مُهرها: ${fa(board.total)} از ${fa(board.travelerTarget)} برای نشان جهانگرد`
            ]
          }
        ]
      }),
      { parse_mode: 'Markdown' }
    )
  } catch (error) {
    logger.debug({ err: error, feature: 'passport', action: 'stamp_notice' }, 'stamp notice skipped')
  }
}

/**
 * ارسال خبرهای مهم منتشرنشدهٔ منطقه در همان گروه.
 *
 * بدون این مسیر، رخدادهای اولویت‌دار (تکمیل پروژه، برندهٔ انتخابات، رکورد جمعیت)
 * فقط با ارسال دستی «خبر» دیده می‌شدند و `publishedAt` هرگز پر نمی‌شد.
 * خطا هرگز به بازیکن نشان داده نمی‌شود.
 */
async function broadcastRegionNews(ctx: Context, container: Container): Promise<void> {
  if (!isGroupContext(ctx.chat?.type) || !ctx.chat) {
    return
  }

  let claimed: Awaited<ReturnType<typeof container.newsService.claimForChat>> = []
  try {
    claimed = await container.newsService.claimForChat(BigInt(ctx.chat.id))
    if (claimed.length === 0) {
      return
    }

    await ctx.reply(
      panel({
        icon: '📣',
        title: 'خبر فوری منطقه',
        sections: [
          {
            lines: claimed.map(
              (item) => `• ${item.title}${item.detail ? `\n  ${item.detail}` : ''}`
            )
          }
        ],
        footer: '📰 برای دیدن همهٔ خبرها کلمهٔ «خبر» را بفرست.'
      }),
      { parse_mode: 'Markdown' }
    )
  } catch (error) {
    // ارسال شکست خورد: خبر نباید «منتشرشده» بماند و برای همیشه گم شود.
    // نشانهٔ انتشار برمی‌گردد تا در پنجرهٔ بعدی دوباره تلاش شود (Cooldown
    // سرویس دست‌نخورده می‌ماند تا حلقهٔ تلاش-شکست ساخته نشود).
    if (claimed.length > 0) {
      await container.newsService
        .releaseClaim(claimed.map((item) => item.id))
        .catch(() => 0)
    }
    logger.debug({ err: error, feature: 'news', action: 'broadcast' }, 'news broadcast skipped')
  }
}

async function handleBankAmountText(
  ctx: Context,
  container: Container,
  context: 'bank_deposit' | 'bank_withdraw'
): Promise<void> {
  const fromId = BigInt(ctx.from!.id)
  const raw = (ctx.message?.text ?? '').trim()

  if (isCancelWord(raw)) {
    await container.userStateRepository.clear(fromId)
    await sendPanel(ctx, { text: texts.bankCancel, keyboard: buildBankBackKeyboard() })
    return
  }

  const amount = parseAmountInput(raw)
  if (amount === null) {
    await sendPanel(ctx, { text: texts.invalidAmount, keyboard: buildBankCancelKeyboard() })
    return
  }

  try {
    if (context === 'bank_deposit') {
      const res = await container.bankingService.deposit(fromId, amount)
      await container.userStateRepository.clear(fromId)
      await logPlayerEvent(container, fromId, GameEventType.BANK_DEPOSIT, 'واریز به حساب بانکی', {
        amount
      })
      await container.dailyQuestService
        .trackByTelegramId(fromId, 'bank_deposit')
        .catch(() => undefined)
      await sendPanel(ctx, {
        text: panel({
          icon: '✅',
          title: 'واریز موفق',
          sections: [
            {
              rows: [
                { label: '📥 مبلغ واریز', value: money(amount) },
                { label: '💵 کیف پول', value: money(res.walletBalance) },
                { label: '💳 حساب بانکی', value: money(res.bankBalance) }
              ]
            }
          ]
        }),
        keyboard: buildBankBackKeyboard()
      })
      return
    }

    const res = await container.bankingService.withdraw(fromId, amount)
    await container.userStateRepository.clear(fromId)
    await logPlayerEvent(container, fromId, GameEventType.BANK_WITHDRAW, 'برداشت از حساب بانکی', {
      amount
    })
    await sendPanel(ctx, {
      text: panel({
        icon: '✅',
        title: 'برداشت موفق',
        sections: [
          {
            rows: [
              { label: '📤 مبلغ برداشت', value: money(amount) },
              { label: '💵 کیف پول', value: money(res.walletBalance) },
              { label: '💳 حساب بانکی', value: money(res.bankBalance) }
            ]
          }
        ]
      }),
      keyboard: buildBankBackKeyboard()
    })
  } catch (err) {
    if (err instanceof AppError) {
      await sendPanel(ctx, {
        text: panel({
          icon: '⚠️',
          title: 'عملیات بانکی انجام نشد',
          sections: [{ lines: err.persianMessage.split('\n') }]
        }),
        keyboard: buildBankCancelKeyboard()
      })
      return
    }
    logger.error(
      { err, feature: 'banking', action: context, userId: ctx.from?.id },
      'bank amount input failed'
    )
    await sendPanel(ctx, { text: texts.invalidAmount, keyboard: buildBankCancelKeyboard() })
  }
}

/** خطای جریان ورودی: پیام سرویس + دکمهٔ انصراف برای تلاش دوباره. */
async function sendInputFlowError(
  ctx: Context,
  err: unknown,
  feature: string,
  action: string,
  cancelKeyboard: Parameters<typeof sendPanel>[1]['keyboard'],
  fallback: string
): Promise<void> {
  if (err instanceof AppError) {
    await sendPanel(ctx, {
      text: panel({
        icon: '⚠️',
        title: 'عملیات انجام نشد',
        sections: [{ lines: err.persianMessage.split('\n') }]
      }),
      keyboard: cancelKeyboard
    })
    return
  }
  logger.error({ err, feature, action, userId: ctx.from?.id }, 'input flow failed')
  await sendPanel(ctx, {
    text: panel({
      icon: '⚠️',
      title: 'عملیات انجام نشد',
      sections: [{ lines: [fallback] }]
    }),
    keyboard: cancelKeyboard
  })
}

/**
 * حالت‌های سازندهٔ آگهی استخدام — draft در UserState.stateData زندگی می‌کند
 * تا هر دکمه یک پنلِ تنها را ویرایش کند (قاعدهٔ «یک عمل = یک پیام»).
 */
interface BizJobDraft {
  title: string
  salary: number
  capacity: number
  minExp: number
  degreeIdx: number
  ageIdx: number
  /** حجمِ قراردادِ ماهانه — در «ساعت بازی در ماه»، همان واحدی که بازیکن می‌فهمد. */
  contractHours: number
}

const BIZ_DEGREE_CYCLE = [
  'DIPLOMA',
  'ASSOCIATE',
  'BACHELOR',
  'MASTER',
  'DOCTORATE'
] as const

const BIZ_AGE_BANDS = [
  { label: 'آزاد', min: null, max: null },
  { label: '۱۸ تا ۳۵', min: 18, max: 35 },
  { label: '۱۸ تا ۵۰', min: 18, max: 50 },
  { label: '۳۵ به بالا', min: 35, max: null }
] as const

function bizJobDraftDefaults(businessName: string): BizJobDraft {
  return {
    title: `کارمند ${businessName}`,
    salary: 400,
    capacity: 1,
    minExp: 0,
    degreeIdx: 0,
    ageIdx: 0,
    // پیش‌فرض کار تمام‌وقت: ۸ ساعت بازی در روز × ۳۰ روز = ۲۴۰ ساعت در ماه
    contractHours: MAX_CONTRACT_GAME_HOURS_PER_MONTH
  }
}

/** مهار حجم قرارداد در بازهٔ رسمی — در یک جا، تا هیچ مسیری عدد بیرونی نپذیرد. */
function clampContractHours(hours: number): number {
  const safe = Number.isFinite(hours) ? Math.round(hours) : MAX_CONTRACT_GAME_HOURS_PER_MONTH
  return Math.min(MAX_CONTRACT_GAME_HOURS_PER_MONTH, Math.max(MIN_CONTRACT_GAME_HOURS_PER_MONTH, safe))
}

function bizJobDraftOf(stateData: unknown, businessName: string): BizJobDraft {
  const base = bizJobDraftDefaults(businessName)
  if (!stateData || typeof stateData !== 'object') {
    return base
  }
  const raw = stateData as Record<string, unknown>
  const num = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback
  return {
    title: typeof raw.title === 'string' && raw.title.length > 0 ? raw.title : base.title,
    salary: num(raw.salary, base.salary),
    capacity: num(raw.capacity, base.capacity),
    minExp: num(raw.minExp, base.minExp),
    degreeIdx: num(raw.degreeIdx, base.degreeIdx) % BIZ_DEGREE_CYCLE.length,
    ageIdx: num(raw.ageIdx, base.ageIdx) % BIZ_AGE_BANDS.length,
    contractHours: clampContractHours(num(raw.contractHours, base.contractHours))
  }
}

function bizJobDraftToState(draft: BizJobDraft): Record<string, number | string> {
  return {
    title: draft.title,
    salary: draft.salary,
    capacity: draft.capacity,
    minExp: draft.minExp,
    degreeIdx: draft.degreeIdx,
    ageIdx: draft.ageIdx,
    contractHours: draft.contractHours
  }
}

const BIZ_DEGREE_FA: Record<string, string> = {
  DIPLOMA: 'دیپلم',
  ASSOCIATE: 'کاردانی',
  BACHELOR: 'کارشناسی',
  MASTER: 'کارشناسی ارشد',
  DOCTORATE: 'دکتری'
}

async function renderBizJobWizard(
  ctx: Context,
  draft: BizJobDraft,
  employeeCapacity: number
): Promise<void> {
  const band = BIZ_AGE_BANDS[draft.ageIdx] ?? BIZ_AGE_BANDS[0]!
  // سقفِ ماهانهٔ هر کارمند = نرخ × حجمِ قرارداد. «۸ ساعت در روز» دیگر یک
  // قانونِ پشت‌صحنه نیست؛ کارفرما خودش حجم را می‌بَرد و همان عدد سقف می‌شود.
  const contractHours = clampContractHours(draft.contractHours)
  const monthlyCeiling = Math.round(ratePerGameHour(draft.salary) * contractHours)
  await editPanel(ctx, {
    text: panel({
      icon: '📢',
      title: 'سازندهٔ آگهی',
      sections: [
        {
          title: draft.title,
          rows: [
            {
              label: '💰 حقوق',
              value: `${money(ratePerGameHour(draft.salary))} در ساعت بازی`
            },
            {
              label: '⏱ حجم ماهانه',
              value: `${fa(contractHours)} ساعت بازی در ماه`
            },
            { label: '🧾 سقف حقوق ماهانه', value: money(monthlyCeiling) },
            {
              label: '💸 هزینهٔ ماهانهٔ تیم',
              value: money(monthlyCeiling * draft.capacity)
            },
            { label: '👥 ظرفیت', value: `${fa(draft.capacity)} از ${fa(employeeCapacity)}` },
            { label: '⭐ حداقل سابقه', value: fa(draft.minExp) },
            {
              label: '🎓 حداقل مدرک',
              value: BIZ_DEGREE_FA[BIZ_DEGREE_CYCLE[draft.degreeIdx]!] ?? 'دیپلم'
            },
            { label: '🎂 شرط سنی', value: band.label }
          ]
        },
        {
          lines: [
            '💡 حقوق فقط برای کاری است که کارمند واقعاً ثبت می‌کند — تا سقفِ همین',
            'حجم ماهانه. هرچه تیم کامل‌تر، درآمد شرکت بالاتر — اما از «نیاز نیرو»',
            'که عبور کنی فقط زیان است.'
          ]
        }
      ]
    }),
    keyboard: buildJobWizardKeyboard(true)
  })
}

/** فهرست آگهی‌های بازِ بازیکنان، صفحه‌ای. */
/** صفحهٔ اصلیِ راهنما — با میان‌برِ تازه‌کار فقط برای کسی که شخصیت ندارد. */
async function openHelpMain(
  ctx: Context,
  container: Container,
  edit: boolean
): Promise<void> {
  const payload = {
    text: HELP_MAIN_TEXT,
    keyboard: await helpMainKeyboardFor(container, BigInt(ctx.from!.id))
  }
  if (edit) {
    await editPanel(ctx, payload)
    return
  }
  await sendPanel(ctx, payload)
}

async function showJobPostingsPanel(
  ctx: Context,
  container: Container,
  page: number
): Promise<void> {
  try {
    const result = await container.businessService.listOpenJobs(page)
    if (result.total === 0) {
      await editPanel(ctx, {
        text: renderJobPostingsPanel([], 1, 1),
        keyboard: buildWorkBackKeyboard()
      })
      return
    }
    await editPanel(ctx, {
      text: renderJobPostingsPanel(result.postings, result.page, result.pages),
      keyboard: buildJobPostingsKeyboard(result.postings, result.page, result.pages)
    })
  } catch (err) {
    await handleCallbackError(ctx, err, {
      feature: 'jobs',
      action: 'list',
      fallback: 'فهرست آگهی‌ها باز نشد.'
    })
  }
}

async function showJobDetailPanel(
  ctx: Context,
  container: Container,
  postingId: string
): Promise<void> {
  const fromId = BigInt(ctx.from!.id)
  try {
    const { posting, problems, applicationStatus } =
      await container.businessService.getPostingForPlayer(fromId, postingId)
    const applied =
      applicationStatus !== null && applicationStatus !== 'REJECTED' && applicationStatus !== 'CANCELLED'
    await editPanel(ctx, {
      text: renderJobDetailPanel(posting, problems),
      keyboard: buildJobDetailKeyboard(
        posting.id,
        applied,
        problems,
        applicationStatus === 'ACCEPTED'
      )
    })
  } catch (err) {
    await handleCallbackError(ctx, err, {
      feature: 'jobs',
      action: 'detail',
      fallback: 'جزئیات آگهی باز نشد.'
    })
  }
}

async function showMyJobPanel(
  ctx: Context,
  container: Container,
  show: typeof editPanel | typeof sendPanel = editPanel
): Promise<void> {
  const fromId = BigInt(ctx.from!.id)
  try {
    const [jobs, applications] = await Promise.all([
      container.businessService.getMyJobView(fromId),
      container.businessService.listMyApplications(fromId)
    ])
    await show(ctx, {
      text: renderMyJobPanel(
        jobs,
        applications.map((a) => ({
          title: a.jobPosting.title,
          businessName: a.jobPosting.business.name
        }))
      ),
      keyboard:
        jobs.length > 0
          ? buildMyJobKeyboard(true)
          : buildMyApplicationsKeyboard(applications.map((a) => ({ id: a.id })))
    })
  } catch (err) {
    // مسیر دکمه با ack پاسخ می‌گیرد؛ مسیر پیام متنی با پنل (وگرنه بی‌صدا می‌ماند)
    if (ctx.callbackQuery) {
      await handleCallbackError(ctx, err, {
        feature: 'jobs',
        action: 'mine',
        fallback: 'پنل شغل من باز نشد.'
      })
      return
    }
    if (err instanceof AppError) {
      await sendPanel(ctx, {
        text: panel({
          icon: '⚠️',
          title: 'انجام نشد',
          sections: [{ lines: err.persianMessage.split('\n') }]
        }),
        keyboard: buildClosePanelKeyboard()
      })
      return
    }
    logger.error({ err, feature: 'jobs', action: 'mine', userId: ctx.from?.id }, 'my job panel failed')
    await sendPanel(ctx, {
      text: panel({
        icon: '⚠️',
        title: 'پنل شغل من باز نشد',
        sections: [{ lines: ['لطفاً چند لحظه بعد دوباره تلاش کن.'] }]
      }),
      keyboard: buildClosePanelKeyboard()
    })
  }
}

export async function showApplicationsPanel(
  ctx: Context,
  container: Container,
  businessId: string
): Promise<void> {
  const fromId = BigInt(ctx.from!.id)
  try {
    const apps = await container.businessService.listApplications(fromId, businessId)
    await editPanel(ctx, {
      text: renderBusinessStaffPanel(
        'درخواست‌های استخدام',
        'درخواست‌های باز',
        apps.map((app) => ({
          lines: [
            `👤 *${app.player.firstName} ${app.player.lastName ?? ''}`.trim(),
            `   درخواست: ${app.jobPosting.title} · ${money(ratePerGameHour(Number(app.jobPosting.salaryPerMinute)))} در ساعت بازی`
          ]
        })),
        'درخواست بازیکنی نرسیده است؛ برای جذب نیرو آگهی بگذار.'
      ),
      keyboard: buildBusinessStaffKeyboard(
        apps.slice(0, 5).flatMap((app) => [
          { text: `✅ پذیرش ${app.player.firstName}`, cb: `job:hire:${app.id}` },
          { text: `❌ رد ${app.player.firstName}`, cb: `job:rej:${app.id}` }
        ]),
        `biz:manage:${businessId}`
      )
    })
  } catch (err) {
    await handleCallbackError(ctx, err, {
      feature: 'business',
      action: 'applications',
      fallback: 'فهرست درخواست‌ها باز نشد.'
    })
  }
}

export async function showEmployeesPanel(
  ctx: Context,
  container: Container,
  businessId: string
): Promise<void> {
  const fromId = BigInt(ctx.from!.id)
  try {
    const employees = await container.businessService.listEmployees(fromId, businessId)
    await editPanel(ctx, {
      text: renderBusinessStaffPanel(
        'کارمندان فعال',
        `${employees.length} نفر در تیم`,
        employees.map((e) => ({
          lines: [
            `👷 *${e.name}* — ${e.title}`,
            `   حقوق ${money(ratePerGameHour(Number(e.salaryPerMinute)))} در ساعت بازی`,
            `   ⏱ قرارداد ${fa(Math.round(e.contractMinutesPerMonth / 60))} ساعت در ماه · سقف ${money(e.monthlyCeiling)}${
              e.unpaidSalary > 0 ? ` · بدهی معوق ${money(e.unpaidSalary)}` : ''
            }`
          ]
        })),
        'هنوز کارمندی نداری؛ با «آگهی استخدام» نیرو جذب کن.'
      ),
      keyboard: buildBusinessStaffKeyboard(
        // هر کارمند دو عمل دارد: تغییر حقوق (تعهد مالیِ جاری) و اخراج.
        employees
          .slice(0, 6)
          .flatMap((e) => [
            {
              text: `💰 حقوق ${e.name}`,
              cb: `biz:setsal:${businessId}:${e.playerId}`
            },
            {
              text: `⏱ حجم ${e.name}`,
              cb: `biz:setvol:${businessId}:${e.playerId}`
            },
            {
              text: `🚪 اخراج ${e.name}`,
              cb: `job:fire:${businessId}:${e.playerId}`
            }
          ]),
        `biz:manage:${businessId}`
      )
    })
  } catch (err) {
    await handleCallbackError(ctx, err, {
      feature: 'business',
      action: 'employees',
      fallback: 'فهرست کارمندان باز نشد.'
    })
  }
}

/** پنل آگهی‌های بازِ یک کسب‌وکار با دکمهٔ بستنِ دستی هر آگهی. */
export async function showPostingsPanel(
  ctx: Context,
  container: Container,
  businessId: string
): Promise<void> {
  const fromId = BigInt(ctx.from!.id)
  try {
    const postings = await container.businessService.listOpenPostings(fromId, businessId)
    await editPanel(ctx, {
      text: renderBusinessStaffPanel(
        'آگهی‌های باز',
        `${postings.length} آگهی فعال`,
        postings.map((p) => ({
          lines: [
            `📢 *${p.title}* — ${money(ratePerGameHour(Number(p.salaryPerMinute)))} در ساعت بازی`,
            `   ظرفیت ${fa(p.capacity - p.hiredCount)} صندلی خالی · ${fa(p._count.applications)} درخواست در انتظار`
          ]
        })),
        'آگهی بازی نداری. با «آگهی استخدام» نیرو جذب کن؛ آگهیِ بسته‌شده با خالی‌شدن صندلی دوباره باز نمی‌شود.'
      ),
      keyboard: buildBusinessStaffKeyboard(
        postings.slice(0, 8).map((p) => ({
          text: `🚫 بستن آگهی «${p.title}»`,
          cb: `job:posting_close:${businessId}:${p.id}`
        })),
        `biz:manage:${businessId}`
      )
    })
  } catch (err) {
    await handleCallbackError(ctx, err, {
      feature: 'business',
      action: 'owner_postings',
      fallback: 'فهرست آگهی‌ها باز نشد.'
    })
  }
}

/**
 * تعیین مهریه توسط زن (ورودی متنی از پنل خانواده).
 * قواعد و پیام‌های خطا از یک منبع می‌آیند: `modules/family/mahr`.
 */
async function handleFamilySetMahrText(
  ctx: Context,
  container: Container,
  proposalId: string
): Promise<void> {
  const fromId = BigInt(ctx.from!.id)
  const raw = (ctx.message?.text ?? '').trim()

  if (isCancelWord(raw)) {
    await container.userStateRepository.clear(fromId)
    await showFamilyPanelAfterInput(ctx, container, '✖️ تعیین مهریه لغو شد.')
    return
  }

  const parsed = parseMahrInput(raw, false)
  if (parsed.kind === 'invalid') {
    await sendPanel(ctx, {
      text: panel({
        icon: '⚠️',
        title: 'مهریه ثبت نشد',
        sections: [{ lines: [parsed.message] }]
      }),
      keyboard: buildFamilyCancelKeyboard()
    })
    return
  }
  if (parsed.kind === 'unset') {
    // در این جریان صفر معنا ندارد؛ زن دارد مهریه را «تعیین» می‌کند.
    await sendPanel(ctx, {
      text: panel({
        icon: '⚠️',
        title: 'مهریه ثبت نشد',
        sections: [{ lines: ['مهریه نمی‌تواند صفر باشد؛ مبلغی که می‌پسندی را بنویس.'] }]
      }),
      keyboard: buildFamilyCancelKeyboard()
    })
    return
  }

  const amount = parsed.amount
  try {
    await container.marriageService.setMahr(fromId, proposalId, amount)
    await container.userStateRepository.clear(fromId)
    await sendPanel(ctx, {
      text: panel({
        icon: '⚖️',
        title: 'مهریه تعیین شد',
        sections: [
          {
            rows: [{ label: '💍 مهریه', value: money(amount) }],
            lines: ['مبلغ برای خواستگار ارسال شد؛ پس از تأیید او عقد ثبت می‌شود.']
          }
        ]
      }),
      keyboard: buildClosePanelKeyboard()
    })
  } catch (err) {
    await sendInputFlowError(
      ctx,
      err,
      'family',
      'set_mahr',
      buildFamilyCancelKeyboard(),
      'تعیین مهریه انجام نشد.'
    )
  }
}

/** بازگشت به پنل خانواده پس از پایان یک جریان ورودی. */
async function showFamilyPanelAfterInput(
  ctx: Context,
  container: Container,
  notice: string
): Promise<void> {
  try {
    const view = await container.marriageService.getView(BigInt(ctx.from!.id))
    await sendPanel(ctx, {
      text: `${notice}\n\n${renderFamilyPanel(view)}`,
      keyboard: buildFamilyKeyboard(view)
    })
  } catch (err) {
    await sendInputFlowError(
      ctx,
      err,
      'family',
      'panel',
      buildClosePanelKeyboard(),
      'پنل خانواده باز نشد.'
    )
  }
}

/**
 * ورود مبلغ هدیه به همسر: مبلغ واقعاً از فرستنده به همسر منتقل می‌شود و
 * رابطه را گرم می‌کند. لغو با کلمهٔ انصراف یا دکمهٔ انصراف.
 */
async function handleFamilyGiftText(ctx: Context, container: Container): Promise<void> {
  const fromId = BigInt(ctx.from!.id)
  const raw = (ctx.message?.text ?? '').trim()

  if (isCancelWord(raw)) {
    await container.userStateRepository.clear(fromId)
    await showFamilyPanelAfterInput(ctx, container, '✖️ هدیه لغو شد.')
    return
  }

  const parsed = parseAmountDetailed(raw, { max: GIFT_MAX })
  if (!parsed.ok) {
    const reasonText =
      parsed.reason === 'too_large'
        ? `هدیه از ${money(GIFT_MAX)} بیشتر نمی‌شود.`
        : 'مبلغ هدیه را به‌صورت یک عدد معتبر بفرست (مثلاً ۲۰۰۰۰۰).'
    await sendPanel(ctx, {
      text: panel({
        icon: '⚠️',
        title: 'هدیه ثبت نشد',
        sections: [{ lines: [reasonText] }]
      }),
      keyboard: buildFamilyGiftCancelKeyboard()
    })
    return
  }
  if (parsed.value < GIFT_MIN) {
    await sendPanel(ctx, {
      text: panel({
        icon: '⚠️',
        title: 'هدیه ثبت نشد',
        sections: [{ lines: [`حداقل هدیه ${money(GIFT_MIN)} است.`] }]
      }),
      keyboard: buildFamilyGiftCancelKeyboard()
    })
    return
  }

  try {
    const res = await container.familyLifeService.sendGiftToSpouse(fromId, parsed.value)
    await container.userStateRepository.clear(fromId)
    await sendPanel(ctx, {
      text: panel({
        icon: '🎁',
        title: 'هدیه ارسال شد',
        sections: [
          {
            rows: [
              { label: '🎁 مبلغ', value: money(res.amount) },
              { label: '💞 دریافت‌کننده', value: res.spouseName }
            ],
            lines: [
              res.warmthGain > 0
                ? `گرمای رابطه ${fa(res.warmthGain)} واحد بیشتر شد.`
                : 'هدیه ثبت شد.'
            ]
          }
        ]
      }),
      keyboard: buildClosePanelKeyboard()
    })
  } catch (err) {
    await sendInputFlowError(
      ctx,
      err,
      'family',
      'gift',
      buildFamilyGiftCancelKeyboard(),
      'هدیه ارسال نشد.'
    )
  }
}

/** دریافت عنوان آگهی از متن و بازکردن سازندهٔ آگهی. */
/**
 * ورودی متنیِ «حقوق دلخواه» در سازندهٔ آگهی.
 *
 * کارفرما در «تومان در هر ساعت بازی» فکر می‌کند و همان عدد را در پیش‌نمایش
 * می‌بیند؛ تبدیل به واحد ذخیره‌سازی فقط با `salaryFromGameHourInput` انجام
 * می‌شود. بازهٔ مجاز هم همان کف و سقف رسمی آگهی است، نه یک عدد تازه.
 */
async function handleBizJobSalaryText(
  ctx: Context,
  container: Container,
  businessId: string
): Promise<void> {
  const fromId = BigInt(ctx.from!.id)
  const raw = (ctx.message?.text ?? '').trim()
  const minGameHour = ratePerGameHour(POST_SALARY_MIN)
  const maxGameHour = ratePerGameHour(POST_SALARY_MAX)

  if (isCancelWord(raw)) {
    await container.userStateRepository.clear(fromId)
    await sendPanel(ctx, {
      text: panel({
        icon: '✖️',
        title: 'ساخت آگهی لغو شد',
        sections: [{ lines: ['حقوق تازه ثبت نشد.'] }]
      }),
      keyboard: buildBusinessManageKeyboard(businessId)
    })
    return
  }

  const amount = parseAmountInput(raw)
  if (amount === null) {
    await sendPanel(ctx, {
      text: panel({
        icon: '⚠️',
        title: 'مبلغ نامعتبر',
        sections: [
          {
            lines: [
              'حقوق را عددی بفرست؛ همان عددی که در پنل هم می‌بینی.',
              'مثال: `1500` یا `۱٬۵۰۰`.',
              `بازهٔ مجاز: ${money(minGameHour)} تا ${money(maxGameHour)} تومان در ساعت بازی.`
            ]
          }
        ]
      }),
      keyboard: buildFlowCancelKeyboard('biz:jf:cancel')
    })
    return
  }

  const salaryPerMinute = salaryFromGameHourInput(amount)
  if (salaryPerMinute < POST_SALARY_MIN || salaryPerMinute > POST_SALARY_MAX) {
    await sendPanel(ctx, {
      text: panel({
        icon: '⚠️',
        title: 'حقوق خارج از بازه',
        sections: [
          {
            lines: [
              `حقوق باید بین ${money(minGameHour)} و ${money(maxGameHour)} تومان در ساعت بازی باشد.`,
              `عددِ فرستاده‌شده: ${money(amount)} تومان در ساعت بازی.`
            ]
          }
        ]
      }),
      keyboard: buildFlowCancelKeyboard('biz:jf:cancel')
    })
    return
  }

  try {
    const businesses = await container.businessService.listOwnerBusinesses(fromId)
    const business = businesses.find((b) => b.id === businessId)
    if (!business) {
      await container.userStateRepository.clear(fromId)
      await sendPanel(ctx, {
        text: panel({
          icon: '⚠️',
          title: 'کسب‌وکار در دسترس نیست',
          sections: [{ lines: ['این کسب‌وکار دیگر در فهرست تو نیست؛ آگهی ساخته نشد.'] }]
        }),
        keyboard: buildWorkBackKeyboard()
      })
      return
    }

    const state = await container.userStateRepository.findByTelegramUserId(fromId)
    const draft = bizJobDraftOf(state?.stateData, business.name)
    draft.salary = salaryPerMinute
    await container.userStateRepository.upsert(fromId, {
      currentContext: `biz_job:${businessId}`,
      stateData: bizJobDraftToState(draft)
    })
    await renderBizJobWizard(ctx, draft, business.employeeCapacity)
  } catch (err) {
    await sendInputFlowError(
      ctx,
      err,
      'business',
      'job_salary',
      buildFlowCancelKeyboard('biz:jf:cancel'),
      'ثبت حقوق انجام نشد.'
    )
  }
}

async function handleBizJobTitleText(
  ctx: Context,
  container: Container,
  businessId: string
): Promise<void> {
  const fromId = BigInt(ctx.from!.id)
  const raw = (ctx.message?.text ?? '').trim()
  if (isCancelWord(raw)) {
    await container.userStateRepository.clear(fromId)
    await sendPanel(ctx, {
      text: panel({
        icon: '✖️',
        title: 'ساخت آگهی لغو شد',
        sections: [{ lines: ['عنوان تازه ثبت نشد.'] }]
      }),
      keyboard: buildBusinessManageKeyboard(businessId)
    })
    return
  }
  const title = plainInput(ctx.message?.text ?? '')
  try {
    const state = await container.userStateRepository.findByTelegramUserId(fromId)
    const draft = bizJobDraftOf(state?.stateData, title || 'آگهی')
    draft.title = title
    if (draft.title.length < 3) {
      await sendPanel(ctx, {
        text: '⚠️ عنوان آگهی باید دست‌کم ۳ نویسه باشد؛ دوباره بنویس.',
        keyboard: buildFlowCancelKeyboard('biz:jf:cancel')
      })
      return
    }
    if (draft.title.length > 40) {
      draft.title = draft.title.slice(0, 40)
    }
    await container.userStateRepository.upsert(fromId, {
      currentContext: `biz_job:${businessId}`,
      stateData: bizJobDraftToState(draft)
    })
    // ظرفیت واقعیِ همان کسب‌وکار، نه یک عدد ثابت: پیش‌تر «۲۰» نوشته می‌شد و
    // بازیکن ظرفیتی می‌دید که کسب‌وکارش نداشت (و `postJob` بعداً رد می‌کرد).
    const businesses = await container.businessService.listOwnerBusinesses(fromId)
    const business = businesses.find((b) => b.id === businessId)
    if (!business) {
      await container.userStateRepository.clear(fromId)
      await sendPanel(ctx, {
        text: panel({
          icon: '⚠️',
          title: 'کسب‌وکار در دسترس نیست',
          sections: [{ lines: ['این کسب‌وکار دیگر در فهرست تو نیست؛ آگهی ساخته نشد.'] }]
        }),
        keyboard: buildWorkBackKeyboard()
      })
      return
    }
    await renderBizJobWizard(ctx, draft, business.employeeCapacity)
  } catch (err) {
    await sendInputFlowError(
      ctx,
      err,
      'business',
      'job_title',
      buildFlowCancelKeyboard('work:menu:my_biz'),
      'عنوان ثبت نشد.'
    )
  }
}

/** دریافت مبلغ برداشت سود از خزانه. */
async function handleBizProfitText(
  ctx: Context,
  container: Container,
  businessId: string
): Promise<void> {
  const fromId = BigInt(ctx.from!.id)
  const raw = (ctx.message?.text ?? '').trim()
  if (isCancelWord(raw)) {
    await container.userStateRepository.clear(fromId)
    await sendPanel(ctx, {
      text: panel({
        icon: '✖️',
        title: 'برداشت سود لغو شد',
        sections: [{ lines: ['مبلغی از خزانه کم نشد.'] }]
      }),
      keyboard: buildBusinessManageKeyboard(businessId)
    })
    return
  }
  const amount = parseAmountInput((ctx.message?.text ?? '').trim())
  try {
    if (amount === null) {
      throw new ValidationError('Invalid amount', 'مبلغ باید یک عدد معتبر باشد.')
    }
    const res = await container.businessService.withdrawProfit(fromId, businessId, amount)
    await container.userStateRepository.clear(fromId)
    // برداشت بیشتر از موجودیِ خزانه رد نمی‌شود، بلکه به همان موجودی محدود
    // می‌شود؛ اگر این را نگوییم، بازیکن عددِ کوچک‌تر را بی‌دلیل می‌بیند.
    const clamped = res.gross < amount
    await sendPanel(ctx, {
      text: panel({
        icon: '💵',
        title: 'برداشت سود',
        sections: [
          {
            rows: [
              { label: '🧾 از خزانه', value: money(res.gross) },
              { label: '🏛️ مالیات ۱۵٪', value: money(res.tax) },
              { label: '💰 به کیف تو', value: money(res.net) },
              { label: '🏦 خزانه پس از برداشت', value: money(res.treasuryAfter) }
            ]
          },
          ...(clamped
            ? [{ lines: [`خزانه کمتر از مبلغ درخواستی بود؛ همان ${money(res.gross)} برداشت شد.`] }]
            : [])
        ],
        footer: '💡 برای پرداخت حقوق، همیشه چیزی در خزانه بگذار.'
      }),
      keyboard: buildBusinessManageKeyboard(businessId)
    })
  } catch (err) {
    await sendInputFlowError(
      ctx,
      err,
      'business',
      'withdraw_profit',
      buildFlowCancelKeyboard('work:menu:my_biz'),
      'برداشت سود انجام نشد.'
    )
  }
}

/**
 * ورودی متنیِ حقوق جدید کارمند.
 * اعتبارسنجی نهایی (سقف/کف و پرش مجاز) در سرویس است؛ این‌جا فقط لغو،
 * عددبودن و عددِ صحیح سنجیده می‌شود تا خطای واضحِ «عدد بفرست» را داشته باشیم.
 */
async function handleBizSalaryText(
  ctx: Context,
  container: Container,
  businessId: string,
  employeePlayerId: string
): Promise<void> {
  const fromId = BigInt(ctx.from!.id)
  const raw = (ctx.message?.text ?? '').trim()
  if (isCancelWord(raw)) {
    await container.userStateRepository.clear(fromId)
    await sendPanel(ctx, {
      text: panel({
        icon: '✖️',
        title: 'تغییر حقوق لغو شد',
        sections: [{ lines: ['حقوقی تغییر نکرد.'] }]
      }),
      keyboard: buildBusinessManageKeyboard(businessId)
    })
    return
  }
  const amount = parseAmountInput(raw)
  if (amount === null) {
    await sendPanel(ctx, {
      text: panel({
        icon: '⚠️',
        title: 'مبلغ نامعتبر',
        sections: [
          {
            lines: [
              'حقوق جدید را عددی بفرست؛ همان عددی که در پنل هم نمایش داده می‌شود — «تومان در ساعت بازی».',
              'مثال: `1500` یا `۱٬۵۰۰`.',
              `بازهٔ مجاز: ${money(ratePerGameHour(POST_SALARY_MIN))} تا ${money(ratePerGameHour(POST_SALARY_MAX))} تومان در ساعت بازی.`
            ]
          }
        ]
      }),
      keyboard: buildFlowCancelKeyboard(`biz:emps:${businessId}`)
    })
    return
  }
  try {
    // ورودیِ کارفرما «تومان در ساعت بازی» است، اما نرخ در دیتابیس «در دقیقهٔ
    // واقعی» نگه داشته می‌شود؛ تبدیل فقط از همین پل انجام می‌شود وگرنه عددِ
    // نوشته‌شده بی‌سروصدا دو برابر (نیم‌ساعت بازی در هر دقیقه) خوانده می‌شد.
    const salaryPerMinute = salaryFromGameHourInput(amount)
    const result = await container.businessService.setEmployeeSalary(
      fromId,
      businessId,
      employeePlayerId,
      salaryPerMinute
    )
    await container.userStateRepository.clear(fromId)
    // به کارمند هم خبر بده: تعهد مالی‌اش عوض شده و حق دانستن دارد.
    await container.notificationService
      ?.notifyPlayerById(
        employeePlayerId,
        '💰 تغییر حقوق',
        `حقوق تو در «${result.businessName}» به ${money(ratePerGameHour(result.salaryPerMinute))} در ساعت بازی تغییر کرد.`,
        undefined,
        `biz-salary:${businessId}:${employeePlayerId}:${result.salaryPerMinute}`,
        'IMPORTANT'
      )
      .catch(() => undefined)
    await sendPanel(ctx, {
      text: panel({
        icon: '💰',
        title: 'حقوق به‌روزرسانی شد',
        sections: [
          {
            rows: [
              { label: '👷 کارمند', value: result.employeeName },
              {
                label: '💵 حقوق جدید',
                value: `${money(ratePerGameHour(result.salaryPerMinute))} در ساعت بازی`
              },
              {
                label: '🧾 معادل ماهانه',
                value: money(monthlySalaryFor(result.salaryPerMinute))
              }
            ]
          }
        ],
        footer: '💡 تغییر حقوق از دورهٔ بعدی تسویه اعمال می‌شود.'
      }),
      keyboard: buildBusinessManageKeyboard(businessId)
    })
  } catch (err) {
    await sendInputFlowError(
      ctx,
      err,
      'business',
      'set_salary',
      buildFlowCancelKeyboard(`biz:emps:${businessId}`),
      'تغییر حقوق انجام نشد.'
    )
  }
}

/**
 * ورودی متنیِ حجمِ قراردادِ کارمند.
 *
 * کارفرما برحسب «ساعت بازی در ماه» می‌نویسد؛ سنجش نهایی (بازهٔ مجاز و
 * مالکیت) در سرویس انجام می‌شود تا هیچ ورودی متنی نتواند مستقیم به
 * دیتابیس برسد.
 */
async function handleSetContractText(
  ctx: Context,
  container: Container,
  businessId: string,
  employeePlayerId: string
): Promise<void> {
  const fromId = BigInt(ctx.from!.id)
  const raw = (ctx.message?.text ?? '').trim()
  if (isCancelWord(raw)) {
    await container.userStateRepository.clear(fromId)
    await sendPanel(ctx, {
      text: panel({
        icon: '✖️',
        title: 'تغییر قرارداد لغو شد',
        sections: [{ lines: ['حجم قرارداد تغییر نکرد.'] }]
      }),
      keyboard: buildBusinessManageKeyboard(businessId)
    })
    return
  }
  const hours = parseAmountInput(raw)
  if (hours === null) {
    await sendPanel(ctx, {
      text: panel({
        icon: '⚠️',
        title: 'عدد نامعتبر',
        sections: [
          {
            lines: [
              'حجم کار را عددی بفرست — «ساعت بازی در ماه».',
              `بازهٔ مجاز: ${fa(MIN_CONTRACT_GAME_HOURS_PER_MONTH)} تا ${fa(MAX_CONTRACT_GAME_HOURS_PER_MONTH)} ساعت در ماه.`,
              'مثال: `160` یا `۱۶۰`'
            ]
          }
        ]
      }),
      keyboard: buildFlowCancelKeyboard(`biz:emps:${businessId}`)
    })
    return
  }
  try {
    const result = await container.businessService.setEmployeeContract(
      fromId,
      businessId,
      employeePlayerId,
      hours
    )
    await container.userStateRepository.clear(fromId)
    // کارمند حق دانستن دارد: حجم توافق‌شده عوض شده و همان سقف کارکرد اوست.
    await container.notificationService
      ?.notifyPlayerById(
        employeePlayerId,
        '⏱ تغییر قرارداد',
        `حجم قراردادت در «${result.businessName}» به ${fa(result.contractGameHoursPerMonth)} ساعت بازی در ماه تغییر کرد.`,
        undefined,
        `biz-contract:${businessId}:${employeePlayerId}:${result.contractMinutesPerMonth}`,
        'IMPORTANT'
      )
      .catch(() => undefined)
    await sendPanel(ctx, {
      text: panel({
        icon: '⏱',
        title: 'قرارداد به‌روزرسانی شد',
        sections: [
          {
            rows: [
              { label: '👷 کارمند', value: result.employeeName },
              {
                label: '⏱ حجم جدید',
                value: `${fa(result.contractGameHoursPerMonth)} ساعت بازی در ماه`
              },
              {
                label: '🧾 سقف حقوق ماهانه',
                value: money(result.monthlyPayCeiling)
              }
            ]
          },
          {
            lines: [
              'حقوق فقط برای کارکرد واقعیِ کارمند و تا همین سقف پرداخت می‌شود؛',
              'کمتر کار کند، کمتر می‌گیرد.'
            ]
          }
        ]
      }),
      keyboard: buildBusinessManageKeyboard(businessId)
    })
  } catch (err) {
    await sendInputFlowError(
      ctx,
      err,
      'business',
      'set_contract',
      buildFlowCancelKeyboard(`biz:emps:${businessId}`),
      'تغییر قرارداد انجام نشد.'
    )
  }
}

/** دریافت مهریه از ریپلای + عدد؛ سپس ثبت خواستگاری. */
async function handleFamilyProposeText(ctx: Context, container: Container): Promise<void> {
  const fromId = BigInt(ctx.from!.id)
  const raw = (ctx.message?.text ?? '').trim()

  // لغو پیش از هر شرط دیگری سنجیده می‌شود؛ وگرنه «انصراف» بدون ریپلای
  // به‌جای لغو، پیام «ریپلای لازم است» می‌گرفت و کاربر گیر می‌کرد.
  if (isCancelWord(raw)) {
    await container.userStateRepository.clear(fromId)
    await showFamilyPanelAfterInput(ctx, container, '✖️ خواستگاری لغو شد.')
    return
  }

  const replyFrom = ctx.message?.reply_to_message?.from
  const replyFromId = replyFrom?.id

  if (replyFromId === undefined || replyFromId === null || BigInt(replyFromId) === fromId) {
    await sendPanel(ctx, {
      text: panel({
        icon: '💌',
        title: 'ریپلای لازم است',
        sections: [
          {
            lines: [
              'اول روی پیام کسی که می‌خواهی با او ازدواج کنی *ریپلای* کن',
              'و مبلغ مهریه پیشنهادی را عددی بفرست.',
              'ریپلای باید روی پیام خودِ او باشد؛ در گفت‌وگوی خصوصی با',
              'ربات فقط پیام خودت و ربات هست و خواستگاری ممکن نیست.',
              ...mahrRuleLines(),
              'برای «تعیین‌نشده» عدد `0` را بفرست تا مهریه را خودِ خانم بچیند.'
            ]
          }
        ]
      }),
      keyboard: buildFamilyCancelKeyboard()
    })
    return
  }

  // در خصوصی تنها گزینهٔ ریپلای، خودِ ربات است؛ پیام روشن بهتر از
  // «این بازیکن یافت نشد» است.
  if (replyFrom?.is_bot) {
    await sendPanel(ctx, {
      text: panel({
        icon: '💌',
        title: 'هدف خواستگاری نیست',
        sections: [
          {
            lines: [
              'روی پیامِ ربات نمی‌توانی خواستگاری کنی!',
              'روی پیام خودِ بازیکن موردنظرت — در گروهی که بازی می‌کنی — ریپلای کن.'
            ]
          }
        ]
      }),
      keyboard: buildFamilyCancelKeyboard()
    })
    return
  }

  const parsed = parseMahrInput(raw, true)
  if (parsed.kind === 'invalid') {
    await sendPanel(ctx, {
      text: panel({
        icon: '⚠️',
        title: 'خواستگاری ثبت نشد',
        sections: [{ lines: [parsed.message] }]
      }),
      keyboard: buildFamilyCancelKeyboard()
    })
    return
  }

  try {
    const res = await container.marriageService.propose(
      fromId,
      BigInt(replyFromId),
      parsed.kind === 'unset' ? null : parsed.amount
    )
    await container.userStateRepository.clear(fromId)
    await sendPanel(ctx, {
      text: panel({
        icon: '💌',
        title: 'خواستگاری ارسال شد',
        sections: [
          {
            rows: [
              { label: '👤 به', value: res.targetName },
              { label: '💵 مهریهٔ پیشنهادی', value: describeMahr(res.mahr) }
            ]
          }
        ],
        footer:
          parsed.kind === 'unset'
            ? '⏳ مهریه را خودش تعیین می‌کند و سپس تو تأیید می‌کنی.'
            : '⏳ منتظر پاسخ او بمان؛ پیشنهاد در پنل «خانواده» او نمایش داده می‌شود.'
      }),
      keyboard: buildClosePanelKeyboard()
    })
  } catch (err) {
    await sendInputFlowError(ctx, err, 'family', 'propose', buildFamilyCancelKeyboard(), 'خواستگاری ثبت نشد.')
  }
}

/**
 * انتقال پول با ریپلای روی پیام بازیکن مقصد.
 *
 * جریان: ورودی → اعتبارسنجی → **صفحهٔ تأیید** → تأیید/انصراف → اجرا.
 * هیچ پولی در این مرحله جابه‌جا نمی‌شود؛ فقط یک تأییدِ تک‌مصرف صادر می‌شود
 * که مبلغ و گیرنده در سمت سرور به آن بسته شده‌اند (callback_data قابل
 * دستکاری نیست).
 */
async function handleTransferReply(
  ctx: Context,
  container: Container,
  command: TransferCommand
): Promise<void> {
  const fromId = BigInt(ctx.from!.id)
  const receiverTelegramId = ctx.message!.reply_to_message!.from!.id

  if (command.kind === 'transfer_invalid') {
    await sendPanel(ctx, {
      text: panel({
        icon: '⚠️',
        title: 'انتقال انجام نشد',
        sections: [
          {
            lines: [
              'مبلغ خوانده نشد.',
              `مثال: ${TRANSFER_EXAMPLE} برای انتقال نقدی`,
              `یا ${BANK_TRANSFER_EXAMPLE} برای انتقال بانکی`
            ]
          }
        ]
      }),
      keyboard: buildClosePanelKeyboard()
    })
    return
  }
  if (command.kind !== 'transfer' && command.kind !== 'bank_transfer') {
    return
  }
  const rail: 'cash' | 'bank' = command.kind === 'bank_transfer' ? 'bank' : 'cash'

  if (receiverTelegramId === ctx.from!.id) {
    await sendPanel(ctx, {
      text: panel({
        icon: '⚠️',
        title: 'انتقال انجام نشد',
        sections: [{ lines: ['روی پیامِ خودت ریپلای کرده‌ای؛ به خودت نمی‌توانی پول بدهی.'] }]
      }),
      keyboard: buildClosePanelKeyboard()
    })
    return
  }
  if (ctx.message?.reply_to_message?.from?.is_bot) {
    await sendPanel(ctx, {
      text: panel({
        icon: '⚠️',
        title: 'انتقال انجام نشد',
        sections: [{ lines: ['روی پیامِ یک ربات ریپلای کرده‌ای؛ مقصد باید یک بازیکن باشد.'] }]
      }),
      keyboard: buildClosePanelKeyboard()
    })
    return
  }

  try {
    // دو مسیرِ جدا: نقدی از کیف پول (سقفِ کوچک) و بانکی از حساب (سقفِ روزانه +
    // مالیات). پیش‌نمایشِ هرکدام از سرویسِ خودش می‌آید تا پنل تأیید دقیقاً همان
    // عددی را نشان بدهد که بعداً کم می‌شود — نه یک تخمینِ دوم.
    if (rail === 'bank') {
      const preview = await container.bankTransferService.preview(
        fromId,
        BigInt(receiverTelegramId),
        command.amount
      )
      const token = await container.userStateRepository.issueScopedConfirmation(
        fromId,
        ctx.chat!.id,
        'act',
        {
          receiverTelegramId: receiverTelegramId.toString(),
          amount: command.amount,
          rail: 'bank'
        }
      )
      const withinToday = preview.gross <= preview.remainingToday
      await sendPanel(ctx, {
        text: panel({
          icon: '🏦',
          title: 'تأیید انتقال بانکی',
          sections: [
            {
              rows: [
                { label: '👤 گیرنده', value: preview.receiverName },
                { label: '💵 مبلغ', value: `*${money(preview.gross)}*` },
                { label: '🧾 مالیات انتقال', value: money(preview.tax) },
                { label: '✅ رسیده به گیرنده', value: money(preview.net) },
                { label: '🏦 منبع', value: `حساب بانکی تو (${money(preview.senderBankBalance)})` },
                { label: '📊 سقفِ باقی‌ماندهٔ امروز', value: money(preview.remainingToday) }
              ]
            },
            {
              lines: [
                '💡 این انتقال از *حساب بانکی* انجام می‌شود، نه از جیب.',
                'مالیات به صندوقِ منطقهٔ خودت می‌رسد.',
                withinToday
                  ? ''
                  : '⚠️ این مبلغ از سقفِ امروزت بیشتر است؛ امروز قابل انجام نیست.',
                '⚠️ برگشت‌پذیر نیست؛ فقط با رضایت خودِ گیرنده برمی‌گردد.'
              ].filter((line) => line !== '')
            }
          ]
        }),
        keyboard: buildTransferConfirmKeyboard(token)
      })
      return
    }

    const preview = await container.transferService.preview(
      fromId,
      BigInt(receiverTelegramId),
      command.amount
    )

    const token = await container.userStateRepository.issueScopedConfirmation(
      fromId,
      ctx.chat!.id,
      'act',
      { receiverTelegramId: receiverTelegramId.toString(), amount: command.amount, rail: 'cash' }
    )

    const walletAfter = preview.senderWallet - command.amount
    await sendPanel(ctx, {
      text: panel({
        icon: '💸',
        title: 'تأیید انتقال پول',
        sections: [
          {
            rows: [
              { label: '👤 گیرنده', value: preview.receiverName },
              { label: '💵 مبلغ', value: `*${money(command.amount)}*` },
              { label: '👛 منبع', value: `کیف پول تو (${money(preview.senderWallet)})` },
              {
                label: '📉 موجودی پس از انتقال',
                value: preview.affordable ? money(walletAfter) : '—'
              }
            ]
          },
          {
            lines: [
              '💡 انتقال از *کیف پول* انجام می‌شود، نه از حساب بانکی.',
              'برای مبلغهای بزرگتر از «انتقال بانکی» استفاده کن.',
              '',
              '⚠️ این انتقال برگشت‌پذیر نیست؛ فقط با رضایت خودِ گیرنده برمی‌گردد.'
            ]
          }
        ]
      }),
      keyboard: buildTransferConfirmKeyboard(token)
    })
  } catch (err) {
    if (err instanceof AppError) {
      await sendPanel(ctx, {
        text: panel({
          icon: '⚠️',
          title: 'انتقال انجام نشد',
          sections: [{ lines: err.persianMessage.split('\n') }]
        }),
        keyboard: buildClosePanelKeyboard()
      })
      return
    }
    await handleCommandError(ctx, err, {
      feature: 'transfer',
      action: 'preview',
      fallback: 'پیش‌نمایش انتقال آماده نشد.'
    })
  }
}

/** دریافت نام حیوان و ثبت سرپرستی. */
async function handlePetNameText(ctx: Context, container: Container, kindKey: string): Promise<void> {
  const fromId = BigInt(ctx.from!.id)
  const raw = (ctx.message?.text ?? '').trim()

  // بدون این گارد، «انصراف» نام حیوان می‌شد و هزینه هم کسر می‌گشت!
  if (isCancelWord(raw)) {
    await container.userStateRepository.clear(fromId)
    await sendPanel(ctx, {
      text: panel({
        icon: '✖️',
        title: 'سرپرستی لغو شد',
        sections: [
          {
            lines: [
              'نامی ثبت نشد و هیچ هزینه‌ای کسر نگشت.',
              'هر وقت خواستی، از فروشگاه حیوان دوباره شروع کن.'
            ]
          }
        ]
      }),
      keyboard: buildPetRecoveryKeyboard()
    })
    return
  }
  const name = plainInput(ctx.message?.text ?? '')

  try {
    const res = await container.petService.adopt(fromId, kindKey, name)
    await container.userStateRepository.clear(fromId)
    await sendPanel(ctx, {
      text: renderPetAdoptedPanel({
        name: res.name,
        kindName: res.kindName,
        emoji: res.emoji,
        price: res.price,
        balanceAfter: res.balanceAfter,
        feedCost: PET_INFO.feedCost
      }),
      // پنل بعدی همان پنل حیوان است: غذا، بازی و هدیهٔ روز اول همه از همین‌جا
      keyboard: buildPetKeyboard(true, true, true, true)
    })
  } catch (err) {
    // جریان ورودی هرگز بازیکن را قفل نمی‌کند: State پاک می‌شود و مسیر بازگشت
    // به فروشگاه روی همان پیام خطا می‌نشیند. پیامِ خطا هم *دقیق* است —
    // «قبلاً حیوان داری» فقط وقتی گفته می‌شود که واقعاً حیوان داشته باشد.
    await container.userStateRepository.clear(fromId).catch(() => undefined)
    await sendInputFlowError(
      ctx,
      err,
      'pet',
      'adopt',
      buildPetRecoveryKeyboard(),
      'سرپرستی حیوان ثبت نشد؛ هیچ هزینه‌ای کسر نگشت.'
    )
  }
}

/** دریافت مبلغ قرض از ریپلای به وام‌دهنده + عدد؛ سپس ثبت درخواست. */
async function handleLoanRequestText(ctx: Context, container: Container): Promise<void> {
  const fromId = BigInt(ctx.from!.id)
  const raw = (ctx.message?.text ?? '').trim()
  const replyFromId = ctx.message?.reply_to_message?.from?.id

  // همان واژه‌های لغوی مشترک همهٔ جریان‌ها («انصراف»، «لغو»، «بیخیال»…)
  if (isCancelWord(raw)) {
    await container.userStateRepository.clear(fromId)
    await sendPanel(ctx, {
      text: panel({
        icon: '✖️',
        title: 'درخواست قرض لغو شد',
        sections: [{ lines: ['هیچ درخواستی ارسال نشد.'] }]
      }),
      keyboard: buildClosePanelKeyboard()
    })
    return
  }

  if (replyFromId === undefined || replyFromId === null || BigInt(replyFromId) === fromId) {
    await sendPanel(ctx, {
      text: panel({
        icon: '💳',
        title: 'ریپلای لازم است',
        sections: [
          {
            lines: [
              'اول روی پیام وام‌دهندهٔ موردنظرت *ریپلای* کن',
              'و مبلغ قرض را بفرست (۲۰۰ هزار تا ۲۰ میلیون).'
            ]
          }
        ]
      }),
      keyboard: buildLoanRequestCancelKeyboard()
    })
    return
  }

  const amount = parseAmountInput(raw)
  if (amount === null) {
    await sendPanel(ctx, { text: texts.invalidAmount, keyboard: buildLoanRequestCancelKeyboard() })
    return
  }

  const lender = await container.playerRepository.findByTelegramUserId(BigInt(replyFromId))
  if (!lender) {
    await sendPanel(ctx, {
      text: panel({
        icon: '⚠️',
        title: 'وام‌دهنده پیدا نشد',
        sections: [{ lines: ['این بازیکن هنوز در شهر ثبت‌نام نکرده است.'] }]
      }),
      keyboard: buildLoanRequestCancelKeyboard()
    })
    return
  }

  try {
    const res = await container.playerLoanService.request(fromId, lender.id, amount)
    await container.userStateRepository.clear(fromId)
    await sendPanel(ctx, {
      text: panel({
        icon: '💳',
        title: 'درخواست قرض ارسال شد',
        sections: [
          {
            rows: [
              { label: '🏦 وام‌دهنده', value: res.lenderName },
              { label: '💵 مبلغ درخواستی', value: money(amount) },
              { label: '📈 بازپرداخت نهایی', value: money(res.totalRepay) }
            ]
          }
        ],
        footer: '⏳ اگر بپذیرد، مبلغ به کیف پولت می‌آید و ۷ روز مهلت بازپرداخت داری.'
      }),
      keyboard: buildClosePanelKeyboard()
    })
  } catch (err) {
    await sendInputFlowError(ctx, err, 'player_loan', 'request', buildLoanRequestCancelKeyboard(), 'درخواست قرض ثبت نشد.')
  }
}

/** دریافت مبلغ پیشنهاد حراج و ثبت آن. */
async function handleAuctionBidText(ctx: Context, container: Container, auctionId: string): Promise<void> {
  const fromId = BigInt(ctx.from!.id)
  const raw = (ctx.message?.text ?? '').trim()

  // همان واژه‌های لغوی مشترک همهٔ جریان‌ها («انصراف»، «لغو»، «بیخیال»…)
  if (isCancelWord(raw)) {
    await container.userStateRepository.clear(fromId)
    await sendPanel(ctx, {
      text: panel({
        icon: '✖️',
        title: 'پیشنهاد حراج لغو شد',
        sections: [{ lines: ['هیچ مبلغی قفل نشد.'] }]
      }),
      keyboard: buildClosePanelKeyboard()
    })
    return
  }

  const amount = parseAmountInput(raw)
  if (amount === null) {
    await sendPanel(ctx, { text: texts.invalidAmount, keyboard: buildAuctionCancelKeyboard() })
    return
  }

  try {
    const res = await container.auctionService.placeBid(fromId, auctionId, amount)
    await container.userStateRepository.clear(fromId)
    await sendPanel(ctx, {
      text: panel({
        icon: '🔨',
        title: 'پیشنهاد ثبت شد',
        sections: [
          {
            rows: [
              { label: '📦 آیتم', value: res.itemName },
              { label: '💵 پیشنهاد تو', value: money(res.amount) }
            ]
          }
        ],
        footer: '💡 مبلغت نزد حراجی قفل است؛ اگر کسی بالاتر بدهد بی‌درنگ برمی‌گردد.'
      }),
      keyboard: buildClosePanelKeyboard()
    })
  } catch (err) {
    await sendInputFlowError(ctx, err, 'auction', 'place_bid', buildAuctionCancelKeyboard(), 'پیشنهاد ثبت نشد.')
  }
}

/** دریافت متن آگهی و انتشار آن در منطقه. */
async function handleAdText(ctx: Context, container: Container): Promise<void> {
  const fromId = BigInt(ctx.from!.id)
  const raw = plainInput(ctx.message?.text ?? '')

  if (isCancelWord(raw)) {
    await container.userStateRepository.clear(fromId)
    await sendPanel(ctx, {
      text: panel({
        icon: '📣',
        title: 'آگهی لغو شد',
        sections: [{ lines: ['هیچ هزینه‌ای کسر نشد.'] }]
      }),
      keyboard: buildClosePanelKeyboard()
    })
    return
  }

  const group =
    ctx.chat && ctx.chat.type !== 'private'
      ? await container.groupRepository.findByTelegramGroupId(BigInt(ctx.chat.id))
      : null

  try {
    const res = await container.adService.publish(fromId, raw, group?.id ?? null)
    await container.userStateRepository.clear(fromId)
    await sendPanel(ctx, {
      text: panel({
        icon: '📣',
        title: 'آگهی منتشر شد',
        sections: [
          {
            rows: [
              { label: '📝 متن', value: res.text },
              { label: '💵 هزینه', value: money(res.fee) }
            ]
          }
        ],
        footer: '🗞️ آگهی تو در جریان خبرهای منطقه پخش می‌شود.'
      }),
      keyboard: buildClosePanelKeyboard()
    })
  } catch (err) {
    await sendInputFlowError(ctx, err, 'ad', 'publish', buildAdsCancelKeyboard(), 'آگهی منتشر نشد.')
  }
}

async function handleReplyIdentity(ctx: Context, container: Container): Promise<void> {
  const viewerId = BigInt(ctx.from!.id)
  const targetUser = ctx.message!.reply_to_message!.from!

  if (targetUser.is_bot) {
    await sendPanel(ctx, { text: '🤖 ربات‌ها شناسنامه ندارند.' })
    return
  }

  const targetId = BigInt(targetUser.id)

  const isTargetRegistered = await container.playerService.isRegistered(targetId)
  if (!isTargetRegistered) {
    await sendPanel(ctx, { text: '⚠️ این کاربر هنوز در بازی ثبت‌نام نکرده است.' })
    return
  }

  const result = await container.identityPrivacyService.getProfileForViewer(viewerId, targetId)
  if (result.isPrivate) {
    await sendPanel(ctx, { text: '🔒 اطلاعات این بازیکن خصوصی است.' })
    return
  }

  if (result.profile) {
    // همان کارت، همان اطلاعات: اگر نشان‌ها برای خودِ بازیکن نمایش داده
    // می‌شود، برای کسی که شناسنامه‌اش را می‌خواند هم باید یکی باشد.
    const row = await container.playerRepository.findByTelegramUserId(targetId).catch(() => null)
    const achievements = row
      ? await container.achievementService.getSummary(row.id).catch(() => null)
      : null
    await sendPanel(ctx, {
      text: renderIdentityCard(result.profile, {
        ...(achievements ? { achievements } : {})
      }),
      keyboard: buildClosePanelKeyboard()
    })
    return
  }

  // حالت نادری که پروفایل خوانده نشد؛ بازیکن هرگز بی‌پاسخ نمی‌ماند.
  await sendPanel(ctx, {
    text: '⚠️ خواندن شناسنامهٔ این بازیکن ممکن نشد؛ کمی بعد دوباره تلاش کن.'
  })
}

/**
 * هشدار سلامت پایین بعد از پایان کار.
 *
 * سلامت فقط در همین لحظه‌ها افت می‌کند، پس بررسی همان‌جا انجام می‌شود و
 * هیچ تایمری لازم نیست. سرویس خودش روزی یک اعلان می‌فرستد.
 */
async function warnLowHealth(container: Container, telegramUserId: bigint): Promise<void> {
  try {
    const player = await container.playerRepository.findByTelegramUserId(telegramUserId)
    if (!player) return
    await container.clinicService.warnIfCritical(player.id, player.health)
  } catch (error) {
    logger.debug({ err: error, feature: 'clinic', action: 'warn' }, 'health warning skipped')
  }
}

/**
 * ثبت ایمن رخداد بازیکن.
 * ثبت رخداد هرگز نباید مسیر اصلی بازی را بشکند، پس خطاها فقط لاگ می‌شوند.
 */
/**
 * برای هر جریانِ ورودی، جملهٔ همان جریان — نه یک متنِ کلی.
 * بازیکن باید بفهمد کدام کار نیمه‌تمام ماند و از کجا دوباره شروع کند.
 */
function expiredFlowHint(context: string): string {
  if (context.startsWith('pet_name:')) {
    return '🐾 جریان سرپرستی نیمه‌کاره ماند؛ از «حیوان» → «فروشگاه حیوان» دوباره شروع کن.'
  }
  if (context === 'family_mahr' || context.startsWith('family_set_mahr:')) {
    return '💞 برای تعیینِ مهریه، دوباره از پنل «خانواده» شروع کن.'
  }
  if (context === 'family_gift') {
    return '🎁 برای هدیه به همسر، دوباره دکمهٔ «هدیه» را در پنل «خانواده» بزن.'
  }
  if (context === 'loan_request') {
    return '🤝 برای درخواستِ وام، دوباره روی پیامِ وام‌دهنده «قرض» بنویس.'
  }
  if (context === 'bank_deposit' || context === 'bank_withdraw') {
    return '🏦 برای واریز یا برداشت، دوباره پنل «بانک» را باز کن.'
  }
  if (context.startsWith('deposit_open:')) {
    return '🏦 برای بازکردنِ سپرده، دوباره از پنل «سپرده» شروع کن.'
  }
  if (context.startsWith('market_sell:')) {
    return '🛒 برای گذاشتنِ آگهیِ فروش، دوباره از پنل «بازار» شروع کن.'
  }
  if (context.startsWith('auction_bid:')) {
    return '🔨 برای ثبتِ پیشنهاد، دوباره پنل «حراجی» را باز کن.'
  }
  if (context.startsWith('rental_price:')) {
    return '🏠 برای تعیینِ اجاره‌بها، دوباره از پنل «اجاره» شروع کن.'
  }
  if (context.startsWith('biz_job_title:') || context.startsWith('biz_job:')) {
    return '💼 برای آگهیِ استخدام، دوباره از پنل «کسب‌وکار» شروع کن.'
  }
  if (context.startsWith('biz_profit:')) {
    return '💵 برای برداشتِ سود، دوباره از پنل «کسب‌وکار» شروع کن.'
  }
  if (context === 'registration') {
    return '📝 برای ادامهٔ ثبت‌نام، «شروع» را بفرست.'
  }
  if (context.startsWith('adm:') || context.startsWith('act:confirm:')) {
    return '🔐 آن صفحهٔ تأیید یک‌بارمصرف بود؛ همان گزینه را دوباره انتخاب کن.'
  }
  if (context === 'ad_text') {
    return '📣 برای انتشارِ آگهی، دوباره پنل «آگهی همگانی» را باز کن.'
  }
  return 'همان گزینه را دوباره از پنلِ مربوط انتخاب کن.'
}

export async function logPlayerEvent(
  container: Container,
  telegramUserId: bigint,
  type: GameEventType,
  title: string,
  options: { detail?: string; amount?: number; dedupeKey?: string } = {}
): Promise<void> {
  try {
    const player = await container.playerRepository.findByTelegramUserId(telegramUserId)
    if (!player) return
    await container.eventService.recordPlayerEvent({
      playerId: player.id,
      type,
      title,
      detail: options.detail,
      amount: options.amount,
      dedupeKey: options.dedupeKey
    })
  } catch (error) {
    logger.debug({ err: error, type }, 'failed to record player event')
  }
}

/** ثبت ایمن رخداد منطقه (منبع خبر). */
export async function logRegionEvent(
  ctx: Context,
  container: Container,
  type: GameEventType,
  title: string,
  options: { detail?: string; amount?: number; dedupeKey?: string; priority?: number } = {}
): Promise<void> {
  try {
    const chatId = ctx.chat?.id
    if (chatId === undefined || !isGroupContext(ctx.chat?.type)) return
    const group = await container.groupRepository.findByTelegramGroupId(BigInt(chatId))
    if (!group) return
    await container.eventService.recordRegionEvent({
      groupId: group.id,
      type,
      title,
      detail: options.detail,
      amount: options.amount,
      dedupeKey: options.dedupeKey,
      priority: options.priority
    })
  } catch (error) {
    logger.debug({ err: error, type }, 'failed to record region event')
  }
}

/** آیا این چت یک گروه است؟ */
function isGroupContext(chatType: string | undefined): boolean {
  return chatType === 'group' || chatType === 'supergroup'
}


/**
 * تشخیص نقش مدیریتی منطقه.
 * دسترسی همیشه سمت سرور از Telegram و دیتابیس بررسی می‌شود؛
 * هیچ‌گاه به callback_data اعتماد نمی‌شود.
 */
async function resolveRegionRole(
  ctx: Context,
  container: Container
): Promise<{ allowed: boolean; roleLabel: string }> {
  const chatId = ctx.chat?.id
  const userId = ctx.from?.id
  if (chatId === undefined || userId === undefined) {
    return { allowed: false, roleLabel: '—' }
  }

  // ادمین‌های ربات همیشه دسترسی دارند
  if (await container.adminService.isAdmin(BigInt(userId))) {
    return { allowed: true, roleLabel: 'مدیر سیستم' }
  }

  try {
    const member = await ctx.api.getChatMember(chatId, userId)
    if (member.status === 'creator' || member.status === 'administrator') {
      // عنوان محلیِ متناسب با سطح محیط (دهیار/شهردار/فرماندار/وزیر و معاون‌شان)
      // از همان جدول واحدی می‌آید که نقش‌های محلی گروه را برچسب می‌زند؛
      // اگر منطقه هنوز ثبت نشده باشد، عنوان عمومی نشان داده می‌شود.
      const group = await container.groupRepository
        .findByTelegramGroupId(BigInt(chatId))
        .catch(() => null)
      const localTitle = group
        ? getLocalRoleTitle(
            group.environmentLevel,
            member.status === 'creator' ? PlayerGroupRole.OWNER : PlayerGroupRole.ADMIN
          )
        : null
      const genericTitle = member.status === 'creator' ? 'رئیس منطقه' : 'معاون منطقه'
      return { allowed: true, roleLabel: localTitle ?? genericTitle }
    }
  } catch {
    // اگر Telegram پاسخ نداد، دسترسی داده نمی‌شود
  }

  return { allowed: false, roleLabel: 'شهروند' }
}

/** آیا کاربر مدیر این منطقه است (برای نمایش دکمهٔ مدیریت)؟ */
async function isRegionManager(ctx: Context, container: Container): Promise<boolean> {
  const role = await resolveRegionRole(ctx, container)
  return role.allowed
}

/** هشدارهای وضعیت منطقه برای پنل مدیریت. */
function buildRegionWarnings(state: {
  population: number
  employed: number
  economicIndex: number
  totalDebt: number
  totalWealth: number
  companies: number
}): string[] {
  const warnings: string[] = []

  if (state.population === 0) {
    warnings.push('⚠️ هیچ بازیکنی در این منطقه ثبت‌نام نکرده است.')
    return warnings
  }

  const unemploymentRate = Math.round(
    ((state.population - state.employed) / state.population) * 100
  )
  if (unemploymentRate >= 60) {
    warnings.push(`⚠️ نرخ بیکاری بالا است (${unemploymentRate}٪).`)
  }
  if (state.economicIndex < 25) {
    warnings.push('⚠️ شاخص اقتصادی منطقه پایین است.')
  }
  if (state.companies === 0) {
    warnings.push('⚠️ هیچ کسب‌وکاری در منطقه فعال نیست.')
  }
  if (state.totalWealth < 0) {
    warnings.push('⚠️ بدهی منطقه از دارایی آن بیشتر است.')
  } else if (state.totalDebt > state.totalWealth) {
    warnings.push('⚠️ حجم بدهی نسبت به ثروت منطقه بالا است.')
  }

  return warnings
}

interface SectionOptions {
  edit?: boolean
}

/**
 * هشدارِ وام به شکلِ قابل‌گسترش در پنل.
 *
 * `renderBankPanel` فیلد `warning` را اختیاری گرفته است؛ این تابع null را به
 * «فیلد غایب» تبدیل می‌کند تا نوع دقیق بماند و متن هشدار هم فقط یک منبع داشته باشد.
 */
function warningFor(lifecycle: Parameters<typeof loanWarningText>[0]): { warning?: string } {
  const text = loanWarningText(lifecycle)
  return text ? { warning: text } : {}
}

async function handleSection(
  ctx: Context,
  container: Container,
  section: string,
  options: SectionOptions = {}
): Promise<void> {
  const chatType = ctx.chat?.type
  const telegramUserId = BigInt(ctx.from!.id)
  const showPanel = options.edit ? editPanel : sendPanel

  // راهنما به بازیکن ثبت‌نام‌نشده هم نمایش داده می‌شود
  if (section === 'help') {
    await openHelpMain(ctx, container, options.edit === true)
    return
  }

  // اطلاعات منطقه هم به ثبت‌نام نیاز ندارد؛ فقط در گروه معنا دارد
  if (section === 'group_info') {
    if (!isSectionAllowedHere('group_info', chatType)) {
      await showPanel(ctx, {
        text: groupOnlyNotice('group_info'),
        keyboard: buildClosePanelKeyboard()
      })
      return
    }
    const groupResult = await handleGroupContext(ctx, container)
    await showPanel(ctx, {
      text: renderGroupInfoPanel(groupResult),
      keyboard: buildClosePanelKeyboard()
    })
    return
  }

  const isRegistered = await container.playerService.isRegistered(telegramUserId)
  if (!isRegistered) {
    await showPanel(ctx, { text: texts.noProfile })
    return
  }

  // تک‌نقطهٔ اجرای سیاست محیط و وضعیت حساب برای مسیر پیام متنی.
  // هیچ شاخه‌ای در پایین اجازهٔ شرط‌گذاری دستی Group/Private ندارد؛
  // سیاست فقط در `chat-policy.ts` تعریف و فقط این‌جا اعمال می‌شود.
  const entry = await checkSectionEntry(ctx, container, section)
  if (entry !== 'allowed') {
    const notice =
      entry === 'wrong_chat'
        ? sectionPolicy(section) === 'GROUP_ONLY'
          ? groupOnlyNotice(section)
          : privateOnlyNotice(section)
        : entry === 'banned'
          ? bannedNotice()
          : entry === 'not_setup'
            ? notSetupNotice()
            : deadNotice()
    await showPanel(ctx, { text: notice, keyboard: buildClosePanelKeyboard() })
    return
  }

  try {
    if (section === 'identity') {
      const [profile, playerRecord] = await Promise.all([
        container.playerService.getProfile(telegramUserId),
        container.playerRepository.findByTelegramUserId(telegramUserId)
      ])
      const keyboard = buildIdentityPrivacyKeyboard(playerRecord?.privacy ?? 'PUBLIC')
      // نشان‌ها روی همان کارت نشان داده می‌شوند تا بازیکن برای دیدن پیشرفتش
      // مجبور نباشد بداند کدام کلیدواژه آن بخش را باز می‌کند.
      const achievements = playerRecord
        ? await container.achievementService.getSummary(playerRecord.id).catch(() => null)
        : null
      const card = renderIdentityCard(profile, {
        showMoney: chatType === 'private',
        ...(achievements ? { achievements } : {})
      })
      await showPanel(ctx, { text: card, keyboard })
      return
    }

    if (section === 'status') {
      // فرسودگیِ بدن Lazy است؛ پیش از نمایش عدد، بازهٔ سپری‌شده اعمال می‌شود تا
      // سلامتِ روی صفحه همان چیزی باشد که واقعاً هست — نه عکسی از گذشته.
      const statusRow = await container.playerRepository.findByTelegramUserId(telegramUserId)
      if (statusRow) {
        await container.vitalityService.syncPlayer(statusRow.id).catch(() => null)
      }
      const profile = await container.playerService.getProfile(telegramUserId)
      const status = renderStatusPanel(profile, {
        showMoney: chatType === 'private',
        age: profile.age
      })
      await showPanel(ctx, { text: status, keyboard: buildClosePanelKeyboard() })
      return
    }

    if (section === 'rebirth') {
      // پایانِ زندگی و آغازی تازه. برای شخصیتِ زنده فقط توضیح است؛ برای
      // شخصیتِ فوت‌شده تنها راهِ ادامهٔ بازی.
      const player = await container.playerRepository.findByTelegramUserId(telegramUserId)
      if (player) {
        const adminOverride = await container.adminService
          .isAdmin(telegramUserId)
          .catch(() => false)
        await showPanel(ctx, await rebirthPanelPayload(container, player.id, { adminOverride }))
      }
      return
    }

    if (section === 'streak') {
      await showStreakPanel(ctx, container)
      return
    }

    if (section === 'lottery') {
      await showLotteryPanel(ctx, container)
      return
    }

    if (section === 'invite') {
      await showInvitePanel(ctx, container)
      return
    }

    if (section === 'market') {
      await showMarketPanel(ctx, container)
      return
    }

    if (section === 'my_job') {
      await showMyJobPanel(ctx, container, showPanel)
      return
    }

    if (section === 'housing') {
      const [player, realEstate, maintenance, recoveryPreview] = await Promise.all([
        container.playerRepository.findByTelegramUserId(telegramUserId),
        container.housingService
          .listPlayerRealEstate(telegramUserId)
          .catch(() => ({ owned: [] as Array<{ baseAssetValue: { toString(): string } }>, activeRental: null })),
        // تسویهٔ Lazy شارژ نگهداری: هر ۳۰ روز یک‌بار، بدون تایمر جداگانه
        container.housingService
          .chargeOverdueMaintenance(telegramUserId)
          .catch(() => ({ chargedTotal: 0, chargedCount: 0, skippedTitles: [] as string[] })),
        container.housingService.getRecoveryPreview(telegramUserId).catch(() => null)
      ])
      const isResting = player?.activityState === 'RESTING'
      const owned = realEstate.owned ?? []
      const assetValue = owned.reduce(
        (acc: number, p: { baseAssetValue: { toString(): string } }) =>
          acc + Number(p.baseAssetValue),
        0
      )
      await showPanel(ctx, {
        text: renderHousingPanel({
          balance: Number(player?.balance ?? 0),
          isResting,
          fatigue: player?.fatigue ?? 0,
          health: player?.health ?? 0,
          propertiesOwned: owned.length,
          assetValue,
          recoveryPreview
        }),
        keyboard: buildHousingMenuKeyboard(isResting)
      })
      if (maintenance.chargedCount > 0 || maintenance.skippedTitles.length > 0) {
        const rows = [
          { label: '🏠 املاک شارژشده', value: `${fa(maintenance.chargedCount)} ملک` },
          { label: '💵 مجموع شارژ', value: money(maintenance.chargedTotal) }
        ]
        await showPanel(ctx, {
          text: panel({
            icon: '🧾',
            title: 'شارژ نگهداری املاک',
            sections: [
              { rows },
              ...(maintenance.skippedTitles.length > 0
                ? [
                    {
                      lines: [
                        `⚠️ برای ${fa(maintenance.skippedTitles.length)} ملک موجودی کافی نبود: ${maintenance.skippedTitles.join('، ')}`
                      ]
                    }
                  ]
                : [])
            ],
            footer: '💡 هر ۳۰ روز، ۰٫۵٪ ارزش هر ملک به‌عنوان نگهداری کسر می‌شود.'
          })
        })
      }
      return
    }

    if (section === 'banking') {
      // سود حساب به‌صورت خودکار (تنبل) تسویه می‌شود: بازیکن نباید برای گرفتن
      // سودی که به‌طور طبیعی به حسابش اضافه شده، دکمه‌ای را شکار کند. عملیات
      // idempotent است و پیش از خواندن موجودی اجرا می‌شود تا پنل عدد تازه نشان دهد.
      await container.bankingService.accrueAccountInterest(telegramUserId)
      const [account, player, credit, bankPool, loanOverview] = await Promise.all([
        container.bankingService.getOrCreateAccount(telegramUserId),
        container.playerRepository.findByTelegramUserId(telegramUserId),
        container.creditService.getCreditProfile(telegramUserId),
        // ترازنامهٔ بانک خواندنِ صرف است و اگر شکست بخورد، پنل نباید باز نشود
        container.bankingService.getPoolSnapshot().catch(() => null),
        // وضعیت واقعیِ وام (فعال / نزدیک سررسید / سررسیدگذشته). همین مسیر
        // وامِ سررسیدگذشتهٔ خودِ بازیکن را هم Lazy نکول می‌کند.
        container.bankingService.getLoanOverview(telegramUserId).catch(() => null)
      ])
      await showPanel(ctx, {
        text: renderBankPanel({
          cardNumber: account.cardNumber,
          bankBalance: Number(account.balance),
          walletBalance: Number(player?.balance ?? 0),
          totalDebt: credit.totalDebt,
          creditScore: credit.score,
          creditGrade: credit.gradeLabel,
          ...(bankPool
            ? {
                bankPool: {
                  liquidity: bankPool.liquidity,
                  totalDeposited: bankPool.totalDeposited,
                  totalDisbursed: bankPool.totalDisbursed
                }
              }
            : {}),
          ...(loanOverview
            ? {
                loan: {
                  remaining: Math.round(Number(loanOverview.loan.remainingAmount)),
                  statusLabel: loanOverview.lifecycle.label,
                  ...warningFor(loanOverview.lifecycle)
                }
              }
            : {})
        }),
        keyboard: buildBankingMenuKeyboard()
      })
      return
    }

    if (section === 'education') {
      const eduStatus = await container.educationService.getPlayerEducationStatus(telegramUserId)
      await showPanel(ctx, {
        text: renderEducationPanel(eduStatus),
        keyboard: buildEducationMenuKeyboard(
          eduStatus.enrollment.canGraduate,
          eduStatus.enrollment.isStudying
        )
      })
      return
    }

    if (section === 'occupation') {
      const [player, workStatus, workplace] = await Promise.all([
        container.playerRepository.findByTelegramUserId(telegramUserId),
        container.workSessionService.getActiveSessionStatus(telegramUserId),
        container.workSessionService.getWorkplace(telegramUserId)
      ])
      // اضافه‌کاری مزد فوری دارد و فقط در شیفتِ پاره‌وقت معنا می‌دهد
      const overtime =
        workStatus && !workStatus.workplaceShift
          ? await container.overtimeService.getOvertimeStatus(telegramUserId)
          : { available: false, cooldownRemainingMin: 0 }

      await showPanel(ctx, {
        text: renderWorkPanel({
          isWorking: Boolean(workStatus),
          jobTitle: workStatus?.session.jobTitle,
          elapsedMinutes: workStatus?.calculation.elapsedMinutes,
          earned: workStatus?.calculation.totalEarnedMoney,
          workplaceShift: Boolean(workStatus?.workplaceShift),
          balance: Number(player?.balance ?? 0),
          experience: player?.experience ?? 0,
          fatigue: player?.fatigue ?? 0,
          health: player?.health ?? 0,
          activityState: player?.activityState
        }),
        keyboard: workStatus
          ? buildActiveWorkKeyboard(overtime.available, Boolean(workStatus.workplaceShift))
          : buildWorkMenuKeyboard(Boolean(workplace))
      })
      return
    }

    if (section === 'my_biz') {
      const businesses = await container.businessService.listOwnerBusinesses(telegramUserId)
      const first = businesses[0]
      await showPanel(ctx, {
        text: renderBusinessList(businesses as never),
        keyboard:
          businesses.length === 0
            ? buildClosePanelKeyboard()
            : businesses.length === 1
              ? buildBusinessManageKeyboard(first!.id)
              : buildBusinessSelectKeyboard(businesses.map((b) => ({ id: b.id, name: b.name })))
      })
      return
    }

    if (section === 'shop') {
      await showPanel(ctx, {
        text: renderShopMainPanel(),
        keyboard: buildShopCategoriesKeyboard()
      })
      return
    }

    if (section === 'inventory') {
      const result = await container.shopService.listInventory(telegramUserId, 0)
      const totalPages = Math.ceil(result.total / result.pageSize)
      await showPanel(ctx, {
        text: renderInventoryPanel(result.rows as never, 0, result.totalValue),
        keyboard: buildInventoryListKeyboard(
          result.rows.map((r) => ({ id: r.id, name: r.item.name })),
          0,
          totalPages
        )
      })
      return
    }

    if (section === 'credit') {
      const credit = await container.creditService.getCreditProfile(telegramUserId)
      await showPanel(ctx, {
        text: renderCreditPanel(credit),
        keyboard: buildCreditKeyboard()
      })
      return
    }

    if (section === 'ledger') {
      const ledger = await container.ledgerService.getLedger(telegramUserId, 0)
      const totalPages = Math.max(1, Math.ceil(ledger.total / ledger.pageSize))
      await showPanel(ctx, {
        text: renderLedgerPanel(ledger),
        keyboard: buildLedgerKeyboard(0, totalPages)
      })
      return
    }

    if (section === 'stats') {
      const stats = await container.statisticsService.getPlayerStatistics(telegramUserId)
      await showPanel(ctx, {
        text: renderStatisticsPanel(stats),
        keyboard: buildStatsKeyboard()
      })
      return
    }

    if (section === 'city') {
      // «اقتصاد» و «شهر» هر دو از همان موتور منطقه استفاده می‌کنند (بدون Duplicate)
      const state = await container.regionService.getState(BigInt(ctx.chat!.id))
      const levelLabel =
        playerGroupLabels[state.environmentLevel as keyof typeof playerGroupLabels] ??
        state.environmentLevel
      await showPanel(ctx, {
        text: renderRegionPanel(state, levelLabel),
        keyboard: buildCityKeyboard()
      })
      return
    }

    if (section === 'home') {
      const [info, regions] = await Promise.all([
        container.residenceService.getResidenceInfo(telegramUserId),
        container.residenceService.listAvailableRegions(telegramUserId).catch(() => [])
      ])
      const levelLabel = info.residenceLevel
        ? (playerGroupLabels[info.residenceLevel as keyof typeof playerGroupLabels] ??
          info.residenceLevel)
        : null
      const canMigrate = !info.canMigrateAt || info.canMigrateAt.getTime() <= Date.now()
      await showPanel(ctx, {
        text: renderResidencePanel(info, levelLabel, regions),
        keyboard: buildResidenceKeyboard(regions, canMigrate && info.hasResidence)
      })
      return
    }

    if (section === 'news') {
      const feed = await container.newsService.getFeed(BigInt(ctx.chat!.id), 0)
      const totalPages = Math.max(1, Math.ceil(feed.total / feed.pageSize))
      await showPanel(ctx, {
        text: renderNewsPanel(feed),
        keyboard: buildNewsKeyboard(0, totalPages)
      })
      return
    }

    if (section === 'region') {
      const state = await container.regionService.getState(BigInt(ctx.chat!.id))
      const levelLabel =
        playerGroupLabels[state.environmentLevel as keyof typeof playerGroupLabels] ??
        state.environmentLevel
      const isManager = await isRegionManager(ctx, container)
      await showPanel(ctx, {
        text: renderRegionPanel(state, levelLabel),
        keyboard: buildRegionKeyboard(isManager)
      })
      return
    }

    if (section === 'rank') {
      const inGroup = isGroupContext(chatType)
      const result = inGroup
        ? await container.rankingService.getGroupRanking(BigInt(ctx.chat!.id), 'wealth', 0)
        : await container.rankingService.getGlobalPlayerRanking('wealth', 0)
      const totalPages = Math.max(1, Math.ceil(result.total / result.pageSize))
      await showPanel(ctx, {
        text: renderRankingPanel(result),
        keyboard: buildRankingKeyboard(result.scope, result.category, 0, totalPages, inGroup)
      })
      return
    }

    if (section === 'mission') {
      const board = await container.missionService.getMissionBoard(telegramUserId)
      await showPanel(ctx, {
        text: renderMissionPanel(board),
        keyboard: buildMissionKeyboard()
      })
      return
    }

    if (section === 'history') {
      const player = await container.playerRepository.findByTelegramUserId(telegramUserId)
      if (!player) {
        await showPanel(ctx, { text: texts.noProfile })
        return
      }
      const history = await container.eventService.getPlayerHistory(player.id, 0)
      const totalPages = Math.max(1, Math.ceil(history.total / history.pageSize))
      await showPanel(ctx, {
        text: renderHistoryPanel(history),
        keyboard: buildHistoryKeyboard(0, totalPages)
      })
      return
    }

    if (section === 'manage') {
      const manager = await resolveRegionRole(ctx, container)
      if (!manager.allowed) {
        await showPanel(ctx, {
          text: panel({
            icon: '🛡️',
            title: 'مدیریت منطقه',
            sections: [
              {
                lines: [
                  'این پنل فقط برای مدیران همین گروه است.',
                  '',
                  'اگر مدیر گروه هستی و این پیام را می‌بینی، کمی بعد دوباره تلاش کن.'
                ]
              }
            ]
          }),
          keyboard: buildClosePanelKeyboard()
        })
        return
      }
      const state = await container.regionService.getState(BigInt(ctx.chat!.id))
      const levelLabel =
        playerGroupLabels[state.environmentLevel as keyof typeof playerGroupLabels] ??
        state.environmentLevel
      await showPanel(ctx, {
        text: renderRegionManagementPanel(state, levelLabel, manager.roleLabel, buildRegionWarnings(state)),
        keyboard: buildManagementKeyboard()
      })
      return
    }

    if (section === 'quests') {
      const board = await container.dailyQuestService.getBoard(telegramUserId)
      await showPanel(ctx, {
        text: renderQuestPanel(board),
        keyboard: buildQuestKeyboard(board.cards, board.chestReady, board.chestClaimed)
      })
      return
    }

    if (section === 'achievements') {
      const board = await container.achievementService.getBoard(telegramUserId)
      await showPanel(ctx, {
        text: renderAchievementPanel(board),
        keyboard: buildAchievementKeyboard()
      })
      return
    }

    if (section === 'fortune') {
      const status = await container.fortuneService.getStatus(telegramUserId)
      await showPanel(ctx, {
        text: renderFortunePanel(status),
        keyboard: buildFortuneKeyboard(status.drawnToday)
      })
      return
    }

    if (section === 'deposits') {
      const board = await container.depositService.getBoard(telegramUserId)
      await showPanel(ctx, {
        text: renderDepositPanel(board),
        keyboard: buildDepositKeyboard(board.plans, board.active, board.capacityLeft)
      })
      return
    }

    if (section === 'clinic') {
      const view = await container.clinicService.getView(telegramUserId)
      await showPanel(ctx, {
        text: renderClinicPanel(view),
        keyboard: buildClinicKeyboard(view.needsTreatment, view.insured)
      })
      return
    }

    if (section === 'rental') {
      const properties = await container.rentalService.getOwnerBoard(telegramUserId)
      await showPanel(ctx, {
        text: renderRentalOwnerPanel(properties),
        keyboard: buildRentalOwnerKeyboard(properties)
      })
      return
    }

    if (section === 'passport') {
      const board = await container.passportService.getBoard(telegramUserId)
      await showPanel(ctx, {
        text: renderPassportPanel(board),
        keyboard: buildPassportKeyboard()
      })
      return
    }

    // سیستم‌های گیم‌پلی تکمیل‌شده (خانواده تا گزارش هفتگی)
    if (
      section === 'family' ||
      section === 'pets' ||
      section === 'auction' ||
      section === 'gym' ||
      section === 'loans' ||
      section === 'challenge' ||
      section === 'policy' ||
      section === 'branches' ||
      section === 'ads' ||
      section === 'report' ||
      section === 'will'
    ) {
      await openFeaturePanel(ctx, container, section, showPanel)
      return
    }

    if (section === 'leaderboard') {
      const isGroupChat = chatType === 'group' || chatType === 'supergroup'
      if (isGroupChat) {
        try {
          const result = await container.leaderboardService.groupTop(BigInt(ctx.chat!.id), 'money', 0)
          await showPanel(ctx, {
            text: renderLeaderboard(result.title, result.rows as never, 'group', 'money', 0),
            keyboard: buildLeaderboardKeyboard('group', 'money', 0, true, result.hasNextPage)
          })
          return
        } catch {
          // گروه ثبت نشده — فهرست جهانی نمایش داده می‌شود
        }
      }
      const result = await container.leaderboardService.globalTop('money', 0)
      await showPanel(ctx, {
        text: renderLeaderboard(result.title, result.rows as never, 'global', 'money', 0),
        keyboard: buildLeaderboardKeyboard('global', 'money', 0, false, result.hasNextPage)
      })
      return
    }

    if (section === 'support') {
      await showSupportPanel(ctx, container, telegramUserId, showPanel)
      return
    }

    const reply = await buildSectionReply(ctx, container, section)
    if (reply) {
      await showPanel(ctx, {
        text: reply.text,
        keyboard: reply.keyboard ?? buildClosePanelKeyboard()
      })
    }
  } catch (error) {
    if (error instanceof AppError) {
      await showPanel(ctx, {
        text: panel({
          icon: '⚠️',
          title: 'انجام نشد',
          sections: [{ lines: error.persianMessage.split('\n') }]
        }),
        keyboard: buildClosePanelKeyboard()
      })
      return
    }

    logger.error(
      {
        err: error,
        errorType: error instanceof Error ? error.name : typeof error,
        feature: 'panel',
        action: section,
        userId: ctx.from?.id,
        chatId: ctx.chat?.id,
        chatType: ctx.chat?.type
      },
      `panel failed: ${section}`
    )

    await showPanel(ctx, {
      text: panel({
        icon: '⚠️',
        title: 'باز کردن این بخش ممکن نشد',
        sections: [{ lines: ['لطفاً چند لحظه بعد دوباره تلاش کن.'] }]
      }),
      keyboard: buildClosePanelKeyboard()
    })
  }
}

async function buildSectionReply(
  ctx: Context,
  container: Container,
  section: string
): Promise<{ text: string; keyboard?: InlineKeyboard } | null> {
  const telegramUserId = BigInt(ctx.from!.id)

  switch (section) {
    case 'life': {
      const profile = await container.playerService.getProfile(telegramUserId)
      const sections: Parameters<typeof panel>[0]['sections'] = [
        {
          rows: [
            // شغلِ فعلی فقط از resolveJob می‌آید (نوبت فعال → استخدام →
            // کسب‌وکار → آخرین سابقه)؛ occupationId هرگز نوشته نمی‌شود.
            { label: '💼 کار', value: profile.jobTitle ?? 'بیکار' },
            { label: '🎓 تحصیلات', value: profile.educationDegree },
            {
              label: '❤️ سلامت',
              value: `${profile.healthLabel} · ${fa(profile.health)}/${fa(profile.maxHealth)}`
            },
            { label: '⚡ خستگی', value: barWithPercent(profile.fatigue) },
            { label: '⭐ تجربه', value: fa(profile.experience) },
            { label: '💍 تأهل', value: maritalStatusLabels[profile.maritalStatus] },
            {
              label: '🏡 محل زندگی',
              value: profile.homeGroup?.title ?? 'هنوز ثبت نشده'
            },
            {
              label: '🎂 سن',
              value: `${fa(profile.age)} سال — ${profile.lifeStageLabel}`
            }
          ]
        }
      ]
      if (profile.biography) {
        sections.push({ title: 'زندگی‌نامه', lines: [profile.biography] })
      }
      return {
        text: panel({
          icon: '🪴',
          title: 'زندگی من',
          sections,
          footer:
            '💡 برای جزئیات هر بخش، همان کلمه را بفرست: «کار»، «بانک»، «خانه»، «محل زندگی»، «خانواده» یا «آمار» — و برای تعیین وارثت «وصیت».'
        }),
        // وصیت از همین‌جا کشف می‌شود: بازیکنی که دنبالش نمی‌گردد هم یک دکمهٔ
        // مستقیم در پنل زندگی‌اش دارد.
        keyboard: buildLifeMenuKeyboard()
      }
    }
    case 'skills': {
      // پنل عمیق مهارت: وضعیت + مصرفِ واقعی + مسیر تمرینِ فعال
      const overview = await container.skillService.getTrainingOverview(telegramUserId)
      return {
        text: renderSkillsTrainingPanel(overview),
        keyboard: buildSkillsTrainingKeyboard(overview)
      }
    }
    case 'relationships': {
      const relationships = await container.relationshipService.listRelationships(telegramUserId)
      return { text: renderRelationshipsList(relationships) }
    }
    case 'notifications': {
      // `getBoard` (نه `listNotifications`) چون فقط همین متد شمارِ ناخوانده‌ها
      // را هم برمی‌گرداند و نشان‌گذاریِ خوانده/نخوانده بدون آن ممکن نبود.
      const board = await container.notificationService.getBoard(telegramUserId, 10)
      return {
        text: renderNotificationsList(board),
        keyboard: buildNotificationsKeyboard(board.unreadCount)
      }
    }
    default:
      return null
  }
}

// ────────────────────────────────────────────── پشتیبانی و گزارش مشکل

/** دسته‌های مجازِ گزارش؛ همان مقادیرِ نوع شمارشی در دیتابیس.
 *  عمداً رشتهٔ خام است نه مرجعِ زمانِ اجرای enum: اگر کلاینتِ تولیدشدهٔ Prisma
 *  از اسکیما عقب‌تر باشد (بستهٔ آفلاینِ کهنه)، خواندنِ PlayerReportCategory.BUG
 *  هنگامِ بارگذاریِ ماژول، کلِ ربات را پیش از ورود به هندلرها می‌کشد؛ با رشتهٔ
 *  خام این مهلکهٔ راه‌اندازی از بین می‌رود و `satisfies` انطباق با enumِ
 *  دیتابیس را همچنان در زمانِ کامپایل تضمین می‌کند. */
const REPORT_CATEGORIES = ['BUG', 'MONEY', 'BEHAVIOR', 'OTHER'] as const satisfies readonly PlayerReportCategory[]

/** آیا این رشتهٔ callback یک دستهٔ شناخته‌شده است؟ */
function isReportCategory(value: string): value is PlayerReportCategory {
  return (REPORT_CATEGORIES as readonly string[]).includes(value)
}

/**
 * پنل پشتیبانی: گزارش‌های خودِ بازیکن + دکمهٔ ثبت گزارش تازه.
 *
 * اگر سقف گزارش‌های بی‌پاسخ پر باشد، دکمه‌های ثبت ساخته نمی‌شوند؛ به‌جایش
 * پانویسِ پنل توضیح می‌دهد که منتظرِ پاسخ باشد. «دکمه‌ای که می‌داند شکست
 * می‌خورد نباید وجود داشته باشد.»
 */
async function showSupportPanel(
  ctx: Context,
  container: Container,
  telegramUserId: bigint,
  showPanel: typeof sendPanel
): Promise<void> {
  const reports = await container.supportService.listMine(telegramUserId)
  const openCount = reports.filter((report) => report.status === 'OPEN').length

  await showPanel(ctx, {
    text: renderSupportPanel({
      reports: reports.map((report) => ({
        id: report.id,
        categoryLabel: reportCategoryLabels[report.category],
        statusLabel: reportStatusLabels[report.status],
        body: report.body,
        answer: report.answer,
        createdAt: report.createdAt,
        answeredAt: report.answeredAt
      })),
      openCount,
      openCap: OPEN_REPORT_CAP
    }),
    keyboard: buildSupportKeyboard({ canOpenNew: openCount < OPEN_REPORT_CAP })
  })
}

/**
 * دریافت متنِ گزارش و ثبت آن.
 *
 * ترتیبِ کار: اعتبارسنجی ← ثبت در دیتابیس ← پاک‌کردنِ state ← پیام موفقیت.
 * اگر اعتبارسنجی رد شود، state **پاک نمی‌شود** تا بازیکن همان‌جا متنِ درست
 * را بفرستد؛ اگر ثبت موفق شود، state پاک و پنل نتیجه با قدمِ بعدی نشان
 * داده می‌شود. هیچ‌گاه پیام موفقیت پیش از ذخیرهٔ واقعی نمی‌رود.
 */
async function handleSupportText(
  ctx: Context,
  container: Container,
  categoryKey: string
): Promise<void> {
  const fromId = BigInt(ctx.from!.id)
  const raw = ctx.message?.text ?? ''
  const category: PlayerReportCategory = isReportCategory(categoryKey) ? categoryKey : 'OTHER'

  // «انصراف/لغو/بستن» جریان را می‌بندد و به پنل پشتیبانی برمی‌گردد.
  if (isCancelWord(raw)) {
    await container.userStateRepository.clear(fromId)
    await showSupportPanel(ctx, container, fromId, sendPanel)
    return
  }

  // جریان به همان چتی گره خورده که آغاز شده؛ ورودی از چت دیگر نباید متنِ
  // ذخیره‌نشده را به گزارش تبدیل کند.
  const pending = await container.userStateRepository.findByTelegramUserId(fromId)
  const metadata = (pending?.stateData ?? null) as { chatId?: number } | null
  if (typeof metadata?.chatId === 'number' && metadata.chatId !== ctx.chat?.id) {
    await sendPanel(ctx, {
      text: 'این گزارش در چت دیگری آغاز شده بود. به همان چت برگرد یا «پشتیبانی» را همین‌جا بفرست.'
    })
    return
  }

  try {
    const report = await container.supportService.submit(fromId, category, raw)
    await container.userStateRepository.clear(fromId)

    const reports = await container.supportService.listMine(fromId)
    const openCount = reports.filter((item) => item.status === 'OPEN').length

    await sendPanel(ctx, {
      text: renderSupportSubmitted({
        categoryLabel: reportCategoryLabels[report.category],
        body: report.body,
        openCount,
        openCap: OPEN_REPORT_CAP
      }),
      keyboard: buildSupportKeyboard({ canOpenNew: openCount < OPEN_REPORT_CAP })
    })
  } catch (err) {
    await sendInputFlowError(
      ctx,
      err,
      'support',
      'submit',
      buildSupportCancelKeyboard(),
      `گزارش ثبت نشد؛ دوباره تلاش کن (متن بین ${fa(REPORT_BODY_LIMITS.min)} و ${fa(REPORT_BODY_LIMITS.max)} نویسه).`
    )
  }
}
