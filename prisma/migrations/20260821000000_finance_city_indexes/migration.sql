-- CreateIndex
CREATE INDEX "financial_transactions_destination_player_id_type_idx" ON "financial_transactions"("destination_player_id", "type");

-- CreateIndex
CREATE INDEX "financial_transactions_source_player_id_created_at_idx" ON "financial_transactions"("source_player_id", "created_at");

-- CreateIndex
CREATE INDEX "financial_transactions_destination_player_id_created_at_idx" ON "financial_transactions"("destination_player_id", "created_at");

-- CreateIndex
CREATE INDEX "players_occupation_id_idx" ON "players"("occupation_id");

-- CreateIndex
CREATE INDEX "players_status_idx" ON "players"("status");

-- CreateIndex
CREATE INDEX "player_inventory_player_id_quantity_idx" ON "player_inventory"("player_id", "quantity");