import { NotificationStatus, PrismaClient } from '@prisma/client'
import { logger } from '../../utils/logger'

export interface RetentionResult {
  expiredUserStates: number
  oldEvents: number
  staleRankingSnapshots: number
  oldNotifications: number
  totalRemoved: number
}

/** سنِ حذفِ اعلان‌های خوانده‌شده — ۳۰ روز واقعی. */
export const READ_NOTIFICATION_TTL_DAYS = 30

/**
 * سقفِ سنِ اعلان‌های **ناخوانده** — ۱۸۰ روز واقعی.
 *
 * چرا ناخوانده‌ها هم در نهایت پاک می‌شوند؟ چون تختهٔ اعلان صندوقِ ورودی است،
 * نه سابقهٔ حسابداری: بازیکنی که شش ماه بازی را ترک کرده نباید هزاران ردیفِ
 * منقضی با خود بکشد. سابقهٔ مالی/مالکیت/ امنیتی جای دیگری است و دست‌نخورده
 * می‌ماند (`financial_transactions` و `admin_logs` هرگز پاک نمی‌شوند).
 */
export const UNREAD_NOTIFICATION_TTL_DAYS = 180

/**
 * سیاست نگهداری داده (Data Retention).
 *
 * داده‌های موقت و فنی پس از مدتی حذف می‌شوند تا دیتابیس بی‌نهایت رشد نکند.
 * داده‌های حیاتی هرگز حذف نمی‌شوند:
 *  - FinancialTransaction (حسابداری و Audit مالی)
 *  - AdminLog (رد اقدامات مدیریتی)
 *  - Migration (سابقهٔ اقامت)
 *  - Property / Business / Loan / BankAccount (مالکیت و تعهدات)
 *  - Player و رخدادهای مهم (اولویت ۴ و بالاتر)
 */
export class RetentionService {
  constructor(private readonly db: PrismaClient) {}

  /**
   * پاکسازی Stateهای موقت کاربر که رهاشده‌اند.
   * جریان ورودیِ یک‌مرحله‌ای بعد از مهلتش بی‌فایده است؛ اما ثبت‌نام
   * چندمرحله‌ای و ازسرگیری‌شدنی است، پس مهلت ۷ روزه دارد (و در ادامه
   * مسیرِ TTL در text.handler هیچ پیام عادی‌ای را نمی‌دزدد).
   */
  async pruneUserStates(olderThanHours = 12): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanHours * 60 * 60 * 1000)
    const registrationCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    const result = await this.db.userState.deleteMany({
      where: {
        OR: [
          { updatedAt: { lt: cutoff }, NOT: { currentContext: 'registration' } },
          { updatedAt: { lt: registrationCutoff }, currentContext: 'registration' }
        ]
      }
    })
    return result.count
  }

  /** پاکسازی رخدادهای کم‌اهمیت قدیمی (رخدادهای مهم نگه داشته می‌شوند). */
  async pruneOldEvents(olderThanDays = 45): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000)
    const result = await this.db.gameEvent.deleteMany({
      where: { createdAt: { lt: cutoff }, priority: { lt: 4 } }
    })
    return result.count
  }

  /** پاکسازی Snapshotهای رتبه‌بندی منقضی (قابل بازسازی هستند). */
  async pruneRankingSnapshots(olderThanDays = 3): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000)
    const result = await this.db.rankingSnapshot.deleteMany({
      where: { computedAt: { lt: cutoff } }
    })
    return result.count
  }

  /**
   * پاک‌سازی اعلان‌های منقضی — تنها جدولِ بی‌سقفِ بازی.
   *
   * دو بازهٔ جدا: خوانده‌شده‌ها زودتر می‌روند (۳۰ روز) و ناخوانده‌ها دیرتر
   * (۱۸۰ روز). هیچ ردیفِ تازه‌ای که بازیکن هنوز ندیده است در چرخهٔ اول پاک نمی‌شود.
   */
  async pruneNotifications(
    readOlderThanDays = READ_NOTIFICATION_TTL_DAYS,
    unreadOlderThanDays = UNREAD_NOTIFICATION_TTL_DAYS
  ): Promise<number> {
    const readCutoff = new Date(Date.now() - readOlderThanDays * 24 * 60 * 60 * 1000)
    const unreadCutoff = new Date(Date.now() - unreadOlderThanDays * 24 * 60 * 60 * 1000)

    const result = await this.db.notification.deleteMany({
      where: {
        OR: [
          { status: NotificationStatus.READ, createdAt: { lt: readCutoff } },
          { createdAt: { lt: unreadCutoff } }
        ]
      }
    })
    return result.count
  }

  /** اجرای کامل سیاست نگهداری؛ خطای هر مرحله مانع بقیه نمی‌شود. */
  async runAll(): Promise<RetentionResult> {
    const expiredUserStates = await this.pruneUserStates().catch((error) => {
      logger.warn({ err: error }, 'retention: userState prune failed')
      return 0
    })
    const oldEvents = await this.pruneOldEvents().catch((error) => {
      logger.warn({ err: error }, 'retention: gameEvent prune failed')
      return 0
    })
    const staleRankingSnapshots = await this.pruneRankingSnapshots().catch((error) => {
      logger.warn({ err: error }, 'retention: rankingSnapshot prune failed')
      return 0
    })
    const oldNotifications = await this.pruneNotifications().catch((error) => {
      logger.warn({ err: error }, 'retention: notification prune failed')
      return 0
    })

    const totalRemoved =
      expiredUserStates + oldEvents + staleRankingSnapshots + oldNotifications

    if (totalRemoved > 0) {
      logger.info(
        { expiredUserStates, oldEvents, staleRankingSnapshots, oldNotifications },
        'retention cycle completed'
      )
    }

    return {
      expiredUserStates,
      oldEvents,
      staleRankingSnapshots,
      oldNotifications,
      totalRemoved
    }
  }
}
