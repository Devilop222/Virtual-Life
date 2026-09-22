import { RelationshipStatus, RelationshipType } from '@prisma/client'
import { RelationshipRepository } from '../../database/repositories/relationship.repository'
import { PlayerRepository } from '../../database/repositories/player.repository'
import { NotFoundError } from '../../utils/classes/errors'

/**
 * نمایِ خواندنیِ شبکهٔ پیوندها.
 *
 * عمداً هیچ نویسنده‌ای این‌جا نیست: پیوندها را خودِ بازی می‌سازد و می‌بندد —
 * ازدواج (`marriage.service`)، طلاق (BLOCKED) و مرگِ همسر (`widowhood.ts`
 * وضعیت را ENDED می‌کند). قبلاً یک `createRelationship` عمومی این‌جا بود که
 * هیچ مسیر بازیکنی به آن نمی‌رسید و توهمِ «افزودن دوست/همکار/همسایه» را
 * می‌ساخت؛ حذف شد تا تنها منبعِ تغییرِ پیوندها همان جریان‌های واقعیِ بازی باشد.
 */
export class RelationshipService {
  constructor(
    private readonly relationshipRepository: RelationshipRepository,
    private readonly playerRepository: PlayerRepository
  ) {}

  async listRelationships(telegramUserId: bigint) {
    const player = await this.playerRepository.findByTelegramUserId(telegramUserId)
    if (!player) {
      throw new NotFoundError('Player not found')
    }

    return this.relationshipRepository.listByPlayerId(player.id)
  }
}

export const relationshipTypeLabels: Record<RelationshipType, string> = {
  [RelationshipType.FRIEND]: 'دوستی',
  [RelationshipType.FAMILY]: 'خانواده',
  [RelationshipType.SPOUSE]: 'ازدواج',
  [RelationshipType.COLLEAGUE]: 'همکار',
  [RelationshipType.NEIGHBOR]: 'همسایه',
  [RelationshipType.ENEMY]: 'دشمنی'
}

export const relationshipStatusLabels: Record<RelationshipStatus, string> = {
  [RelationshipStatus.PENDING]: 'در انتظار',
  [RelationshipStatus.ACTIVE]: 'فعال',
  [RelationshipStatus.BLOCKED]: 'مسدود',
  [RelationshipStatus.ENDED]: 'خاتمه‌یافته'
}
