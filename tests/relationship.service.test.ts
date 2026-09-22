import { RelationshipStatus, RelationshipType } from '@prisma/client'
import { RelationshipService } from '../src/modules/relationship/relationship.service'
import { RelationshipRepository } from '../src/database/repositories/relationship.repository'
import { PlayerRepository } from '../src/database/repositories/player.repository'
import { renderRelationshipsList } from '../src/bot/renders'

describe('RelationshipService', () => {
  let relationshipRepository: { listByPlayerId: jest.Mock }
  let playerRepository: { findByTelegramUserId: jest.Mock }
  let service: RelationshipService

  beforeEach(() => {
    relationshipRepository = { listByPlayerId: jest.fn().mockResolvedValue([]) }
    playerRepository = { findByTelegramUserId: jest.fn() }
    service = new RelationshipService(
      relationshipRepository as unknown as RelationshipRepository,
      playerRepository as unknown as PlayerRepository
    )
  })

  test('فقط پیوندهای ثبت‌شدهٔ بازیکن را برمی‌گرداند', async () => {
    playerRepository.findByTelegramUserId.mockResolvedValue({ id: 'p1' })
    const rows = [{ id: 'rel-1' }]
    relationshipRepository.listByPlayerId.mockResolvedValue(rows)

    await expect(service.listRelationships(1n)).resolves.toEqual(rows)
    expect(relationshipRepository.listByPlayerId).toHaveBeenCalledWith('p1')
  })

  test('بازیکنِ ثبت‌نام‌نکرده را رد می‌کند', async () => {
    playerRepository.findByTelegramUserId.mockResolvedValue(null)

    await expect(service.listRelationships(1n)).rejects.toThrow()
  })

  // نگهبانِ حذف: `createRelationship` یک نویسندهٔ بی‌مسیر بود که توهمِ
  // «افزودن دوست/همکار/همسایه» را می‌ساخت. اگر روزی برگردد، این تست
  // باید با شکست خبر بدهد تا آگاهانه تصمیم گرفته شود.
  test('نویسندهٔ عمومیِ پیوند وجود ندارد — پیوندها فقط از جریان‌های بازی می‌آیند', () => {
    const surface = Object.getOwnPropertyNames(RelationshipService.prototype)
    expect(surface).not.toContain('createRelationship')
  })
})

describe('renderRelationshipsList — سابقهٔ پیوندها', () => {
  const spouse = (status: RelationshipStatus) => ({
    type: RelationshipType.SPOUSE,
    status,
    strength: status === RelationshipStatus.ACTIVE ? 100 : 10,
    createdAt: new Date('2026-01-02T00:00:00Z'),
    relatedPlayer: { firstName: 'نیلوفر', lastName: 'کریمی' }
  })

  test('حالت خالی صادق است و وعدهٔ افزودن دوست نمی‌دهد', () => {
    const text = renderRelationshipsList([])

    expect(text).toContain('هنوز هیچ پیوندی')
    // وعدهٔ قدیمی: «دوستانت را با ریپلای روی پیامشان پیدا کن» — چنین کنشی وجود ندارد.
    expect(text).not.toContain('ریپلای')
    expect(text).toContain('ازدواج')
  })

  test('پیوندِ بسته‌شده هم با تاریخ نمایش داده می‌شود (سابقه)', () => {
    const text = renderRelationshipsList([spouse(RelationshipStatus.ENDED)])

    expect(text).toContain('نیلوفر کریمی')
    expect(text).toContain('خاتمه‌یافته')
    expect(text).toContain('ازدواج')
  })

  test('طلاق با وضعیت مسدود و نه حذف ردیف نمایش داده می‌شود', () => {
    const text = renderRelationshipsList([spouse(RelationshipStatus.BLOCKED)])

    expect(text).toContain('مسدود')
  })
})
