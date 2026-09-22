import { EventScope, GameEventType, Prisma, PrismaClient, TransactionType } from '@prisma/client'
import { ConflictError, NotFoundError, ValidationError } from '../../utils/classes/errors'
import { dayIndex } from '../../utils/game-time'

/** هزینهٔ انتشار هر آگهی همگانی (Sink). */
export const NEWS_AD_FEE = 2_000_000
/** حداکثر طول متن آگهی. */
const MAX_AD_LENGTH = 90

/**
 * آگهی همگانی بازیکنان.
 *
 * بازیکن با پرداخت هزینه، پیام کوتاه خود را وارد جریان خبرهای منطقه می‌کند؛
 * مسیر `NewsService.claimForChat` آن را در گروه منتشر می‌کند (اولویت ۴).
 * کلید یکتای روزانه از اسپم جلوگیری می‌کند و هزینهٔ سنگین مانع آلودگی خبر می‌شود.
 */
export class AdService {
  constructor(private readonly db: PrismaClient) {}

  /** پاک‌سازی متن آگهی. */
  private sanitize(raw: string): string {
    return raw.replace(/\s+/g, ' ').trim()
  }

  /** انتشار آگهی همگانی در منطقه. */
  async publish(
    telegramUserId: bigint,
    text: string,
    groupId: string | null
  ): Promise<{ text: string; fee: number }> {
    const clean = this.sanitize(text)
    if (clean.length < 5) {
      throw new ValidationError('Too short', 'متن آگهی دست‌کم ۵ حرف باشد.')
    }
    if (clean.length > MAX_AD_LENGTH) {
      throw new ValidationError(
        'Too long',
        `متن آگهی حداکثر ${MAX_AD_LENGTH.toLocaleString('fa-IR')} حرف می‌تواند باشد.`
      )
    }

    const player = await this.db.player.findUnique({
      where: { telegramUserId },
      select: { id: true, homeGroupId: true, firstName: true }
    })
    if (!player) {
      throw new NotFoundError('Player not found')
    }

    const targetGroupId = groupId ?? player.homeGroupId
    if (!targetGroupId) {
      throw new ConflictError(
        'No target region',
        'آگهی باید در یک منطقهٔ فعال منتشر شود.'
      )
    }

    const group = await this.db.group.findFirst({
      where: { id: targetGroupId, status: 'ACTIVE' },
      select: { id: true }
    })
    if (!group) {
      throw new ConflictError('Region inactive', 'منطقهٔ مقصد فعال نیست.')
    }

    const dedupeKey = `ad:${player.id}:${dayIndex()}`

    // کسر هزینه و ثبت خبر در «یک» تراکنش: اگر کلید یکتا جلوی آگهی دوم روزانه را
    // بگیرد، تراکنش برمی‌گردد و پول کاربر نمی‌سوزد (پیش‌تر هزینه جدا کسر می‌شد
    // و رخداد جدا —با خطای خورده‌شده— ثبت می‌شد؛ یعنی آگهی دوم پول می‌گرفت اما منتشر نمی‌شد).
    try {
      await this.db.$transaction(async (tx) => {
        const debited = await tx.player.updateMany({
          where: { id: player.id, balance: { gte: NEWS_AD_FEE } },
          data: { balance: { decrement: NEWS_AD_FEE } }
        })
        if (debited.count !== 1) {
          throw new ConflictError(
            'Insufficient balance',
            `انتشار آگهی ${NEWS_AD_FEE.toLocaleString('fa-IR')} تومان هزینه دارد.`
          )
        }

        await tx.financialTransaction.create({
          data: {
            amount: NEWS_AD_FEE,
            type: TransactionType.NEWS_AD_FEE,
            sourcePlayerId: player.id,
            reference: 'هزینهٔ آگهی همگانی'
          }
        })

        // رخداد با publishedAt خالی: claimForChat آن را به گروه می‌برد
        await tx.gameEvent.create({
          data: {
            scope: EventScope.REGION,
            type: GameEventType.NEWS_AD_PUBLISHED,
            priority: 4,
            groupId: group.id,
            title: `📣 آگهی ${player.firstName}`,
            detail: clean,
            dedupeKey
          }
        })
      })
    } catch (error) {
      // نقض کلید یکتا = آگهی امروز قبلاً منتشر شده؛ تراکنش برگشته و پول کسر نشده است.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictError(
          'Ad already published today',
          'امروز یک آگهی منتشر کرده‌ای؛ فردا دوباره می‌توانی آگهی بدهی.'
        )
      }
      throw error
    }

    return { text: clean, fee: NEWS_AD_FEE }
  }
}

export const AD_INFO = { fee: NEWS_AD_FEE, maxLength: MAX_AD_LENGTH } as const
