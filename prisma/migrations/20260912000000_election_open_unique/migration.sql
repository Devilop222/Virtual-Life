-- ═══════════════════════════════════════════════════════════
-- Integrity: تضمین حداکثر یک انتخاباتِ باز (OPEN) برای هر گروه
-- بدون این شاخص، دو دورهٔ باز همزمان می‌توانست برای یک منطقه ساخته شود
-- و رأی‌ها تقسیم/مختل شوند. پیامد: انتخابات بی‌اعتبار.
-- ═══════════════════════════════════════════════════════════

-- پاکسازی دادهٔ ناسالم احتمالی: اگر برای یک گروه دو OPEN وجود دارد،
-- قدیمی‌ترین نگه داشته و بقیه فوراً CLOSED می‌شوند تا شاخص بتواند ساخته شود.
UPDATE "elections" a
SET "status" = 'CLOSED'
WHERE a."status" = 'OPEN'
  AND EXISTS (
    SELECT 1 FROM "elections" b
    WHERE b."group_id" = a."group_id"
      AND b."status" = 'OPEN'
      AND (b."started_at" < a."started_at"
           OR (b."started_at" = a."started_at" AND b."id" < a."id"))
  );

CREATE UNIQUE INDEX IF NOT EXISTS "elections_group_id_open_key"
  ON "elections"("group_id")
  WHERE "status" = 'OPEN';
