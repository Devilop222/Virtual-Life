import { Gender, PrismaClient, Player } from '@prisma/client'
import { PlayerRepository } from '../src/database/repositories/player.repository'

describe('PlayerRepository', () => {
  let db: {
    player: {
      findUnique: jest.Mock
      upsert: jest.Mock
    }
    financialTransaction: { createMany: jest.Mock }
    $transaction: jest.Mock
  }
  let repository: PlayerRepository

  beforeEach(() => {
    db = {
      player: {
        findUnique: jest.fn(),
        upsert: jest.fn()
      },
      financialTransaction: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
      $transaction: jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(db))
    }
    repository = new PlayerRepository(db as unknown as PrismaClient)
  })

  test('finds a player by telegram user id', async () => {
    const player = { id: 'p1', telegramUserId: 42n } as unknown as Player
    db.player.findUnique.mockResolvedValue(player)

    const result = await repository.findByTelegramUserId(42n)

    expect(result).toBe(player)
    expect(db.player.findUnique).toHaveBeenCalledWith({
      where: { telegramUserId: 42n }
    })
  })

  test('isRegistered returns true when player exists', async () => {
    db.player.findUnique.mockResolvedValue({ id: 'p1' })

    await expect(repository.isRegistered(42n)).resolves.toBe(true)
  })

  test('isRegistered returns false when player does not exist', async () => {
    db.player.findUnique.mockResolvedValue(null)

    await expect(repository.isRegistered(42n)).resolves.toBe(false)
  })

  test('creates a player via upsert (race-condition safe)', async () => {
    const player = { id: 'p1' } as unknown as Player
    db.player.upsert.mockResolvedValue(player)

    const result = await repository.createUpsert({
      telegramUserId: 42n,
      firstName: 'سارا',
      lastName: null,
      username: null,
      gender: Gender.FEMALE,
      biography: 'معلم',
      age: 24
    })

    expect(result).toBe(player)
    expect(db.player.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { telegramUserId: 42n }
      })
    )
    // سرمایهٔ اولیه یک ردیف دفتر کل دارد تا آشتی‌دادن دفتر با موجودی درست باشد
    const row = db.financialTransaction.createMany.mock.calls[0][0]
    expect(row.skipDuplicates).toBe(true)
    expect(row.data[0].destinationPlayerId).toBe('p1')
    expect(row.data[0].id).toBe('initial-capital:p1')
  })
})