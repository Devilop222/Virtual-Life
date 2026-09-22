import { Prisma, PrismaClient, PlayerSkill } from '@prisma/client'

/** هر ۱۵ دقیقهٔ کارِ مرتبط ۱ امتیاز تمرین می‌دهد. */
export const SKILL_PRACTICE_MINUTES = 15
/** هر ۵۰ امتیاز یک سطح مهارت. */
export const SKILL_POINTS_PER_LEVEL = 50
/** سقف سطح مهارت. */
export const SKILL_MAX_LEVEL = 10

export class PlayerSkillRepository {
  constructor(private readonly db: PrismaClient) {}

  /**
   * میانگین سطح مهارت‌های نام‌برده‌شده؛ مهارتِ ثبت‌نشده سطح ۱ حساب می‌شود.
   * فهرست خالی/null یعنی «بدون نیاز مهارتی» → undefined (ضریب بی‌اثر).
   */
  async averageLevelForSkillNames(
    playerId: string,
    skillNames: string[] | null | undefined
  ): Promise<number | undefined> {
    if (!skillNames || skillNames.length === 0) {
      return undefined
    }
    const rows = await this.db.playerSkill.findMany({
      where: { playerId, skill: { name: { in: skillNames } } },
      select: { level: true }
    })
    const known = Math.min(rows.length, skillNames.length)
    const total =
      rows.reduce((acc, r) => acc + r.level, 0) + (skillNames.length - known) * 1
    return total / skillNames.length
  }

  async listByPlayerId(playerId: string): Promise<
    (PlayerSkill & { skill: { id: string; name: string; description: string | null } })[]
  > {
    return this.db.playerSkill.findMany({
      where: { playerId },
      include: {
        skill: {
          select: {
            id: true,
            name: true,
            description: true
          }
        }
      }
    })
  }

  async assign(
    playerId: string,
    skillId: string,
    level = 1,
    tx: Prisma.TransactionClient = this.db
  ): Promise<PlayerSkill> {
    return tx.playerSkill.upsert({
      where: {
        playerId_skillId: { playerId, skillId }
      },
      create: { playerId, skillId, level },
      update: { level }
    })
  }

  /**
   * اعطای سطح مهارت بدونِ پسرفت.
   *
   * تفاوتش با `assign` مهم است: `assign` سطح را *جایگزین* می‌کند (برای تنظیم
   * دستیِ ادمین) ولی اینجا بالاترینِ «سطح فعلی» و «سطح اعطایی» نگه داشته
   * می‌شود. پیش‌تر فارغ‌التحصیلی از `assign(…, 2)` استفاده می‌کرد، یعنی
   * بازیکنی که با کارِ مرتبط «برنامه‌نویسی» را به سطح ۷ رسانده بود، با گرفتن
   * مدرک مهندسی نرم‌افزار به سطح ۲ سقوط می‌کرد — ناقضِ همان اصلی که
   * `addPracticePoints` رعایت می‌کند («سطحِ ازپیش‌کسب‌شده هرگز پایین نمی‌آید»).
   *
   * امتیازهای تمرین هم دست‌نخورده می‌مانند تا نوار پیشرفتِ بازیکن نپرد.
   */
  async awardLevel(
    playerId: string,
    skillId: string,
    level: number,
    tx: Prisma.TransactionClient = this.db
  ): Promise<PlayerSkill> {
    const safeLevel = Math.max(1, Math.min(SKILL_MAX_LEVEL, Math.floor(level)))
    const existing = await tx.playerSkill.findUnique({
      where: { playerId_skillId: { playerId, skillId } }
    })
    if (!existing) {
      return tx.playerSkill.create({
        data: { playerId, skillId, level: safeLevel }
      })
    }
    const finalLevel = Math.max(existing.level, safeLevel)
    if (finalLevel === existing.level) {
      return existing
    }
    return tx.playerSkill.update({
      where: { id: existing.id },
      data: { level: finalLevel }
    })
  }

  async increaseLevel(playerId: string, skillId: string): Promise<PlayerSkill> {
    return this.db.playerSkill.update({
      where: {
        playerId_skillId: { playerId, skillId }
      },
      data: {
        level: { increment: 1 }
      }
    })
  }

  /**
   * تمرین عملی: هر ۱۵ دقیقهٔ کارِ مرتبط، ۱ امتیاز تجربه به مهارت می‌دهد؛
   * هر ۵۰ امتیاز یک سطح (سقف ۱۰). سطحِ ازپیش‌کسب‌شده (مثلاً از تحصیل)
   * هرگز پایین نمی‌آید.
   */
  async addPracticePoints(
    playerId: string,
    skillIds: string[],
    minutes: number
  ): Promise<number> {
    if (skillIds.length === 0 || minutes < SKILL_PRACTICE_MINUTES) {
      return 0
    }
    const points = Math.floor(minutes / SKILL_PRACTICE_MINUTES)

    await this.db.$transaction(async (tx) => {
      for (const skillId of skillIds) {
        const existing = await tx.playerSkill.findUnique({
          where: { playerId_skillId: { playerId, skillId } }
        })
        if (existing) {
          const newPoints = existing.points + points
          const levelFromPoints = Math.min(SKILL_MAX_LEVEL, 1 + Math.floor(newPoints / SKILL_POINTS_PER_LEVEL))
          await tx.playerSkill.update({
            where: { id: existing.id },
            data: { points: newPoints, level: Math.max(existing.level, levelFromPoints) }
          })
        } else {
          await tx.playerSkill.create({
            data: {
              playerId,
              skillId,
              points,
              level: Math.min(SKILL_MAX_LEVEL, 1 + Math.floor(points / SKILL_POINTS_PER_LEVEL))
            }
          })
        }
      }
    })

    return points
  }
}