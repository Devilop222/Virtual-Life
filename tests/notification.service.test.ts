import { NotificationStatus, NotificationType, Prisma, PrismaClient } from '@prisma/client'
import { NotificationService } from '../src/modules/notification/notification.service'
import { NotificationRepository } from '../src/database/repositories/notification.repository'
import { PlayerRepository } from '../src/database/repositories/player.repository'
import { NotFoundError } from '../src/utils/classes/errors'

/**
 * مرزهای اعلان.
 *
 * سنجهٔ اصلی این فایل «مسیرِ یکتا» است: ردیف‌های اعلان فقط از
 * `NotificationRepository` رد می‌شوند. سرویس پیش‌تر خودش مستقیم به
 * `db.notification` می‌نوشت و همان کلاس بدون هیچ فراخوان مانده بود — یعنی
 * دو راهِ موازی برای یک جدول که می‌توانستند از هم جدا بیفتند.
 */
describe('NotificationService', () => {
  let notificationRepository: {
    create: jest.Mock
    listByPlayerId: jest.Mock
    countByPlayer: jest.Mock
    countUnread: jest.Mock
    markAllRead: jest.Mock
  }
  let playerRepository: { findByTelegramUserId: jest.Mock }
  let db: {
    player: { findUnique: jest.Mock }
    notification: {
      create: jest.Mock
      findMany: jest.Mock
      count: jest.Mock
      updateMany: jest.Mock
    }
  }
  let service: NotificationService

  beforeEach(() => {
    notificationRepository = {
      create: jest.fn(),
      listByPlayerId: jest.fn(),
      countByPlayer: jest.fn(),
      countUnread: jest.fn(),
      markAllRead: jest.fn()
    }
    playerRepository = {
      findByTelegramUserId: jest.fn()
    }
    db = {
      player: { findUnique: jest.fn().mockResolvedValue({ telegramUserId: 42n }) },
      notification: {
        create: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        updateMany: jest.fn()
      }
    }
    service = new NotificationService(
      notificationRepository as unknown as NotificationRepository,
      playerRepository as unknown as PlayerRepository,
      db as unknown as PrismaClient
    )
  })

  test('نوشتنِ تخته از مسیرِ یکتا (repository) رد می‌شود، نه مستقیم از کلاینت', async () => {
    notificationRepository.create.mockResolvedValue({ id: 'notif-2' })

    const created = await service.notifyPlayerById(
      'player-1',
      'هشدار',
      'سلامتت کم است',
      NotificationType.WARNING,
      'health-warn:player-1:1'
    )

    expect(created).toBe(true)
    expect(notificationRepository.create).toHaveBeenCalledWith({
      playerId: 'player-1',
      title: 'هشدار',
      message: 'سلامتت کم است',
      type: NotificationType.WARNING,
      dedupeKey: 'health-warn:player-1:1'
    })
    // رگرسیونِ مسیرِ یکتا: هیچ نوشتارِ مستقیمی روی جدول اعلان نباشد
    expect(db.notification.create).not.toHaveBeenCalled()
    expect(db.notification.updateMany).not.toHaveBeenCalled()
  })

  test('بدون کلید ضدتکرار هم همان مسیرِ یکتا استفاده می‌شود', async () => {
    notificationRepository.create.mockResolvedValue({ id: 'notif-3' })

    await service.notifyPlayerById('player-1', 'خبر', 'متن')

    expect(notificationRepository.create).toHaveBeenCalledWith({
      playerId: 'player-1',
      title: 'خبر',
      message: 'متن',
      type: NotificationType.INFO,
      dedupeKey: undefined
    })
  })

  test('تصادم کلید یکتا (P2002) بی‌صدا است و نوشتنِ دوباره گزارش نمی‌شود', async () => {
    notificationRepository.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('unique constraint', {
        code: 'P2002',
        clientVersion: '6.19.3'
      })
    )

    await expect(
      service.notifyPlayerById('player-1', 't', 'm', NotificationType.INFO, 'dup')
    ).resolves.toBe(false)
  })

  test('خطای واقعیِ دیتابیس پنهان نمی‌شود', async () => {
    notificationRepository.create.mockRejectedValue(new Error('connection lost'))

    await expect(
      service.notifyPlayerById('player-1', 't', 'm', NotificationType.INFO, 'dup')
    ).rejects.toThrow('connection lost')
  })

  test('تخته پرچم و شمارِ ناخوانده‌ها را درست گزارش می‌کند', async () => {
    playerRepository.findByTelegramUserId.mockResolvedValue({ id: 'player-1' })
    notificationRepository.listByPlayerId.mockResolvedValue([
      {
        id: 'n1',
        title: 'یک',
        message: 'م۱',
        type: NotificationType.EVENT,
        status: NotificationStatus.PENDING,
        createdAt: new Date()
      },
      {
        id: 'n2',
        title: 'دو',
        message: 'م۲',
        type: NotificationType.INFO,
        status: NotificationStatus.READ,
        createdAt: new Date()
      }
    ])
    notificationRepository.countUnread.mockResolvedValue(1)
    notificationRepository.countByPlayer.mockResolvedValue(2)

    const board = await service.getBoard(42n)

    expect(board.items.map((item) => item.unread)).toEqual([true, false])
    expect(board.unreadCount).toBe(1)
    expect(board.total).toBe(2)
    expect(db.notification.findMany).not.toHaveBeenCalled()
    expect(db.notification.count).not.toHaveBeenCalled()
  })

  test('خوانده‌شدنِ کل از repository می‌آید و تعداد واقعی را برمی‌گرداند', async () => {
    playerRepository.findByTelegramUserId.mockResolvedValue({ id: 'player-1' })
    notificationRepository.markAllRead.mockResolvedValue(3)

    await expect(service.markAllAsRead(42n)).resolves.toBe(3)
    expect(notificationRepository.markAllRead).toHaveBeenCalledWith('player-1')
    expect(db.notification.updateMany).not.toHaveBeenCalled()
  })

  test('بازیکنِ ناشناس باعث خطای دامنه می‌شود، نه نوشتارِ بی‌صاحب', async () => {
    playerRepository.findByTelegramUserId.mockResolvedValue(null)

    await expect(service.getBoard(42n)).rejects.toThrow(NotFoundError)
    await expect(service.markAllAsRead(42n)).rejects.toThrow(NotFoundError)
    expect(notificationRepository.markAllRead).not.toHaveBeenCalled()
  })
})
