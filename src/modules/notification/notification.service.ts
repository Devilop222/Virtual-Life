import { NotificationStatus, NotificationType, Prisma, PrismaClient } from '@prisma/client'
import { NotificationRepository } from '../../database/repositories/notification.repository'
import { PlayerRepository } from '../../database/repositories/player.repository'
import { NotFoundError } from '../../utils/classes/errors'
import { logger } from '../../utils/logger'
import {
  type NotificationLevel,
  pushPrivateMessage,
  pushedToChat,
  storedInBoard
} from './push'

export interface NotificationView {
  id: string
  title: string
  message: string
  type: NotificationType
  unread: boolean
  createdAt: Date
}

export interface NotificationBoard {
  items: NotificationView[]
  unreadCount: number
  total: number
}

export class NotificationService {
  constructor(
    private readonly notificationRepository: NotificationRepository,
    private readonly playerRepository: PlayerRepository,
    private readonly db: PrismaClient
  ) {}

  /**
   * ثبت اعلان با شناسهٔ داخلی بازیکن و کلید یکتای اختیاری.
   *
   * `dedupeKey` تنها ضامن «یک اعلان برای یک رخداد» است؛ تصادم Unique بی‌خطر
   * نادیده گرفته می‌شود تا تولیدکنندهٔ اعلان هرگز نشکند.
   */
  async notifyPlayerById(
    playerId: string,
    title: string,
    message: string,
    type: NotificationType = NotificationType.INFO,
    dedupeKey?: string,
    level?: NotificationLevel
  ): Promise<boolean> {
    // سطحِ INTERNAL هرگز ذخیره نمی‌شود؛ رخدادِ داخلی بازی خبر نیست.
    if (level === 'INTERNAL') {
      return false
    }
    const written = await this.writeBoard(playerId, title, message, type, dedupeKey)
    if (!level) {
      // رفتار پیش‌فرض و قدیمی: فقط تخته، بدون مزاحمت در چت خصوصی
      return written
    }
    if (!pushedToChat(level)) {
      return written
    }
    // ضدتکرار باید روی **هر دو کانال** اثر کند: اگر ردیف تخته ساخته نشد یعنی
    // این رخداد پیش‌تر اعلام شده، پس پیام خصوصی هم نباید دوباره برود.
    // وگرنه بازیکن برای یک اتفاق دو بار پیام می‌گیرد.
    if (!written) {
      return false
    }
    const player = await this.db.player
      .findUnique({ where: { id: playerId }, select: { telegramUserId: true } })
      .catch(() => null)
    if (!player) {
      return written
    }
    await pushPrivateMessage(
      player.telegramUserId,
      renderPushCard({
        icon: notificationTypeIcons[type],
        title,
        lines: message.split('\n')
      })
    )
    return written
  }

  /** نوشتن ردیف تخته با کلید ضدتکرار؛ `true` یعنی ردیف تازه ساخته شد. */
  private async writeBoard(
    playerId: string,
    title: string,
    message: string,
    type: NotificationType,
    dedupeKey?: string
  ): Promise<boolean> {
    try {
      await this.notificationRepository.create({ playerId, title, message, type, dedupeKey })
      return true
    } catch (error) {
      // فقط تصادم کلید یکتا «بی‌صدا» است؛ بقیهٔ خطاها Log می‌شوند
      // (فراخوان‌دهنده‌ها آتش‌وبفرست‌اند، پس آخرین جای صادقِ ثبت خطا همین‌جاست)
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return false
      }
      logger.error({ err: error, playerId, title }, 'notification create failed')
      throw error
    }
  }

  /**
   * ارسال فقط-کانالِ پیام خصوصی برای اعلانی که **پیش‌تر در تخته ثبت شده**
   * است.
   *
   * چرا لازم شد؟ در بعضی مسیرها نوشتنِ تخته باید داخل تراکنشِ همان عمل انجام
   * شود (مثلاً «پاسخ ادمین» و «بستن گزارش» که باید اتمیک با گزارش ثبت شوند).
   * اگر آن‌جا `announce` صدا زده شود، یک ردیفِ تکراری در تخته ساخته می‌شود.
   * این متد فقط Push را می‌فرستد و هرگز پرتاب نمی‌کند.
   */
  async pushByPlayerId(
    playerId: string,
    title: string,
    message: string,
    type: NotificationType = NotificationType.INFO
  ): Promise<boolean> {
    const player = await this.db.player
      .findUnique({ where: { id: playerId }, select: { telegramUserId: true } })
      .catch(() => null)
    if (!player) {
      return false
    }
    return pushPrivateMessage(
      player.telegramUserId,
      renderPushCard({
        icon: notificationTypeIcons[type],
        title,
        lines: message.split('\n')
      })
    )
  }

  /** تختهٔ اعلان‌ها با شمار ناخوانده. */
  async getBoard(telegramUserId: bigint, limit = 10): Promise<NotificationBoard> {
    const player = await this.playerRepository.findByTelegramUserId(telegramUserId)
    if (!player) {
      throw new NotFoundError('Player not found')
    }

    const [rows, unreadCount, total] = await Promise.all([
      this.notificationRepository.listByPlayerId(player.id, limit),
      this.notificationRepository.countUnread(player.id),
      this.notificationRepository.countByPlayer(player.id)
    ])

    return {
      items: rows.map((row) => ({
        id: row.id,
        title: row.title,
        message: row.message,
        type: row.type,
        unread: row.status !== NotificationStatus.READ,
        createdAt: row.createdAt
      })),
      unreadCount,
      total
    }
  }

  /**
   * خوانده‌شدن همهٔ اعلان‌های بازیکن.
   *
   * تنها نوشتاری که پنل اعلان‌ها انجام می‌دهد: یک یادداشتِ خوانده‌شدن روی
   * اعلان‌های **خودِ** بازیکن. هیچ دارایی/وضعیت بازی را تغییر نمی‌دهد، پس
   * برای حسابِ مسدود یا پایان‌یافته هم بی‌خطر است.
   */
  async markAllAsRead(telegramUserId: bigint): Promise<number> {
    const player = await this.playerRepository.findByTelegramUserId(telegramUserId)
    if (!player) {
      throw new NotFoundError('Player not found')
    }

    return this.notificationRepository.markAllRead(player.id)
  }

  /**
   * مسیرِ واحدِ اعلامِ یک اتفاقِ مهم به بازیکن.
   *
   * یک فراخوانی، دو کانال، یک سیاست (`push.ts`):
   *  • تختهٔ اعلان — برای هر سطحی جز INTERNAL (با `dedupeKey` ضدتکرار).
   *  • پیام خصوصی — فقط CRITICAL و IMPORTANT.
   *
   * هرگز پرتاب نمی‌کند: اعلان، قابلیتِ جانبیِ یک عملیات است و نباید
   * تراکنشی را که پول را جابه‌جا کرده برگرداند.
   *
   * @returns آیا پیام خصوصی واقعاً تحویل شد (برای متنِ تأییدِ سمتِ فرستنده).
   */
  async announce(input: {
    playerId: string
    title: string
    message: string
    type?: NotificationType
    level: NotificationLevel
    dedupeKey?: string
  }): Promise<boolean> {
    const type = input.type ?? NotificationType.INFO

    let stored = true
    if (storedInBoard(input.level)) {
      // نوشتنِ تخته پیش از push: اگر push شکست خورد (بلاک/چتِ باز نشده)،
      // بازیکن هنوز همان متن را در «اعلان‌ها» می‌بیند.
      try {
        stored = await this.notifyPlayerById(
          input.playerId,
          input.title,
          input.message,
          type,
          input.dedupeKey
        )
      } catch (error) {
        logger.error({ err: error, playerId: input.playerId }, 'announce board write failed')
        return false
      }
    }

    if (!pushedToChat(input.level)) {
      return false
    }
    // `dedupeKey` تکراری → این رخداد قبلاً اعلام شده؛ پیام خصوصی هم نرو.
    if (!stored) {
      return false
    }

    const player = await this.db.player
      .findUnique({ where: { id: input.playerId }, select: { telegramUserId: true } })
      .catch(() => null)
    if (!player) {
      return false
    }
    return pushPrivateMessage(
      player.telegramUserId,
      renderPushCard({ icon: notificationTypeIcons[type], title: input.title, lines: input.message.split('\n') })
    )
  }
}

/**
 * قالبِ پیامِ خصوصیِ اعلان — همان زبانِ بصریِ پنل‌ها، بدون کیبورد.
 * جدا از `bot/ui-kit` تا لایهٔ سرویس به لایهٔ تلگرام وابسته نشود.
 */
export function renderPushCard(input: { icon: string; title: string; lines: string[] }): string {
  const body = input.lines.filter((line) => line.length > 0).join('\n')
  return `${input.icon} *${input.title}*\n\n${body}`
}

export const notificationTypeLabels: Record<NotificationType, string> = {
  [NotificationType.INFO]: 'اطلاعیه',
  [NotificationType.EVENT]: 'رویداد',
  [NotificationType.WARNING]: 'هشدار',
  [NotificationType.SYSTEM]: 'سیستم'
}

export const notificationTypeIcons: Record<NotificationType, string> = {
  [NotificationType.INFO]: 'ℹ️',
  [NotificationType.EVENT]: '🎉',
  [NotificationType.WARNING]: '⚠️',
  [NotificationType.SYSTEM]: '🛠️'
}
