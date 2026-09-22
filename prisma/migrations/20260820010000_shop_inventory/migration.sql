-- CreateTable
CREATE TABLE "shop_items" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "price" DECIMAL(65,30) NOT NULL,
    "rarity" TEXT NOT NULL DEFAULT 'common',
    "stock" INTEGER NOT NULL DEFAULT -1,
    "effects" JSONB NOT NULL DEFAULT '{}',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shop_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "player_inventory" (
    "id" TEXT NOT NULL,
    "player_id" TEXT NOT NULL,
    "item_id" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "player_inventory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "shop_items_key_key" ON "shop_items"("key");

-- CreateIndex
CREATE INDEX "shop_items_category_idx" ON "shop_items"("category");

-- CreateIndex
CREATE INDEX "shop_items_active_idx" ON "shop_items"("active");

-- CreateIndex
CREATE INDEX "player_inventory_item_id_idx" ON "player_inventory"("item_id");

-- CreateIndex
CREATE UNIQUE INDEX "player_inventory_player_id_item_id_key" ON "player_inventory"("player_id", "item_id");

-- AddForeignKey
ALTER TABLE "player_inventory" ADD CONSTRAINT "player_inventory_player_id_fkey" FOREIGN KEY ("player_id") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_inventory" ADD CONSTRAINT "player_inventory_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "shop_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;