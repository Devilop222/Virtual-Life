import { GameEventType } from '@prisma/client'

/**
 * فیلترهای تاریخچهٔ زندگی.
 *
 * تاریخچهٔ بازیکن همهٔ رخدادهای مهم را نگه می‌دارد، اما پیش از این فقط پشتِ
 * هم ردیف می‌شدند و پارامتر `types` سرویس تاریخچه هرگز از هیچ مسیری صدا
 * زده نمی‌شد (عمقِ مرده). حالا بازیکن می‌تواند زندگی‌اش را برش بزند:
 * فقط کار، فقط پول، فقط خانواده یا فقط شهر — همان دادهٔ واقعی، دیدهای مختلف.
 */

export type HistoryFilterKey = 'all' | 'work' | 'money' | 'family' | 'city'

export interface HistoryFilter {
  key: HistoryFilterKey
  label: string
}

export const HISTORY_FILTERS: readonly HistoryFilter[] = [
  { key: 'all', label: 'همه' },
  { key: 'work', label: '💼 کار' },
  { key: 'money', label: '💰 مالی' },
  { key: 'family', label: '💞 خانواده' },
  { key: 'city', label: '🏙️ شهر' }
]

const WORK_TYPES: GameEventType[] = [
  'JOB_STARTED',
  'JOB_APPLIED',
  'JOB_FINISHED',
  'SALARY_RECEIVED',
  'OVERTIME_WORKED',
  'PAYROLL_SETTLED',
  'PAYROLL_DEBT',
  'COMPANY_CREATED',
  'COMPANY_UPGRADED',
  'BRANCH_OPENED'
]

const MONEY_TYPES: GameEventType[] = [
  'BANK_DEPOSIT',
  'BANK_WITHDRAW',
  'LOAN_CREATED',
  'LOAN_REPAID',
  'DEPOSIT_MATURED',
  'MARKET_TRANSACTION',
  'STOCK_TRANSACTION',
  'ITEM_SOLD',
  'P2P_LOAN_SETTLED',
  'AUCTION_WON',
  'LOTTERY_TICKET',
  'LOTTERY_WON'
]

const FAMILY_TYPES: GameEventType[] = [
  'MARRIAGE_REGISTERED',
  'DIVORCE_REGISTERED',
  'HOUSE_PURCHASED',
  'HOUSE_RENTED',
  'RENT_INCOME',
  'PET_ADOPTED',
  'PET_FED'
]

const CITY_TYPES: GameEventType[] = [
  'REGION_REGISTERED',
  'REGION_LEVEL_CHANGED',
  'REGION_POPULATION_MILESTONE',
  'REGION_ECONOMY_SHIFT',
  'REGION_WEALTH_RECORD',
  'REGION_BIG_TRANSACTION',
  'RESIDENCE_ESTABLISHED',
  'RESIDENCE_MIGRATED',
  'PLAYER_TRAVELED',
  'TRAVEL_STAMP',
  'PROJECT_COMPLETED',
  'ELECTION_WON',
  'CHALLENGE_COMPLETED',
  'MAYOR_POLICY_SET'
]

/** کلید فیلتر معتبر است؟ (برای کال‌بک‌های قدیمی/دستکاری‌شده) */
export function isHistoryFilterKey(key: string): key is HistoryFilterKey {
  return HISTORY_FILTERS.some((f) => f.key === key)
}

/**
 * فهرست انواع رخدادِ یک فیلتر؛ «همه» یعنی بدون فیلتر (`undefined`).
 */
export function historyFilterTypes(key: HistoryFilterKey): GameEventType[] | undefined {
  switch (key) {
    case 'work':
      return WORK_TYPES
    case 'money':
      return MONEY_TYPES
    case 'family':
      return FAMILY_TYPES
    case 'city':
      return CITY_TYPES
    default:
      return undefined
  }
}

/** برچسب نمایشی فیلتر. */
export function historyFilterLabel(key: HistoryFilterKey): string {
  return HISTORY_FILTERS.find((f) => f.key === key)?.label ?? 'همه'
}
