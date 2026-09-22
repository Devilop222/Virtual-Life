import type { Prisma } from '@prisma/client'

/**
 * سقف سلامت بازیکن — منبع واحد این قانون برای همهٔ سیستم‌ها.
 *
 * عضویت فعال باشگاه سقف را از ۱۰۰ به ۱۲۰ می‌برد. تا قبل از وجود این ماژول،
 * هر سیستم clamp خودش را با ۱۰۰ هاردکد می‌کرد و عضو باشگاه با کالای درمانی
 * یا استراحت، سلامتش را «کم» می‌کرد (۱۱۵ → ۱۰۰).
 *
 * با `tx` یا `db` صدا زده می‌شود تا داخل تراکنش‌ها هم بدون کوئری اضافه قابل
 * استفاده باشد.
 */

export const BASE_MAX_HEALTH = 100
export const GYM_MAX_HEALTH = 120

/** چک‌لیست تایپی حداقلی — هم PrismaClient و هم TransactionClient را می‌پذیرد. */
type HealthCapClient = Pick<Prisma.TransactionClient, 'gymMembership'>

/** سقف سلامت واقعی بازیکن در همین لحظه. */
export async function resolveMaxHealth(
  db: HealthCapClient,
  playerId: string
): Promise<number> {
  const membership = await db.gymMembership.findFirst({
    where: { playerId, expiresAt: { gt: new Date() } },
    select: { id: true }
  })
  return membership ? GYM_MAX_HEALTH : BASE_MAX_HEALTH
}
