/**
 * طبقه‌بندیِ رویدادهای خطای Prisma برای لاگ.
 *
 * چرا این فایل؟ چند مسیرِ بازی *عمداً* به نقضِ یکتایی تکیه می‌کنند و همان‌جا
 * هم اداره‌اش می‌کنند: کلید `dedupeKey` برای اعلان و رخداد، حساب بانکیِ یکتا
 * برای هر بازیکن، وام فعالِ یکتا، ثبت گروه. در این مسیرها `P2002` یعنی
 * «رقابتِ همزمان درست مهار شد» — نه یک خطا. نوشتنش با سطح `error` دو ضرر
 * دارد: هشدارِ بی‌مورد در لاگِ عملیاتی، و پنهان‌شدنِ خطاهای واقعی میانِ آن‌ها.
 *
 * فقط و فقط نقضِ یکتایی پایین می‌آید؛ هر خطای دیگری (اتصال، محدودیتِ کلید
 * خارجی، رکوردِ لازمِ پیدا نشده) همان `error` می‌ماند.
 */
export type PrismaLogSeverity = 'warn' | 'error'

/** نشانه‌های «تکراری نوشتن، عمداً رد شد» در پیامِ Prisma. */
const EXPECTED_UNIQUE_REFUSAL = [/Unique constraint failed/i, /\bP2002\b/]

export function prismaLogSeverity(message: string): PrismaLogSeverity {
  return EXPECTED_UNIQUE_REFUSAL.some((pattern) => pattern.test(message)) ? 'warn' : 'error'
}

/** پیامِ آمادهٔ لاگ برای هر سطح؛ کوتاه و بدون اصطلاحِ فنیِ گیج‌کننده. */
export function prismaLogMessage(severity: PrismaLogSeverity): string {
  return severity === 'warn'
    ? 'prisma: a duplicate write was refused by the database (idempotency guard)'
    : 'prisma error'
}
