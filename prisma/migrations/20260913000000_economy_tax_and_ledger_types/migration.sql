-- ═══════════════════════════════════════════════════════════
-- اقتصاد: انواع تراکنشِ تازه برای مالیات، سود بانکی و پاداش‌ها
--
-- چرا؟ پیش از این چند جریان مالیِ کاملاً متفاوت همگی با یک نوع
-- «TRANSFER» ثبت می‌شدند: خرید فروشگاه (Sink)، پاداش کارت روزانه (پول تازه)،
-- مالیات و فروش بلیت. با یک نوع مشترک، نه دفتر کل قابل ممیزی بود و نه
-- می‌شد فهمید پول از کجا آمده و کجا رفته است. هر مقدار جدید یک جریان
-- مستقل و قابل ردیابی است.
--
-- نکته: `ALTER TYPE ... ADD VALUE` روی PostgreSQL 12+ داخل تراکنش مجاز است
-- (به شرط اینکه در همان تراکنش استفاده نشود) — همان الگویی که مهاجرت‌های
-- قبلی این مخزن هم به کار برده‌اند.
-- ═══════════════════════════════════════════════════════════

ALTER TYPE "TransactionType" ADD VALUE IF NOT EXISTS 'TAX_PAYMENT';
ALTER TYPE "TransactionType" ADD VALUE IF NOT EXISTS 'LOAN_INTEREST';
ALTER TYPE "TransactionType" ADD VALUE IF NOT EXISTS 'DEPOSIT_INTEREST';
ALTER TYPE "TransactionType" ADD VALUE IF NOT EXISTS 'SHOP_PURCHASE';
ALTER TYPE "TransactionType" ADD VALUE IF NOT EXISTS 'REWARD_PAYOUT';
