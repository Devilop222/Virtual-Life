-- CreateEnum
-- Idempotent: MigrationReason may already exist (created by 20260823000000_residence_migration).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' AND t.typname = 'MigrationReason') THEN
    CREATE TYPE "MigrationReason" AS ENUM ('FIRST_SETTLEMENT', 'VOLUNTARY', 'ADMIN_ACTION');
  END IF;
END
$$;

-- AlterEnum
ALTER TYPE "GameEventType" ADD VALUE 'STREAK_CLAIMED';
ALTER TYPE "GameEventType" ADD VALUE 'OVERTIME_WORKED';
ALTER TYPE "GameEventType" ADD VALUE 'RENT_INCOME';
ALTER TYPE "GameEventType" ADD VALUE 'PROJECT_COMPLETED';
ALTER TYPE "GameEventType" ADD VALUE 'LOTTERY_TICKET';
ALTER TYPE "GameEventType" ADD VALUE 'LOTTERY_WON';
ALTER TYPE "GameEventType" ADD VALUE 'ELECTION_WON';
ALTER TYPE "GameEventType" ADD VALUE 'ITEM_SOLD';
ALTER TYPE "GameEventType" ADD VALUE 'PLAYER_REFERRED';

-- AlterEnum
ALTER TYPE "TransactionType" ADD VALUE 'MARKET_TRADE';
ALTER TYPE "TransactionType" ADD VALUE 'LOTTERY_PRIZE';

-- AlterTable (players)
ALTER TABLE "players" ADD COLUMN "streak_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "players" ADD COLUMN "last_streak_at" TIMESTAMP(3);
ALTER TABLE "players" ADD COLUMN "last_overtime_at" TIMESTAMP(3);
ALTER TABLE "players" ADD COLUMN "referral_code" TEXT;

-- AlterTable (groups)
ALTER TABLE "groups" ADD COLUMN "lottery_last_week" INTEGER;
ALTER TABLE "groups" ADD COLUMN "lottery_last_winner_id" TEXT;
ALTER TABLE "groups" ADD COLUMN "lottery_last_prize" DECIMAL(65,30);

-- CreateTable: region_projects
CREATE TABLE "region_projects" (
    "id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "target_amount" DECIMAL(65,30) NOT NULL,
    "collected_amount" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "is_completed" BOOLEAN NOT NULL DEFAULT false,
    "started_by_player_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    CONSTRAINT "region_projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable: lottery_tickets
CREATE TABLE "lottery_tickets" (
    "id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "player_id" TEXT NOT NULL,
    "week_key" INTEGER NOT NULL,
    "price" DECIMAL(65,30) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "lottery_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable: market_listings
CREATE TABLE "market_listings" (
    "id" TEXT NOT NULL,
    "seller_player_id" TEXT NOT NULL,
    "item_id" TEXT NOT NULL,
    "item_name" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unit_price" DECIMAL(65,30) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "sold_at" TIMESTAMP(3),
    CONSTRAINT "market_listings_pkey" PRIMARY KEY ("id")
);

-- CreateTable: referrals
CREATE TABLE "referrals" (
    "id" TEXT NOT NULL,
    "referrer_player_id" TEXT NOT NULL,
    "referee_player_id" TEXT NOT NULL,
    "rewarded_at" TIMESTAMP(3),
    "bonus_paid_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "referrals_pkey" PRIMARY KEY ("id")
);

-- CreateTable: election_candidates
CREATE TABLE "election_candidates" (
    "id" TEXT NOT NULL,
    "election_id" TEXT NOT NULL,
    "player_id" TEXT NOT NULL,
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "election_candidates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "region_projects_group_id_is_completed_idx" ON "region_projects"("group_id", "is_completed");
CREATE UNIQUE INDEX "lottery_tickets_group_id_player_id_week_key_key" ON "lottery_tickets"("group_id", "player_id", "week_key");
CREATE INDEX "lottery_tickets_group_id_week_key_idx" ON "lottery_tickets"("group_id", "week_key");
CREATE INDEX "market_listings_status_expires_at_idx" ON "market_listings"("status", "expires_at");
CREATE INDEX "market_listings_seller_player_id_idx" ON "market_listings"("seller_player_id");
CREATE INDEX "referrals_referrer_player_id_idx" ON "referrals"("referrer_player_id");
CREATE UNIQUE INDEX "election_candidates_election_id_player_id_key" ON "election_candidates"("election_id", "player_id");

-- AddForeignKey
ALTER TABLE "region_projects" ADD CONSTRAINT "region_projects_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "lottery_tickets" ADD CONSTRAINT "lottery_tickets_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "lottery_tickets" ADD CONSTRAINT "lottery_tickets_player_id_fkey" FOREIGN KEY ("player_id") REFERENCES "players"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "market_listings" ADD CONSTRAINT "market_listings_seller_player_id_fkey" FOREIGN KEY ("seller_player_id") REFERENCES "players"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "market_listings" ADD CONSTRAINT "market_listings_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "shop_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referrer_player_id_fkey" FOREIGN KEY ("referrer_player_id") REFERENCES "players"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referee_player_id_fkey" FOREIGN KEY ("referee_player_id") REFERENCES "players"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "election_candidates" ADD CONSTRAINT "election_candidates_election_id_fkey" FOREIGN KEY ("election_id") REFERENCES "elections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "election_candidates" ADD CONSTRAINT "election_candidates_player_id_fkey" FOREIGN KEY ("player_id") REFERENCES "players"("id") ON DELETE CASCADE ON UPDATE CASCADE;