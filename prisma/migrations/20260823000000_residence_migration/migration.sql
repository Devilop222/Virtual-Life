-- CreateEnum
CREATE TYPE "MigrationReason" AS ENUM ('FIRST_SETTLEMENT', 'VOLUNTARY', 'ADMIN_ACTION');

-- AlterEnum
ALTER TYPE "GameEventType" ADD VALUE 'RESIDENCE_ESTABLISHED';
ALTER TYPE "GameEventType" ADD VALUE 'RESIDENCE_MIGRATED';
ALTER TYPE "GameEventType" ADD VALUE 'PLAYER_TRAVELED';

-- AlterTable
ALTER TABLE "players" ADD COLUMN "residence_since" TIMESTAMP(3);
ALTER TABLE "players" ADD COLUMN "last_migration_at" TIMESTAMP(3);
ALTER TABLE "players" ADD COLUMN "current_region_id" TEXT;
ALTER TABLE "players" ADD COLUMN "last_activity_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "migrations" (
    "id" TEXT NOT NULL,
    "player_id" TEXT NOT NULL,
    "from_group_id" TEXT,
    "to_group_id" TEXT NOT NULL,
    "reason" "MigrationReason" NOT NULL,
    "cost" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "migrations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "migrations_player_id_created_at_idx" ON "migrations"("player_id", "created_at");

-- CreateIndex
CREATE INDEX "migrations_to_group_id_idx" ON "migrations"("to_group_id");

-- CreateIndex
CREATE INDEX "players_home_group_id_idx" ON "players"("home_group_id");

-- AddForeignKey
ALTER TABLE "players" ADD CONSTRAINT "players_current_region_id_fkey" FOREIGN KEY ("current_region_id") REFERENCES "groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "migrations" ADD CONSTRAINT "migrations_player_id_fkey" FOREIGN KEY ("player_id") REFERENCES "players"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "migrations" ADD CONSTRAINT "migrations_from_group_id_fkey" FOREIGN KEY ("from_group_id") REFERENCES "groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "migrations" ADD CONSTRAINT "migrations_to_group_id_fkey" FOREIGN KEY ("to_group_id") REFERENCES "groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;