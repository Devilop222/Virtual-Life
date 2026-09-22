import { PrismaClient } from '@prisma/client'
import { NotFoundError } from '../../utils/classes/errors'
import { effectiveAge, daysToNextBirthday, playedYears } from '../lifecycle/game-calendar'
import { gameDaysSince } from '../../utils/game-time'

/** حالت هر شاخص آماری. */
export type StatState =
  | 'unset' // هنوز ثبت نشده
  | 'zero' // صفر واقعی
  | 'starting' // مقدار اولیه
  | 'growing' // در حال رشد
  | 'high' // بالا
  | 'elite' // بسیار بالا
  | 'unranked' // واجد شرایط رتبه‌بندی نیست
  | 'ranked' // رتبه‌دار

export interface StatValue {
  label: string
  state: StatState
  /** متن آمادهٔ نمایش؛ هرگز عدد بی‌معنی نشان نمی‌دهد. */
  display: string
  raw: number | null
  hint?: string
}

export interface StatGroup {
  title: string
  items: StatValue[]
}

export interface PlayerStatistics {
  groups: StatGroup[]
  netWorth: number
  computedAt: Date
}

/** حداقل شرایط ورود به رتبه‌بندی هر معیار. */
const RANK_ELIGIBILITY = {
  wealth: { minNetWorth: 1_000_000 },
  education: { minDegreeRank: 2 },
  experience: { minExperience: 50 },
  assets: { minAssetValue: 1_000_000 }
} as const

const DEGREE_RANK: Record<string, number> = {
  DIPLOMA: 1,
  ASSOCIATE: 2,
  BACHELOR: 3,
  MASTER: 4,
  DOCTORATE: 5
}

const DEGREE_TITLES: Record<string, string> = {
  DIPLOMA: 'دیپلم',
  ASSOCIATE: 'کاردانی',
  BACHELOR: 'کارشناسی',
  MASTER: 'کارشناسی ارشد',
  DOCTORATE: 'دکتری'
}

/**
 * سرویس آمار بازیکن.
 *
 * هیچ شاخصی به‌صورت عدد خام نمایش داده نمی‌شود؛ هر مقدار یک State دارد
 * (ثبت‌نشده، صفر واقعی، در حال رشد، بدون رتبه، …) و متن مناسب همان State نمایش داده می‌شود.
 * تمام مقادیر از داده‌های واقعی محاسبه می‌شوند (بدون ذخیرهٔ تکراری).
 */
export class StatisticsService {
  constructor(private readonly db: PrismaClient) {}

  async getPlayerStatistics(telegramUserId: bigint): Promise<PlayerStatistics> {
    const player = await this.db.player.findUnique({
      where: { telegramUserId },
      select: {
        id: true,
        age: true,
        balance: true,
        health: true,
        fatigue: true,
        experience: true,
        currentDegree: true,
        graduationField: true,
        isEnrolled: true,
        startedAt: true,
        homeGroup: { select: { title: true, environmentLevel: true } },
        // شغل واقعی از نوبت‌های کاری خوانده می‌شود، نه از occupationId که هرگز نوشته نمی‌شود
        workSessions: {
          orderBy: [{ startedAt: 'desc' }],
          take: 1,
          select: { jobTitle: true, status: true }
        },
        employments: {
          where: { isActive: true },
          take: 1,
          select: { title: true }
        },
        ownedBusinesses: {
          where: { status: 'ACTIVE' },
          take: 1,
          select: { name: true }
        }
      }
    })
    if (!player) {
      throw new NotFoundError('Player not found')
    }

    const [
      bankAgg,
      properties,
      businesses,
      loanAgg,
      workSessionCount,
      workAgg,
      skillCount,
      incomeAgg,
      expenseAgg,
      inventoryRows,
      eventCount
    ] = await Promise.all([
      this.db.bankAccount.aggregate({
        where: { playerId: player.id },
        _sum: { balance: true }
      }),
      this.db.property.findMany({
        where: { ownerId: player.id },
        select: { baseAssetValue: true }
      }),
      this.db.business.findMany({
        where: { ownerId: player.id, status: 'ACTIVE' },
        select: { level: true, treasury: true }
      }),
      this.db.loan.aggregate({
        where: { playerId: player.id, status: 'ACTIVE' },
        _sum: { remainingAmount: true }
      }),
      this.db.workSession.count({ where: { playerId: player.id, status: 'COMPLETED' } }),
      this.db.workSession.aggregate({
        where: { playerId: player.id, status: 'COMPLETED' },
        _sum: { earnedMoney: true }
      }),
      this.db.playerSkill.count({ where: { playerId: player.id } }),
      this.db.financialTransaction.aggregate({
        where: { destinationPlayerId: player.id },
        _sum: { amount: true }
      }),
      this.db.financialTransaction.aggregate({
        where: { sourcePlayerId: player.id },
        _sum: { amount: true }
      }),
      this.db.playerInventory.findMany({
        where: { playerId: player.id, quantity: { gt: 0 } },
        select: { quantity: true, item: { select: { price: true, priceMultiplier: true } } }
      }),
      this.db.gameEvent.count({ where: { playerId: player.id } })
    ])

    const cash = Number(player.balance)
    const bank = Number(bankAgg._sum.balance ?? 0)
    const propertyValue = properties.reduce((acc, p) => acc + Number(p.baseAssetValue), 0)
    // ارزش شرکت = خزانه + ارزش سطح؛ خزانه فقط یک‌بار شمرده می‌شود (بدون Double Counting)
    const businessValue = businesses.reduce(
      (acc, b) => acc + Number(b.treasury) + b.level * 10_000_000,
      0
    )
    const inventoryValue = inventoryRows.reduce(
      (acc, row) =>
        acc +
        row.quantity *
          Math.max(1, Math.round(Number(row.item.price) * Number(row.item.priceMultiplier))),
      0
    )
    const assetValue = propertyValue + businessValue + inventoryValue
    const debt = Number(loanAgg._sum.remainingAmount ?? 0)
    const netWorth = cash + bank + assetValue - debt

    const totalIncome = Number(incomeAgg._sum.amount ?? 0)
    const totalExpense = Number(expenseAgg._sum.amount ?? 0)
    const totalSalary = Number(workAgg._sum.earnedMoney ?? 0)
    const degreeRank = DEGREE_RANK[player.currentDegree] ?? 1
    // روزهای *بازی* — همان تقویمی که سن و قراردادها با آن شمرده می‌شوند.
    const daysPlayed = gameDaysSince(player.startedAt)

    const age = effectiveAge(player.startedAt, player.age)
    const years = playedYears(player.startedAt)

    const groups: StatGroup[] = [
      {
        title: 'اطلاعات کلی',
        items: [
          this.plainStat('🎂 سن', age, 'سال'),
          {
            label: '🗓️ سال بعد',
            state: 'starting',
            display: `${daysToNextBirthday(player.startedAt).toLocaleString('fa-IR')} روز دیگر`,
            raw: daysToNextBirthday(player.startedAt)
          },
          {
            label: '📆 سال‌های زندگی',
            state: years > 0 ? 'growing' : 'starting',
            display:
              years > 0
                ? `${years.toLocaleString('fa-IR')} سال سپری شد`
                : 'تازه شروع کرده‌ای',
            raw: years
          },
          this.countStat('📅 سابقهٔ بازی', daysPlayed, 'روز', 'امروز شروع کرده‌ای'),
          this.plainStat('❤️ سلامت', player.health, 'درصد'),
          this.plainStat('⚡ خستگی', player.fatigue, 'درصد'),
          this.textStat('🏡 محل زندگی', player.homeGroup?.title ?? null, 'هنوز ثبت نشده')
        ]
      },
      {
        title: 'وضعیت اقتصادی',
        items: [
          this.moneyStat('💵 پول نقد', cash),
          this.moneyStat('💳 موجودی بانک', bank),
          this.moneyStat('🏠 ارزش املاک', propertyValue),
          this.moneyStat('🏢 ارزش کسب‌وکار', businessValue),
          this.moneyStat('🎒 ارزش انبار', inventoryValue),
          this.moneyStat('📑 بدهی', debt),
          this.netWorthStat(netWorth)
        ]
      },
      {
        title: 'جریان مالی',
        items: [
          this.moneyStat('🟢 کل درآمد', totalIncome),
          this.moneyStat('🔴 کل هزینه', totalExpense),
          this.balanceStat('⚖️ تراز مالی', totalIncome - totalExpense)
        ]
      },
      {
        title: 'وضعیت علمی',
        items: [
          this.textStat('🎓 مدرک', DEGREE_TITLES[player.currentDegree] ?? null, 'نامشخص'),
          this.textStat(
            '📚 رشته',
            player.graduationField ?? (player.isEnrolled ? 'در حال تحصیل' : null),
            'هنوز رشته‌ای ثبت نشده'
          ),
          this.rankEligibilityStat(
            '🏅 رتبهٔ علمی',
            degreeRank >= RANK_ELIGIBILITY.education.minDegreeRank,
            degreeRank,
            'برای ورود به رتبه‌بندی علمی باید حداقل مدرک کاردانی داشته باشی'
          )
        ]
      },
      {
        title: 'وضعیت شغلی',
        items: [
          this.textStat('💼 شغل', jobTitleOf(player), 'هنوز شغلی نداری'),
          this.countStat('🔁 نوبت‌های کاری', workSessionCount, 'نوبت', 'هنوز کار نکرده‌ای'),
          this.moneyStat('💰 کل دستمزد', totalSalary),
          this.countStat('🏢 کسب‌وکار', businesses.length, 'مورد', 'کسب‌وکاری نداری')
        ]
      },
      {
        title: 'تجربه و مهارت',
        items: [
          this.growthStat('⭐ تجربه', player.experience, [50, 250, 1000]),
          this.countStat('🎯 مهارت‌ها', skillCount, 'مهارت', 'هنوز مهارتی نیاموخته‌ای'),
          this.rankEligibilityStat(
            '🏅 رتبهٔ تجربه',
            player.experience >= RANK_ELIGIBILITY.experience.minExperience,
            player.experience,
            'برای ورود به رتبه‌بندی تجربه باید حداقل ۵۰ تجربه داشته باشی'
          )
        ]
      },
      {
        title: 'رتبه‌بندی',
        items: [
          this.rankEligibilityStat(
            '💰 رتبهٔ ثروت',
            netWorth >= RANK_ELIGIBILITY.wealth.minNetWorth,
            netWorth,
            'برای ورود به رتبه‌بندی ثروت باید خالص دارایی‌ات از یک میلیون تومان بیشتر باشد'
          ),
          this.rankEligibilityStat(
            '🏘️ رتبهٔ دارایی',
            assetValue >= RANK_ELIGIBILITY.assets.minAssetValue,
            assetValue,
            'برای ورود به رتبه‌بندی دارایی باید ملک یا کسب‌وکار داشته باشی'
          )
        ]
      },
      {
        title: 'سابقهٔ فعالیت',
        items: [
          this.countStat('🗂️ رخدادهای ثبت‌شده', eventCount, 'رخداد', 'هنوز رخدادی ثبت نشده')
        ]
      }
    ]

    return { groups, netWorth, computedAt: new Date() }
  }

  // ---------- سازندهٔ شاخص‌ها ----------

  private plainStat(label: string, value: number, unit: string): StatValue {
    return {
      label,
      state: 'starting',
      display: `${value.toLocaleString('fa-IR')} ${unit}`,
      raw: value
    }
  }

  private textStat(label: string, value: string | null, unsetText: string): StatValue {
    if (!value) {
      return { label, state: 'unset', display: unsetText, raw: null }
    }
    return { label, state: 'starting', display: value, raw: null }
  }

  private countStat(
    label: string,
    value: number,
    unit: string,
    unsetText: string
  ): StatValue {
    if (value <= 0) {
      return { label, state: 'unset', display: unsetText, raw: 0 }
    }
    return {
      label,
      state: value > 10 ? 'growing' : 'starting',
      display: `${value.toLocaleString('fa-IR')} ${unit}`,
      raw: value
    }
  }

  private moneyStat(label: string, value: number): StatValue {
    if (value <= 0) {
      return { label, state: 'zero', display: '۰ تومان', raw: 0 }
    }
    const state: StatState =
      value >= 100_000_000 ? 'elite' : value >= 10_000_000 ? 'high' : 'growing'
    return { label, state, display: `${value.toLocaleString('fa-IR')} تومان`, raw: value }
  }

  private balanceStat(label: string, value: number): StatValue {
    const sign = value > 0 ? '+' : value < 0 ? '−' : ''
    return {
      label,
      state: value === 0 ? 'zero' : value > 0 ? 'growing' : 'starting',
      display: `${sign}${Math.abs(value).toLocaleString('fa-IR')} تومان`,
      raw: value
    }
  }

  private netWorthStat(value: number): StatValue {
    if (value === 0) {
      return { label: '📊 خالص دارایی', state: 'zero', display: '۰ تومان', raw: 0 }
    }
    if (value < 0) {
      return {
        label: '📊 خالص دارایی',
        state: 'starting',
        display: `−${Math.abs(value).toLocaleString('fa-IR')} تومان`,
        raw: value,
        hint: 'بدهی‌ات از دارایی‌ات بیشتر است'
      }
    }
    const state: StatState =
      value >= 500_000_000 ? 'elite' : value >= 50_000_000 ? 'high' : 'growing'
    return {
      label: '📊 خالص دارایی',
      state,
      display: `${value.toLocaleString('fa-IR')} تومان`,
      raw: value
    }
  }

  private growthStat(label: string, value: number, tiers: [number, number, number]): StatValue {
    if (value <= 0) {
      return { label, state: 'unset', display: 'هنوز ثبت نشده', raw: 0 }
    }
    const state: StatState =
      value >= tiers[2] ? 'elite' : value >= tiers[1] ? 'high' : value >= tiers[0] ? 'growing' : 'starting'
    return { label, state, display: value.toLocaleString('fa-IR'), raw: value }
  }

  /** شاخص رتبه: اگر شرایط ورود نباشد، «بدون رتبه» نمایش داده می‌شود (هرگز «رتبه ۰»). */
  private rankEligibilityStat(
    label: string,
    eligible: boolean,
    raw: number,
    hint: string
  ): StatValue {
    if (!eligible) {
      return { label, state: 'unranked', display: 'بدون رتبه', raw, hint }
    }
    return { label, state: 'ranked', display: 'واجد شرایط رتبه‌بندی', raw }
  }
}

/** عنوان شغل واقعی با اولویت: کار در جریان ← استخدام ← کارفرمایی ← آخرین سابقه. */
function jobTitleOf(player: {
  workSessions: Array<{ jobTitle: string; status: string }>
  employments: Array<{ title: string }>
  ownedBusinesses: Array<{ name: string }>
}): string | null {
  const active = player.workSessions.find((s) => s.status === 'ACTIVE')
  if (active) {
    return `${active.jobTitle} (در حال کار)`
  }
  if (player.employments[0]) {
    return player.employments[0].title
  }
  if (player.ownedBusinesses[0]) {
    return `کارفرمای ${player.ownedBusinesses[0].name}`
  }
  return player.workSessions[0]?.jobTitle ?? null
}
