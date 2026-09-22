-- ═══════════════════════════════════════════════════════════
-- یک حساب بانکی برای هر بازیکن (یکتایی در سطح دیتابیس)
--
-- چرا؟ `player_id` در `bank_accounts` فقط ایندکس ساده داشت؛ یکتایی حساب
-- تنها به «اول بخوان، اگر نبود بساز» در کد تکیه می‌کرد. دو درخواست همزمان
-- (کلیک دوبله روی «حساب بانکی» در اولین استفاده) هر دو می‌خواندند «حسابی
-- نیست» و هر دو یک حساب می‌ساختند. از آن لحظه به بعد:
--   • هر خوانده (`findFirst` بدون ترتیب) یکی از دو حساب را برمی‌گرداند،
--   • واریز/برداشت و سود سپرده می‌توانند روی حساب‌های مختلف بنشینند،
--   • یعنی موجودیِ پس‌انداز بازیکن بی‌صدا دو تکه می‌شود و عددی که روی
--     پنل می‌بیند با پولِ واقعی‌اش یکی نیست.
--
-- این مهاجرت دو کار می‌کند:
--   ۱. رکوردهای تکراریِ موجود را یکی می‌کند — قدیمی‌ترین حساب نگه داشته
--      می‌شود و موجودی بقیه در آن جمع می‌شود (پولِ هیچ بازیکنی گم نمی‌شود
--      و پولی هم از هیچ ساخته نمی‌شود: فقط جمع و حذف).
--   ۲. یکتایی واقعی می‌سازد تا از این پس دیتابیس خودش جلوی حساب دوم را
--      بگیرد؛ لایهٔ مخزن هم در صورت برخورد، همان حساب موجود را برمی‌گرداند.
--
-- هیچ جدول دیگری به `bank_accounts` کلید خارجی ندارد (وام‌ها به بازیکن
-- وصل‌اند نه به حساب)، پس حذف رکوردهای تکراری هیچ دادهٔ وابسته‌ای را
-- بی‌صاحب نمی‌کند.
-- ═══════════════════════════════════════════════════════════

-- ۱) جمع‌کردن موجودی حساب‌های تکراری در قدیمی‌ترین حسابِ همان بازیکن
WITH "ranked" AS (
    SELECT "id", "player_id", "balance",
           row_number() OVER (
               PARTITION BY "player_id"
               ORDER BY "created_at" ASC, "id" ASC
           ) AS "rn"
    FROM "bank_accounts"
),
"keepers" AS (
    SELECT "player_id", "id" AS "keep_id" FROM "ranked" WHERE "rn" = 1
),
"duplicates" AS (
    SELECT "r"."id", "r"."player_id", "r"."balance"
    FROM "ranked" "r"
    JOIN "keepers" "k" ON "k"."player_id" = "r"."player_id"
    WHERE "r"."rn" > 1
),
"folded" AS (
    SELECT "player_id", sum("balance") AS "total"
    FROM "duplicates"
    GROUP BY "player_id"
)
UPDATE "bank_accounts" "b"
SET "balance" = "b"."balance" + "f"."total",
    "updated_at" = CURRENT_TIMESTAMP
FROM "folded" "f"
JOIN "keepers" "k" ON "k"."player_id" = "f"."player_id"
WHERE "b"."id" = "k"."keep_id";

-- ۲) حذف حساب‌های تکراری (همان ترتیب: قدیمی‌ترین حساب نگه داشته می‌شود)
DELETE FROM "bank_accounts"
WHERE "id" IN (
    SELECT "id" FROM (
        SELECT "id",
               row_number() OVER (
                   PARTITION BY "player_id"
                   ORDER BY "created_at" ASC, "id" ASC
               ) AS "rn"
        FROM "bank_accounts"
    ) "ranked"
    WHERE "rn" > 1
);

-- ۳) ایندکس ساده جای خودش را به یکتایی واقعی می‌دهد
DROP INDEX IF EXISTS "bank_accounts_player_id_idx";

CREATE UNIQUE INDEX IF NOT EXISTS "bank_accounts_player_id_key" ON "bank_accounts"("player_id");
