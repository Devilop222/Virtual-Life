-- CreateTable
CREATE TABLE "job_capacities" (
    "job_key" TEXT NOT NULL,
    "capacity" INTEGER NOT NULL DEFAULT 0,
    "occupied" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_capacities_pkey" PRIMARY KEY ("job_key")
);

-- CreateTable
CREATE TABLE "admin_logs" (
    "id" TEXT NOT NULL,
    "actor_user_id" BIGINT NOT NULL,
    "action" TEXT NOT NULL,
    "target_user_id" BIGINT,
    "details" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_logs_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "groups" ADD COLUMN "owner_telegram_user_id" BIGINT;

-- CreateIndex
CREATE INDEX "admin_logs_actor_user_id_idx" ON "admin_logs"("actor_user_id");

-- CreateIndex
CREATE INDEX "admin_logs_target_user_id_idx" ON "admin_logs"("target_user_id");