import { Occupation, PrismaClient } from '@prisma/client'

export class OccupationRepository {
  constructor(private readonly db: PrismaClient) {}

  async findByName(name: string): Promise<Occupation | null> {
    return this.db.occupation.findUnique({
      where: { name }
    })
  }

  async findById(id: string): Promise<Occupation | null> {
    return this.db.occupation.findUnique({ where: { id } })
  }

  async list(limit = 50, offset = 0): Promise<Occupation[]> {
    return this.db.occupation.findMany({
      take: limit,
      skip: offset,
      orderBy: [{ category: 'asc' }, { level: 'asc' }]
    })
  }
}