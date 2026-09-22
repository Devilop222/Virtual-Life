import { GameEventType, PrismaClient } from '@prisma/client'
import { NotFoundError } from '../../utils/classes/errors'
import { EventService } from '../events/event.service'

export interface StampView {
  groupTitle: string
  environmentLevel: string
  stampedAt: Date
}

export interface PassportBoard {
  stamps: StampView[]
  total: number
  travelerTarget: number
}

/** تعداد مُهر لازم برای نشان «جهانگرد». */
const TRAVELER_TARGET = 5

/**
 * گذرنامهٔ سفر.
 *
 * چرا لازم است: سفر (حضور در منطقهٔ دیگر) از قبل ثبت می‌شد ولی هیچ اثر یا
 * یادگاری نداشت؛ مناطق برای بازیکن فقط یک عدد بودند. مُهر سفر انگیزهٔ دیدن
 * مناطق تازه را می‌سازد و به نشان «جهانگرد» وصل می‌شود.
 *
 * هزینهٔ اجرایی: یک `create` با `skipDuplicates`‌مانند (خطای Unique نادیده
 * گرفته می‌شود) فقط در اولین حضور هر منطقه. مسیر داغ پیام‌ها سنگین نمی‌شود.
 */
export class PassportService {
  constructor(
    private readonly db: PrismaClient,
    private readonly eventService: EventService
  ) {}

  /**
   * ثبت مُهر برای اولین حضور در یک منطقه.
   * `true` یعنی مُهر تازه ثبت شد (برای نمایش پنل جشن).
   */
  async stamp(playerId: string, groupId: string): Promise<boolean> {
    try {
      await this.db.travelStamp.create({ data: { playerId, groupId } })
    } catch {
      // این منطقه قبلاً مُهر خورده است
      return false
    }

    const group = await this.db.group.findUnique({
      where: { id: groupId },
      select: { title: true }
    })

    await this.eventService
      .recordPlayerEvent({
        playerId,
        type: GameEventType.TRAVEL_STAMP,
        title: `مُهر سفر: ${group?.title ?? 'منطقهٔ تازه'}`,
        dedupeKey: `stamp:${playerId}:${groupId}`
      })
      .catch(() => undefined)

    return true
  }

  /** گذرنامهٔ بازیکن. */
  async getBoard(telegramUserId: bigint): Promise<PassportBoard> {
    const player = await this.db.player.findUnique({
      where: { telegramUserId },
      select: { id: true }
    })
    if (!player) {
      throw new NotFoundError('Player not found')
    }

    const rows = await this.db.travelStamp.findMany({
      where: { playerId: player.id },
      orderBy: { stampedAt: 'asc' },
      select: {
        stampedAt: true,
        group: { select: { title: true, environmentLevel: true } }
      }
    })

    return {
      stamps: rows.map((row) => ({
        groupTitle: row.group.title,
        environmentLevel: row.group.environmentLevel,
        stampedAt: row.stampedAt
      })),
      total: rows.length,
      travelerTarget: TRAVELER_TARGET
    }
  }
}

export const PASSPORT_INFO = { travelerTarget: TRAVELER_TARGET } as const
