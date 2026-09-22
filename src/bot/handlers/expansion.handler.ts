import { Bot, Context, InlineKeyboard } from 'grammy'
import { Container } from '../../services/container'
import { editPanel, sendPanel, ackCallback } from '../panel'
import {
  faDate, panel, fa, money, bar } from '../ui-kit'
import { handleCallbackError, handleCommandError } from '../handler-errors'
import { askForConfirmation } from '../confirm-action'
import { CANDIDACY_DEPOSIT } from '../../modules/city/elections.service'
import { MAX_ACTIVE_LISTINGS } from '../../modules/market/trade.service'
import { hoursUntil } from '../../utils/game-time'
import { CLINIC_INFO } from '../../modules/health/clinic.service'
import { MAX_PROJECT_DONATION, type RegionProjectView } from '../../modules/city/projects.service'
import {
  buildMarketListKeyboard,
  buildMyListingsKeyboard,
  buildMarketCancelKeyboard,
  buildQuestKeyboard,
  buildAchievementKeyboard,
  buildFortuneKeyboard,
  buildDepositKeyboard,
  buildDepositCancelKeyboard,
  buildDepositBoardKeyboard,
  buildClinicKeyboard,
  buildRentalOwnerKeyboard,
  buildRentalMarketKeyboard,
  buildRentalCancelKeyboard,
  buildPassportKeyboard
} from '../keyboards/main.keyboard'
import {
  renderQuestPanel,
  renderAchievementPanel,
  renderFortunePanel,
  renderDepositPanel,
  renderClinicPanel,
  renderRentalOwnerPanel,
  renderRentalMarketPanel,
  renderPassportPanel
} from '../renders'
import { isCancelWord, parseAmountDetailed, parseAmountInput } from '../../utils/commands'
import {
  groupOnlyAlert,
  groupOnlyNotice,
  isSectionAllowedHere,
  notSetupAlert,
  privateOnlyNotice
} from '../chat-policy'
import {
  buildClosePanelKeyboard,
  buildSectionDoneKeyboard
} from '../keyboards/main.keyboard'
import { texts } from '../../utils/classes/texts'

export function registerExpansionHandlers(bot: Bot, container: Container): void {
  bot.callbackQuery('streak:claim', async (ctx) => {
    const fromId = BigInt(ctx.from.id)
    try {
      const result = await container.rewardsService.claimDailyStreak(fromId)
      await ackCallback(ctx, `+${result.reward.toLocaleString('fa-IR')} تومان!`)
      await editPanel(ctx, {
        text: panel({
          icon: '🔥',
          title: 'پاداش استریک',
          sections: [
            {
              rows: [
                { label: '⚡ زنجیره', value: `${fa(result.streak)} روز` },
                { label: '💰 پاداش', value: money(result.reward) }
              ]
            }
          ],
          footer:
            result.streak >= 7
              ? '🏆 به سقف زنجیره رسیدی. فردا از روز اول شروع می‌شود.'
              : '💡 زنجیره را نشکن تا پاداش بیشتر شود.'
        })
      })
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'rewards',
        action: 'claim_streak',
        fallback: 'دریافت پاداش استریک انجام نشد.'
      })
    }
  })

  // ---------- سخت کار کردن (همان فشارِ کوتاهِ پرمزد) ----------
  bot.callbackQuery('work:overtime', async (ctx) => {
    const fromId = BigInt(ctx.from.id)
    try {
      const result = await container.overtimeService.startOvertime(fromId)
      if (result.skipped) {
        await ackCallback(ctx, 'همین حالا یک فشارِ تازه کشیدی!')
        return
      }
      await ackCallback(ctx, `+${result.earned.toLocaleString('fa-IR')} تومان`)
      await editPanel(ctx, {
        text: panel({
          icon: '🔥',
          title: 'با تمام توان کار کردی',
          sections: [
            {
              rows: [
                { label: '💼 شغل', value: result.jobTitle },
                { label: '⏱️ مدت', value: `${fa(result.minutes)} دقیقه` },
                { label: '💰 دستمزد', value: money(result.earned) },
                { label: '⚡ خستگی', value: `+${fa(result.fatigueAdded)}٪` },
                { label: '❤️ سلامت', value: `−${fa(result.healthLost)}٪` },
                ...(result.conditionFactor !== undefined && result.conditionFactor < 1
                  ? [
                      {
                        label: '⚙️ توان بدنی',
                        value: `${fa(Math.round(result.conditionFactor * 100))}٪ — دستمزدت به همین اندازه کم شد`
                      }
                    ]
                  : [])
              ]
            }
          ],
          footer:
            result.conditionFactor !== undefined && result.conditionFactor < 1
              ? '💡 با استراحت یا درمان، فشار بعدی پردرآمدتر می‌شود.'
              : '⚠️ اگر خستگی به حد بحرانی برسد، کار خودکار متوقف می‌شود.'
        }),
        keyboard: new InlineKeyboard()
          .text('🔄 به‌روزرسانی دستمزد', 'work:status')
          .row()
          .add({ text: 'بستن', callback_data: 'panel:close', style: 'danger' })
      })
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'occupation',
        action: 'overtime',
        fallback: 'سخت کار کردن ثبت نشد.'
      })
    }
  })

  bot.callbackQuery('lottery:buy', async (ctx) => {
    if (!isAllowedHere(ctx, 'lottery')) {
      await ackCallback(ctx, groupOnlyAlert('lottery'), true)
      return
    }
    const fromId = BigInt(ctx.from.id)
    try {
      const group = await resolveGroup(container, BigInt(ctx.chat!.id))
      if (!group) {
        await ackCallback(ctx, notSetupAlert(), true)
        return
      }
      const result = await container.lotteryService.buyTicket(fromId, group.id)
      await ackCallback(ctx, 'بلیت خریدی! 🎰')
      await editPanel(ctx, {
        text: panel({
          icon: '🎫',
          title: 'بلیت خریداری شد',
          sections: [{
            rows: [
              { label: '👥 شرکت‌کنندگان', value: fa(result.participants) },
              { label: '💰 جایزهٔ فعلی', value: money(result.prizeEstimate) }
            ]
          }],
          footer: 'قرعه هر هفته کشیده می‌شود. موفق باشی!'
        })
      })
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'lottery',
        action: 'buy_ticket',
        fallback: 'خرید بلیت انجام نشد.'
      })
    }
  })

  // ---------- پروژه‌های شهری ----------
  bot.callbackQuery('city:projects', async (ctx) => {
    if (!isAllowedHere(ctx, 'city')) {
      await ackCallback(ctx, groupOnlyAlert('city'), true)
      return
    }
    try {
      // گاردِ ثبت‌بودن گروه پیش از اولین ack؛ ack دوم به کاربر نمی‌رسد
      const group = await resolveGroup(container, BigInt(ctx.chat!.id))
      if (!group) {
        await ackCallback(ctx, notSetupAlert(), true)
        return
      }
      await ackCallback(ctx)
      await handleCityProjects(ctx, container, group)
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'projects',
        action: 'open_panel',
        fallback: 'باز کردن پروژه‌های شهر ممکن نشد.'
      })
    }
  })

  // آغاز رسمی پروژه: فقط شهردارِ فعال، و پشت تأیید دومرحله‌ای. تصمیم
  // برگشت‌ناپذیر است و برای همیشه در سرگذشت منطقه می‌ماند؛ پس یک کلیکِ
  // اتفاقی نباید آن را اجرا کند. هیچ پولی اینجا رد و بدل نمی‌شود.
  bot.callbackQuery(/^project:launch:/, async (ctx) => {
    const key = ctx.callbackQuery.data.split(':')[2] ?? ''
    if (!isAllowedHere(ctx, 'city')) {
      await ackCallback(ctx, groupOnlyAlert('city'), true)
      return
    }

    try {
      const group = await resolveGroup(container, BigInt(ctx.chat!.id))
      if (!group) {
        await ackCallback(ctx, notSetupAlert(), true)
        return
      }

      const isMayor = await container.policyService.canManage(BigInt(ctx.from.id), group.id)
      if (!isMayor) {
        await ackCallback(ctx, 'فقط شهردارِ فعالِ منطقه می‌تواند پروژه را رسماً آغاز کند.', true)
        return
      }

      const project = (await container.projectsService.listProjects(group.id)).find(
        (p) => p.key === key
      )
      if (!project) {
        await ackCallback(ctx, 'این پروژه در فهرست شهر نیست.', true)
        return
      }
      if (project.isLaunched) {
        await ackCallback(ctx, 'این پروژه پیش‌تر رسماً آغاز شده است.', true)
        return
      }

      await ackCallback(ctx)
      await askForConfirmation(ctx, container, {
        kind: 'project_launch',
        icon: '🚩',
        title: 'آغاز رسمی پروژه',
        rows: [
          { label: '🏗️ پروژه', value: project.title },
          { label: '🎯 هدف کمک مردمی', value: money(project.targetAmount) },
          { label: '💰 جمع‌آوری‌شده', value: money(project.collectedAmount) }
        ],
        lines: [
          'با تأیید، این پروژه «پروژهٔ رسمی شهر» می‌شود و در خبرهای منطقه اعلام می‌شود.',
          'این تصمیم پولی جابه‌جا نمی‌کند، ولی برگشت‌پذیر هم نیست.'
        ],
        payload: { projectKey: key }
      })
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'projects',
        action: 'launch_prompt',
        fallback: 'صفحهٔ تأیید آغاز پروژه باز نشد.'
      })
    }
  })

  // ── سوابق کمک‌ها ──
  bot.callbackQuery(/^project:history:/, async (ctx) => {
    await ackCallback(ctx)
    try {
      const parts = (ctx.callbackQuery?.data ?? '').split(':')
      const key = parts[2]
      const page = clampPage(parts[3])
      const group = ctx.chat
        ? await resolveGroup(container, BigInt(ctx.chat.id))
        : null
      if (!group || !key) {
        await editPanel(ctx, {
          text: panel({ icon: '🏗️', title: 'سوابق کمک', sections: [{ lines: ['پروژه پیدا نشد.'] }] })
        })
        return
      }
      const board = await container.projectsService.listProjectDonations(
        group.id,
        key,
        page,
        PROJECT_PAGE_SIZE
      )
      const totalPages = Math.max(1, Math.ceil(board.total / PROJECT_PAGE_SIZE))
      const kb = new InlineKeyboard()
      if (page > 0) kb.text('⬅️ قبلی', `project:history:${key}:${page - 1}`)
      kb.text(`${fa(page + 1)} / ${fa(totalPages)}`, `project:history:${key}:${page}`)
      if (page + 1 < totalPages) kb.text('بعدی ➡️', `project:history:${key}:${page + 1}`)
      kb.row().text('🏗️ پروژه‌ها', 'city:projects')
      kb.row().add({ text: 'بستن', callback_data: 'panel:close', style: 'danger' })
      await editPanel(ctx, {
        text: renderProjectDonations(board.title, board, page, PROJECT_PAGE_SIZE),
        keyboard: kb
      })
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'projects',
        action: 'donation_history',
        fallback: 'سوابق کمک این پروژه باز نشد.'
      })
    }
  })

  bot.callbackQuery(/^project:mydonations:/, async (ctx) => {
    await ackCallback(ctx)
    try {
      const page = clampPage((ctx.callbackQuery?.data ?? '').split(':')[2])
      const player = await container.playerRepository.findByTelegramUserId(BigInt(ctx.from.id))
      if (!player) {
        await editPanel(ctx, {
          text: panel({ icon: '📜', title: 'کمک‌های من', sections: [{ lines: ['حسابت پیدا نشد.'] }] })
        })
        return
      }
      const board = await container.projectsService.listMyDonations(
        player.id,
        page,
        PROJECT_PAGE_SIZE
      )
      const totalPages = Math.max(1, Math.ceil(board.total / PROJECT_PAGE_SIZE))
      const kb = new InlineKeyboard()
      if (page > 0) kb.text('⬅️ قبلی', `project:mydonations:${page - 1}`)
      kb.text(`${fa(page + 1)} / ${fa(totalPages)}`, `project:mydonations:${page}`)
      if (page + 1 < totalPages) kb.text('بعدی ➡️', `project:mydonations:${page + 1}`)
      kb.row().text('🏗️ پروژه‌ها', 'city:projects')
      kb.row().add({ text: 'بستن', callback_data: 'panel:close', style: 'danger' })
      await editPanel(ctx, {
        text: renderMyDonations(board, page, PROJECT_PAGE_SIZE),
        keyboard: kb
      })
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'projects',
        action: 'my_donations',
        fallback: 'سوابق کمک‌هایت باز نشد.'
      })
    }
  })

  bot.callbackQuery(/^project:donate:/, async (ctx) => {
    const [, , key, amountStr] = ctx.callbackQuery.data.split(':')
    const amount = Number(amountStr)
    const fromId = BigInt(ctx.from.id)
    if (!isAllowedHere(ctx, 'city')) {
      await ackCallback(ctx, groupOnlyAlert('city'), true)
      return
    }
    if (!Number.isSafeInteger(amount) || amount <= 0) return

    try {
      const group = await resolveGroup(container, BigInt(ctx.chat!.id))
      if (!group) {
        await ackCallback(ctx, notSetupAlert(), true)
        return
      }
      const res = await container.projectsService.donate(fromId, group.id, key!, amount)
      await container.dailyQuestService
        .trackByTelegramId(fromId, 'project_donation')
        .catch(() => undefined)

      if (res.completedNow) {
        await ackCallback(ctx, '🎉 پروژه تکمیل شد!', true)
      } else {
        // نامِ پروژه در پیام می‌آید: چند پروژه در یک صفحه دکمه دارند و بازیکن
        // باید بفهمد این مبلغ کدام‌یک را جلو برد.
        await ackCallback(ctx, `${money(res.donated)} به «${res.projectTitle}» کمک شد`)
      }
      await handleCityProjects(ctx, container, group)
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'projects',
        action: 'donate',
        fallback: 'کمک به این پروژه ثبت نشد.',
        meta: { projectKey: key, amount }
      })
    }
  })

  // ---------- کمک با مبلغ دلخواه ----------
  bot.callbackQuery(/^project:custom:/, async (ctx) => {
    const key = ctx.callbackQuery.data.split(':')[2] ?? ''
    const fromId = BigInt(ctx.from.id)
    if (!isAllowedHere(ctx, 'city')) {
      await ackCallback(ctx, groupOnlyAlert('city'), true)
      return
    }
    await ackCallback(ctx)
    try {
      const group = await resolveGroup(container, BigInt(ctx.chat!.id))
      if (!group) {
        await ackCallback(ctx, notSetupAlert(), true)
        return
      }
      const project = (await container.projectsService.listProjects(group.id)).find(
        (p) => p.key === key && !p.isCompleted
      )
      if (!project) {
        await ackCallback(ctx, 'این پروژه دیگر باز نیست', true)
        await handleCityProjects(ctx, container, group)
        return
      }

      await container.userStateRepository.upsert(fromId, {
        currentContext: `project_amount:${key}`,
        stateData: {}
      })

      await editPanel(ctx, {
        text: panel({
          icon: '💚',
          title: `کمک به «${project.title}»`,
          sections: [
            { lines: ['✍️ مبلغ را بفرست.'] },
            {
              rows: [
                { label: '📉 باقی‌مانده', value: money(project.remainingAmount) },
                { label: '🔝 سقف هر کمک', value: money(MAX_PROJECT_DONATION) }
              ]
            }
          ],
          footer: '💡 «۱۰۰ میلیون» هم می‌پذیرد؛ بیشتر از باقی‌مانده کسر نمی‌شود.'
        }),
        keyboard: buildSectionDoneKeyboard('🏙️ پروژه‌ها', 'city:projects')
      })
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'projects',
        action: 'custom_amount',
        fallback: 'باز کردنِ کمک دلخواه ممکن نشد.',
        meta: { projectKey: key }
      })
    }
  })

  // ---------- انتخابات ----------
  bot.callbackQuery('city:elections', async (ctx) => {
    if (!isAllowedHere(ctx, 'city')) {
      await ackCallback(ctx, groupOnlyAlert('city'), true)
      return
    }
    try {
      // گاردِ ثبت‌بودن گروه پیش از اولین ack؛ ack دوم به کاربر نمی‌رسد
      const group = await resolveGroup(container, BigInt(ctx.chat!.id))
      if (!group) {
        await ackCallback(ctx, notSetupAlert(), true)
        return
      }
      await ackCallback(ctx)
      await handleElections(ctx, container, group.id)
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'elections',
        action: 'open_panel',
        fallback: 'باز کردن پنل انتخابات ممکن نشد.'
      })
    }
  })

  bot.callbackQuery('election:candidacy', async (ctx) => {
    if (!isAllowedHere(ctx, 'city')) {
      await ackCallback(ctx, groupOnlyAlert('city'), true)
      return
    }
    const fromId = BigInt(ctx.from.id)
    try {
      const group = await resolveGroup(container, BigInt(ctx.chat!.id))
      if (!group) {
        // return بی‌پیام یعنی چرخندهٔ بی‌پایان برای کاربر
        await ackCallback(ctx, notSetupAlert(), true)
        return
      }
      const result = await container.electionsService.registerCandidacy(fromId, group.id)
      await ackCallback(ctx, 'نامزدی‌ات ثبت شد! 📝', true)
      await editPanel(ctx, {
        text: panel({
          icon: '📝',
          title: 'نامزدی ثبت شد',
          sections: [
            {
              rows: [
                { label: '🗳️ انتخابات', value: result.title },
                { label: '💰 ودیه', value: money(CANDIDACY_DEPOSIT) }
              ]
            },
            { lines: ['از ساکنان منطقه بخواه به تو رأی بدهند.'] }
          ],
          footer: 'ودیه پس از پایان انتخابات برگردانده می‌شود.'
        }),
        keyboard: new InlineKeyboard()
          .text('🗳️ پنل انتخابات', 'city:elections')
          .row()
          .add({ text: 'بستن', callback_data: 'panel:close', style: 'danger' })
      })
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'elections',
        action: 'register_candidacy',
        fallback: 'ثبت نامزدی انجام نشد.'
      })
    }
  })

  bot.callbackQuery(/^election:vote:/, async (ctx) => {
    const candidateId = ctx.callbackQuery.data.split(':')[2] ?? ''
    if (!isAllowedHere(ctx, 'city')) {
      await ackCallback(ctx, groupOnlyAlert('city'), true)
      return
    }
    const fromId = BigInt(ctx.from.id)
    try {
      const group = await resolveGroup(container, BigInt(ctx.chat!.id))
      if (!group) {
        await ackCallback(ctx, notSetupAlert(), true)
        return
      }
      await container.electionsService.castVote(fromId, group.id, candidateId)
      await ackCallback(ctx, 'رأیت ثبت شد! 🗳️')
      await handleElections(ctx, container, group.id)
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'elections',
        action: 'cast_vote',
        fallback: 'ثبت رأی انجام نشد.'
      })
    }
  })

  // ---------- بازار بازیکنان ----------
  bot.callbackQuery(/^mkt:list:\d+$/, async (ctx) => {
    await ackCallback(ctx)
    const page = Number(ctx.callbackQuery.data.split(':')[2]) || 0
    try {
      await showMarket(ctx, container, page)
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'trade',
        action: 'list_active',
        fallback: 'باز کردن بازار ممکن نشد.'
      })
    }
  })

  bot.callbackQuery('mkt:mine', async (ctx) => {
    await ackCallback(ctx)
    const fromId = BigInt(ctx.from.id)
    try {
      const listings = await container.tradeService.listMine(fromId)
      await editPanel(ctx, {
        text: renderMyListings(listings),
        keyboard: buildMyListingsKeyboard(
          listings.map((l) => ({ id: l.id, itemName: l.itemName }))
        )
      })
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'trade',
        action: 'list_mine',
        fallback: 'خواندن آگهی‌های تو ممکن نشد.'
      })
    }
  })

  bot.callbackQuery(/^mkt:sell:/, async (ctx) => {
    const inventoryId = ctx.callbackQuery.data.split(':')[2] ?? ''
    const fromId = BigInt(ctx.from.id)
    await ackCallback(ctx)

    // ترتیب درست: اول واجد شرایط بودن، بعد ورود به جریانِ گرفتنِ ورودی.
    // اگر بازیکن سقف آگهی را پر کرده باشد، نباید تعداد و قیمت بفرستد و
    // آن‌وقت بفهمد نمی‌تواند ثبت کند؛ در آن حالت هیچ Stateی هم ساخته نمی‌شود.
    const activeListings = await container.tradeService
      .activeListingCount(fromId)
      .catch(() => 0)
    if (activeListings >= MAX_ACTIVE_LISTINGS) {
      await editPanel(ctx, {
        text: panel({
          icon: '🧺',
          title: 'قفسهٔ فروش تو پر است',
          sections: [
            {
              lines: [
                `الان ${fa(activeListings)} آگهی فعال داری و سقف ${fa(
                  MAX_ACTIVE_LISTINGS
                )} آگهی است.`
              ]
            },
            {
              lines: [
                '🔄 اول یکی از آگهی‌هایت را لغو کن یا تا پایان ۴۸ ساعتش صبر کن.',
                '💡 هر آگهی کالا را در امانت نگه می‌دارد؛ آگهی بی‌خریدار یعنی کالای قفل‌شده.'
              ]
            }
          ],
          footer: 'آخرین آگهی‌ها معمولاً زودتر فروش می‌روند: قیمت را کمی پایین‌تر بگذار.'
        }),
        keyboard: buildSectionDoneKeyboard('🏷️ آگهی‌های من', 'mkt:mine')
      })
      return
    }

    // شناسهٔ کالا در State نگه داشته می‌شود تا پیام بعدی کاربر قیمت تلقی شود
    await container.userStateRepository.upsert(fromId, {
      currentContext: `market_sell:${inventoryId}`,
      stateData: {}
    })

    await editPanel(ctx, {
      text: panel({
        icon: '🏷️',
        title: 'ثبت آگهی فروش',
        sections: [
          { lines: ['✍️ تعداد و قیمت هر عدد را بفرست.', 'قالب: `تعداد قیمت`'] },
          { lines: ['مثال: `2 150000` یعنی ۲ عدد، هر عدد ۱۵۰٬۰۰۰ تومان.'] }
        ],
        footer: '💡 کالا تا فروش یا لغو آگهی از انبارت رزرو می‌شود.'
      }),
      keyboard: buildMarketCancelKeyboard()
    })
  })

  bot.callbackQuery('mkt:sell_cancel', async (ctx) => {
    const fromId = BigInt(ctx.from.id)
    await container.userStateRepository.clear(fromId)
    await ackCallback(ctx, 'ثبت آگهی لغو شد')
    await editPanel(ctx, {
      text: panel({
        icon: '✖️',
        title: 'ثبت آگهی لغو شد',
        sections: [{ lines: ['هیچ کالایی از انبارت کم نشد.'] }]
      }),
      keyboard: new InlineKeyboard()
        .text('🎒 انبار من', 'inv:list:0')
        .row()
        .add({ text: 'بستن', callback_data: 'panel:close', style: 'danger' })
    })
  })

  bot.callbackQuery(/^mkt:cancel:/, async (ctx) => {
    const listingId = ctx.callbackQuery.data.split(':')[2] ?? ''
    const fromId = BigInt(ctx.from.id)
    try {
      await container.tradeService.cancelListing(fromId, listingId)
      await ackCallback(ctx, 'آگهی لغو شد و کالا برگشت')
      const listings = await container.tradeService.listMine(fromId)
      await editPanel(ctx, {
        text: renderMyListings(listings),
        keyboard: buildMyListingsKeyboard(
          listings.map((l) => ({ id: l.id, itemName: l.itemName }))
        )
      })
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'trade',
        action: 'cancel_listing',
        fallback: 'لغو آگهی انجام نشد.'
      })
    }
  })

  bot.callbackQuery(/^trade:buy:/, async (ctx) => {
    const listingId = ctx.callbackQuery.data.split(':')[2] ?? ''
    const fromId = BigInt(ctx.from.id)
    try {
      const result = await container.tradeService.buyListing(fromId, listingId)
      await container.dailyQuestService
        .trackByTelegramId(fromId, 'market_trade')
        .catch(() => undefined)
      await ackCallback(ctx, 'خرید موفق!')
      await editPanel(ctx, {
        text: panel({
          icon: '🤝',
          title: 'خرید موفق',
          sections: [{
            rows: [
              { label: '📦 کالا', value: result.itemName },
              { label: '🔢 تعداد', value: fa(result.quantity) },
              { label: '💰 مبلغ کل', value: money(result.totalPrice) },
              { label: '👤 فروشنده', value: result.sellerName },
              { label: '👛 موجودی تو', value: money(result.buyerBalanceAfter) }
            ]
          }],
          footer: '🎒 کالا به انبارت اضافه شد؛ از «انبار من» ببینش.'
        }),
        keyboard: new InlineKeyboard()
          .text('🤝 بازار بازیکنان', 'mkt:list:0')
          .text('🎒 انبار من', 'inv:list:0')
          .row()
          .add({ text: 'بستن', callback_data: 'panel:close', style: 'danger' })
      })
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'trade',
        action: 'buy_listing',
        fallback: 'خرید از بازار انجام نشد.'
      })
    }
  })

  // ---------- کارت‌های روزانه ----------
  bot.callbackQuery('quest:main', async (ctx) => {
    await ackCallback(ctx)
    try {
      await showQuestBoard(ctx, container)
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'quests',
        action: 'open_panel',
        fallback: 'باز کردن کارت‌های روزانه ممکن نشد.'
      })
    }
  })

  bot.callbackQuery(/^quest:claim:/, async (ctx) => {
    const questKey = ctx.callbackQuery.data.split(':')[2] ?? ''
    const fromId = BigInt(ctx.from.id)
    try {
      const result = await container.dailyQuestService.claimCard(fromId, questKey)
      const total = result.reward + result.allThreeBonus
      await ackCallback(ctx, `+${total.toLocaleString('fa-IR')} تومان!`)
      await showQuestBoard(ctx, container)
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'quests',
        action: 'claim_card',
        fallback: 'دریافت پاداش این کارت انجام نشد.',
        meta: { questKey }
      })
    }
  })

  bot.callbackQuery('quest:chest', async (ctx) => {
    const fromId = BigInt(ctx.from.id)
    try {
      const result = await container.dailyQuestService.claimWeeklyChest(fromId)
      await ackCallback(ctx, `صندوق باز شد! +${result.amount.toLocaleString('fa-IR')}`, true)
      await showQuestBoard(ctx, container)
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'quests',
        action: 'claim_chest',
        fallback: 'باز کردن صندوق هفته انجام نشد.'
      })
    }
  })

  // ---------- نشان‌ها ----------
  bot.callbackQuery('ach:main', async (ctx) => {
    const fromId = BigInt(ctx.from.id)
    try {
      const board = await container.achievementService.getBoard(fromId)
      // فقط اولین ack به کاربر می‌رسد؛ پس هشدارِ نشان تازه جای ack ساده را می‌گیرد
      if (board.newlyUnlocked.length > 0) {
        await ackCallback(ctx, `${board.newlyUnlocked.length} نشان تازه باز شد!`, true)
      } else {
        await ackCallback(ctx)
      }
      await editPanel(ctx, {
        text: renderAchievementPanel(board),
        keyboard: buildAchievementKeyboard()
      })
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'achievements',
        action: 'open_panel',
        fallback: 'باز کردن نشان‌ها ممکن نشد.'
      })
    }
  })

  // ---------- شانس روزانه ----------
  bot.callbackQuery('fortune:main', async (ctx) => {
    await ackCallback(ctx)
    const fromId = BigInt(ctx.from.id)
    try {
      const status = await container.fortuneService.getStatus(fromId)
      await editPanel(ctx, {
        text: renderFortunePanel(status),
        keyboard: buildFortuneKeyboard(status.drawnToday)
      })
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'fortune',
        action: 'open_panel',
        fallback: 'باز کردن شانس روزانه ممکن نشد.'
      })
    }
  })

  bot.callbackQuery('fortune:draw', async (ctx) => {
    const fromId = BigInt(ctx.from.id)
    try {
      const outcome = await container.fortuneService.draw(fromId)
      await ackCallback(
        ctx,
        outcome.amount > 0
          ? `${outcome.kind === 'loss' ? '−' : '+'}${outcome.amount.toLocaleString('fa-IR')} تومان`
          : 'شانس امروزت ثبت شد'
      )
      await editPanel(ctx, {
        text: renderFortunePanel({
          drawnToday: true,
          kind: outcome.kind,
          amount: outcome.amount,
          message: outcome.message
        }),
        keyboard: buildFortuneKeyboard(true)
      })
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'fortune',
        action: 'draw',
        fallback: 'کشیدن شانس امروز انجام نشد.'
      })
    }
  })

  // ---------- سپردهٔ مدت‌دار ----------
  bot.callbackQuery('dep:main', async (ctx) => {
    await ackCallback(ctx)
    try {
      await showDepositBoard(ctx, container)
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'deposits',
        action: 'open_panel',
        fallback: 'باز کردن پنل سپرده ممکن نشد.'
      })
    }
  })

  bot.callbackQuery(/^dep:open:/, async (ctx) => {
    const planKey = ctx.callbackQuery.data.split(':')[2] ?? ''
    const fromId = BigInt(ctx.from.id)
    await ackCallback(ctx)

    // مبلغ در پیام بعدی گرفته می‌شود؛ کلید پلن در خود Context حمل می‌شود
    await container.userStateRepository.upsert(fromId, {
      currentContext: `deposit_open:${planKey}`,
      stateData: {}
    })

    await editPanel(ctx, {
      text: panel({
        icon: '⏳',
        title: 'افتتاح سپرده',
        sections: [
          { lines: ['✍️ مبلغ سپرده را بفرست.'] },
          { lines: ['مثال: `2000000` یا `2M`'] }
        ],
        footer: '💡 اصل پول تا سررسید از کیف پولت خارج می‌شود.'
      }),
      keyboard: buildDepositCancelKeyboard()
    })
  })

  bot.callbackQuery('dep:cancel', async (ctx) => {
    const fromId = BigInt(ctx.from.id)
    await container.userStateRepository.clear(fromId)
    await ackCallback(ctx, 'افتتاح سپرده لغو شد')
    try {
      await showDepositBoard(ctx, container)
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'deposits',
        action: 'cancel_open',
        fallback: 'بازگشت به پنل سپرده ممکن نشد.'
      })
    }
  })

  bot.callbackQuery(/^dep:break:/, async (ctx) => {
    const depositId = ctx.callbackQuery.data.split(':')[2] ?? ''
    const fromId = BigInt(ctx.from.id)
    try {
      const result = await container.depositService.breakEarly(fromId, depositId)
      await ackCallback(ctx, `${result.payout.toLocaleString('fa-IR')} تومان دریافت کردی`)
      await editPanel(ctx, {
        text: panel({
          icon: '🔓',
          title: 'سپرده شکسته شد',
          sections: [
            {
              rows: [
                { label: '💵 اصل سپرده', value: money(result.principal) },
                { label: '💰 سود پرداختی', value: money(result.interest) },
                { label: '✂️ جریمهٔ سود', value: money(result.penalty) },
                { label: '📊 دریافتی کل', value: money(result.payout) }
              ]
            }
          ],
          footer: '💡 اگر تا سررسید صبر می‌کردی، سود کامل را می‌گرفتی.'
        }),
        // دکمهٔ بازگشت به تختهٔ سپرده‌ها؛ «انصراف» در این نقطه بی‌معنا بود.
        keyboard: buildDepositBoardKeyboard()
      })
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'deposits',
        action: 'break_early',
        fallback: 'شکست سپرده انجام نشد.'
      })
    }
  })

  // ---------- درمانگاه ----------
  bot.callbackQuery('clinic:main', async (ctx) => {
    await ackCallback(ctx)
    try {
      await showClinic(ctx, container)
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'clinic',
        action: 'open_panel',
        fallback: 'باز کردن درمانگاه ممکن نشد.'
      })
    }
  })

  bot.callbackQuery('clinic:treat', async (ctx) => {
    const fromId = BigInt(ctx.from.id)
    try {
      const result = await container.clinicService.treat(fromId)
      await ackCallback(ctx, `سلامتت کامل شد! −${result.paid.toLocaleString('fa-IR')}`)
      await editPanel(ctx, {
        text: panel({
          icon: '💉',
          title: 'درمان انجام شد',
          sections: [
            {
              rows: [
                { label: '❤️ سلامت', value: `${fa(result.newHealth)} از ۱۰۰` },
                { label: '🩹 درمان‌شده', value: `${fa(result.healedAmount)} واحد` },
                { label: '💰 پرداختی', value: money(result.paid) },
                ...(result.saved > 0
                  ? [{ label: '🛡️ صرفه‌جویی بیمه', value: money(result.saved) }]
                  : [])
              ]
            }
          ],
          footer: '💡 با بیمهٔ درمان، هزینهٔ درمان‌های بعدی کمتر می‌شود.'
        }),
        keyboard: buildSectionDoneKeyboard('🏥 درمانگاه', 'clinic:main')
      })
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'clinic',
        action: 'treat',
        fallback: 'درمان انجام نشد.'
      })
    }
  })

  bot.callbackQuery('clinic:treat_emergency', async (ctx) => {
    const fromId = BigInt(ctx.from.id)
    try {
      const result = await container.clinicService.treatEmergency(fromId)
      await ackCallback(ctx, `سلامتت ${fa(result.newHealth)} شد −${money(result.paid)}`)
      await editPanel(ctx, {
        text: panel({
          icon: '🚑',
          title: 'درمان اضطراری انجام شد',
          sections: [
            {
              rows: [
                { label: '❤️ سلامت', value: `${fa(result.newHealth)} از ۱۰۰` },
                { label: '🩹 بازیابی‌شده', value: `${fa(result.healedAmount)} واحد` },
                { label: '💰 پرداختی', value: money(result.paid) },
                ...(result.saved > 0
                  ? [{ label: '🛡️ صرفه‌جویی بیمه', value: money(result.saved) }]
                  : [])
              ]
            }
          ],
          footer:
            '💡 هنوز به سلامت کامل نرسیده‌ای؛ با درآمد بیشتر می‌توانی بقیه‌اش را هم درمان کنی.'
        }),
        keyboard: buildSectionDoneKeyboard('🚑 درمانگاه', 'clinic:main')
      })
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'clinic',
        action: 'treat_emergency',
        fallback: 'درمان اضطراری انجام نشد.'
      })
    }
  })

  bot.callbackQuery('clinic:insure', async (ctx) => {
    const fromId = BigInt(ctx.from.id)
    try {
      const result = await container.clinicService.buyInsurance(fromId)
      await ackCallback(ctx, result.extended ? 'بیمه تمدید شد' : 'بیمه فعال شد')
      // پنلِ نتیجه، نه برگشتِ بی‌صدای پنلِ درمانگاه: بازیکن باید بفهمد چی خریده،
      // چقدر داده، تا کِی پوشش دارد و بعدش چیست.
      await editPanel(ctx, {
        text: panel({
          icon: '🛡️',
          title: result.extended ? 'بیمهٔ درمان تمدید شد' : 'بیمهٔ درمان فعال شد',
          sections: [
            {
              rows: [
                { label: '💵 حق بیمه', value: money(result.premium) },
                { label: '🗓️ پوشش تا', value: faDate(result.coversUntil) },
                {
                  label: '🩹 پوشش هزینهٔ درمان',
                  value: `${fa(CLINIC_INFO.coverRatePercent)}٪ هزینه‌ها`
                }
              ]
            },
            {
              lines: [
                result.extended
                  ? 'تمدید از انتهای پوشش قبلی محاسبه شد؛ هیچ روزی از پوششت از دست نرفت.'
                  : 'از این لحظه، هر درمانی که بروی سهم کمتری از کیفت می‌رود.'
              ]
            }
          ],
          footer: '💡 پنل «درمانگاه» همیشه روزهای باقی‌ماندهٔ پوشش را نشان می‌دهد.'
        }),
        keyboard: buildSectionDoneKeyboard('🏥 درمانگاه', 'clinic:main')
      })
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'clinic',
        action: 'buy_insurance',
        fallback: 'خرید بیمه انجام نشد.'
      })
    }
  })

  // ---------- بازار اجاره ----------
  bot.callbackQuery('rent:main', async (ctx) => {
    await ackCallback(ctx)
    try {
      await showRentalOwner(ctx, container)
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'rental',
        action: 'open_owner_panel',
        fallback: 'باز کردن املاک اجاره‌ای ممکن نشد.'
      })
    }
  })

  bot.callbackQuery('rent:market', async (ctx) => {
    await ackCallback(ctx)
    try {
      await showRentalMarket(ctx, container)
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'rental',
        action: 'open_market_panel',
        fallback: 'باز کردن آگهی‌های اجاره ممکن نشد.'
      })
    }
  })

  bot.callbackQuery(/^rent:toggle:/, async (ctx) => {
    const [, , propertyId, flag] = ctx.callbackQuery.data.split(':')
    const fromId = BigInt(ctx.from.id)
    try {
      const result = await container.rentalService.setListed(
        fromId,
        propertyId ?? '',
        flag === '1'
      )
      await ackCallback(ctx, result.listed ? 'ملک عرضه شد' : 'ملک از بازار برداشته شد')
      await showRentalOwner(ctx, container)
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'rental',
        action: 'set_listed',
        fallback: 'تغییر وضعیت عرضه انجام نشد.'
      })
    }
  })

  bot.callbackQuery(/^rent:price:/, async (ctx) => {
    const propertyId = ctx.callbackQuery.data.split(':')[2] ?? ''
    const fromId = BigInt(ctx.from.id)
    await ackCallback(ctx)

    const properties = await container.rentalService.getOwnerBoard(fromId)
    const target = properties.find((property) => property.id === propertyId)

    await container.userStateRepository.upsert(fromId, {
      currentContext: `rental_price:${propertyId}`,
      stateData: {}
    })

    await editPanel(ctx, {
      text: panel({
        icon: '💰',
        title: 'تعیین اجاره‌بها',
        sections: [
          { lines: ['✍️ اجاره‌بهای ماهانه را بفرست.'] },
          ...(target
            ? [
                {
                  rows: [
                    { label: '🏠 ملک', value: target.title },
                    { label: '📊 بازهٔ مجاز', value: `${money(target.minRent)} تا ${money(target.maxRent)}` }
                  ]
                }
              ]
            : [])
        ],
        footer: '💡 قیمت خارج از بازهٔ مجاز پذیرفته نمی‌شود.'
      }),
      keyboard: buildRentalCancelKeyboard()
    })
  })

  bot.callbackQuery('rent:cancel', async (ctx) => {
    const fromId = BigInt(ctx.from.id)
    await container.userStateRepository.clear(fromId)
    await ackCallback(ctx, 'تعیین اجاره‌بها لغو شد')
    try {
      await showRentalOwner(ctx, container)
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'rental',
        action: 'cancel_price',
        fallback: 'بازگشت به املاک ممکن نشد.'
      })
    }
  })

  bot.callbackQuery(/^rent:take:/, async (ctx) => {
    const propertyId = ctx.callbackQuery.data.split(':')[2] ?? ''
    const fromId = BigInt(ctx.from.id)
    try {
      const result = await container.rentalService.rent(fromId, propertyId)
      await ackCallback(ctx, 'قرارداد اجاره بسته شد!')
      await editPanel(ctx, {
        text: panel({
          icon: '🔑',
          title: 'قرارداد اجاره',
          sections: [
            {
              rows: [
                { label: '🏠 ملک', value: result.propertyTitle },
                { label: '💰 اجاره‌بها', value: money(result.monthlyRent) },
                { label: '📅 مدت', value: `${fa(result.daysLeft)} روز` }
              ]
            }
          ],
          footer: '💡 حالا می‌توانی از بخش «خانه» در این ملک استراحت کنی.'
        }),
        keyboard: buildRentalMarketKeyboard([], true)
      })
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'rental',
        action: 'rent_property',
        fallback: 'بستن قرارداد اجاره انجام نشد.'
      })
    }
  })

  bot.callbackQuery('rent:end', async (ctx) => {
    const fromId = BigInt(ctx.from.id)
    try {
      const result = await container.rentalService.endTenancy(fromId)
      await ackCallback(ctx, `قرارداد ${result.propertyTitle} فسخ شد`)
      await showRentalMarket(ctx, container)
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'rental',
        action: 'end_tenancy',
        fallback: 'فسخ قرارداد انجام نشد.'
      })
    }
  })

  // پرداخت اجاره + تمدید ۳۰ روز: پول واقعاً از کیف مستأجر به مالک می‌رود
  // (اتومیت، بدون خلق پول) و هر دو طرف اعلان می‌گیرند.
  bot.callbackQuery('rent:renew', async (ctx) => {
    const fromId = BigInt(ctx.from.id)
    try {
      const result = await container.rentalService.renewRental(fromId)
      await ackCallback(ctx, 'اجاره پرداخت و قرارداد تمدید شد')
      await editPanel(ctx, {
        text: panel({
          icon: '💰',
          title: 'اجاره پرداخت شد',
          sections: [
            {
              rows: [
                { label: '🏠 ملک', value: result.propertyTitle },
                { label: '💵 مبلغ پرداختی', value: money(result.monthlyRent) },
                { label: '📅 تمدید شد تا', value: `${fa(result.daysLeft)} روز دیگر` }
              ]
            }
          ],
          footer: '💡 مالک اعلان دریافت کرد. برای تمدید بعدی، پیش از پایان قرارداد این دکمه را بزن.'
        }),
        keyboard: buildRentalMarketKeyboard([], true)
      })
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'rental',
        action: 'renew_rental',
        fallback: 'پرداخت اجاره انجام نشد.'
      })
    }
  })

  // ---------- گذرنامهٔ سفر ----------
  bot.callbackQuery('passport:main', async (ctx) => {
    await ackCallback(ctx)
    const fromId = BigInt(ctx.from.id)
    try {
      const board = await container.passportService.getBoard(fromId)
      await editPanel(ctx, {
        text: renderPassportPanel(board),
        keyboard: buildPassportKeyboard()
      })
    } catch (err) {
      await handleCallbackError(ctx, err, {
        feature: 'passport',
        action: 'open_panel',
        fallback: 'باز کردن گذرنامه ممکن نشد.'
      })
    }
  })

}

/**
 * پنل استریک روزانه — از کلمهٔ «استریک» در هر چت باز می‌شود.
 * همان دادهٔ سرویس پاداش است؛ فقط مسیر دسترسی از دستور به کلمه تغییر کرده.
 */
export async function showStreakPanel(ctx: Context, container: Container): Promise<void> {
  const fromId = BigInt(ctx.from!.id)
  try {
    const status = await container.rewardsService.getStreakStatus(fromId)
    const keyboard = status.claimedToday
      ? undefined
      : new InlineKeyboard().add({
          text: '🔥 دریافت پاداش',
          callback_data: 'streak:claim',
          style: 'success'
        })

    await sendPanel(ctx, {
      text: panel({
        icon: '🔥',
        title: 'استریک روزانه',
        sections: [
          {
            rows: [
              { label: '⚡ زنجیرهٔ فعلی', value: `${fa(status.currentStreak)} روز` },
              { label: '💰 پاداش بعدی', value: `${fa(status.nextReward)} تومان` }
            ]
          }
        ],
        footer: status.claimedToday
          ? '✅ پاداش امروز را گرفتی. فردا دوباره سر بزن.'
          : '👇 برای دریافت پاداش، دکمهٔ زیر را بزن.'
      }),
      keyboard
    })
  } catch (err) {
    await handleCommandError(ctx, err, {
      feature: 'rewards',
      action: 'streak_status',
      fallback: 'خواندن وضعیت استریک ممکن نشد.'
    })
  }
}

/**
 * پنل قرعه‌کشی هفتگی — فقط داخل گروه، از کلمهٔ «قرعه‌کشی».
 */
export async function showLotteryPanel(ctx: Context, container: Container): Promise<void> {
  // لایهٔ سیاست (chat-policy) پیش‌تر محیط را بررسی کرده؛ این گارد فقط دفاع
  // در عمق است و هرگز بی‌صدا برنمی‌گردد.
  if (!isAllowedHere(ctx, 'lottery')) {
    await sendPanel(ctx, { text: groupOnlyNotice('lottery'), keyboard: buildClosePanelKeyboard() })
    return
  }
  try {
    const group = await resolveGroup(container, BigInt(ctx.chat!.id))
    if (!group) {
      await sendPanel(ctx, {
        text: panel({
          icon: '🎰',
          title: 'قرعه‌کشی هفتگی',
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
    const player = await container.playerRepository.findByTelegramUserId(BigInt(ctx.from!.id))
    if (!player) {
      await sendPanel(ctx, { text: texts.noProfile })
      return
    }

    const data = await container.lotteryService.getPanelData(player.id, group.id)
    const sections: Parameters<typeof panel>[0]['sections'] = [
      {
        rows: [
          { label: '🎟️ قیمت بلیت', value: money(data.ticketPrice) },
          { label: '👥 شرکت‌کنندگان', value: `${fa(data.participantCount)} نفر` },
          { label: '💰 جایزهٔ تخمینی', value: money(data.estimatedPrize) }
        ],
        lines: [data.youHaveTicket ? '✅ بلیت این هفته را داری.' : '🎫 هنوز بلیت نگرفتی.']
      }
    ]

    if (data.lastWeek.hasResult && data.lastWeek.winnerName) {
      sections.push({
        rows: [
          { label: '🏆 برندهٔ هفتهٔ قبل', value: data.lastWeek.winnerName },
          { label: '💰 جایزه', value: money(data.lastWeek.prize) }
        ],
        lines: []
      })
    }

    const keyboard = data.youHaveTicket
      ? undefined
      : new InlineKeyboard().add({
          text: '🎟️ خرید بلیت',
          callback_data: 'lottery:buy',
          style: 'success'
        })

    await sendPanel(ctx, {
      text: panel({ icon: '🎰', title: 'قرعه‌کشی هفتگی', sections }),
      keyboard
    })
  } catch (err) {
    await handleCommandError(ctx, err, {
      feature: 'lottery',
      action: 'open_panel',
      fallback: 'باز کردن قرعه‌کشی ممکن نشد.'
    })
  }
}

/**
 * پنل دعوت دوستان — فقط در چت خصوصی، از کلمهٔ «دعوت دوستان».
 */
export async function showInvitePanel(ctx: Context, container: Container): Promise<void> {
  // لایهٔ سیاست پیش‌تر محیط را بررسی کرده؛ این گارد فقط دفاع در عمق است.
  if (ctx.chat?.type !== 'private') {
    await sendPanel(ctx, { text: privateOnlyNotice('invite'), keyboard: buildClosePanelKeyboard() })
    return
  }
  try {
    const stats = await container.rewardsService.getReferralStats(BigInt(ctx.from!.id))
    const botInfo = await ctx.api.getMe()
    const link = `https://t.me/${botInfo.username}?start=REF${stats.code}`

    await sendPanel(ctx, {
      text: panel({
        icon: '🔗',
        title: 'دعوت دوستان',
        sections: [
          { title: 'لینک اختصاصی تو', lines: [`\`${link}\``] },
          {
            rows: [
              { label: '👥 معرفی‌شده‌ها', value: fa(stats.invitedCount) },
              ...(stats.pendingCount > 0
                ? [{ label: '⏳ در انتظار تکمیل', value: fa(stats.pendingCount) }]
                : []),
              { label: '💰 پاداش معرفی', value: money(300_000) },
              { label: '🏡 پاداش اقامت', value: money(500_000) }
            ]
          }
        ],
        footer: 'دوستت لینک را باز کند و /start بزند، هر دو پاداش می‌گیرید!'
      })
    })
  } catch (err) {
    await handleCommandError(ctx, err, {
      feature: 'referral',
      action: 'invite_link',
      fallback: 'ساخت لینک دعوت ممکن نشد.'
    })
  }
}

function isGroup(ctx: Context): boolean {
  return ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup'
}
void isGroup // برای سازگاریِ تست‌های قدیمی — گارد اصلی isAllowedHere است

/** گارد متمرکز گروهی — فقط یک منبع حقیقت (SECTION_CHAT_POLICY). */
function isAllowedHere(ctx: Context, section: string): boolean {
  return isSectionAllowedHere(section, ctx.chat?.type)
}

/** پنل کارت‌های روزانه؛ در هر بازدید ردیف‌های امروز تضمین می‌شوند. */
async function showQuestBoard(ctx: Context, container: Container): Promise<void> {
  const board = await container.dailyQuestService.getBoard(BigInt(ctx.from!.id))
  await editPanel(ctx, {
    text: renderQuestPanel(board),
    keyboard: buildQuestKeyboard(board.cards, board.chestReady, board.chestClaimed)
  })
}

/** پنل سپرده؛ خودِ سرویس سررسیدهای رسیده را پیش از رندر تسویه می‌کند. */
async function showDepositBoard(ctx: Context, container: Container): Promise<void> {
  const board = await container.depositService.getBoard(BigInt(ctx.from!.id))
  await editPanel(ctx, {
    text: renderDepositPanel(board),
    keyboard: buildDepositKeyboard(board.plans, board.active, board.capacityLeft)
  })
}

async function showClinic(ctx: Context, container: Container): Promise<void> {
  const fromId = BigInt(ctx.from!.id)
  // فرسودگی بدنه Lazy است؛ پیش از نمایشِ هزینهٔ درمان، بازهٔ سپری‌شده اعمال
  // می‌شود تا بازیکن بابتِ سلامتی پول بدهد که دیگر ندارد.
  const row = await container.playerRepository.findByTelegramUserId(fromId)
  if (row) {
    await container.vitalityService.syncPlayer(row.id).catch(() => null)
  }
  const view = await container.clinicService.getView(fromId)
  const canTreatFull = view.affordableUnits >= view.missingHealth
  await editPanel(ctx, {
    text: renderClinicPanel(view),
    keyboard: buildClinicKeyboard(view.needsTreatment, view.insured, {
      canTreatFull,
      emergencyUnits: view.affordableUnits
    })
  })
}

async function showRentalOwner(ctx: Context, container: Container): Promise<void> {
  const properties = await container.rentalService.getOwnerBoard(BigInt(ctx.from!.id))
  await editPanel(ctx, {
    text: renderRentalOwnerPanel(properties),
    keyboard: buildRentalOwnerKeyboard(properties)
  })
}

async function showRentalMarket(ctx: Context, container: Container): Promise<void> {
  const fromId = BigInt(ctx.from!.id)
  const [offers, tenancy] = await Promise.all([
    container.rentalService.listRentable(fromId),
    container.rentalService.getTenancy(fromId)
  ])
  await editPanel(ctx, {
    text: renderRentalMarketPanel(offers, tenancy),
    keyboard: buildRentalMarketKeyboard(
      offers.map((offer) => ({ propertyId: offer.propertyId, title: offer.title })),
      tenancy !== null
    )
  })
}

/**
 * افتتاح سپرده از پیام متنی مبلغ.
 *
 * از `text.handler` صدا زده می‌شود چون State مسیر متن در آنجا خوانده می‌شود.
 */
export async function handleDepositAmountText(
  ctx: Context,
  container: Container,
  planKey: string,
  text: string
): Promise<boolean> {
  const fromId = BigInt(ctx.from!.id)

  if (isCancelWord(text)) {
    await container.userStateRepository.clear(fromId)
    await sendPanel(ctx, {
      text: panel({
        icon: '✖️',
        title: 'افتتاح سپرده لغو شد',
        sections: [{ lines: ['مبلغی از کیف پولت کسر نشد.'] }]
      }),
      keyboard: buildSectionDoneKeyboard('🏦 سپرده‌ها', 'dep:main')
    })
    return true
  }

  const amount = parseAmountInput(text)
  if (amount === null) {
    await sendPanel(ctx, {
      text: panel({
        icon: '⚠️',
        title: 'مبلغ نامعتبر',
        sections: [{ lines: ['مبلغ را عددی بفرست.', 'مثال: `2000000` یا `2M`'] }]
      }),
      keyboard: buildSectionDoneKeyboard('🏦 سپرده‌ها', 'dep:main')
    })
    return true
  }

  try {
    const result = await container.depositService.open(fromId, planKey, amount)
    await container.userStateRepository.clear(fromId)
    await sendPanel(ctx, {
      text: panel({
        icon: '⏳',
        title: 'سپرده افتتاح شد',
        sections: [
          {
            rows: [
              { label: '📄 پلن', value: result.planLabel },
              { label: '💵 اصل سپرده', value: money(result.principal) },
              { label: '💰 دریافتی در سررسید', value: money(result.payout) },
              { label: '📅 سررسید', value: faDate(result.maturesAt) }
            ]
          }
        ],
        footer: '💡 در سررسید، با اولین بازدید پنل سپرده مبلغ واریز می‌شود.'
      }),
      keyboard: buildSectionDoneKeyboard('🏦 سپرده‌ها', 'dep:main')
    })
  } catch (err) {
    await handleCommandError(ctx, err, {
      feature: 'deposits',
      action: 'open',
      fallback: 'افتتاح سپرده انجام نشد.'
    })
  }
  return true
}

/**
 * ورودی متنیِ «کمک با مبلغ دلخواه» به یک پروژهٔ شهر.
 *
 * مبلغ از همان خوانندهٔ مرکزیِ مبالغ می‌آید تا «۱۰۰ میلیون» و «۱٫۵ میلیارد»
 * همه‌جا یک معنا داشته باشند؛ اعتبارسنجی نهایی (وضعیت بازیکن، سقف، تراکنش)
 * در `ProjectsService.donate` است.
 */
export async function handleProjectDonationAmountText(
  ctx: Context,
  container: Container,
  projectKey: string,
  text: string
): Promise<boolean> {
  const fromId = BigInt(ctx.from!.id)

  if (isCancelWord(text)) {
    await container.userStateRepository.clear(fromId)
    await sendPanel(ctx, {
      text: panel({
        icon: '✖️',
        title: 'کمک لغو شد',
        sections: [{ lines: ['هیچ مبلغی کسر نشد.'] }]
      }),
      keyboard: buildSectionDoneKeyboard('🏙️ پروژه‌ها', 'city:projects')
    })
    return true
  }

  const group = await resolveGroup(container, BigInt(ctx.chat!.id))
  if (!group) {
    await container.userStateRepository.clear(fromId)
    await sendPanel(ctx, {
      text: panel({
        icon: '⚠️',
        title: 'کمک ثبت نشد',
        sections: [{ lines: ['این گروه هنوز به بازی وصل نشده است.'] }]
      }),
      keyboard: buildClosePanelKeyboard()
    })
    return true
  }

  const raw = text.trim()
  const badAmount = async (): Promise<void> => {
    await sendPanel(ctx, {
      text: panel({
        icon: '⚠️',
        title: 'مبلغ نامعتبر',
        sections: [
          {
            lines: [
              'مبلغ را عددی بفرست.',
              'مثال: `1000000` یا `۱۰۰ میلیون` یا `۱٫۵ میلیارد`.'
            ]
          }
        ]
      }),
      keyboard: buildSectionDoneKeyboard('🏙️ پروژه‌ها', 'city:projects')
    })
  }

  const parsed = parseAmountDetailed(raw, { max: MAX_PROJECT_DONATION })
  if (!parsed.ok) {
    if (parsed.reason === 'too_large') {
      // سقف واقعیِ سرویس است؛ پیام دقیق‌تر از «عدد نامعتبر» کمک می‌کند.
      await sendPanel(ctx, {
        text: panel({
          icon: '⚠️',
          title: 'مبلغ بیش از سقف',
          sections: [
            { lines: [`سقف هر کمک ${money(MAX_PROJECT_DONATION)} است.`] }
          ]
        }),
        keyboard: buildSectionDoneKeyboard('🏙️ پروژه‌ها', 'city:projects')
      })
      return true
    }
    await badAmount()
    return true
  }

  try {
    const res = await container.projectsService.donate(fromId, group.id, projectKey, parsed.value)
    await container.userStateRepository.clear(fromId)
    await container.dailyQuestService
      .trackByTelegramId(fromId, 'project_donation')
      .catch(() => undefined)

    await sendPanel(ctx, {
      text: panel({
        icon: res.completedNow ? '🎉' : '💚',
        title: res.completedNow ? 'پروژه تکمیل شد' : 'کمک ثبت شد',
        sections: [
          {
            rows: [
              { label: '🏗️ پروژه', value: res.projectTitle },
              { label: '💚 کسرشده', value: money(res.donated) }
            ]
          },
          {
            lines: [
              res.completedNow
                ? 'این پروژه با همین کمک به پایان رسید و اثرش به منطقه رسید.'
                : 'هر کمک یک ردیفِ جدا در «سوابق کمک‌های من» دارد.'
            ]
          }
        ]
      }),
      keyboard: buildSectionDoneKeyboard('🏙️ پروژه‌ها', 'city:projects')
    })
  } catch (err) {
    // state پاک می‌شود تا پیامِ بعدیِ بازیکن ناخواسته دوباره کمک ثبت نکند.
    await container.userStateRepository.clear(fromId).catch(() => undefined)
    await handleCommandError(ctx, err, {
      feature: 'projects',
      action: 'donate_custom',
      fallback: 'کمک به این پروژه ثبت نشد.'
    })
  }
  return true
}

/** تعیین اجاره‌بها از پیام متنی مبلغ. */
export async function handleRentalPriceText(
  ctx: Context,
  container: Container,
  propertyId: string,
  text: string
): Promise<boolean> {
  const fromId = BigInt(ctx.from!.id)

  if (isCancelWord(text)) {
    await container.userStateRepository.clear(fromId)
    await sendPanel(ctx, {
      text: panel({
        icon: '✖️',
        title: 'تعیین اجاره‌بها لغو شد',
        sections: [{ lines: ['اجاره‌بهایی ثبت نشد و ملک دست‌نخورده ماند.'] }]
      }),
      keyboard: buildSectionDoneKeyboard('🏠 اجاره', 'rent:main')
    })
    return true
  }

  const amount = parseAmountInput(text)
  if (amount === null) {
    await sendPanel(ctx, {
      text: panel({
        icon: '⚠️',
        title: 'مبلغ نامعتبر',
        sections: [{ lines: ['اجاره‌بها را عددی بفرست.', 'مثال: `1500000`'] }]
      }),
      keyboard: buildSectionDoneKeyboard('🏠 اجاره', 'rent:main')
    })
    return true
  }

  try {
    const result = await container.rentalService.setRent(fromId, propertyId, amount)
    await container.userStateRepository.clear(fromId)
    await sendPanel(ctx, {
      text: panel({
        icon: '💰',
        title: 'اجاره‌بها ثبت شد',
        sections: [
          {
            rows: [
              { label: '🏠 ملک', value: result.title },
              { label: '💰 اجاره‌بهای ماهانه', value: money(result.monthlyRent) }
            ]
          }
        ],
        footer: '💡 برای دیده شدن، ملک را در بازار اجاره عرضه کن.'
      }),
      keyboard: buildSectionDoneKeyboard('🏠 اجاره', 'rent:main')
    })
  } catch (err) {
    await handleCommandError(ctx, err, {
      feature: 'rental',
      action: 'set_rent',
      fallback: 'ثبت اجاره‌بها انجام نشد.'
    })
  }
  return true
}

async function resolveGroup(container: Container, telegramGroupId: bigint) {
  return container.groupRepository.findByTelegramGroupId(telegramGroupId)
}

/** مبلغ‌های یک‌کلیکیِ کمک؛ بقیهٔ مبالغ از «✏️ دلخواه» می‌آید. */
const PROJECT_DONATION_PRESETS: readonly number[] = [100_000, 500_000]

/** برچسبِ کوتاهِ مبلغ برای دکمهٔ موبایل: «۱۰۰ هزار» و «۱٫۵ میلیارد». */
function compactMoney(amount: number): string {
  if (amount >= 1_000_000_000) return `${fa(amount / 1_000_000_000)} میلیارد`
  if (amount >= 1_000_000) return `${fa(amount / 1_000_000)} میلیون`
  if (amount >= 1_000) return `${fa(amount / 1_000)} هزار`
  return fa(amount)
}

async function handleCityProjects(
  ctx: Context,
  container: Container,
  group: NonNullable<Awaited<ReturnType<typeof resolveGroup>>>
) {
  const projects = await container.projectsService.listProjects(group.id)
  // شهردارِ فعال می‌تواند پروژه را رسماً آغاز کند؛ همین تصمیم در پنل شهر
  // دیده می‌شود تا «شهردار بودن» فقط یک عنوان نباشد.
  const isMayor = await container.policyService
    .canManage(BigInt(ctx.from!.id), group.id)
    .catch(() => false)

  const kb = new InlineKeyboard()

  for (const p of projects) {
    if (p.isCompleted) continue
    // برچسب‌ها کوتاه‌اند و نامِ پروژه در سربرگِ بالای همین صفحه آمده است؛
    // نامِ بلندِ پروژه در هر دکمه، دکمه را روی موبایل به سه کلمه می‌رساند
    // و فقط جای دکمهٔ «سوابق» را تنگ می‌کند.
    for (const amount of PROJECT_DONATION_PRESETS) {
      kb.add({
        text: compactMoney(amount),
        callback_data: `project:donate:${p.key}:${amount}`,
        style: 'success'
      })
    }
    kb.add({
      text: '✏️ دلخواه',
      callback_data: `project:custom:${p.key}`,
      style: 'primary'
    })
    kb.row()
    if (isMayor && !p.isLaunched) {
      kb.add({ text: `🚩 آغاز رسمی`, callback_data: `project:launch:${p.key}`, style: 'primary' })
    }
    // سوابق، کنشِ اصلی نیست؛ رنگ خنثی می‌ماند تا دکمهٔ سبزِ کمک برجسته بماند.
    kb.text(`📜 سوابق`, `project:history:${p.key}:0`)
    kb.row()
  }

  // سوابقِ کمک‌ها و کمک‌های خودِ بازیکن — دسترسیِ یک‌کلیکی، نه گمشده در منو.
  kb.text('📜 سوابق کمک‌های من', 'project:mydonations:0')
  kb.row()
  kb.text('🏙️ بازگشت به شهر', 'city:refresh')
  kb.row().add({ text: 'بستن', callback_data: 'panel:close', style: 'danger' })

  await editPanel(ctx, {
    text: renderProjectsList(projects, isMayor),
    keyboard: kb
  })
}

/** صفحه‌بندیِ پروژه‌ها — کوتاه، امن و بی‌سرریز. */
const PROJECT_PAGE_SIZE = 8

function clampPage(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? '0', 10)
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 500) : 0
}

async function handleElections(ctx: Context, container: Container, groupId: string) {
  const state = await container.electionsService.getElectionState(groupId)

  const kb = new InlineKeyboard()

  if (state.phase === 'open') {
    for (const c of state.candidates) {
      kb.add({
        text: `${c.name} · ${fa(c.votes)} رأی`,
        callback_data: `election:vote:${c.playerId}`,
        style: 'primary'
      }).row()
    }
  }

  kb.add({ text: '📝 نامزد شدن', callback_data: 'election:candidacy', style: 'success' }).row()
  kb.text('🏙️ بازگشت به شهر', 'city:refresh')
  kb.row().add({ text: 'بستن', callback_data: 'panel:close', style: 'danger' })

  await editPanel(ctx, {
    text:
      state.phase === 'open'
        ? renderElections(state.candidates, state.hoursLeft)
        : renderNoElection(),
    keyboard: kb
  })
}

/** پنل انتخابات وقتی هیچ دوره‌ای باز نیست؛ اولین نامزد، دوره را آغاز می‌کند. */
function renderNoElection(): string {
  return panel({
    icon: '🗳️',
    title: 'انتخابات شهردار',
    sections: [
      {
        lines: [
          'در این منطقه هنوز دورهٔ انتخاباتی باز نشده است.',
          'اولین کسی که نامزد شود، دورهٔ جدید را آغاز می‌کند.'
        ]
      },
      {
        rows: [
          { label: '📅 طول دوره', value: `${fa(14)} روز` },
          { label: '💰 ودیهٔ نامزدی', value: money(CANDIDACY_DEPOSIT) }
        ]
      }
    ],
    footer: 'ودیه پس از پایان انتخابات به همهٔ نامزدها برگردانده می‌شود.'
  })
}

/** پنل بازار بازیکنی با صفحه‌بندی. */
async function showMarket(ctx: Context, container: Container, page: number): Promise<void> {
  const result = await container.tradeService.listActive(page)
  const totalPages = Math.max(1, Math.ceil(result.total / result.pageSize))

  await editPanel(ctx, {
    text: renderMarketList(result.listings, result.total),
    keyboard: buildMarketListKeyboard(
      result.listings.map((l) => ({ id: l.id, itemName: l.itemName, totalPrice: l.totalPrice })),
      result.page,
      totalPages
    )
  })
}

/**
 * پنل بازار بازیکنان از مسیر پیام متنی (کلیدواژهٔ «بازار»).
 * نسخهٔ ویرایشی (`showMarket`) برای دکمه‌هاست؛ این یکی پنل تازه می‌فرستد.
 */
export async function showMarketPanel(ctx: Context, container: Container): Promise<void> {
  try {
    const result = await container.tradeService.listActive(0)
    const totalPages = Math.max(1, Math.ceil(result.total / result.pageSize))
    await sendPanel(ctx, {
      text: renderMarketList(result.listings, result.total),
      keyboard: buildMarketListKeyboard(
        result.listings.map((l) => ({ id: l.id, itemName: l.itemName, totalPrice: l.totalPrice })),
        result.page,
        totalPages
      )
    })
  } catch (err) {
    await handleCommandError(ctx, err, {
      feature: 'trade',
      action: 'open_panel',
      fallback: 'باز کردن بازار ممکن نشد.'
    })
  }
}

/**
 * ثبت آگهی از پیام متنی «تعداد قیمت».
 *
 * از `text.handler` صدا زده می‌شود چون State مسیر متن در آنجا خوانده می‌شود.
 * مقدار بازگشتی `true` یعنی پیام مصرف شد و نباید به مسیرهای دیگر برود.
 */
export async function handleMarketSellText(
  ctx: Context,
  container: Container,
  inventoryId: string,
  text: string
): Promise<boolean> {
  const fromId = BigInt(ctx.from!.id)

  if (isCancelWord(text)) {
    await container.userStateRepository.clear(fromId)
    await sendPanel(ctx, {
      text: panel({
        icon: '✖️',
        title: 'ثبت آگهی لغو شد',
        sections: [{ lines: ['کالایی در بازار گذاشته نشد.'] }]
      }),
      keyboard: buildSectionDoneKeyboard('🏷️ آگهی‌های من', 'mkt:mine')
    })
    return true
  }

  const parts = text.split(/\s+/).filter(Boolean)
  const quantity = parseCount(parts[0])
  const unitPrice = parseCount(parts[1])

  if (parts.length !== 2 || quantity === null || unitPrice === null) {
    await sendPanel(ctx, {
      text: panel({
        icon: '⚠️',
        title: 'ورودی نامعتبر',
        sections: [{ lines: ['قالب درست: `تعداد قیمت`', 'مثال: `2 150000`'] }]
      }),
      keyboard: buildSectionDoneKeyboard('🏷️ آگهی‌های من', 'mkt:mine')
    })
    return true
  }

  try {
    const listing = await container.tradeService.createListing(
      fromId,
      inventoryId,
      quantity,
      unitPrice
    )
    await container.userStateRepository.clear(fromId)
    await container.dailyQuestService
      .trackByTelegramId(fromId, 'market_trade')
      .catch(() => undefined)
    await sendPanel(ctx, {
      text: panel({
        icon: '🏷️',
        title: 'آگهی ثبت شد',
        sections: [
          {
            rows: [
              { label: '📦 کالا', value: listing.itemName },
              { label: '🔢 تعداد', value: fa(listing.quantity) },
              { label: '💰 قیمت هر عدد', value: money(listing.unitPrice) },
              { label: '💵 درآمد در صورت فروش', value: money(listing.unitPrice * listing.quantity) }
            ]
          }
        ],
        footer: '⏱️ آگهی تا ۴۸ ساعت فعال است.'
      }),
      keyboard: buildSectionDoneKeyboard('🏷️ آگهی‌های من', 'mkt:mine')
    })
  } catch (err) {
    await handleCommandError(ctx, err, {
      feature: 'trade',
      action: 'create_listing',
      fallback: 'ثبت آگهی انجام نشد.'
    })
  }
  return true
}

/** عدد صحیح مثبت از ورودی فارسی یا لاتین. */
function parseCount(raw: string | undefined): number | null {
  if (!raw) return null
  const normalized = raw.replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))).replace(/[,٬]/g, '')
  if (!/^\d+$/.test(normalized)) return null
  const value = Number(normalized)
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

function renderMarketList(
  listings: Array<{ itemName: string; quantity: number; unitPrice: number; totalPrice: number; sellerName: string }>,
  total: number
): string {
  if (listings.length === 0) {
    return panel({
      icon: '🤝',
      title: 'بازار بازیکنان',
      sections: [
        {
          lines: [
            'هیچ آگهی فعالی وجود ندارد.',
            'از بخش «انبار» می‌توانی کالاهایت را برای فروش بگذاری.'
          ]
        }
      ]
    })
  }

  const lines = listings.map(
    (l, i) =>
      `${fa(i + 1)}. *${l.itemName}* ×${fa(l.quantity)} · ${money(l.unitPrice)} هر عدد\n   👤 ${l.sellerName} · مجموع ${money(l.totalPrice)}`
  )

  return panel({
    icon: '🤝',
    title: 'بازار بازیکنان',
    sections: [{ lines }],
    footer: `📦 ${fa(total)} آگهی فعال · برای خرید روی دکمه بزن.`
  })
}

function renderMyListings(
  listings: Array<{ itemName: string; quantity: number; unitPrice: unknown; expiresAt: Date }>
): string {
  if (listings.length === 0) {
    return panel({
      icon: '📋',
      title: 'آگهی‌های من',
      sections: [{ lines: ['هیچ آگهی فعالی نداری.', 'از «انبار» کالایت را برای فروش بگذار.'] }]
    })
  }

  const lines = listings.map((l) => {
    // اعتبار آگهی روی ساعت بازی گزارش می‌شود — نه با تقسیم دستی بر میلی‌ثانیه.
    const hoursLeft = hoursUntil(l.expiresAt)
    return `• *${l.itemName}* ×${fa(l.quantity)} · ${money(Number(l.unitPrice))} · ⏱️ ${fa(hoursLeft)} ساعت بازی`
  })

  return panel({
    icon: '📋',
    title: 'آگهی‌های من',
    sections: [{ lines }],
    footer: '💡 با لغو آگهی، کالا به انبارت برمی‌گردد.'
  })
}

function renderProjectsList(
  projects: RegionProjectView[],
  isMayor: boolean
): string {
  const active = projects.filter((p) => !p.isCompleted)
  const done = projects.filter((p) => p.isCompleted)

  const sections: Parameters<typeof panel>[0]['sections'] = []

  if (active.length === 0) {
    sections.push({
      lines: ['همهٔ پروژه‌های شهر تکمیل شده‌اند. شهر به دستِ خودِ ساکنانش ساخته شد. 🎉']
    })
  }

  for (const p of active) {
    // هر پروژه یک جدولِ کوتاه است، نه یک پاراگراف: چشم بازیکن باید در یک نگاه
    // بفهمد چقدر جمع شده، چقدر مانده و چند نفر پشتش ایستاده‌اند.
    sections.push({
      title: `${p.isLaunched ? '🚩' : '🏗️'} ${p.title}`,
      rows: [
        { label: '🎯 هدف', value: money(p.targetAmount) },
        { label: '💰 جمع‌شده', value: money(p.collectedAmount) },
        { label: '📉 باقی‌مانده', value: money(p.remainingAmount) },
        { label: '👥 مشارکت‌کنندگان', value: `${fa(p.participantCount)} نفر` }
      ],
      lines: [
        `${bar(p.progressPercent)} ${fa(p.progressPercent)}٪`,
        p.description,
        p.isLaunched ? '🚩 پروژهٔ رسمی شهر — شهردار پشتش ایستاده است.' : '🏗️ هنوز رسماً آغاز نشده؛ کمک‌ها ادامه دارد.'
      ]
    })
  }

  if (done.length > 0) {
    sections.push({
      title: '✅ تکمیل‌شده',
      lines: done.flatMap((p) => [
        `• *${p.title}* — ${p.description}`,
        `  با ${money(p.collectedAmount)} از ${fa(p.participantCount)} مشارکت‌کننده`
      ])
    })
  }

  const footer = isMayor
    ? '🚩 تو شهردارِ فعالی؛ می‌توانی یک پروژه را رسماً آغاز کنی تا کل منطقه خبردار شود.'
    : '💡 با کمک مالی پروژه‌ها را جلو ببر؛ پروژهٔ رسمی، هدفِ اعلام‌شدهٔ شهر است.'

  return panel({ icon: '🏗️', title: 'پروژه‌های شهر', sections, footer })
}

/** سوابق مشارکتِ یک پروژه — صفحه‌بندی‌شده و بدون هیچ دادهٔ مالیِ خصوصی. */
function renderProjectDonations(
  title: string,
  board: Awaited<ReturnType<Container['projectsService']['listProjectDonations']>>,
  page: number,
  pageSize: number
): string {
  const totalPages = Math.max(1, Math.ceil(board.total / pageSize))
  const lines =
    board.items.length > 0
      ? board.items.map(
          (item) =>
            `• ${item.donorName} — *${money(item.amount)}* · ${faDate(item.createdAt)}`
        )
      : ['هنوز کسی به این پروژه کمک نکرده است. اولین نفر باش!']

  return panel({
    icon: '📜',
    title: `سوابق کمک به «${title}»`,
    sections: [
      { rows: [{ label: '👥 مشارکت‌کننده', value: `${fa(board.total)} نفر` }] },
      { lines }
    ],
    footer: `صفحهٔ ${fa(page + 1)} از ${fa(totalPages)} — مجموع همهٔ کمک‌ها با پیشرفت پروژه یکی است.`
  })
}

/** سوابق مشارکت‌های خودِ بازیکن. */
function renderMyDonations(
  board: Awaited<ReturnType<Container['projectsService']['listMyDonations']>>,
  page: number,
  pageSize: number
): string {
  const totalPages = Math.max(1, Math.ceil(board.total / pageSize))
  const lines =
    board.items.length > 0
      ? board.items.map(
          (item) =>
            `• *${item.projectTitle}* — ${money(item.amount)} · ${faDate(item.createdAt)}`
        )
      : ['هنوز به هیچ پروژه‌ای کمک نکرده‌ای.', 'با کمک به پروژه‌های شهر، اثرش را روی منطقه‌ات می‌بینی.']

  return panel({
    icon: '📜',
    title: 'کمک‌های من به شهر',
    sections: [
      {
        rows: [
          { label: '🎁 مجموع کمک‌ها', value: money(board.totalAmount) },
          { label: '🧾 تعداد', value: `${fa(board.total)} بار` }
        ]
      },
      { lines }
    ],
    footer: `صفحهٔ ${fa(page + 1)} از ${fa(totalPages)} — هر کمک یک ردیفِ جدا و قابل‌پیگیری است.`
  })
}

function renderElections(candidates: Array<{ name: string; votes: number }>, hoursLeft: number): string {
  const lines =
    candidates.length > 0
      ? candidates.map((c, i) => `${fa(i + 1)}. ${c.name} · ${fa(c.votes)} رأی`)
      : ['هنوز نامزدی ثبت‌نام نکرده است.']

  return panel({
    icon: '🗳️',
    title: 'انتخابات شهردار',
    sections: [{ lines }],
    footer: `⏱️ زمان باقی‌مانده: ${fa(hoursLeft)} ساعت`
  })
}
