import {
  GameEventType,
  MaritalStatus,
  NotificationType,
  PlayerStatus,
  PrismaClient,
  RelationshipStatus,
  RelationshipType,
  MarriageEndReason
} from '@prisma/client'
import type { NotificationLevel } from '../notification/push'

/**
 * پایانِ ازدواج با فوتِ همسر — چرخهٔ گمشدهٔ خانواده.
 *
 * پیش از این، تنها راهِ بسته‌شدن یک ازدواج «طلاق» بود. اگر همسرِ یک بازیکن
 * فوت می‌کرد (وضعیتِ `DEAD` که مدیریت بازی ثبت می‌کند)، ازدواج تا ابد
 * `isActive` می‌ماند و بازیکن:
 *
 *   • در پنل «خانواده» همسرِ فوت‌شده را زنده می‌دید،
 *   • همیشه پیامِ «منتظرِ فعالیتِ همسر» می‌گرفت (پاداشِ زوجین قفلِ ابدی)،
 *   • و چون `maritalStatus` روی `MARRIED` می‌ماند، هرگز نمی‌توانست دوباره
 *     ازدواج کند — یک بن‌بستِ کاملِ چرخهٔ زندگی. مقدارِ `WIDOWED` در اسکیما
 *     وجود داشت ولی هیچ‌جای بازی نوشته نمی‌شد و فقط یک برچسب بود.
 *
 * این ماژول همان‌جا که ازدواج خوانده می‌شود (Lazy، بدون تایمر و سازگار با
 * Restart) وضعیت را آشتی می‌دهد: ازدواج با علتِ `WIDOWED` بسته می‌شود،
 * وضعیتِ بازمانده به `WIDOWED` می‌رود (پس می‌تواند دوباره ازدواج کند)،
 * پیوندِ همسری به `ENDED` می‌رسد و یک اعلان/رخدادِ یک‌باره — با کلیدِ
 * ضدتکرارِ خودِ ازدواج — برای بازمانده ثبت می‌شود.
 *
 * منطقِ حساب‌وکتاب عوض نمی‌شود: این مسیر هیچ پولی جابه‌جا نمی‌کند و مهریه‌ای
 * (که هنگام عقد پرداخت شده) پس گرفته نمی‌شود.
 */

export interface WidowhoodClosure {
  marriageId: string
  /** بازمانده — کسی که وضعیتش به WIDOWED می‌رود. */
  survivorId: string
  deceasedId: string
  deceasedName: string
}

/** متنِ اعلان و رخداد یک‌بارهٔ فوتِ همسر؛ یک منبعِ حقیقت برای هر دو کانال. */
export function widowhoodNotice(closure: WidowhoodClosure): {
  title: string
  message: string
  historyTitle: string
  detail: string
  dedupeKey: string
} {
  return {
    title: '🕯️ تسلیت — همسرت فوت شد',
    message:
      `همسرت *${closure.deceasedName}* از دنیا رفت و این زندگیِ مشترک بسته شد.\n` +
      'مهریه‌ای که هنگام عقد پرداخت شده بود پس گرفته نمی‌شود.\n' +
      'می‌توانی دوباره زندگی مشترک بسازی: پنل «خانواده» را باز کن و خواستگاری کن.',
    historyTitle: '🕯️ فوت همسر',
    detail: `همسرت ${closure.deceasedName} از دنیا رفت؛ این ازدواج بسته شد.`,
    dedupeKey: `widowhood:${closure.marriageId}:${closure.survivorId}`
  }
}

/**
 * یافتن و بستنِ ازدواج‌های فعالی که همسرشان فوت کرده است.
 *
 * هر بستن در یک تراکنشِ شرطی انجام می‌شود (`isActive: true` شرطِ نوشتار است)،
 * پس دو مسیرِ همزمان نمی‌توانند یک ازدواج را دوبار ببندند و بازمانده دوبار
 * وضعیت نگیرد. بازگشتی‌ها همان ازدواج‌هایی هستند که **همین حالا** بسته شدند؛
 * پس صداکننده می‌داند چه‌وقت باید اعلان بفرستد (و دیگر هرگز تکرار نمی‌کند).
 */
export async function closeWidowedMarriages(
  db: PrismaClient,
  playerId: string
): Promise<WidowhoodClosure[]> {
  const marriages = await db.marriage.findMany({
    where: { isActive: true, OR: [{ playerAId: playerId }, { playerBId: playerId }] },
    include: {
      playerA: { select: { id: true, firstName: true, lastName: true, status: true } },
      playerB: { select: { id: true, firstName: true, lastName: true, status: true } }
    }
  })

  const closures: WidowhoodClosure[] = []
  for (const marriage of marriages) {
    const other = marriage.playerAId === playerId ? marriage.playerB : marriage.playerA
    if (other.status !== PlayerStatus.DEAD) {
      continue
    }
    const closed = await closeMarriageByDeath(db, marriage.id, playerId, other.id)
    if (!closed) {
      continue
    }
    closures.push({
      marriageId: marriage.id,
      survivorId: playerId,
      deceasedId: other.id,
      deceasedName: `${other.firstName} ${other.lastName ?? ''}`.trim()
    })
  }
  return closures
}

/** تنها نقطهٔ نوشتارِ «ازدواج با فوتِ همسر بسته شد». */
async function closeMarriageByDeath(
  db: PrismaClient,
  marriageId: string,
  survivorId: string,
  deceasedId: string
): Promise<boolean> {
  return db.$transaction(async (tx) => {
    const locked = await tx.marriage.updateMany({
      where: { id: marriageId, isActive: true },
      data: { isActive: false, endedAt: new Date(), endReason: MarriageEndReason.WIDOWED }
    })
    if (locked.count !== 1) {
      return false
    }

    // وضعیتِ بازمانده آزاد می‌شود؛ شرطِ MARRIED جلوی بازنویسیِ وضعیتِ
    // عوض‌شده (مثلاً ازدواجِ تازه‌ای که در همین فاصله ثبت شده) را می‌گیرد.
    await tx.player.updateMany({
      where: { id: survivorId, maritalStatus: MaritalStatus.MARRIED },
      data: { maritalStatus: MaritalStatus.WIDOWED }
    })

    // پیوندِ همسری دیگر «فعال» نیست؛ «پایان‌یافته» است نه «مسدود» —
    // مسدود (BLOCKED) معنای دشمنیِ طلاق را دارد و اینجا مرگ است، نه قهر.
    for (const [from, to] of [
      [survivorId, deceasedId],
      [deceasedId, survivorId]
    ] as const) {
      await tx.relationship.upsert({
        where: {
          playerId_relatedPlayerId_type: {
            playerId: from,
            relatedPlayerId: to,
            type: RelationshipType.SPOUSE
          }
        },
        create: {
          playerId: from,
          relatedPlayerId: to,
          type: RelationshipType.SPOUSE,
          status: RelationshipStatus.ENDED,
          strength: 10
        },
        update: { status: RelationshipStatus.ENDED, strength: 10 }
      })
    }
    return true
  })
}

type NotifyFn = (
  playerId: string,
  title: string,
  message: string,
  type?: NotificationType,
  dedupeKey?: string,
  level?: NotificationLevel
) => Promise<boolean>

type RecordEventFn = (input: {
  playerId: string
  type: GameEventType
  title: string
  detail?: string
  dedupeKey?: string
}) => Promise<unknown>

/**
 * اعلامِ فوتِ همسر به بازمانده.
 *
 * اعلان و رخدادِ سرگذشت بیرونِ تراکنش می‌روند تا شکستِ تلگرام هیچ‌وقت وضعیتِ
 * ثبت‌شده را برنگرداند؛ کلیدِ ضدتکرارِ یکتا هم دوبار فرستادن را غیرممکن می‌کند.
 */
export async function announceWidowhood(
  closures: WidowhoodClosure[],
  deps: { notify?: NotifyFn; recordEvent?: RecordEventFn }
): Promise<void> {
  for (const closure of closures) {
    const notice = widowhoodNotice(closure)
    if (deps.notify) {
      await deps
        .notify(
          closure.survivorId,
          notice.title,
          notice.message,
          NotificationType.WARNING,
          notice.dedupeKey,
          'CRITICAL'
        )
        .catch(() => undefined)
    }
    if (deps.recordEvent) {
      await deps
        .recordEvent({
          playerId: closure.survivorId,
          type: GameEventType.WIDOWHOOD_REGISTERED,
          title: notice.historyTitle,
          detail: notice.detail,
          dedupeKey: notice.dedupeKey
        })
        .catch(() => undefined)
    }
  }
}

/**
 * ترکیبِ آشتی‌دادن و اعلام — تنها چیزی که صداکننده‌ها لازم دارند.
 * اگر هیچ ازدواجی با فوت بسته نشود، خروجی خالی است و هیچ کوئریِ اضافه‌ای
 * (اعلان/رخداد) اجرا نمی‌شود.
 */
export async function settleWidowhood(
  db: PrismaClient,
  playerId: string,
  deps: { notify?: NotifyFn; recordEvent?: RecordEventFn }
): Promise<WidowhoodClosure[]> {
  const closures = await closeWidowedMarriages(db, playerId)
  if (closures.length > 0) {
    await announceWidowhood(closures, deps)
  }
  return closures
}

/** همهٔ بازیکنانِ یک مجموعه را (یک‌بار) آشتی می‌دهد — برای مسیرهای دوطرفه. */
export async function settleWidowhoodForAll(
  db: PrismaClient,
  playerIds: string[],
  deps: { notify?: NotifyFn; recordEvent?: RecordEventFn }
): Promise<WidowhoodClosure[]> {
  const out: WidowhoodClosure[] = []
  for (const playerId of new Set(playerIds)) {
    out.push(...(await settleWidowhood(db, playerId, deps)))
  }
  return out
}
