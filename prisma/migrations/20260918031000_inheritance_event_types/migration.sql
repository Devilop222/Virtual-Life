-- رویدادهای وصیت، مرگ و میراث.
--
-- چرا نوعِ رویداد جدا و نه استفاده از یک نوعِ موجود؟ سرگذشتِ بازیکن
-- (`historyEventLabels`) و ممیزیِ رخدادها روی همین نوع سوارند. اگر مرگ و
-- انتقالِ میراث با نوعِ «دستاورد جدید» یا «پاداش» ثبت شوند، تاریخچهٔ بازیکن
-- و وارث دروغ می‌گوید و دیگر نمی‌شود از روی داده فهمید پول از کجا آمده.
-- این چهار مقدار دقیقاً همان چهار رویدادِ تازهٔ سیستمِ وصیت/میراث هستند.
--
-- هیچ مقداری حذف یا بازنویسی نمی‌شود؛ فقط مقدار تازه اضافه می‌گردد.

-- AlterEnum
ALTER TYPE "GameEventType" ADD VALUE IF NOT EXISTS 'WILL_UPDATED';
ALTER TYPE "GameEventType" ADD VALUE IF NOT EXISTS 'WILL_CANCELLED';
ALTER TYPE "GameEventType" ADD VALUE IF NOT EXISTS 'PLAYER_DIED';
ALTER TYPE "GameEventType" ADD VALUE IF NOT EXISTS 'INHERITANCE_SETTLED';
