-- ═══════════════════════════════════════════════════════════
-- هر منطقه «یک» انتخابات OPEN — نه بیشتر
--
-- چرا؟ `getOrCreateOpenElection` با «اول بخوان، اگر نبود بساز» کار می‌کرد
-- (بدون هیچ یکتایی در دیتابیس). دو نامزدیِ همزمانِ لحظهٔ شروع دورهٔ جدید
-- هر دو می‌خواندند «انتخاباتی نیست» و هر دو یک انتخابات OPEN می‌ساختند.
-- از آن لحظه:
--   • `findFirst({ status: 'OPEN' })` بدون ترتیب، هر بار یکی از دو دوره
--     را برمی‌گرداند (پنل‌ها بین دو دوره جابه‌جا می‌شدند)،
--   • رأی‌ها بین دو دوره تقسیم می‌شد و نتیجهٔ اعلام‌شده با آرای واقعی
--     انتخابی یکی نبود،
--   • ودیهٔ نامزدی هم در هر دو دوره کسر می‌شد (دو بار ۳۰۰ هزار برای یک دوره).
--
-- این مهاجرت دو کار می‌کند:
--   ۱. اگر در هر منطقه هنوز چند انتخابات OPEN مانده باشد (حالت تکراری
--      قدیمی)، قدیمی‌ترین دوره نگه داشته می‌شود — همان دورهایی که رأی و
--      نامزد واقعی دارد — و دورهای تکراری جدید بسته می‌شوند. ودیهٔ
--      نامزدهای دورهای تکراری با همان ردیف دفتر کلِ معمول برمی‌گردد،
--      پس پولی گم نمی‌شود و پولی هم از هیچ ساخته نمی‌شود.
--   ۲. یکتایی واقعی با یک ایندکس partial می‌سازد تا از این پس دیتابیس
--      خودش جلوی انتخابات OPEN دوم را بگیرد؛ سرویس هم در صورت برخورد
--      (P2002) همان دورهٔ موجود را برمی‌گرداند.
--
-- همهٔ مراحل Idempotent‌اند: اگر هیچ دورهٔ تکراری نباشد، هیچ نوشتاری
-- انجام نمی‌شود و ایندکس فقط در صورت نبود ساخته می‌شود.
-- ═══════════════════════════════════════════════════════════

-- ۱. ودیهٔ نامزدهای دورهای تکراری بازمی‌گردد (ردیف دفتر کل)
WITH ranked AS (
  SELECT
    e.id,
    ROW_NUMBER() OVER (
      PARTITION BY e."group_id"
      ORDER BY e."started_at" ASC, e.id ASC
    ) AS rn
  FROM "elections" e
  WHERE e.status = 'OPEN'
),
dupes AS (
  SELECT id FROM ranked WHERE rn > 1
)
INSERT INTO "financial_transactions" ("id", "amount", "type", "reference", "destination_player_id", "created_at")
SELECT
  gen_random_uuid(),
  300000,
  'TRANSFER',
  'بازگشت ودیهٔ نامزدی (بازبینی دورهٔ تکراری)',
  ec."player_id",
  now()
FROM "election_candidates" ec
JOIN dupes d ON d.id = ec."election_id";

-- ۲. همان مبلغ به کیف بازیکنان برمی‌گردد (بدون تکرار برای چند نامزدی در یک دوره)
WITH ranked AS (
  SELECT
    e.id,
    ROW_NUMBER() OVER (
      PARTITION BY e."group_id"
      ORDER BY e."started_at" ASC, e.id ASC
    ) AS rn
  FROM "elections" e
  WHERE e.status = 'OPEN'
),
dupes AS (
  SELECT id FROM ranked WHERE rn > 1
)
UPDATE "players" p
SET balance = p.balance + 300000
FROM (
  SELECT DISTINCT ec."player_id"
  FROM "election_candidates" ec
  WHERE ec."election_id" IN (SELECT id FROM dupes)
) t
WHERE p.id = t."player_id";

-- ۳. دورهای تکراری (همهٔ OPEN به‌جز قدیمی‌ترین هر منطقه) بسته می‌شوند
WITH ranked AS (
  SELECT
    e.id,
    ROW_NUMBER() OVER (
      PARTITION BY e."group_id"
      ORDER BY e."started_at" ASC, e.id ASC
    ) AS rn
  FROM "elections" e
  WHERE e.status = 'OPEN'
),
dupes AS (
  SELECT id FROM ranked WHERE rn > 1
)
UPDATE "elections"
SET status = 'CLOSED'
WHERE id IN (SELECT id FROM dupes);

-- ۴. یکتایی واقعی: در هر منطقه حداکثر یک انتخابات OPEN
CREATE UNIQUE INDEX IF NOT EXISTS idx_elections_one_open_per_group
  ON "elections" ("group_id")
  WHERE status = 'OPEN';
