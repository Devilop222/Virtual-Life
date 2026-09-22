import { PlayerIdentityView } from '../modules/identity/player.service'
import { formatGameMinutes, gameClockLine, ratePerGameHour } from '../utils/game-time'
import {
  genderLabels,
  maritalStatusLabels,
  socialLevelLabels
} from '../modules/identity/player.service'
import { playerGroupLabels } from '../modules/groups/group.service'
import { monthlySalaryFor } from '../modules/occupation/payroll-math'
import { relationshipTypeLabels, relationshipStatusLabels } from '../modules/relationship/relationship.service'
import { notificationTypeLabels } from '../modules/notification/notification.service'
import { SHOP_CATEGORIES, rarityLabels, ItemRarity } from '../modules/shop/shop-catalog'
import { describeMahr, isMahrSet, mahrRuleLines } from '../modules/family/mahr'
import { MARRIAGE_INFO } from '../modules/family/marriage.service'
import {
  panel,
  bullets,
  fa,
  money,
  faDate,
  bar,
  barWithPercent,
  healthBar,
  fatigueBar,
} from './ui-kit'
import { vitalityRateHint } from '../modules/health/vitality'
import { activityStateLabels, label } from '../utils/classes/labels'
import type { CreditProfile } from '../modules/finance/credit.service'
import type { LedgerPage } from '../modules/finance/ledger.service'
import { transactionLabels } from '../modules/finance/ledger.service'
import type { NewsFeed } from '../modules/news/news.service'
import type { RegionState } from '../modules/city/region.service'
import type { RankingResult } from '../modules/ranking/ranking.service'
import type { MissionBoard } from '../modules/missions/mission.service'
import type { HistoryPage } from '../modules/events/event.service'
import type { ResidenceInfo, MigrationCheck } from '../modules/residence/residence.service'
import type { PayrollSettlement } from '../modules/occupation/payroll.service'
import type { PlayerStatistics } from '../modules/statistics/statistics.service'
import { historyEventLabels } from '../modules/events/event.service'
import { experienceTierLabel } from '../config/economy'
import type { QuestBoard } from '../modules/quests/daily-quest.service'
import type { AchievementBoard } from '../modules/achievements/achievement.service'
import type { DepositBoard } from '../modules/banking/deposit.service'
import type { ClinicView } from '../modules/health/clinic.service'
import type {
  OwnerPropertyView,
  RentableView,
  TenancyView
} from '../modules/housing/rental.service'
import type { PassportBoard } from '../modules/residence/passport.service'
import type { WillView } from '../modules/inheritance/will.service'
import { WILL_PANEL_COPY } from '../modules/inheritance/will.service'

// ──────────────────────────────────────────────────────────────────────────────
//  🏠 مسکن
// ──────────────────────────────────────────────────────────────────────────────

export function renderHousingPanel(data: {
  balance: number
  isResting: boolean
  fatigue: number
  health: number
  propertiesOwned?: number
  assetValue?: number
  recoveryPreview?: {
    bestLevel: number
    isFurnished: boolean
    hasProperty: boolean
    hasRental: boolean
    fatiguePerHour: number
    healthPerHour: number
    regionBonusApplied: boolean
    isShelter?: boolean
    shelterHint?: string
  } | null
}): string {
  const healthPct = Math.round((data.health / 100) * 100)
  const rp = data.recoveryPreview
  const recoveryLines: string[] | undefined = rp
    ? rp.isShelter
      ? [
          `🏚️ سرپناه فعلی: *آلونک* — رایگان و همیشگی`,
          `   ⚡ خستگی: *−${fa(rp.fatiguePerHour)}٪ در ساعت*   ·   ❤️ سلامت: *+${fa(rp.healthPerHour)} در ساعت*`,
          ...(rp.shelterHint ? [rp.shelterHint] : []),
          '💡 یک خانهٔ واقعی بخری یا اجاره کنی، همین عدد چند برابر می‌شود.'
        ]
      : rp.hasProperty || rp.hasRental
      ? [
          `🛌 سرعت ریکاوری (سطح ${fa(rp.bestLevel)}${rp.isFurnished ? ' · مبله 🛋️' : ''}${rp.regionBonusApplied ? ' · بافر منطقه ✨' : ''}):`,
          `   ⚡ خستگی: *−${fa(rp.fatiguePerHour)}٪ در ساعت*   ·   ❤️ سلامت: *+${fa(rp.healthPerHour)} در ساعت*`,
          rp.isFurnished ? '   🛋️ مبله = ‎+۱۵٪ سرعت ریکاوری' : '',
          rp.regionBonusApplied ? '   ✨ پروژهٔ پارک/درمانگاه منطقه = ‎+۲۵٪' : '',
        ].filter(Boolean) as string[]
      : ['🏚️ هنوز ملکی نداری — ریکاوری ساعتی *صفر* است. با خرید یا اجاره فعال می‌شود.']
    : undefined

  const sections: Parameters<typeof panel>[0]['sections'] = [
    {
      title: '💰 دارایی',
      rows: [
        { label: '💵 موجودی نقدی', value: money(data.balance) },
        { label: '🏠 املاک', value: `${fa(data.propertiesOwned ?? 0)} ملک` },
        { label: '🏘️ ارزش دارایی', value: money(data.assetValue ?? 0) },
      ],
    },
    {
      title: '❤️ وضعیت جسمی',
      lines: [
        `⚡ خستگی  ${fatigueBar(data.fatigue)}`,
        `❤️ سلامت  ${healthBar(healthPct)}`,
      ],
    },
  ]
  if (recoveryLines) {
    sections.push({ title: '🛌 برآورد ریکاوری', lines: recoveryLines })
  }
  sections.push({
    lines: [
      data.isResting
        ? '🛌 *در حال استراحت* — خستگی‌ات به‌تدریج کم می‌شود.\nبرای پایان و ثبتِ ریکاوری، «پایان استراحت» را بزن.'
        : rp?.isShelter
          ? '🛌 می‌توانی همین حالا استراحت کنی — آلونکت همیشه در دسترس است.'
          : '🛌 برای رفع خستگی، باید ملک داشته باشی و دکمهٔ «شروع استراحت» را بزنی.',
    ],
  })
  return panel({
    icon: '🏠',
    title: 'سامانهٔ مسکن',
    sections,
    footer: rp?.hasProperty || rp?.hasRental
      ? '💡 سطح بالاتر + مبله + پروژهٔ منطقه = ریکاوری سریع‌تر. یک ساعت استراحت ≈ اعداد بالا.'
      : '💡 هرچه سطح ملک بالاتر باشد، سرعت ریکاوری بیشتر است.',
  })
}

// ──────────────────────────────────────────────────────────────────────────────
//  🏦 بانک
// ──────────────────────────────────────────────────────────────────────────────

export function renderBankPanel(data: {
  cardNumber: string
  bankBalance: number
  walletBalance: number
  totalDebt?: number
  creditScore?: number
  creditGrade?: string
  /**
   * ترازنامهٔ عمومی بانک.
   * بدون این بخش، رد شدنِ وام به دلیل کمبود نقدینگی از دید بازیکن بی‌دلیل است.
   */
  bankPool?: {
    liquidity: number
    totalDeposited: number
    totalDisbursed: number
  }
  /**
   * وامِ فعال همراه با وضعیت واقعیِ چرخهٔ عمر.
   *
   * بدون این بخش، `dueAt` هیچ‌جا دیده نمی‌شد: بازیکن نمی‌دانست چقدر تا سررسید
   * مانده، پس نمی‌توانست پیش از تملکِ وثیقه تصمیم بگیرد.
   */
  loan?: {
    remaining: number
    /** برچسب چرخهٔ عمر: فعال / نزدیک سررسید / سررسیدگذشته. */
    statusLabel: string
    /** هشدار آماده برای نمایش در پانویس (اگر ریسکی هست). */
    warning?: string
  }
}): string {
  const total = data.bankBalance + data.walletBalance
  const sections: Parameters<typeof panel>[0]['sections'] = [
    {
      title: '💳 حساب من',
      rows: [
        { label: '🔢 شمارهٔ کارت', value: `\`${data.cardNumber}\`` },
        { label: '💵 کیف پول', value: money(data.walletBalance) },
        { label: '🏦 موجودی بانک', value: money(data.bankBalance) },
        { label: '📊 دارایی نقدی', value: `*${money(total)}*` },
      ],
    },
  ]

  if (data.totalDebt !== undefined || data.creditScore !== undefined) {
    const rows: { label: string; value: string }[] = []
    if (data.creditScore !== undefined) {
      rows.push({
        label: '📈 اعتبار مالی',
        value: `${fa(data.creditScore)}${data.creditGrade ? ` (${data.creditGrade})` : ''}`,
      })
    }
    if (data.totalDebt !== undefined) {
      rows.push({ label: '📑 بدهی جاری', value: money(data.totalDebt) })
    }
    sections.push({ title: '📑 اعتبار و بدهی', rows })
  }

  if (data.bankPool) {
    sections.push({
      title: '🏛️ پشتوانهٔ بانک',
      rows: [
        { label: '💰 نقدینگی صندوق', value: money(data.bankPool.liquidity) },
        { label: '📥 مجموع سپرده‌های مردم', value: money(data.bankPool.totalDeposited) },
        { label: '📤 مجموع وام‌های پرداخته', value: money(data.bankPool.totalDisbursed) },
      ],
      lines: [
        'وام از همین صندوق پرداخت می‌شود؛ اگر نقدینگی کافی نباشد، درخواست رد می‌شود.',
        'سود سپرده‌ها هم از بهرهٔ وام‌های بازپرداخت‌شده پرداخت می‌شود.',
      ],
    })
  }

  if (data.loan) {
    sections.push({
      title: '📑 وام فعال من',
      rows: [
        { label: '💳 ماندهٔ بدهی', value: money(data.loan.remaining) },
        { label: '⏳ وضعیت', value: data.loan.statusLabel },
      ],
      ...(data.loan.warning ? { lines: [data.loan.warning] } : {}),
    })
  }

  sections.push({
    title: 'ℹ️ نرخ‌ها',
    lines: [
      '• سود سپردهٔ سالانه: *٪۱۵*',
      '• بهرهٔ وام ۳۰روزه: *٪۱۴ تا ٪۲۲* — بسته به گرید اعتباری',
      '• مهلت پس از سررسید: *۷ روز بازی* — بعد از آن وثیقه تملک می‌شود.',
    ],
  })

  return panel({
    icon: '🏦',
    title: 'سامانهٔ بانکی',
    sections,
    footer: '💡 برای واریز/برداشت: دکمه را بزن و سپس مبلغ را بنویس.',
  })
}

// ──────────────────────────────────────────────────────────────────────────────
//  💼 کار و درآمد
// ──────────────────────────────────────────────────────────────────────────────

export function renderWorkPanel(data: {
  isWorking: boolean
  jobTitle?: string
  elapsedMinutes?: number
  earned?: number
  /** شیفتِ محل کار: مزد فوری ندارد و در تسویهٔ کسب‌وکار می‌آید. */
  workplaceShift?: boolean
  balance: number
  experience: number
  fatigue: number
  health: number
  activityState?: string
}): string {
  if (data.isWorking) {
    const shiftRows = [
      { label: '📌 شغل', value: `*${data.jobTitle ?? 'نامشخص'}*` },
      { label: '⏱️ مدت کار', value: formatGameMinutes(data.elapsedMinutes ?? 0) },
      data.workplaceShift
        ? { label: '💰 دستمزد', value: 'در تسویهٔ کارفرما' }
        : { label: '💰 دستمزد تا اکنون', value: `*${money(data.earned ?? 0)}*` }
    ]
    return panel({
      icon: '💼',
      title: 'کار و درآمد',
      sections: [
        { title: '🔧 شیفتِ جاری', rows: shiftRows },
        {
          title: '⚡ توان بدنی',
          lines: [`خستگی  ${fatigueBar(data.fatigue)}`, `سلامت  ${healthBar(data.health)}`],
        },
      ],
      footer: data.workplaceShift
        ? '💡 کارکردت ثبت می‌شود و کارفرما در «تسویهٔ حقوق» پرداخت می‌کند.'
        : '💡 با «پایان کار» دستمزدت به کیف پول واریز می‌شود.',
    })
  }

  return panel({
    icon: '💼',
    title: 'کار و درآمد',
    sections: [
      {
        title: '📊 وضعیت',
        rows: [
          { label: '⚪ فعالیت', value: label(activityStateLabels, data.activityState, 'آزاد') },
          { label: '💵 کیف پول', value: money(data.balance) },
          { label: '⭐ سابقهٔ کاری', value: `*${experienceTierLabel(data.experience)}*` },
        ],
      },
      {
        title: '⚡ توان بدنی',
        lines: [`خستگی  ${fatigueBar(data.fatigue)}`, `سلامت  ${healthBar(data.health)}`],
      },
    ],
    footer: '💡 دستمزد به سختی کار، سابقه و مدرک تحصیلی بستگی دارد.',
  })
}

// ──────────────────────────────────────────────────────────────────────────────
//  🏭 کسب‌وکارها
// ──────────────────────────────────────────────────────────────────────────────

export function renderBusinessList(
  businesses: Array<{
    name: string
    level: number
    treasury: { toString: () => string }
    employeeCapacity: number
    employees: Array<{ isActive: boolean }>
    baseRevenuePerMinute?: number | { toString(): string }
    operatingCostPerMinute?: number | { toString(): string }
    tierFactor?: number
  }>,
): string {
  if (businesses.length === 0) {
    return panel({
      icon: '🏭',
      title: 'کسب‌وکارهای من',
      sections: [
        {
          lines: [
            'هنوز مالک هیچ کسب‌وکاری نیستی.',
            '',
            'از بخش «کار» → «کار تمام‌وقت» می‌توانی شرکت تأسیس کنی.',
            'هر مدل سرمایه، ظرفیت و درآمدِ متفاوتی دارد.',
          ],
        },
      ],
      footer: '💡 پس از تأسیس، مالک واقعاً کسب‌وکارت را مدیریت می‌کنی.',
    })
  }

  const body = businesses.flatMap((b) => {
    const active = b.employees.filter((e) => e.isActive).length
    const cap = b.employeeCapacity
    const capPct = cap > 0 ? Math.round((active / cap) * 100) : 0
    const baseRev = b.baseRevenuePerMinute !== undefined ? Number(b.baseRevenuePerMinute) : undefined
    const opCost = b.operatingCostPerMinute !== undefined ? Number(b.operatingCostPerMinute) : undefined
    const lines: string[] = [
      `🏢 *${b.name}* — سطح ${fa(b.level)}${b.tierFactor ? ` · ضریب ${fa(Math.round(b.tierFactor * 100))}٪` : ''}`,
      `   💰 خزانه: ${money(b.treasury)}`,
      `   👥 نیرو: ${fa(active)} از ${fa(cap)}  ${bar(capPct, 8)}`,
    ]
    if (baseRev !== undefined && opCost !== undefined) {
      const dailyRevenue = Math.round(baseRev * 480 * (0.5 + 0.5 * (active / Math.max(1, cap))))
      const dailyCost = Math.round(opCost * 1440)
      const dailyNet = dailyRevenue - dailyCost
      const netIcon = dailyNet >= 0 ? '📈' : '📉'
      const netLabel = dailyNet >= 0 ? 'سودِ روزانهٔ تقریبی' : 'زیانِ روزانهٔ تقریبی'
      lines.push(`   ${netIcon} ${netLabel}: *${money(Math.abs(dailyNet))}*`)
      lines.push(`   📊 درآمد ≈ ${money(dailyRevenue)} · هزینه ≈ ${money(dailyCost)}`)
      if (active === 0 && cap > 0) lines.push('   ⚠️ بدون نیروی فعال، درآمد · ۵۰٪ است — نیرو استخدام کن.')
      if (capPct >= 100) lines.push('   ✅ ظرفیت تکمیل — آمادهٔ ارتقا؟')
      else if (capPct < 30) lines.push('   💡 تکمیلِ نیرو پایین = حاشیهٔ سود کمتر')
    } else {
      lines.push('   💡 «جزئیات» را باز کن تا درآمد و هزینهٔ روزانه را ببینی.')
    }
    lines.push('')
    return lines
  })

  return panel({
    icon: '🏭',
    title: 'کسب‌وکارهای من',
    sections: [{ lines: body }],
    footer: '💡 ظرفیت تکمیل + ارتقا = درآمدِ پایهٔ بیشتر. خزانه را برای حقوق پر نگه دار.',
  })
}

// ──────────────────────────────────────────────────────────────────────────────
//  🔎 آگهی‌های استخدام
// ──────────────────────────────────────────────────────────────────────────────

export function renderJobPostingsPanel(
  postings: Array<{
    id: string
    title: string
    minExperience: number
    salaryPerMinute: { toString: () => string }
    capacity: number
    hiredCount: number
    minAge: number | null
    maxAge: number | null
    requiredDegree: string
    requiredSkill: string | null
    business: { name: string }
  }>,
  page: number,
  pages: number,
): string {
  if (postings.length === 0) {
    return panel({
      icon: '🔎',
      title: 'آگهی‌های استخدام',
      sections: [
        {
          lines: [
            'در حال حاضر آگهی فعالی ثبت نشده است.',
            '',
            'تا پیدا شدنِ فرصت بهتر، از *«کار پاره‌وقت»* درآمد بساز —',
            'حقوق بر اساس سختی کار، مهارت و سلامت محاسبه می‌شود.',
          ],
        },
      ],
      footer: '💡 مالکان کسب‌وکار از پنل شرکتشان آگهی منتشر می‌کنند.',
    })
  }

  const sections: Parameters<typeof panel>[0]['sections'] = [
    {
      lines: postings.flatMap((p) => {
        // معادل ماهانه از همان تابعی می‌آید که دفتر پرداخت هم می‌شناسد: ماه بازی
        // ۳۰ روز است و حقوق کارمند روزی ۸ ساعت بازی انباشته می‌شود.
        const monthly = monthlySalaryFor(Number(p.salaryPerMinute))
        const fill = p.capacity > 0 ? Math.round((p.hiredCount / p.capacity) * 100) : 0
        return [
          `📄 *${p.title}* — ${p.business.name}`,
          `   💰 ${money(ratePerGameHour(Number(p.salaryPerMinute)))} در ساعت بازی  ·  ماهانه ≈ ${money(monthly)}`,
          `   👥 ${fa(p.hiredCount)}∕${fa(p.capacity)}  ${bar(fill, 6)}`,
          '',
        ]
      }),
    },
  ]

  return panel({
    icon: '🔎',
    title: 'آگهی‌های استخدام',
    sections,
    footer:
      pages > 1
        ? `💡 صفحهٔ ${fa(page)} از ${fa(pages)} — برای درخواست، آگهی را باز کن.`
        : '💡 برای درخواست استخدام، دکمهٔ «مشاهدهٔ آگهی» را بزن.',
  })
}

// ──────────────────────────────────────────────────────────────────────────────
//  📄 جزئیات آگهی
// ──────────────────────────────────────────────────────────────────────────────

export function renderJobDetailPanel(
  posting: {
    title: string
    salaryPerMinute: { toString: () => string }
    contractMinutesPerMonth: number
    capacity: number
    hiredCount: number
    minExperience: number
    minAge: number | null
    maxAge: number | null
    requiredDegree: string
    requiredSkill: string | null
    business: { name: string }
  },
  problems: string[],
): string {
  const sections: Parameters<typeof panel>[0]['sections'] = [
    {
      title: `📄 ${posting.title}`,
      rows: [
        { label: '🏢 کارفرما', value: `*${posting.business.name}*` },
        { label: '💰 حقوق', value: `${money(ratePerGameHour(Number(posting.salaryPerMinute)))} در ساعت بازی` },
        {
          label: '🧾 معادل ماهانه',
          value: money(monthlySalaryFor(Number(posting.salaryPerMinute))),
        },
        {
          label: '⏱ حجم ماهانه',
          value: `${fa(Math.round(posting.contractMinutesPerMonth / 60))} ساعت بازی در ماه`,
        },
        { label: '👥 ظرفیت', value: `${fa(posting.hiredCount)} از ${fa(posting.capacity)}` },
      ],
    },
    {
      title: '📋 شرایطِ خواسته‌شده',
      lines: [
        `• سابقه: دست‌کم ${fa(posting.minExperience)}`,
        `• مدرک: ${DEGREE_LABELS[posting.requiredDegree] ?? posting.requiredDegree}`,
        posting.minAge !== null
          ? `• سن: ${fa(posting.minAge as number)}${posting.maxAge !== null ? ` تا ${fa(posting.maxAge as number)}` : ' به بالا'}`
          : '• سن: آزاد',
        posting.requiredSkill ? `• مهارتِ مطلوب: *${posting.requiredSkill}*` : '• مهارت: بی‌شرط',
      ],
    },
  ]

  if (problems.length > 0) {
    sections.push({
      title: '⚠️ شرایطت کامل نیست',
      lines: problems.map((p) => `• ${p}`),
    })
  } else {
    sections.push({
      lines: ['✅ همهٔ شرایط را داری — می‌توانی درخواست بدهی.'],
    })
  }

  return panel({
    icon: '📄',
    title: 'آگهی استخدام',
    sections,
    footer:
      problems.length > 0
        ? '💡 اول شرایط را کامل کن؛ آنگاه دکمهٔ درخواست فعال می‌شود.'
        : '💡 پس از درخواست، کارفرما تو را تأیید/رد می‌کند. حقوق تا ۸ ساعت در روز انباشته می‌شود.',
  })
}

const DEGREE_LABELS: Record<string, string> = {
  DIPLOMA: 'دیپلم',
  ASSOCIATE: 'کاردانی',
  BACHELOR: 'کارشناسی',
  MASTER: 'کارشناسی ارشد',
  DOCTORATE: 'دکتری',
}

// ──────────────────────────────────────────────────────────────────────────────
//  🧑‍💼 شغلِ من
// ──────────────────────────────────────────────────────────────────────────────

export function renderMyJobPanel(
  jobs: Array<{
    businessName: string
    title: string
    salaryPerMinute: number
    contractMinutesPerMonth: number
    workedMinutes: number
    workedMinutesThisMonth: number
    remainingMinutesThisMonth: number
    accrued: number
    unpaid: number
    staffed: number
    capacity: number
  }>,
  applications: Array<{ title: string; businessName: string }>,
): string {
  const sections: Parameters<typeof panel>[0]['sections'] = []

  if (jobs.length === 0) {
    sections.push({
      lines: [
        'در هیچ کسب‌وکاری استخدام نیستی.',
        '',
        applications.length === 0
          ? 'از بخش «کار» آگهی‌ها را ببین، شرایط را بخوان و درخواست بده.'
          : 'درخواست‌های زیر در انتظار پاسخِ کارفرما هستند.',
      ].filter(Boolean) as string[],
    })
  } else {
    for (const job of jobs) {
      const totalDue = job.accrued + job.unpaid
      // سقفِ ماهانه(حجم قرارداد) همان چیزی است که کارمند را از شیفتِ تازه
      // محروم می‌کند، پس باید صریح دیده شود — نه اینکه وسط کار معلوم شود.
      const contractFull =
        job.contractMinutesPerMonth > 0 &&
        job.workedMinutesThisMonth >= job.contractMinutesPerMonth
      sections.push({
        title: `🏢 ${job.businessName}`,
        rows: [
          { label: '💼 سمت', value: `*${job.title}*` },
          { label: '💰 حقوق', value: `${money(ratePerGameHour(Number(job.salaryPerMinute)))} در ساعت بازی` },
          {
            label: '⏱ قرارداد ماهانه',
            value: `${fa(Math.round(job.contractMinutesPerMonth / 60))} ساعت بازی در ماه`,
          },
          {
            label: '📊 کارکرد این ماه',
            value: `${formatGameMinutes(job.workedMinutesThisMonth)} از ${formatGameMinutes(job.contractMinutesPerMonth)}`,
          },
          {
            label: contractFull ? '✅ وضعیت' : '🎯 باقی‌مانده',
            value: contractFull
              ? 'حجم این ماه پر شده؛ ماه بعد دوباره سر کار بیا.'
              : formatGameMinutes(job.remainingMinutesThisMonth),
          },
          { label: '🕐 کارکرد این دوره', value: formatGameMinutes(job.workedMinutes) },
          { label: '⏳ معوقِ تسویه', value: totalDue > 0 ? `*${money(totalDue)}*` : '—' },
          { label: '👥 تیم', value: `${fa(job.staffed)} از ${fa(job.capacity)}` },
        ],
      })
    }
    sections.push({
      lines: [
        '💡 حقوق فقط برای ساعت‌هایی است که *شیفت ثبت کرده‌ای* — نه برای زمانی که عضو تیمی.',
        'با «شروع شیفت» در محل کارت کار می‌کنی و کارکردت ثبت می‌شود؛',
        'کارفرما با «تسویهٔ حقوق» آن را پرداخت می‌کند و با استعفا همان‌جا واریز می‌شود.',
      ],
    })
  }

  if (applications.length > 0) {
    sections.push({
      title: '📨 درخواست‌های در انتظار پاسخ',
      lines: applications.map((a) => `• *${a.title}* — ${a.businessName}`),
    })
  }

  return panel({
    icon: '🧑‍💼',
    title: 'شغل من',
    sections,
    footer: '💡 هم‌زمان فقط *یک* کارمندیِ فعال می‌توانی داشته باشی.',
  })
}

// ──────────────────────────────────────────────────────────────────────────────
//  👥 کارمندان کسب‌وکار
// ──────────────────────────────────────────────────────────────────────────────

export function renderBusinessStaffPanel(
  title: string,
  businessName: string,
  rows: Array<{ lines: string[] }>,
  emptyText: string,
): string {
  if (rows.length === 0) {
    return panel({
      icon: '👥',
      title,
      sections: [{ lines: [emptyText] }],
      footer: '💡 از فهرست آگهی‌ها نیرو جذب کن.',
    })
  }
  return panel({
    icon: '👥',
    title,
    sections: [{ title: `🏢 ${businessName}`, lines: rows.flatMap((r) => [...r.lines, '']) }],
  })
}

// ──────────────────────────────────────────────────────────────────────────────
//  🛒 فروشگاه
// ──────────────────────────────────────────────────────────────────────────────

export function renderShopMainPanel(): string {
  return panel({
    icon: '🛒',
    title: 'فروشگاه',
    sections: [
      { title: '📂 دسته‌ها', lines: bullets([...SHOP_CATEGORIES]) },
      {
        title: 'ℹ️ راهنما',
        lines: [
          '• هر کالا اثری مشخص روی سلامت، خستگی یا تجربه دارد.',
          '• کالاهای خریداری‌شده به *انبار* اضافه می‌شوند.',
          '• قیمت‌ها با عرضه، تقاضا و رونق اقتصادی تغییر می‌کنند.',
        ],
      },
    ],
    footer: 'برای دیدن کالاها، یک دسته را از دکمه‌های زیر انتخاب کن.',
  })
}

export function renderShopCategoryPanel(
  category: string,
  items: Array<{
    name: string
    description: string
    basePrice: number
    currentPrice: number
    trend: 'up' | 'down' | 'stable'
    rarity: string
    stock: number
    effects: unknown
  }>,
): string {
  if (items.length === 0) {
    return panel({
      icon: '🛒',
      title: category,
      sections: [
        {
          lines: [
            'در این دسته کالایی موجود نیست.',
            '',
            'شاید تقاضا باعث اتمام موجودی شده؛ بعداً دوباره سر بزن.',
          ],
        },
      ],
    })
  }

  const body = items.flatMap((item) => {
    const rarity = rarityLabels[item.rarity as ItemRarity] ?? item.rarity
    const effects = item.effects as Record<string, number> | null
    const effectParts: string[] = []
    if (effects?.health) effectParts.push(`❤️ ${effects.health > 0 ? '+' : ''}${effects.health}`)
    if (effects?.fatigue) effectParts.push(`⚡ ${effects.fatigue}`)
    if (effects?.experience) effectParts.push(`⭐ +${effects.experience}`)

    const trendMark = item.trend === 'up' ? '📈' : item.trend === 'down' ? '📉' : '➖'
    const stockText = item.stock === -1 ? '' : ` · موجودی: ${fa(item.stock)}`
    const priceLine =
      item.currentPrice !== item.basePrice
        ? `${money(item.basePrice)} → *${money(item.currentPrice)}*`
        : `${money(item.currentPrice)}`

    return [
      `*${item.name}*  ·  _${rarity}_`,
      `${trendMark} ${priceLine}${stockText}`,
      effectParts.length > 0 ? effectParts.join('   ') : '',
      '',
    ].filter(Boolean)
  })

  return panel({
    icon: '🛒',
    title: category,
    sections: [{ lines: body }],
    footer: '💡 قیمت‌ها با عرضه و تقاضا تغییر می‌کنند. 📈 گران‌تر · 📉 ارزان‌تر',
  })
}

export function renderInventoryPanel(
  rows: Array<{
    quantity: number
    item: { name: string; rarity: string; effects: unknown }
  }>,
  page: number,
  /**
   * ارزش تقریبی کل انبار به قیمت فروشگاه.
   *
   * اختیاری است تا فراخوان‌های موجود نشکنند، ولی هر دو مسیر واقعی مقدارش را
   * می‌دهند: بازیکن باید پیش از فروش بداند دارایی‌اش چقدر می‌ارزد.
   */
  totalValue?: number,
): string {
  if (rows.length === 0) {
    return panel({
      icon: '🎒',
      title: 'انبار من',
      sections: [
        {
          lines: ['انبار خالی است.', '', 'از بخش «فروشگاه» کالا بخر تا اینجا ببینی‌شان.'],
        },
      ],
      footer: '💡 برای استفاده، روی نام کالا در دکمه‌های زیر بزن.',
    })
  }

  const body = rows.map((row, index) => {
    const rarity = rarityLabels[row.item.rarity as ItemRarity] ?? row.item.rarity
    const effects = row.item.effects as Record<string, number> | null
    const effectParts: string[] = []
    if (effects?.health) effectParts.push(`❤️ ${effects.health > 0 ? '+' : ''}${effects.health}`)
    if (effects?.fatigue) effectParts.push(`⚡ ${effects.fatigue}`)
    if (effects?.experience) effectParts.push(`⭐ +${effects.experience}`)

    const number = fa(index + 1 + page * 12)
    const effectText = effectParts.length > 0 ? ` · ${effectParts.join(' ')}` : ''
    return `${number}. *${row.item.name}* ×${fa(row.quantity)}  ·  _${rarity}_${effectText}`
  })

  const sections: Parameters<typeof panel>[0]['sections'] = [{ lines: body }]
  if (totalValue !== undefined && totalValue > 0) {
    sections.push({
      lines: [`💰 ارزش انبار به قیمت فروشگاه: ${money(totalValue)}`]
    })
  }

  return panel({
    icon: '🎒',
    title: 'انبار من',
    sections,
    footer: '💡 برای استفاده، روی نام کالا در دکمه‌های زیر بزن.',
  })
}

// ──────────────────────────────────────────────────────────────────────────────
//  🪪 شناسنامه — زیباترین ویترینِ هویت
// ──────────────────────────────────────────────────────────────────────────────

export function renderIdentityCard(
  profile: PlayerIdentityView,
  options: {
    showMoney?: boolean
    /**
     * خلاصهٔ نشان‌ها — اختیاری، تا نداشتنش پنل را نشکند.
     *
     * چرا روی همین کارت؟ شناسنامه ویترینِ پیشرفت است و نشان‌ها بخشی از آن
     * پیشرفت‌اند؛ تا پیش از این، تنها جای دیدنشان یک بخش جداگانه بود و روی
     * کارت هیچ اثری نداشتند.
     */
    achievements?: { count: number; icons: string[] }
  } = {},
): string {
  const education = profile.educationField
    ? `${profile.educationDegree} (${profile.educationField})`
    : profile.educationDegree

  const skills =
    profile.skills.length > 0
      ? profile.skills.map((s) => s.skill.name).join('، ')
      : '—'

  const healthPct = Math.round((profile.health / profile.maxHealth) * 100)
  const prodScore = profile.productivityScore
  const prodLabel = profile.productivityLabel

  const sections: Parameters<typeof panel>[0]['sections'] = [
    {
      title: '🕐 ساعت بازی',
      lines: [
        gameClockLine(),
        '_هر ۱ دقیقهٔ واقعی = ۳۰ دقیقهٔ بازی · هر ۱ روز واقعی = ۱ ماه بازی_'
      ]
    },
    {
      title: '👤 هویت',
      rows: [
        { label: 'نام', value: `*${profile.firstName} ${profile.lastName ?? ''}`.trim() + '*' },
        { label: '🎂 سن', value: `${fa(profile.age)} سال — *${profile.lifeStageLabel}*` },
        {
          label: '🗓️ تولد بعدی',
          value: profile.birthdayInDays > 0 ? `${fa(profile.birthdayInDays)} روز دیگر` : '*امروز!* 🎉',
        },
        { label: '⚧ جنسیت', value: genderLabels[profile.gender] },
        { label: '💍 تأهل', value: maritalStatusLabels[profile.maritalStatus] },
      ],
    },
    {
      title: '❤️ وضعیت زندگی',
      lines: [
        `سلامت  ${healthBar(healthPct)}  _${profile.healthLabel}_  ${fa(profile.health)}/${fa(profile.maxHealth)}`,
        `خستگی  ${fatigueBar(profile.fatigue)}`,
        `⭐ تجربه  ${fa(profile.experience)}  ·  *${experienceTierLabel(profile.experience)}*`,
        `⚙️ بهره‌وری  ${barWithPercent(prodScore, 8)}  _${prodLabel}_`,
      ],
    },
    {
      title: '🎓 رشد',
      rows: [
        { label: 'تحصیلات', value: education },
        { label: '🎯 مهارت‌ها', value: skills },
        ...(options.achievements
          ? [
              {
                label: '🏅 نشان‌ها',
                value:
                  options.achievements.count > 0
                    ? `${fa(options.achievements.count)}${
                        options.achievements.icons.length > 0
                          ? ` — ${options.achievements.icons.join(' ')}`
                          : ''
                      }`
                    : 'هنوز نشانی نگرفته'
              }
            ]
          : [])
      ],
    },
    {
      title: '💼 شغل',
      rows: [{ label: 'شغل', value: jobValueOf(profile) }],
    },
    {
      title: '💰 اقتصاد',
      rows: options.showMoney
        ? [{ label: 'موجودی', value: `*${money(profile.balance)}*` }]
        : [{ label: 'دارایی', value: 'در چت خصوصی «شناسنامه» را بفرست تا موجودی را ببینی.' }],
    },
    {
      title: '🏡 جایگاه',
      rows: [
        { label: 'محل زندگی', value: profile.homeGroup?.title ?? '—' },
        { label: '📊 سطح اجتماعی', value: `*${socialLevelLabels[profile.socialLevel]}*` },
        { label: '👥 مناطق عضو', value: `${fa(profile.groupCount)} منطقه` },
      ],
    },
  ]

  if (profile.biography) {
    sections.push({
      title: '📝 زندگی‌نامه',
      lines: [`_${profile.biography}_`],
    })
  }

  return panel({
    icon: '🪪',
    title: 'شناسنامه',
    sections,
    footer: '💡 نکته: «وضعیت من» وضعیتِ *امروز* را می‌دهد؛ شناسنامه *هویتِ ماندگارت* را.',
  })
}

function jobValueOf(profile: PlayerIdentityView): string {
  if (!profile.jobTitle) return 'بیکار'
  return profile.isWorkingNow ? `*${profile.jobTitle}*  ⏺ در حال کار` : profile.jobTitle
}

// ──────────────────────────────────────────────────────────────────────────────
//  📋 وضعیتِ من — داشبوردِ امروز
// ──────────────────────────────────────────────────────────────────────────────

export function renderStatusPanel(
  profile: PlayerIdentityView,
  options: { showMoney?: boolean; hint?: string; age?: number } = {},
): string {
  const education = profile.educationField
    ? `${profile.educationDegree} (${profile.educationField})`
    : profile.educationDegree
  const healthPct = Math.round((profile.health / profile.maxHealth) * 100)

  const health2ProdScore = profile.productivityScore
  const health2ProdLabel = profile.productivityLabel
  const sections: Parameters<typeof panel>[0]['sections'] = [
    {
      title: '🕐 ساعت بازی',
      lines: [gameClockLine()]
    },
    {
      title: '⚡ توان و سلامت',
      lines: [
        `❤️ سلامت  ${healthBar(healthPct)}  _${profile.healthLabel}_`,
        `⚡ خستگی  ${fatigueBar(profile.fatigue)}`,
        `⭐ تجربه  ${fa(profile.experience)}  ·  *${experienceTierLabel(profile.experience)}*`,
        `⚙️ بهره‌وری  ${barWithPercent(health2ProdScore, 8)}  _${health2ProdLabel}_`,
        ...(options.age === undefined ? [] : [`🩺 ${vitalityRateHint(options.age)}`])
      ],
    },
    {
      title: '📍 زندگی و کار',
      rows: [
        { label: '💼 شغل', value: jobValueOf(profile) },
        { label: '🎓 تحصیلات', value: education },
        { label: '🏡 محل زندگی', value: profile.homeGroup?.title ?? '—' },
        { label: '💍 تأهل', value: maritalStatusLabels[profile.maritalStatus] },
        { label: '📊 سطح اجتماعی', value: socialLevelLabels[profile.socialLevel] },
        { label: '👥 عضویت', value: `${fa(profile.groupCount)} منطقه` },
      ],
    },
  ]

  if (options.showMoney) {
    sections[1]?.rows?.push({ label: '💰 موجودی', value: `*${money(profile.balance)}*` })
  }

  if (profile.biography) {
    sections.push({ title: '📝 زندگی‌نامه', lines: [`_${profile.biography}_`] })
  }

  return panel({
    icon: '📋',
    title: 'وضعیت من',
    sections,
    footer: options.hint ?? '💡 برای جزئیاتِ کامل، «شناسنامه» یا «راهنما» را بفرست.',
  })
}

// ──────────────────────────────────────────────────────────────────────────────
//  📈 اعتبار مالی
// ──────────────────────────────────────────────────────────────────────────────

export function renderCreditPanel(credit: CreditProfile): string {
  const factorLines =
    credit.factors.length > 0
      ? credit.factors.map(
          (f) => `${f.impact > 0 ? '🟢' : '🔴'} ${f.label}: ${f.impact > 0 ? '+' : ''}${fa(f.impact)}`,
        )
      : ['اطلاعات کافی برای تحلیل ثبت نشده است — پس‌انداز و فعالیت بساز.']

  const scorePercent = Math.round(((credit.score - 300) / 600) * 100)

  return panel({
    icon: '📈',
    title: 'اعتبار مالی',
    sections: [
      {
        title: '🎯 امتیاز اعتباری',
        rows: [
          { label: 'امتیاز', value: `*${fa(credit.score)}* از ۹۰۰` },
          { label: 'رتبه', value: `*${credit.grade}* — ${credit.gradeLabel}` },
        ],
        lines: [barWithPercent(scorePercent, 12)],
      },
      {
        title: '💰 وضعیت مالی',
        rows: [
          { label: '💵 نقدی', value: money(credit.cashBalance) },
          { label: '🏦 بانکی', value: money(credit.bankBalance) },
          { label: '🏘️ دارایی ثابت', value: money(credit.assetValue) },
          { label: '📑 بدهی جاری', value: credit.totalDebt > 0 ? `*${money(credit.totalDebt)}*` : money(0) },
          { label: '📊 خالص دارایی', value: `*${money(credit.netWorth)}*` },
        ],
      },
      {
        title: '🏦 سقف تسهیلات',
        rows: [
          { label: 'حداکثر وام', value: `*${money(credit.maxLoanAmount)}*` },
          { label: 'وامِ جاری', value: `${fa(credit.activeLoans)} فقره` },
          { label: 'تسویه‌شده', value: `${fa(credit.repaidLoans)} فقره` },
        ],
      },
      { title: '🔍 عواملِ مؤثر', lines: factorLines },
    ],
    footer: '💡 با پس‌انداز، خرید دارایی و بازپرداخت منظم، گریدت بهتر می‌شود و نرخ وام ارزان‌تر.',
  })
}

// ──────────────────────────────────────────────────────────────────────────────
//  📜 دفتر مالی
// ──────────────────────────────────────────────────────────────────────────────

export function renderLedgerPanel(ledger: LedgerPage): string {
  if (ledger.entries.length === 0) {
    return panel({
      icon: '📜',
      title: 'دفتر مالی',
      sections: [
        {
          lines: [
            'هیچ تراکنش مالی ثبت نشده است.',
            '',
            'با کار کردن، خرید، عملیات بانکی و زندگی روزمره،',
            'همهٔ گردش‌هایت اینجا با جزئیات ثبت می‌شود.',
          ],
        },
      ],
      footer: '💡 «اعتبار مالی» را هم ببین — سقف وام و گریدت را می‌گوید.',
    })
  }

  const net = ledger.totalIn - ledger.totalOut
  const netLabel = net >= 0 ? '📈 مانده (سود)' : '📉 مانده (کسری)'

  const lines = ledger.entries.map((entry) => {
    const sign = entry.direction === 'in' ? '🟢 +' : '🔴 −'
    const title = label(transactionLabels, entry.type, 'تراکنش')
    const date = faDate(entry.createdAt)
    return `${sign} ${money(entry.amount)}\n   _${title}_ — ${date}`
  })

  const totalPages = Math.max(1, Math.ceil(ledger.total / ledger.pageSize))

  return panel({
    icon: '📜',
    title: 'دفتر مالی',
    sections: [
      {
        title: '📊 خلاصه',
        rows: [
          { label: '🟢 کل ورودی', value: money(ledger.totalIn) },
          { label: '🔴 کل خروجی', value: money(ledger.totalOut) },
          { label: netLabel, value: `*${money(Math.abs(net))}*` },
        ],
      },
      { title: '🧾 آخرین تراکنش‌ها', lines },
    ],
    footer: `صفحهٔ ${fa(ledger.page + 1)} از ${fa(totalPages)} — مجموع ${fa(ledger.total)} تراکنش`,
  })
}

// ──────────────────────────────────────────────────────────────────────────────
//  📊 آمارِ من
// ──────────────────────────────────────────────────────────────────────────────

export function renderStatisticsPanel(stats: PlayerStatistics): string {
  const badge: Record<string, string> = {
    unset: '⚪',
    zero: '⚪',
    starting: '🔵',
    growing: '🟢',
    high: '🟡',
    elite: '🟣',
    unranked: '⚪',
    ranked: '🏅',
  }

  const sections = stats.groups.map((group) => ({
    title: group.title,
    lines: group.items.flatMap((item) => {
      const icon = badge[item.state] ?? '🔵'
      const main = `${icon} *${item.label}*: ${item.display}`
      return item.hint ? [main, `   ↳ _${item.hint}_`] : [main]
    }),
  }))

  return panel({
    icon: '📊',
    title: 'آمار من',
    sections,
    footer: '💡 راهنمای هر شاخص در «راهنما ← آمار» توضیح داده شده است.',
  })
}

// ──────────────────────────────────────────────────────────────────────────────
//  💼 تسویهٔ حقوق (Payroll)
// ──────────────────────────────────────────────────────────────────────────────

export function renderPayrollPanel(settlement: PayrollSettlement, isPreview: boolean): string {
  if (settlement.skipped) {
    return panel({
      icon: '💼',
      title: 'تسویهٔ حقوق',
      sections: [
        {
          lines: [
            'در حال حاضر چیزی برای تسویه وجود ندارد.',
            '',
            'درآمد و حقوق بر پایهٔ *کارکرد ثبت‌شده* است، نه گذشت زمان.',
            'اگر کسی در این دوره شیفت نگرفته باشد، همین پیام دوباره می‌آید.',
          ],
        },
      ],
      footer: '💡 هر تسویه، درآمد، هزینهٔ عملیاتی و حقوق همه را یک‌جا ثبت می‌کند.',
    })
  }

  const sections: Parameters<typeof panel>[0]['sections'] = [
    {
      title: '📊 حسابداریِ دوره',
      rows: [
        { label: '⏱️ مدتِ دوره', value: `${fa(settlement.elapsedMinutes)} دقیقه` },
        { label: '🕘 کارکردِ ثبت‌شده', value: formatGameMinutes(settlement.deliveredMinutes) },
        {
          label: '👥 نیروی انسانی',
          value: `${fa(settlement.activeEmployees)} نفر · ضریب *${fa(Math.round(settlement.staffingFactor * 100))}٪*`,
        },
        { label: '📈 درآمد ناخالص', value: money(settlement.grossRevenue) },
        { label: '📉 هزینهٔ عملیاتی', value: money(settlement.operatingCost) },
        { label: '👥 حقوق پرداختی (ناخالص)', value: money(settlement.totalPayroll) },
        {
          label: '🧾 مالیات بر درآمد کارمندان',
          value: settlement.totalTax > 0 ? money(settlement.totalTax) : '—',
        },
        {
          label: '💵 خالص به کارمندان',
          value: money(settlement.totalPayroll - settlement.totalTax),
        },
        {
          label: settlement.netProfit >= 0 ? '✅ سود خالص' : '⚠️ زیان خالص',
          value: `*${money(Math.abs(settlement.netProfit))}*`,
        },
      ],
    },
    {
      title: '🏛️ خزانه',
      rows: [
        { label: 'پیش از تسویه', value: money(settlement.treasuryBefore) },
        { label: 'پس از تسویه', value: `*${money(settlement.treasuryAfter)}*` },
      ],
    },
  ]

  if (settlement.totalUnpaidDebt > 0) {
    sections.push({
      title: '⚠️ بدهیِ حقوقی',
      lines: [
        `${money(settlement.totalUnpaidDebt)} حقوق به‌عنوان *بدهی* ثبت شد؛`,
        'با موجودیِ بیشترِ خزانه در تسویهٔ بعد پرداخت می‌شود.',
        `${fa(settlement.unpaidEmployees)} کارمند حقوق کامل نگرفتند — خزانه را تقویت کن.`,
      ],
    })
  }

  if (settlement.lines.length > 0) {
    sections.push({
      title: '👥 کارمندان',
      lines: settlement.lines.map((line) => {
        const status = line.unpaid === 0 ? '✅' : line.paid > 0 ? '⚠️' : '❌'
        const detail =
          line.unpaid === 0
            ? line.tax > 0
              ? `${money(line.paid)} (خالص ${money(line.net)})`
              : money(line.paid)
            : `${money(line.paid)} از ${money(line.owed)}`
        return `${status} *${line.employeeTitle}* — ${detail}`
      }),
    })
  }

  return panel({
    icon: '💼',
    title: isPreview ? `پیش‌نمایشِ تسویه — ${settlement.businessName}` : `تسویهٔ حقوق — ${settlement.businessName}`,
    sections,
    footer: isPreview
      ? '💡 برای انجام تسویه، دکمهٔ «تأیید» را بزن.'
      : '✅ تسویه انجام شد و تراکنش‌ها ثبت شدند.',
  })
}

// ──────────────────────────────────────────────────────────────────────────────
//  🏡 محل زندگی
// ──────────────────────────────────────────────────────────────────────────────

export function renderResidencePanel(
  info: ResidenceInfo,
  levelLabel: string | null,
  availableRegions: Array<{ title: string; environmentLevel: string }>,
): string {
  if (!info.hasResidence) {
    return panel({
      icon: '🏡',
      title: 'محل زندگی',
      sections: [
        {
          lines: [
            'هنوز محل اقامتی برایت ثبت نشده است.',
            '',
            'اقامت با *اولین فعالیت واقعی* در یک گروه ثبت می‌شود؛',
            'مثلاً فرستادن «شناسنامه»، «کار»، «بانک» یا «خانه» داخل گروه.',
            '',
            '💡 تنها *عضو شدن* در گروه، اقامت ایجاد نمی‌کند.',
          ],
        },
      ],
      footer: 'برای ثبتِ اقامت، در یک گروه کلمهٔ مرتبط را بفرست.',
    })
  }

  const sections: Parameters<typeof panel>[0]['sections'] = [
    {
      title: '📍 اقامتِ اصلی',
      rows: [
        { label: '🏡 منطقه', value: `*${info.residenceTitle ?? 'ثبت نشده'}*` },
        { label: '🏙️ سطح', value: levelLabel ?? 'ثبت نشده' },
        { label: '📅 از تاریخ', value: info.residenceSince ? faDate(info.residenceSince) : 'ثبت نشده' },
        { label: '🔄 مهاجرت', value: `${fa(info.migrationCount)} بار` },
      ],
    },
  ]

  if (info.isTraveling) {
    sections.push({
      title: '✈️ سفر',
      lines: [
        `مهمانِ «*${info.currentRegionTitle ?? 'منطقهٔ دیگر'}*» هستی.`,
        'حضور موقت، اقامت اصلی‌ات را تغییر نمی‌دهد.',
      ],
    })
  }

  if (availableRegions.length > 0) {
    sections.push({
      title: '🗺️ مقاصدِ قابل مهاجرت',
      lines: bullets(availableRegions.map((r) => `*${r.title}*`)),
    })
  }

  const cooldownNote =
    info.canMigrateAt && info.canMigrateAt.getTime() > Date.now()
      ? `⏳ مهاجرت بعدی از *${faDate(info.canMigrateAt)}* امکان‌پذیر است.`
      : '✅ در حال حاضر می‌توانی مهاجرت کنی.'

  return panel({
    icon: '🏡',
    title: 'محل زندگی',
    sections,
    footer: cooldownNote,
  })
}

export function renderMigrationCheckPanel(targetTitle: string, check: MigrationCheck): string {
  if (!check.allowed) {
    return panel({
      icon: '⚠️',
      title: 'مهاجرت امکان‌پذیر نیست',
      sections: [{ title: `🏙️ مقصد: ${targetTitle}`, lines: bullets(check.blockers) }],
      footer: 'پس از رفع موارد بالا دوباره تلاش کن.',
    })
  }

  return panel({
    icon: '✈️',
    title: 'تأییدِ مهاجرت',
    sections: [
      {
        rows: [
          { label: '🏙️ مقصد', value: `*${targetTitle}*` },
          { label: '💰 هزینه', value: `*${money(check.cost)}*` },
        ],
        lines: ['با تأیید، محل اقامت اصلی‌ات تغییر می‌کند و هزینه کسر می‌شود.'],
      },
    ],
    footer: '⚠️ پس از مهاجرت، تا *۷۲ ساعت* نمی‌توانی دوباره مهاجرت کنی.',
  })
}

// ──────────────────────────────────────────────────────────────────────────────
//  📰 اخبار
// ──────────────────────────────────────────────────────────────────────────────

export function renderNewsPanel(feed: NewsFeed): string {
  if (feed.items.length === 0) {
    return panel({
      icon: '📰',
      title: `اخبار ${feed.groupTitle}`,
      sections: [
        {
          lines: [
            'در هفتهٔ گذشته خبر مهمی در این منطقه ثبت نشده است.',
            '',
            'خبرها از اتفاقات *واقعیِ همین منطقه* ساخته می‌شوند:',
            '• رشد یا افت اقتصادی',
            '• تأسیس و رشد کسب‌وکار',
            '• رکوردهای ثروت و جمعیت',
            '• معاملاتِ بزرگ',
          ],
        },
      ],
      footer: '💡 با فعالیت — کار، معامله، تأسیس — خبر می‌سازی.',
    })
  }

  const lines = feed.items.flatMap((item) => {
    const badge = item.priority >= 5 ? '🔴' : item.priority >= 4 ? '🟠' : '🔵'
    const date = faDate(item.createdAt)
    const body = [`${badge} *${item.title}*`]
    if (item.detail) body.push(`   _${item.detail}_`)
    if (item.amount !== null) body.push(`   💰 ${money(item.amount)}`)
    body.push(`   🕐 ${date}`, '')
    return body
  })

  const totalPages = Math.max(1, Math.ceil(feed.total / feed.pageSize))

  return panel({
    icon: '📰',
    title: `اخبار ${feed.groupTitle}`,
    sections: [{ lines }],
    footer: `صفحهٔ ${fa(feed.page + 1)} از ${fa(totalPages)} — ${fa(feed.total)} خبر در هفتهٔ گذشته`,
  })
}

// ──────────────────────────────────────────────────────────────────────────────
//  🏙️ وضعیت منطقه
// ──────────────────────────────────────────────────────────────────────────────

export function renderRegionPanel(state: RegionState, levelLabel: string): string {
  const trend =
    state.indexTrend > 0
      ? `🟢 رو به رشد (+${fa(state.indexTrend)})`
      : state.indexTrend < 0
        ? `🔴 رو به افت (${fa(state.indexTrend)})`
        : '⚪ باثبات'

  return panel({
    icon: '🏙️',
    title: state.groupTitle,
    sections: [
      {
        title: '👥 جمعیت',
        rows: [
          { label: '🏙️ سطح منطقه', value: `*${levelLabel}*` },
          { label: '👥 جمعیت', value: `${fa(state.population)} بازیکن` },
          { label: '💼 شاغل', value: `${fa(state.employed)} نفر` },
          { label: '🚫 بیکار', value: `${fa(state.unemployed)} نفر` },
        ],
        lines: [`📈 نرخ اشتغال  ${barWithPercent(state.employmentRate, 8)}`],
      },
      {
        title: '📊 اقتصاد',
        rows: [
          { label: 'شاخص اقتصادی', value: `${fa(state.economicIndex)} از ۱۰۰` },
          { label: '📉 روند', value: trend },
          { label: '💰 ثروت کل', value: money(state.totalWealth) },
          { label: '🏦 سپردهٔ بانکی', value: money(state.bankDeposits) },
          { label: '📑 بدهی کل', value: money(state.totalDebt) },
        ],
        lines: [`⚖️ سلامت اقتصادی  ${barWithPercent(state.economicIndex, 8)}`],
      },
      {
        title: '🏗️ زیرساخت و گردش مالی',
        rows: [
          { label: '🏢 کسب‌وکار', value: `${fa(state.companies)} مورد` },
          { label: '🏠 املاک', value: `${fa(state.properties)} ملک` },
          { label: '🎓 تحصیل‌کرده', value: `${fa(state.educatedCount)} نفر` },
          { label: '🔄 گردش هفتگی', value: money(state.transactionVolume) },
          { label: '🧾 تراکنش', value: `${fa(state.transactionCount)} مورد` },
          { label: '🏛️ صندوق منطقه', value: money(state.taxRevenue) },
        ],
      },
    ],
    footer: `🕐 آخرین بازمحاسبه: ${state.refreshedAt.toLocaleTimeString('fa-IR')}`,
  })
}

// ──────────────────────────────────────────────────────────────────────────────
//  🏆 رتبه‌بندی
// ──────────────────────────────────────────────────────────────────────────────

export function renderRankingPanel(result: RankingResult): string {
  const scopeLabel =
    result.scope === 'group' ? 'این منطقه' : result.scope === 'region' ? 'مناطق' : 'جهانی'

  if (result.rows.length === 0) {
    return panel({
      icon: '🏆',
      title: `${result.title} — ${scopeLabel}`,
      sections: [
        {
          lines: [
            'اطلاعات کافی برای رتبه‌بندی ثبت نشده است.',
            '',
            'با کار کردن، سرمایه‌گذاری و فعالیتِ بیشتر، اینجا دیده می‌شوی.',
          ],
        },
      ],
    })
  }

  const medals = ['🥇', '🥈', '🥉']
  const lines = result.rows.map((row) => {
    const badge = row.rank <= 3 ? medals[row.rank - 1] : `${fa(row.rank)}.`
    return `${badge} *${row.name}* — ${row.value}`
  })

  const totalPages = Math.max(1, Math.ceil(result.total / result.pageSize))

  return panel({
    icon: '🏆',
    title: `${result.title} — ${scopeLabel}`,
    sections: [{ lines }],
    footer: `صفحهٔ ${fa(result.page + 1)} از ${fa(totalPages)}`,
  })
}

// ──────────────────────────────────────────────────────────────────────────────
//  🎯 مأموریت‌ها
// ──────────────────────────────────────────────────────────────────────────────

export function renderMissionPanel(board: MissionBoard): string {
  if (board.missions.length === 0) {
    return panel({
      icon: '🎯',
      title: 'مأموریت‌ها',
      sections: [
        {
          lines: [
            '🎉 تمام مأموریت‌های فعلی را انجام داده‌ای!',
            '',
            `✅ تکمیل‌شده: ${fa(board.completedCount)} از ${fa(board.totalTracked)}`,
            '',
            'با پیشرفت در بازی، مأموریت‌های تازه باز می‌شوند.',
          ],
        },
      ],
    })
  }

  const stars = ['⭐', '⭐⭐', '⭐⭐⭐']
  const sections = board.missions.map((m) => {
    const percent = m.target > 0 ? Math.min(100, Math.round((m.progress / m.target) * 100)) : 0
    return {
      title: `${m.title}  ${stars[m.difficulty - 1]}`,
      lines: [m.description, `${barWithPercent(percent, 10)}  ${fa(m.progress)}/${fa(m.target)}`, `🎁 ${m.reward}`, `💡 ${m.hint}`],
    }
  })

  return panel({
    icon: '🎯',
    title: 'مأموریت‌های من',
    sections,
    footer: `✅ تکمیل‌شده: ${fa(board.completedCount)} از ${fa(board.totalTracked)}`,
  })
}

// ──────────────────────────────────────────────────────────────────────────────
//  🗂️ تاریخچه
// ──────────────────────────────────────────────────────────────────────────────

export function renderHistoryPanel(history: HistoryPage, filterLabel = 'همه'): string {
  const title = filterLabel === 'همه' ? 'تاریخچهٔ زندگی' : `تاریخچهٔ زندگی — ${filterLabel}`
  if (history.entries.length === 0) {
    return panel({
      icon: '🗂️',
      title,
      sections: [
        {
          lines: [
            filterLabel === 'همه'
              ? 'هنوز رخداد مهمی ثبت نشده است.'
              : `در این بخش (${filterLabel}) رخدادی ثبت نشده است.`,
            '',
            'رخدادهای مهمِ زندگی‌ات اینجا ثبت می‌شوند:',
            '• شروع و پایانِ کار',
            '• خرید ملک و تأسیس کسب‌وکار',
            '• عملیات بانکی و وام',
            '• فارغ‌التحصیلی و دستاوردها',
            '',
            'با دکمه‌های بالا می‌توانی تاریخچه را برش بزنی.',
          ],
        },
      ],
    })
  }

  const lines = history.entries.flatMap((entry) => {
    const kind = label(historyEventLabels, entry.type, 'رخداد')
    const date = faDate(entry.createdAt)
    const body = [`▪️ *${entry.title}*`, `   ${kind} — ${date}`]
    if (entry.amount !== null) body.push(`   💰 ${money(entry.amount)}`)
    body.push('')
    return body
  })

  const totalPages = Math.max(1, Math.ceil(history.total / history.pageSize))

  return panel({
    icon: '🗂️',
    title,
    sections: [{ lines }],
    footer: `صفحهٔ ${fa(history.page + 1)} از ${fa(totalPages)} — ${fa(history.total)} رخداد`,
  })
}

// ──────────────────────────────────────────────────────────────────────────────
//  🛡️ مدیریت منطقه
// ──────────────────────────────────────────────────────────────────────────────

export function renderRegionManagementPanel(
  state: RegionState,
  levelLabel: string,
  roleLabel: string,
  warnings: string[],
): string {
  return panel({
    icon: '🛡️',
    title: `مدیریتِ ${state.groupTitle}`,
    sections: [
      {
        title: '👤 سمت تو',
        rows: [
          { label: 'نقش', value: `*${roleLabel}*` },
          { label: '🏙️ سطح منطقه', value: levelLabel },
        ],
      },
      {
        title: '📊 وضعیت منطقه',
        rows: [
          { label: '👥 جمعیت', value: `${fa(state.population)} بازیکن` },
          { label: '💼 شاغل', value: `${fa(state.employed)} نفر` },
          { label: '🏠 مسکن', value: `${fa(state.properties)} ملک` },
          { label: '🏢 کسب‌وکار', value: `${fa(state.companies)} مورد` },
          { label: '📈 شاخص اقتصادی', value: `${fa(state.economicIndex)} از ۱۰۰` },
          { label: '🏛️ صندوق منطقه', value: money(state.taxRevenue) },
        ],
      },
      {
        title: '⚠️ هشدارها',
        lines: warnings.length > 0 ? warnings : ['✅ وضعیت منطقه سالم است.'],
      },
    ],
    footer: '💡 این پنل فقط برای مدیرانِ همین منطقه در دسترس است.',
  })
}

// ──────────────────────────────────────────────────────────────────────────────
//  🎓 تحصیل
// ──────────────────────────────────────────────────────────────────────────────

export function renderEducationPanel(status: {
  currentDegree: string
  degreeLabel: string
  currentField: string | null
  enrollment: {
    isStudying: boolean
    fieldTitle?: string
    degreeTitle?: string
    progressPercentage: number
    minutesRemaining: number
    canGraduate: boolean
    /** دسته‌های شغلیِ هم‌حوزهٔ رشته — همان‌جا که مدرک دستمزد بیشتری می‌سازد. */
    affinitySummary?: string
  }
}): string {
  const degreeRow = {
    label: '📜 آخرین مدرک',
    value: status.currentField ? `*${status.degreeLabel}* · ${status.currentField}` : `*${status.degreeLabel}*`,
  }

  if (!status.enrollment.isStudying) {
    const sections: Parameters<typeof panel>[0]['sections'] = [
      { rows: [degreeRow] },
      {
        title: '💡 مسیرِ رشد · تحصیل → مهارت → شغل → درآمد',
        lines: [
          'هر مقطع، مهارت و شانسِ استخدامِ تازه می‌دهد:',
          '• *دیپلم* → کارهای پایه، خدماتی، فروش اولیه',
          '• *کاردانی* → فنی متوسط، اداری، حسابداری پایه',
          '• *کارشناسی* → درمان مقدماتی، مهندسی، مدیریت شعبه',
          '• *کارشناسی‌ارشد* → تخصص پیشرفته، مربیگری، تحلیل مالی',
          '• *دکتری* → پژوهش، پزشکی تخصصی، کارآفرینی سطح بالا',
          '',
          'پس از فارغ‌التحصیلی، مهارتِ رشته را می‌گیری و',
          'هر سطحِ آن تا ٪۱۰ به دستمزدِ مشاغلِ هم‌حوزه می‌افزاید.',
        ],
      },
    ]

    if (status.currentField && status.enrollment.affinitySummary) {
      sections.push({
        title: '🎯 رشتهٔ تو کجا برایت پول بیشتری می‌سازد',
        lines: [
          `*${status.currentField}* در این دسته‌ها دستمزد بهتری می‌گیرد:`,
          `${status.enrollment.affinitySummary}`,
          '',
          'در بقیهٔ دسته‌ها هم می‌توانی کار کنی؛ فقط پاداشِ هم‌حوزه بودن را نمی‌گیری.',
        ],
      })
    }

    return panel({
      icon: '🎓',
      title: 'تحصیل',
      sections,
      footer: 'برای ثبت‌نامِ مقطعِ بعدی، از دکمه‌های زیر رشته را انتخاب کن.',
    })
  }

  return panel({
    icon: '🎓',
    title: 'تحصیل',
    sections: [
      { rows: [degreeRow] },
      {
        title: '📚 دورهٔ جاری',
        rows: [
          { label: 'رشته', value: `*${status.enrollment.fieldTitle ?? 'نامشخص'}*` },
          { label: 'مقطع', value: status.enrollment.degreeTitle ?? 'نامشخص' },
          { label: '⏱️ باقی‌مانده', value: `${fa(status.enrollment.minutesRemaining)} دقیقه` },
        ],
        lines: [
          `${barWithPercent(status.enrollment.progressPercentage, 10)}`,
          '💡 تحصیل → مهارت → شغلِ پردرآمدتر → تسویهٔ حقوقِ بیشتر',
          ...(status.enrollment.affinitySummary
            ? [`🎯 پس از فارغ‌التحصیلی در دستهٔ *${status.enrollment.affinitySummary}* دستمزد بهتری می‌گیری.`]
            : []),
          '😴 در دوران تحصیل هم می‌توانی از «خانه» استراحت کنی؛ فقط کار ممنوع است.',
        ],
      },
    ],
    footer: status.enrollment.canGraduate
      ? '🎉 دوره‌ات تمام شد — «دریافت مدرک» را بزن.'
      : '⏳ تا پایان دوره صبر کن؛ شهریه برنمی‌گردد و تغییر رشته ممکن نیست.',
  })
}

// ──────────────────────────────────────────────────────────────────────────────
//  ⭐ مهارت‌ها
// ──────────────────────────────────────────────────────────────────────────────

export function renderSkillsList(
  skills: { level: number; points: number; skill: { name: string; description: string | null } }[],
): string {
  if (skills.length === 0) {
    return panel({
      icon: '⭐',
      title: 'مهارت‌ها',
      sections: [
        {
          lines: [
            'هنوز مهارتی ثبت نشده است.',
            '',
            '• با *تحصیل*، مهارتِ رشته را می‌گیری.',
            '• با *کارِ مرتبط*، هر ۱۵ دقیقه ۱ امتیاز تمرین می‌گیری.',
            '• هر ۵۰ امتیاز = یک سطح؛ هر سطح تا ٪۱۰ به دستمزدِ شغلِ همان حوزه می‌افزاید.',
          ],
        },
      ],
      footer: '💡 مدرک به‌تنهایی استخدام نمی‌آورد؛ مهارت و سابقه هم لازم است.',
    })
  }

  return panel({
    icon: '⭐',
    title: 'مهارت‌ها',
    sections: [
      {
        lines: skills.flatMap((s) => {
          const lvl = s.level
          const isMax = lvl >= 10
          const pointsInLevel = s.points % 50
          const need = isMax ? 0 : 50 - pointsInLevel
          const progress = isMax ? 100 : Math.round((pointsInLevel / 50) * 100)
          const lvlBar = bar(Math.min(100, Math.round((lvl / 10) * 100)), 6)
          const main = `• *${s.skill.name}* — سطح ${fa(lvl)}${isMax ? ' (سقف 🏆)' : ''}  ${lvlBar}`
          if (isMax) return [main, '   ✨ سقف مهارت — هر کارِ مرتبط همچنان تجربه می‌دهد.']
          return [
            main,
            `   ${barWithPercent(progress, 8)}  ${fa(pointsInLevel)}/۵۰ تا سطح ${fa(lvl + 1)} · ${fa(s.points)} امتیاز کل${need <= 10 && need > 0 ? ' · نزدیک ارتقا ⏳' : ''}`,
          ]
        }),
      },
    ],
    footer: '💡 هر سطح مهارتِ مرتبط، دستمزدِ همان دسته را تا ٪۱۰ بیشتر می‌کند. با کارِ مرتبط امتیاز بگیر.',
  })
}

/**
 * پنل «تمرین مهارت» — نمای عمیق: وضعیت هر مهارت + جایی که واقعاً مصرف
 * می‌شود + هزینهٔ جلسهٔ بعدی تمرین. مصرف‌کننده‌ها از کاتالوگ واقعیِ شغل‌ها
 * و کسب‌وکارها خوانده می‌شوند؛ دکمهٔ تمرین در `buildSkillsTrainingKeyboard`.
 */
export function renderSkillsTrainingPanel(overview: {
  sessionsToday: number
  canTrainMore: boolean
  skills: Array<{
    id: string
    name: string
    description: string | null
    level: number
    points: number
    pointsToNext: number | null
    maxed: boolean
    nextSessionCost: number
    usedInJobs: string[]
    usedInBusinesses: string[]
  }>
}): string {
  const lines = overview.skills.flatMap((s) => {
    const pointsInLevel = s.points % 50
    const progress = s.maxed ? 100 : Math.round((pointsInLevel / 50) * 100)
    const head = `• *${s.name}* — سطح ${fa(s.level)}${s.maxed ? ' (سقف 🏆)' : ''}`
    const usage = [
      ...(s.usedInJobs.length > 0 ? [`کار: ${s.usedInJobs.join('، ')}`] : []),
      ...(s.usedInBusinesses.length > 0 ? [`کسب‌وکار: ${s.usedInBusinesses.join('، ')}`] : []),
    ].join(' · ')
    if (s.maxed) {
      return [head, usage ? `   🎯 ${usage}` : '   🎯 در کارهای مرتبط مصرف می‌شود.']
    }
    return [
      head,
      `   ${barWithPercent(progress, 8)}  ${fa(pointsInLevel)}/۵۰ تا سطح ${fa(s.level + 1)}`,
      `   🏋️ تمرین: ${money(s.nextSessionCost)} (+۱۲ امتیاز)${usage ? ` · 🎯 ${usage}` : ''}`,
    ]
  })

  return panel({
    icon: '⭐',
    title: 'مهارت‌ها و تمرین',
    sections: [
      {
        lines: [
          overview.canTrainMore
            ? `🏋️ امروز ${fa(overview.sessionsToday)} جلسه تمرین کرده‌ای؛ با دکمه‌های زیر تمرین کن.`
            : '✅ ظرفیت تمرینِ امروز پر شده؛ تمرینِ بیشتر در یک روز بازده ندارد.',
          'هر جلسه تمرین پول و کمی خستگی می‌گیرد و ۱۲ امتیاز می‌دهد؛ هر ۵۰ امتیاز یک سطح است.',
        ],
      },
      { lines },
    ],
    footer:
      '💡 مهارت فقط عدد نیست: ضریب دستمزدِ کارِ مرتبط و بهره‌وری کارمندانِ کسب‌وکار به آن وابسته است.',
  })
}

// ──────────────────────────────────────────────────────────────────────────────
//  💞 روابط
// ──────────────────────────────────────────────────────────────────────────────

export function renderRelationshipsList(
  relationships: {
    type: keyof typeof relationshipTypeLabels
    status: keyof typeof relationshipStatusLabels
    strength: number
    createdAt: Date
    relatedPlayer: { firstName: string; lastName: string | null } | null
  }[],
): string {
  if (relationships.length === 0) {
    return panel({
      icon: '💞',
      title: 'روابط',
      sections: [
        {
          lines: [
            'هنوز هیچ پیوندی برایت ثبت نشده است.',
            '',
            'پیوندها با دستور ساخته نمی‌شوند؛ از دلِ بازی می‌آیند:',
            '• ازدواج و زندگیِ مشترک → «*خانواده*»',
          ],
        },
      ],
      footer: '💡 این صفحه تنها سابقهٔ پیوندهایت را نشان می‌دهد.',
    })
  }

  return panel({
    icon: '💞',
    title: 'روابط',
    sections: [
      {
        lines: relationships.map((r) => {
          const name = r.relatedPlayer
            ? `${r.relatedPlayer.firstName} ${r.relatedPlayer.lastName ?? ''}`.trim()
            : 'نامشخص'
          const type = relationshipTypeLabels[r.type]
          const st = relationshipStatusLabels[r.status]
          return `• *${type}* — ${name}  _(${st})_  ·  ${faDate(r.createdAt)}`
        }),
      },
    ],
    footer: '💡 پیوندهای بسته‌شده (طلاق/فوتِ همسر) هم این‌جا می‌مانند؛ وضعیتِ جاری و گرمای رابطه در «*خانواده*» است.',
  })
}

// ──────────────────────────────────────────────────────────────────────────────
//  🔔 اعلان‌ها
// ──────────────────────────────────────────────────────────────────────────────

/**
 * صندوق اعلان‌های بازیکن.
 *
 * سه چیز که این پنل باید صادقانه بگوید چون بازیکن هیچ راه دیگری برای
 * فهمیدنشان ندارد:
 *  • چند اعلان **نخوانده** دارد (نشانِ 🔵 روی همان ردیف‌ها).
 *  • از چند اعلانِ کل، همین چندتا نشان داده شده — وگرنه بازیکنِ پرکار
 *    فکر می‌کند اعلان‌های قدیمی‌ترش نابود شده‌اند.
 *  • اگر ۱۰ مورد پر شده باشد، «قدیمی‌ترها در دسترس نیستند» یک واقعیت است،
 *    نه یک باگ؛ پس نوشته می‌شود تا پرسش «بقیه‌شان کو؟» بی‌جواب نماند.
 */
export function renderNotificationsList(board: {
  items: {
    id: string
    title: string
    message: string
    type: keyof typeof notificationTypeLabels
    createdAt: Date
    unread: boolean
  }[]
  unreadCount: number
  total: number
}): string {
  const { items, unreadCount, total } = board

  if (items.length === 0) {
    return panel({
      icon: '🔔',
      title: 'اعلان‌ها',
      sections: [
        {
          lines: [
            'اعلانِ تازه‌ای نداری.',
            '',
            'پس از رخدادهای مرتبط — حقوق، ازدواج، خبرِ شهر —',
            'پیام‌ها در این بخش نمایش داده می‌شوند.',
          ],
        },
      ],
    })
  }

  const summary =
    unreadCount > 0
      ? `${fa(unreadCount)} اعلانِ خوانده‌نشده · از ${fa(total)} اعلان`
      : `همه خوانده شده · ${fa(total)} اعلان`

  const body = items.flatMap((n) => {
    const when = faDate(n.createdAt)
    const type = label(notificationTypeLabels, n.type, '')
    const marker = n.unread ? '🔵' : '⚪'
    return [`${marker} *${n.title}*  _${type}_ — ${when}`, n.message, '']
  })

  const hidden = total - items.length
  const sections: Parameters<typeof panel>[0]['sections'] = [
    { lines: [summary] },
    { lines: body }
  ]
  if (hidden > 0) {
    sections.push({
      lines: [
        `📚 ${fa(hidden)} اعلانِ قدیمی‌تر را این پنل نشان نمی‌دهد.`,
        'پیام‌های خوانده‌شده پس از مدتی خودکار پاک می‌شوند.'
      ]
    })
  }

  return panel({ icon: '🔔', title: 'اعلان‌ها', sections })
}

// ──────────────────────────────────────────────────────────────────────────────
//  🏆 جدول امتیازات (قدیمی اما سازگار)
// ──────────────────────────────────────────────────────────────────────────────

export function renderLeaderboard(
  title: string,
  rows: Array<{
    telegramUserId: bigint
    firstName: string
    lastName: string | null
    balance: { toString: () => string }
    experience: number
    age: number
    occupation: { name: string } | null
  }>,
  scope: 'group' | 'global',
  metric: string,
  page: number,
): string {
  const scopeLabel = scope === 'global' ? 'جهانی' : 'این گروه'

  if (rows.length === 0) {
    return panel({
      icon: '🏆',
      title: `${title} · ${scopeLabel}`,
      sections: [{ lines: ['هنوز بازیکنی در این دسته رتبه‌ای ندارد.', '', 'اولین باش — با کار و سرمایه، اینجا دیده می‌شوی.'] }],
    })
  }

  const medals = ['🥇', '🥈', '🥉']
  const body = rows.map((row, index) => {
    const rank = index + 1 + page * 5
    const badge = page === 0 && index < medals.length ? medals[index]! : `${fa(rank)}.`
    const name = `${row.firstName} ${row.lastName ?? ''}`.trim()

    let value: string
    if (metric === 'money') value = money(row.balance)
    else if (metric === 'experience') value = `${fa(row.experience)} تجربه`
    else value = `${fa(row.age)} سال`

    return `${badge} *${name}* — ${value}`
  })

  return panel({
    icon: '🏆',
    title: `${title} · ${scopeLabel}`,
    sections: [{ lines: body }],
    footer: `صفحهٔ ${fa(page + 1)}`,
  })
}

// ──────────────────────────────────────────────────────────────────────────────
//  🎴 کارت‌های روزانه
// ──────────────────────────────────────────────────────────────────────────────

export function renderQuestPanel(board: QuestBoard): string {
  const cardLines = board.cards.flatMap((card) => {
    const badge = card.claimed ? '✅' : card.done ? '🎁' : '⏳'
    const percent = card.target > 0 ? Math.min(100, Math.round((card.progress / card.target) * 100)) : 0
    return [
      `${badge} *${card.title}*`,
      `   ${barWithPercent(percent, 8)}  ${fa(card.progress)}/${fa(card.target)}`,
      `   🎁 ${money(card.reward)}`,
      card.claimed ? '' : `   💡 ${card.hint}`,
      '',
    ].filter((l) => l !== '')
  })

  const weekPercent =
    board.weekTarget > 0 ? Math.min(100, Math.round((board.weekClaimedCount / board.weekTarget) * 100)) : 0

  const chestLine = board.chestClaimed
    ? '✅ صندوق این هفته را گرفته‌ای.'
    : board.chestReady
      ? '🧰 *صندوقِ هفته آمادهٔ باز شدن است!*'
      : `🧰 با تکمیل هر ${fa(board.weekTarget)} کارتِ هفته، ${money(board.chestAmount)} می‌گیری.`

  return panel({
    icon: '🎴',
    title: 'کارت‌های روزانه',
    sections: [
      { lines: cardLines },
      {
        title: '🎁 پاداش‌های ویژه',
        rows: [
          {
            label: 'تکمیل هر سه کارت',
            value: board.allThreeClaimed ? '✅ گرفته شد' : `${money(board.allThreeBonus)} پاداش اضافه`,
          },
          { label: '📅 کارت‌های این هفته', value: `${fa(board.weekClaimedCount)} از ${fa(board.weekTarget)}` },
        ],
        lines: [barWithPercent(weekPercent, 10), chestLine],
      },
    ],
    footer: '💡 کارت‌ها هر روز عوض می‌شوند و پیشرفتشان با فعالیتِ واقعی جلو می‌رود.',
  })
}

// ──────────────────────────────────────────────────────────────────────────────
//  🏅 نشان‌ها
// ──────────────────────────────────────────────────────────────────────────────

export function renderAchievementPanel(board: AchievementBoard): string {
  const unlocked = board.items.filter((item) => item.unlocked)
  const locked = board.items.filter((item) => !item.unlocked)
  const percent = board.total > 0 ? Math.round((board.unlockedCount / board.total) * 100) : 0

  const sections: Parameters<typeof panel>[0]['sections'] = [
    {
      title: '📊 پیشرفت',
      rows: [
        { label: '🏅 نشان‌های من', value: `${fa(board.unlockedCount)} از ${fa(board.total)}` },
        { label: '💰 پاداش دریافتی', value: money(board.totalReward) },
      ],
      lines: [barWithPercent(percent, 10)],
    },
  ]

  if (board.newlyUnlocked.length > 0) {
    sections.push({
      title: '✨ تازه باز شد',
      lines: board.newlyUnlocked.map(
        (item) => `${item.icon} *${item.title}* — ${money(item.reward)} به کیفت واریز شد!`,
      ),
    })
  }

  if (unlocked.length > 0) {
    sections.push({
      title: '✅ باز شده',
      lines: unlocked.map((item) => `${item.icon} ${item.title}`),
    })
  }

  if (locked.length > 0) {
    sections.push({
      title: '🔒 در انتظار تو',
      lines: locked.map((item) => `🔒 ${item.title} — ${item.description} (${money(item.reward)})`),
    })
  }

  return panel({
    icon: '🏅',
    title: 'نشان‌ها',
    sections,
    footer: '💡 نشان‌ها از وضعیتِ واقعی‌ات سنجیده می‌شوند و پاداششان یک‌بار پرداخت می‌شود.',
  })
}

// ──────────────────────────────────────────────────────────────────────────────
//  ⏳ سپردهٔ مدت‌دار
// ──────────────────────────────────────────────────────────────────────────────

export function renderDepositPanel(board: DepositBoard): string {
  const planLines = board.plans.map(
    (plan) => `⏳ *${plan.label}* — ${fa(plan.termDays)} روز · سود سالانه *٪${fa(Math.round(plan.rateAnnual * 100))}*`,
  )

  const sections: Parameters<typeof panel>[0]['sections'] = [
    { title: '📋 پلن‌ها', lines: planLines },
  ]

  if (board.active.length > 0) {
    sections.push({
      title: '📦 سپرده‌های من',
      lines: board.active.flatMap((d) => [
        `${d.matured ? '✅' : '⏳'} *${d.planLabel}* — ${money(d.principal)}`,
        d.matured
          ? '   سررسید شد — مبلغ به کیفت واریز می‌شود.'
          : `   ${fa(d.daysLeft)} روز مانده  ·  سودِ تا اکنون: ${money(d.accruedNow)}`,
        `   💰 دریافتی در سررسید: ${money(d.projectedPayout)}`,
        '',
      ]),
    })
  }

  sections.push({
    title: '📊 ظرفیت',
    rows: [
      { label: 'اصلِ سپرده‌های فعال', value: money(board.totalActive) },
      { label: 'ظرفیتِ باقی‌مانده', value: money(board.capacityLeft) },
      { label: 'حداقل مبلغ', value: money(board.minPrincipal) },
    ],
  })

  return panel({
    icon: '⏳',
    title: 'سپردهٔ مدت‌دار',
    sections,
    footer:
      board.pendingLiquidity > 0
        ? `🏦 نقدینگی بانک برای ${fa(board.pendingLiquidity)} سپردهٔ سررسیده کافی نیست؛ پس از بازگشت وام‌ها خودکار پرداخت می‌شود.`
        : board.maturedCount > 0
          ? `✅ ${fa(board.maturedCount)} سپردهٔ سررسیدشده همین حالا تسویه شد.`
          : '💡 شکستِ زودهنگامِ سپرده، بخشی از سود را از دست می‌دهد.',
  })
}

// ──────────────────────────────────────────────────────────────────────────────
//  🏥 درمانگاه
// ──────────────────────────────────────────────────────────────────────────────

export function renderClinicPanel(view: ClinicView): string {
  const healthPct = Math.round((view.health / view.maxHealth) * 100)
  const sections: Parameters<typeof panel>[0]['sections'] = [
    {
      title: '❤️ وضعیت سلامت',
      rows: [
        { label: 'سلامت', value: `${fa(view.health)} از ${fa(view.maxHealth)}` },
        { label: 'کمبود', value: `${fa(view.missingHealth)} واحد` },
      ],
      lines: [`${healthBar(healthPct)}  _${view.health >= view.maxHealth ? 'کامل' : 'نیازمند درمان'}_`],
    },
  ]

  if (view.needsTreatment) {
    const rows: {label:string,value:string}[] = [{ label: '💰 هزینهٔ کامل', value: `*${money(view.fullCost)}*` }]
    if (view.insured) rows.push({ label: '🛡️ پرداختی با بیمه', value: `*${money(view.discountedCost)}*` })
    sections.push({ title: '💵 هزینهٔ درمان', rows })

    // پلِ نجات: وقتی موجودی به درمان کامل نمی‌رسد، بازیکن باید بداند که
    // بن‌بست نیست — رنگارنگ و صریح، چون همین جمله بین «ادامهٔ بازی» و
    // «مرگ اجباری» فاصله می‌اندازد.
    if (view.affordableUnits < view.missingHealth) {
      sections.push({
        title: '🚑 درمان اضطراری',
        rows: [
          { label: '🩹 قابل بازیابی', value: `${fa(view.affordableUnits)} واحد` },
          { label: '💰 هزینه', value: `*${money(view.affordableCost)}*` }
        ],
        lines: [
          view.affordableUnits > 0
            ? 'موجودی‌ات به درمان کامل نمی‌رسد؛ ولی می‌توانی همین حالا بخشی از سلامتت را برگردانی.'
            : 'موجودی‌ات حتی برای یک واحد درمان کافی نیست. اول درآمد بساز، یا در خانه استراحت کن.'
        ]
      })
    }
  } else {
    sections.push({ lines: ['✅ سلامتت کامل است — نیازی به درمان نداری.'] })
  }

  sections.push({
    title: '🛡️ بیمهٔ درمان',
    rows: [
      { label: 'وضعیت', value: view.insured ? `✅ فعال · ${fa(view.insuranceDaysLeft)} روز مانده` : '— ندارد' },
      { label: 'حق بیمه', value: `${money(view.premium)} برای ${fa(view.insuranceDays)} روز` },
      { label: 'پوشش', value: `${fa(view.coverRatePercent)}٪` },
    ],
  })

  return panel({
    icon: '🏥',
    title: 'درمانگاه',
    sections,
    footer: view.isCritical
      ? '⚠️ سلامتت بحرانی است؛ کار کردن در این وضعیت پرهزینه است.'
      : '💡 استراحت در خانه ارزان‌تر اما کندتر از درمانگاه است.',
  })
}

// ──────────────────────────────────────────────────────────────────────────────
//  🔑 اجاره
// ──────────────────────────────────────────────────────────────────────────────

export function renderRentalOwnerPanel(properties: OwnerPropertyView[]): string {
  if (properties.length === 0) {
    return panel({
      icon: '🔑',
      title: 'بازار اجاره',
      sections: [
        {
          lines: [
            'هنوز ملکی نداری که اجاره بدهی.',
            '',
            'از بخش «خانه» می‌توانی ملک بخری و بعد آن را اجاره بدهی.',
            'اجاره، درآمدِ ماهانه و بی‌دردسر می‌آورد — بدون کارِ اضافه.',
          ],
        },
      ],
      footer: '💡 با دکمهٔ «آگهی‌های اجاره» می‌توانی خودت مستأجر شوی.',
    })
  }

  const lines = properties.flatMap((p) => {
    const status = p.tenantName
      ? `👤 اجاره داده شده به *${p.tenantName}* · ${fa(p.daysLeft)} روز مانده`
      : p.listedForRent
        ? '📣 در بازار اجاره عرضه شده است'
        : '🚫 در بازار عرضه نشده است'
    const income = p.activeRentAmount
      ? `   💰 اجارهٔ هر تمدید: ${money(p.activeRentAmount)}`
      : `   💰 اجاره‌بهای فعلی: ${money(p.baseRent)}`

    return [
      `🏠 *${p.title}* — سطح ${fa(p.level)}`,
      `   ${status}`,
      income,
      `   📊 بازه مجاز: ${money(p.minRent)} تا ${money(p.maxRent)}`,
      ...(p.tenantName && p.totalRentReceived > 0
        ? [`   🧾 کلِ دریافتی از این قرارداد: ${money(p.totalRentReceived)}`]
        : []),
      '',
    ]
  })

  return panel({
    icon: '🔑',
    title: 'املاک اجاره‌ای من',
    sections: [{ lines }],
    footer: '💡 تا پایانِ قراردادِ فعال، تغییر اجاره‌بها یا برداشتنِ ملک ممکن نیست. با هر پرداختِ مستأجر، اعلان می‌گیری.',
  })
}

export function renderRentalMarketPanel(
  offers: RentableView[],
  tenancy: TenancyView | null,
): string {
  const sections: Parameters<typeof panel>[0]['sections'] = []

  if (tenancy) {
    const expiringSoon = tenancy.daysLeft <= 3
    sections.push({
      title: '📄 قراردادِ جاریِ من',
      rows: [
        { label: '🏠 ملک', value: `*${tenancy.propertyTitle}*` },
        { label: '👤 مالک', value: tenancy.ownerName },
        { label: '💰 اجارهٔ ماهانه', value: money(tenancy.monthlyRent) },
        { label: '📅 روزهای باقی‌مانده', value: `${fa(tenancy.daysLeft)} روز` },
      ],
      lines: [
        expiringSoon
          ? '⚠️ قرارداد دارد تمام می‌شود؛ پیش از پایان «پرداخت اجاره» بزن تا تمدید شود.'
          : '💡 با «پرداخت اجاره» قرارداد ۳۰ روز دیگر تمدید می‌شود؛ پس از پایانِ قرارداد بدون تمدید، ملک استراحت از دستت می‌رود.',
      ],
    })
  }

  if (offers.length > 0) {
    sections.push({
      title: '📣 آگهی‌های فعال',
      lines: offers.flatMap((o) => [
        `🔑 *${o.title}* — سطح ${fa(o.level)}`,
        `   💰 ${money(o.monthlyRent)}  ·  👤 ${o.ownerName}`,
        o.recoveryBonusPercent > 0
          ? `   🛌 ریکاوری ${fa(o.recoveryBonusPercent)}٪ بهتر از اتاقِ پایه`
          : '   🛌 ریکاوریِ پایه',
        '',
      ]),
    })
  } else if (!tenancy) {
    sections.push({
      lines: [
        'در حال حاضر هیچ ملکی برای اجاره عرضه نشده است.',
        '',
        'مالکان می‌توانند از پنل املاکشان ملک را عرضه کنند.',
      ],
    })
  }

  return panel({
    icon: '🔑',
    title: 'آگهی‌های اجاره',
    sections,
    footer: tenancy
      ? '💡 با فسخ قرارداد، اجارهٔ پرداخت‌شده برنمی‌گردد.'
      : '💡 با اجارهٔ ملک می‌توانی بدون خرید، در خانه استراحت کنی.',
  })
}

// ──────────────────────────────────────────────────────────────────────────────
//  🎲 شانس روزانه
// ──────────────────────────────────────────────────────────────────────────────

export function renderFortunePanel(status: {
  drawnToday: boolean
  kind: string | null
  amount: number
  message: string | null
}): string {
  if (!status.drawnToday) {
    return panel({
      icon: '🎲',
      title: 'شانس روزانه',
      sections: [
        {
          lines: [
            'هر روز یک‌بار می‌توانی شانست را امتحان کنی.',
            '',
            'نتیجه ممکن است پیامِ ساده، سودِ کوچک، هزینهٔ کوچک یا جایزهٔ بزرگ باشد.',
          ],
        },
        {
          title: '📜 قواعد',
          lines: [
            '• نتیجهٔ هر روز برای تو ثابت است؛ بستن و باز کردن پنل تغییری نمی‌دهد.',
            '• اگر موجودی‌ات کم باشد، هزینه اعمال نمی‌شود.',
            '• ارقام کوچک‌اند؛ این بخش جایِ کار کردن را نمی‌گیرد.',
          ],
        },
      ],
      footer: '👇 برای کشیدنِ شانسِ امروز، دکمهٔ زیر را بزن.',
    })
  }

  const icon =
    status.kind === 'jackpot' ? '🎉' : status.kind === 'gain' ? '💰' : status.kind === 'loss' ? '💸' : '🍀'

  const rows =
    status.amount > 0
      ? [{ label: status.kind === 'loss' ? '💸 هزینه' : '💰 دریافتی', value: `*${money(status.amount)}*` }]
      : []

  const fortuneSections: Parameters<typeof panel>[0]['sections'] = [
    { lines: [status.message ?? 'شانس امروزت ثبت شد.'] },
  ]
  if (rows.length > 0) fortuneSections.push({ rows })
  return panel({
    icon,
    title: 'شانسِ امروز',
    sections: fortuneSections,
    footer: '💡 فردا دوباره سر بزن؛ شانس هر روز از نو کشیده می‌شود.',
  })
}

// ──────────────────────────────────────────────────────────────────────────────
//  🧭 گذرنامهٔ سفر
// ──────────────────────────────────────────────────────────────────────────────

export function renderPassportPanel(board: PassportBoard): string {
  if (board.total === 0) {
    return panel({
      icon: '🧭',
      title: 'گذرنامهٔ سفر',
      sections: [
        {
          lines: [
            'هنوز هیچ مُهری در گذرنامه‌ات ثبت نشده است.',
            '',
            'با فعالیت در گروه‌های تازه، مُهرِ همان منطقه ثبت می‌شود.',
            `با ${fa(board.travelerTarget)} مُهر، نشانِ «جهانگرد» را می‌گیری.`,
          ],
        },
      ],
      footer: '💡 مُهرِ هر منطقه فقط یک‌بار ثبت می‌شود.',
    })
  }

  const lines = board.stamps.map((stamp) => {
    const levelLabel =
      playerGroupLabels[stamp.environmentLevel as keyof typeof playerGroupLabels] ??
      stamp.environmentLevel
    const date = faDate(stamp.stampedAt)
    return `🧿 *${stamp.groupTitle}* · ${levelLabel} — ${date}`
  })

  const percent = Math.min(100, Math.round((board.total / board.travelerTarget) * 100))

  return panel({
    icon: '🧭',
    title: 'گذرنامهٔ سفر',
    sections: [
      {
        title: '📊 پیشرفت',
        rows: [
          { label: '🧿 مُهرها', value: `${fa(board.total)} منطقه` },
          { label: '🎯 هدفِ جهانگرد', value: `${fa(board.travelerTarget)} منطقه` },
        ],
        lines: [barWithPercent(percent, 10)],
      },
      { title: '🗺️ مناطقِ دیده‌شده', lines },
    ],
    footer: '💡 مُهرِ هر منطقه فقط یک‌بار ثبت می‌شود.',
  })
}

// ──────────────────────────────────────────────────────────────────────────────
//  💞 خانواده
// ──────────────────────────────────────────────────────────────────────────────

export function renderFamilyPanel(view: {
  genderIsMale: boolean
  hasSpouse: boolean
  spouseName: string | null
  marriedAt: Date | null
  mahr: number
  daysMarried: number
  bonusReady: boolean
  bonusWaitingForSpouse?: boolean
  bonusAmount: number
  warmth?: number | null
  warmthLabelText?: string | null
  bonusMultiplier?: number | null
  activityDoneToday?: boolean
  /** همسرِ بازیکن فوت کرده و آن ازدواج بسته شده است (وضعیتِ بازمانده: WIDOWED). */
  isWidowed?: boolean
  incomingProposals: Array<{
    id: string
    fromName: string
    offeredMahr: number
    status: string
    canAccept: boolean
    canSetMahr: boolean
  }>
  outgoingProposals: Array<{
    id: string
    targetName: string
    mahr: number
    awaitingMyAnswer: boolean
  }>
}): string {
  const sections: Parameters<typeof panel>[0]['sections'] = []

  if (view.hasSpouse) {
    const warmth = view.warmth ?? null
    const multiplier = view.bonusMultiplier ?? 1
    sections.push({
      title: '💞 زندگیِ مشترک',
      rows: [
        { label: 'همسر', value: `*${view.spouseName ?? 'نامشخص'}*` },
        {
          label: view.genderIsMale ? '💍 مهریه (پرداخت‌شده به همسر)' : '💍 مهریه (دریافتیِ تو)',
          value: describeMahr(view.mahr),
        },
        { label: '📅 مدتِ زندگیِ مشترک', value: `${fa(view.daysMarried)} روز` },
      ],
    })
    if (warmth !== null) {
      // گرمای رابطه: نوار واقعی + وضعیتی که پاداش روزانه به آن وابسته است
      const warmLines = [
        `🔥 گرمای رابطه: ${barWithPercent(warmth)} — *${view.warmthLabelText ?? ''}*`,
      ]
      if (multiplier < 1) {
        warmLines.push(
          `⚠️ رابطه سرد شده؛ پاداشِ روزانه الان با ضریب ${fa(Math.round(multiplier * 100))}٪ پرداخت می‌شود. با «وقتِ مشترک» و هدیه گرمش کن.`
        )
      }
      sections.push({ lines: warmLines })
    }
    sections.push({
      lines: [
        view.bonusReady
          ? `🎁 پاداشِ امروزِ زوجین (*${money(view.bonusAmount)}*) آماده است — دکمه را بزن.`
          : view.bonusWaitingForSpouse
            ? `⏳ پاداشِ امروز (${money(view.bonusAmount)}) مانده، ولی همسرت ${fa(MARRIAGE_INFO.spouseActiveHours)} ساعتِ اخیر فعالیتی نداشته؛ وقتی او هم سر بزند، دکمه باز می‌شود.`
            : '✅ پاداشِ امروزِ زوجین گرفته شده؛ فردا دوباره سر بزن.',
        ...(view.activityDoneToday
          ? ['🕯️ وقتِ مشترکِ امروز انجام شده است.']
          : ['🕯️ وقتِ مشترکِ امروز مانده — هزینه‌اش را بده، خستگیِ هر دو کم می‌شود و رابطه گرم‌تر.']),
      ],
    })
  } else if (view.isWidowed) {
    // فوتِ همسر: ازدواج بسته شده و راهِ ساختنِ زندگیِ تازه باز است. متن باید
    // دقیقاً همین را بگوید، نه «هنوز متأهل نشده‌ای» که پاک‌کنندهٔ یک واقعهٔ مهم است.
    sections.push({
      title: '🕯️ همسرت فوت شده',
      lines: view.genderIsMale
        ? [
            'آن زندگیِ مشترک با فوتِ همسرت بسته شد و مهریه‌ای که پرداخت کرده بودی پس گرفته نمی‌شود.',
            '',
            'هر وقت آماده بودی می‌توانی دوباره زندگی مشترک بسازی: دکمهٔ «خواستگاری» را بزن،',
            'روی پیامِ طرفِ مقابل *ریپلای* کن و مبلغِ مهریهٔ پیشنهادی را بفرست (`0` یعنی خودش تعیین کند).'
          ]
        : [
            'آن زندگیِ مشترک با فوتِ همسرت بسته شد؛ مهریه‌ای که هنگام عقد گرفته بودی نزد خودت می‌ماند.',
            '',
            'هر وقت آماده بودی می‌توانی دوباره ازدواج کنی؛ پیشنهادهای تازه در همین پنل به تو می‌رسند:',
            'یا مبلغ را می‌پذیری، یا مهریهٔ خودت را تعیین می‌کنی تا پس از تأییدِ خواستگار عقد ثبت شود.',
            '',
            ...mahrRuleLines()
          ]
    })
  } else {
    sections.push({
      lines: view.genderIsMale
        ? [
            'هنوز متأهل نشده‌ای.',
            '',
            'دکمهٔ «خواستگاری» را بزن، سپس روی پیامِ طرفِ مقابل *ریپلای* کن',
            'و مبلغِ مهریهٔ پیشنهادی را بفرست (`0` یعنی مهریه را خودش تعیین کند).',
            'عقد پس از تأییدِ هر دو طرف ثبت می‌شود.',
          ]
        : [
            'هنوز متأهل نشده‌ای.',
            '',
            'پیشنهادهای ازدواج در همین پنل به تو می‌رسند:',
            'یا همین مبلغ را بپذیری، یا مهریهٔ خودت را تعیین کنی',
            'تا پس از تأییدِ خواستگار عقد ثبت شود.',
            '',
            ...mahrRuleLines(),
          ],
    })
  }

  if (view.incomingProposals.length > 0) {
    sections.push({
      title: '💌 خواستگاری‌های در انتظارِ پاسخِ تو',
      lines: view.incomingProposals.flatMap((p) => [
        `👤 *${p.fromName}* — ${
          isMahrSet(p.offeredMahr)
            ? `مهریهٔ پیشنهادی ${money(p.offeredMahr)}`
            : 'مهریه تعیین نشده؛ ابتدا مبلغِ دلخواهت را مشخص کن'
        }`,
        p.status === 'MAHR_SET'
          ? '   مهریه را تو تعیین کردی؛ منتظرِ تأییدِ اوست (می‌توانی تغییرش دهی)'
          : p.canAccept
            ? '   می‌توانی همین مبلغ را بپذیری یا مهریهٔ خودت را تعیین کنی'
            : '   مهریهٔ خودت را تعیین کن تا او تأیید کند',
        '',
      ]),
    })
  }

  if (!view.hasSpouse && view.incomingProposals.length === 0 && view.outgoingProposals.length === 0) {
    sections.push({
      title: '📭 درخواست‌ها',
      lines: ['درخواستِ ازدواجِ بازی نداری. پیشنهادِ تازه پس از ثبت در همین بخش نمایش داده می‌شود.'],
    })
  }

  if (view.outgoingProposals.length > 0) {
    sections.push({
      title: '📨 پیشنهادهای ارسالیِ تو',
      lines: view.outgoingProposals.flatMap((p) => [
        `👤 *${p.targetName}* — ${
          p.awaitingMyAnswer
            ? `مهریهٔ ${money(p.mahr)} تعیین شده؛ منتظرِ تأییدِ توست`
            : `مهریهٔ پیشنهادی ${describeMahr(p.mahr)}؛ در انتظارِ پاسخ`
        }`,
        '',
      ]),
    })
  }

  return panel({
    icon: '💞',
    title: 'خانواده',
    sections,
    footer: view.hasSpouse
      ? '💡 طلاق فقط هزینهٔ ثبت دارد؛ مهریهٔ پرداخت‌شده پس‌گرفته نمی‌شود.'
      : 'مهریه هنگامِ عقد از کیفِ پولِ مرد به کیفِ پولِ زن منتقل می‌شود.',
  })
}

/**
 * پنل «جزئیات خانواده» — نمای عمیقِ زندگی مشترک.
 * همهٔ مقادیر از وضعیتِ واقعیِ دیتابیس می‌آیند: مشخصات همسر، گرمای رابطه،
 * خانه‌ها (مسکن) و داراییِ خانوار (اقتصاد). هیچ عدد نمایشی‌ای در کار نیست.
 */
export function renderFamilyDetailPanel(view: {
  spouse: {
    name: string
    username: string | null
    age: number
    degreeLabel: string
    field: string | null
    employed: boolean
    regionTitle: string | null
    activeRecently: boolean
  } | null
  warmth: number | null
  warmthLabelText: string | null
  bonusMultiplier: number | null
  daysMarried: number
  mahr: number
  activityDoneToday: boolean
  activityCost: number
  myBalance: number
  spouseBalance: { visible: boolean; amount: number } | null
  householdBalance: number | null
  myHome: string | null
  spouseHome: string | null
  sharedHome: string | null
}): string {
  if (!view.spouse) {
    return panel({
      icon: '👨‍👩‍👧',
      title: 'جزئیات خانواده',
      sections: [
        { lines: ['هنوز متأهل نشده‌ای؛ جزئیاتی برای نمایش نیست.', 'از پنل «خانواده» خواستگاری کن.'] },
      ],
    })
  }

  const s = view.spouse
  const sections: Parameters<typeof panel>[0]['sections'] = [
    {
      title: '👤 همسرِ تو',
      rows: [
        { label: 'نام', value: `*${s.name}*` },
        { label: 'شناسه', value: s.username ? `@${s.username}` : '—' },
        { label: 'سن', value: `${fa(s.age)} سال` },
        { label: 'تحصیلات', value: s.field ? `${s.degreeLabel} — ${s.field}` : s.degreeLabel },
        { label: 'شغل', value: s.employed ? 'شاغل' : 'بیکار' },
        { label: 'محل زندگی', value: s.regionTitle ?? '—' },
        { label: 'وضعیت', value: s.activeRecently ? '🟢 اخیراً فعال' : '⚪ مدتی است سر نزده' },
      ],
    },
    {
      title: '💞 وضعیت رابطه',
      rows: [
        { label: '📅 زندگی مشترک', value: `${fa(view.daysMarried)} روز` },
        { label: '💍 مهریه', value: describeMahr(view.mahr) },
      ],
      lines: [
        view.warmth !== null
          ? `🔥 گرما: ${barWithPercent(view.warmth)} — *${view.warmthLabelText ?? ''}*`
          : '',
        ...(view.bonusMultiplier !== null && view.bonusMultiplier < 1
          ? [`⚠️ ضریب پاداش روزانه فعلاً ${fa(Math.round(view.bonusMultiplier * 100))}٪ است.`]
          : []),
      ],
    },
    {
      title: '🏠 خانه و دارایی',
      rows: [
        { label: 'خانهٔ تو', value: view.myHome ?? 'ندارد' },
        { label: 'خانهٔ همسر', value: view.spouseHome ?? 'ندارد' },
        { label: 'خانهٔ مشترک', value: view.sharedHome ?? 'هنوز نه' },
        { label: 'موجودی تو', value: money(view.myBalance) },
        {
          label: 'موجودی همسر',
          value: view.spouseBalance?.visible ? money(view.spouseBalance.amount) : '🔒 خصوصی',
        },
        {
          label: 'دارایی خانوار',
          value: view.householdBalance !== null ? money(view.householdBalance) : '🔒 خصوصی',
        },
      ],
    },
    {
      lines: [
        view.activityDoneToday
          ? '🕯️ وقتِ مشترکِ امروز انجام شده است.'
          : `🕯️ «وقتِ مشترک» امروز مانده — ${money(view.activityCost)} هزینه دارد، خستگیِ هر دو را کم و رابطه را گرم می‌کند.`,
      ],
    },
  ]

  return panel({
    icon: '👨‍👩‍👧',
    title: 'جزئیات خانواده',
    sections,
    footer:
      '💡 اطلاعات همسر از پروفایل واقعی او خوانده می‌شود؛ اگر پروفایلش خصوصی باشد بعضی موارد پنهان است.',
  })
}

// ──────────────────────────────────────────────────────────────────────────────
//  🐾 حیوان خانگی
// ──────────────────────────────────────────────────────────────────────────────

export interface PetPanelView {
  kindName: string
  emoji: string
  name: string
  hunger: number
  mood: number
  statusLabel: string
  statusHint: string
  isSick: boolean
  daysTogether: number
  fedToday: boolean
  playedToday: boolean
  bonusReady: boolean
  bonusCheckedToday: boolean
  giftReceivedToday: boolean
  feedCost: number
  bondPoints: number
  bondTitle: string
  bondEmoji: string
  bondNextLevelAt: number | null
  bondProgressPercent: number
  bonusMultiplierPercent: number
  nextStepHint: string
}

export function renderPetPanel(view: PetPanelView | null): string {
  if (!view) {
    return panel({
      icon: '🐾',
      title: 'حیوان خانگی',
      sections: [
        {
          lines: [
            'هنوز هم‌سایه‌ای نداری.',
            '',
            'یک حیوان خانگی، روزی یک هدیهٔ نقدی برایت می‌آورد و',
            'حالِ روزهایت را عوض می‌کند — به شرطِ رسیدگی.',
          ],
        },
        {
          title: '📋 چطور شروع می‌شود؟',
          lines: [
            '۱. از «فروشگاه حیوان» یک نژاد انتخاب کن و قیمتش را ببین.',
            '۲. خرید را تأیید کن و برایش یک نام بگذار.',
            '۳. هر روز بهش غذا بده؛ اگر ۲ روز بی‌غذا بماند، بیمار می‌شود.',
          ],
        },
      ],
      footer: '💡 هر بازیکن فقط *یک* حیوان می‌تواند داشته باشد.',
    })
  }

  const todayLines = [
    view.fedToday ? '✅ امروز غذا خورده است.' : `🍽️ امروز گرسنه است (هزینهٔ وعده: *${money(view.feedCost)}*).`,
    view.playedToday ? '✅ امروز با او بازی کرده‌ای.' : '🎾 امروز وقتِ بازی با او مانده (رایگان).',
    view.giftReceivedToday
      ? '🎁 هدیهٔ امروز را گرفته‌ای.'
      : view.bonusCheckedToday
        ? '🎁 امروز شانست را امتحان کردی و هدیه‌ای نیامد؛ فردا دوباره سر بزن.'
        : view.bonusReady
          ? `🎁 حالش خوب است — هدیهٔ امروز را بگیر (ضریب پیوند: ٪${fa(view.bonusMultiplierPercent)}).`
          : '🎁 برای هدیه، حالش باید بالای ۶۰٪ باشد.',
  ]

  const bondLines = [
    `پیوند: ${barWithPercent(view.bondProgressPercent, 8)} — *${view.bondEmoji} ${view.bondTitle}* (سطح ${fa(view.bondPoints)} امتیاز مراقبت)`,
    view.bondNextLevelAt === null
      ? '💞 به بالاترین سطحِ پیوند رسیده‌اید؛ هدیه‌اش ٪۲۰ بیشتر است.'
      : `💡 ${fa(view.bondNextLevelAt - view.bondPoints)} امتیازِ مراقبت تا سطحِ بعدی — هر روز غذا و بازی، یک پله نزدیک‌تر.`,
  ]

  const sections: Parameters<typeof panel>[0]['sections'] = [
    {
      title: '📊 وضعیت',
      rows: [
        { label: '🐾 نژاد', value: view.kindName },
        { label: '🍽️ گرسنگی', value: `${bar(view.hunger, 8)} ${fa(view.hunger)}٪` },
        { label: '💖 حال', value: `${view.statusLabel}  ${bar(view.mood, 8)} ${fa(view.mood)}٪` },
        { label: '📅 با هم', value: `${fa(view.daysTogether)} روز` },
      ],
      lines: [view.statusHint],
    },
    {
      title: '🗓️ امروز',
      lines: todayLines,
    },
    {
      title: '💞 پیوند',
      lines: bondLines,
    },
  ]

  if (view.isSick) {
    sections.push({
      title: '⚠️ نیازِ فوری',
      lines: [
        'حالش بد است و تا درمان، هدیه‌ای نمی‌دهد و بازی هم نمی‌کند.',
        'یک وعده غذا خوابش را راحت می‌کند: «🍽️ غذا دادن».',
      ],
    })
  }

  return panel({
    icon: view.emoji,
    title: view.name,
    sections,
    footer: view.nextStepHint,
  })
}

/**
 * فروشگاه حیوان: نژادها با قیمت، ویژگی و توانِ خرید بازیکن.
 * هیچ وعدهٔ سرپرستی‌ای بدون دیدنِ قیمت و موجودی انجام نمی‌شود.
 */
export function renderPetShopPanel(view: {
  hasPet: boolean
  petName: string | null
  balance: number
  feedCostPerDay: number
  sickAfterDays: number
  kinds: Array<{
    key: string
    name: string
    emoji: string
    price: number
    bonusMin: number
    bonusMax: number
    trait: string
    affordable: boolean
    shortfall: number
  }>
}): string {
  if (view.hasPet) {
    return panel({
      icon: '🐾',
      title: 'فروشگاه حیوان',
      sections: [
        {
          lines: [
            `تو همین حالا از *${view.petName ?? 'حیوان خانگی'}* نگهداری می‌کنی.`,
            '',
            'هر بازیکن فقط یک حیوان می‌تواند داشته باشد؛',
            'برای دیدنش به پنل «حیوان» برگرد.',
          ],
        },
      ],
      footer: '💡 نگهداریِ خوب، هدیهٔ روزانهٔ بیشتری می‌سازد.',
    })
  }

  const kindLines = view.kinds.flatMap((kind) => [
    `${kind.emoji} *${kind.name}* — ${money(kind.price)}  ${kind.affordable ? '✅' : '💸'}`,
    `   _${kind.trait}_`,
    `   🎁 هدیهٔ روزانه: ${money(kind.bonusMin)} تا ${money(kind.bonusMax)}`,
    ...(kind.affordable
      ? []
      : [`   ⚠️ ${money(kind.shortfall)} کم داری تا این نژاد را سرپرستی کنی.`]),
    '',
  ])

  return panel({
    icon: '🐾',
    title: 'فروشگاه حیوان',
    sections: [
      {
        title: '💰 توانِ خرید تو',
        rows: [
          { label: '💵 موجودی کیف', value: money(view.balance) },
          { label: '🍽️ هزینهٔ روزانه', value: `${money(view.feedCostPerDay)} برای هر وعده` },
        ],
        lines: [`⚠️ اگر ${fa(view.sickAfterDays)} روز به حیوان غذا نرسد، بیمار می‌شود.`],
      },
      { title: '🐾 نژادها', lines: kindLines },
    ],
    footer: '👇 یک نژاد را انتخاب کن تا صفحهٔ تأیید را ببینی.\n🎁 هدیهٔ روزانه یک تلاش در روز دارد و به حالِ حیوان بستگی دارد.',
  })
}

/** صفحهٔ بازبینیِ سرپرستی: چه می‌گیری، چقدر می‌دهی، کیف پولت چقدر می‌شود. */
export function renderPetReviewPanel(view: {
  kindName: string
  emoji: string
  trait: string
  price: number
  bonusMin: number
  bonusMax: number
  balance: number
  balanceAfter: number
  hasPet: boolean
  petName: string | null
}): string {
  if (view.hasPet) {
    return panel({
      icon: '⚠️',
      title: 'سرپرستی ممکن نیست',
      sections: [
        {
          lines: [
            `تو از *${view.petName ?? 'حیوان خانگی'}* نگهداری می‌کنی و هر بازیکن`,
            'فقط یک حیوان می‌تواند داشته باشد.',
          ],
        },
      ],
      footer: '💡 از پنل «حیوان» می‌توانی از او مراقبت کنی.'
    })
  }

  const affordable = view.balance >= view.price
  const shortfall = Math.max(0, view.price - view.balance)

  return panel({
    icon: view.emoji,
    title: `تأییدِ سرپرستیِ ${view.kindName}`,
    sections: [
      {
        title: '🐾 چه چیزی می‌گیری؟',
        rows: [
          { label: '🏷️ نژاد', value: `${view.emoji} *${view.kindName}*` },
          { label: '🎁 هدیهٔ روزانه', value: `${money(view.bonusMin)} تا ${money(view.bonusMax)}` },
        ],
        lines: [`_${view.trait}_`],
      },
      {
        title: '🧾 حساب‌وکتاب',
        rows: [
          { label: '💵 هزینهٔ سرپرستی', value: `*${money(view.price)}*` },
          { label: '💰 موجودی فعلی', value: money(view.balance) },
          {
            label: affordable ? '✅ موجودی پس از خرید' : '⚠️ کمبودِ موجودی',
            value: affordable ? `*${money(view.balanceAfter)}*` : `*${money(shortfall)}*`,
          },
        ],
      },
      {
        lines: affordable
          ? [
              'با تأیید، نامِ حیوانت را می‌پرسیم و سرپرستی همان لحظه ثبت می‌شود.',
              'هزینه فقط پس از ثبتِ موفقِ نام کسر می‌شود؛ اگر چیزی درست پیش نرود، هیچ پولی از کیفت نمی‌رود.',
            ]
          : [
              'موجودیِ کیفت برای این نژاد کافی نیست؛ چیزی کسر نمی‌شود.',
              'می‌توانی نژادِ ارزان‌تری انتخاب کنی یا اول درآمد بسازی.',
            ],
      },
    ],
    footer: affordable
      ? '👇 اگر مطمئنی، «تأیید و انتخاب نام» را بزن.'
      : '👇 برای دیدنِ نژادهای دیگر به فروشگاه برگرد.'
  })
}

/** صفحهٔ موفقیتِ سرپرستی: نام، نژاد، پرداختی و سه قدمِ اول. */
export function renderPetAdoptedPanel(view: {
  name: string
  kindName: string
  emoji: string
  price: number
  balanceAfter: number
  feedCost: number
}): string {
  return panel({
    icon: view.emoji,
    title: `${view.name} به زندگی‌ات آمد`,
    sections: [
      {
        title: '🎉 سرپرستی ثبت شد',
        rows: [
          { label: '🐾 هم‌سایهٔ تازه', value: `${view.emoji} *${view.name}*` },
          { label: '🏷️ نژاد', value: view.kindName },
          { label: '💵 هزینهٔ سرپرستی', value: money(view.price) },
          { label: '💰 موجودی باقی‌مانده', value: `*${money(view.balanceAfter)}*` },
        ],
      },
      {
        title: '🚀 سه قدمِ اول',
        lines: [
          `۱. امروز بهش غذا بده (${money(view.feedCost)}) تا حالش خوب شروع شود.`,
          '۲. با او بازی کن؛ پیوندتان هر روز عمیق‌تر می‌شود.',
          '۳. هر روز هدیه‌اش را بگیر — با پیوندِ بالاتر، هدیه بیشتر می‌شود.',
        ],
      },
    ],
    footer: '💡 اگر ۲ روز بی‌غذا بماند بیمار می‌شود؛ هر روز سر بزن.',
  })
}

// ──────────────────────────────────────────────────────────────────────────────
//  🔨 حراجی هفتگی
// ──────────────────────────────────────────────────────────────────────────────

export function renderAuctionPanel(view: {
  itemName: string
  emoji: string
  startingBid: number
  currentBid: number
  minNextBid: number
  bidsCount: number
  leaderName: string | null
  isClosed: boolean
}): string {
  if (view.isClosed) {
    return panel({
      icon: '🏁',
      title: 'حراجیِ این هفته',
      sections: [
        {
          lines: [
            'زمانِ حراجی تمام شد.',
            '',
            'هفتهٔ بعد آیتمِ تازه‌ای می‌آید — شانسِ دوباره داری.',
          ],
        },
      ],
    })
  }

  return panel({
    icon: view.emoji,
    title: view.itemName,
    sections: [
      {
        title: '🔨 وضعیتِ مزایده',
        rows: [
          { label: 'قیمتِ پایه', value: money(view.startingBid) },
          { label: '💰 بالاترین پیشنهاد', value: `*${money(view.currentBid)}*` },
          { label: '👤 پیشتاز', value: view.leaderName ?? 'هنوز کسی' },
          { label: '🔢 تعدادِ پیشنهادها', value: `${fa(view.bidsCount)} بار` },
        ],
      },
      { lines: [`👇 حداقلِ پیشنهادِ بعدی: *${money(view.minNextBid)}*`] },
    ],
    footer: '💡 مبلغِ پیشنهادِت قفل می‌شود و با پیشنهادِ بالاترِ دیگری برمی‌گردد.',
  })
}

// ──────────────────────────────────────────────────────────────────────────────
//  💪 باشگاه ورزشی
// ──────────────────────────────────────────────────────────────────────────────

export function renderGymPanel(view: {
  isActive: boolean
  expiresAt: Date | null
  daysLeft: number
  weeklyFee: number
  maxHealth: number
  baseMaxHealth: number
}): string {
  return panel({
    icon: '💪',
    title: 'باشگاه ورزشی',
    sections: [
      {
        title: '🛡️ عضویت',
        rows: [
          { label: 'وضعیت', value: view.isActive ? `✅ فعال تا *${faDate(view.expiresAt)}*` : '— غیرفعال' },
          {
            label: '❤️ سقف سلامت',
            value: `${fa(view.maxHealth)} از ${fa(view.baseMaxHealth)} پایه  ${barWithPercent(Math.round((view.maxHealth / 120) * 100), 6)}`,
          },
          { label: '💵 حق اشتراک هفتگی', value: money(view.weeklyFee) },
        ],
      },
      {
        lines: [
          view.isActive
            ? `⏳ ${fa(view.daysLeft)} روزِ دیگر عضویتت به پایان می‌رسد.`
            : 'با عضویتِ فعال، سقف سلامت از ۱۰۰ به *۱۲۰* می‌رسد.',
        ],
      },
    ],
    footer: '💡 سلامتِ بیشتر = شیفت‌های بیشتری پیش از نیاز به درمانگاه.',
  })
}

// ──────────────────────────────────────────────────────────────────────────────
//  🤝 قرض بازیکنی
// ──────────────────────────────────────────────────────────────────────────────

export function renderLoansPanel(view: {
  incomingRequests: Array<{ id: string; borrowerName: string; principal: number; totalRepay: number }>
  active: Array<{
    id: string
    counterpartyName: string
    role: 'lender' | 'borrower'
    principal: number
    totalRepay: number
    dueAt: Date | null
    isOverdue: boolean
  }>
  defaultsCount: number
  minPrincipal: number
  maxPrincipal: number
  feePercent: number
}): string {
  const sections: Parameters<typeof panel>[0]['sections'] = []

  if (view.incomingRequests.length > 0) {
    sections.push({
      title: '📨 درخواست‌های رسیده به تو',
      lines: view.incomingRequests.flatMap((r) => [
        `👤 *${r.borrowerName}* — ${money(r.principal)}`,
        `   بازپرداختِ انتظاری: ${money(r.totalRepay)}`,
        '',
      ]),
    })
  }

  if (view.active.length > 0) {
    sections.push({
      title: '📑 قرض‌های فعال',
      lines: view.active.flatMap((l) => [
        `${l.role === 'lender' ? '🏦 قرض داده‌ای به' : '💳 قرض گرفته‌ای از'} *${l.counterpartyName}*`,
        `   اصل: ${money(l.principal)}  ·  بازپرداخت: ${money(l.totalRepay)}`,
        l.dueAt ? `   ⏳ سررسید: ${faDate(l.dueAt)}` : '',
        l.isOverdue ? '   ⚠️ *از سررسید گذشته!*' : '',
        '',
      ].filter(Boolean) as string[]),
    })
  }

  if (sections.length === 0) {
    sections.push({
      lines: [
        'قرضِ فعالی بین تو و دیگران نیست.',
        '',
        'برای درخواست، روی پیامِ طرفِ مقابل *ریپلای* بزن و بنویس:',
        '`درخواست وام ۵۰۰۰۰۰`  — یا از دکمهٔ «درخواست قرض» داخل پنل.',
      ],
    })
  }

  const warning =
    view.defaultsCount > 0
      ? `⚠️ ${fa(view.defaultsCount)} مورد نکول در سابقه‌ات ثبت شده.`
      : '✅ سابقهٔ پرداختت تمیز است.'

  return panel({
    icon: '🤝',
    title: 'قرضِ بازیکنان',
    sections,
    footer: `${warning}\n💡 کارمزد قرارداد ٪${fa(view.feePercent)} است؛ محدوده: ${money(view.minPrincipal)} تا ${money(view.maxPrincipal)}.`,
  })
}

// ──────────────────────────────────────────────────────────────────────────────
//  🏹 چالش جمعی منطقه
// ──────────────────────────────────────────────────────────────────────────────

export function renderChallengePanel(view: {
  goalTitle: string
  emoji: string
  targetValue: number
  currentValue: number
  progressPercent: number
  isCompleted: boolean
  myContributed: number
  rewardPerPlayer: number
  unit: string
}): string {
  return panel({
    icon: view.emoji,
    title: 'چالشِ هفتگیِ منطقه',
    sections: [
      {
        title: view.goalTitle,
        lines: [
          barWithPercent(view.progressPercent, 10),
          `${fa(view.currentValue)} از ${fa(view.targetValue)} ${view.unit}`,
        ],
      },
      {
        title: '🎯 مشارکتِ تو',
        rows: [
          { label: 'امتیازِ من', value: `${fa(view.myContributed)} ${view.unit}` },
          { label: '🎁 پاداشِ تکمیل', value: money(view.rewardPerPlayer) },
        ],
      },
      {
        lines: [
          view.isCompleted
            ? '🎉 چالش کامل شد! پاداشت را بگیر.'
            : 'با کار، معامله یا سفر، امتیازِ جمعیِ منطقه‌ات را جلو ببر.',
        ],
      },
    ],
    footer: '💡 اگر در چالش مشارکت داشته باشی، پس از تکمیل پاداش می‌گیری.',
  })
}

// ──────────────────────────────────────────────────────────────────────────────
//  🏛️ سیاستِ شهردار
// ──────────────────────────────────────────────────────────────────────────────

export function renderPolicyPanel(
  policies: Array<{ key: string; title: string; emoji: string; description: string }>,
  activeKey: string | null,
  isMayor: boolean,
  /** یک خط دربارهٔ شهردارِ فعال و اعتبار دورهٔ او (تا «اختیار موقت» شفاف باشد). */
  mayorLine?: string,
): string {
  const lines = policies.map((p) => {
    const marker = p.key === activeKey ? '✅' : '▫️'
    return `${marker} ${p.emoji} *${p.title}*\n   _${p.description}_`
  })

  return panel({
    icon: '🏛️',
    title: 'سیاستِ شهردار',
    sections: [
      { lines },
      {
        lines: [
          isMayor
            ? 'تو شهردار هستی؛ هفته‌ای یک بار می‌توانی سیاست را عوض کنی.'
            : 'فقط شهردارِ منتخب می‌تواند سیاستِ منطقه را تغییر دهد.',
          ...(mayorLine ? [mayorLine] : []),
        ],
      },
    ],
    footer: '💡 سیاستِ فعال روی تخفیف‌ها و ریکاوریِ همهٔ ساکنان اثر می‌گذارد.',
  })
}

// ──────────────────────────────────────────────────────────────────────────────
//  🏬 شعب کسب‌وکار
// ──────────────────────────────────────────────────────────────────────────────

export function renderBranchPanel(view: {
  branches: Array<{
    id: string
    businessName: string
    regionTitle: string
    pendingIncome: number
    pendingDays: number
    openedAt: Date
  }>
  businesses: Array<{ id: string; name: string }>
  setupCost: number
  incomePerDay: number
}): string {
  const sections: Parameters<typeof panel>[0]['sections'] = []

  if (view.branches.length > 0) {
    sections.push({
      title: '🏬 شعبه‌های من',
      lines: view.branches.flatMap((b) => [
        `🏢 *${b.businessName}* — ${b.regionTitle}`,
        b.pendingIncome > 0
          ? `   💰 در انتظارِ برداشت: *${money(b.pendingIncome)}* (${fa(b.pendingDays)} روز)`
          : '   💤 درآمدِ تازه‌ای انباشته نشده',
        '',
      ]),
    })
  } else {
    sections.push({
      lines: [
        'هنوز شعبه‌ای نداری.',
        '',
        `راه‌اندازیِ هر شعبه *${money(view.setupCost)}* هزینه دارد و روزی *${money(view.incomePerDay)}* درآمدِ غیرفعال می‌سازد.`,
      ],
    })
  }

  return panel({
    icon: '🏬',
    title: 'شعبِ کسب‌وکار',
    sections,
    footer: '💡 انباشتِ درآمدِ هر شعبه تا یک هفته ذخیره می‌شود.',
  })
}

// ──────────────────────────────────────────────────────────────────────────────
//  📣 آگهی همگانی
// ──────────────────────────────────────────────────────────────────────────────

export function renderAdsPanel(stats: { fee: number; maxLength: number }): string {
  return panel({
    icon: '📣',
    title: 'آگهیِ همگانی',
    sections: [
      {
        lines: [
          'پیامِ خودت را به همهٔ ساکنانِ منطقه برسان!',
          '',
          `💵 هزینهٔ انتشار: *${money(stats.fee)}*`,
          `✍️ حداکثر طول: ${fa(stats.maxLength)} حرف`,
          '🕐 روزی یک آگهی',
        ],
      },
    ],
    footer: '💡 آگهی در جریانِ خبرهای منطقه منتشر می‌شود.',
  })
}

// ──────────────────────────────────────────────────────────────────────────────
//  📊 گزارشِ هفتگیِ مالی
// ──────────────────────────────────────────────────────────────────────────────

export function renderReportPanel(report: {
  thisWeek: {
    incomeTotal: number
    expenseTotal: number
    net: number
    topExpenseLabel: string
    topExpenseAmount: number
  }
  lastWeek: { incomeTotal: number; expenseTotal: number; net: number }
  trendPercent: number
}): string {
  const trendLine =
    report.trendPercent > 0
      ? `📈 خرجِ این هفته ${fa(report.trendPercent)}٪ بیشتر از هفتهٔ قبل`
      : report.trendPercent < 0
        ? `📉 خرجِ این هفته ${fa(Math.abs(report.trendPercent))}٪ کمتر از هفتهٔ قبل`
        : '➖ خرجت مثل هفتهٔ قبل است'

  return panel({
    icon: '📊',
    title: 'گزارشِ هفتگیِ مالی',
    sections: [
      {
        title: '📅 این هفته',
        rows: [
          { label: '🟢 درآمد', value: money(report.thisWeek.incomeTotal) },
          { label: '🔴 خرج', value: money(report.thisWeek.expenseTotal) },
          {
            label: report.thisWeek.net >= 0 ? '💼 مانده' : '⚠️ کسری',
            value: `*${money(Math.abs(report.thisWeek.net))}*`,
          },
          { label: '📌 بزرگ‌ترین خرج', value: report.thisWeek.topExpenseLabel },
        ],
      },
      {
        title: '📆 هفتهٔ قبل',
        rows: [
          { label: '🟢 درآمد', value: money(report.lastWeek.incomeTotal) },
          { label: '🔴 خرج', value: money(report.lastWeek.expenseTotal) },
        ],
        lines: [trendLine],
      },
    ],
    footer: '💡 گزارش را می‌توانی به مرکز اعلان‌ها هم بفرستی.',
  })
}

// ──────────────────────────────────────────────────────────────────────────────
//  🆘 پشتیبانی و گزارش مشکل
// ──────────────────────────────────────────────────────────────────────────────

/**
 * پنل پشتیبانی بازیکن: راهنمای ثبت گزارش + گزارش‌های خودش با پاسخ‌ها.
 *
 * چرا این پنل لازم بود؟ پیش‌تر بازیکنی که به ایراد برمی‌خورد هیچ مسیر رسمی
 * نداشت؛ اگر هم در گروه می‌گفت، چیزی ثبت نمی‌شد و ادمین بعداً چیزی برای
 * پیگیری نداشت. متنِ داخل گزارش‌ها با `plainInput` پاک‌سازی شده و برای
 * مارک‌داون بی‌خطر است.
 */
export function renderSupportPanel(view: {
  reports: Array<{
    id: string
    categoryLabel: string
    statusLabel: string
    body: string
    answer: string | null
    createdAt: Date
    answeredAt: Date | null
  }>
  openCount: number
  openCap: number
}): string {
  const sections: Parameters<typeof panel>[0]['sections'] = [
    {
      title: '📝 چه چیزی را اینجا بگویم؟',
      lines: [
        '• دکمهٔ بی‌اثر، خطای ناگهانی یا جریانی که نصفه ماند',
        '• کسر یا واریز اشتباه پول و تراکنش گم‌شده',
        '• رفتار نامناسب یک بازیکن دیگر',
        '',
        'در متن گزارش، جزئیات و زمان وقوع را بنویس؛ همین‌قدر که یادت هست کافی است.',
      ],
    },
  ]

  if (view.reports.length === 0) {
    sections.push({
      title: '📨 گزارش‌های من',
      lines: ['هنوز گزارشی ثبت نکرده‌ای.'],
    })
  } else {
    sections.push({
      title: `📨 گزارش‌های من (${fa(view.reports.length)})`,
      lines: view.reports.flatMap((report, index) => {
        const lines = [
          `• *${report.categoryLabel}* · ${report.statusLabel} · ${faDate(report.createdAt)}`,
          `   «${report.body}»`,
          report.answer
            ? `   ↳ پاسخ تیم مدیریت${report.answeredAt ? ` (${faDate(report.answeredAt)})` : ''}: ${report.answer}`
            : '   ↳ هنوز پاسخی نگرفته است.'
        ]
        if (index < view.reports.length - 1) {
          lines.push('')
        }
        return lines
      }),
    })
  }

  const full = view.openCount >= view.openCap

  return panel({
    icon: '🆘',
    title: 'پشتیبانی و گزارش مشکل',
    sections,
    footer: full
      ? `💡 همین حالا ${fa(view.openCount)} گزارشِ بی‌پاسخ داری؛ تا رسیدگی‌شان گزارش تازه ثبت نمی‌شود.`
      : '💡 گزارش فقط برای تیم مدیریت ثبت می‌شود؛ در گروه نمایش داده نمی‌شود.',
  })
}

/** تأیید ثبت گزارش — بعد از ذخیره، نه پیش از آن. */
export function renderSupportSubmitted(view: {
  categoryLabel: string
  body: string
  openCount: number
  openCap: number
}): string {
  return panel({
    icon: '✅',
    title: 'گزارشت ثبت شد',
    sections: [
      {
        rows: [
          { label: '🏷️ دسته', value: view.categoryLabel },
          { label: '📨 گزارش‌های بی‌پاسخ', value: `${fa(view.openCount)} از ${fa(view.openCap)}` },
        ],
      },
      { lines: [`«${view.body}»`] },
    ],
    footer: '💡 پاسخ را همین‌جا و در «اعلان‌ها» می‌بینی؛ لازم نیست دوباره بپرسی.',
  })
}

// ──────────────────────────────────────────────────────────────────────────────
//  📜 وصیت و انتقال دارایی
// ──────────────────────────────────────────────────────────────────────────────

/**
 * پنل وصیت.
 *
 * قاعدهٔ نمایش: عددی که این‌جا نوشته می‌شود **همان** عددی است که لحظهٔ مرگ به
 * وارث می‌رسد (`InheritanceService.estateSnapshot`). پس بازیکن هرگز چیزی
 * نمی‌بیند که ارث نمی‌برد؛ تفاوت فقط «بدهی‌ها کم می‌شوند» است که همان‌جا هم
 * گفته می‌شود.
 */
export function renderWillPanel(view: WillView): string {
  const sections: Parameters<typeof panel>[0]['sections'] = []

  if (view.isDead) {
    sections.push({
      lines: [
        'این شخصیت از دنیا رفته و وصیتش قفل شده است.',
        'دارایی‌ها طبق آخرین وصیتِ ثبت‌شده منتقل می‌شود.',
        'برای شروع دوباره /start را بفرست.'
      ]
    })
  } else if (view.hasWill && !view.heirInvalidReason) {
    sections.push({
      title: '📜 وصیتِ ثبت‌شده',
      rows: [
        { label: '👤 وارث', value: `*${view.heirName}*` },
        ...(view.heirUsername ? [{ label: '🆔 نام‌کاربری', value: `@${view.heirUsername}` }] : []),
        ...(view.updatedAt ? [{ label: '🕐 آخرین تغییر', value: faDate(view.updatedAt) }] : [])
      ]
    })
    if (view.note) {
      sections.push({ title: '✍️ یادداشت تو', lines: [view.note] })
    }
  } else if (view.heirInvalidReason) {
    sections.push({
      title: '⚠️ وصیتت اجرا نمی‌شود',
      lines: [
        view.heirInvalidReason,
        'تا وارثِ معتبر انتخاب نکنی، دارایی‌ها بی‌صاحب می‌مانند.'
      ]
    })
  } else {
    sections.push({
      lines: [
        'هنوز وارثی انتخاب نکرده‌ای.',
        ...WILL_PANEL_COPY.rules.slice(0, 2).map((line) => `• ${line}`)
      ]
    })
  }

  const estate = view.estate
  sections.push({
    title: '💼 دارایی‌ات',
    rows: [
      { label: '💰 کیف پول', value: money(estate.wallet) },
      { label: '🏦 حساب بانکی', value: money(estate.bank) },
      { label: '🏠 ملک', value: fa(estate.properties) },
      { label: '🏢 کسب‌وکار', value: fa(estate.businesses) },
      { label: '📦 اقلام انبار', value: fa(estate.inventory) },
      ...(estate.deposits > 0 ? [{ label: '🗓️ سپردهٔ فعال', value: fa(estate.deposits) }] : [])
    ]
  })

  const debts = estate.loanDebt + estate.playerLoanDebt
  sections.push({
    title: '💳 تعهدها',
    rows: [
      { label: '🏦 بدهی بانکی', value: money(estate.loanDebt) },
      { label: '🤝 بدهی به بازیکنان', value: money(estate.playerLoanDebt) },
      ...(estate.playerLoanReceivable > 0
        ? [{ label: '📥 طلب از بازیکنان', value: money(estate.playerLoanReceivable) }]
        : [])
    ],
    lines:
      debts > 0
        ? ['بدهی‌ها اول از پول نقد تسویه می‌شوند؛ باقی به وارث می‌رسد.']
        : []
  })

  if (view.inherited) {
    const c = view.inherited
    sections.push({
      title: '📂 دارایی‌ای که به تو رسیده',
      lines: [
        `💰 نقد و بانکی: ${money(c.cashTransferred)}`,
        `🏠 ملک: ${fa(c.propertiesCount)}  ·  🏢 کسب‌وکار: ${fa(c.businessesCount)}`,
        c.debtSettled > 0 ? `💳 بدهی تسویه‌شده: ${money(c.debtSettled)}` : '',
        c.debtUnpaid > 0 ? `⚠️ بدهی پوشش‌داده‌نشده: ${money(c.debtUnpaid)}` : ''
      ].filter(Boolean) as string[]
    })
  }

  return panel({
    icon: '📜',
    title: 'وصیت و انتقال دارایی',
    sections,
    footer: view.isDead
      ? undefined
      : 'همه‌چیز خودکار و یک‌بار منتقل می‌شود؛ تا زنده‌ای می‌توانی وارث را عوض کنی.'
  })
}

/** پنل راهنمای قوانین وصیت (از دکمهٔ «قوانین»). */
export function renderWillRulesPanel(): string {
  return panel({
    icon: '⚖️',
    title: 'قوانین وصیت',
    sections: [
      { lines: [WILL_PANEL_COPY.intro] },
      { title: 'قواعد', lines: WILL_PANEL_COPY.rules.map((line) => `• ${line}`) },
      {
        title: 'چه چیزی منتقل می‌شود؟',
        lines: [
          '• پول کیف پول و موجودی حساب بانکی',
          '• ملک‌ها و خانه‌های اجاره‌داده‌شده (با مستأجرشان)',
          '• کسب‌وکارها همراه کارکنان و قراردادهایشان',
          '• سپرده، سهام، انبار، زمین کشت و حیوان خانگی',
          '• طلب‌هایی که از بازیکنان داری'
        ]
      }
    ],
    footer: 'بدهی‌ها پیش از تقسیم، از دارایی نقدی تسویه می‌شوند.'
  })
}

// ──────────────────────────────────────────────────────────────────────────────
//  🌱 زندگی تازه
// ──────────────────────────────────────────────────────────────────────────────

export interface RebirthPanelView {
  /** آیا همین حالا می‌تواند زندگی تازه را شروع کند؟ */
  eligible: boolean
  /** جملهٔ انسانیِ «چرا نه». */
  reason: string | null
  /** چندمین زندگی از این هم شروع می‌شود. */
  nextLifeNumber: number
  /** داراییِ بی‌وارثی که به صندوق منطقه می‌رسد. */
  residualEstate: number
  /** نام منطقه‌ای که دارایی به آن می‌رسد (اگر معلوم باشد). */
  regionTitle: string | null
}

/**
 * پنل «زندگی تازه» — تنها راهِ ادامهٔ بازی برای شخصیتِ فوت‌شده.
 *
 * چرا این پنل لازم است؟ پیام مرگ می‌گفت «با /start یک شخصیت تازه بساز» ولی
 * این کار ممکن نبود: حساب هر بازیکن یک ردیفِ یکتا دارد. این پنل همان وعده را
 * واقعی می‌کند و صریح می‌گوید چه چیزی به زندگیِ بعدی می‌رسد و چه چیزی نه —
 * بی‌این صراحت، بازیکن نمی‌فهمد چرا مهارت‌ها و خانه‌اش صفر و خالی شروع می‌شوند.
 */
export function renderRebirthPanel(view: RebirthPanelView): string {
  if (!view.eligible) {
    return panel({
      icon: '🌱',
      title: 'زندگی تازه',
      sections: [
        {
          lines: [view.reason ?? 'زندگی تازه هنوز ممکن نیست.']
        },
        {
          title: '📋 چه چیزی در انتظار است؟',
          lines: [
            'بعد از تسویهٔ امور، می‌توانی شخصیت تازه‌ای بسازی:',
            'نام و جنسیتِ تازه، سلامت کامل و همان سرمایهٔ اولیهٔ روز اول.',
            'شهر و منطقه‌ات همان می‌ماند — فقط شخصیت عوض می‌شود.'
          ]
        }
      ],
      footer: '💡 سابقهٔ مالی، پرونده‌های گذشته و داراییِ رسیده به وارث همه ثبت می‌مانند.'
    })
  }

  const estateLines =
    view.residualEstate > 0
      ? [
          `💰 دارایی بی‌وارثِ باقی‌مانده‌ات (${money(view.residualEstate)}) به ${
            view.regionTitle ? `صندوق «${view.regionTitle}»` : 'صندوق منطقه‌ات'
          } می‌رسد.`,
          'عمداً به زندگیِ بعدی منتقل نمی‌شود؛ وگرنه بی‌وصیتی سودآور می‌شد.'
        ]
      : []

  return panel({
    icon: '🌱',
    title: 'زندگی تازه',
    sections: [
      {
        lines: [
          `این ${fa(view.nextLifeNumber)}‌مین زندگی توست.`,
          'شخصیتِ تازه از صفر شروع می‌کند، اما دنیایی که ساخته‌ای سرِ جایش می‌ماند.'
        ]
      },
      {
        title: '✅ چه چیزی با تو می‌آید؟',
        lines: [
          '🏙️ منطقه و گروهت — لازم نیست دوباره جا باز کنی',
          `💰 سرمایهٔ اولیه (${money(400_000)}) برای شروع دوباره`,
          '🩺 سلامت کامل و بدنی بی‌خستگی',
          '📜 سابقهٔ مالی و پرونده‌های گذشته (برای شفافیت، نه برای استفاده)'
        ]
      },
      {
        title: '🔄 چه چیزی از نو ساخته می‌شود؟',
        lines: [
          '• مهارت‌ها، تحصیل و سابقهٔ کاری',
          '• خانه، کسب‌وکار، سپرده، سهام و انبار',
          '• روابط خانوادگی',
          '• داراییِ خودت که طبق وصیت به وارث رسیده است'
        ]
      },
      ...(estateLines.length > 0 ? [{ title: '🏛️ دارایی بی‌وارث', lines: estateLines }] : [])
    ],
    footer: '💡 این کار برگشت‌پذیر نیست؛ مطمئن شو می‌خواهی زندگی تازه را شروع کنی.'
  })
}
