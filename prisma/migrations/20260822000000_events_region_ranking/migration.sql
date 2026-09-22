-- CreateEnum
CREATE TYPE "EventScope" AS ENUM ('PLAYER', 'REGION');

-- CreateEnum
CREATE TYPE "GameEventType" AS ENUM ('JOB_STARTED', 'JOB_FINISHED', 'SALARY_RECEIVED', 'HOUSE_PURCHASED', 'HOUSE_RENTED', 'BANK_DEPOSIT', 'BANK_WITHDRAW', 'LOAN_CREATED', 'LOAN_REPAID', 'EDUCATION_ENROLLED', 'EDUCATION_COMPLETED', 'COMPANY_CREATED', 'COMPANY_UPGRADED', 'MARKET_TRANSACTION', 'ACHIEVEMENT_UNLOCKED', 'REGION_REGISTERED', 'REGION_LEVEL_CHANGED', 'REGION_POPULATION_MILESTONE', 'REGION_ECONOMY_SHIFT', 'REGION_WEALTH_RECORD', 'REGION_BIG_TRANSACTION');

-- CreateEnum
CREATE TYPE "RankingScope" AS ENUM ('GROUP', 'GLOBAL', 'REGION');

-- CreateTable
CREATE TABLE "game_events" (
    "id" TEXT NOT NULL,
    "scope" "EventScope" NOT NULL,
    "type" "GameEventType" NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 1,
    "player_id" TEXT,
    "group_id" TEXT,
    "title" TEXT NOT NULL,
    "detail" TEXT,
    "amount" DECIMAL(65,30),
    "dedupe_key" TEXT,
    "published_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "game_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "region_stats" (
    "group_id" TEXT NOT NULL,
    "population" INTEGER NOT NULL DEFAULT 0,
    "employed" INTEGER NOT NULL DEFAULT 0,
    "companies" INTEGER NOT NULL DEFAULT 0,
    "properties" INTEGER NOT NULL DEFAULT 0,
    "total_wealth" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "bank_deposits" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "total_debt" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "average_income" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "educated_count" INTEGER NOT NULL DEFAULT 0,
    "transaction_volume" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "transaction_count" INTEGER NOT NULL DEFAULT 0,
    "tax_revenue" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "economic_index" INTEGER NOT NULL DEFAULT 0,
    "previous_index" INTEGER NOT NULL DEFAULT 0,
    "refreshed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "region_stats_pkey" PRIMARY KEY ("group_id")
);

-- CreateTable
CREATE TABLE "ranking_snapshots" (
    "id" TEXT NOT NULL,
    "scope" "RankingScope" NOT NULL,
    "category" TEXT NOT NULL,
    "group_id" TEXT,
    "payload" JSONB NOT NULL,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ranking_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "game_events_dedupe_key_key" ON "game_events"("dedupe_key");

-- CreateIndex
CREATE INDEX "game_events_player_id_created_at_idx" ON "game_events"("player_id", "created_at");

-- CreateIndex
CREATE INDEX "game_events_group_id_created_at_idx" ON "game_events"("group_id", "created_at");

-- CreateIndex
CREATE INDEX "game_events_group_id_published_at_idx" ON "game_events"("group_id", "published_at");

-- CreateIndex
CREATE INDEX "game_events_scope_priority_idx" ON "game_events"("scope", "priority");

-- CreateIndex
CREATE INDEX "region_stats_economic_index_idx" ON "region_stats"("economic_index");

-- CreateIndex
CREATE INDEX "ranking_snapshots_computed_at_idx" ON "ranking_snapshots"("computed_at");

-- CreateIndex
CREATE UNIQUE INDEX "ranking_snapshots_scope_category_group_id_key" ON "ranking_snapshots"("scope", "category", "group_id");

-- AddForeignKey
ALTER TABLE "game_events" ADD CONSTRAINT "game_events_player_id_fkey" FOREIGN KEY ("player_id") REFERENCES "players"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_events" ADD CONSTRAINT "game_events_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "region_stats" ADD CONSTRAINT "region_stats_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;