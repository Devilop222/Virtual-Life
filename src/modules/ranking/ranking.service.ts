import { PlayerStatus, PrismaClient, RankingScope } from '@prisma/client'
import { NotFoundError } from '../../utils/classes/errors'

export type PlayerRankCategory = 'wealth' | 'education' | 'experience' | 'assets'
export type RegionRankCategory = 'region_wealth' | 'region_population' | 'region_activity'
export type RankCategory = PlayerRankCategory | RegionRankCategory

export interface RankRow {
  rank: number
  name: string
  value: string
  raw: number
}

export interface RankingResult {
  scope: 'group' | 'global' | 'region'
  category: RankCategory
  title: string
  rows: RankRow[]
  page: number
  pageSize: number
  total: number
  computedAt: Date
  cached: boolean
}

const PAGE_SIZE = 5
/** حداکثر تعداد ردیف ذخیره‌شده در هر Snapshot. */
const SNAPSHOT_SIZE = 50
/** عمر Snapshot؛ در این بازه از Cache خوانده می‌شود. */
const SNAPSHOT_TTL_MS = 10 * 60 * 1000

export const RANK_CATEGORIES: Record<RankCategory, { title: string; forRegions: boolean }> = {
  wealth: { title: '💰 ثروتمندترین‌ها', forRegions: false },
  education: { title: '🎓 باسوادترین‌ها', forRegions: false },
  experience: { title: '⭐ باتجربه‌ترین‌ها', forRegions: false },
  assets: { title: '🏘️ بیشترین دارایی', forRegions: false },
  region_wealth: { title: '💰 ثروتمندترین مناطق', forRegions: true },
  region_population: { title: '👥 پرجمعیت‌ترین مناطق', forRegions: true },
  region_activity: { title: '📈 فعال‌ترین مناطق', forRegions: true }
}

const DEGREE_RANK: Record<string, number> = {
  DIPLOMA: 1,
  ASSOCIATE: 2,
  BACHELOR: 3,
  MASTER: 4,
  DOCTORATE: 5
}

/**
 * موتور رتبه‌بندی با Snapshot.
 * رتبه‌ها در هر درخواست از صفر محاسبه نمی‌شوند؛ هر ده دقیقه یک‌بار Snapshot ساخته
 * و در دیتابیس ذخیره می‌شود. صفحه‌بندی روی همان Snapshot انجام می‌گیرد.
 */
export class RankingService {
  constructor(private readonly db: PrismaClient) {}

  async getGroupRanking(
    telegramGroupId: bigint,
    category: PlayerRankCategory,
    page = 0
  ): Promise<RankingResult> {
    const group = await this.db.group.findUnique({
      where: { telegramGroupId },
      select: { id: true }
    })
    if (!group) {
      throw new NotFoundError(
        'Group not registered',
        'این گروه هنوز به‌عنوان محیط بازی ثبت نشده است. در همین گروه /start را بفرست.'
      )
    }

    return this.resolve(RankingScope.GROUP, category, group.id, page, () =>
      this.computePlayerRows(category, group.id)
    )
  }

  async getGlobalPlayerRanking(
    category: PlayerRankCategory,
    page = 0
  ): Promise<RankingResult> {
    return this.resolve(RankingScope.GLOBAL, category, null, page, () =>
      this.computePlayerRows(category, null)
    )
  }

  async getRegionRanking(category: RegionRankCategory, page = 0): Promise<RankingResult> {
    return this.resolve(RankingScope.REGION, category, null, page, () =>
      this.computeRegionRows(category)
    )
  }

  /** خواندن از Snapshot یا ساخت آن در صورت کهنه بودن. */
  private async resolve(
    scope: RankingScope,
    category: RankCategory,
    groupId: string | null,
    page: number,
    compute: () => Promise<RankRow[]>
  ): Promise<RankingResult> {
    const existing = await this.db.rankingSnapshot.findFirst({
      where: { scope, category, groupId }
    })

    let rows: RankRow[]
    let computedAt: Date
    let cached = false

    if (existing && Date.now() - existing.computedAt.getTime() < SNAPSHOT_TTL_MS) {
      rows = existing.payload as unknown as RankRow[]
      computedAt = existing.computedAt
      cached = true
    } else {
      rows = await compute()
      computedAt = new Date()
      if (existing) {
        await this.db.rankingSnapshot.update({
          where: { id: existing.id },
          data: { payload: rows as unknown as object, computedAt }
        })
      } else {
        await this.db.rankingSnapshot
          .create({
            data: {
              scope,
              category,
              groupId,
              payload: rows as unknown as object,
              computedAt
            }
          })
          .catch(() => {
            // اگر همزمان Snapshot دیگری ساخته شده باشد، نقض unique بی‌خطر است
          })
      }
    }

    const start = Math.max(0, page) * PAGE_SIZE
    return {
      scope: scope === RankingScope.GROUP ? 'group' : scope === RankingScope.GLOBAL ? 'global' : 'region',
      category,
      title: RANK_CATEGORIES[category].title,
      rows: rows.slice(start, start + PAGE_SIZE),
      page: Math.max(0, page),
      pageSize: PAGE_SIZE,
      total: rows.length,
      computedAt,
      cached
    }
  }

  /** محاسبهٔ رتبهٔ بازیکنان؛ فقط ستون‌های لازم و با محدودیت تعداد. */
  private async computePlayerRows(
    category: PlayerRankCategory,
    groupId: string | null
  ): Promise<RankRow[]> {
    let playerIds: string[] | null = null
    if (groupId) {
      const memberships = await this.db.playerGroup.findMany({
        where: { groupId, status: 'ACTIVE' },
        select: { playerId: true }
      })
      playerIds = memberships.map((m) => m.playerId)
      if (playerIds.length === 0) return []
    }

    // فهرست زنده: بازیکنان فوت‌شده یا بن‌شده در تابلوی رقابتی نمی‌آیند
    const where = {
      ...(playerIds ? { id: { in: playerIds } } : {}),
      status: { notIn: [PlayerStatus.DEAD, PlayerStatus.BANNED] }
    }

    if (category === 'assets') {
      // دارایی = مجموع ارزش املاک؛ با groupBy محاسبه می‌شود، نه با N+1
      // فیلتر مالکِ زنده داخل خودِ groupBy است تا رتبه‌ها جابه‌جا نشوند
      const grouped = await this.db.property.groupBy({
        by: ['ownerId'],
        where: {
          ...(playerIds ? { ownerId: { in: playerIds } } : { ownerId: { not: null } }),
          owner: { status: { notIn: [PlayerStatus.DEAD, PlayerStatus.BANNED] } }
        },
        _sum: { baseAssetValue: true },
        orderBy: { _sum: { baseAssetValue: 'desc' } },
        take: SNAPSHOT_SIZE
      })
      const ownerIds = grouped
        .map((g) => g.ownerId)
        .filter((id): id is string => Boolean(id))
      if (ownerIds.length === 0) return []

      const owners = await this.db.player.findMany({
        where: { id: { in: ownerIds } },
        select: { id: true, firstName: true, lastName: true }
      })
      const nameOf = new Map(owners.map((o) => [o.id, displayName(o)]))

      return grouped
        .filter((g) => g.ownerId)
        .map((g, index) => {
          const raw = Number(g._sum.baseAssetValue ?? 0)
          return {
            rank: index + 1,
            name: nameOf.get(g.ownerId as string) ?? 'ناشناس',
            value: `${raw.toLocaleString('fa-IR')} تومان`,
            raw
          }
        })
    }

    if (category === 'education') {
      const players = await this.db.player.findMany({
        where,
        select: {
          firstName: true,
          lastName: true,
          currentDegree: true,
          experience: true
        },
        take: 500
      })
      return players
        .map((p) => ({
          name: displayName(p),
          raw: DEGREE_RANK[p.currentDegree] ?? 1,
          tie: p.experience
        }))
        .sort((a, b) => b.raw - a.raw || b.tie - a.tie)
        .slice(0, SNAPSHOT_SIZE)
        .map((p, index) => ({
          rank: index + 1,
          name: p.name,
          value: degreeTitle(p.raw),
          raw: p.raw
        }))
    }

    const orderBy = category === 'wealth' ? { balance: 'desc' as const } : { experience: 'desc' as const }
    const players = await this.db.player.findMany({
      where,
      orderBy,
      take: SNAPSHOT_SIZE,
      select: { firstName: true, lastName: true, balance: true, experience: true }
    })

    return players.map((p, index) => {
      const raw = category === 'wealth' ? Number(p.balance) : p.experience
      return {
        rank: index + 1,
        name: displayName(p),
        value:
          category === 'wealth'
            ? `${raw.toLocaleString('fa-IR')} تومان`
            : `${raw.toLocaleString('fa-IR')} تجربه`,
        raw
      }
    })
  }

  /** محاسبهٔ رتبهٔ مناطق از جدول تجمیعی RegionStat (سبک و سریع). */
  private async computeRegionRows(category: RegionRankCategory): Promise<RankRow[]> {
    const orderBy =
      category === 'region_wealth'
        ? { totalWealth: 'desc' as const }
        : category === 'region_population'
          ? { population: 'desc' as const }
          : { economicIndex: 'desc' as const }

    const stats = await this.db.regionStat.findMany({
      orderBy,
      take: SNAPSHOT_SIZE,
      select: {
        population: true,
        totalWealth: true,
        economicIndex: true,
        group: { select: { title: true } }
      }
    })

    return stats.map((s, index) => {
      const raw =
        category === 'region_wealth'
          ? Number(s.totalWealth)
          : category === 'region_population'
            ? s.population
            : s.economicIndex
      const value =
        category === 'region_wealth'
          ? `${raw.toLocaleString('fa-IR')} تومان`
          : category === 'region_population'
            ? `${raw.toLocaleString('fa-IR')} بازیکن`
            : `شاخص ${raw.toLocaleString('fa-IR')}`
      return { rank: index + 1, name: s.group.title, value, raw }
    })
  }
}

function displayName(p: { firstName: string; lastName: string | null }): string {
  return `${p.firstName} ${p.lastName ?? ''}`.trim()
}

function degreeTitle(rank: number): string {
  const titles = ['دیپلم', 'کاردانی', 'کارشناسی', 'کارشناسی ارشد', 'دکتری']
  return titles[rank - 1] ?? 'دیپلم'
}
