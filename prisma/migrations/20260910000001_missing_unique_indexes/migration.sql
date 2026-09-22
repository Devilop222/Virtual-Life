-- ═══════════════════════════════════════════════════════════
-- Integrity: دو یونیک‌ایندکس که schema.prisma اعلام می‌کرد ولی هیچ
-- مهاجرتی نساخته بود (Schema Drift). بدون آن‌ها:
--   • یک بازیکن می‌توانست دو بار با یک کد معرف ثبت شود (پاداش دوباره)
--   • یک پروژهٔ منطقه می‌توانست دو ردیف با یک کلید داشته باشد (هدف دو برابر)
-- ═══════════════════════════════════════════════════════════

-- ۱) هر بازیکن فقط یک بار «معروفی‌شده» است.
-- اگر دادهٔ تکراری از پیش وجود دارد، قدیمی‌ترین ردیف نگه داشته می‌شود تا
-- مهاجرت روی دیتابیسِ در حال کار هم امن اجرا شود.
DELETE FROM "referrals" a
USING "referrals" b
WHERE a."referee_player_id" = b."referee_player_id"
  AND (a."created_at" > b."created_at"
       OR (a."created_at" = b."created_at" AND a."id" > b."id"));

CREATE UNIQUE INDEX IF NOT EXISTS "referrals_referee_player_id_key"
  ON "referrals"("referee_player_id");

-- ۲) هر پروژهٔ منطقه در هر گروه یک ردیف دارد.
DELETE FROM "region_projects" a
USING "region_projects" b
WHERE a."group_id" = b."group_id"
  AND a."key" = b."key"
  AND (a."created_at" > b."created_at"
       OR (a."created_at" = b."created_at" AND a."id" > b."id"));

CREATE UNIQUE INDEX IF NOT EXISTS "region_projects_group_id_key_key"
  ON "region_projects"("group_id", "key");

-- ۳) حذف بازیکن باید رکورد حیوان خانگی‌اش را هم ببرد (مطابق schema).
ALTER TABLE "pets" DROP CONSTRAINT IF EXISTS "pets_player_id_fkey";
ALTER TABLE "pets"
  ADD CONSTRAINT "pets_player_id_fkey"
  FOREIGN KEY ("player_id") REFERENCES "players"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
