import { PrismaClient, Skill } from '@prisma/client'

export class SkillRepository {
  constructor(private readonly db: PrismaClient) {}

  async findByName(name: string): Promise<Skill | null> {
    return this.db.skill.findUnique({
      where: { name }
    })
  }

  /**
   * نگاشت نام مهارت → شناسه، در یک Query.
   * پایانِ هر شیفت و فارغ‌التحصیلی چند مهارت را با هم حل می‌کنند؛ حلقهٔ
   * `findByName` به‌ازای هر مهارت یک رفت‌وبرگشت به دیتابیس می‌زد (N+1).
   */
  async findIdsByNames(names: readonly string[]): Promise<Map<string, string>> {
    if (names.length === 0) {
      return new Map()
    }
    const rows = await this.db.skill.findMany({
      where: { name: { in: [...names] } },
      select: { id: true, name: true }
    })
    return new Map(rows.map((row) => [row.name, row.id]))
  }

  async findById(id: string): Promise<Skill | null> {
    return this.db.skill.findUnique({ where: { id } })
  }

  async list(): Promise<Skill[]> {
    return this.db.skill.findMany({
      orderBy: { name: 'asc' }
    })
  }
}