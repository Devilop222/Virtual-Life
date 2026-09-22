-- ═══════════════════════════════════════════════════════════
-- Update: سیم‌کشی کامل استخدام — شمارندهٔ کارمندان فعال،
-- سن مجاز در آگهی و رهگیری ظرفیت استخدام‌شده
-- ═══════════════════════════════════════════════════════════

-- AlterTable: شمارندهٔ قطعی کارمندان فعال (گارد ظرفیت اتمیک)
ALTER TABLE "businesses" ADD COLUMN "active_employees" INTEGER NOT NULL DEFAULT 0;

-- Backfill از وضعیت موجود
UPDATE "businesses" b
SET "active_employees" = sub.cnt
FROM (
  SELECT "business_id" AS bid, COUNT(*)::int AS cnt
  FROM "business_employees"
  WHERE "is_active" = true
  GROUP BY "business_id"
) sub
WHERE sub.bid = b."id";

-- AlterTable: محدودیت سنی و شمارندهٔ استخدام‌شدگان هر آگهی
ALTER TABLE "job_postings" ADD COLUMN "min_age" INTEGER;
ALTER TABLE "job_postings" ADD COLUMN "max_age" INTEGER;
ALTER TABLE "job_postings" ADD COLUMN "hired_count" INTEGER NOT NULL DEFAULT 0;

-- AlterTable: لنگر تسویهٔ حقوق هر کارمند (ضد پرداخت دوباره)
ALTER TABLE "business_employees" ADD COLUMN "paid_until_at" TIMESTAMP(3);
UPDATE "business_employees" e
SET "paid_until_at" = b."last_payroll_at"
FROM "businesses" b
WHERE b."id" = e."business_id" AND e."paid_until_at" IS NULL;

-- فهرست آگهی‌های باز برای بازیکنان
CREATE INDEX IF NOT EXISTS "job_postings_status_created_at_idx" ON "job_postings"("status", "created_at");
