import { Prisma, WorkSessionStatus, WorkSessionType } from '@prisma/client'
import { creditedWorkMinutes } from './payroll-math'

/**
 * کارکردِ ثبت‌شده در یک کسب‌وکار.
 *
 * شیفت‌های `FULL_TIME` که به یک کسب‌وکار وصل‌اند، تنها سندِ «کار کردن» در بازی
 * هستند و سه مصرف‌کننده دارند؛ همه باید یک عدد ببینند، پس کوئری و جمع‌زدن
 * هر دو همین‌جا می‌مانند:
 *  • تسویهٔ حقوق (پایهٔ حقوق کارمند و پایهٔ درآمد کسب‌وکار)
 *  • تسویهٔ نهایی هنگام استعفا/اخراج
 *  • پنل «شغل من» که کارکرد جاری را نشان می‌دهد
 */
export interface WorkShift {
  playerId: string
  startedAt: Date
  endedAt: Date | null
}

/**
 * شیفت‌های تمام‌شدهٔ یک کسب‌وکار در بازهٔ `[since, until]`.
 *
 * `until` لازم است: یک شیفتِ هنوز-باز نباید کارکرد بسازد، و شیفتی که بعد از
 * پایان این بازه تمام شده به تسویهٔ بعدی تعلق دارد (وگرنه دو بار شمرده می‌شود).
 */
export async function completedShifts(
  db: Prisma.TransactionClient,
  businessId: string,
  since: Date,
  until?: Date
): Promise<WorkShift[]> {
  const endedAt: Prisma.DateTimeFilter = { gt: since }
  if (until) {
    endedAt.lte = until
  }
  return db.workSession.findMany({
    where: {
      businessId,
      sessionType: WorkSessionType.FULL_TIME,
      status: WorkSessionStatus.COMPLETED,
      endedAt
    },
    select: { playerId: true, startedAt: true, endedAt: true }
  })
}

/** جمع کارکردِ یک بازیکن از این شیفت‌ها (شیفت‌های پیش از لنگرِ او شمرده نمی‌شوند). */
export function creditedMinutesOf(
  shifts: ReadonlyArray<WorkShift>,
  playerId: string,
  since: Date
): number {
  let total = 0
  for (const shift of shifts) {
    if (shift.playerId !== playerId || !shift.endedAt || shift.endedAt <= since) {
      continue
    }
    total += creditedWorkMinutes(shift.startedAt, shift.endedAt)
  }
  return total
}

/**
 * کارکردِ تحویل‌شدهٔ کسب‌وکار، وزن‌داده‌شده با بهره‌وریِ هر کس — پایهٔ درآمد.
 *
 * بهره‌وری از بیرون داده می‌شود چون مالک کارمند نیست و بهره‌وری‌اش ۱ است؛
 * نبودِ کسی در نقشه هم عدد خنثی می‌دهد تا دادهٔ ناقص درآمد را صفر نکند.
 */
export function deliveredMinutes(
  shifts: ReadonlyArray<WorkShift>,
  productivityOf: (playerId: string) => number
): number {
  let total = 0
  for (const shift of shifts) {
    if (!shift.endedAt) {
      continue
    }
    total += creditedWorkMinutes(shift.startedAt, shift.endedAt) * productivityOf(shift.playerId)
  }
  return Math.round(total)
}
