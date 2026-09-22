import { InlineKeyboard } from 'grammy'
import type { Prisma } from '@prisma/client'
import { GameEventType } from '@prisma/client'
import type { Container } from '../services/container'
import { registerConfirmableAction } from './confirm-action'
import { ackCallback, editPanel } from './panel'
import { panel, fa, money } from './ui-kit'
import { ratePerGameHour } from '../utils/game-time'
import { handleCallbackError } from './handler-errors'
import {
  buildEducationBackKeyboard,
  buildHousingBackKeyboard,
  buildWillKeyboard,
  buildWorkBackKeyboard
} from './keyboards/main.keyboard'
import { renderWillPanel } from './renders'
import {
  DegreeLevel,
  EDUCATION_FIELDS,
  degreeLabels
} from '../modules/education/education-blueprints'
import { PROPERTY_BLUEPRINTS } from '../modules/housing/housing-blueprints'
import {
  logPlayerEvent,
  logRegionEvent,
  showApplicationsPanel,
  showEmployeesPanel,
  showPostingsPanel
} from './handlers/text.handler'

/**
 * عملیاتِ حساسی که پیش از اجرا صفحهٔ تأیید می‌گیرند.
 *
 * همهٔ این‌ها پول یا مسیرِ زندگی بازیکن را عوض می‌کنند و برگشتشان یا ناممکن
 * است یا پرهزینه؛ پس یک کلیکِ اتفاقی نباید انجامشان دهد. منطقِ اجرا همان
 * منطقِ قبلیِ handlerهاست — فقط پشتِ تأیید نشسته است.
 */

function str(payload: Prisma.JsonObject, key: string): string {
  const value = payload[key]
  return typeof value === 'string' ? value : ''
}

export function registerConfirmableActions(): void {
  // ── آغاز رسمی پروژهٔ شهری (فقط شهردارِ فعال) ────────────────────
  registerConfirmableAction({
    kind: 'project_launch',
    async run(ctx, container: Container, payload) {
      const fromId = BigInt(ctx.from!.id)
      const projectKey = str(payload, 'projectKey')
      try {
        const group = await container.groupRepository.findByTelegramGroupId(BigInt(ctx.chat!.id))
        if (!group) {
          await ackCallback(ctx, 'این گروه هنوز برای بازی راه‌اندازی نشده است.', true)
          return
        }
        const result = await container.projectsService.launchProject(fromId, group.id, projectKey)
        await ackCallback(ctx, '🚩 پروژه رسماً آغاز شد')
        await editPanel(ctx, {
          text: panel({
            icon: '🚩',
            title: 'پروژهٔ رسمی شهر آغاز شد',
            sections: [
              {
                rows: [
                  { label: '🏗️ پروژه', value: result.title },
                  { label: '🎯 هدف کمک مردمی', value: money(result.targetAmount) },
                  { label: '💰 جمع‌آوری‌شده تا حالا', value: money(result.collectedAmount) }
                ]
              },
              {
                lines: [
                  'این خبر در منطقه اعلام شد؛ حالا همه می‌دانند هدف شهر چیست.',
                  'کمک‌ها همان‌جا در پنل پروژه‌ها جمع می‌شوند.'
                ]
              }
            ],
            footer: '💡 هر دوره یک شهردار می‌تواند پروژه‌های شهر را رسماً آغاز کند.'
          }),
          keyboard: new InlineKeyboard()
            .add({ text: '🏗️ پنل پروژه‌های شهر', callback_data: 'city:projects', style: 'primary' })
            .text('بستن', 'panel:close')
        })
      } catch (err) {
        await handleCallbackError(ctx, err, {
          feature: 'projects',
          action: 'launch',
          fallback: 'آغاز رسمی پروژه انجام نشد.'
        })
      }
    }
  })

  // ── انتخاب رشتهٔ تحصیلی ──────────────────────────────────────────
  registerConfirmableAction({
    kind: 'edu_enroll',
    async run(ctx, container: Container, payload) {
      const fromId = BigInt(ctx.from!.id)
      const fieldKey = str(payload, 'fieldKey')
      const degree = str(payload, 'degree') as DegreeLevel
      try {
        const result = await container.educationService.enrollInUniversity(fromId, fieldKey, degree)
        await logPlayerEvent(
          container,
          fromId,
          GameEventType.EDUCATION_ENROLLED,
          `ثبت‌نام در رشتهٔ ${result.field.title}`
        )
        await ackCallback(ctx, 'ثبت‌نام انجام شد')
        await editPanel(ctx, {
          text: panel({
            icon: '🎓',
            title: 'ثبت‌نام انجام شد',
            sections: [
              {
                rows: [
                  { label: '📚 رشته', value: result.field.title },
                  { label: '🎓 مقطع', value: degreeLabels[degree as keyof typeof degreeLabels] ?? degree },
                  { label: '👛 موجودی تو', value: money(result.balanceAfter) }
                ]
              }
            ],
            footer: '💡 پیشرفت تحصیل را از پنل «تحصیل» دنبال کن؛ مدرک بالاتر، درآمد بیشتر.'
          }),
          keyboard: buildEducationBackKeyboard()
        })
      } catch (err) {
        await handleCallbackError(ctx, err, {
          feature: 'education',
          action: 'enroll',
          fallback: 'ثبت‌نام در این رشته انجام نشد.'
        })
      }
    }
  })

  // ── خرید ملک ─────────────────────────────────────────────────────
  registerConfirmableAction({
    kind: 'house_buy',
    async run(ctx, container: Container, payload) {
      const fromId = BigInt(ctx.from!.id)
      const typeKey = str(payload, 'typeKey')
      try {
        const { property, balanceAfter } = await container.housingService.buyPropertyByBlueprint(
          fromId,
          typeKey
        )
        await logPlayerEvent(container, fromId, GameEventType.HOUSE_PURCHASED, 'خرید ملک جدید')
        await ackCallback(ctx, 'خرید ملک انجام شد')
        await editPanel(ctx, {
          text: panel({
            icon: '🎉',
            title: 'سند ملک به نامت خورد',
            sections: [
              {
                rows: [
                  { label: '🏠 ملک', value: property.title ?? typeKey },
                  { label: '💵 پرداختی', value: money(Number(property.purchasePrice ?? 0)) },
                  { label: '👛 موجودی تو', value: money(balanceAfter) }
                ]
              }
            ],
            footer: '💡 حالا می‌توانی در خانه‌ات استراحت کنی، یا آن را اجاره بدهی.'
          }),
          keyboard: buildHousingBackKeyboard()
        })
      } catch (err) {
        await handleCallbackError(ctx, err, {
          feature: 'housing',
          action: 'buy_property',
          fallback: 'خرید این ملک انجام نشد.'
        })
      }
    }
  })

  // ── فروش ملک به شهر ─────────────────────────────────────────────
  registerConfirmableAction({
    kind: 'house_sell',
    async run(ctx, container: Container, payload) {
      const fromId = BigInt(ctx.from!.id)
      const propertyId = str(payload, 'propertyId')
      try {
        const result = await container.housingService.sellProperty(fromId, propertyId)
        await logPlayerEvent(container, fromId, GameEventType.ITEM_SOLD, `فروش ${result.title}`)
        await ackCallback(ctx, 'ملک فروخته شد')
        await editPanel(ctx, {
          text: panel({
            icon: '💸',
            title: 'فروش ملک انجام شد',
            sections: [
              {
                rows: [
                  { label: '🏠 ملک', value: result.title },
                  { label: '💰 مبلغ دریافتی', value: money(result.salePrice) }
                ]
              }
            ],
            footer: '💡 مبلغ به کیف پولت واریز شد و ملک از املاکت خارج شد.'
          }),
          keyboard: buildHousingBackKeyboard()
        })
      } catch (err) {
        await handleCallbackError(ctx, err, {
          feature: 'housing',
          action: 'sell_property',
          fallback: 'فروش این ملک انجام نشد.'
        })
      }
    }
  })

  // ── تأسیس کسب‌وکار ───────────────────────────────────────────────
  registerConfirmableAction({
    kind: 'biz_create',
    async run(ctx, container: Container, payload) {
      const fromId = BigInt(ctx.from!.id)
      const modelType = str(payload, 'modelType')
      const title = str(payload, 'title')
      try {
        const { business: biz, balanceAfter, startupCost } = await container.businessService.createBusiness(
          fromId,
          modelType,
          title
        )
        await logPlayerEvent(container, fromId, GameEventType.COMPANY_CREATED, `تأسیس ${biz.name}`)
        await ackCallback(ctx, 'کسب‌وکار تأسیس شد')
        await editPanel(ctx, {
          text: panel({
            icon: '🎉',
            title: 'کسب‌وکار تأسیس شد',
            sections: [
              {
                rows: [
                  { label: '🏢 نام', value: biz.name },
                  { label: '👥 ظرفیت کارمند', value: `${fa(biz.employeeCapacity)} نفر` },
                  { label: '💵 هزینهٔ راه‌اندازی', value: money(startupCost) },
                  { label: '👛 موجودی تو', value: money(balanceAfter) }
                ]
              }
            ],
            footer: '💡 قدم بعدی: از «آگهی شغل» نیرو بگیر تا درآمدِ واقعی شروع شود.'
          }),
          keyboard: buildWorkBackKeyboard()
        })
      } catch (err) {
        await handleCallbackError(ctx, err, {
          feature: 'business',
          action: 'create',
          fallback: 'تأسیس کسب‌وکار انجام نشد. سرمایه و سابقه‌ات را بررسی کن.'
        })
      }
    }
  })

  // ── استخدام متقاضی ───────────────────────────────────────────────
  registerConfirmableAction({
    kind: 'job_hire',
    async run(ctx, container: Container, payload) {
      const fromId = BigInt(ctx.from!.id)
      const applicationId = str(payload, 'applicationId')
      try {
        const businessId = await container.businessService.getApplicationBusinessId(applicationId)
        const employment = await container.businessService.hireEmployee(fromId, applicationId)
        await logPlayerEvent(container, fromId, GameEventType.JOB_STARTED, 'عضو تازه به تیم اضافه شد', {
          detail: employment.title
        })
        await logRegionEvent(
          ctx,
          container,
          GameEventType.JOB_STARTED,
          `یک شهروند در «${employment.title}» استخدام شد`,
          { dedupeKey: `hire:${employment.id}`, priority: 3 }
        )
        await ackCallback(ctx, 'استخدام انجام شد')
        await showApplicationsPanel(ctx, container, businessId)
      } catch (err) {
        await handleCallbackError(ctx, err, {
          feature: 'business',
          action: 'hire',
          fallback: 'پذیرش درخواست انجام نشد.'
        })
      }
    }
  })

  // ── اخراج کارمند ─────────────────────────────────────────────────
  registerConfirmableAction({
    kind: 'job_fire',
    async run(ctx, container: Container, payload) {
      const fromId = BigInt(ctx.from!.id)
      const businessId = str(payload, 'businessId')
      const employeePlayerId = str(payload, 'employeePlayerId')
      try {
        const res = await container.businessService.fireEmployee(
          fromId,
          businessId,
          employeePlayerId
        )
        await ackCallback(ctx, res.unpaid > 0 ? 'اخراج شد — بخشی معوق ماند' : 'اخراج و تسویه شد')
        await showEmployeesPanel(ctx, container, businessId)
      } catch (err) {
        await handleCallbackError(ctx, err, {
          feature: 'business',
          action: 'fire',
          fallback: 'اخراج انجام نشد.'
        })
      }
    }
  })

  // ── بستن دستی آگهی استخدام ──────────────────────────────────
  registerConfirmableAction({
    kind: 'job_posting_close',
    async run(ctx, container: Container, payload) {
      const fromId = BigInt(ctx.from!.id)
      const businessId = str(payload, 'businessId')
      const postingId = str(payload, 'postingId')
      try {
        await container.businessService.closePosting(fromId, businessId, postingId)
        await ackCallback(ctx, 'آگهی بسته شد')
        await showPostingsPanel(ctx, container, businessId)
      } catch (err) {
        await handleCallbackError(ctx, err, {
          feature: 'business',
          action: 'posting_close_go',
          fallback: 'بستن آگهی انجام نشد.'
        })
      }
    }
  })

  // ── افتتاح شعبه ─────────────────────────────────────────────────
  registerConfirmableAction({
    kind: 'branch_open',
    async run(ctx, container: Container, payload) {
      const fromId = BigInt(ctx.from!.id)
      const businessId = str(payload, 'businessId')
      const regionId = str(payload, 'regionId')
      try {
        const res = await container.branchService.openBranch(fromId, businessId, regionId)
        // پیش‌تر فقط «رویداد منطقه» ثبت می‌شد و در تاریخچهٔ خود بازیکن
        // هیچ اثری از افتتاح شعبه نمی‌ماند.
        await logPlayerEvent(
          container,
          fromId,
          GameEventType.BRANCH_OPENED,
          `افتتاح شعبه در ${res.regionTitle}`
        )
        await ackCallback(ctx, `🏢 شعبه در ${res.regionTitle} افتتاح شد`)
        await editPanel(ctx, {
          text: panel({
            icon: '🏢',
            title: 'افتتاح شعبه',
            sections: [
              {
                rows: [
                  { label: '🏪 کسب‌وکار', value: res.businessName },
                  { label: '🧭 منطقه', value: res.regionTitle },
                  { label: '💵 هزینهٔ تأسیس', value: money(res.cost) }
                ]
              }
            ],
            footer: '💡 درآمد شعبه روزانه انباشته می‌شود؛ هر وقت خواستی برداشت کن.'
          }),
          keyboard: buildWorkBackKeyboard()
        })
      } catch (err) {
        await handleCallbackError(ctx, err, {
          feature: 'branch',
          action: 'open',
          fallback: 'افتتاح شعبه انجام نشد.'
        })
      }
    }
  })

  // ── ارتقای کسب‌وکار ──────────────────────────────────────────────
  registerConfirmableAction({
    kind: 'biz_upgrade',
    async run(ctx, container: Container, payload) {
      const fromId = BigInt(ctx.from!.id)
      const businessId = str(payload, 'businessId')
      try {
        const biz = await container.businessService.upgradeBusiness(fromId, businessId)
        await logPlayerEvent(
          container,
          fromId,
          GameEventType.COMPANY_UPGRADED,
          `ارتقای ${biz.name} به سطح ${biz.level}`
        )
        await ackCallback(ctx, 'کسب‌وکار ارتقا یافت')
        await editPanel(ctx, {
          text: panel({
            icon: '⬆️',
            title: 'ارتقای کسب‌وکار',
            sections: [
              {
                rows: [
                  { label: '🏢 نام', value: biz.name },
                  { label: '📈 سطح جدید', value: fa(biz.level) },
                  { label: '👥 ظرفیت کارمند', value: `${fa(biz.employeeCapacity)} نفر` }
                ]
              }
            ]
          }),
          keyboard: buildWorkBackKeyboard()
        })
      } catch (err) {
        await handleCallbackError(ctx, err, {
          feature: 'business',
          action: 'upgrade',
          fallback: 'ارتقای کسب‌وکار انجام نشد.'
        })
      }
    }
  })

  // ── ثبت/تغییر وارث در وصیت ─────────────────────────────────────
  //
  // شناسهٔ وارث در payload سمتِ سرور می‌نشیند، نه در `callback_data`؛ اگر در
  // دکمه بود، دستکاری آن یعنی فرستادن دارایی به حساب دلخواه. توکن تأیید
  // تک‌مصرف است، پس دو کلیک یا کلیکِ کهنه وصیت را دوبار عوض نمی‌کند.
  registerConfirmableAction({
    kind: 'will_set',
    async run(ctx, container: Container, payload) {
      const fromId = BigInt(ctx.from!.id)
      const heirId = str(payload, 'heirId')
      try {
        const result = await container.willService.setHeir(fromId, heirId)
        await ackCallback(ctx, result.changed ? '📜 وصیت به‌روز شد' : '📜 وصیت ثبت شد')
        const view = await container.willService.getView(fromId)
        await editPanel(ctx, {
          text: renderWillPanel(view),
          keyboard: buildWillKeyboard(view)
        })
      } catch (err) {
        await handleCallbackError(ctx, err, {
          feature: 'will',
          action: 'confirm_set',
          fallback: 'ثبت وارث انجام نشد.'
        })
      }
    }
  })

  // ── لغو وصیت ───────────────────────────────────────────────────
  registerConfirmableAction({
    kind: 'will_cancel',
    async run(ctx, container: Container) {
      const fromId = BigInt(ctx.from!.id)
      try {
        await container.willService.cancel(fromId)
        await ackCallback(ctx, '🗑️ وصیت لغو شد')
        const view = await container.willService.getView(fromId)
        await editPanel(ctx, {
          text: renderWillPanel(view),
          keyboard: buildWillKeyboard(view)
        })
      } catch (err) {
        await handleCallbackError(ctx, err, {
          feature: 'will',
          action: 'confirm_cancel',
          fallback: 'لغو وصیت انجام نشد.'
        })
      }
    }
  })
}

/** داده‌های لازم برای صفحهٔ تأییدِ هر عملیات. */
export const confirmationPreviews = {
  educationField(fieldKey: string, degree: string) {
    const field = EDUCATION_FIELDS.find((f) => f.key === fieldKey)
    return {
      icon: '🎓',
      title: 'تأیید انتخاب رشته',
      rows: [
        { label: '📚 رشته', value: field?.title ?? fieldKey },
        { label: '🎓 مقطع', value: degreeLabels[degree as keyof typeof degreeLabels] ?? degree },
        { label: '💵 هزینهٔ ثبت‌نام', value: money(field?.baseTuitionCost ?? 0) },
        {
          label: '🧠 مهارت‌های تازه',
          value: field?.gainedSkills.join('، ') || '—'
        }
      ],
      lines: [
        'این انتخاب مسیر تحصیلی و فرصت‌های شغلی آینده‌ات را عوض می‌کند',
        'و هزینهٔ ثبت‌نام از کیف پولت کسر می‌شود.'
      ],
      footer: '⚠️ پس از ثبت‌نام، تغییر رشته با هزینه و زمان همراه است.'
    }
  },

  property(typeKey: string) {
    const blueprint = PROPERTY_BLUEPRINTS.find((b) => b.type === typeKey)
    return {
      icon: '🏠',
      title: 'تأیید خرید ملک',
      rows: [
        { label: '🏠 ملک', value: blueprint?.title ?? typeKey },
        { label: '💵 قیمت', value: money(blueprint?.purchasePrice ?? 0) },
        { label: '⭐ سطح ملک', value: fa(blueprint?.level ?? 0) }
      ],
      lines: ['مبلغ کامل از کیف پولت کسر می‌شود و سند به نامت صادر می‌گردد.'],
      footer: '💡 بعد از خرید می‌توانی در آن استراحت کنی، یا آن را اجاره بدهی و درآمد داشته باشی.'
    }
  },

  propertySale(title: string, baseAssetValue: number, salePrice: number) {
    return {
      icon: '💸',
      title: 'تأیید فروش ملک',
      rows: [
        { label: '🏠 ملک', value: title },
        { label: '💎 ارزش دارایی', value: money(baseAssetValue) },
        { label: '💰 مبلغ فروش (۶۰٪ ارزش)', value: `*${money(salePrice)}*` }
      ],
      lines: [
        'ملک به شهر فروخته می‌شود و از املاکت خارج می‌گردد.',
        'اگر در این ملک استراحت می‌کردی، بعد از فروش دیگر محل استراحت نداری (مگر ملک یا اجارهٔ دیگری داشته باشی).'
      ],
      footer: '⚠️ فروش برگشت‌پذیر نیست؛ مبلغ کمتر از قیمت خرید است.'
    }
  },

  businessBlueprint(modelType: string, container: Container) {
    const blueprint = container.businessService
      .getBlueprints()
      .find((b) => b.modelType === modelType)
    return {
      icon: '🏭',
      title: 'تأیید تأسیس کسب‌وکار',
      rows: [
        { label: '🏢 نام', value: blueprint?.title ?? modelType },
        { label: '💵 هزینهٔ راه‌اندازی', value: money(blueprint?.startupCost ?? 0) },
        { label: '👥 ظرفیت کارمند', value: `${fa(blueprint?.baseCapacity ?? 0)} نفر` },
        {
          label: '📈 درآمد پایه',
          value: `${money(ratePerGameHour(blueprint?.baseRevenuePerMinute ?? 0))} در ساعت بازی`
        },
        {
          label: '📉 هزینهٔ جاری',
          value: `${money(ratePerGameHour(blueprint?.operatingCostPerMinute ?? 0))} در ساعت بازی`
        }
      ],
      lines: ['هزینهٔ راه‌اندازی یک‌بار و فوراً از کیف پولت کسر می‌شود.'],
      footer: '⚠️ کسب‌وکارِ بدون نیرو درآمدِ نصف دارد؛ هزینهٔ جاری همیشه جاری است.'
    }
  },

  jobHire(applicantName: string, title: string, salaryPerMinute: number) {
    return {
      icon: '🤝',
      title: 'تأیید استخدام',
      rows: [
        { label: '👤 متقاضی', value: applicantName },
        { label: '💼 عنوان شغلی', value: title },
        { label: '💵 حقوق', value: `${money(ratePerGameHour(salaryPerMinute))} در ساعت بازی` }
      ],
      lines: [
        'با استخدام، پرداخت این حقوق به تعهد جاری کسب‌وکار تبدیل می‌شود',
        'و از خزانهٔ شرکت کسر می‌گردد.'
      ],
      footer: '⚠️ اگر خزانه خالی شود، حقوق معوق می‌ماند و انگیزهٔ کارمند افت می‌کند.'
    }
  },

  jobFire(employeeName: string, title: string, unpaidSalary: number) {
    return {
      icon: '🚪',
      title: 'تأیید اخراج کارمند',
      rows: [
        { label: '👤 کارمند', value: employeeName },
        { label: '💼 عنوان شغلی', value: title },
        { label: '💵 حقوق معوق', value: money(unpaidSalary) }
      ],
      lines: [
        'حقوق معوق همین حالا از خزانهٔ کسب‌وکار تسویه می‌شود',
        'و همکاری پایان می‌یابد.'
      ],
      footer: '⚠️ اخراج برگشت‌پذیر نیست؛ برای بازگشت باید دوباره آگهی بزنی.'
    }
  },

  branchOpen(
    businessName: string,
    regionTitle: string,
    setupCost: number,
    incomePerDay: number
  ) {
    return {
      icon: '🏢',
      title: 'تأیید افتتاح شعبه',
      rows: [
        { label: '🏪 کسب‌وکار', value: businessName },
        { label: '🧭 منطقه', value: regionTitle },
        { label: '💵 هزینهٔ تأسیس', value: money(setupCost) },
        { label: '📈 درآمد روزانه', value: money(incomePerDay) }
      ],
      lines: ['هزینهٔ تأسیس یک‌بار و فوراً از کیف پولت کسر می‌شود.'],
      footer: '⚠️ در هر منطقه فقط یک شعبه از هر کسب‌وکار ممکن است و هزینه بازگشت ندارد.'
    }
  },

  businessUpgrade(businessName: string) {
    return {
      icon: '⬆️',
      title: 'تأیید ارتقای کسب‌وکار',
      rows: [{ label: '🏢 کسب‌وکار', value: businessName }],
      lines: [
        'ارتقا ظرفیت کارمند و درآمد پایه را بالا می‌برد',
        'و هزینهٔ ارتقا از خزانهٔ کسب‌وکار کسر می‌شود.'
      ],
      footer: '⚠️ ارتقا برگشت‌پذیر نیست و هزینه‌اش بازگردانده نمی‌شود.'
    }
  }
}
