import { PlayerRepository } from '../../database/repositories/player.repository'
import { JobCapacityRepository } from '../../database/repositories/job-capacity.repository'
import { WorkSessionRepository } from '../../database/repositories/work-session.repository'
import { PART_TIME_JOBS } from './work-blueprints'

const SYNC_TTL_MS = 10 * 60 * 1000
let lastSyncAt = 0

export class JobCapacityService {
  constructor(
    private readonly jobCapacityRepository: JobCapacityRepository,
    private readonly playerRepository: PlayerRepository,
    /** اختیاری: برای آشتیِ شمارندهٔ ظرفیت با شیفت‌های فعالِ واقعی. */
    private readonly workSessionRepository?: WorkSessionRepository
  ) {}

  private computeCapacity(baseCapacity: number, activePlayers: number): number {
    const scale = 1 + Math.floor(activePlayers / 500)
    return Math.min(baseCapacity * 4, Math.max(baseCapacity, baseCapacity * scale))
  }

  async syncCapacities(): Promise<void> {
    if (Date.now() - lastSyncAt < SYNC_TTL_MS) {
      return
    }

    const activePlayers = await this.playerRepository.countPlayers()

    // هر شغل ردیفِ خودش را دارد؛ ~۳۴ نوشتارِ مستقل موازی می‌شوند تا
    // همگام‌سازیِ ده‌دقیقه‌ای به‌جای ۳۴ رفت‌وبرگشتِ پیاپی، یک موج باشد.
    await Promise.all(
      PART_TIME_JOBS.map((job) =>
        this.jobCapacityRepository.upsertCapacity(
          job.key,
          this.computeCapacity(job.baseCapacity, activePlayers)
        )
      )
    )

    const allJobs = new Set(PART_TIME_JOBS.map((j) => j.key))
    const existing = await this.jobCapacityRepository.listAll()
    await Promise.all(
      existing
        .filter((row) => !allJobs.has(row.jobKey))
        .map((row) => this.jobCapacityRepository.upsertCapacity(row.jobKey, 0))
    )

    await this.reconcileOccupied(existing)

    lastSyncAt = Date.now()
  }

  /**
   * شمارندهٔ «اشغال» را با تعداد واقعی شیفت‌های فعال یکی می‌کند.
   *
   * چرا لازم است: ظرفیت فقط در `releaseSlot` آزاد می‌شود و آن هم تنها از مسیر
   * «پایان کار» صدا زده می‌شود. اگر ربات وسطِ شیفت خاموش شود، نشست ACTIVE
   * می‌ماند و ظرفیت آن شغل برای همیشه یک واحد کمتر می‌شود — تا جایی که شغل
   * پر به‌نظر برسد و هیچ‌کس نتواند شروع کند. یک کوئری تجمیعی در هر
   * همگام‌سازیِ ده‌دقیقه‌ای این نشتی را می‌بندد.
   */
  private async reconcileOccupied(
    existing: Array<{ jobKey: string; occupied: number }>
  ): Promise<void> {
    if (!this.workSessionRepository) {
      return
    }
    const actual = await this.workSessionRepository.countActiveByJob().catch(() => null)
    if (!actual) {
      return
    }
    // نوشتارهای شرطیِ مستقل؛ موازی می‌شوند.
    await Promise.all(
      existing
        .filter((row) => (actual.get(row.jobKey) ?? 0) !== row.occupied)
        .map((row) =>
          this.jobCapacityRepository.reconcileOccupied(row.jobKey, actual.get(row.jobKey) ?? 0)
        )
    )
  }

  async getCapacityMap(): Promise<Record<string, { capacity: number; occupied: number }>> {
    await this.syncCapacities()
    const rows = await this.jobCapacityRepository.listAll()
    const map: Record<string, { capacity: number; occupied: number }> = {}
    for (const row of rows) {
      map[row.jobKey] = { capacity: row.capacity, occupied: row.occupied }
    }
    return map
  }

  /**
   * تضمین وجود ردیف ظرفیت برای یک شغل با کمترین تعداد Query.
   * فقط زمانی countPlayers صدا زده می‌شود که ردیف واقعاً وجود نداشته باشد.
   */
  private async ensureCapacityRow(jobKey: string): Promise<void> {
    const existing = await this.jobCapacityRepository.findByJobKey(jobKey)
    if (existing) {
      return
    }

    const jobDef = PART_TIME_JOBS.find((j) => j.key === jobKey)
    if (!jobDef) {
      return
    }

    const activePlayers = await this.playerRepository.countPlayers()
    await this.jobCapacityRepository.upsertCapacity(
      jobKey,
      this.computeCapacity(jobDef.baseCapacity, activePlayers)
    )
  }

  async takeSlot(jobKey: string): Promise<boolean> {
    await this.ensureCapacityRow(jobKey)
    return this.jobCapacityRepository.takeSlot(jobKey)
  }

  async releaseSlot(jobKey: string): Promise<void> {
    await this.jobCapacityRepository.releaseSlot(jobKey)
  }
}