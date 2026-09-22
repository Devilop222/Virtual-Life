import { PrismaClient, PlayerGroup } from '@prisma/client'
import { PlayerGroupRepository } from '../src/database/repositories/player-group.repository'

describe('PlayerGroupRepository', () => {
  let db: {
    playerGroup: {
      findUnique: jest.Mock
      upsert: jest.Mock
    }
  }
  let repository: PlayerGroupRepository

  beforeEach(() => {
    db = {
      playerGroup: {
        findUnique: jest.fn(),
        upsert: jest.fn()
      }
    }
    repository = new PlayerGroupRepository(db as unknown as PrismaClient)
  })

  test('finds an existing membership', async () => {
    const membership = { id: 'pg1' } as unknown as PlayerGroup
    db.playerGroup.findUnique.mockResolvedValue(membership)

    const result = await repository.findMembership('player-1', 'group-1')

    expect(result).toBe(membership)
    expect(db.playerGroup.findUnique).toHaveBeenCalledWith({
      where: { playerId_groupId: { playerId: 'player-1', groupId: 'group-1' } }
    })
  })

  test('upserts membership without duplicating', async () => {
    const membership = { id: 'pg1' } as unknown as PlayerGroup
    db.playerGroup.upsert.mockResolvedValue(membership)

    const result = await repository.upsert({ playerId: 'player-1', groupId: 'group-1' })

    expect(result).toBe(membership)
    expect(db.playerGroup.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          playerId_groupId: { playerId: 'player-1', groupId: 'group-1' }
        }
      })
    )
  })
})