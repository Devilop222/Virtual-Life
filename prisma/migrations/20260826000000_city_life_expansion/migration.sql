-- ═══════════════════════════════════════════════════════════
-- Update: زندگی شهری — ازدواج، حیوان خانگی، بورس، حراجی، باشگاه،
-- قرض بازیکنی، مزرعه، کارگاه ساخت، چالش جمعی و گسترش‌ها
-- ═══════════════════════════════════════════════════════════

-- AlterEnum: رخدادهای تازه
ALTER TYPE "GameEventType" ADD VALUE 'MARRIAGE_REGISTERED';
ALTER TYPE "GameEventType" ADD VALUE 'DIVORCE_REGISTERED';
ALTER TYPE "GameEventType" ADD VALUE 'PET_ADOPTED';
ALTER TYPE "GameEventType" ADD VALUE 'PET_FED';
ALTER TYPE "GameEventType" ADD VALUE 'STOCK_TRANSACTION';
ALTER TYPE "GameEventType" ADD VALUE 'AUCTION_WON';
ALTER TYPE "GameEventType" ADD VALUE 'GYM_SUBSCRIBED';
ALTER TYPE "GameEventType" ADD VALUE 'P2P_LOAN_SETTLED';
ALTER TYPE "GameEventType" ADD VALUE 'FARM_HARVESTED';
ALTER TYPE "GameEventType" ADD VALUE 'ITEM_CRAFTED';
ALTER TYPE "GameEventType" ADD VALUE 'CHALLENGE_COMPLETED';
ALTER TYPE "GameEventType" ADD VALUE 'BRANCH_OPENED';
ALTER TYPE "GameEventType" ADD VALUE 'MAYOR_POLICY_SET';
ALTER TYPE "GameEventType" ADD VALUE 'NEWS_AD_PUBLISHED';

-- AlterEnum: انواع تراکنش تازه
ALTER TYPE "TransactionType" ADD VALUE 'MAHR_PAYMENT';
ALTER TYPE "TransactionType" ADD VALUE 'DIVORCE_SETTLEMENT';
ALTER TYPE "TransactionType" ADD VALUE 'STOCK_BUY';
ALTER TYPE "TransactionType" ADD VALUE 'STOCK_SELL';
ALTER TYPE "TransactionType" ADD VALUE 'AUCTION_BID';
ALTER TYPE "TransactionType" ADD VALUE 'AUCTION_WIN';
ALTER TYPE "TransactionType" ADD VALUE 'GYM_FEE';
ALTER TYPE "TransactionType" ADD VALUE 'P2P_LOAN_DISBURSE';
ALTER TYPE "TransactionType" ADD VALUE 'P2P_LOAN_REPAY';
ALTER TYPE "TransactionType" ADD VALUE 'FARM_PLANT';
ALTER TYPE "TransactionType" ADD VALUE 'FARM_HARVEST';
ALTER TYPE "TransactionType" ADD VALUE 'CRAFTING_FEE';
ALTER TYPE "TransactionType" ADD VALUE 'BRANCH_SETUP';
ALTER TYPE "TransactionType" ADD VALUE 'PROPERTY_MAINTENANCE';
ALTER TYPE "TransactionType" ADD VALUE 'NEWS_AD_FEE';

-- AlterTable: املاک — مبله و نگهداری
ALTER TABLE "properties" ADD COLUMN "is_furnished" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "properties" ADD COLUMN "last_maintenance_at" TIMESTAMP(3);

-- AlterTable: مناطق — سیاست فعال شهردار
ALTER TABLE "groups" ADD COLUMN "active_policy" TEXT;

-- CreateTable: marriages
CREATE TABLE "marriages" (
    "id" TEXT NOT NULL,
    "player_a_id" TEXT NOT NULL,
    "player_b_id" TEXT NOT NULL,
    "mahr" DECIMAL(65,30) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "married_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "divorced_at" TIMESTAMP(3),
    "last_bonus_day_index" INTEGER,
    CONSTRAINT "marriages_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "marriages_player_a_id_is_active_idx" ON "marriages"("player_a_id", "is_active");
CREATE INDEX "marriages_player_b_id_is_active_idx" ON "marriages"("player_b_id", "is_active");
ALTER TABLE "marriages" ADD CONSTRAINT "marriages_player_a_id_fkey" FOREIGN KEY ("player_a_id") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "marriages" ADD CONSTRAINT "marriages_player_b_id_fkey" FOREIGN KEY ("player_b_id") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable: marriage_proposals
CREATE TABLE "marriage_proposals" (
    "id" TEXT NOT NULL,
    "proposer_id" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "mahr" DECIMAL(65,30) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "marriage_proposals_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "marriage_proposals_target_id_status_idx" ON "marriage_proposals"("target_id", "status");
ALTER TABLE "marriage_proposals" ADD CONSTRAINT "marriage_proposals_proposer_id_fkey" FOREIGN KEY ("proposer_id") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "marriage_proposals" ADD CONSTRAINT "marriage_proposals_target_id_fkey" FOREIGN KEY ("target_id") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable: pets
CREATE TABLE "pets" (
    "id" TEXT NOT NULL,
    "player_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "hunger" INTEGER NOT NULL DEFAULT 0,
    "mood" INTEGER NOT NULL DEFAULT 100,
    "last_fed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "adopted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_bonus_day_index" INTEGER,
    CONSTRAINT "pets_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "pets_player_id_key" ON "pets"("player_id");
ALTER TABLE "pets" ADD CONSTRAINT "pets_player_id_fkey" FOREIGN KEY ("player_id") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable: stock_holdings
CREATE TABLE "stock_holdings" (
    "id" TEXT NOT NULL,
    "player_id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "shares" INTEGER NOT NULL DEFAULT 0,
    "average_buy_price" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "stock_holdings_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "stock_holdings_player_id_symbol_key" ON "stock_holdings"("player_id", "symbol");
CREATE INDEX "stock_holdings_player_id_idx" ON "stock_holdings"("player_id");
ALTER TABLE "stock_holdings" ADD CONSTRAINT "stock_holdings_player_id_fkey" FOREIGN KEY ("player_id") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable: auctions
CREATE TABLE "auctions" (
    "id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "item_key" TEXT NOT NULL,
    "item_name" TEXT NOT NULL,
    "week_key" INTEGER NOT NULL,
    "starting_bid" DECIMAL(65,30) NOT NULL,
    "current_bid" DECIMAL(65,30) NOT NULL,
    "highest_bidder_id" TEXT,
    "is_closed" BOOLEAN NOT NULL DEFAULT false,
    "closed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "auctions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "auctions_group_id_week_key_item_key_key" ON "auctions"("group_id", "week_key", "item_key");
CREATE INDEX "auctions_group_id_is_closed_idx" ON "auctions"("group_id", "is_closed");
ALTER TABLE "auctions" ADD CONSTRAINT "auctions_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable: auction_bids
CREATE TABLE "auction_bids" (
    "id" TEXT NOT NULL,
    "auction_id" TEXT NOT NULL,
    "bidder_id" TEXT NOT NULL,
    "amount" DECIMAL(65,30) NOT NULL,
    "bid_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "auction_bids_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "auction_bids_auction_id_amount_idx" ON "auction_bids"("auction_id", "amount");
CREATE INDEX "auction_bids_bidder_id_idx" ON "auction_bids"("bidder_id");
ALTER TABLE "auction_bids" ADD CONSTRAINT "auction_bids_auction_id_fkey" FOREIGN KEY ("auction_id") REFERENCES "auctions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "auction_bids" ADD CONSTRAINT "auction_bids_bidder_id_fkey" FOREIGN KEY ("bidder_id") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable: gym_memberships
CREATE TABLE "gym_memberships" (
    "id" TEXT NOT NULL,
    "player_id" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "gym_memberships_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "gym_memberships_player_id_expires_at_idx" ON "gym_memberships"("player_id", "expires_at");
ALTER TABLE "gym_memberships" ADD CONSTRAINT "gym_memberships_player_id_fkey" FOREIGN KEY ("player_id") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable: player_loans
CREATE TABLE "player_loans" (
    "id" TEXT NOT NULL,
    "lender_id" TEXT NOT NULL,
    "borrower_id" TEXT NOT NULL,
    "principal" DECIMAL(65,30) NOT NULL,
    "fee_rate" DECIMAL(65,30) NOT NULL DEFAULT 0.05,
    "total_repay" DECIMAL(65,30) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "due_at" TIMESTAMP(3),
    "disbursed_at" TIMESTAMP(3),
    "paid_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "player_loans_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "player_loans_borrower_id_status_idx" ON "player_loans"("borrower_id", "status");
CREATE INDEX "player_loans_lender_id_status_idx" ON "player_loans"("lender_id", "status");
ALTER TABLE "player_loans" ADD CONSTRAINT "player_loans_lender_id_fkey" FOREIGN KEY ("lender_id") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "player_loans" ADD CONSTRAINT "player_loans_borrower_id_fkey" FOREIGN KEY ("borrower_id") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable: farm_plots
CREATE TABLE "farm_plots" (
    "id" TEXT NOT NULL,
    "player_id" TEXT NOT NULL,
    "seed_key" TEXT NOT NULL,
    "seed_name" TEXT NOT NULL,
    "cost" DECIMAL(65,30) NOT NULL,
    "expected_harvest" DECIMAL(65,30) NOT NULL,
    "planted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ready_at" TIMESTAMP(3) NOT NULL,
    "is_harvested" BOOLEAN NOT NULL DEFAULT false,
    "harvested_at" TIMESTAMP(3),
    CONSTRAINT "farm_plots_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "farm_plots_player_id_is_harvested_idx" ON "farm_plots"("player_id", "is_harvested");
ALTER TABLE "farm_plots" ADD CONSTRAINT "farm_plots_player_id_fkey" FOREIGN KEY ("player_id") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable: business_branches
CREATE TABLE "business_branches" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "level" INTEGER NOT NULL DEFAULT 1,
    "employee_capacity" INTEGER NOT NULL DEFAULT 3,
    "income_per_day" DECIMAL(65,30) NOT NULL DEFAULT 400000,
    "last_collected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "BusinessStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "business_branches_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "business_branches_business_id_group_id_key" ON "business_branches"("business_id", "group_id");
CREATE INDEX "business_branches_group_id_idx" ON "business_branches"("group_id");
ALTER TABLE "business_branches" ADD CONSTRAINT "business_branches_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "business_branches" ADD CONSTRAINT "business_branches_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable: regional_challenges
CREATE TABLE "regional_challenges" (
    "id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "week_key" INTEGER NOT NULL,
    "goal_key" TEXT NOT NULL,
    "goal_title" TEXT NOT NULL,
    "target_value" INTEGER NOT NULL,
    "current_value" INTEGER NOT NULL DEFAULT 0,
    "is_completed" BOOLEAN NOT NULL DEFAULT false,
    "reward_per_player" DECIMAL(65,30) NOT NULL,
    "completed_at" TIMESTAMP(3),
    CONSTRAINT "regional_challenges_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "regional_challenges_group_id_week_key_goal_key_key" ON "regional_challenges"("group_id", "week_key", "goal_key");
CREATE INDEX "regional_challenges_group_id_week_key_idx" ON "regional_challenges"("group_id", "week_key");
ALTER TABLE "regional_challenges" ADD CONSTRAINT "regional_challenges_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable: regional_challenge_contributions
CREATE TABLE "regional_challenge_contributions" (
    "id" TEXT NOT NULL,
    "challenge_id" TEXT NOT NULL,
    "player_id" TEXT NOT NULL,
    "points" INTEGER NOT NULL DEFAULT 0,
    "claimed_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "regional_challenge_contributions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "regional_challenge_contributions_challenge_id_player_id_key" ON "regional_challenge_contributions"("challenge_id", "player_id");
CREATE INDEX "regional_challenge_contributions_player_id_idx" ON "regional_challenge_contributions"("player_id");
ALTER TABLE "regional_challenge_contributions" ADD CONSTRAINT "regional_challenge_contributions_challenge_id_fkey" FOREIGN KEY ("challenge_id") REFERENCES "regional_challenges"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "regional_challenge_contributions" ADD CONSTRAINT "regional_challenge_contributions_player_id_fkey" FOREIGN KEY ("player_id") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
