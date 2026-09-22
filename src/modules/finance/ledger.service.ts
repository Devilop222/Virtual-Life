import { PrismaClient, TransactionType } from '@prisma/client'
import { NotFoundError } from '../../utils/classes/errors'

export interface LedgerEntry {
  id: string
  amount: number
  direction: 'in' | 'out'
  type: TransactionType
  reference: string | null
  createdAt: Date
}

export interface LedgerPage {
  entries: LedgerEntry[]
  page: number
  pageSize: number
  total: number
  totalIn: number
  totalOut: number
}

const PAGE_SIZE = 8

/**
 * انواعی که «درآمد» شمرده می‌شوند (پول تازه‌ای که به بازیکن می‌رسد یا
 * دارایی‌اش را نقد می‌کند). برداشت از حساب خودِ بازیکن درآمد نیست و اینجا
 * جای ندارد — همان پولی است که قبلاً داشته.
 */
const INCOME_TYPES: TransactionType[] = [
  TransactionType.SALARY_PAYMENT,
  TransactionType.BUSINESS_REVENUE,
  TransactionType.BANK_INTEREST,
  TransactionType.DEPOSIT_PAYOUT,
  TransactionType.STOCK_SELL,
  TransactionType.FARM_HARVEST,
  TransactionType.P2P_LOAN_DISBURSE,
  TransactionType.LOTTERY_PRIZE,
  TransactionType.REWARD_PAYOUT,
  TransactionType.PROPERTY_SALE
]

export const transactionLabels: Record<TransactionType, string> = {
  SALARY_PAYMENT: 'حقوق',
  BUSINESS_REVENUE: 'درآمد کسب‌وکار',
  STARTUP_COST: 'هزینهٔ راه‌اندازی',
  BUSINESS_UPGRADE: 'ارتقای کسب‌وکار',
  PROPERTY_PURCHASE: 'خرید ملک',
  PROPERTY_SALE: 'فروش ملک',
  PROPERTY_RENT: 'اجارهٔ ملک',
  BANK_DEPOSIT: 'واریز بانکی',
  BANK_WITHDRAWAL: 'برداشت بانکی',
  BANK_INTEREST: 'سود سپرده',
  LOAN_DISBURSEMENT: 'دریافت وام',
  LOAN_REPAYMENT: 'بازپرداخت وام',
  TRANSFER: 'انتقال نقدی',
  BANK_TRANSFER: 'انتقال بانکی',
  WITHDRAWAL: 'برداشت',
  DEPOSIT: 'سپردهٔ مدت‌دار',
  MARKET_TRADE: 'معامله بازیکنی',
  LOTTERY_PRIZE: 'جایزه قرعه‌کشی',
  MEDICAL_EXPENSE: 'هزینهٔ درمان',
  INSURANCE_PREMIUM: 'حق بیمه',
  DEPOSIT_PAYOUT: 'سررسید سپرده',
  MAHR_PAYMENT: 'مهریه',
  DIVORCE_SETTLEMENT: 'تسویه طلاق',
  STOCK_BUY: 'خرید سهام',
  STOCK_SELL: 'فروش سهام',
  AUCTION_BID: 'پیشنهاد حراجی',
  AUCTION_WIN: 'برنده حراجی',
  GYM_FEE: 'عضویت باشگاه',
  P2P_LOAN_DISBURSE: 'قرض از بازیکن',
  P2P_LOAN_REPAY: 'بازپرداخت قرض بازیکنی',
  FARM_PLANT: 'کاشت محصول',
  FARM_HARVEST: 'برداشت محصول',
  CRAFTING_FEE: 'کارمزد کارگاه',
  BRANCH_SETUP: 'افتتاح شعبه',
  PROPERTY_MAINTENANCE: 'شارژ نگهداری ملک',
  NEWS_AD_FEE: 'آگهی همگانی',
  TAX_PAYMENT: 'مالیات',
  LOAN_INTEREST: 'سود وام',
  DEPOSIT_INTEREST: 'سود سپرده',
  SHOP_PURCHASE: 'خرید از فروشگاه',
  REWARD_PAYOUT: 'پاداش',
  EDUCATION_TUITION: 'شهریهٔ تحصیل',
  FAMILY_EXPENSE: 'خرج خانواده',
  PET_EXPENSE: 'هزینهٔ حیوان خانگی',
  PET_BONUS: 'هدیهٔ حیوان خانگی',
  FORTUNE_LOSS: 'شانس روزانه',
  RESIDENCE_MIGRATION_FEE: 'هزینهٔ مهاجرت',
  SKILL_TRAINING: 'تمرین مهارت',
  INHERITANCE_TRANSFER: 'انتقال میراث',
  LOAN_COLLATERAL_SEIZED: 'تملک وثیقهٔ وام',
  PROJECT_DONATION: 'کمک به پروژهٔ شهری',
  UNCLAIMED_ESTATE: 'داراییِ بی‌وارث (به صندوق منطقه)'
}

/**
 * دفتر مالی (Ledger) و آمار زندگی بازیکن.
 * همهٔ اعداد از FinancialTransaction و جداول اصلی خوانده می‌شوند تا
 * تنها یک Source of Truth وجود داشته باشد.
 */
export class LedgerService {
  constructor(private readonly db: PrismaClient) {}

  private async requirePlayer(telegramUserId: bigint) {
    const player = await this.db.player.findUnique({
      where: { telegramUserId },
      select: {
        id: true,
        age: true,
        balance: true,
        experience: true,
        currentDegree: true,
        startedAt: true
      }
    })
    if (!player) {
      throw new NotFoundError('Player not found')
    }
    return player
  }

  async getLedger(telegramUserId: bigint, page = 0): Promise<LedgerPage> {
    const player = await this.requirePlayer(telegramUserId)
    const where = {
      OR: [{ sourcePlayerId: player.id }, { destinationPlayerId: player.id }]
    }

    const [total, rows, inAgg, outAgg] = await Promise.all([
      this.db.financialTransaction.count({ where }),
      this.db.financialTransaction.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: Math.max(0, page) * PAGE_SIZE,
        take: PAGE_SIZE,
        select: {
          id: true,
          amount: true,
          type: true,
          reference: true,
          createdAt: true,
          destinationPlayerId: true
        }
      }),
      this.db.financialTransaction.aggregate({
        where: { destinationPlayerId: player.id },
        _sum: { amount: true }
      }),
      this.db.financialTransaction.aggregate({
        where: { sourcePlayerId: player.id },
        _sum: { amount: true }
      })
    ])

    const entries: LedgerEntry[] = rows.map((row) => ({
      id: row.id,
      amount: Number(row.amount),
      direction: row.destinationPlayerId === player.id ? 'in' : 'out',
      type: row.type,
      reference: row.reference,
      createdAt: row.createdAt
    }))

    return {
      entries,
      page: Math.max(0, page),
      pageSize: PAGE_SIZE,
      total,
      totalIn: Number(inAgg._sum.amount ?? 0),
      totalOut: Number(outAgg._sum.amount ?? 0)
    }
  }

}

export function isIncomeType(type: TransactionType): boolean {
  return INCOME_TYPES.includes(type)
}
