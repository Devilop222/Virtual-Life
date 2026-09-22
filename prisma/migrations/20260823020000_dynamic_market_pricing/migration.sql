-- AlterTable
ALTER TABLE "shop_items" ADD COLUMN "price_multiplier" DECIMAL(65,30) NOT NULL DEFAULT 1;
ALTER TABLE "shop_items" ADD COLUMN "previous_multiplier" DECIMAL(65,30) NOT NULL DEFAULT 1;
ALTER TABLE "shop_items" ADD COLUMN "purchase_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "shop_items" ADD COLUMN "recent_purchases" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "shop_items" ADD COLUMN "last_price_update_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateIndex
CREATE INDEX "shop_items_active_last_price_update_at_idx" ON "shop_items"("active", "last_price_update_at");