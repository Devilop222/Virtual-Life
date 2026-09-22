-- ═══════════════════════════════════════════════════════════
-- Admin: فهرست ادمین‌های ربات در دیتابیس (منبع حقیقت دسترسی)
--
-- پیش‌تر دسترسی مدیریت فقط از ADMIN_USER_IDS می‌آمد و افزودن/حذف ادمین
-- نیازمند Redeploy بود. حالا ادمین‌ها ردیف دیتابیس هستند و حذف یک ردیف
-- هیچ داده‌ای از جدول players پاک نمی‌کند (عمداً بدون FK).
-- ═══════════════════════════════════════════════════════════

CREATE TYPE "BotAdminRole" AS ENUM ('OWNER', 'ADMIN');

CREATE TABLE "bot_admins" (
    "id" TEXT NOT NULL,
    "telegram_user_id" BIGINT NOT NULL,
    "first_name" TEXT,
    "username" TEXT,
    "role" "BotAdminRole" NOT NULL DEFAULT 'ADMIN',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "granted_by" BIGINT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bot_admins_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "bot_admins_telegram_user_id_key" ON "bot_admins"("telegram_user_id");
CREATE INDEX "bot_admins_is_active_idx" ON "bot_admins"("is_active");

-- فهرست اقدامات ادمین صفحه‌به‌صفحه و بر پایهٔ زمان خوانده می‌شود
CREATE INDEX IF NOT EXISTS "admin_logs_actor_user_id_created_at_idx" ON "admin_logs"("actor_user_id", "created_at");
CREATE INDEX IF NOT EXISTS "admin_logs_created_at_idx" ON "admin_logs"("created_at");

-- ادمین‌های اولیهٔ ربات؛ شناسهٔ ثابت تا مهاجرت چندبار اجراشدنی بماند
INSERT INTO "bot_admins" ("id", "telegram_user_id", "role", "is_active", "created_at", "updated_at")
VALUES
  ('bootstrap-owner', 6910416744, 'OWNER', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('bootstrap-admin', 8369939024, 'ADMIN', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("telegram_user_id") DO NOTHING;
