-- ═══════════════════════════════════════════════════════════
-- صندوق بانک (ترازنامهٔ واقعی بانک)
--
-- چرا؟ پیش از این `disburseLoan` پول وام را «از هیچ» می‌ساخت و سود سپرده هم
-- بدون هیچ منبعی mint می‌شد. حالا بانک یک ردیف ترازنامه دارد:
--   • سپرده‌گذاری بازیکن ⇒ افزایش صندوق
--   • پرداخت وام        ⇒ کاهش صندوق (شرطی؛ اگر کم باشد وام پرداخت نمی‌شود)
--   • بازپرداخت وام     ⇒ افزایش صندوق
--   • سود سپرده/حساب    ⇒ کاهش صندوق (تا سقف موجودی)
-- این جدول فقط یک ردیف دارد و همهٔ نوشتن‌ها از
-- `src/modules/banking/bank-pool.service.ts` می‌گذرد.
-- ═══════════════════════════════════════════════════════════

CREATE TABLE "bank_pool" (
    "id" TEXT NOT NULL DEFAULT 'main',
    "balance" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "total_deposited" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "total_disbursed" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "total_repaid" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "total_loan_interest" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "total_deposit_interest" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bank_pool_pkey" PRIMARY KEY ("id")
);
