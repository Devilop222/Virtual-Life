-- AlterEnum
ALTER TYPE "GameEventType" ADD VALUE 'PAYROLL_SETTLED';
ALTER TYPE "GameEventType" ADD VALUE 'PAYROLL_DEBT';

-- AlterTable
ALTER TABLE "businesses" ADD COLUMN "last_payroll_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "businesses" ADD COLUMN "total_revenue" DECIMAL(65,30) NOT NULL DEFAULT 0;
ALTER TABLE "businesses" ADD COLUMN "total_payroll" DECIMAL(65,30) NOT NULL DEFAULT 0;
ALTER TABLE "businesses" ADD COLUMN "total_operating_cost" DECIMAL(65,30) NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "businesses_status_last_payroll_at_idx" ON "businesses"("status", "last_payroll_at");