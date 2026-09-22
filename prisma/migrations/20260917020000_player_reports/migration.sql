-- ═══════════════════════════════════════════════════════════
-- گزارش بازیکن به پشتیبانی.
--
-- چرا؟ بازیکن هیچ راهِ رسمی برای رساندنِ مشکل به ادمین نداشت؛ ایرادها فقط
-- شفاهی در گروه گفته می‌شدند، هیچ سابقه‌ای نمی‌ماند و همان اشکال دوباره
-- گزارش و دوباره کشف می‌شد. این جدول همان مسیر را ماندگار و قابلِ‌پاسخ
-- می‌کند.
--
-- مهاجرت افزودنی است: فقط دو نوعِ تازه و یک جدولِ تازه می‌سازد و هیچ جدول
-- یا ستونِ موجودی را تغییر نمی‌دهد.
-- ═══════════════════════════════════════════════════════════

CREATE TYPE "PlayerReportCategory" AS ENUM ('BUG', 'MONEY', 'BEHAVIOR', 'OTHER');
CREATE TYPE "PlayerReportStatus" AS ENUM ('OPEN', 'ANSWERED', 'CLOSED');

CREATE TABLE "player_reports" (
    "id" TEXT NOT NULL,
    "player_id" TEXT NOT NULL,
    "category" "PlayerReportCategory" NOT NULL DEFAULT 'OTHER',
    "body" TEXT NOT NULL,
    "section" TEXT,
    "status" "PlayerReportStatus" NOT NULL DEFAULT 'OPEN',
    "answer" TEXT,
    "answered_by" BIGINT,
    "answered_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "player_reports_pkey" PRIMARY KEY ("id")
);

-- صفِ ادمین همیشه «بازها به ترتیب زمان» است؛ همین ایندکس همان را می‌پوشاند.
CREATE INDEX "player_reports_status_created_at_idx" ON "player_reports"("status", "created_at");
-- بازیکن هم تاریخچهٔ گزارش‌های خودش را با همین ایندکس می‌خواند.
CREATE INDEX "player_reports_player_id_created_at_idx" ON "player_reports"("player_id", "created_at");

ALTER TABLE "player_reports"
    ADD CONSTRAINT "player_reports_player_id_fkey"
    FOREIGN KEY ("player_id") REFERENCES "players"("id") ON DELETE CASCADE ON UPDATE CASCADE;
