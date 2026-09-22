/**
 * مرگ — تنها نقطهٔ ثبتِ فوت و آغازِ پروندهٔ میراث.
 *
 * ## قانون بازی
 * `health > 0` زنده، `health === 0` مرده. این ماژول همان قانون را «مسیر
 * واحد» می‌کند: هر مسیری که سلامت یک بازیکن را به صفر می‌رساند (تنظیم دستی
 * مدیر، و هر سیستم آیندهٔ آسیب) فقط `registerDeath` را صدا می‌زند و هیچ‌کدام
 * خودشان وضعیت مرگ را نمی‌نویسند.
 *
 * ## چرا idempotent؟
 * مرگ می‌تواند از دو مسیر هم‌زمان برسد (کلیک دوبارهٔ مدیر، دو درخواست موازی،
 * تلاش دوباره پس از restart). پس:
 *   • قیدِ یکتای `inheritance_cases.deceased_id` فقط یک پرونده را ممکن می‌کند.
 *   • نوشتار وضعیت بازیکن شرطی است (`status != DEAD`)، پس بار دوم `count === 0`
 *     می‌شود و هیچ‌چیز دوباره اجرا نمی‌شود.
 *   • نشستِ کاریِ باز در همان تراکنش لغو می‌شود؛ وگرنه «پایان شیفت» بعد از مرگ
 *     برای یک شخصیت مرده پول واریز می‌کرد.
 *
 * ## چرا پس از مرگ، پول دست نمی‌خورد؟
 * ترتیب عمدی است: اول «مرگ» به‌صورت اتمیک ثبت می‌شود، بعد میراث اجرا می‌گردد.
 * اگر اجرای میراث خطا بخورد، شخصیت مرده است ولی دارایی‌اش سرِ جایش می‌ماند
 * (نه دزدیده می‌شود، نه گم) و پرونده با `lastError` برای تلاش دوباره باز می‌ماند.
 */
import {
  NotificationType,
  PlayerActivityState,
  PlayerStatus,
  PrismaClient,
  WorkSessionStatus
} from '@prisma/client'
import { logger } from '../../utils/logger'
import type { NotificationLevel } from '../notification/push'
import { InheritanceService } from './inheritance.service'
import { EventService } from '../events/event.service'
import { GameEventType } from '@prisma/client'

/** کدهای علت مرگ (دادهٔ داخلی؛ برچسبش در `DEATH_CAUSE_LABELS`). */
export const DEATH_CAUSE = {
  health: 'health',
  admin: 'admin',
  unknown: 'unknown'
} as const

export type DeathCause = (typeof DEATH_CAUSE)[keyof typeof DEATH_CAUSE]

/** برچسب انسانیِ علت مرگ — بدون اصطلاح فنی و بدون قضاوت. */
export const DEATH_CAUSE_LABELS: Record<string, string> = {
  health: 'از دست دادن کاملِ سلامت',
  admin: 'تصمیم مدیریت بازی',
  unknown: 'نامشخص'
}

export function deathCauseLabel(cause: string): string {
  return DEATH_CAUSE_LABELS[cause] ?? 'نامشخص'
}

export interface DeathResult {
  /** آیا همین فراخوانی مرگ را ثبت کرد؟ (`false` یعنی قبلاً مرده بود) */
  newlyDead: boolean
  caseId: string | null
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

export class DeathService {
  constructor(
    private readonly db: PrismaClient,
    private readonly inheritance: InheritanceService,
    private readonly notificationService?: NotificationPort,
    private readonly eventService?: EventService
  ) {}

  /**
   * ثبت مرگ و سپس اجرای میراث.
   *
   * @param opts.skipInheritance برای مسیرهایی که می‌خواهند فقط وضعیت را
   *        عوض کنند (تست/بازسازی داده) و انتقال را دستی اجرا کنند.
   */
  async registerDeath(
    playerId: string,
    cause: DeathCause = DEATH_CAUSE.unknown,
    opts: { skipInheritance?: boolean } = {}
  ): Promise<DeathResult> {
    const existing = await this.db.inheritanceCase.findFirst({
      where: { deceasedId: playerId },
      orderBy: { lifeIndex: 'desc' },
      select: { id: true, lifeIndex: true }
    })
    // پروندهٔ زندگیِ *جاری* بسته شده است (یعنی همین زندگی قبلاً مرده) — نه
    // پروندهٔ یک زندگیِ قدیمی که بعد از «زندگی تازه» هم روی دیسک مانده.
    if (existing) {
      const player = await this.db.player.findUnique({
        where: { id: playerId },
        select: { lives: true, status: true }
      })
      if (player && player.lives <= existing.lifeIndex && player.status === PlayerStatus.DEAD) {
        return { newlyDead: false, caseId: existing.id }
      }
    }

    // متغیر بیرونِ بلوک تعریف می‌شود چون داخل تراکنش پر می‌شود ولی پس از آن
    // (برای اعلان و اجرای میراث) لازم است.
    let caseId: string | null = null
    {
      const newlyDead = await this.db
        .$transaction(async (tx) => {
          // شرطِ `where` عمداً فقط شناسه است و نه «وضعیت هنوز DEAD نشده».
          // اگر مسیر دیگری وضعیت را مستقیم DEAD کرده باشد و پرونده‌ای نساخته
          // باشد (پنل ادمین چنین اختیاری دارد)، این‌جا «پذیرش» می‌شود؛ وگرنه آن
          // شخصیت برای همیشه «مردهٔ بی‌پرونده» می‌ماند و دارایی‌اش هرگز به وارث
          // نمی‌رسد. جلوگیری از پردازشِ دوباره کارِ `findUnique` بالای همین تابع
          // و قیدِ یکتای `inheritance_cases.deceased_id` است.
          const claimed = await tx.player.updateMany({
            where: { id: playerId },
            data: {
              status: PlayerStatus.DEAD,
              // کفِ سلامت صفر می‌شود تا اینورینتِ «سلامت هرگز منفی نیست» و
              // «صفر یعنی مرده» با هم سازگار بمانند؛ اگر مسیر فراخوان سلامت
              // را منفی گذاشته باشد، این‌جا نرمال می‌شود.
              health: 0,
              activityState: PlayerActivityState.IDLE,
              restStartedAt: null
            }
          })
          if (claimed.count !== 1) return false

          // شیفتِ باز باید بسته شود؛ وگرنه تسویهٔ شیفت برای شخصیتِ مرده پول واریز می‌کند
          await tx.workSession.updateMany({
            where: { playerId, status: WorkSessionStatus.ACTIVE },
            data: { status: WorkSessionStatus.CANCELLED, endedAt: new Date() }
          })

          // شمارهٔ زندگی از خودِ ردیفِ بازیکن خوانده می‌شود، نه از تعدادِ
          // پرونده‌ها: اگر روزی پرونده‌ای دستی پاک شود، تعداد دیگر با شمارهٔ
          // زندگی هم‌خوان نیست و شمارشِ ساده پروندهٔ تکراری می‌ساخت.
          const lifeRow = await tx.player.findUniqueOrThrow({
            where: { id: playerId },
            select: { lives: true }
          })
          const created = await tx.inheritanceCase.create({
            data: { deceasedId: playerId, lifeIndex: lifeRow.lives, cause }
          })
          caseId = created.id
          return true
        })
        .catch(async (error) => {
          // رقابت روی قیدِ یکتایی: مسیر دیگر همان لحظه پرونده را ساخت
          logger.warn({ err: error, playerId }, 'death registration raced; re-reading case')
          const raced = await this.db.inheritanceCase.findFirst({
            where: { deceasedId: playerId },
            orderBy: { lifeIndex: 'desc' },
            select: { id: true }
          })
          caseId = raced?.id ?? null
          return false
        })

      if (!newlyDead) {
        return { newlyDead: false, caseId }
      }

      logger.info({ playerId, cause, caseId }, 'player died; inheritance case opened')

      await this.notificationService
        ?.notifyPlayerById(
          playerId,
          '⚰️ شخصیتت از دنیا رفت',
          `سلامتت به صفر رسید و این زندگی بسته شد (${deathCauseLabel(cause)}).\n` +
            'دارایی‌هایت طبق وصیت به وارثت منتقل می‌شود؛ اگر وصیتی ثبت نکرده بودی، دارایی محفوظ می‌ماند.\n' +
            'می‌توانی با /start یک شخصیت تازه بسازی — و این بار از پنل «وصیت» وارثت را مشخص کن.',
          undefined,
          `death:${caseId}`,
          'CRITICAL'
        )
        .catch(() => undefined)

      // سرگذشتِ بازیکن باید مرگ را ثبت کند؛ وگرنه آخرین رخدادِ زندگی‌اش
      // «کار» یا «خرید» می‌ماند و تاریخچه بی‌معنا می‌شود.
      await this.eventService
        ?.recordPlayerEvent({
          playerId,
          type: GameEventType.PLAYER_DIED,
          title: 'پایان زندگی',
          detail: `علت: ${deathCauseLabel(cause)}`,
          dedupeKey: `death-event:${caseId}`
        })
        .catch(() => undefined)

      if (!opts.skipInheritance && caseId) {
        await this.inheritance.runForDeceased(playerId).catch((error) => {
          logger.error({ err: error, playerId }, 'inheritance run after death failed')
        })
      }
      return { newlyDead: true, caseId }
    }
  }

  /**
   * بررسی Lazy سلامت: اگر بازیکن زنده است ولی سلامتش صفر شده، همین‌جا مرگ
   * ثبت می‌شود.
   *
   * چرا Lazy؟ چون هر مسیر آینده‌ای که سلامت را کم کند، اگر یادش برود مرگ را
   * صدا بزند، بازیکن برای ابد «زندهٔ صفرسلامت» می‌ماند. این بررسی از پنلِ
   * وصیت اجرا می‌شود (جایی که بازیکن قطعاً خودش را می‌بیند).
   */
  async checkHealth(playerId: string): Promise<DeathResult | null> {
    const player = await this.db.player.findUnique({
      where: { id: playerId },
      select: { health: true, status: true }
    })
    if (!player || player.status === PlayerStatus.DEAD || player.health > 0) {
      return null
    }
    return this.registerDeath(playerId, DEATH_CAUSE.health)
  }

  /** آخرین پروندهٔ میراث یک بازیکن (پروندهٔ زندگیِ جاری). */

  /** آیا این بازیکن مرده است؟ (گاردِ مشترک برای سرویس‌های دیگر) */
}
