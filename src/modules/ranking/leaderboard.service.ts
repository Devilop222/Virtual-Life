import { PlayerGroupStatus } from '@prisma/client'
import { PlayerRepository } from '../../database/repositories/player.repository'
import { PlayerGroupRepository } from '../../database/repositories/player-group.repository'
import { GroupRepository } from '../../database/repositories/group.repository'
import { NotFoundError } from '../../utils/classes/errors'

export type LeaderboardMetric = 'money' | 'experience' | 'health' | 'age'

export const LEADERBOARD_METRICS: Record<LeaderboardMetric, { label: string; rankField: 'balance' | 'experience' | 'health' | 'age' }> = {
  money: { label: '💰 ثروتمندترین‌ها', rankField: 'balance' },
  experience: { label: '⭐ باتجربه‌ترین‌ها', rankField: 'experience' },
  health: { label: '❤️ سالم‌ترین‌ها', rankField: 'health' },
  age: { label: '🎂 مسن‌ترین‌ها', rankField: 'age' }
}

const DEFAULT_PAGE_SIZE = 5

export class LeaderboardService {
  constructor(
    private readonly playerRepository: PlayerRepository,
    private readonly playerGroupRepository: PlayerGroupRepository,
    private readonly groupRepository: GroupRepository
  ) {}

  async groupTop(
    telegramGroupId: bigint,
    metric: LeaderboardMetric,
    page = 0
  ) {
    const group = await this.groupRepository.findByTelegramGroupId(telegramGroupId)
    if (!group) {
      throw new NotFoundError('Group not registered', 'این گروه هنوز به‌عنوان محیط بازی ثبت نشده است. در همین گروه /start را بفرست.')
    }

    const memberships = await this.playerGroupRepository.listByGroupId(group.id)
    const telegramUserIds = memberships
      .filter((m) => m.status === PlayerGroupStatus.ACTIVE)
      .map((m) => m.player.telegramUserId)

    const field = LEADERBOARD_METRICS[metric].rankField
    const skip = Math.max(0, page) * DEFAULT_PAGE_SIZE
    const rows = await this.playerRepository.listTop(field, telegramUserIds, skip, DEFAULT_PAGE_SIZE)

    return {
      scope: 'group' as const,
      title: LEADERBOARD_METRICS[metric].label,
      metric,
      rows,
      page,
      pageSize: DEFAULT_PAGE_SIZE,
      // صفحهٔ تمام‌پر یعنی احتمالاً صفحهٔ بعدی هم هست؛ دکمهٔ «بعدی» فقط در این حالت
      // نمایش داده می‌شود تا دکمهٔ مرده در صفحهٔ آخر ساخته نشود.
      hasNextPage: rows.length === DEFAULT_PAGE_SIZE
    }
  }

  async globalTop(metric: LeaderboardMetric, page = 0) {
    const field = LEADERBOARD_METRICS[metric].rankField
    const skip = Math.max(0, page) * DEFAULT_PAGE_SIZE
    const rows = await this.playerRepository.listTop(field, null, skip, DEFAULT_PAGE_SIZE)

    return {
      scope: 'global' as const,
      title: LEADERBOARD_METRICS[metric].label,
      metric,
      rows,
      page,
      pageSize: DEFAULT_PAGE_SIZE,
      hasNextPage: rows.length === DEFAULT_PAGE_SIZE
    }
  }
}