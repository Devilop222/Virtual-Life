/**
 * اعمالِ فرسودگیِ طبیعیِ بدن — پلی بین «منحنیِ فرسودگی» و «ثبتِ مرگ».
 *
 * ## چرا Lazy؟
 * همین قراردادی که کلِ این پروژه روی آن ساخته شده: هیچ تایمرِ سرانه‌ای وجود
 * ندارد. ستونِ `healthSyncedAt` مبدأ زمان است؛ هر بار که این سرویس صدا زده
 * شود، **کلِ** بازهٔ سپری‌شده از آن مبدأ یک‌جا حساب و اعمال می‌شود. پس:
 *   • restart ربات هیچ‌چیز را نمی‌بُرد و چیزی را دوبار اعمال نمی‌کند،
 *   • خاموشیِ طولانیِ سرور به‌درستی «پیشرفتِ آفلاین» می‌شود (بدن در غیابِ
 *     بازیکن هم فرسوده می‌شود — همان چیزی که این سیستم برایش ساخته شده)،
 *   • و هیچ حلقهٔ پس‌زمینه‌ای لازم نیست تا بازی کار کند.
 *
 * ## چرا کسر گم نمی‌شود؟
 * `vitalityDecayAmount` عددِ اعشاری می‌دهد. این سرویس فقط بخشِ صحیح را از
 * سلامت کم می‌کند و بعد مبدأ را **دقیقاً** به‌اندازهٔ همان بخشِ مصرف‌شده جلو
 * می‌برد (`advanceCursor`). باقی‌ماندهٔ کسری در مبدأ باقی می‌ماند و در دورهٔ
 * بعد مصرف می‌شود؛ پس با ۱۰۰۰ بار همگام‌سازی هم یک واحد سلامت گم نمی‌شود.
 *
 * ## چرا مرگ از همین‌جا اعلام می‌شود؟
 * قانونِ بازی «سلامت صفر = مرگ» است و این سرویس تنها جایی است که سلامت را
 * بی‌نظرِ کفِ کار پایین می‌برد. اگر مرگ را صدا نمی‌زد، بازیکنِ رهاشده برای
 * همیشه «زندهٔ صفرسلامت» می‌ماند و پروندهٔ میراثش هرگز باز نمی‌شد.
 * نوشتارِ مرگ خودش idempotent است (`DeathService.registerDeath`)، پس دو
 * فراخوانِ هم‌زمان فقط یک پرونده می‌سازد.
 */
import { NotificationType, PlayerActivityState, PlayerStatus, PrismaClient } from '@prisma/client'
import { logger } from '../../utils/logger'
import { REAL_MS_PER_GAME_MONTH } from '../../utils/game-time'
import { effectiveAge } from '../lifecycle/game-calendar'
import { DEATH_CAUSE, type DeathService } from '../inheritance/death.service'
import type { NotificationLevel } from '../notification/push'
import {
  VITALITY_CRITICAL_HEALTH,
  VITALITY_WARNING_HEALTH,
  vitalityDecayAmount,
  vitalityDecayPerGameMonth
} from './vitality'

/** کمترین فاصلهٔ دو همگام‌سازی برای یک بازیکن — از نوشتنِ بی‌فایده جلو می‌گیرد. */
export const VITALITY_MIN_SYNC_INTERVAL_MS = 30 * 60 * 1000

/** حداکثر بازیکنی که یک چرخهٔ دوره‌ای همگام می‌کند. */
export const VITALITY_SWEEP_LIMIT = 200

export interface VitalitySyncResult {
  /** آیا چیزی در دیتابیس نوشته شد؟ */
  changed: boolean
  healthBefore: number
  healthAfter: number
  /** آیا همین فراخوانی مرگ را ثبت کرد؟ */
  died: boolean
}

interface NotificationPort {
  notifyPlayerById: (
    playerId: string,
    title: string,
    message: string,
    type?: NotificationType,
    dedupeKey?: string,
    level?: NotificationLevel
  ) => Promise<boolean>
}

/** آموزشِ کوتاهِ «چه کار کنم» — بدون اصطلاح فنی. */
const ADVICE = 'می‌توانی در درمانگاه سلامتت را برگردانی، یا در خانه استراحت کنی.'

export class VitalityService {
  constructor(
    private readonly db: PrismaClient,
    private readonly deathService?: DeathService,
    private readonly notificationService?: NotificationPort
  ) {}

  /**
   * همگام‌سازیِ فرسودگیِ یک بازیکن.
   *
   * @param opts.force از فاصلهٔ حداقلِ همگام‌سازی بگذر (برای تست و پنلِ سلامت).
   */
  async syncPlayer(
    playerId: string,
    opts: { force?: boolean; now?: number } = {}
  ): Promise<VitalitySyncResult | null> {
    const now = opts.now ?? Date.now()
    const player = await this.db.player.findUnique({
      where: { id: playerId },
      select: {
        id: true,
        health: true,
        status: true,
        age: true,
        startedAt: true,
        healthSyncedAt: true,
        activityState: true
      }
    })
    if (!player) {
      return null
    }
    // شخصیتِ مرده یا مسدود فرسوده نمی‌شود؛ پروندهٔ میراثش نباید با یک
    // همگام‌سازیِ دیرهنگام دوباره باز شود.
    if (player.status !== PlayerStatus.ACTIVE) {
      return null
    }
    const healthBefore = Math.max(0, player.health)
    if (healthBefore <= 0) {
      // سلامت همین حالا صفر است ولی مرگ ثبت نشده؛ همان‌جا مرگ اعلام می‌شود.
      return this.finishDeath(playerId, healthBefore)
    }

    const elapsedMs = now - player.healthSyncedAt.getTime()
    if (!opts.force && elapsedMs < VITALITY_MIN_SYNC_INTERVAL_MS) {
      return null
    }

    const age = effectiveAge(player.startedAt, player.age)
    const rate = vitalityDecayPerGameMonth(age)
    // استراحت، بدن را بازمی‌گرداند؛ پس بدنِ در حالِ استراحت کندتر فرسوده می‌شود.
    const resting = player.activityState === PlayerActivityState.RESTING
    const decay = vitalityDecayAmount(elapsedMs, rate, resting)

    // فقط بخشِ صحیح کم می‌شود؛ کسر با جابه‌جاییِ دقیقِ مبدأ باقی می‌ماند.
    const consumed = Math.floor(decay)
    const nextCursor = this.advanceCursor(player.healthSyncedAt, consumed, rate, resting, now)

    if (consumed <= 0) {
      // سلامت تغییر نمی‌کند ولی مبدأ باید جلو برود تا کسرِ انباشته باقی بماند.
      await this.db.player.updateMany({
        where: { id: playerId, healthSyncedAt: player.healthSyncedAt },
        data: { healthSyncedAt: nextCursor }
      })
      return { changed: false, healthBefore, healthAfter: healthBefore, died: false }
    }

    const healthAfter = Math.max(0, healthBefore - consumed)

    // نوشتار شرطی روی «سلامت و مبدأیی که خواندیم»: اگر بین خواندن و نوشتن،
    // مسیر دیگری (درمان، استراحت، ادمین) سلامت را عوض کرده باشد، صفر ردیف
    // می‌خورد و فرسودگیِ محاسبه‌شده روی نتیجهٔ او خراب نمی‌شود. مبدأ هم
    // دست‌نخورده می‌ماند تا دورهٔ بعد دوباره حساب شود (نه دوبار، نه صفر).
    const written = await this.db.player.updateMany({
      where: { id: playerId, health: healthBefore, healthSyncedAt: player.healthSyncedAt },
      data: { health: healthAfter, healthSyncedAt: nextCursor }
    })
    if (written.count !== 1) {
      return { changed: false, healthBefore, healthAfter: healthBefore, died: false }
    }

    if (healthAfter <= 0) {
      return this.finishDeath(playerId, healthBefore)
    }

    await this.warnIfNeeded(playerId, healthBefore, healthAfter)
    return { changed: true, healthBefore, healthAfter, died: false }
  }

  /**
   * چرخهٔ دوره‌ای: قدیمی‌ترین همگام‌سازی‌ها اول.
   *
   * بدون این چرخه، بازیکنی که دیگر ربات را باز نمی‌کند هرگز فرسوده نمی‌شد و
   * «میراثِ رهاشده» هیچ‌وقت اجرا نمی‌شد — یعنی همان نقصی که این سیستم برای
   * رفعش ساخته شده، فقط به پنل‌ها منتقل می‌شد.
   */
  async sweep(limit: number = VITALITY_SWEEP_LIMIT): Promise<{
    processed: number
    changed: number
    died: number
  }> {
    const cutoff = new Date(Date.now() - VITALITY_MIN_SYNC_INTERVAL_MS)
    const candidates = await this.db.player.findMany({
      where: {
        status: PlayerStatus.ACTIVE,
        healthSyncedAt: { lt: cutoff }
      },
      orderBy: { healthSyncedAt: 'asc' },
      take: Math.max(1, limit),
      select: { id: true }
    })

    let changed = 0
    let died = 0
    for (const candidate of candidates) {
      try {
        const result = await this.syncPlayer(candidate.id)
        if (result?.changed) changed += 1
        if (result?.died) died += 1
      } catch (error) {
        // یک بازیکنِ خراب نباید کلِ چرخه را بخواباند.
        logger.warn({ err: error, playerId: candidate.id }, 'vitality sync failed for player')
      }
    }
    if (died > 0) {
      logger.info({ processed: candidates.length, changed, died }, 'vitality sweep finished')
    }
    return { processed: candidates.length, changed, died }
  }

  /**
   * مبدأ زمان را دقیقاً به‌اندازهٔ بخشِ مصرف‌شده جلو می‌برد.
   *
   * چرا ساده `now` نمی‌شود؟ چون آن‌وقت کسرِ باقی‌مانده برای همیشه دور ریخته
   * می‌شد. و چرا از سلامتِ جدید حساب نمی‌شود؟ چون سلامت دست‌کاریِ مسیرهای
   * دیگر است. مبدأ باید فقط «زمانِ مصرف‌شده» را رد کند و نه بیشتر.
   */
  private advanceCursor(
    cursor: Date,
    consumed: number,
    rate: number,
    resting: boolean,
    now: number
  ): Date {
    if (rate <= 0) {
      return new Date(now)
    }
    const factor = resting ? 0.5 : 1
    const consumedMs = (consumed / (rate * factor)) * REAL_MS_PER_GAME_MONTH
    const next = cursor.getTime() + consumedMs
    // هرگز از «الان» جلو نزن؛ وگرنه مبدأ آینده می‌شد و فرسودگی منفی می‌ساخت.
    return new Date(Math.min(next, now))
  }

  /** ثبت مرگ از مسیر واحد + گزارش علت. */
  private async finishDeath(playerId: string, healthBefore: number): Promise<VitalitySyncResult> {
    if (!this.deathService) {
      logger.warn({ playerId }, 'vitality reached zero but no death service is wired')
      return { changed: false, healthBefore, healthAfter: 0, died: false }
    }
    const result = await this.deathService.registerDeath(playerId, DEATH_CAUSE.health)
    return {
      changed: true,
      healthBefore,
      healthAfter: 0,
      died: result.newlyDead
    }
  }

  /**
   * هشدارِ دو پله‌ای.
   *
   * چرا دو پله؟ یک هشدارِ تک‌پله‌ای در آستانهٔ بحرانی، بازیکن را وقتی خبر
   * می‌کند که تقریباً کار از کار گذشته و درمانش گران است. پلهٔ «نصف» یک فرصتِ
   * ارزان می‌دهد و پلهٔ «بحرانی» جدی می‌گیرد.
   */
  private async warnIfNeeded(
    playerId: string,
    healthBefore: number,
    healthAfter: number
  ): Promise<void> {
    if (!this.notificationService) {
      return
    }
    const day = new Date().toISOString().slice(0, 10)
    if (healthBefore > VITALITY_WARNING_HEALTH && healthAfter <= VITALITY_WARNING_HEALTH) {
      await this.notificationService
        .notifyPlayerById(
          playerId,
          '🩺 سلامتت به نصف رسید',
          `سلامتت به ${healthAfter} رسید. بدن با گذرِ زمان فرسوده می‌شود و کم‌کم ` +
            `نمی‌توانی کار کنی.\n${ADVICE}`,
          NotificationType.SYSTEM,
          `vitality-warn:${playerId}:${day}`,
          'IMPORTANT'
        )
        .catch(() => undefined)
      return
    }
    if (healthBefore > VITALITY_CRITICAL_HEALTH && healthAfter <= VITALITY_CRITICAL_HEALTH) {
      await this.notificationService
        .notifyPlayerById(
          playerId,
          '🚨 سلامتت بحرانی است',
          `سلامتت به ${healthAfter} رسید و زیرِ ۱۱ دیگر نمی‌توانی کار کنی. ` +
            `اگر به صفر برسد، زندگی این شخصیت تمام می‌شود.\n${ADVICE}`,
          NotificationType.SYSTEM,
          `vitality-critical:${playerId}:${day}`,
          'CRITICAL'
        )
        .catch(() => undefined)
    }
  }
}
