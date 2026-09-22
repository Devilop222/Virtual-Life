import { PrismaClient } from '@prisma/client'

export class JobCapacityRepository {
  constructor(private readonly db: PrismaClient) {}

  async findByJobKey(jobKey: string) {
    return this.db.jobCapacity.findUnique({ where: { jobKey } })
  }

  async listAll() {
    return this.db.jobCapacity.findMany()
  }

  async upsertCapacity(jobKey: string, capacity: number): Promise<void> {
    await this.db.jobCapacity.upsert({
      where: { jobKey },
      create: { jobKey, capacity, occupied: 0 },
      update: { capacity: Math.max(0, capacity) }
    })
  }

  async getOccupied(jobKey: string): Promise<number> {
    const row = await this.db.jobCapacity.findUnique({ where: { jobKey } })
    return row?.occupied ?? 0
  }

  /**
   * اشغال یک ظرفیت به‌صورت اتمیک.
   * شرط `occupied < capacity` داخل خود UPDATE است تا دو بازیکن همزمان
   * نتوانند آخرین ظرفیت را بگیرند.
   * جدول ستون id ندارد؛ کلید اصلی job_key است.
   */
  async takeSlot(jobKey: string): Promise<boolean> {
    const rows = await this.db.$queryRaw<{ job_key: string }[]>`
      UPDATE "job_capacities"
      SET "occupied" = "occupied" + 1, "updated_at" = NOW()
      WHERE "job_key" = ${jobKey} AND "occupied" < "capacity"
      RETURNING "job_key"
    `
    return rows.length === 1
  }

  /**
   * آشتی‌دادنِ شمارندهٔ اشغال با تعداد واقعی شیفت‌های فعال.
   *
   * نوشتار شرطی است (`occupied` فقط وقتی عوض می‌شود که با واقعیت فرق داشته
   * باشد) تا همگام‌سازیِ دوره‌ای هر ده دقیقه، نوشتارِ بی‌اثر تولید نکند.
   * عمداً با Prisma نوشته شده و نه SQL خام — این فایل تنها دو دستور SQL خام
   * دارد که هر دو باید اتمیک بمانند و آزمونِ انطباقِ SQL با اسکیما روی
   * همان‌ها نگهبانی می‌کند.
   */
  async reconcileOccupied(jobKey: string, actual: number): Promise<number> {
    const safe = Math.max(0, Math.floor(actual))
    const result = await this.db.jobCapacity.updateMany({
      where: { jobKey, occupied: { not: safe } },
      data: { occupied: safe }
    })
    return result.count
  }

  async releaseSlot(jobKey: string): Promise<void> {
    await this.db.$executeRaw`
      UPDATE "job_capacities"
      SET "occupied" = GREATEST("occupied" - 1, 0), "updated_at" = NOW()
      WHERE "job_key" = ${jobKey}
    `
  }
}