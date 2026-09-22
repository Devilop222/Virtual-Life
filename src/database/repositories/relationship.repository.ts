import { Prisma, PrismaClient } from '@prisma/client'

export class RelationshipRepository {
  constructor(private readonly db: PrismaClient) {}

  async listByPlayerId(playerId: string): Promise<
    Prisma.RelationshipGetPayload<{
      include: {
        relatedPlayer: { select: { firstName: true; lastName: true } }
      }
    }  >[]
  > {
    return this.db.relationship.findMany({
      where: { playerId },
      include: {
        relatedPlayer: {
          select: {
            firstName: true,
            lastName: true
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    })
  }
}
