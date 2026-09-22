import { PrismaClient, TransactionType } from '@prisma/client'
import { NotFoundError } from '../../utils/classes/errors'
import { NotificationService } from '../notification/notification.service'
import { transactionLabels } from '../finance/ledger.service'
import { GAME_DAYS_PER_WEEK, gameDays, weekIndex } from '../../utils/game-time'

/** طول یک هفتـهٔ بازی (۵٫۶ ساعت واقعی) — همان چرخه‌ای که گزارش هفتگی روی آن می‌نشیند. */
const WEEK_MS = gameDays(GAME_DAYS_PER_WEEK)

export interface ReportSection {
  incomeTotal: number
  expenseTotal: number
  net: number
  topExpenseLabel: string
  topExpenseAmount: number
}

export interface WeeklyReport {
  thisWeek: ReportSection
  lastWeek: ReportSection
  trendPercent: number
}

/**
 * گزارش هفتگی مالی.
 *
 * همهٔ اعداد از FinancialTransaction خوانده می‌شوند (تک منبع حقیقت).
 * ارسال به مرکز اعلان با کلید یکتای هفته فقط یک بار در هفته انجام می‌شود.
 */
export class ReportService {
  constructor(
    private readonly db: PrismaClient,
    private readonly notificationService: NotificationService
  ) {}

  /** تجمیع ورودی/خروجی یک بازهٔ هفته‌ای. */
  private async sectionFor(playerId: string, weekStartMs: number): Promise<ReportSection> {
    const since = new Date(weekStartMs)
    const until = new Date(weekStartMs + WEEK_MS)

    const [inAgg, outAgg, topExpense] = await Promise.all([
      this.db.financialTransaction.aggregate({
        where: { destinationPlayerId: playerId, createdAt: { gte: since, lt: until } },
        _sum: { amount: true }
      }),
      this.db.financialTransaction.aggregate({
        where: { sourcePlayerId: playerId, createdAt: { gte: since, lt: until } },
        _sum: { amount: true }
      }),
      this.db.financialTransaction.groupBy({
        by: ['type'],
        where: { sourcePlayerId: playerId, createdAt: { gte: since, lt: until } },
        _sum: { amount: true },
        orderBy: { _sum: { amount: 'desc' } },
        take: 1
      })
    ])

    const incomeTotal = Number(inAgg._sum.amount ?? 0)
    const expenseTotal = Number(outAgg._sum.amount ?? 0)
    const topType = topExpense[0]?.type as TransactionType | undefined

    return {
      incomeTotal,
      expenseTotal,
      net: incomeTotal - expenseTotal,
      topExpenseLabel: topType
        ? (transactionLabels[topType] ?? 'تراکنش')
        : '—',
      topExpenseAmount: Number(topExpense[0]?._sum.amount ?? 0)
    }
  }

  /** ساخت گزارش دو هفتهٔ اخیر. */
  async getReport(telegramUserId: bigint): Promise<WeeklyReport> {
    const player = await this.db.player.findUnique({
      where: { telegramUserId },
      select: { id: true }
    })
    if (!player) {
      throw new NotFoundError('Player not found')
    }

    const currentWeek = weekIndex()
    const [thisWeek, lastWeek] = await Promise.all([
      this.sectionFor(player.id, currentWeek * WEEK_MS),
      this.sectionFor(player.id, (currentWeek - 1) * WEEK_MS)
    ])

    const trendPercent =
      lastWeek.expenseTotal > 0
        ? Math.round(
            ((thisWeek.expenseTotal - lastWeek.expenseTotal) / lastWeek.expenseTotal) * 100
          )
        : 0

    return { thisWeek, lastWeek, trendPercent }
  }

  /**
   * ارسال گزارش به مرکز اعلان؛ در هر هفته تنها یک بار (کلید یکتا).
   * `true` یعنی اعلان تازه ثبت شد، `false` یعنی این هفته قبلاً ارسال شده.
   */
  async sendToNotifications(
    telegramUserId: bigint,
    report: WeeklyReport
  ): Promise<boolean> {
    const player = await this.db.player.findUnique({
      where: { telegramUserId },
      select: { id: true }
    })
    if (!player) {
      throw new NotFoundError('Player not found')
    }

    const lines = [
      `درآمد: ${report.thisWeek.incomeTotal.toLocaleString('fa-IR')} ت`,
      `خرج: ${report.thisWeek.expenseTotal.toLocaleString('fa-IR')} ت`,
      `مانده: ${report.thisWeek.net >= 0 ? '+' : '−'}${Math.abs(report.thisWeek.net).toLocaleString('fa-IR')} ت`
    ].join('\n')

    return this.notificationService.notifyPlayerById(
      player.id,
      '📊 گزارش هفتگی مالی',
      lines,
      undefined,
      `weekly-report:${player.id}:${weekIndex()}`,
      'INFORMATIONAL'
    )
  }
}
