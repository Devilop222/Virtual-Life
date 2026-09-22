-- ارسالِ درخواست استخدام یک «شروعِ کار» نیست؛ بازیکن در تاریخچهٔ زندگی
-- برچسبِ نادرست می‌دید. نوعِ رخدادِ جداگانه اضافه می‌شود.
ALTER TYPE "GameEventType" ADD VALUE IF NOT EXISTS 'JOB_APPLIED';
