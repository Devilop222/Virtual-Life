import { Notification, NotificationStatus, NotificationType, PrismaClient } from '@prisma/client'

export interface CreateNotificationInput {
  playerId: string
  title: string
  message: string
  type?: NotificationType
  /**
   * کلید یکتای رخداد. تصادم آن **دادهٔ** تکراری را رد می‌کند؛ تصمیمِ
   * «تصادم بی‌صدا باشد یا نه» سیاستِ سرویس است، نه این‌جا.
   */
  dedupeKey?: string
}

/**
 * دسترسیِ داده‌ای اعلان‌ها.
 *
 * چرا این کلاس لازم است و صرفاً یک لایهٔ اضافه نیست؟ همهٔ ردیف‌های اعلان از
 * یک مسیر نوشته و خوانده می‌شوند: `NotificationService`. پیش‌تر سرویس خودش
 * مستقیم به Prisma می‌نوشت و این کلاس بدون هیچ فراخوانِ تولیدی مانده بود —
 * یعنی دو راهِ موازی برای همان جدول. حالا یک راه هست.
 *
 * متدهای «صفِ تحویل» (`listPending`/`updateStatus`) حذف شدند: ارسال واقعی
 * همیشه درون‌خطی و در `push.ts` انجام می‌شود و هیچ مصرف‌کننده‌ای نداشتند؛
 * نگه‌داشتنشان یعنی سه وضعیتِ `PENDING`/`SENT`/`FAILED` که هیچ‌کس نمی‌نویسد.
 */
export class NotificationRepository {
  constructor(private readonly db: PrismaClient) {}

  async create(input: CreateNotificationInput): Promise<Notification> {
    return this.db.notification.create({
      data: {
        playerId: input.playerId,
        title: input.title,
        message: input.message,
        type: input.type ?? NotificationType.INFO,
        ...(input.dedupeKey ? { dedupeKey: input.dedupeKey } : {})
      }
    })
  }

  async listByPlayerId(playerId: string, limit = 20, offset = 0): Promise<Notification[]> {
    return this.db.notification.findMany({
      where: { playerId },
      take: limit,
      skip: offset,
      orderBy: { createdAt: 'desc' }
    })
  }

  async countByPlayer(playerId: string): Promise<number> {
    return this.db.notification.count({ where: { playerId } })
  }

  async countUnread(playerId: string): Promise<number> {
    return this.db.notification.count({
      where: { playerId, status: { not: NotificationStatus.READ } }
    })
  }

  /**
   * خوانده‌شدنِ همهٔ اعلان‌های بازیکن با یک Query.
   *
   * `status: { not: READ }` عمدی است: ردیف‌های خوانده‌شده دست‌نخورده می‌مانند
   * تا `readAt`شان (که ترتیب خواندن را نگه می‌دارد) بازنویسی نشود.
   */
  async markAllRead(playerId: string): Promise<number> {
    const result = await this.db.notification.updateMany({
      where: { playerId, status: { not: NotificationStatus.READ } },
      data: { status: NotificationStatus.READ, readAt: new Date() }
    })
    return result.count
  }
}
