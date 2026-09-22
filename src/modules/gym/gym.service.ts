import { GameEventType, PrismaClient, TransactionType } from '@prisma/client'
import { ConflictError, NotFoundError } from '../../utils/classes/errors'
import { EventService } from '../events/event.service'
import { BASE_MAX_HEALTH, GYM_MAX_HEALTH } from '../health/max-health'
import { cycleAmount, daysUntil, gameDays } from '../../utils/game-time'

/**
 * حق اشتراک هفتگی باشگاه (هر دوره ۷ روز *بازی* = ۵٫۶ ساعت واقعی).
 *
 * مبلغ با `cycleAmount` هم‌تراز شده تا هزینهٔ باشگاه در زمان واقعی همان
 * چیزی بماند که بود؛ وگرنه دورهٔ ۳۰ برابر کوتاه‌تر با همان قیمت، یک هزینهٔ
 * ۳۰ برابری می‌شد.
 */
export const GYM_WEEKLY_FEE = cycleAmount(800_000)
/** مدت هر دورهٔ عضویت روی تقویم بازی. */
const MEMBERSHIP_DAYS = 7

export interface GymView {
  isActive: boolean
  expiresAt: Date | null
  daysLeft: number
  weeklyFee: number
  maxHealth: number
  baseMaxHealth: number
}

/**
 * باشگاه ورزشی.
 *
 * عضویت فعال، سقف سلامت را از ۱۰۰ به ۱۲۰ می‌برد؛ یعنی بازیکن می‌تواند پیش از
 * رسیدن به وضعیت بحرانی، شیفت‌های بیشتری کار کند. هزینهٔ ثابت هفتگی در برابر
 * درآمد اضافه، تقریباً متعادل است و هیچ منبع بی‌پایان پول نمی‌سازد.
 *
 * تمدید: از انتهای دورهٔ فعلی محاسبه می‌شود (نه از امروز) تا خرید زودهنگام
 * روزهای عضویت را نسوزاند.
 */
export class GymService {
  constructor(
    private readonly db: PrismaClient,
    private readonly eventService: EventService
  ) {}

  /** عضویت فعال بازیکن (اگر هست). */
  async activeMembership(playerId: string) {
    return this.db.gymMembership.findFirst({
      where: { playerId, expiresAt: { gt: new Date() } },
      orderBy: { expiresAt: 'desc' }
    })
  }

  /** سقف سلامت فعلی بازیکن. */
  /** خرید یا تمدید عضویت. */
  async subscribe(
    telegramUserId: bigint
  ): Promise<{ expiresAt: Date; extended: boolean; fee: number }> {
    const player = await this.db.player.findUnique({
      where: { telegramUserId },
      select: { id: true }
    })
    if (!player) {
      throw new NotFoundError('Player not found')
    }

    const subscription = await this.db.$transaction(async (tx) => {
      // کسر شرطی، نقطهٔ صف‌شدن است: تا این تراکنش تمام نشود، درخواست همزمانِ
      // دوم روی همان ردیفِ بازیکن منتظر می‌ماند.
      const debited = await tx.player.updateMany({
        where: { id: player.id, balance: { gte: GYM_WEEKLY_FEE } },
        data: { balance: { decrement: GYM_WEEKLY_FEE } }
      })
      if (debited.count !== 1) {
        throw new ConflictError(
          'Insufficient balance',
          `حق اشتراک هفتگی ${GYM_WEEKLY_FEE.toLocaleString('fa-IR')} تومان است.`
        )
      }

      // تمدید از مقدارِ *لحظهٔ نوشتن* حساب می‌شود، نه از خواندهٔ پیش از
      // تراکنش. پیش‌تر دو خریدِ همزمان، هر دو از یک مبدأ حساب می‌کردند و در
      // نتیجه دو هفته پول می‌گرفتند و یک هفته تحویل می‌دادند.
      const current = await tx.gymMembership.findFirst({
        where: { playerId: player.id, expiresAt: { gt: new Date() } },
        orderBy: { expiresAt: 'desc' },
        select: { expiresAt: true }
      })
      const base = current ? current.expiresAt.getTime() : Date.now()
      const expiresAt = new Date(base + gameDays(MEMBERSHIP_DAYS))

      await tx.gymMembership.create({
        data: { playerId: player.id, expiresAt }
      })

      await tx.financialTransaction.create({
        data: {
          amount: GYM_WEEKLY_FEE,
          type: TransactionType.GYM_FEE,
          sourcePlayerId: player.id,
          reference: current ? 'تمدید عضویت باشگاه' : 'عضویت باشگاه ورزشی'
        }
      })

      return { expiresAt, extended: Boolean(current) }
    })

    await this.eventService
      .recordPlayerEvent({
        playerId: player.id,
        type: GameEventType.GYM_SUBSCRIBED,
        title: '💪 عضویت باشگاه فعال شد',
        amount: GYM_WEEKLY_FEE,
        dedupeKey: `gym-sub:${player.id}:${subscription.expiresAt.getTime()}`
      })
      .catch(() => undefined)

    return { ...subscription, fee: GYM_WEEKLY_FEE }
  }

  /** نمای پنل باشگاه. */
  async getView(telegramUserId: bigint): Promise<GymView> {
    const player = await this.db.player.findUnique({
      where: { telegramUserId },
      select: { id: true }
    })
    if (!player) {
      throw new NotFoundError('Player not found')
    }

    const membership = await this.activeMembership(player.id)
    const daysLeft = membership ? daysUntil(membership.expiresAt) : 0

    return {
      isActive: Boolean(membership),
      expiresAt: membership?.expiresAt ?? null,
      daysLeft,
      weeklyFee: GYM_WEEKLY_FEE,
      maxHealth: membership ? GYM_MAX_HEALTH : BASE_MAX_HEALTH,
      baseMaxHealth: BASE_MAX_HEALTH
    }
  }

  /** سقف سلامت برای مصرف‌کننده‌ها (درمانگاه). */
  static readonly BASE_MAX = BASE_MAX_HEALTH
  static readonly MEMBER_MAX = GYM_MAX_HEALTH
}
