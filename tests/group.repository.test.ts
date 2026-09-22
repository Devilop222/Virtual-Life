import { PrismaClient, Group } from '@prisma/client'
import { GroupRepository } from '../src/database/repositories/group.repository'
import { GroupType } from '@prisma/client'

describe('GroupRepository', () => {
  let db: {
    group: {
      findUnique: jest.Mock
      upsert: jest.Mock
    }
  }
  let repository: GroupRepository

  beforeEach(() => {
    db = {
      group: {
        findUnique: jest.fn(),
        upsert: jest.fn()
      }
    }
    repository = new GroupRepository(db as unknown as PrismaClient)
  })

  test('finds group by telegram group id', async () => {
    const group = { id: 'g1', telegramGroupId: -100123n } as unknown as Group
    db.group.findUnique.mockResolvedValue(group)

    const result = await repository.findByTelegramGroupId(-100123n)

    expect(result).toBe(group)
  })

  test('upserts group with given data', async () => {
    const group = { id: 'g1' } as unknown as Group
    db.group.upsert.mockResolvedValue(group)

    const result = await repository.upsert({
      telegramGroupId: -100123n,
      title: 'گروه دوستان',
      type: GroupType.SUPERGROUP,
      memberCount: 20,
      realMemberCount: 18
    })

    expect(result).toBe(group)
    expect(db.group.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { telegramGroupId: -100123n }
      })
    )
    // جمعیت/سطح این‌جا نوشته نمی‌شود: تنها نویسندهٔ آن‌ها `updateEnvironment`
    // است تا مهرِ تغییر قابلِ‌اعتماد بماند.
    const call = db.group.upsert.mock.calls[0]![0]
    expect(call.create).not.toHaveProperty('gamePopulation')
    expect(call.update).not.toHaveProperty('environmentLevel')
  })

  test('نوشتارِ سطح: مهری فقط وقتی‌که سطح واقعاً عوض شود', async () => {
    const db = {
      group: {
        updateMany: jest.fn()
      }
    }
    const repository = new GroupRepository(db as unknown as PrismaClient)
    const groupId = 'g1'

    // تغییرِ سطح: یک برنده، یک مهر.
    db.group.updateMany.mockResolvedValueOnce({ count: 1 })
    const changed = await repository.updateEnvironment(groupId, 16, 'CITY' as never)
    expect(changed.levelChanged).toBe(true)
    expect(changed.levelChangedAt).toBeInstanceOf(Date)

    // بدون تغییرِ سطح، فقط جمعیت هم‌تراز می‌شود و مهری گرفته نمی‌شود.
    db.group.updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 })
    const same = await repository.updateEnvironment(groupId, 16, 'CITY' as never)
    expect(same.levelChanged).toBe(false)
    expect(same.levelChangedAt).toBeNull()
    expect(same.changed).toBe(true)

    // شرطِ گام اول روی خودِ سطح است: همین است که رقابت را می‌بندد.
    expect(db.group.updateMany.mock.calls[0]![0].where).toEqual({
      id: groupId,
      environmentLevel: { not: 'CITY' }
    })
  })

  test('صفحه‌بندی با شناسهٔ آخرین ردیف ادامه می‌دهد (بدون skip)', async () => {
    const db = { group: { findMany: jest.fn().mockResolvedValue([]) } }
    const repository = new GroupRepository(db as unknown as PrismaClient)

    await repository.listPageAfter({ afterId: 'last-id', limit: 25 })

    expect(db.group.findMany).toHaveBeenCalledWith({
      where: { id: { gt: 'last-id' } },
      take: 25,
      orderBy: { id: 'asc' }
    })
  })
})