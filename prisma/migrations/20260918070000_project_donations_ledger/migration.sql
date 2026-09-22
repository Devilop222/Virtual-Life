-- پروژه‌های شهری ۲.۰: رکوردِ مستقلِ هر مشارکت و وضعیتِ قابل‌ممیزی پروژه.
--
-- سه چیز اضافه می‌شود:
--  ۱. `started_at` — لحظهٔ «آغاز رسمی» توسط شهردار، جدا از createdAt.
--  ۲. `announced_at` — اعلامِ خبرِ تکمیل؛ بدون آن، پروژه‌ای که ربات بین تکمیل
--     و ثبت خبر پایین بیاید برای همیشه تکمیل‌شدهٔ بی‌خبر می‌ماند.
--  ۳. جدول `project_donations` — هر کمک یک ردیف، تا جمعِ کمک‌ها با
--     CollectedAmount قابل‌آشتی‌دادن باشد.

ALTER TABLE "region_projects" ADD COLUMN "started_at" TIMESTAMP(3);
ALTER TABLE "region_projects" ADD COLUMN "announced_at" TIMESTAMP(3);

-- پروژه‌های موجود که شهردار آغازشان کرده، لحظهٔ آغازشان مشخص نیست؛
-- نزدیک‌ترین شاهد موجود، لحظهٔ ساخت ردیف است.
UPDATE "region_projects" SET "started_at" = "created_at" WHERE "started_by_player_id" IS NOT NULL;

-- پروژه‌های تکمیل‌شدهٔ گذشته خبرشان قبلاً اعلام شده؛ دوباره اعلام نمی‌شوند.
UPDATE "region_projects" SET "announced_at" = "completed_at" WHERE "is_completed" = true;

CREATE INDEX "region_projects_is_completed_announced_at_idx" ON "region_projects"("is_completed", "announced_at");

CREATE TABLE "project_donations" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "donor_id" TEXT,
    "donor_name" TEXT NOT NULL,
    "amount" DECIMAL(65,30) NOT NULL,
    "game_day" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_donations_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "project_donations_donor_id_created_at_idx" ON "project_donations"("donor_id", "created_at");
CREATE INDEX "project_donations_project_id_created_at_idx" ON "project_donations"("project_id", "created_at");

ALTER TABLE "project_donations" ADD CONSTRAINT "project_donations_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "region_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- سندِ مالی است: با حذفِ حسابِ اهداکننده پاک نمی‌شود، فقط اشاره‌اش تهی می‌شود.
ALTER TABLE "project_donations" ADD CONSTRAINT "project_donations_donor_id_fkey" FOREIGN KEY ("donor_id") REFERENCES "players"("id") ON DELETE SET NULL ON UPDATE CASCADE;
