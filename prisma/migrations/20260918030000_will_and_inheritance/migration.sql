-- وصیت و میراث.
--
-- پیش از این، مرگ فقط یک برچسب وضعیت بود (`PlayerStatus.DEAD`) و هیچ مسیری
-- داراییِ شخصیت متوفی را تعیین تکلیف نمی‌کرد: کیف پول، بانک، ملک، کسب‌وکار،
-- سپرده، سهام و انبار بازیکن تا ابد روی شخصیتِ مرده می‌ماند و هیچ‌کس — نه
-- بازیکن و نه سیستم — نمی‌توانست بگوید آن پول باید کجا برود. این مهاجرت سه
-- چیز اضافه می‌کند:
--
--   ۱. `wills`              — آخرین وصیتِ معتبر هر شخصیت (owner_id یکتا،
--                             پس «ثبت وصیت» یک upsert اتمیک است).
--   ۲. `inheritance_cases`  — پروندهٔ میراث با وضعیتِ مرحله‌ای؛ مرگ و انتقال
--                             دارایی فقط از این‌جا رد می‌شوند (deceased_id یکتا،
--                             پس ثبت مرگ دقیقاً یک‌بار ممکن است).
--   ۳. مقدارِ `INHERITANCE_TRANSFER` در enum تراکنش‌ها — انتقالِ واقعیِ پول از
--                             متوفی به وارث باید ردیفِ دفتری داشته باشد، وگرنه
--                             اینورینتِ «هر تغییر موجودی، ردیف دفتری دارد»
--                             می‌شکند و ممیزیِ اقتصاد آن را پولِ بی‌منبع می‌بیند.
--
-- هیچ ستون/ردیف/مقدارِ موجودی حذف یا بازنویسی نمی‌شود.

-- AlterEnum
ALTER TYPE "TransactionType" ADD VALUE IF NOT EXISTS 'INHERITANCE_TRANSFER';

-- CreateEnum
CREATE TYPE "InheritanceStatus" AS ENUM ('PENDING', 'SETTLED_DEBTS', 'TRANSFERRED', 'COMPLETED', 'NO_HEIR', 'FAILED');

-- CreateTable
CREATE TABLE "wills" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "heir_id" TEXT NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inheritance_cases" (
    "id" TEXT NOT NULL,
    "deceased_id" TEXT NOT NULL,
    "heir_id" TEXT,
    "status" "InheritanceStatus" NOT NULL DEFAULT 'PENDING',
    "cause" TEXT NOT NULL,
    "snapshot" JSONB,
    "cash_transferred" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "debt_settled" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "debt_unpaid" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "properties_count" INTEGER NOT NULL DEFAULT 0,
    "businesses_count" INTEGER NOT NULL DEFAULT 0,
    "holdings_count" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "opened_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "inheritance_cases_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "wills_owner_id_key" ON "wills"("owner_id");

-- CreateIndex
CREATE INDEX "wills_heir_id_idx" ON "wills"("heir_id");

-- CreateIndex
CREATE UNIQUE INDEX "inheritance_cases_deceased_id_key" ON "inheritance_cases"("deceased_id");

-- CreateIndex
CREATE INDEX "inheritance_cases_status_idx" ON "inheritance_cases"("status");

-- CreateIndex
CREATE INDEX "inheritance_cases_heir_id_idx" ON "inheritance_cases"("heir_id");

-- AddForeignKey
ALTER TABLE "wills" ADD CONSTRAINT "wills_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "players"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wills" ADD CONSTRAINT "wills_heir_id_fkey" FOREIGN KEY ("heir_id") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inheritance_cases" ADD CONSTRAINT "inheritance_cases_deceased_id_fkey" FOREIGN KEY ("deceased_id") REFERENCES "players"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inheritance_cases" ADD CONSTRAINT "inheritance_cases_heir_id_fkey" FOREIGN KEY ("heir_id") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
