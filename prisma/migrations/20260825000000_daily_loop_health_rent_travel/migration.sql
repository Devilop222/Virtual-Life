-- ═══════════════════════════════════════════════════════════
-- Update: چرخهٔ روزانه، نشان‌ها، سپردهٔ مدت‌دار، سلامت، اجاره، سفر
-- ═══════════════════════════════════════════════════════════

-- CreateEnum
CREATE TYPE "TermDepositStatus" AS ENUM ('ACTIVE', 'PAID', 'BROKEN');

-- AlterEnum: رخدادهای تازه
ALTER TYPE "GameEventType" ADD VALUE 'QUEST_COMPLETED';
ALTER TYPE "GameEventType" ADD VALUE 'WEEKLY_CHEST';
ALTER TYPE "GameEventType" ADD VALUE 'MEDICAL_TREATMENT';
ALTER TYPE "GameEventType" ADD VALUE 'DEPOSIT_MATURED';
ALTER TYPE "GameEventType" ADD VALUE 'TRAVEL_STAMP';

-- AlterEnum: انواع تراکنش تازه
ALTER TYPE "TransactionType" ADD VALUE 'MEDICAL_EXPENSE';
ALTER TYPE "TransactionType" ADD VALUE 'INSURANCE_PREMIUM';
ALTER TYPE "TransactionType" ADD VALUE 'DEPOSIT_PAYOUT';

-- CreateTable: daily_quests
CREATE TABLE "daily_quests" (
    "id" TEXT NOT NULL,
    "player_id" TEXT NOT NULL,
    "day_index" INTEGER NOT NULL,
    "quest_key" TEXT NOT NULL,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "target" INTEGER NOT NULL,
    "claimed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "daily_quests_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "daily_quests_player_id_day_index_quest_key_key" ON "daily_quests"("player_id", "day_index", "quest_key");
CREATE INDEX "daily_quests_player_id_day_index_idx" ON "daily_quests"("player_id", "day_index");
ALTER TABLE "daily_quests" ADD CONSTRAINT "daily_quests_player_id_fkey" FOREIGN KEY ("player_id") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable: weekly_chests
CREATE TABLE "weekly_chests" (
    "id" TEXT NOT NULL,
    "player_id" TEXT NOT NULL,
    "week_index" INTEGER NOT NULL,
    "amount" DECIMAL(65,30) NOT NULL,
    "claimed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "weekly_chests_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "weekly_chests_player_id_week_index_key" ON "weekly_chests"("player_id", "week_index");
ALTER TABLE "weekly_chests" ADD CONSTRAINT "weekly_chests_player_id_fkey" FOREIGN KEY ("player_id") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable: achievement_grants
CREATE TABLE "achievement_grants" (
    "id" TEXT NOT NULL,
    "player_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "reward" DECIMAL(65,30) NOT NULL,
    "granted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "achievement_grants_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "achievement_grants_player_id_key_key" ON "achievement_grants"("player_id", "key");
CREATE INDEX "achievement_grants_player_id_idx" ON "achievement_grants"("player_id");
ALTER TABLE "achievement_grants" ADD CONSTRAINT "achievement_grants_player_id_fkey" FOREIGN KEY ("player_id") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable: term_deposits
CREATE TABLE "term_deposits" (
    "id" TEXT NOT NULL,
    "player_id" TEXT NOT NULL,
    "principal" DECIMAL(65,30) NOT NULL,
    "rate_annual" DECIMAL(65,30) NOT NULL,
    "term_days" INTEGER NOT NULL,
    "opened_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "matures_at" TIMESTAMP(3) NOT NULL,
    "status" "TermDepositStatus" NOT NULL DEFAULT 'ACTIVE',
    "payout" DECIMAL(65,30),
    "settled_at" TIMESTAMP(3),
    CONSTRAINT "term_deposits_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "term_deposits_player_id_status_idx" ON "term_deposits"("player_id", "status");
ALTER TABLE "term_deposits" ADD CONSTRAINT "term_deposits_player_id_fkey" FOREIGN KEY ("player_id") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable: daily_fortunes
CREATE TABLE "daily_fortunes" (
    "id" TEXT NOT NULL,
    "player_id" TEXT NOT NULL,
    "day_index" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "amount" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "message" TEXT NOT NULL,
    "drawn_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "daily_fortunes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "daily_fortunes_player_id_day_index_key" ON "daily_fortunes"("player_id", "day_index");
ALTER TABLE "daily_fortunes" ADD CONSTRAINT "daily_fortunes_player_id_fkey" FOREIGN KEY ("player_id") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable: insurance_policies
CREATE TABLE "insurance_policies" (
    "id" TEXT NOT NULL,
    "player_id" TEXT NOT NULL,
    "premium" DECIMAL(65,30) NOT NULL,
    "cover_rate" DECIMAL(65,30) NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "covers_until" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "insurance_policies_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "insurance_policies_player_id_covers_until_idx" ON "insurance_policies"("player_id", "covers_until");
ALTER TABLE "insurance_policies" ADD CONSTRAINT "insurance_policies_player_id_fkey" FOREIGN KEY ("player_id") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable: travel_stamps
CREATE TABLE "travel_stamps" (
    "id" TEXT NOT NULL,
    "player_id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "stamped_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "travel_stamps_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "travel_stamps_player_id_group_id_key" ON "travel_stamps"("player_id", "group_id");
CREATE INDEX "travel_stamps_player_id_idx" ON "travel_stamps"("player_id");
ALTER TABLE "travel_stamps" ADD CONSTRAINT "travel_stamps_player_id_fkey" FOREIGN KEY ("player_id") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "travel_stamps" ADD CONSTRAINT "travel_stamps_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ملک اجاره‌ای: پرچم عرضه برای اجاره + قیمت تعیین‌شدهٔ مالک
ALTER TABLE "properties" ADD COLUMN "is_listed_for_rent" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "properties_is_listed_for_rent_idx" ON "properties"("is_listed_for_rent");

-- اعلان: کلید یکتا برای جلوگیری از اعلان تکراری
ALTER TABLE "notifications" ADD COLUMN "dedupe_key" TEXT;
CREATE UNIQUE INDEX "notifications_dedupe_key_key" ON "notifications"("dedupe_key");
