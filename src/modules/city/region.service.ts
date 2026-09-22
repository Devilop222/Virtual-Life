import { GameEventType, PlayerGroupStatus, PrismaClient, TransactionType } from '@prisma/client'
import { NotFoundError } from '../../utils/classes/errors'
import { EventService } from '../events/event.service'
import { countEmployedPlayers } from '../occupation/employment'
import { REGION_CONFIG } from '../../config/region.config'
import { GAME_DAYS_PER_WEEK, gameDays } from '../../utils/game-time'

export interface RegionState {
  groupId: string
  groupTitle: string
  environmentLevel: string
  population: number
  employed: number
  unemployed: number
  employmentRate: number
  companies: number
  properties: number
  totalWealth: number
  bankDeposits: number
  totalDebt: number
  averageIncome: number
  educatedCount: number
  transactionVolume: number
  transactionCount: number
  taxRevenue: number
  economicIndex: number
  previousIndex: number
  indexTrend: number
  refreshedAt: Date
}

/** همهٔ آستانه‌ها از تنظیمات مرکزی می‌آیند. */
const STALE_AFTER_MS = REGION_CONFIG.statTtlMs
const SMOOTHING = REGION_CONFIG.economicSmoothing

/**
 * موتور منطقه: آمار هر گروه را به‌صورت تجمیعی نگه می‌دارد.
 * هیچ درخواستی کل بازیکنان را Scan نمی‌کند؛ همه‌چیز با Aggregate Query و Cache دیتابیسی
 * محاسبه و در RegionStat ذخیره می‌شود.
 */
export class RegionService {
  constructor(
    private readonly db: PrismaClient,
    private readonly eventService: EventService
  ) {}

  /** خواندن وضعیت منطقه؛ اگر آمار کهنه باشد، بازمحاسبه می‌شود. */
  async getState(telegramGroupId: bigint, forceRefresh = false): Promise<RegionState> {
    const group = await this.db.group.findUnique({
      where: { telegramGroupId },
      select: { id: true, title: true, environmentLevel: true, stat: true }
    })
    if (!group) {
      throw new NotFoundError(
        'Group not registered',
        'این گروه هنوز به‌عنوان محیط بازی ثبت نشده است. در همین گروه /start را بفرست.'
      )
    }

    const stat = group.stat
    const isStale =
      forceRefresh || !stat || Date.now() - stat.refreshedAt.getTime() > STALE_AFTER_MS

    if (!isStale && stat) {
      return this.toState(group, stat)
    }

    const refreshed = await this.refresh(group.id, group.environmentLevel)
    return this.toState(group, refreshed)
  }

  /** بازمحاسبهٔ آمار منطقه با Aggregate Query. */
  async refresh(groupId: string, environmentLevel?: string) {
    // شاخص قبلی (برای هموارسازی) و صندوق منطقه (که هرگز بازنویسی نمی‌شود)
    // پیش از هر شاخه‌ای خوانده می‌شوند تا «منطقهٔ خالی» هم صندوقش را از دست ندهد.
    const previous = await this.db.regionStat.findUnique({
      where: { groupId },
      select: { economicIndex: true, taxRevenue: true }
    })
    const previousIndex = previous?.economicIndex ?? 0
    // صندوق منطقه (مالیات و فروش بلیت) فقط از مسیر `economy/tax.service`
    // پر می‌شود؛ بازمحاسبهٔ آمار نباید آن را پاک کند. پیش‌تر این ستون با
    // فرمول ساختگیِ «۲٪ گردش هفته» بازنویسی می‌شد و عدد روی پنل منطقه هیچ
    // ربطی به پولی که کسی واقعاً پرداخت کرده بود نداشت.
    const regionFund = Math.max(0, Math.round(Number(previous?.taxRevenue ?? 0)))

    const memberships = await this.db.playerGroup.findMany({
      where: { groupId, status: PlayerGroupStatus.ACTIVE },
      select: { playerId: true }
    })
    const playerIds = memberships.map((m) => m.playerId)

    if (playerIds.length === 0) {
      return this.persist(groupId, {
        population: 0,
        employed: 0,
        companies: 0,
        properties: 0,
        totalWealth: 0,
        bankDeposits: 0,
        totalDebt: 0,
        averageIncome: 0,
        educatedCount: 0,
        transactionVolume: 0,
        transactionCount: 0,
        taxRevenue: regionFund,
        economicIndex: 0
      })
    }

    // پنجرهٔ آماری منطقه: یک هفتـهٔ بازی، از ساعت مرکزی — نه ضریب دستی.
    const since = new Date(Date.now() - gameDays(GAME_DAYS_PER_WEEK))

    const [employed, walletAgg, bankAgg, companies, properties, debtAgg, educated, txAgg, salaryAgg] =
      await Promise.all([
        countEmployedPlayers(this.db, playerIds),
        this.db.player.aggregate({ where: { id: { in: playerIds } }, _sum: { balance: true } }),
        this.db.bankAccount.aggregate({
          where: { playerId: { in: playerIds } },
          _sum: { balance: true }
        }),
        this.db.business.count({ where: { ownerId: { in: playerIds }, status: 'ACTIVE' } }),
        this.db.property.count({ where: { ownerId: { in: playerIds } } }),
        this.db.loan.aggregate({
          where: { playerId: { in: playerIds }, status: 'ACTIVE' },
          _sum: { remainingAmount: true }
        }),
        this.db.player.count({
          where: { id: { in: playerIds }, currentDegree: { not: 'DIPLOMA' } }
        }),
        this.db.financialTransaction.aggregate({
          where: {
            createdAt: { gte: since },
            OR: [
              { sourcePlayerId: { in: playerIds } },
              { destinationPlayerId: { in: playerIds } }
            ]
          },
          _sum: { amount: true },
          _count: { _all: true }
        }),
        this.db.financialTransaction.aggregate({
          where: { destinationPlayerId: { in: playerIds }, type: TransactionType.SALARY_PAYMENT },
          _sum: { amount: true }
        })
      ])

    const population = playerIds.length
    const cash = Number(walletAgg._sum.balance ?? 0)
    const deposits = Number(bankAgg._sum.balance ?? 0)
    const debt = Number(debtAgg._sum.remainingAmount ?? 0)
    const txVolume = Number(txAgg._sum.amount ?? 0)
    const txCount = txAgg._count._all
    const totalSalary = Number(salaryAgg._sum.amount ?? 0)
    const totalWealth = cash + deposits - debt

    const rawIndex = this.computeEconomicIndex({
      population,
      employed,
      companies,
      properties,
      totalWealth,
      txVolume,
      txCount,
      educated
    })

    // هموارسازی: شاخص با یک تراکنش کوچک جهش نمی‌کند
    const economicIndex =
      previousIndex === 0
        ? rawIndex
        : Math.round(previousIndex + (rawIndex - previousIndex) * SMOOTHING)

    const persisted = await this.persist(groupId, {
      population,
      employed,
      companies,
      properties,
      totalWealth,
      bankDeposits: deposits,
      totalDebt: debt,
      averageIncome: population > 0 ? Math.round(totalSalary / population) : 0,
      educatedCount: educated,
      transactionVolume: txVolume,
      transactionCount: txCount,
      taxRevenue: regionFund,
      economicIndex,
      previousIndex
    })

    await this.emitMilestones(groupId, environmentLevel, {
      population,
      previousPopulation: previous ? undefined : 0,
      economicIndex,
      previousIndex,
      totalWealth
    })

    return persisted
  }

  /**
   * شاخص اقتصادی ۰ تا ۱۰۰ با وزن‌دهی و نرمال‌سازی لگاریتمی.
   * هیچ عاملی به‌تنهایی نمی‌تواند شاخص را منفجر کند (هر بخش سقف دارد).
   */
  private computeEconomicIndex(input: {
    population: number
    employed: number
    companies: number
    properties: number
    totalWealth: number
    txVolume: number
    txCount: number
    educated: number
  }): number {
    const employmentScore =
      input.population > 0 ? (input.employed / input.population) * 25 : 0
    const wealthScore = Math.min(25, logScale(input.totalWealth, 1_000_000) * 25)
    const activityScore = Math.min(20, logScale(input.txVolume, 1_000_000) * 20)
    const businessScore = Math.min(15, logScale(input.companies, 1) * 15)
    const propertyScore = Math.min(10, logScale(input.properties, 1) * 10)
    const educationScore =
      input.population > 0 ? (input.educated / input.population) * 5 : 0

    const total =
      employmentScore +
      wealthScore +
      activityScore +
      businessScore +
      propertyScore +
      educationScore

    return Math.max(0, Math.min(100, Math.round(total)))
  }

  /** ثبت رخدادهای خبری در صورت عبور از آستانه‌های معنادار. */
  private async emitMilestones(
    groupId: string,
    environmentLevel: string | undefined,
    data: {
      population: number
      previousPopulation?: number
      economicIndex: number
      previousIndex: number
      totalWealth: number
    }
  ): Promise<void> {
    // نقطهٔ عطف جمعیتی: ۱۰، ۲۵، ۵۰، ۱۰۰، ۲۵۰
    const milestones = [10, 25, 50, 100, 250]
    const reached = milestones.filter((m) => data.population >= m).pop()
    if (reached) {
      await this.eventService.recordRegionEvent({
        groupId,
        type: GameEventType.REGION_POPULATION_MILESTONE,
        title: `جمعیت منطقه به ${reached.toLocaleString('fa-IR')} بازیکن رسید`,
        detail: environmentLevel ? undefined : undefined,
        dedupeKey: `pop:${groupId}:${reached}`,
        priority: 4
      })
    }

    // جهش یا افت محسوس اقتصادی (۱۵ واحد یا بیشتر)
    const delta = data.economicIndex - data.previousIndex
    if (data.previousIndex > 0 && Math.abs(delta) >= 15) {
      const bucket = Math.floor(data.economicIndex / 10) * 10
      await this.eventService.recordRegionEvent({
        groupId,
        type: GameEventType.REGION_ECONOMY_SHIFT,
        title:
          delta > 0
            ? `رونق اقتصادی منطقه؛ شاخص به ${data.economicIndex} رسید`
            : `رکود اقتصادی منطقه؛ شاخص به ${data.economicIndex} رسید`,
        dedupeKey: `econ:${groupId}:${bucket}:${delta > 0 ? 'up' : 'down'}`,
        priority: 4
      })
    }

    // رکورد ثروت منطقه (پله‌های میلیاردی)
    if (data.totalWealth > 0) {
      const billions = Math.floor(data.totalWealth / 1_000_000_000)
      if (billions >= 1) {
        await this.eventService.recordRegionEvent({
          groupId,
          type: GameEventType.REGION_WEALTH_RECORD,
          title: `ثروت کل منطقه از ${billions.toLocaleString('fa-IR')} میلیارد تومان گذشت`,
          amount: data.totalWealth,
          dedupeKey: `wealth:${groupId}:${billions}`,
          priority: 4
        })
      }
    }
  }

  private async persist(
    groupId: string,
    data: {
      population: number
      employed: number
      companies: number
      properties: number
      totalWealth: number
      bankDeposits?: number
      totalDebt?: number
      averageIncome?: number
      educatedCount: number
      transactionVolume: number
      transactionCount: number
      taxRevenue: number
      economicIndex: number
      previousIndex?: number
    }
  ) {
    // `taxRevenue` عمداً از payloadِ `update` بیرون است: صندوق منطقه پول واقعی
    // دارد (مالیات، فروش بلیت) که فقط از `economy/tax.service` نوشته می‌شود.
    // بازنویسیِ آن با مقدارِ خوانده‌شدهٔ ابتدای refresh، هر مالیاتی که در فاصله
    // بین خواندن و نوشتن به صندوق می‌رسید را بی‌صدا می‌زد (پول از بین می‌رفت).
    // در `create` مقدارِ همان لحظهٔ خواندن نوشته می‌شود؛ اگر در همان لحظه
    // صندوق ساخته شده باشد، شاخهٔ update بی‌طرف است.
    const payload = {
      population: data.population,
      employed: data.employed,
      companies: data.companies,
      properties: data.properties,
      totalWealth: data.totalWealth,
      bankDeposits: data.bankDeposits ?? 0,
      totalDebt: data.totalDebt ?? 0,
      averageIncome: data.averageIncome ?? 0,
      educatedCount: data.educatedCount,
      transactionVolume: data.transactionVolume,
      transactionCount: data.transactionCount,
      economicIndex: data.economicIndex,
      previousIndex: data.previousIndex ?? 0,
      refreshedAt: new Date()
    }

    return this.db.regionStat.upsert({
      where: { groupId },
      create: { groupId, taxRevenue: data.taxRevenue, ...payload },
      update: payload
    })
  }

  private toState(
    group: { id: string; title: string; environmentLevel: string },
    stat: {
      population: number
      employed: number
      companies: number
      properties: number
      totalWealth: { toString(): string }
      bankDeposits: { toString(): string }
      totalDebt: { toString(): string }
      averageIncome: { toString(): string }
      educatedCount: number
      transactionVolume: { toString(): string }
      transactionCount: number
      taxRevenue: { toString(): string }
      economicIndex: number
      previousIndex: number
      refreshedAt: Date
    }
  ): RegionState {
    return {
      groupId: group.id,
      groupTitle: group.title,
      environmentLevel: group.environmentLevel,
      population: stat.population,
      employed: stat.employed,
      unemployed: Math.max(0, stat.population - stat.employed),
      employmentRate:
        stat.population > 0 ? Math.round((stat.employed / stat.population) * 100) : 0,
      companies: stat.companies,
      properties: stat.properties,
      totalWealth: Number(stat.totalWealth),
      bankDeposits: Number(stat.bankDeposits),
      totalDebt: Number(stat.totalDebt),
      averageIncome: Number(stat.averageIncome),
      educatedCount: stat.educatedCount,
      transactionVolume: Number(stat.transactionVolume),
      transactionCount: stat.transactionCount,
      taxRevenue: Number(stat.taxRevenue),
      economicIndex: stat.economicIndex,
      previousIndex: stat.previousIndex,
      indexTrend: stat.economicIndex - stat.previousIndex,
      refreshedAt: stat.refreshedAt
    }
  }
}

/** نرمال‌سازی لگاریتمی به بازهٔ ۰ تا ۱. */
function logScale(value: number, unit: number): number {
  if (value <= 0) return 0
  const normalized = Math.log10(1 + value / unit) / Math.log10(1 + 1000)
  return Math.max(0, Math.min(1, normalized))
}
