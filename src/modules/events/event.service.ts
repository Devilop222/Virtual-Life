import { EventScope, GameEventType, PrismaClient } from '@prisma/client'

export interface RecordPlayerEventInput {
  playerId: string
  type: GameEventType
  title: string
  detail?: string
  amount?: number
  /** کلید یکتا برای جلوگیری از ثبت دوباره (Idempotency) */
  dedupeKey?: string
}

export interface RecordRegionEventInput {
  groupId: string
  type: GameEventType
  title: string
  detail?: string
  amount?: number
  dedupeKey?: string
  /** اولویت خبری ۱ تا ۵؛ ۴ و بالاتر ارزش انتشار خودکار دارد */
  priority?: number
}

export interface HistoryPage {
  entries: Array<{
    id: string
    type: GameEventType
    title: string
    detail: string | null
    amount: number | null
    createdAt: Date
  }>
  page: number
  pageSize: number
  total: number
}

/** اولویت پیش‌فرض هر نوع رخداد برای موتور خبر. */
const DEFAULT_PRIORITY: Partial<Record<GameEventType, number>> = {
  REGION_REGISTERED: 5,
  REGION_LEVEL_CHANGED: 5,
  REGION_WEALTH_RECORD: 4,
  REGION_POPULATION_MILESTONE: 4,
  REGION_ECONOMY_SHIFT: 4,
  REGION_BIG_TRANSACTION: 3,
  COMPANY_CREATED: 3,
  COMPANY_UPGRADED: 3,
  ACHIEVEMENT_UNLOCKED: 2,
  EDUCATION_COMPLETED: 2,
  HOUSE_PURCHASED: 2,
  // نکول وام یک رویداد مالی سنگین است: تملک وثیقه و جریمهٔ اعتبار.
  // اولویت ۳ یعنی در سرگذشت و فید منطقه دیده می‌شود ولی گروه را پر نمی‌کند.
  LOAN_DEFAULTED: 3
}

const HISTORY_PAGE_SIZE = 8

/** انواع رخدادی که در تاریخچهٔ بازیکن نمایش داده می‌شوند. */
export const historyEventLabels: Record<GameEventType, string> = {
  JOB_STARTED: 'شروع کار',
  JOB_APPLIED: 'درخواست کار',
  JOB_FINISHED: 'پایان کار',
  SALARY_RECEIVED: 'دریافت دستمزد',
  HOUSE_PURCHASED: 'خرید ملک',
  HOUSE_RENTED: 'اجارهٔ ملک',
  BANK_DEPOSIT: 'واریز بانکی',
  BANK_WITHDRAW: 'برداشت بانکی',
  LOAN_CREATED: 'دریافت وام',
  LOAN_REPAID: 'بازپرداخت وام',
  EDUCATION_ENROLLED: 'ثبت‌نام تحصیلی',
  EDUCATION_COMPLETED: 'فارغ‌التحصیلی',
  COMPANY_CREATED: 'تأسیس کسب‌وکار',
  COMPANY_UPGRADED: 'ارتقای کسب‌وکار',
  MARKET_TRANSACTION: 'معاملهٔ بازار',
  ACHIEVEMENT_UNLOCKED: 'دستاورد جدید',
  REGION_REGISTERED: 'ثبت منطقه',
  REGION_LEVEL_CHANGED: 'تغییر سطح منطقه',
  REGION_POPULATION_MILESTONE: 'رشد جمعیت منطقه',
  REGION_ECONOMY_SHIFT: 'تغییر اقتصاد منطقه',
  REGION_WEALTH_RECORD: 'رکورد ثروت منطقه',
  REGION_BIG_TRANSACTION: 'معاملهٔ بزرگ منطقه',
  RESIDENCE_ESTABLISHED: 'ثبت محل اقامت',
  RESIDENCE_MIGRATED: 'مهاجرت',
  PLAYER_TRAVELED: 'سفر به منطقه',
  PAYROLL_SETTLED: 'تسویه حقوق کارمندان',
  PAYROLL_DEBT: 'بدهی حقوقی',
  STREAK_CLAIMED: 'استریک روزانه',
  OVERTIME_WORKED: 'اضافه‌کاری',
  RENT_INCOME: 'درآمد اجاره',
  PROJECT_STARTED: 'آغاز پروژهٔ شهری',
  PROJECT_COMPLETED: 'تکمیل پروژه شهری',
  LOTTERY_TICKET: 'خرید بلیت قرعه‌کشی',
  LOTTERY_WON: 'برنده قرعه‌کشی',
  ELECTION_WON: 'برنده انتخابات',
  ITEM_SOLD: 'فروش کالا',
  PLAYER_REFERRED: 'معرفی بازیکن',
  QUEST_COMPLETED: 'کارت روزانه',
  WEEKLY_CHEST: 'صندوق هفته',
  MEDICAL_TREATMENT: 'درمان در درمانگاه',
  DEPOSIT_MATURED: 'سررسید سپرده',
  TRAVEL_STAMP: 'مُهر سفر',
  MARRIAGE_REGISTERED: 'ازدواج',
  DIVORCE_REGISTERED: 'طلاق',
  WIDOWHOOD_REGISTERED: 'فوت همسر',
  PET_ADOPTED: 'سرپرستی حیوان',
  PET_FED: 'غذای حیوان',
  PET_PLAY: 'وقتِ گذراندن با حیوان',
  PET_GIFT: 'هدیهٔ حیوان',
  STOCK_TRANSACTION: 'معامله بورس',
  AUCTION_WON: 'برنده حراجی',
  GYM_SUBSCRIBED: 'عضویت باشگاه',
  P2P_LOAN_SETTLED: 'تسویه قرض بازیکنی',
  FARM_HARVESTED: 'برداشت محصول',
  ITEM_CRAFTED: 'ساخت در کارگاه',
  CHALLENGE_COMPLETED: 'چالش منطقه کامل شد',
  WILL_UPDATED: 'وصیت به‌روز شد',
  WILL_CANCELLED: 'وصیت لغو شد',
  PLAYER_DIED: 'فوت شخصیت',
  INHERITANCE_SETTLED: 'انتقال میراث',
  BRANCH_OPENED: 'افتتاح شعبه',
  MAYOR_POLICY_SET: 'سیاست شهردار',
  NEWS_AD_PUBLISHED: 'آگهی همگانی',
  LOAN_DEFAULTED: 'نکول وام بانکی'
}

/**
 * ثبت رخدادهای مهم بازی.
 * این سرویس هم منبع «تاریخچه» بازیکن است و هم منبع «خبر» منطقه.
 * تنها رخدادهای معنادار ثبت می‌شوند؛ تغییرات کوچک (مثل خستگی ۳۱ به ۳۲) ثبت نمی‌شوند.
 */
export class EventService {
  constructor(private readonly db: PrismaClient) {}

  private priorityOf(type: GameEventType, override?: number): number {
    if (override !== undefined) return Math.min(5, Math.max(1, override))
    return DEFAULT_PRIORITY[type] ?? 1
  }

  /** ثبت رخداد بازیکن. در صورت تکرار dedupeKey، رخداد دوباره ثبت نمی‌شود. */
  async recordPlayerEvent(input: RecordPlayerEventInput): Promise<void> {
    await this.safeCreate({
      scope: EventScope.PLAYER,
      type: input.type,
      priority: this.priorityOf(input.type),
      playerId: input.playerId,
      title: input.title,
      detail: input.detail ?? null,
      amount: input.amount ?? null,
      dedupeKey: input.dedupeKey ?? null
    })
  }

  /** ثبت رخداد منطقه (منبع خبر). */
  async recordRegionEvent(input: RecordRegionEventInput): Promise<void> {
    await this.safeCreate({
      scope: EventScope.REGION,
      type: input.type,
      priority: this.priorityOf(input.type, input.priority),
      groupId: input.groupId,
      title: input.title,
      detail: input.detail ?? null,
      amount: input.amount ?? null,
      dedupeKey: input.dedupeKey ?? null
    })
  }

  private async safeCreate(data: {
    scope: EventScope
    type: GameEventType
    priority: number
    playerId?: string
    groupId?: string
    title: string
    detail: string | null
    amount: number | null
    dedupeKey: string | null
  }): Promise<void> {
    try {
      await this.db.gameEvent.create({ data })
    } catch {
      // نقض unique روی dedupeKey یعنی رخداد قبلاً ثبت شده؛ بی‌خطر نادیده گرفته می‌شود.
      // ثبت رخداد هرگز نباید مسیر اصلی Gameplay را بشکند.
    }
  }

  /** تاریخچهٔ بازیکن با صفحه‌بندی و امکان فیلتر بر اساس نوع. */
  async getPlayerHistory(
    playerId: string,
    page = 0,
    types?: GameEventType[]
  ): Promise<HistoryPage> {
    const where = {
      playerId,
      ...(types && types.length > 0 ? { type: { in: types } } : {})
    }

    const [total, rows] = await Promise.all([
      this.db.gameEvent.count({ where }),
      this.db.gameEvent.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: Math.max(0, page) * HISTORY_PAGE_SIZE,
        take: HISTORY_PAGE_SIZE,
        select: {
          id: true,
          type: true,
          title: true,
          detail: true,
          amount: true,
          createdAt: true
        }
      })
    ])

    return {
      entries: rows.map((r) => ({
        id: r.id,
        type: r.type,
        title: r.title,
        detail: r.detail,
        amount: r.amount === null ? null : Number(r.amount),
        createdAt: r.createdAt
      })),
      page: Math.max(0, page),
      pageSize: HISTORY_PAGE_SIZE,
      total
    }
  }

  /** پاکسازی رخدادهای قدیمی تا دیتابیس بی‌نهایت رشد نکند. */
  async pruneOldEvents(olderThanDays = 60): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000)
    const result = await this.db.gameEvent.deleteMany({
      where: { createdAt: { lt: cutoff }, priority: { lt: 4 } }
    })
    return result.count
  }
}
