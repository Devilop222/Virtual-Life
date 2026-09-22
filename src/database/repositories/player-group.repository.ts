import {
  PlayerGroup,
  PlayerGroupActivity,
  PlayerGroupRole,
  PlayerGroupStatus,
  Prisma,
  PrismaClient
} from '@prisma/client'

export interface UpsertPlayerGroupInput {
  playerId: string
  groupId: string
  role?: PlayerGroupRole
  activity?: PlayerGroupActivity
  status?: PlayerGroupStatus
}

export class PlayerGroupRepository {
  constructor(private readonly db: PrismaClient) {}

  async findMembership(
    playerId: string,
    groupId: string
  ): Promise<PlayerGroup | null> {
    return this.db.playerGroup.findUnique({
      where: {
        playerId_groupId: {
          playerId,
          groupId
        }
      }
    })
  }

  async upsert(input: UpsertPlayerGroupInput): Promise<PlayerGroup> {
    return this.db.playerGroup.upsert({
      where: {
        playerId_groupId: {
          playerId: input.playerId,
          groupId: input.groupId
        }
      },
      create: {
        playerId: input.playerId,
        groupId: input.groupId,
        role: input.role ?? PlayerGroupRole.MEMBER,
        activity: input.activity ?? PlayerGroupActivity.NORMAL,
        status: input.status ?? PlayerGroupStatus.ACTIVE
      },
      update: {
        role: input.role,
        activity: input.activity,
        status: input.status
      }
    })
  }

  async listByPlayerId(playerId: string): Promise<
    Prisma.PlayerGroupGetPayload<{ include: { group: true } }>[]
  > {
    return this.db.playerGroup.findMany({
      where: { playerId },
      include: { group: true }
    })
  }

  /**
   * جمعیتِ بازیِ یک منطقه: شمارِ بازیکنانی که عضویتشان «فعال» است.
   *
   * `status` عمداً شرط است: عضوی که گروه را ترک کرده یا اخراج شده، دیگر
   * شهروندِ آن منطقه نیست و نباید سطحش را بالا نگه دارد.
   */
  async countActivePlayers(groupId: string): Promise<number> {
    return this.db.playerGroup.count({
      where: { groupId, status: PlayerGroupStatus.ACTIVE }
    })
  }

  async listByGroupId(groupId: string): Promise<
    Prisma.PlayerGroupGetPayload<{ include: { player: true } }>[]
  > {
    return this.db.playerGroup.findMany({
      where: { groupId },
      include: { player: true }
    })
  }
}