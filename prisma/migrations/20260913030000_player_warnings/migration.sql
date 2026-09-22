-- CreateTable
CREATE TABLE "player_warnings" (
    "id" TEXT NOT NULL,
    "player_id" TEXT NOT NULL,
    "issued_by" BIGINT NOT NULL,
    "reason" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "caused_ban" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "player_warnings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "player_warnings_player_id_is_active_idx" ON "player_warnings"("player_id", "is_active");

-- CreateIndex
CREATE INDEX "player_warnings_issued_by_idx" ON "player_warnings"("issued_by");

-- AddForeignKey
ALTER TABLE "player_warnings" ADD CONSTRAINT "player_warnings_player_id_fkey" FOREIGN KEY ("player_id") REFERENCES "players"("id") ON DELETE CASCADE ON UPDATE CASCADE;
