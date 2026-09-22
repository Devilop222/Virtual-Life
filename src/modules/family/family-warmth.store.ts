import { Prisma, RelationshipStatus, RelationshipType } from '@prisma/client'
import { decayedWarmth, WARMTH_INITIAL } from './family-warmth'

/**
 * خواندن/نوشتن گرمای رابطهٔ زوجین روی دیتابیس.
 *
 * گرما در همان ستونِ موجود `relationships.strength` روی رابطهٔ SPOUSE ذخیره
 * می‌شود (دو ردیف دوطرفه) و لنگرِ فرسایشش `marriages.last_warmth_at` است.
 * این توابع تابعِ «کدام ذخیره‌سازی» هستند؛ منطق محاسبه در `family-warmth`.
 *
 * هر دو سرویس ازدواج (پاداش روزانه) و زندگی خانواده (وقت مشترک/هدیه) از
 * همین توابع استفاده می‌کنند تا خواندنِ «گرمای واقعیِ همین لحظه» و نوشتنِ
 * اتمیکِ آن در کل بازی یک تعریف داشته باشد.
 */

/** چک‌لیست تایپی حداقلی — هم PrismaClient و هم TransactionClient را می‌پذیرد. */
type WarmthClient = Pick<Prisma.TransactionClient, 'relationship' | 'marriage'>

export interface WarmthAnchor {
  marriageId: string
  playerAId: string
  playerBId: string
  /** آخرین لحظه‌ای که گرما لمس شد؛ نبودش = روز عقد. */
  anchorMs: number
}

/**
 * گرمای واقعیِ همین لحظه: مقدار ذخیره‌شده منهای فرسایشِ روزهای بی‌خبری.
 * نبود ردیف رابطه (دادهٔ قدیمی/نقص) «گرمای کامل» فرض می‌شود تا خطای داده
 * پاداش بازیکن را بی‌صدا نصف نکند.
 */
export async function readWarmth(db: WarmthClient, anchor: WarmthAnchor): Promise<number> {
  const relation = await db.relationship.findFirst({
    where: {
      playerId: anchor.playerAId,
      relatedPlayerId: anchor.playerBId,
      type: RelationshipType.SPOUSE
    },
    select: { strength: true }
  })
  const stored = relation ? relation.strength : WARMTH_INITIAL
  return decayedWarmth(stored, anchor.anchorMs)
}

/**
 * نوشتن گرما برای هر دو طرف + جابه‌جایی لنگر فرسایش به «اکنون».
 *
 * نوشتار دوطرفه با `updateMany` است: اگر یکی از ردیف‌ها (دادهٔ قدیمی) وجود
 * نداشته باشد، بقیهٔ نوشتار بی‌اثر نمی‌ماند و بازیکن دیگری گیر نمی‌کند.
 */
export async function writeWarmth(
  db: WarmthClient,
  anchor: WarmthAnchor,
  strength: number,
  now: Date = new Date()
): Promise<void> {
  await db.relationship.updateMany({
    where: {
      OR: [
        { playerId: anchor.playerAId, relatedPlayerId: anchor.playerBId },
        { playerId: anchor.playerBId, relatedPlayerId: anchor.playerAId }
      ],
      type: RelationshipType.SPOUSE,
      status: RelationshipStatus.ACTIVE
    },
    data: { strength }
  })
  await db.marriage.update({
    where: { id: anchor.marriageId },
    data: { lastWarmthAt: now }
  })
}

/** ساخت لنگر از روی یک ردیف ازدواج (با فیلدهای لازم). */
export function warmthAnchorOf(marriage: {
  id: string
  playerAId: string
  playerBId: string
  marriedAt: Date
  lastWarmthAt: Date | null
}): WarmthAnchor {
  return {
    marriageId: marriage.id,
    playerAId: marriage.playerAId,
    playerBId: marriage.playerBId,
    anchorMs: (marriage.lastWarmthAt ?? marriage.marriedAt).getTime()
  }
}
