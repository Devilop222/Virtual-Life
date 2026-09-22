-- پایانِ ازدواج با فوتِ همسر — بستنِ چرخهٔ گمشدهٔ خانواده.
--
-- پیش‌تر تنها راهِ پایانِ ازدواج، طلاق بود. با فوتِ یک زوج، ردیفِ ازدواج
-- تا ابد `is_active = true` می‌ماند، `marital_status` بازمانده روی MARRIED
-- قفل می‌شد و او هرگز نمی‌توانست دوباره ازدواج کند. این مهاجرت افزودنی
-- جایِ «علتِ پایان» و «زمانِ پایان» را می‌سازد؛ هیچ ستون یا ردیفی حذف نمی‌شود
-- و ازدواج‌های فعالِ موجود دست‌نخورده می‌مانند (هر دو ستون NULL).

-- AlterEnum: نوعِ رخدادِ سرگذشت برای فوتِ همسر
ALTER TYPE "GameEventType" ADD VALUE IF NOT EXISTS 'WIDOWHOOD_REGISTERED';

-- CreateEnum
CREATE TYPE "MarriageEndReason" AS ENUM ('DIVORCED', 'WIDOWED');

-- AlterTable
ALTER TABLE "marriages" ADD COLUMN "ended_at" TIMESTAMP(3);
ALTER TABLE "marriages" ADD COLUMN "end_reason" "MarriageEndReason";
