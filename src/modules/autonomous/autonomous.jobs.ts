/**
 * کارهای پردازشِ خودکار — «چه چیزی، هر چند وقت، و چه کسی را خبر کند».
 *
 * چرخه‌ها در `autonomous.service` زمان‌بندی می‌شوند و اینجا فقط **تعریف**
 * می‌شوند: هر کار یک فاصله دارد و یک تابع. تصمیم‌های دامنه (آیا شیفت تمام
 * شده؟ آیا واحدها تمام شده‌اند؟ آیا سطح عوض شده؟) در سرویس‌های خودشان است؛
 * اینجا فقط «چه زمانی بپرس» و «چطور به بازیکن بگو» نوشته می‌شود.
 *
 * چرا وابستگی‌ها یک بستهٔ باریک است و نه `Container`؟ چون `container.ts` این
 * ماژول را می‌سازد؛ اگر اینجا از نوعِ Container استفاده شود، حلقهٔ import
 * ساخته می‌شود. بستهٔ باریک هم حلقه را می‌بندد و هم تست را ساده می‌کند: هر
 * کار با یک شیء جعلیِ کوچک قابل آزمایش است.
 */

import { GameEventType, NotificationType } from '@prisma/client'
import { fa, money } from '../../utils/format'
import { formatGameMinutes } from '../../utils/game-time'
import { levelChangeDirection } from '../groups/environment.classifier'
import { ENVIRONMENT_LABELS, type EnvironmentPromotion } from '../groups/group.service'
import { workStopReasonText, type WorkStopReason } from '../occupation/work-due'
import type { AutoSettledShift } from '../occupation/work-session.service'
import type { GraduatedStudent } from '../education/education.service'
import type { AutonomousJob } from './autonomous.service'

// ─────────────────────────────────────────────────────────────────────────────
//  فاصلهٔ چرخه‌ها
// ─────────────────────────────────────────────────────────────────────────────

/**
 * شیفتِ کاری سریع‌ترین چرخه را دارد: کارِ پاره‌وقت یک بازهٔ واقعی است و
 * «خستگی بحرانی» باید در چند دقیقه بسته شود، نه در ساعت. یک پرس‌وجوی بسته روی
 * شیفت‌های فعال (با نمایهٔ وضعیت) هر دقیقه هزینهٔ ناچیزی دارد.
 */
export const WORK_STOP_INTERVAL_MS = 60_000
/** پایانِ دورهٔ تحصیلی یک رخدادِ روزانه است، نه دقیقه‌ای؛ دو دقیقه کافی است. */
export const EDUCATION_INTERVAL_MS = 2 * 60_000
/** سطحِ منطقه با جمعیت عوض می‌شود؛ جمعیت آهسته حرکت می‌کند. */
export const SETTLEMENT_INTERVAL_MS = 10 * 60_000
/** آگهی‌های بازار بیشترین سرعتِ انقضا را دارند (بازه‌های کوتاه). */
export const MARKET_EXPIRY_INTERVAL_MS = 15 * 60_000
/** نگهداریِ سنگین: همان ۶ ساعتی که پیش از این هم بود. */
export const MAINTENANCE_INTERVAL_MS = 6 * 60 * 60 * 1000

/** کلیدهای کارهای دوره‌ایِ موجود که به همین چرخه منتقل شده‌اند. */
export type PeriodicKey =
  | 'loanSweep'
  | 'vitality'
  | 'inheritanceRecovery'
  | 'projectAnnouncements'
  | 'underwork'
  | 'marketExpiry'
  | 'retention'

/** فاصلهٔ هر کار دوره‌ای — نگهداری سنگین ۶ ساعته، انقضای بازار کوتاه‌تر. */
const PERIODIC_INTERVALS: Record<PeriodicKey, number> = {
  loanSweep: MAINTENANCE_INTERVAL_MS,
  vitality: MAINTENANCE_INTERVAL_MS,
  inheritanceRecovery: MAINTENANCE_INTERVAL_MS,
  projectAnnouncements: MAINTENANCE_INTERVAL_MS,
  underwork: MAINTENANCE_INTERVAL_MS,
  marketExpiry: MARKET_EXPIRY_INTERVAL_MS,
  retention: MAINTENANCE_INTERVAL_MS
}

export interface AutonomousDeps {
  work: { settleDueSessions(limit?: number): Promise<AutoSettledShift[]> }
  education: { graduateDueStudents(limit?: number): Promise<GraduatedStudent[]> }
  groups: { sweepEnvironmentLevels(limit?: number): Promise<EnvironmentPromotion[]> }
  players: { findIdsByTelegramUserIds(ids: bigint[]): Promise<Map<bigint, string>> }
  notifications: {
    announce(input: {
      playerId: string
      title: string
      message: string
      type?: NotificationType
      level: 'CRITICAL' | 'IMPORTANT' | 'INFORMATIONAL' | 'INTERNAL'
      dedupeKey?: string
    }): Promise<boolean>
  }
  events: {
    recordRegionEvent(input: {
      groupId: string
      type: GameEventType
      title: string
      dedupeKey?: string
      priority?: number
    }): Promise<void>
  }
  /** کارهای دوره‌ایِ موجودِ پروژه — یک‌بار در `app.ts` به سرویس‌ها وصل می‌شوند. */
  periodic: Record<PeriodicKey, () => Promise<unknown>>
}

// ─────────────────────────────────────────────────────────────────────────────
//  متن‌های بازیکن‌محور
// ─────────────────────────────────────────────────────────────────────────────

/**
 * متنِ پایانِ خودکارِ شیفت.
 *
 * دلیلِ توقف **همیشه** گفته می‌شود: بازیکنی که کارش بی‌اعلام بسته شود فکر
 * می‌کند بازی خراب شده. عددِ واقعیِ پرداخت هم می‌آید تا او مجبور نشود برای
 * فهمیدنش پنل بانک را باز کند.
 */
export function autoStopMessage(shift: AutoSettledShift): string {
  const lines = [
    workStopReasonText(shift.reason as WorkStopReason | null),
    '',
    `👔 ${shift.jobTitle}`,
    `⏱ کارکرد: ${formatGameMinutes(shift.elapsedGameMinutes)}`,
    `⚡ خستگی این شیفت: ${fa(shift.fatigueGained)}٪`
  ]
  if (shift.workplaceName) {
    lines.push('', '💼 کارکردت ثبت شد و در تسویهٔ کارفرما پرداخت می‌شود.')
  } else if (shift.netPaid > 0) {
    lines.push(`💰 ${money(shift.netPaid)} به کیف پولت واریز شد.`)
  }
  lines.push('', '💡 با استراحت (بخش «خانه») می‌توانی دوباره سر کار بروی.')
  return lines.join('\n')
}

/** متنِ فارغ‌التحصیلیِ خودکار. */
export function graduationMessage(student: GraduatedStudent): string {
  return [
    `🎓 مدرک ${student.degreeLabel} در رشتهٔ ${student.fieldTitle} صادر شد.`,
    `⭐ ${fa(student.gainedExp)} تجربه گرفتی و مهارت‌های این رشته به پرونده‌ات اضافه شد.`,
    '',
    '💡 این مدرک در شغل‌های هم‌حوزه دستمزدت را بالا می‌برد؛ در «شغل‌ها» رشته‌ات را ببین.'
  ].join('\n')
}

/**
 * تغییرِ سطحِ منطقه — **جهت‌دار**.
 *
 * پیش از این هر تغییری «ارتقا پیدا کرد» خوانده می‌شد. سطح با جمعیت عوض می‌شود و
 * جمعیت می‌تواند کم شود؛ پس منطقهٔ شهری که به روستا برمی‌گشت پیامِ «ارتقا پیدا
 * کرد» می‌گرفت — سیستم به مالکِ خودش دروغ می‌گفت و او هم دنبالِ ویژگی‌هایی
 * می‌گشت که دیگر باز نبودند. جهت از خودِ جدولِ آستانه‌ها می‌آید
 * (`levelChangeDirection`)، پس هرگز از رفتارِ واقعیِ طبقه‌بندی جدا نمی‌افتد.
 */
export function levelChangeTitle(change: EnvironmentPromotion): string {
  return levelChangeDirection(change.from, change.to) === 'down'
    ? 'سطح منطقه‌ات پایین آمد'
    : 'منطقه‌ات ارتقا پیدا کرد'
}

/** عنوانِ خبرِ منطقه (روی تختهٔ خبرهای منطقهٔ همان گروه). */
export function levelChangeEventTitle(change: EnvironmentPromotion): string {
  return levelChangeDirection(change.from, change.to) === 'down'
    ? `منطقه به سطح «${ENVIRONMENT_LABELS[change.to]}» برگشت`
    : `منطقه به سطح «${ENVIRONMENT_LABELS[change.to]}» رسید`
}

/** متنِ تغییرِ سطحِ منطقه، برای مالک گروه. */
export function levelChangeMessage(change: EnvironmentPromotion): string {
  if (levelChangeDirection(change.from, change.to) === 'down') {
    return [
      `🏚 منطقهٔ «${change.groupTitle}» به سطح «${ENVIRONMENT_LABELS[change.to]}» برگشت.`,
      `👥 شهروندانِ بازی: ${fa(change.population)} نفر`,
      '',
      '💡 سطح منطقه با شمارِ شهروندانِ بازی تعیین می‌شود؛ با پیوستنِ شهروندانِ تازه دوباره بالا می‌رود.'
    ].join('\n')
  }
  return [
    `🏙️ منطقهٔ «${change.groupTitle}» به سطح «${ENVIRONMENT_LABELS[change.to]}» رسید.`,
    `👥 شهروندان بازی: ${fa(change.population)} نفر`,
    '',
    '💡 سطح تازه، ظرفیت و گزینه‌های اقتصادی بیشتری در همین منطقه باز می‌کند.'
  ].join('\n')
}

/**
 * کلیدِ ضدتکرارِ یک تغییرِ سطح.
 *
 * چرا مهرِ تغییر داخلِ کلید است؟ کلید در دیتابیس یکتاست و هرگز پاک نمی‌شود؛
 * اگر فقط سطحِ مقصد در کلید باشد (`…:CITY`)، منطقه‌ای که شهر → روستا → شهر
 * می‌شود برای بارِ دوم هیچ خبری نمی‌گیرد. با مهرِ تغییر، هم‌زمانیِ دو نویسنده
 * یک اعلان می‌سازد (شرطِ نوشتار فقط یک برنده دارد) ولی تغییرِ بعدیِ همان منطقه
 * هم اعلانِ خودش را دارد.
 */
export function levelChangeDedupeKey(
  prefix: string,
  change: Pick<EnvironmentPromotion, 'groupId' | 'to' | 'at'>
): string {
  return `${prefix}:${change.groupId}:${change.to}:${change.at}`
}

// ─────────────────────────────────────────────────────────────────────────────
//  ساخت کارها
// ─────────────────────────────────────────────────────────────────────────────

export function buildAutonomousJobs(deps: AutonomousDeps): AutonomousJob[] {
  const jobs: AutonomousJob[] = [
    {
      name: 'work-auto-stop',
      intervalMs: WORK_STOP_INTERVAL_MS,
      run: async () => {
        const settled = await deps.work.settleDueSessions()
        for (const shift of settled) {
          await deps.notifications.announce({
            playerId: shift.playerId,
            title: 'شیفت خودکار تمام شد',
            message: autoStopMessage(shift),
            type: NotificationType.WARNING,
            level: 'CRITICAL',
            // درست پس از تسویه اجرا می‌شود و تسویه خودش ضدتکرار است؛ این کلید
            // لایهٔ دومِ محافظت برای تحویلِ اعلان در محیط‌های رقابتی است.
            dedupeKey: `work-autostop:${shift.sessionId}`
          })
        }
      }
    },
    {
      name: 'education-graduation',
      intervalMs: EDUCATION_INTERVAL_MS,
      run: async () => {
        const graduated = await deps.education.graduateDueStudents()
        if (graduated.length === 0) {
          return
        }
        // یک پرس‌وجو برای همهٔ دانشجوهای همین چرخه (بدون N+1).
        const ids = await deps.players.findIdsByTelegramUserIds(
          graduated.map((student) => student.telegramUserId)
        )
        for (const student of graduated) {
          const playerId = ids.get(student.telegramUserId)
          if (!playerId) {
            continue
          }
          await deps.notifications.announce({
            playerId,
            title: 'فارغ‌التحصیل شدی',
            message: graduationMessage(student),
            type: NotificationType.EVENT,
            level: 'IMPORTANT',
            dedupeKey: `education-graduated:${playerId}:${student.degreeLabel}:${student.fieldTitle}`
          })
        }
      }
    },
    {
      name: 'settlement-level',
      intervalMs: SETTLEMENT_INTERVAL_MS,
      run: async () => {
        const changes = await deps.groups.sweepEnvironmentLevels()
        for (const change of changes) {
          await deps.events
            .recordRegionEvent({
              groupId: change.groupId,
              type: GameEventType.REGION_LEVEL_CHANGED,
              title: levelChangeEventTitle(change),
              dedupeKey: levelChangeDedupeKey('region-level', change),
              priority: 5
            })
            .catch(() => undefined)

          // اعلان هدفمند به مالک گروه — نه پیام گروهی به همهٔ شهروندان.
          if (!change.ownerTelegramUserId) {
            continue
          }
          const ids = await deps.players.findIdsByTelegramUserIds([change.ownerTelegramUserId])
          const ownerId = ids.get(change.ownerTelegramUserId)
          if (!ownerId) {
            continue
          }
          await deps.notifications.announce({
            playerId: ownerId,
            title: levelChangeTitle(change),
            message: levelChangeMessage(change),
            type: NotificationType.EVENT,
            level: 'IMPORTANT',
            dedupeKey: levelChangeDedupeKey('region-level-notice', change)
          })
        }
      }
    }
  ]

  for (const key of Object.keys(PERIODIC_INTERVALS) as PeriodicKey[]) {
    jobs.push({
      name: key,
      intervalMs: PERIODIC_INTERVALS[key],
      run: () => deps.periodic[key]()
    })
  }

  return jobs
}
