-- ═══════════════════════════════════════════════════════════
-- Integrity: هر ملک همزمان فقط یک قرارداد اجارهٔ فعال؛ هر مستأجر هم
-- همزمان فقط یک قرارداد فعال.
--
-- تا حالا «قرارداد فعال نبودن» فقط با read-then-create چک می‌شد؛ دو
-- درخواست همزمان (دو مستأجر روی یک ملک، یا دابل‌کلیک) هر دو چک را رد
-- می‌کردند و دو قرارداد فعال + دو پرداخت اجاره ساخته می‌شد.
-- الگوی همان قیدی که «یک وام فعال» را تضمین می‌کند
-- (20260908000001_one_active_loan_per_player).
--
-- نکته: انقضای قرارداد Lazy است؛ ردیف‌های منقضی که هنوز is_active=true
-- دارند اول بسته می‌شوند وگرنه قید، ملکِ با قرارداد منقضی را برای همیشه
-- قفل می‌کرد.
-- ═══════════════════════════════════════════════════════════

-- ۱) قراردادهای منقضیِ هنوز-فعال بسته می‌شوند (همان کاری که سرویس
--    از این پس داخل تراکنش اجاره هم می‌کند).
UPDATE "rental_contracts" SET "is_active" = false WHERE "expires_at" <= now();

-- ۲) اگر از race قدیمی دو قرارداد فعالِ همپوشان مانده، قدیمی‌ترین
--    (اولویت با قرارداد اول) نگه داشته می‌شود — الگوی پاکسازی referrals.
UPDATE "rental_contracts" a
SET "is_active" = false
FROM "rental_contracts" b
WHERE a."property_id" = b."property_id"
  AND a."is_active" = true AND b."is_active" = true
  AND (a."started_at" < b."started_at"
       OR (a."started_at" = b."started_at" AND a."id" < b."id"));

-- ۳) اگر مستأجری از race قدیمی دو قرارداد فعال دارد، قدیمی‌ترین می‌ماند.
UPDATE "rental_contracts" a
SET "is_active" = false
FROM "rental_contracts" b
WHERE a."tenant_id" = b."tenant_id"
  AND a."is_active" = true AND b."is_active" = true
  AND (a."started_at" < b."started_at"
       OR (a."started_at" = b."started_at" AND a."id" < b."id"));

CREATE UNIQUE INDEX IF NOT EXISTS "one_active_rental_per_property"
  ON "rental_contracts"("property_id") WHERE "is_active" = true;

CREATE UNIQUE INDEX IF NOT EXISTS "one_active_rental_per_tenant"
  ON "rental_contracts"("tenant_id") WHERE "is_active" = true;
