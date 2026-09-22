import type { PrismaClient } from '@prisma/client'

/**
 * مرجعِ واحدِ «چه کسی الان شهردار است».
 *
 * چرا یک ماژولِ جدا؟ پیش‌تر دو قاعدهٔ متفاوت برای یک پرسش وجود داشت:
 *   • `PolicyService.currentMayor` برندهٔ آخرین انتخابات بسته‌شده را برمی‌گرداند
 *     بی‌آنکه به پایانِ دوره کاری داشته باشد — پس شهردارِ سه دوره قبل هم
 *     می‌توانست برای همیشه سیاست عوض کند.
 *   • `ElectionsService.isCurrentMayor` همان قاعده را با سقفِ زمانی داشت و
 *     هیچ‌جا صدا زده نمی‌شد.
 * نتیجه: دو منبع حقیقت و یک اختیارِ بی‌پایانِ خاموش.
 *
 * حالا یک قاعده، یک تابع: برندهٔ آخرین انتخاباتِ بسته‌شده شهردارِ «فعال» است،
 * و اگر دوره‌اش هم تمام شده باشد (هنوز انتخابات تازه‌ای بسته نشده) با برچسبِ
 * *اختیار موقت* شناخته می‌شود — نه اینکه بی‌صدا اختیارش تمدید شود و نه اینکه
 * منطقه بی‌مدیر بماند تا انتخابات بعدی.
 */
import { gameMonths } from '../../utils/game-time'

/** دورهٔ شهرداری: یک ماه بازی (۳۰ روز بازی ≈ ۲۴ ساعت واقعی). */
export const MAYOR_TERM_MS = gameMonths(1)

export interface CityAuthority {
  /** بازیکنِ شهردارِ فعال. */
  playerId: string
  /** پایانِ دورهٔ او (پس از این لحظه، اختیار موقت است). */
  termEndsAt: Date
  /** دوره تمام شده و انتخابات تازه‌ای هنوز بسته نشده. */
  isCaretaker: boolean
  /** میلی‌ثانیهٔ باقی‌مانده تا پایان دوره (۰ اگر تمام شده باشد). */
  msRemaining: number
}

/**
 * شهردارِ فعالِ یک منطقه؛ `null` یعنی هنوز هیچ دورهٔ انتخاباتی‌ای بسته نشده
 * و منطقه شهردار ندارد.
 */
export async function resolveCityAuthority(
  db: PrismaClient,
  groupId: string
): Promise<CityAuthority | null> {
  const lastClosed = await db.election.findFirst({
    where: { groupId, status: 'CLOSED', winnerId: { not: null } },
    orderBy: { endsAt: 'desc' },
    select: { winnerId: true, endsAt: true }
  })

  if (!lastClosed?.winnerId) {
    return null
  }

  const termEndsAt = new Date(lastClosed.endsAt.getTime() + MAYOR_TERM_MS)
  const msRemaining = Math.max(0, termEndsAt.getTime() - Date.now())

  return {
    playerId: lastClosed.winnerId,
    termEndsAt,
    isCaretaker: msRemaining === 0,
    msRemaining
  }
}
