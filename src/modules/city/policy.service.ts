import { GameEventType, PrismaClient } from '@prisma/client'
import { ConflictError, NotFoundError } from '../../utils/classes/errors'
import { EventService } from '../events/event.service'
import { weekIndex } from '../../utils/game-time'
import { resolveCityAuthority, type CityAuthority } from './authority'

export interface MayorPolicy {
  key: string
  title: string
  emoji: string
  description: string
}

/**
 * سیاست‌های قابل انتخاب شهردار؛ هر سیاست با بافرهای موجود منطقه ترکیب می‌شود.
 * کلیدها باید با منطق getRegionBuffs در projects.service همخوان بمانند.
 */
export const MAYOR_POLICIES: readonly MayorPolicy[] = [
  {
    key: 'bazaar_discount',
    title: 'تخفیف بازار هفتگی',
    emoji: '🛒',
    description: '۳٪ تخفیف اضافه روی همهٔ خریدهای فروشگاه منطقه'
  },
  {
    key: 'park_boost',
    title: 'پارک‌سازی محله‌ای',
    emoji: '🌳',
    description: 'ریکاوری استراحت ساکنان ۵٪ مؤثرتر می‌شود'
  },
  {
    key: 'open_city',
    title: 'شهرِ مهمان‌نواز',
    emoji: '🛫',
    description: '۱۰٪ تخفیف هزینهٔ مهاجرت به این منطقه'
  }
]

/**
 * سیاست شهردار.
 *
 * شهردارِ آخرین دورهٔ برگزارشدهٔ منطقه، هر هفته یک بار می‌تواند یکی از سه
 * سیاست را فعال کند. اعتبارسنجی از خود جدول انتخابات خوانده می‌شود (winnerId)
 * تا هیچ منبع دوم حقیقت ساخته نشود.
 */
export class PolicyService {
  constructor(
    private readonly db: PrismaClient,
    private readonly eventService: EventService
  ) {}

  /**
   * وضعیت کامل شهرداری: چه کسی، تا کِی، و آیا دوره‌اش تمام شده است.
   *
   * این تنها راهِ پرسیدنِ «شهردار کیست؟» است — قاعده در `authority.ts`
   * زندگی می‌کند تا پنل سیاست، پنل شهر و سرویس پروژه‌ها همه یک پاسخ
   * بگیرند و هیچ منبعِ دومِ حقیقتی ساخته نشود.
   */
  async mayorStatus(groupId: string): Promise<CityAuthority | null> {
    return resolveCityAuthority(this.db, groupId)
  }

  /** تعیین یا تغییر سیاست فعال منطقه. */
  async setPolicy(
    mayorTgId: bigint,
    groupId: string,
    policyKey: string
  ): Promise<{ policyTitle: string; emoji: string }> {
    const policy = MAYOR_POLICIES.find((p) => p.key === policyKey)
    if (!policy) {
      throw new NotFoundError('Unknown policy', 'این سیاست وجود ندارد.')
    }

    const mayor = await this.db.player.findUnique({
      where: { telegramUserId: mayorTgId },
      select: { id: true }
    })
    if (!mayor) {
      throw new NotFoundError('Player not found')
    }

    const authority = await this.mayorStatus(groupId)
    if (!authority || authority.playerId !== mayor.id) {
      throw new ConflictError(
        'Not the mayor',
        'فقط شهردار منتخب منطقه می‌تواند سیاست تعیین کند.'
      )
    }

    // تغییر سیاست هفته‌ای یک بار (کلید یکتا روی رخداد)
    const dedupeKey = `policy:${groupId}:${weekIndex()}`

    await this.db.group.update({
      where: { id: groupId },
      data: { activePolicy: policyKey }
    })

    await this.eventService
      .recordRegionEvent({
        groupId,
        type: GameEventType.MAYOR_POLICY_SET,
        priority: 4,
        title: `${policy.emoji} سیاست جدید شهردار`,
        detail: policy.description,
        dedupeKey
      })
      .catch(() => undefined)

    return { policyTitle: policy.title, emoji: policy.emoji }
  }

  /** سیاست فعال فعلی منطقه. */
  async getActivePolicy(groupId: string): Promise<MayorPolicy | null> {
    const group = await this.db.group.findUnique({
      where: { id: groupId },
      select: { activePolicy: true }
    })
    if (!group?.activePolicy) {
      return null
    }
    return MAYOR_POLICIES.find((p) => p.key === group.activePolicy) ?? null
  }

  /**
   * بررسی اینکه آیا بازیکن شهردارِ فعال است (برای UI و برای نگهبانِ
   * سرویس‌های دیگر مانند «آغاز پروژه»). یک قاعده، دو مصرف‌کننده.
   */
  async canManage(telegramUserId: bigint, groupId: string): Promise<boolean> {
    const authority = await this.mayorStatus(groupId)
    if (!authority) return false

    const player = await this.db.player.findUnique({
      where: { telegramUserId },
      select: { id: true }
    })
    return player !== null && player.id === authority.playerId
  }
}

export const POLICY_INFO = { policies: MAYOR_POLICIES } as const
