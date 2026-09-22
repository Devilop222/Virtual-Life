/**
 * هندلرهای سیستم‌های گیم‌پلی تکمیل‌شده (خانواده، حیوان، حراجی، باشگاه،
 * قرض بازیکنی، چالش، سیاست، شعبه، آگهی).
 *
 * الگوی ثابت: یک عمل = یک پنل، همیشه edit، خطا فقط با persianMessage.
 * جریان‌های ورودی متنی (مهریه، نام حیوان، مبلغ قرض، پیشنهاد حراج، متن آگهی)
 * با Context در UserState ثبت می‌شوند و در text.handler خوانده می‌شوند.
 */
import { Bot, Context } from 'grammy'
import type { Container } from '../../services/container'
import { handleCallbackError } from '../handler-errors'
import {
  groupOnlyAlert,
  groupOnlyNotice,
  isSectionAllowedHere,
  notSetupAlert
} from '../chat-policy'
import type { PanelOptions } from '../panel'
import { ackCallback, editPanel } from '../panel'
import {
  faDate, fa, money, panel } from '../ui-kit'
import {
  renderFamilyPanel,
  renderFamilyDetailPanel,
  renderPetPanel,
  renderPetShopPanel,
  renderPetReviewPanel,
  renderAuctionPanel,
  renderGymPanel,
  renderLoansPanel,
  renderChallengePanel,
  renderPolicyPanel,
  renderBranchPanel,
  renderAdsPanel,
  renderReportPanel
} from '../renders'
import { askForConfirmation } from '../confirm-action'
import { confirmationPreviews } from '../confirmations'
import { BRANCH_INFO } from '../../modules/occupation/branch.service'
import { DIVORCE_COST, MARRIAGE_INFO } from '../../modules/family/marriage.service'
import { FAMILY_LIFE_INFO } from '../../modules/family/family-life.service'
import { PLAYER_LOAN_INFO } from '../../modules/lending/player-loan.service'
import { mahrRuleLines } from '../../modules/family/mahr'
import {
  buildFamilyKeyboard,
  buildFamilyCancelKeyboard,
  buildFamilyDetailKeyboard,
  buildFamilyDivorceConfirmKeyboard,
  buildFamilyGiftCancelKeyboard,
  buildPetAdoptKeyboard,
  buildPetKeyboard,
  buildPetNameCancelKeyboard,
  buildPetReviewKeyboard,
  buildAuctionKeyboard,
  buildAuctionCancelKeyboard,
  buildGymKeyboard,
  buildLoansKeyboard,
  buildLoanRequestCancelKeyboard,
  buildChallengeKeyboard,
  buildPolicyKeyboard,
  buildBranchKeyboard,
  buildBranchBusinessKeyboard,
  buildAdsKeyboard,
  buildAdsCancelKeyboard,
  buildClosePanelKeyboard
} from '../keyboards/main.keyboard'
import { PET_KINDS } from '../../modules/pets/pet.service'
import { AD_INFO } from '../../modules/news/ad.service'
import { MAYOR_POLICIES } from '../../modules/city/policy.service'
import { daysUntil } from '../../utils/game-time'
import { showWillPanel } from './will.handler'

// ---------- پنل‌های مشترک ----------

type ShowPanelFn = (ctx: Context, options: PanelOptions) => Promise<void>

async function showFamilyPanel(
  ctx: Context,
  container: Container,
  fromId: bigint,
  showPanel: ShowPanelFn = editPanel
): Promise<void> {
  const view = await container.marriageService.getView(fromId)
  await showPanel(ctx, {
    text: renderFamilyPanel(view),
    keyboard: buildFamilyKeyboard(view)
  })
}

/** پنل عمیق خانواده: همسر، گرما، خانه و دارایی — همه از دادهٔ واقعی. */
async function showFamilyDetailPanel(
  ctx: Context,
  container: Container,
  fromId: bigint,
  showPanel: ShowPanelFn = editPanel
): Promise<void> {
  const view = await container.familyLifeService.getFamilyDetail(fromId)
  await showPanel(ctx, {
    text: renderFamilyDetailPanel(view),
    keyboard: view.hasSpouse ? buildFamilyDetailKeyboard() : buildClosePanelKeyboard()
  })
}

async function showPetPanel(
  ctx: Context,
  container: Container,
  fromId: bigint,
  showPanel: ShowPanelFn = editPanel
): Promise<void> {
  const view = await container.petService.getView(fromId)
  await showPanel(ctx, {
    text: renderPetPanel(view),
    keyboard: buildPetKeyboard(
      view !== null,
      view?.canFeed ?? false,
      view?.bonusReady ?? false,
      view?.canPlay ?? false
    )
  })
}

/** فروشگاه حیوان: قیمت، ویژگی و توانِ خرید — پیش از هر تعهدی. */
async function showPetShopPanel(
  ctx: Context,
  container: Container,
  fromId: bigint,
  showPanel: ShowPanelFn = editPanel
): Promise<void> {
  const shop = await container.petService.getShopView(fromId)
  await showPanel(ctx, {
    text: renderPetShopPanel(shop),
    keyboard: shop.hasPet
      ? buildPetKeyboard(true, false, false, false)
      : buildPetAdoptKeyboard([...shop.kinds], shop.balance)
  })
}

/** بازبینی سرپرستی: چه می‌گیری، چقدر می‌دهی، موجودی بعد از خرید. */
async function showPetReviewPanel(
  ctx: Context,
  container: Container,
  fromId: bigint,
  kindKey: string,
  showPanel: ShowPanelFn = editPanel
): Promise<void> {
  const kind = PET_KINDS.find((k) => k.key === kindKey)
  if (!kind) {
    await showPetShopPanel(ctx, container, fromId, showPanel)
    return
  }
  const shop = await container.petService.getShopView(fromId)
  const affordable = shop.balance >= kind.price
  await showPanel(ctx, {
    text: renderPetReviewPanel({
      kindName: kind.name,
      emoji: kind.emoji,
      trait: kind.trait,
      price: kind.price,
      bonusMin: kind.bonusMin,
      bonusMax: kind.bonusMax,
      balance: shop.balance,
      balanceAfter: shop.balance - kind.price,
      hasPet: shop.hasPet,
      petName: shop.petName
    }),
    keyboard: shop.hasPet
      ? buildPetKeyboard(true, false, false, false)
      : buildPetReviewKeyboard(kind.key, affordable)
  })
}

async function showAuctionPanel(
  ctx: Context,
  container: Container,
  groupId: string,
  fromId?: bigint,
  showPanel: ShowPanelFn = editPanel
): Promise<void> {
  // fromId برای دکمهٔ «پیشنهاد» لازم است: رهبرِ فعلی روی پیشنهاد خودش
  // دکمه نمی‌بیند (سرور هم این قاعده را جداگانه اجرا می‌کند).
  const view = await container.auctionService.getView(groupId, fromId)
  const canBid = !view.isClosed && !view.amILeader
  await showPanel(ctx, {
    text: renderAuctionPanel(view),
    keyboard: buildAuctionKeyboard(canBid, view.minNextBid)
  })
}

async function showGymPanel(
  ctx: Context,
  container: Container,
  fromId: bigint,
  showPanel: ShowPanelFn = editPanel
): Promise<void> {
  const view = await container.gymService.getView(fromId)
  await showPanel(ctx, {
    text: renderGymPanel(view),
    keyboard: buildGymKeyboard(view.isActive)
  })
}

async function showLoansPanel(
  ctx: Context,
  container: Container,
  fromId: bigint,
  showPanel: ShowPanelFn = editPanel
): Promise<void> {
  const view = await container.playerLoanService.getView(fromId)
  await showPanel(ctx, {
    text: renderLoansPanel(view),
    keyboard: buildLoansKeyboard(
      view.incomingRequests,
      view.active.filter((loan) => loan.role === 'borrower')
    )
  })
}

async function showChallengePanel(
  ctx: Context,
  container: Container,
  groupId: string,
  fromId: bigint,
  showPanel: ShowPanelFn = editPanel
): Promise<void> {
  const view = await container.challengeService.getView(fromId, groupId)
  await showPanel(ctx, {
    text: renderChallengePanel(view),
    keyboard: buildChallengeKeyboard(view.canClaimReward, true)
  })
}

async function showPolicyPanel(
  ctx: Context,
  container: Container,
  groupId: string,
  fromId: bigint,
  showPanel: ShowPanelFn = editPanel
): Promise<void> {
  const [active, authority, player] = await Promise.all([
    container.policyService.getActivePolicy(groupId),
    container.policyService.mayorStatus(groupId),
    container.playerRepository.findByTelegramUserId(fromId)
  ])
  const isMayor = player !== null && authority !== null && authority.playerId === player.id
  // وضعیت دورهٔ شهرداری روی خودِ پنل نوشته می‌شود: بازیکن می‌فهمد چه کسی، تا
  // کِی، و اگر دوره تمام شده چرا اختیار «موقت» است.
  const mayorLine =
    authority === null
      ? 'هنوز شهرداری انتخاب نشده؛ از پنل «انتخابات» دورهٔ تازه را شروع کن.'
      : authority.isCaretaker
        ? '⏳ دورهٔ شهرداری تمام شده و انتخابات تازه‌ای بسته نشده؛ اختیارات تا آن زمان موقت است.'
        : `⏳ تا پایان این دورهٔ شهرداری ${fa(daysUntil(authority.termEndsAt))} روز بازی باقی است.`
  await showPanel(ctx, {
    text: renderPolicyPanel([...MAYOR_POLICIES], active?.key ?? null, isMayor, mayorLine),
    keyboard: buildPolicyKeyboard([...MAYOR_POLICIES], isMayor)
  })
}

async function showBranchPanel(
  ctx: Context,
  container: Container,
  fromId: bigint,
  showPanel: ShowPanelFn = editPanel
): Promise<void> {
  const [board, regions] = await Promise.all([
    container.branchService.getOwnerBoard(fromId),
    container.groupRepository.listAll()
  ])
  await showPanel(ctx, {
    text: renderBranchPanel(board),
    keyboard: buildBranchKeyboard(board.branches, board.businesses.length > 0, regions)
  })
}

async function showAdsPanel(ctx: Context, showPanel: ShowPanelFn = editPanel): Promise<void> {
  await showPanel(ctx, {
    text: renderAdsPanel(AD_INFO),
    keyboard: buildAdsKeyboard()
  })
}

/** افتتاح شعبه و نمایش تأییدیهٔ نهایی (مسیر مشترک تک‌انتخابی و چندانتخابی). */
/**
 * افتتاح شعبه پول نقد کسر می‌کند و برگشت‌پذیر نیست، پس پیش از اجرا صفحهٔ
 * تأیید می‌گیرد. نام منطقه از خودِ منبع داده خوانده می‌شود (نه از دکمه) تا
 * بازیکن نتواند با دستکاری `callback_data` متن تأیید را جابه‌جا کند.
 */
async function askBranchOpenConfirmation(
  ctx: Context,
  container: Container,
  businessId: string,
  businessName: string,
  regionId: string
): Promise<void> {
  const regions = await container.branchService.listTargetRegions()
  const region = regions.find((r) => r.id === regionId)
  await ackCallback(ctx)
  await askForConfirmation(ctx, container, {
    kind: 'branch_open',
    payload: { businessId, regionId },
    ...confirmationPreviews.branchOpen(
      businessName,
      region?.title ?? 'منطقهٔ انتخابی',
      BRANCH_INFO.setupCost,
      BRANCH_INFO.incomePerDay
    )
  })
}

function groupOnlyAck(ctx: Context, section: string): Promise<void> {
  return ackCallback(ctx, groupOnlyAlert(section), true)
}

function isGroup(ctx: Context): boolean {
  return ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup'
}

/** گارد متمرکز بخش گروهی — از جدولِ SECTION_CHAT_POLICY می‌خواند. */
function isAllowedHere(ctx: Context, section: string): boolean {
  return isSectionAllowedHere(section, ctx.chat?.type)
}

/**
 * تبدیل شناسهٔ چت تلگرام به شناسهٔ داخلی منطقه.
 * همهٔ سرویس‌های گروهی (حراجی، چالش، سیاست) کلید خارجی به `Group.id` دارند؛
 * فرستادن شناسهٔ عددی تلگرام به آن‌ها خطای یکپارچگی می‌سازد.
 */
async function resolveFeatureGroup(ctx: Context, container: Container): Promise<string | null> {
  if (!isGroup(ctx)) return null
  const group = await container.groupRepository.findByTelegramGroupId(BigInt(ctx.chat!.id))
  return group?.id ?? null
}

async function groupNotRegisteredAck(ctx: Context): Promise<void> {
  await ackCallback(ctx, notSetupAlert(), true)
}

// ---------- نقطهٔ ورود مشترک (منوی کلمه‌ای و شهر) ----------

export type FeatureSection =
  | 'family'
  | 'pets'
  | 'auction'
  | 'gym'
  | 'loans'
  | 'challenge'
  | 'policy'
  | 'branches'
  | 'ads'
  | 'report'
  | 'will'

/** بازکردن پنل هر سیستم؛ هم از هندلرهای دکمه و هم از بخش‌های متنی استفاده می‌شود. */
export async function openFeaturePanel(
  ctx: Context,
  container: Container,
  section: FeatureSection,
  showPanel: ShowPanelFn
): Promise<void> {
  const fromId = BigInt(ctx.from!.id)

  if (section === 'auction' || section === 'challenge' || section === 'policy') {
    if (!isAllowedHere(ctx, section)) {
      // پیام هدایت از همان منبع مرکزی سیاست محیط می‌آید تا لحن و کلمهٔ
      // پیشنهادیِ هر بخش در همهٔ مسیرها یکی باشد (پیش‌تر این‌جا متن جدا داشت).
      await showPanel(ctx, { text: groupOnlyNotice(section) })
      return
    }
    const groupId = await resolveFeatureGroup(ctx, container)
    if (!groupId) {
      await showPanel(ctx, {
        text: panel({
          icon: 'ℹ️',
          title: 'گروه ثبت‌نشده',
          sections: [
            {
              lines: [
                'این گروه هنوز برای بازی راه‌اندازی نشده است.',
                'برای فعال‌سازی، یکی از مدیران گروه باید /start را بفرستد.'
              ]
            }
          ]
        })
      })
      return
    }
    if (section === 'auction') return showAuctionPanel(ctx, container, groupId, fromId, showPanel)
    if (section === 'challenge') return showChallengePanel(ctx, container, groupId, fromId, showPanel)
    return showPolicyPanel(ctx, container, groupId, fromId, showPanel)
  }

  switch (section) {
    case 'family':
      return showFamilyPanel(ctx, container, fromId, showPanel)
    case 'pets':
      return showPetPanel(ctx, container, fromId, showPanel)
    case 'gym':
      return showGymPanel(ctx, container, fromId, showPanel)
    case 'loans':
      return showLoansPanel(ctx, container, fromId, showPanel)
    case 'branches':
      return showBranchPanel(ctx, container, fromId, showPanel)
    case 'ads':
      return showAdsPanel(ctx, showPanel)
    case 'will':
      return showWillPanel(ctx, container, fromId, showPanel)
    case 'report': {
      const report = await container.reportService.getReport(fromId)
      // ارسال به مرکز اعلان فقط یک بار در هفته است (کلید یکتا داخل سرویس)
      void container.reportService.sendToNotifications(fromId, report).catch(() => undefined)
      await showPanel(ctx, {
        text: renderReportPanel(report),
        keyboard: buildClosePanelKeyboard()
      })
      return
    }
  }
}

// ---------- ثبت هندلرها ----------

export function registerFeatureHandlers(bot: Bot, container: Container): void {
  // ---------- خانواده ----------
  bot.callbackQuery('fam:main', async (ctx) => {
    const fromId = BigInt(ctx.from.id)
    await ackCallback(ctx)
    try {
      await showFamilyPanel(ctx, container, fromId)
    } catch (err) {
      await handleCallbackError(ctx, err, { feature: 'family', action: 'panel', fallback: 'پنل خانواده باز نشد.' })
    }
  })

  // زن پیشنهادِ مبلغ‌دار را همان‌طور که هست می‌پذیرد
  bot.callbackQuery(/^fam:accept:/, async (ctx) => {
    const fromId = BigInt(ctx.from.id)
    const proposalId = ctx.callbackQuery.data.split(':')[2]!
    try {
      await container.marriageService.acceptProposal(fromId, proposalId)
      await ackCallback(ctx, '💍 عقد ثبت شد')
      await showFamilyPanel(ctx, container, fromId)
    } catch (err) {
      await handleCallbackError(ctx, err, { feature: 'family', action: 'accept', fallback: 'این پیشنهاد قابل قبول نیست.' })
    }
  })

  // زن مهریه را خودش تعیین/تغییر می‌دهد؛ بعد نوبت تأیید مرد است
  bot.callbackQuery(/^fam:mahr:/, async (ctx) => {
    const fromId = BigInt(ctx.from.id)
    const proposalId = ctx.callbackQuery.data.split(':')[2]!
    await ackCallback(ctx)
    await container.userStateRepository.upsert(fromId, {
      currentContext: `family_set_mahr:${proposalId}`,
      stateData: {}
    })
    await editPanel(ctx, {
      text: panel({
        icon: '✍️',
        title: 'تعیین مهریه',
        sections: [
          {
            lines: [
              'مبلغ مهریه‌ای که می‌پسندی را *همین‌جا عددی* بفرست.',
              ...mahrRuleLines(),
              'پس از ارسال، آقای باید آن را تأیید کند تا عقد ثبت شود.'
            ]
          }
        ]
      }),
      keyboard: buildFamilyCancelKeyboard()
    })
  })

  bot.callbackQuery(/^fam:reject:/, async (ctx) => {
    const fromId = BigInt(ctx.from.id)
    const proposalId = ctx.callbackQuery.data.split(':')[2]!
    try {
      await container.marriageService.rejectProposal(fromId, proposalId)
      await ackCallback(ctx, 'پیشنهاد رد شد')
      await showFamilyPanel(ctx, container, fromId)
    } catch (err) {
      await handleCallbackError(ctx, err, { feature: 'family', action: 'reject', fallback: 'رد این پیشنهاد انجام نشد.' })
    }
  })

  // مرد مهریهٔ تعیین‌شده را تأیید و عقد را ثبت می‌کند
  bot.callbackQuery(/^fam:confirm:/, async (ctx) => {
    const fromId = BigInt(ctx.from.id)
    const proposalId = ctx.callbackQuery.data.split(':')[2]!
    try {
      await container.marriageService.confirmProposal(fromId, proposalId)
      await ackCallback(ctx, '💍 عقد ثبت شد')
      await showFamilyPanel(ctx, container, fromId)
    } catch (err) {
      await handleCallbackError(ctx, err, { feature: 'family', action: 'confirm', fallback: 'تأیید مهریه انجام نشد.' })
    }
  })

  // مرد پیش از پاسخ یا در برابر مهریهٔ تعیین‌شده انصراف می‌دهد
  bot.callbackQuery(/^fam:withdraw:/, async (ctx) => {
    const fromId = BigInt(ctx.from.id)
    const proposalId = ctx.callbackQuery.data.split(':')[2]!
    try {
      await container.marriageService.withdrawProposal(fromId, proposalId)
      await ackCallback(ctx, 'پیشنهادت پس گرفته شد')
      await showFamilyPanel(ctx, container, fromId)
    } catch (err) {
      await handleCallbackError(ctx, err, { feature: 'family', action: 'withdraw', fallback: 'انصراف ثبت نشد.' })
    }
  })

  bot.callbackQuery('fam:start_propose', async (ctx) => {
    const fromId = BigInt(ctx.from.id)
    await ackCallback(ctx)
    await container.userStateRepository.upsert(fromId, { currentContext: 'family_mahr', stateData: {} })
    await editPanel(ctx, {
      text: panel({
        icon: '💌',
        title: 'خواستگاری',
        sections: [
          {
            lines: [
              'در گروه، روی پیام کسی که می‌خواهی با او ازدواج کنی *ریپلای* کن',
              'و مبلغ مهریه پیشنهادی‌ات را عددی بفرست.',
              'ریپلای روی پیام خودِ او لازم است؛ پیام ربات هدف خواستگاری نیست.',
              '',
              ...mahrRuleLines(),
              `• اگر عدد \`0\` بفرستی، مهریه تعیین‌نشده می‌ماند و خودِ خانم آن را می‌چیند`,
              `• عقد پس از تأیید متقابل ثبت می‌شود؛ مهلت پاسخ ${fa(MARRIAGE_INFO.proposalTtlHours)} ساعت است`
            ]
          }
        ]
      }),
      keyboard: buildFamilyCancelKeyboard()
    })
  })

  bot.callbackQuery('fam:cancel_input', async (ctx) => {
    const fromId = BigInt(ctx.from.id)
    await container.userStateRepository.clear(fromId)
    await ackCallback(ctx, 'انصراف ثبت شد')
    try {
      await showFamilyPanel(ctx, container, fromId)
    } catch (err) {
      await handleCallbackError(ctx, err, { feature: 'family', action: 'cancel', fallback: 'بازگشت به پنل خانواده انجام نشد.' })
    }
  })

  bot.callbackQuery('fam:bonus', async (ctx) => {
    const fromId = BigInt(ctx.from.id)
    try {
      const res = await container.marriageService.claimCoupleBonus(fromId)
      await ackCallback(ctx, `${money(res.amount)} پاداش گرفتی`)
      await editPanel(ctx, {
        text: panel({
          icon: '💞',
          title: 'پاداش زوجین',
          sections: [
            {
              rows: [
                { label: '🪙 پاداش امروز', value: money(res.amount) },
                { label: '💞 همسر', value: res.spouseName }
              ]
            }
          ],
          footer: '💡 فردا هم سر بزن؛ پاداش روزانه است.'
        }),
        keyboard: buildClosePanelKeyboard()
      })
    } catch (err) {
      await handleCallbackError(ctx, err, { feature: 'family', action: 'bonus', fallback: 'پاداش زوجین گرفته نشد.' })
    }
  })

  // جزئیات خانواده: همسر، رابطه، خانه و دارایی
  bot.callbackQuery('fam:detail', async (ctx) => {
    const fromId = BigInt(ctx.from.id)
    await ackCallback(ctx)
    try {
      await showFamilyDetailPanel(ctx, container, fromId)
    } catch (err) {
      await handleCallbackError(ctx, err, { feature: 'family', action: 'detail', fallback: 'جزئیات خانواده باز نشد.' })
    }
  })

  // وقت مشترک: هزینه دارد، خستگی هر دو را کم و رابطه را گرم می‌کند
  bot.callbackQuery('fam:activity', async (ctx) => {
    const fromId = BigInt(ctx.from.id)
    try {
      const res = await container.familyLifeService.spendTimeTogether(fromId)
      await ackCallback(
        ctx,
        `🕯️ وقت مشترک ثبت شد — خستگیِ هر دو کم شد (گرمای رابطه: ${fa(res.warmth)})`
      )
      await showFamilyPanel(ctx, container, fromId)
    } catch (err) {
      await handleCallbackError(ctx, err, { feature: 'family', action: 'activity', fallback: 'وقت مشترک انجام نشد.' })
    }
  })

  // هدیه به همسر: ورود مبلغ با Context
  bot.callbackQuery('fam:gift', async (ctx) => {
    const fromId = BigInt(ctx.from.id)
    await ackCallback(ctx)
    await container.userStateRepository.upsert(fromId, {
      currentContext: 'family_gift',
      stateData: {}
    })
    await editPanel(ctx, {
      text: panel({
        icon: '🎁',
        title: 'هدیه به همسر',
        sections: [
          {
            lines: [
              'مبلغ هدیه را *عددی* بفرست تا از موجودی‌ات به همسرت منتقل شود.',
              `• حداقل ${money(FAMILY_LIFE_INFO.giftMin)} و حداکثر ${money(FAMILY_LIFE_INFO.giftMax)}`,
              '• هدیهٔ بزرگ‌تر رابطه را بیشتر گرم می‌کند (تا سقف مشخص)',
              '• پول واقعاً جابه‌جا می‌شود و به حساب همسر می‌نشیند'
            ]
          }
        ]
      }),
      keyboard: buildFamilyGiftCancelKeyboard()
    })
  })

  // طلاق هزینه دارد؛ یک پنل تأیید قبل از ثبت
  bot.callbackQuery('fam:divorce', async (ctx) => {
    await ackCallback(ctx)
    await editPanel(ctx, {
      text: panel({
        icon: '💔',
        title: 'ثبت طلاق',
        sections: [
          {
            lines: [
              `هزینهٔ ثبت طلاق ${money(DIVORCE_COST)} است و به شهر پرداخت می‌شود.`,
              'مهریه‌ای که هنگام عقد پرداخت شده، همسر می‌ماند و پس‌گرفته نمی‌شود.',
              'این تصمیم یک‌طرفه است؛ با دقت تأیید کن.'
            ]
          }
        ]
      }),
      keyboard: buildFamilyDivorceConfirmKeyboard()
    })
  })

  bot.callbackQuery('fam:divorce_confirm', async (ctx) => {
    const fromId = BigInt(ctx.from.id)
    try {
      const res = await container.marriageService.divorce(fromId)
      await ackCallback(ctx, 'طلاق ثبت شد')
      await editPanel(ctx, {
        text: panel({
          icon: '💔',
          title: 'طلاق ثبت شد',
          sections: [
            {
              rows: [
                { label: '💔 همسر سابق', value: res.spouseName },
                { label: '🪙 هزینهٔ ثبت', value: money(res.paidFee) }
              ]
            }
          ]
        }),
        keyboard: buildClosePanelKeyboard()
      })
    } catch (err) {
      await handleCallbackError(ctx, err, { feature: 'family', action: 'divorce', fallback: 'طلاق ثبت نشد.' })
    }
  })

  // ---------- حیوان خانگی ----------
  bot.callbackQuery('pet:main', async (ctx) => {
    const fromId = BigInt(ctx.from.id)
    await ackCallback(ctx)
    try {
      await showPetPanel(ctx, container, fromId)
    } catch (err) {
      await handleCallbackError(ctx, err, { feature: 'pet', action: 'panel', fallback: 'پنل حیوان خانگی باز نشد.' })
    }
  })

  // فروشگاه حیوان. `pet:choose_kind` نامِ قدیمیِ همین پنل است و برای
  // پنل‌های کهنهٔ روی صفحه نگه داشته شده تا دکمهٔ قدیمی هم زنده بماند.
  bot.callbackQuery('pet:shop', async (ctx) => {
    const fromId = BigInt(ctx.from.id)
    await ackCallback(ctx)
    try {
      await showPetShopPanel(ctx, container, fromId)
    } catch (err) {
      await handleCallbackError(ctx, err, { feature: 'pet', action: 'shop', fallback: 'فروشگاه حیوان باز نشد.' })
    }
  })

  bot.callbackQuery('pet:choose_kind', async (ctx) => {
    const fromId = BigInt(ctx.from.id)
    await ackCallback(ctx)
    try {
      await showPetShopPanel(ctx, container, fromId)
    } catch (err) {
      await handleCallbackError(ctx, err, { feature: 'pet', action: 'shop_legacy', fallback: 'فروشگاه حیوان باز نشد.' })
    }
  })

  // مرحلهٔ بازبینی: هیچ State و هیچ تعهدی اینجا ساخته نمی‌شود.
  bot.callbackQuery(/^pet:adopt:/, async (ctx) => {
    const fromId = BigInt(ctx.from.id)
    const kindKey = ctx.callbackQuery.data.split(':')[2]!
    await ackCallback(ctx)
    try {
      await showPetReviewPanel(ctx, container, fromId, kindKey)
    } catch (err) {
      await handleCallbackError(ctx, err, { feature: 'pet', action: 'review', fallback: 'صفحهٔ تأیید سرپرستی باز نشد.' })
    }
  })

  // تأییدِ نهایی: تنها جایی که State نام نوشته می‌شود — و فقط وقتی همهٔ
  // شرایط (حیوانِ موجود، موجودیِ کافی) همین حالا دوباره سنجیده شده باشد.
  bot.callbackQuery(/^pet:adopt_go:/, async (ctx) => {
    const fromId = BigInt(ctx.from.id)
    const kindKey = ctx.callbackQuery.data.split(':')[2]!
    try {
      const kind = PET_KINDS.find((k) => k.key === kindKey)
      const shop = await container.petService.getShopView(fromId)
      if (!kind) {
        await ackCallback(ctx, 'این نژاد دیگر در فروشگاه نیست.', true)
        await showPetShopPanel(ctx, container, fromId)
        return
      }
      if (shop.hasPet) {
        await ackCallback(ctx, 'تو همین حالا یک حیوان خانگی داری.', true)
        await showPetPanel(ctx, container, fromId)
        return
      }
      if (shop.balance < kind.price) {
        await ackCallback(
          ctx,
          `${(kind.price - shop.balance).toLocaleString('fa-IR')} تومان کم داری؛ نژاد دیگری را ببین.`,
          true
        )
        await showPetShopPanel(ctx, container, fromId)
        return
      }
      await container.userStateRepository.upsert(fromId, {
        currentContext: `pet_name:${kindKey}`,
        stateData: { kindName: kind.name, price: kind.price, balanceBefore: shop.balance }
      })
      await ackCallback(ctx)
      await editPanel(ctx, {
        text: panel({
          icon: '✏️',
          title: 'نامِ حیوان',
          sections: [
            {
              rows: [
                { label: '🐾 نژاد', value: `${kind.emoji} *${kind.name}*` },
                { label: '💵 هزینه', value: money(kind.price) },
                { label: '💰 موجودی', value: money(shop.balance) }
              ]
            },
            {
              lines: [
                'برای هم‌سایهٔ تازه‌ات یک نام بفرست (۲ تا ۲۴ حرف).',
                'مثال: «پشمک»، «سیاه»، «کوکو».',
                '',
                'هزینه فقط پس از ثبت موفق کسر می‌شود؛ اگر چیزی درست پیش نرود،',
                'هیچ پولی از کیفت نمی‌رود.'
              ]
            }
          ],
          footer: 'برای برگشت، دکمهٔ زیر را بزن.'
        }),
        keyboard: buildPetNameCancelKeyboard()
      })
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'pet',
        action: 'adopt_start',
        fallback: 'شروع سرپرستی انجام نشد.'
      })
    }
  })

  bot.callbackQuery('pet:cancel_name', async (ctx) => {
    const fromId = BigInt(ctx.from.id)
    await container.userStateRepository.clear(fromId)
    await ackCallback(ctx, 'انصراف ثبت شد')
    try {
      await showPetPanel(ctx, container, fromId)
    } catch (err) {
      await handleCallbackError(ctx, err, { feature: 'pet', action: 'cancel', fallback: 'بازگشت به پنل حیوان انجام نشد.' })
    }
  })

  bot.callbackQuery('pet:feed', async (ctx) => {
    const fromId = BigInt(ctx.from.id)
    try {
      const res = await container.petService.feed(fromId)
      await ackCallback(
        ctx,
        res.cured
          ? `🏥 حالش بهتر شد — ${money(res.cost)} پرداخت شد`
          : `🍽️ با ${money(res.cost)} غذا داده شد`
      )
      await showPetPanel(ctx, container, fromId)
    } catch (err) {
      await handleCallbackError(ctx, err, { feature: 'pet', action: 'feed', fallback: 'غذا دادن انجام نشد.' })
    }
  })

  // بازی: رایگان، روزی یک بار — یک‌باربودنش را دیتابیس تضمین می‌کند
  bot.callbackQuery('pet:play', async (ctx) => {
    const fromId = BigInt(ctx.from.id)
    try {
      const res = await container.petService.play(fromId)
      await ackCallback(ctx, `🎾 بازی کردید — پیوند در سطح ${fa(res.bondLevel)}`)
      await showPetPanel(ctx, container, fromId)
    } catch (err) {
      await handleCallbackError(ctx, err, { feature: 'pet', action: 'play', fallback: 'بازی کردن انجام نشد.' })
    }
  })

  bot.callbackQuery('pet:bonus', async (ctx) => {
    const fromId = BigInt(ctx.from.id)
    try {
      const res = await container.petService.claimDailyBonus(fromId)
      if (!res) {
        // شفاف و بدون اسپم: امروز بررسی شد ولی هدیه‌ای نیامد.
        await ackCallback(ctx, 'امروز هدیه‌ای نیامد؛ فردا دوباره سر بزن. 🍀', true)
        await showPetPanel(ctx, container, fromId)
        return
      }
      await ackCallback(
        ctx,
        `🎁 هدیهٔ امروز: ${money(res.amount)}${res.multiplierPercent > 100 ? ` (پیوند ٪${fa(res.multiplierPercent)})` : ''}`
      )
      await showPetPanel(ctx, container, fromId)
    } catch (err) {
      await handleCallbackError(ctx, err, { feature: 'pet', action: 'bonus', fallback: 'هدیهٔ امروز گرفته نشد.' })
    }
  })

  // ---------- حراجی (گروهی) ----------
  bot.callbackQuery('auc:main', async (ctx) => {
    if (!isAllowedHere(ctx, 'auction')) {
      await groupOnlyAck(ctx, 'auction')
      return
    }
    const groupId = await resolveFeatureGroup(ctx, container)
    if (!groupId) {
      await groupNotRegisteredAck(ctx)
      return
    }
    const fromId = BigInt(ctx.from.id)
    await ackCallback(ctx)
    try {
      await showAuctionPanel(ctx, container, groupId, fromId)
    } catch (err) {
      await handleCallbackError(ctx, err, { feature: 'auction', action: 'panel', fallback: 'پنل حراجی باز نشد.' })
    }
  })

  bot.callbackQuery('auc:start_bid', async (ctx) => {
    if (!isAllowedHere(ctx, 'auction')) {
      await groupOnlyAck(ctx, 'auction')
      return
    }
    const groupId = await resolveFeatureGroup(ctx, container)
    if (!groupId) {
      await groupNotRegisteredAck(ctx)
      return
    }
    const fromId = BigInt(ctx.from.id)
    await ackCallback(ctx)
    try {
      const view = await container.auctionService.getView(groupId)
      await container.userStateRepository.upsert(fromId, { currentContext: `auction_bid:${view.id}`, stateData: {} })
      await editPanel(ctx, {
        text: panel({
          icon: '🔨',
          title: 'ثبت پیشنهاد',
          sections: [
            {
              lines: [
                `مبلغ پیشنهادت را بفرست (حداقل ${money(view.minNextBid)}).`,
                'مبلغ پیشنهاددهندهٔ قبلی بلافاصله به خودش برمی‌گردد.'
              ]
            }
          ]
        }),
        keyboard: buildAuctionCancelKeyboard()
      })
    } catch (err) {
      await handleCallbackError(ctx, err, { feature: 'auction', action: 'start_bid', fallback: 'ثبت پیشنهاد باز نشد.' })
    }
  })

  bot.callbackQuery('auc:cancel_bid', async (ctx) => {
    if (!isAllowedHere(ctx, 'auction')) {
      await groupOnlyAck(ctx, 'auction')
      return
    }
    const groupId = await resolveFeatureGroup(ctx, container)
    const fromId = BigInt(ctx.from.id)
    // در هر حالت جریان ورودی بسته می‌شود؛ اما اولین ack باید پیام درست باشد
    if (!groupId) {
      await container.userStateRepository.clear(fromId)
      await groupNotRegisteredAck(ctx)
      return
    }
    await container.userStateRepository.clear(fromId)
    await ackCallback(ctx, 'انصراف ثبت شد')
    try {
      await showAuctionPanel(ctx, container, groupId, fromId)
    } catch (err) {
      await handleCallbackError(ctx, err, { feature: 'auction', action: 'cancel_bid', fallback: 'بازگشت به پنل حراجی انجام نشد.' })
    }
  })

  // ---------- باشگاه ----------
  bot.callbackQuery('gym:main', async (ctx) => {
    const fromId = BigInt(ctx.from.id)
    await ackCallback(ctx)
    try {
      await showGymPanel(ctx, container, fromId)
    } catch (err) {
      await handleCallbackError(ctx, err, { feature: 'gym', action: 'panel', fallback: 'پنل باشگاه باز نشد.' })
    }
  })

  bot.callbackQuery('gym:subscribe', async (ctx) => {
    const fromId = BigInt(ctx.from.id)
    try {
      const res = await container.gymService.subscribe(fromId)
      await ackCallback(ctx, res.extended ? 'عضویت تمدید شد' : 'عضویت فعال شد')
      await editPanel(ctx, {
        text: panel({
          icon: '💪',
          title: res.extended ? 'عضویت تمدید شد' : 'عضویت باشگاه فعال شد',
          sections: [
            {
              rows: [
                { label: '💵 حق عضویت', value: money(res.fee) },
                { label: '📅 اعتبار تا', value: faDate(res.expiresAt) },
                { label: '❤️ سقف سلامت', value: '۱۲۰ (به‌جای ۱۰۰ پایه)' }
              ]
            }
          ]
        }),
        keyboard: buildGymKeyboard(true)
      })
    } catch (err) {
      await handleCallbackError(ctx, err, { feature: 'gym', action: 'subscribe', fallback: 'خرید عضویت انجام نشد.' })
    }
  })

  // ---------- قرض بازیکنی ----------
  bot.callbackQuery('loan:main', async (ctx) => {
    const fromId = BigInt(ctx.from.id)
    await ackCallback(ctx)
    try {
      await showLoansPanel(ctx, container, fromId)
    } catch (err) {
      await handleCallbackError(ctx, err, { feature: 'player_loan', action: 'panel', fallback: 'پنل قرض‌ها باز نشد.' })
    }
  })

  bot.callbackQuery('loan:start_request', async (ctx) => {
    const fromId = BigInt(ctx.from.id)
    await ackCallback(ctx)
    await container.userStateRepository.upsert(fromId, { currentContext: 'loan_request', stateData: {} })
    await editPanel(ctx, {
      text: panel({
        icon: '💳',
        title: 'درخواست قرض',
        sections: [
          {
            lines: [
              'روی پیام وام‌دهندهٔ موردنظرت *ریپلای* کن',
              'و مبلغ قرض را به‌صورت عدد بفرست.',
              `بازهٔ مجاز: ${money(PLAYER_LOAN_INFO.minPrincipal)} تا ${money(PLAYER_LOAN_INFO.maxPrincipal)}؛`,
              `بازپرداخت ${fa(PLAYER_LOAN_INFO.termDays)} روزه با ${fa(Math.round(PLAYER_LOAN_INFO.feeRate * 100))}٪ سود`,
              `(${fa(Math.round(PLAYER_LOAN_INFO.lenderShareRate * 100))}٪ سود وام‌دهنده + ${fa(
                Math.round((PLAYER_LOAN_INFO.feeRate - PLAYER_LOAN_INFO.lenderShareRate) * 100)
              )}٪ کارمزد سیستم).`
            ]
          }
        ]
      }),
      keyboard: buildLoanRequestCancelKeyboard()
    })
  })

  bot.callbackQuery('loan:cancel_request', async (ctx) => {
    const fromId = BigInt(ctx.from.id)
    await container.userStateRepository.clear(fromId)
    await ackCallback(ctx, 'انصراف ثبت شد')
    try {
      await showLoansPanel(ctx, container, fromId)
    } catch (err) {
      await handleCallbackError(ctx, err, { feature: 'player_loan', action: 'cancel_request', fallback: 'بازگشت به پنل قرض‌ها انجام نشد.' })
    }
  })

  bot.callbackQuery(/^loan:accept:/, async (ctx) => {
    const fromId = BigInt(ctx.from.id)
    const loanId = ctx.callbackQuery.data.split(':')[2]!
    try {
      const res = await container.playerLoanService.accept(fromId, loanId)
      await ackCallback(ctx, '✅ قرض پرداخت شد')
      await editPanel(ctx, {
        text: panel({
          icon: '🤝',
          title: 'قرض پرداخت شد',
          sections: [
            {
              rows: [
                { label: '🧑 وام‌گیرنده', value: res.borrowerName },
                { label: '💵 مبلغ پرداختی', value: money(res.principal) },
                { label: '📅 مهلت بازپرداخت', value: '۷ روز' }
              ]
            }
          ],
          footer: `💡 در سررسید، اصل پولت با ${fa(Math.round(PLAYER_LOAN_INFO.lenderShareRate * 100))}٪ سود به تو برمی‌گردد؛ ${fa(
            Math.round((PLAYER_LOAN_INFO.feeRate - PLAYER_LOAN_INFO.lenderShareRate) * 100)
          )}٪ کارمزد سیستم است.`
        }),
        keyboard: buildClosePanelKeyboard()
      })
    } catch (err) {
      await handleCallbackError(ctx, err, { feature: 'player_loan', action: 'accept', fallback: 'پرداخت این قرض انجام نشد.' })
    }
  })

  bot.callbackQuery(/^loan:reject:/, async (ctx) => {
    const fromId = BigInt(ctx.from.id)
    const loanId = ctx.callbackQuery.data.split(':')[2]!
    try {
      await container.playerLoanService.reject(fromId, loanId)
      await ackCallback(ctx, 'درخواست رد شد')
      await showLoansPanel(ctx, container, fromId)
    } catch (err) {
      await handleCallbackError(ctx, err, { feature: 'player_loan', action: 'reject', fallback: 'رد این درخواست انجام نشد.' })
    }
  })

  bot.callbackQuery(/^loan:repay:/, async (ctx) => {
    const fromId = BigInt(ctx.from.id)
    const loanId = ctx.callbackQuery.data.split(':')[2]!
    try {
      const res = await container.playerLoanService.repay(fromId, loanId)
      await ackCallback(ctx, '💳 قرض تسویه شد')
      await editPanel(ctx, {
        text: panel({
          icon: '✅',
          title: 'تسویهٔ قرض',
          sections: [
            {
              rows: [{ label: '💵 مبلغ بازپرداخت', value: money(res.paid) }]
            }
          ],
          footer: '🤝 اعتبارت نزد وام‌دهنده محفوظ ماند.'
        }),
        keyboard: buildClosePanelKeyboard()
      })
    } catch (err) {
      await handleCallbackError(ctx, err, { feature: 'player_loan', action: 'repay', fallback: 'تسویهٔ قرض انجام نشد.' })
    }
  })

  // ---------- چالش منطقه (گروهی) ----------
  bot.callbackQuery('chal:main', async (ctx) => {
    if (!isAllowedHere(ctx, 'challenge')) {
      await groupOnlyAck(ctx, 'challenge')
      return
    }
    const groupId = await resolveFeatureGroup(ctx, container)
    if (!groupId) {
      await groupNotRegisteredAck(ctx)
      return
    }
    const fromId = BigInt(ctx.from.id)
    await ackCallback(ctx)
    try {
      await showChallengePanel(ctx, container, groupId, fromId)
    } catch (err) {
      await handleCallbackError(ctx, err, { feature: 'challenge', action: 'panel', fallback: 'پنل چالش باز نشد.' })
    }
  })

  bot.callbackQuery('chal:claim', async (ctx) => {
    const fromId = BigInt(ctx.from.id)
    try {
      const res = await container.challengeService.claimReward(fromId)
      await ackCallback(ctx, `🎁 ${money(res.amount)} پاداش گرفتی`)
      await editPanel(ctx, {
        text: panel({
          icon: '🎁',
          title: 'پاداش چالش',
          sections: [
            {
              rows: [
                { label: '🏁 چالش', value: res.goalTitle },
                { label: '🪙 پاداش', value: money(res.amount) }
              ]
            }
          ]
        }),
        keyboard: buildClosePanelKeyboard()
      })
    } catch (err) {
      await handleCallbackError(ctx, err, { feature: 'challenge', action: 'claim', fallback: 'پاداش چالش گرفته نشد.' })
    }
  })

  // ---------- سیاست شهردار (گروهی) ----------
  bot.callbackQuery('pol:main', async (ctx) => {
    if (!isAllowedHere(ctx, 'policy')) {
      await groupOnlyAck(ctx, 'policy')
      return
    }
    const groupId = await resolveFeatureGroup(ctx, container)
    if (!groupId) {
      await groupNotRegisteredAck(ctx)
      return
    }
    const fromId = BigInt(ctx.from.id)
    await ackCallback(ctx)
    try {
      await showPolicyPanel(ctx, container, groupId, fromId)
    } catch (err) {
      await handleCallbackError(ctx, err, { feature: 'policy', action: 'panel', fallback: 'پنل سیاست‌ها باز نشد.' })
    }
  })

  bot.callbackQuery(/^pol:set:/, async (ctx) => {
    if (!isAllowedHere(ctx, 'policy')) {
      await groupOnlyAck(ctx, 'policy')
      return
    }
    const groupId = await resolveFeatureGroup(ctx, container)
    if (!groupId) {
      await groupNotRegisteredAck(ctx)
      return
    }
    const fromId = BigInt(ctx.from.id)
    const policyKey = ctx.callbackQuery.data.split(':')[2]!
    try {
      const res = await container.policyService.setPolicy(fromId, groupId, policyKey)
      await ackCallback(ctx, `${res.emoji} سیاست فعال شد`)
      await showPolicyPanel(ctx, container, groupId, fromId)
    } catch (err) {
      await handleCallbackError(ctx, err, { feature: 'policy', action: 'set', fallback: 'فعال‌سازی سیاست انجام نشد.' })
    }
  })

  // ---------- شعب کسب‌وکار ----------
  bot.callbackQuery('br:main', async (ctx) => {
    const fromId = BigInt(ctx.from.id)
    await ackCallback(ctx)
    try {
      await showBranchPanel(ctx, container, fromId)
    } catch (err) {
      await handleCallbackError(ctx, err, { feature: 'branch', action: 'panel', fallback: 'پنل شعبه‌ها باز نشد.' })
    }
  })

  bot.callbackQuery(/^br:open:/, async (ctx) => {
    const fromId = BigInt(ctx.from.id)
    const regionId = ctx.callbackQuery.data.split(':')[2]!
    try {
      const board = await container.branchService.getOwnerBoard(fromId)
      if (board.businesses.length === 0) {
        await ackCallback(ctx, 'اول یک کسب‌وکار تأسیس کن.', true)
        return
      }
      if (board.businesses.length > 1) {
        // چند کسب‌وکار فعال: اول انتخاب کن شعبه از کدام باشد
        await ackCallback(ctx)
        await editPanel(ctx, {
          text: panel({
            icon: '🏢',
            title: 'انتخاب کسب‌وکار',
            sections: [{ lines: ['شعبه را برای کدام کسب‌وکارت می‌خواهی؟'] }]
          }),
          keyboard: buildBranchBusinessKeyboard(regionId, board.businesses)
        })
        return
      }
      const business = board.businesses[0]!
      await askBranchOpenConfirmation(ctx, container, business.id, business.name, regionId)
    } catch (err) {
      await handleCallbackError(ctx, err, { feature: 'branch', action: 'open', fallback: 'افتتاح شعبه انجام نشد.' })
    }
  })

  bot.callbackQuery(/^br:pick:/, async (ctx) => {
    const fromId = BigInt(ctx.from.id)
    const [, , regionId, businessId] = ctx.callbackQuery.data.split(':')
    if (!regionId || !businessId) {
      await ackCallback(ctx, 'این دکمه دیگر معتبر نیست؛ پنل شعبه را دوباره باز کن.', true)
      return
    }
    try {
      // نام کسب‌وکار از دیتابیس گرفته می‌شود، نه از payload دکمه
      const board = await container.branchService.getOwnerBoard(fromId)
      const business = board.businesses.find((b) => b.id === businessId)
      if (!business) {
        await ackCallback(ctx, 'این کسب‌وکار دیگر در فهرست تو نیست؛ پنل شعبه را به‌روزرسانی کن.', true)
        return
      }
      await askBranchOpenConfirmation(ctx, container, business.id, business.name, regionId)
    } catch (err) {
      await handleCallbackError(ctx, err, { feature: 'branch', action: 'open_pick', fallback: 'افتتاح شعبه انجام نشد.' })
    }
  })

  bot.callbackQuery(/^br:collect:/, async (ctx) => {
    const fromId = BigInt(ctx.from.id)
    const branchId = ctx.callbackQuery.data.split(':')[2]!
    try {
      const res = await container.branchService.collectIncome(fromId, branchId)
      await ackCallback(ctx, `💰 ${money(res.net)} به کیف پول رسید`)
      await editPanel(ctx, {
        text: panel({
          icon: '💰',
          title: 'برداشت درآمد شعبه',
          sections: [
            {
              rows: [
                { label: '🧭 شعبه', value: res.regionTitle },
                { label: '📅 روزهای انباشت', value: `${fa(res.days)} روز` },
                { label: '💵 درآمد ناخالص شعبه', value: money(res.amount) },
                { label: '🏛️ مالیات بر سود (۱۵٪)', value: money(res.tax) },
                { label: '💰 به کیف تو', value: `*${money(res.net)}*` }
              ]
            }
          ],
          footer: 'مالیات بر سود شعبه به صندوق عمومی همان منطقه می‌رود.'
        }),
        keyboard: buildClosePanelKeyboard()
      })
    } catch (err) {
      await handleCallbackError(ctx, err, { feature: 'branch', action: 'collect', fallback: 'برداشت درآمد شعبه انجام نشد.' })
    }
  })

  // ---------- آگهی همگانی ----------
  bot.callbackQuery('ad:main', async (ctx) => {
    await ackCallback(ctx)
    try {
      await showAdsPanel(ctx)
    } catch (err) {
      await handleCallbackError(ctx, err, { feature: 'ad', action: 'panel', fallback: 'پنل آگهی باز نشد.' })
    }
  })

  bot.callbackQuery('ad:start', async (ctx) => {
    const fromId = BigInt(ctx.from.id)
    await ackCallback(ctx)
    await container.userStateRepository.upsert(fromId, { currentContext: 'ad_text', stateData: {} })
    await editPanel(ctx, {
      text: panel({
        icon: '✏️',
        title: 'نوشتن آگهی',
        sections: [
          {
            lines: [
              `متن آگهی‌ات را بفرست (حداکثر ${fa(AD_INFO.maxLength)} نویسه).`,
              `هزینهٔ انتشار: ${money(AD_INFO.fee)} — هر روز یک آگهی.`
            ]
          }
        ]
      }),
      keyboard: buildAdsCancelKeyboard()
    })
  })

  bot.callbackQuery('ad:cancel', async (ctx) => {
    const fromId = BigInt(ctx.from.id)
    await container.userStateRepository.clear(fromId)
    await ackCallback(ctx, 'انصراف ثبت شد')
    try {
      await showAdsPanel(ctx)
    } catch (err) {
      await handleCallbackError(ctx, err, { feature: 'ad', action: 'cancel', fallback: 'بازگشت به پنل آگهی انجام نشد.' })
    }
  })

  // ---------- گزارش هفتگی ----------
  bot.callbackQuery('report:main', async (ctx) => {
    await ackCallback(ctx)
    try {
      await openFeaturePanel(ctx, container, 'report', editPanel)
    } catch (err) {
      await handleCallbackError(ctx, err, { feature: 'report', action: 'panel', fallback: 'پنل گزارش باز نشد.' })
    }
  })
}
