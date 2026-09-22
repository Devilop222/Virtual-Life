import { GameEventType, MigrationReason, PrismaClient, TransactionType } from '@prisma/client'
import { ConflictError, NotFoundError, ValidationError } from '../../utils/classes/errors'
import { EventService } from '../events/event.service'
import { ProjectsService } from '../city/projects.service'
import { RESIDENCE_CONFIG, migrationCostFor } from '../../config/region.config'
import { hoursUntil } from '../../utils/game-time'
import { RegionFundService } from '../economy/tax.service'

export interface ResidenceInfo {
  hasResidence: boolean
  residenceGroupId: string | null
  residenceTitle: string | null
  residenceLevel: string | null
  residenceSince: Date | null
  currentRegionId: string | null
  currentRegionTitle: string | null
  isTraveling: boolean
  canMigrateAt: Date | null
  migrationCount: number
}

export interface MigrationCheck {
  allowed: boolean
  reason?: string
  cost: number
  blockers: string[]
}

/**
 * سرویس اقامت، سفر و مهاجرت.
 *
 * سه مفهوم کاملاً جدا:
 *  - Residence: محل اقامت اصلی بازیکن (فقط با اولین فعالیت معتبر یا مهاجرت تغییر می‌کند)
 *  - Travel: حضور موقت در منطقهٔ دیگر (اقامت را تغییر نمی‌دهد)
 *  - Migration: تغییر رسمی اقامت با هزینه، Cooldown و بررسی تعهدات
 *
 * عضو شدن در گروه، افزودن توسط ادمین یا ارسال پیام نامعتبر هرگز اقامت ایجاد نمی‌کند.
 */
export class ResidenceService {
  /** تنها کانالِ نوشتن روی صندوق منطقه — همان که مالیات و حراجی استفاده می‌کنند. */
  private readonly regionFund = new RegionFundService()

  constructor(
    private readonly db: PrismaClient,
    private readonly eventService: EventService,
    private readonly projectsService?: ProjectsService
  ) {}

  /** وضعیت اقامت بازیکن. */
  async getResidenceInfo(telegramUserId: bigint): Promise<ResidenceInfo> {
    const player = await this.db.player.findUnique({
      where: { telegramUserId },
      select: {
        id: true,
        residenceSince: true,
        lastMigrationAt: true,
        currentRegionId: true,
        homeGroup: { select: { id: true, title: true, environmentLevel: true } },
        currentRegion: { select: { id: true, title: true } }
      }
    })
    if (!player) {
      throw new NotFoundError('Player not found')
    }

    const migrationCount = await this.db.migration.count({ where: { playerId: player.id } })

    const canMigrateAt = player.lastMigrationAt
      ? new Date(player.lastMigrationAt.getTime() + RESIDENCE_CONFIG.migrationCooldownMs)
      : null

    return {
      hasResidence: Boolean(player.homeGroup),
      residenceGroupId: player.homeGroup?.id ?? null,
      residenceTitle: player.homeGroup?.title ?? null,
      residenceLevel: player.homeGroup?.environmentLevel ?? null,
      residenceSince: player.residenceSince,
      currentRegionId: player.currentRegionId,
      currentRegionTitle: player.currentRegion?.title ?? null,
      isTraveling: Boolean(
        player.currentRegionId && player.homeGroup && player.currentRegionId !== player.homeGroup.id
      ),
      canMigrateAt,
      migrationCount
    }
  }

  /**
   * تعیین اقامت اولیه هنگام اولین فعالیت معتبر.
   * اگر بازیکن از قبل اقامت دارد، هیچ تغییری انجام نمی‌شود (Group ≠ Residence).
   * عملیات با شرط `homeGroupId: null` اتمیک است تا دو فعالیت همزمان دو اقامت نسازند.
   */
  async establishInitialResidence(
    playerId: string,
    groupId: string
  ): Promise<{ established: boolean }> {
    const claimed = await this.db.player.updateMany({
      where: { id: playerId, homeGroupId: null },
      data: { homeGroupId: groupId, residenceSince: new Date() }
    })

    if (claimed.count !== 1) {
      return { established: false }
    }

    await this.db.migration
      .create({
        data: {
          playerId,
          fromGroupId: null,
          toGroupId: groupId,
          reason: MigrationReason.FIRST_SETTLEMENT,
          cost: 0
        }
      })
      .catch(() => {})

    await this.eventService
      .recordPlayerEvent({
        playerId,
        type: GameEventType.RESIDENCE_ESTABLISHED,
        title: 'محل اقامتت ثبت شد',
        dedupeKey: `residence-init:${playerId}`
      })
      .catch(() => {})

    return { established: true }
  }

  /**
   * ثبت حضور موقت (Travel) در یک منطقه.
   * این عملیات هرگز اقامت اصلی را تغییر نمی‌دهد.
   */
  async trackPresence(playerId: string, groupId: string): Promise<void> {
    await this.db.player.update({
      where: { id: playerId },
      data: { currentRegionId: groupId, lastActivityAt: new Date() }
    })
  }

  /** بررسی امکان مهاجرت بدون انجام آن. */
  async checkMigration(telegramUserId: bigint, targetGroupId: string): Promise<MigrationCheck> {
    const player = await this.db.player.findUnique({
      where: { telegramUserId },
      select: {
        id: true,
        balance: true,
        homeGroupId: true,
        lastMigrationAt: true,
        activityState: true,
        isEnrolled: true
      }
    })
    if (!player) {
      throw new NotFoundError('Player not found')
    }

    const [target, migrationDiscount] = await Promise.all([
      this.db.group.findUnique({
        where: { id: targetGroupId },
        select: { id: true, environmentLevel: true, status: true }
      }),
      // پایانهٔ مسافربری منطقهٔ فعلی، هزینهٔ خروج ساکنانش را کم می‌کند
      this.projectsService
        ?.getRegionBuffs(player.homeGroupId)
        .then((b) => b.migrationDiscount)
        .catch(() => 0) ?? Promise.resolve(0)
    ])
    if (!target) {
      throw new NotFoundError('Region not found', 'منطقهٔ مقصد یافت نشد.')
    }

    const cost = Math.round(migrationCostFor(target.environmentLevel) * (1 - migrationDiscount))
    const blockers: string[] = []

    if (player.homeGroupId === targetGroupId) {
      blockers.push('همین حالا در این منطقه اقامت داری.')
    }

    if (target.status !== 'ACTIVE') {
      blockers.push('منطقهٔ مقصد غیرفعال است.')
    }

    if (player.lastMigrationAt) {
      const nextAllowed =
        player.lastMigrationAt.getTime() + RESIDENCE_CONFIG.migrationCooldownMs
      if (Date.now() < nextAllowed) {
        // فاصله روی ساعت بازی گزارش می‌شود، نه با تقسیم دستی بر میلی‌ثانیه.
        const hours = hoursUntil(new Date(nextAllowed))
        blockers.push(`تا ${hours} ساعت بازی دیگر نمی‌توانی مهاجرت کنی.`)
      }
    }

    if (Number(player.balance) < cost) {
      blockers.push(`هزینهٔ مهاجرت ${cost.toLocaleString('fa-IR')} تومان است و موجودی‌ات کافی نیست.`)
    }

    if (player.activityState === 'WORKING') {
      blockers.push('ابتدا کار فعلی‌ات را تمام کن.')
    }

    if (player.isEnrolled) {
      blockers.push('در حال تحصیل هستی؛ ابتدا دوره را تمام کن.')
    }

    const [activeLoans, activeBusinesses] = await Promise.all([
      this.db.loan.count({ where: { playerId: player.id, status: 'ACTIVE' } }),
      this.db.business.count({ where: { ownerId: player.id, status: 'ACTIVE' } })
    ])

    if (activeLoans > 0) {
      blockers.push('وام تسویه‌نشده داری؛ ابتدا بدهی‌ات را پرداخت کن.')
    }
    if (activeBusinesses > 0) {
      blockers.push('کسب‌وکار فعال داری و نمی‌توانی محل اقامت را تغییر دهی.')
    }

    return { allowed: blockers.length === 0, cost, blockers }
  }

  /**
   * انجام مهاجرت به‌صورت اتمیک.
   * کسر هزینه و تغییر اقامت در یک تراکنش با شرط انجام می‌شوند تا
   * دو درخواست همزمان نتوانند دو بار هزینه بگیرند یا اقامت را خراب کنند.
   */
  async migrate(telegramUserId: bigint, targetGroupId: string) {
    const check = await this.checkMigration(telegramUserId, targetGroupId)
    if (!check.allowed) {
      throw new ConflictError('Migration blocked', check.blockers.join('\n'))
    }

    const result = await this.db.$transaction(async (tx) => {
      const player = await tx.player.findUnique({
        where: { telegramUserId },
        select: { id: true, homeGroupId: true, lastMigrationAt: true }
      })
      if (!player) {
        throw new NotFoundError('Player not found')
      }

      // کسر شرطی هزینه: محافظت از Double-Spend
      const debited = await tx.player.updateMany({
        where: { id: player.id, balance: { gte: check.cost } },
        data: { balance: { decrement: check.cost } }
      })
      if (debited.count !== 1) {
        throw new ValidationError(
          'Insufficient balance',
          'موجودیت برای پرداخت هزینهٔ مهاجرت کافی نیست.'
        )
      }

      // شرط روی homeGroupId و lastMigrationAt: جلوگیری از مهاجرت دوباره
      const moved = await tx.player.updateMany({
        where: {
          id: player.id,
          homeGroupId: player.homeGroupId,
          lastMigrationAt: player.lastMigrationAt
        },
        data: {
          homeGroupId: targetGroupId,
          currentRegionId: targetGroupId,
          residenceSince: new Date(),
          lastMigrationAt: new Date()
        }
      })
      if (moved.count !== 1) {
        throw new ConflictError(
          'Migration state changed',
          'وضعیت اقامتت تغییر کرده است. دوباره تلاش کن.'
        )
      }

      await tx.migration.create({
        data: {
          playerId: player.id,
          fromGroupId: player.homeGroupId,
          toGroupId: targetGroupId,
          reason: MigrationReason.VOLUNTARY,
          cost: check.cost
        }
      })

      // هزینه باید دو اثر داشته باشد: در دفتر کلِ بازیکن ثبت شود و به جایی
      // برسد. پیش‌تر کسر خام بود و هیچ ردیفی نمی‌گذاشت — دفتر بازیکن با کیفش
      // نمی‌خواند و ممیزی اقتصاد آن را «کسرِ بدون ثبت» می‌دید. حالا همان الگوی
      // `TAX_PAYMENT`: خروجِ بازیکن + واریز به صندوق منطقه (اینجا مقصد، چون از
      // این لحظه مالیاتِ بازیکن هم به همان منطقه می‌رود).
      if (check.cost > 0) {
        await tx.financialTransaction.create({
          data: {
            amount: check.cost,
            type: TransactionType.RESIDENCE_MIGRATION_FEE,
            sourcePlayerId: player.id,
            reference: 'هزینهٔ مهاجرت به منطقهٔ جدید'
          }
        })
        await this.regionFund.credit(tx, targetGroupId, check.cost)
      }

      return { playerId: player.id, fromGroupId: player.homeGroupId }
    })

    const target = await this.db.group.findUnique({
      where: { id: targetGroupId },
      select: { title: true }
    })

    await this.eventService
      .recordPlayerEvent({
        playerId: result.playerId,
        type: GameEventType.RESIDENCE_MIGRATED,
        title: `مهاجرت به ${target?.title ?? 'منطقهٔ جدید'}`,
        amount: check.cost
      })
      .catch(() => {})

    return { cost: check.cost, targetTitle: target?.title ?? null }
  }

  /** مناطقی که بازیکن در آن‌ها عضویت فعال دارد (برای انتخاب مقصد مهاجرت). */
  async listAvailableRegions(telegramUserId: bigint) {
    const player = await this.db.player.findUnique({
      where: { telegramUserId },
      select: { id: true, homeGroupId: true }
    })
    if (!player) {
      throw new NotFoundError('Player not found')
    }

    const memberships = await this.db.playerGroup.findMany({
      where: { playerId: player.id, status: 'ACTIVE' },
      select: {
        group: { select: { id: true, title: true, environmentLevel: true, status: true } }
      }
    })

    return memberships
      .map((m) => m.group)
      .filter((g) => g.status === 'ACTIVE' && g.id !== player.homeGroupId)
  }
}
