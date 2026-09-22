-- فرسودگیِ طبیعیِ بدن: ستونِ مبدأ زمانِ فرسودگی روی جدول بازیکنان.
--
-- مقدار پیش‌فرضِ `CURRENT_TIMESTAMP` عمدی است: بازیکنانِ موجود از لحظهٔ
-- اجرای مهاجرت فرسودگی‌شان شمرده می‌شود، نه از «شروع زندگی»؛ وگرنه هر
-- بازیکنِ قدیمی در نخستین تماس، چند ده واحد سلامت را یک‌جا از دست می‌داد.

ALTER TABLE "players" ADD COLUMN "health_synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX "players_status_health_synced_at_idx" ON "players"("status", "health_synced_at");
