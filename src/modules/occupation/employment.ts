import { Prisma, PrismaClient } from '@prisma/client'
import { playtimeDays } from '../../utils/game-time'

/**
 * بازهٔ «فعال اقتصادی» بودن بر اساس آخرین کار انجام‌شده.
 *
 * این یک پنجرهٔ *آماری* است (نه رخدادی در دنیای بازی)، پس همان ۷ روزِ واقعیِ
 * قبلی را نگه می‌دارد تا شاغل‌شمردن بازیکن‌ها معنای قبلی‌اش را از دست ندهد.
 */
const RECENT_WORK_MS = playtimeDays(7)

/**
 * تعریف واحد «شاغل» در کل بازی.
 *
 * فیلد `Player.occupationId` هرگز در هیچ مسیری نوشته نمی‌شود (کاتالوگ `Occupation`
 * فقط Seed است و بازیکن به آن متصل نمی‌گردد)، پس هر جا که اشتغال از آن فیلد خوانده
 * می‌شد همیشه «بیکار» برمی‌گشت. اشتغال از داده‌هایی استخراج می‌شود که واقعاً نوشته
 * می‌شوند:
 *
 *  • نوبت کاری فعال (کار پاره‌وقت در همین لحظه)
 *  • استخدام فعال در کسب‌وکار دیگری
 *  • مالکیت کسب‌وکار فعال (خودکارفرمایی)
 *  • نوبت کاری تمام‌شده در هفت روز گذشته (اشتغال دوره‌ای)
 *
 * این تعریف در یک نقطه نگه داشته می‌شود تا پنل شناسنامه، اعتبار مالی، مأموریت‌ها
 * و شاخص اقتصادی منطقه هیچ‌وقت اعداد ناسازگار نشان ندهند.
 */
export function employedPlayerFilter(now = Date.now()): Prisma.PlayerWhereInput {
  return {
    OR: [
      { workSessions: { some: { status: 'ACTIVE' } } },
      { employments: { some: { isActive: true } } },
      { ownedBusinesses: { some: { status: 'ACTIVE' } } },
      {
        workSessions: {
          some: {
            status: 'COMPLETED',
            endedAt: { gte: new Date(now - RECENT_WORK_MS) }
          }
        }
      }
    ]
  }
}

/** آیا این بازیکن بر اساس تعریف بالا شاغل است؟ */
export async function isPlayerEmployed(db: PrismaClient, playerId: string): Promise<boolean> {
  const count = await db.player.count({
    where: { id: playerId, ...employedPlayerFilter() }
  })
  return count === 1
}

/** تعداد شاغلان میان مجموعه‌ای از بازیکنان (یک Query، بدون N+1). */
export async function countEmployedPlayers(
  db: PrismaClient,
  playerIds: string[]
): Promise<number> {
  if (playerIds.length === 0) {
    return 0
  }
  return db.player.count({
    where: { id: { in: playerIds }, ...employedPlayerFilter() }
  })
}

export interface CurrentJobView {
  title: string
  isActive: boolean
}

/**
 * عنوان شغل قابل نمایش از آخرین نوبت کاری.
 * `isActive` مشخص می‌کند بازیکن همین حالا مشغول است یا این آخرین سابقهٔ اوست.
 */
export function currentJobOf(
  sessions: Array<{ jobTitle: string; status: string }>
): CurrentJobView | null {
  const latest = sessions[0]
  if (!latest) {
    return null
  }
  return { title: latest.jobTitle, isActive: latest.status === 'ACTIVE' }
}
