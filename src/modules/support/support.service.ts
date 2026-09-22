import { PlayerReportCategory, PlayerReportStatus, PrismaClient } from '@prisma/client'
import { ConflictError, NotFoundError, ValidationError } from '../../utils/classes/errors'
import { plainInput } from '../../utils/validation'

/**
 * سقف و کفِ متنِ گزارش و پاسخ.
 *
 * چرا اعداد کوچکِ «کف»؟ یک گزارشِ یک‌حرفی («؟») نه قابل پیگیری است و نه
 * قابل پاسخ؛ حداقلِ معقول، ادمین را از خواندنِ صفِ بی‌محتوا نجات می‌دهد.
 */
export const REPORT_BODY_LIMITS = { min: 10, max: 700 } as const
export const REPORT_ANSWER_LIMITS = { min: 3, max: 700 } as const

/**
 * سقفِ گزارش‌های بازِ همزمانِ یک بازیکن.
 *
 * بدون این سقف، یک بازیکنِ عصبانی می‌تواند با چند ده گزارشِ پشت‌سرهم صف را
 * بی‌مصرف کند؛ با سقف، مسیرِ «بسته‌شدن/پاسخ‌گرفتن گزارشِ قبلی» باز می‌ماند
 * و صف برای بقیه قابل استفاده می‌ماند.
 */
export const OPEN_REPORT_CAP = 3

export const reportCategoryLabels: Record<PlayerReportCategory, string> = {
  BUG: 'ایراد فنی',
  MONEY: 'مشکل مالی',
  BEHAVIOR: 'رفتار بازیکن',
  OTHER: 'سایر'
}

export const reportStatusLabels: Record<PlayerReportStatus, string> = {
  OPEN: 'در انتظار بررسی',
  ANSWERED: 'پاسخ داده‌شده',
  CLOSED: 'بسته‌شده'
}

export interface PlayerReportView {
  id: string
  category: PlayerReportCategory
  body: string
  section: string | null
  status: PlayerReportStatus
  answer: string | null
  answeredAt: Date | null
  createdAt: Date
}

/** یک ردیف گزارش از دید ادمین: متن بازیکن + هویت او. */
export interface AdminReportView extends PlayerReportView {
  playerName: string
  telegramUserId: bigint
}

export interface AdminReportPage {
  items: AdminReportView[]
  total: number
  page: number
  pageSize: number
  openCount: number
}

export const ADMIN_REPORT_PAGE_SIZE = 6

/**
 * سرویس گزارش بازیکن (سمت بازیکن).
 *
 * این سرویس فقط «ثبت و خواندنِ گزارشِ خودِ بازیکن» را انجام می‌دهد. هیچ
 * متدی اینجا قدرتِ تغییرِ اقتصاد، وضعیت یا دادهٔ دیگری را ندارد؛ رسیدگی
 * (پاسخ/بستن) در `AdminService` است تا نگهبانِ ادمین و گزارش مدیریت هرگز
 * دور زده نشود. تفکیکِ عمدی: مسیر بازیکن هرگز نمی‌تواند صفِ مدیریتی را عوض کند.
 */
export class SupportService {
  constructor(private readonly db: PrismaClient) {}

  /** پاک‌سازی و اندازه‌سنجیِ متنِ گزارش؛ همان قاعدهٔ متن‌های آزادِ دیگر. */
  static validateBody(raw: string): string {
    const text = plainInput(raw ?? '')
    if (text.length < REPORT_BODY_LIMITS.min || text.length > REPORT_BODY_LIMITS.max) {
      throw new ValidationError(
        'Report too short',
        `متن گزارش باید بین ${REPORT_BODY_LIMITS.min} و ${REPORT_BODY_LIMITS.max} نویسه باشد.`
      )
    }
    return text
  }

  /**
   * ثبت گزارش تازه.
   *
   * @param section بخشی که بازیکن هنگام گزارش در آن بود (برای عیب‌یابی).
   */
  async submit(
    telegramUserId: bigint,
    category: PlayerReportCategory,
    rawBody: string,
    section?: string | null
  ): Promise<PlayerReportView> {
    const body = SupportService.validateBody(rawBody)
    const player = await this.db.player.findUnique({
      where: { telegramUserId },
      select: { id: true }
    })
    if (!player) {
      throw new NotFoundError(
        'Player not found',
        'برای ثبت گزارش اول باید در چت خصوصی ربات ثبت‌نام کنی.'
      )
    }

    const openCount = await this.db.playerReport.count({
      where: { playerId: player.id, status: PlayerReportStatus.OPEN }
    })
    if (openCount >= OPEN_REPORT_CAP) {
      throw new ConflictError(
        'Too many open reports',
        `همین حالا ${openCount} گزارشِ بی‌پاسخ داری؛ تا رسیدگی‌شان گزارش تازه ثبت نمی‌شود.`
      )
    }

    const created = await this.db.playerReport.create({
      data: {
        playerId: player.id,
        category,
        body,
        section: section ?? null
      },
      select: {
        id: true,
        category: true,
        body: true,
        section: true,
        status: true,
        answer: true,
        answeredAt: true,
        createdAt: true
      }
    })
    return created
  }

  /** گزارش‌های خودِ بازیکن، تازه‌ترین اول — با پاسخِ ادمین اگر داده شده باشد. */
  async listMine(telegramUserId: bigint, limit = 5): Promise<PlayerReportView[]> {
    const player = await this.db.player.findUnique({
      where: { telegramUserId },
      select: { id: true }
    })
    if (!player) {
      return []
    }

    return this.db.playerReport.findMany({
      where: { playerId: player.id },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        category: true,
        body: true,
        section: true,
        status: true,
        answer: true,
        answeredAt: true,
        createdAt: true
      }
    })
  }

}
