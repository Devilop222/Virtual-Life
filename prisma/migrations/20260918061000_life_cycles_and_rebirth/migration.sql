-- چرخهٔ زندگی: شمارندهٔ زندگی‌ها روی بازیکن، و یکتاییِ پروندهٔ میراث «به‌ازای هر زندگی».
--
-- پیش از این `inheritance_cases.deceased_id` یکتا بود؛ یعنی هر حساب در کلِ
-- عمرش فقط یک بار می‌توانست بمیرد. با «زندگی تازه» این قید مانع می‌شد، ولی
-- حذفِ سادهٔ آن هم idempotencyِ ثبتِ مرگ را از بین می‌برد. راه‌حل: یکتایی روی
-- (متوفی، شمارهٔ زندگی) — پس هر زندگی دقیقاً یک پرونده دارد، و زندگی بعدی
-- پروندهٔ تازه می‌گیرد بی‌آنکه سابقهٔ زندگی قبلی دست بخورد.

ALTER TABLE "players" ADD COLUMN "lives" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "inheritance_cases" ADD COLUMN "life_index" INTEGER NOT NULL DEFAULT 1;

-- رکوردهای موجود همه زندگیِ اول‌اند، پس مقدار پیش‌فرض ۱ درست است.
DROP INDEX "inheritance_cases_deceased_id_key";

CREATE UNIQUE INDEX "inheritance_cases_deceased_id_life_index_key" ON "inheritance_cases"("deceased_id", "life_index");
