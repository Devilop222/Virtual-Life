-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Gender" AS ENUM ('MALE', 'FEMALE');

-- CreateEnum
CREATE TYPE "MaritalStatus" AS ENUM ('SINGLE', 'MARRIED', 'DIVORCED', 'WIDOWED');

-- CreateEnum
CREATE TYPE "SocialLevel" AS ENUM ('LOW', 'MIDDLE', 'HIGH', 'ELITE');

-- CreateEnum
CREATE TYPE "PlayerStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'DEAD', 'BANNED');

-- CreateEnum
CREATE TYPE "ProfilePrivacy" AS ENUM ('PUBLIC', 'PRIVATE');

-- CreateEnum
CREATE TYPE "PlayerActivityState" AS ENUM ('IDLE', 'WORKING', 'STUDYING', 'RESTING', 'SLEEPING', 'TRAVELING');

-- CreateEnum
CREATE TYPE "DegreeLevel" AS ENUM ('DIPLOMA', 'ASSOCIATE', 'BACHELOR', 'MASTER', 'DOCTORATE');

-- CreateEnum
CREATE TYPE "LifeStage" AS ENUM ('CHILDHOOD', 'ADOLESCENCE', 'YOUTH', 'ADULTHOOD', 'MIDDLE_AGE', 'SENIORITY');

-- CreateEnum
CREATE TYPE "GroupType" AS ENUM ('GROUP', 'SUPERGROUP', 'CHANNEL');

-- CreateEnum
CREATE TYPE "GroupStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "GroupEnvironmentLevel" AS ENUM ('VILLAGE', 'CITY', 'PROVINCE', 'COUNTRY');

-- CreateEnum
CREATE TYPE "PlayerGroupRole" AS ENUM ('MEMBER', 'ADMIN', 'OWNER');

-- CreateEnum
CREATE TYPE "PlayerGroupActivity" AS ENUM ('LOW', 'NORMAL', 'HIGH');

-- CreateEnum
CREATE TYPE "PlayerGroupStatus" AS ENUM ('ACTIVE', 'LEFT', 'KICKED', 'BANNED');

-- CreateEnum
CREATE TYPE "RegistrationState" AS ENUM ('AWAITING_GENDER', 'AWAITING_BIOGRAPHY', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "RelationshipType" AS ENUM ('FRIEND', 'FAMILY', 'SPOUSE', 'COLLEAGUE', 'NEIGHBOR', 'ENEMY');

-- CreateEnum
CREATE TYPE "RelationshipStatus" AS ENUM ('PENDING', 'ACTIVE', 'BLOCKED', 'ENDED');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('INFO', 'EVENT', 'WARNING', 'SYSTEM');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'READ');

-- CreateEnum
CREATE TYPE "WorkSessionType" AS ENUM ('PART_TIME', 'FULL_TIME');

-- CreateEnum
CREATE TYPE "WorkSessionStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "BusinessCategory" AS ENUM ('SERVICE', 'STORE', 'GYM', 'EDUCATION', 'WORKSHOP', 'FACTORY', 'OFFICE');

-- CreateEnum
CREATE TYPE "BusinessStatus" AS ENUM ('ACTIVE', 'BANKRUPT', 'CLOSED');

-- CreateEnum
CREATE TYPE "JobPostingStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "JobApplicationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PropertyType" AS ENUM ('ROOM', 'SMALL_HOUSE', 'APARTMENT', 'LARGE_HOUSE', 'VILLA', 'MANSION');

-- CreateEnum
CREATE TYPE "PropertyStatus" AS ENUM ('AVAILABLE', 'OWNED', 'RENTED');

-- CreateEnum
CREATE TYPE "BankAccountStatus" AS ENUM ('ACTIVE', 'FROZEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "LoanStatus" AS ENUM ('ACTIVE', 'PAID', 'DEFAULTED', 'CLOSED');

-- CreateEnum
CREATE TYPE "ElectionStatus" AS ENUM ('UPCOMING', 'OPEN', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TransactionType" AS ENUM ('SALARY_PAYMENT', 'BUSINESS_REVENUE', 'STARTUP_COST', 'BUSINESS_UPGRADE', 'PROPERTY_PURCHASE', 'PROPERTY_RENT', 'BANK_DEPOSIT', 'BANK_WITHDRAWAL', 'BANK_INTEREST', 'LOAN_DISBURSEMENT', 'LOAN_REPAYMENT', 'TRANSFER', 'WITHDRAWAL', 'DEPOSIT');

-- CreateTable
CREATE TABLE "players" (
    "id" TEXT NOT NULL,
    "telegram_user_id" BIGINT NOT NULL,
    "first_name" TEXT NOT NULL,
    "last_name" TEXT,
    "username" TEXT,
    "gender" "Gender" NOT NULL,
    "birth_date" TIMESTAMP(3),
    "age" INTEGER NOT NULL DEFAULT 18,
    "life_stage" "LifeStage" NOT NULL DEFAULT 'YOUTH',
    "biography" TEXT NOT NULL,
    "marital_status" "MaritalStatus" NOT NULL DEFAULT 'SINGLE',
    "social_level" "SocialLevel" NOT NULL DEFAULT 'LOW',
    "privacy" "ProfilePrivacy" NOT NULL DEFAULT 'PUBLIC',
    "activity_state" "PlayerActivityState" NOT NULL DEFAULT 'IDLE',
    "health" INTEGER NOT NULL DEFAULT 100,
    "fatigue" INTEGER NOT NULL DEFAULT 0,
    "experience" INTEGER NOT NULL DEFAULT 0,
    "balance" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "current_degree" "DegreeLevel" NOT NULL DEFAULT 'DIPLOMA',
    "graduation_field" TEXT,
    "is_enrolled" BOOLEAN NOT NULL DEFAULT false,
    "enrolled_field_key" TEXT,
    "target_degree" "DegreeLevel",
    "study_started_at" TIMESTAMP(3),
    "rest_started_at" TIMESTAMP(3),
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "status" "PlayerStatus" NOT NULL DEFAULT 'ACTIVE',
    "occupation_id" TEXT,
    "home_group_id" TEXT,

    CONSTRAINT "players_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "groups" (
    "id" TEXT NOT NULL,
    "telegram_group_id" BIGINT NOT NULL,
    "title" TEXT NOT NULL,
    "type" "GroupType" NOT NULL DEFAULT 'SUPERGROUP',
    "member_count" INTEGER NOT NULL DEFAULT 0,
    "real_member_count" INTEGER NOT NULL DEFAULT 0,
    "environment_level" "GroupEnvironmentLevel" NOT NULL DEFAULT 'VILLAGE',
    "status" "GroupStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "player_groups" (
    "id" TEXT NOT NULL,
    "player_id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "role" "PlayerGroupRole" NOT NULL DEFAULT 'MEMBER',
    "activity" "PlayerGroupActivity" NOT NULL DEFAULT 'NORMAL',
    "status" "PlayerGroupStatus" NOT NULL DEFAULT 'ACTIVE',

    CONSTRAINT "player_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "occupations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT NOT NULL,
    "level" INTEGER NOT NULL DEFAULT 1,
    "base_salary" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "required_age" INTEGER NOT NULL DEFAULT 18,
    "experience" INTEGER NOT NULL DEFAULT 0,
    "working_hours" INTEGER NOT NULL DEFAULT 8,
    "workplace" TEXT NOT NULL,
    "promotion_rules" JSONB NOT NULL DEFAULT '{}',
    "required_skills" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "occupations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "skills" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT NOT NULL DEFAULT 'general',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "skills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "player_skills" (
    "id" TEXT NOT NULL,
    "player_id" TEXT NOT NULL,
    "skill_id" TEXT NOT NULL,
    "level" INTEGER NOT NULL DEFAULT 1,
    "points" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "player_skills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "relationships" (
    "id" TEXT NOT NULL,
    "player_id" TEXT NOT NULL,
    "related_player_id" TEXT NOT NULL,
    "type" "RelationshipType" NOT NULL,
    "status" "RelationshipStatus" NOT NULL DEFAULT 'ACTIVE',
    "strength" INTEGER NOT NULL DEFAULT 50,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "relationships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "player_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL DEFAULT 'INFO',
    "status" "NotificationStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "read_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_states" (
    "id" TEXT NOT NULL,
    "telegram_user_id" BIGINT NOT NULL,
    "current_context" TEXT,
    "state_data" JSONB NOT NULL DEFAULT '{}',
    "pending_since" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "properties" (
    "id" TEXT NOT NULL,
    "type" "PropertyType" NOT NULL,
    "title" TEXT NOT NULL,
    "level" INTEGER NOT NULL DEFAULT 1,
    "purchase_price" DECIMAL(65,30) NOT NULL,
    "rental_price_monthly" DECIMAL(65,30) NOT NULL,
    "base_asset_value" DECIMAL(65,30) NOT NULL,
    "fatigue_recovery_rate" DECIMAL(65,30) NOT NULL DEFAULT 1.0,
    "owner_id" TEXT,
    "group_id" TEXT,
    "status" "PropertyStatus" NOT NULL DEFAULT 'AVAILABLE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "properties_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rental_contracts" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "monthly_rent" DECIMAL(65,30) NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "rental_contracts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_accounts" (
    "id" TEXT NOT NULL,
    "player_id" TEXT NOT NULL,
    "card_number" TEXT NOT NULL,
    "balance" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "interest_rate_annual" DECIMAL(65,30) NOT NULL DEFAULT 0.15,
    "last_interest_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "BankAccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bank_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loans" (
    "id" TEXT NOT NULL,
    "player_id" TEXT NOT NULL,
    "principal_amount" DECIMAL(65,30) NOT NULL,
    "total_repayment_amount" DECIMAL(65,30) NOT NULL,
    "remaining_amount" DECIMAL(65,30) NOT NULL,
    "interest_rate_percent" DECIMAL(65,30) NOT NULL,
    "collateral_property_id" TEXT,
    "collateral_business_id" TEXT,
    "status" "LoanStatus" NOT NULL DEFAULT 'ACTIVE',
    "disbursed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "due_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "loans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "elections" (
    "id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" "ElectionStatus" NOT NULL DEFAULT 'UPCOMING',
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ends_at" TIMESTAMP(3) NOT NULL,
    "winner_id" TEXT,

    CONSTRAINT "elections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "votes" (
    "id" TEXT NOT NULL,
    "election_id" TEXT NOT NULL,
    "voter_id" TEXT NOT NULL,
    "candidate_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "votes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_sessions" (
    "id" TEXT NOT NULL,
    "player_id" TEXT NOT NULL,
    "job_key" TEXT NOT NULL,
    "job_title" TEXT NOT NULL,
    "session_type" "WorkSessionType" NOT NULL DEFAULT 'PART_TIME',
    "business_id" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMP(3),
    "status" "WorkSessionStatus" NOT NULL DEFAULT 'ACTIVE',
    "pay_per_minute" DECIMAL(65,30) NOT NULL,
    "earned_money" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "earned_exp" INTEGER NOT NULL DEFAULT 0,
    "health_drain" INTEGER NOT NULL DEFAULT 0,
    "fatigue_gained" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "work_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "businesses" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" "BusinessCategory" NOT NULL,
    "model_type" TEXT NOT NULL,
    "level" INTEGER NOT NULL DEFAULT 1,
    "treasury" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "employee_capacity" INTEGER NOT NULL DEFAULT 5,
    "production_units_per_hour" DECIMAL(65,30) NOT NULL DEFAULT 10,
    "operating_cost_per_minute" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "base_revenue_per_minute" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "status" "BusinessStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "businesses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "business_employees" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "player_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "salary_per_minute" DECIMAL(65,30) NOT NULL,
    "unpaid_salary" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "hired_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "business_employees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_postings" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "required_skill" TEXT,
    "required_degree" "DegreeLevel" NOT NULL DEFAULT 'DIPLOMA',
    "required_field" TEXT,
    "min_experience" INTEGER NOT NULL DEFAULT 0,
    "salary_per_minute" DECIMAL(65,30) NOT NULL,
    "capacity" INTEGER NOT NULL DEFAULT 1,
    "status" "JobPostingStatus" NOT NULL DEFAULT 'OPEN',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_postings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_applications" (
    "id" TEXT NOT NULL,
    "job_posting_id" TEXT NOT NULL,
    "player_id" TEXT NOT NULL,
    "status" "JobApplicationStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "financial_transactions" (
    "id" TEXT NOT NULL,
    "amount" DECIMAL(65,30) NOT NULL,
    "type" "TransactionType" NOT NULL,
    "reference" TEXT,
    "source_player_id" TEXT,
    "destination_player_id" TEXT,
    "source_business_id" TEXT,
    "destination_business_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "financial_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "players_telegram_user_id_key" ON "players"("telegram_user_id");

-- CreateIndex
CREATE INDEX "players_telegram_user_id_idx" ON "players"("telegram_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "groups_telegram_group_id_key" ON "groups"("telegram_group_id");

-- CreateIndex
CREATE INDEX "groups_telegram_group_id_idx" ON "groups"("telegram_group_id");

-- CreateIndex
CREATE INDEX "player_groups_group_id_idx" ON "player_groups"("group_id");

-- CreateIndex
CREATE INDEX "player_groups_player_id_idx" ON "player_groups"("player_id");

-- CreateIndex
CREATE UNIQUE INDEX "player_groups_player_id_group_id_key" ON "player_groups"("player_id", "group_id");

-- CreateIndex
CREATE UNIQUE INDEX "occupations_name_key" ON "occupations"("name");

-- CreateIndex
CREATE INDEX "occupations_name_idx" ON "occupations"("name");

-- CreateIndex
CREATE UNIQUE INDEX "skills_name_key" ON "skills"("name");

-- CreateIndex
CREATE INDEX "skills_name_idx" ON "skills"("name");

-- CreateIndex
CREATE INDEX "player_skills_skill_id_idx" ON "player_skills"("skill_id");

-- CreateIndex
CREATE INDEX "player_skills_player_id_idx" ON "player_skills"("player_id");

-- CreateIndex
CREATE UNIQUE INDEX "player_skills_player_id_skill_id_key" ON "player_skills"("player_id", "skill_id");

-- CreateIndex
CREATE INDEX "relationships_related_player_id_idx" ON "relationships"("related_player_id");

-- CreateIndex
CREATE INDEX "relationships_player_id_idx" ON "relationships"("player_id");

-- CreateIndex
CREATE UNIQUE INDEX "relationships_player_id_related_player_id_type_key" ON "relationships"("player_id", "related_player_id", "type");

-- CreateIndex
CREATE INDEX "notifications_player_id_idx" ON "notifications"("player_id");

-- CreateIndex
CREATE INDEX "notifications_status_idx" ON "notifications"("status");

-- CreateIndex
CREATE UNIQUE INDEX "user_states_telegram_user_id_key" ON "user_states"("telegram_user_id");

-- CreateIndex
CREATE INDEX "user_states_telegram_user_id_idx" ON "user_states"("telegram_user_id");

-- CreateIndex
CREATE INDEX "user_states_pending_since_idx" ON "user_states"("pending_since");

-- CreateIndex
CREATE INDEX "properties_owner_id_idx" ON "properties"("owner_id");

-- CreateIndex
CREATE INDEX "properties_status_idx" ON "properties"("status");

-- CreateIndex
CREATE INDEX "rental_contracts_tenant_id_idx" ON "rental_contracts"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "bank_accounts_card_number_key" ON "bank_accounts"("card_number");

-- CreateIndex
CREATE INDEX "bank_accounts_player_id_idx" ON "bank_accounts"("player_id");

-- CreateIndex
CREATE INDEX "loans_player_id_status_idx" ON "loans"("player_id", "status");

-- CreateIndex
CREATE INDEX "elections_group_id_status_idx" ON "elections"("group_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "votes_election_id_voter_id_key" ON "votes"("election_id", "voter_id");

-- CreateIndex
CREATE INDEX "work_sessions_player_id_status_idx" ON "work_sessions"("player_id", "status");

-- CreateIndex
CREATE INDEX "businesses_owner_id_idx" ON "businesses"("owner_id");

-- CreateIndex
CREATE INDEX "business_employees_player_id_idx" ON "business_employees"("player_id");

-- CreateIndex
CREATE UNIQUE INDEX "business_employees_business_id_player_id_key" ON "business_employees"("business_id", "player_id");

-- CreateIndex
CREATE INDEX "job_postings_business_id_status_idx" ON "job_postings"("business_id", "status");

-- CreateIndex
CREATE INDEX "job_applications_player_id_idx" ON "job_applications"("player_id");

-- CreateIndex
CREATE UNIQUE INDEX "job_applications_job_posting_id_player_id_key" ON "job_applications"("job_posting_id", "player_id");

-- CreateIndex
CREATE INDEX "financial_transactions_source_player_id_idx" ON "financial_transactions"("source_player_id");

-- CreateIndex
CREATE INDEX "financial_transactions_destination_player_id_idx" ON "financial_transactions"("destination_player_id");

-- CreateIndex
CREATE INDEX "financial_transactions_source_business_id_idx" ON "financial_transactions"("source_business_id");

-- CreateIndex
CREATE INDEX "financial_transactions_destination_business_id_idx" ON "financial_transactions"("destination_business_id");

-- AddForeignKey
ALTER TABLE "players" ADD CONSTRAINT "players_occupation_id_fkey" FOREIGN KEY ("occupation_id") REFERENCES "occupations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "players" ADD CONSTRAINT "players_home_group_id_fkey" FOREIGN KEY ("home_group_id") REFERENCES "groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_groups" ADD CONSTRAINT "player_groups_player_id_fkey" FOREIGN KEY ("player_id") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_groups" ADD CONSTRAINT "player_groups_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_skills" ADD CONSTRAINT "player_skills_player_id_fkey" FOREIGN KEY ("player_id") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_skills" ADD CONSTRAINT "player_skills_skill_id_fkey" FOREIGN KEY ("skill_id") REFERENCES "skills"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_player_id_fkey" FOREIGN KEY ("player_id") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_related_player_id_fkey" FOREIGN KEY ("related_player_id") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_player_id_fkey" FOREIGN KEY ("player_id") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "properties" ADD CONSTRAINT "properties_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "players"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "properties" ADD CONSTRAINT "properties_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rental_contracts" ADD CONSTRAINT "rental_contracts_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rental_contracts" ADD CONSTRAINT "rental_contracts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_player_id_fkey" FOREIGN KEY ("player_id") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loans" ADD CONSTRAINT "loans_player_id_fkey" FOREIGN KEY ("player_id") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loans" ADD CONSTRAINT "loans_collateral_property_id_fkey" FOREIGN KEY ("collateral_property_id") REFERENCES "properties"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loans" ADD CONSTRAINT "loans_collateral_business_id_fkey" FOREIGN KEY ("collateral_business_id") REFERENCES "businesses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "elections" ADD CONSTRAINT "elections_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "votes" ADD CONSTRAINT "votes_election_id_fkey" FOREIGN KEY ("election_id") REFERENCES "elections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "votes" ADD CONSTRAINT "votes_voter_id_fkey" FOREIGN KEY ("voter_id") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_sessions" ADD CONSTRAINT "work_sessions_player_id_fkey" FOREIGN KEY ("player_id") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_sessions" ADD CONSTRAINT "work_sessions_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "businesses" ADD CONSTRAINT "businesses_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_employees" ADD CONSTRAINT "business_employees_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_employees" ADD CONSTRAINT "business_employees_player_id_fkey" FOREIGN KEY ("player_id") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_postings" ADD CONSTRAINT "job_postings_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_applications" ADD CONSTRAINT "job_applications_job_posting_id_fkey" FOREIGN KEY ("job_posting_id") REFERENCES "job_postings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_applications" ADD CONSTRAINT "job_applications_player_id_fkey" FOREIGN KEY ("player_id") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_transactions" ADD CONSTRAINT "financial_transactions_source_player_id_fkey" FOREIGN KEY ("source_player_id") REFERENCES "players"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_transactions" ADD CONSTRAINT "financial_transactions_destination_player_id_fkey" FOREIGN KEY ("destination_player_id") REFERENCES "players"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_transactions" ADD CONSTRAINT "financial_transactions_source_business_id_fkey" FOREIGN KEY ("source_business_id") REFERENCES "businesses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_transactions" ADD CONSTRAINT "financial_transactions_destination_business_id_fkey" FOREIGN KEY ("destination_business_id") REFERENCES "businesses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

