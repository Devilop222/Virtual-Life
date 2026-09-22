/**
 * درگاهِ باریکِ دیتابیس برای قابلیت‌های عملیاتی (وضعیت سیستم، بکاپ، بازیابی).
 *
 * ## چرا یک واسط و نه `prisma` مستقیم؟
 * این محیط PostgreSQL ندارد. اگر سرویس‌های عملیاتی مستقیم به `PrismaClient`
 * چسبیده باشند، هیچ‌چیز جز «تایپ‌چک می‌شود» قابل اثبات نیست و کلِ منطقِ حساس
 * (ترتیبِ کلیدهای خارجی، شمارشِ ردیف‌ها، اعتبارسنجیِ پیش از بازیابی) بدون
 * آزمون می‌ماند. با این واسط، خط لولهٔ کامل در آزمون با یک دیتابیسِ جعلی
 * اجرا می‌شود و همان SQLِ تولیدشده هم قابل بازبینی است.
 *
 * عمداً کوچک نگه داشته شده: فقط سه عملیات. هیچ منطق دامنه‌ای این‌جا نیست.
 */
import type { PrismaClient } from '@prisma/client'

export interface OpsDatabase {
  /** پرس‌وجوی خواندنی؛ آرایهٔ ردیف‌ها را برمی‌گرداند. */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>
  /** نوشتار/DDL؛ تعدادِ ردیف‌های اثرگرفته. */
  execute(sql: string, params?: unknown[]): Promise<number>
  /**
   * اجرای چند عملیات در **یک** تراکنش روی **یک** اتصال.
   *
   * یک اتصال بودنْ حیاتی است، نه فقط اتمیک بودن: بازیابی داخل تراکنش
   * `SET LOCAL session_replication_role` می‌زند که یک تنظیمِ *نشستی* است.
   * اگر دستورها روی اتصال‌های مختلفِ استخر پخش شوند، آن تنظیم روی بقیه اثر
   * نمی‌کند و کلیدهای خارجی وسطِ بازیابی می‌شکنند. Prisma تراکنشِ تعاملی را
   * به یک اتصال گره می‌زند، پس این قرارداد برقرار است.
   */
  transaction<T>(fn: (tx: OpsDatabase) => Promise<T>): Promise<T>
}

/** پیاده‌سازیِ واقعی روی Prisma. */
export class PrismaOpsDatabase implements OpsDatabase {
  constructor(private readonly client: PrismaClient) {}

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await this.client.$queryRawUnsafe(sql, ...params)) as T[]
  }

  async execute(sql: string, params: unknown[] = []): Promise<number> {
    return this.client.$executeRawUnsafe(sql, ...params)
  }

  async transaction<T>(fn: (tx: OpsDatabase) => Promise<T>): Promise<T> {
    return this.client.$transaction(async (tx) => {
      const wrapped: OpsDatabase = {
        query: async <R = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
          (await tx.$queryRawUnsafe(sql, ...params)) as R[],
        execute: (sql: string, params: unknown[] = []) => tx.$executeRawUnsafe(sql, ...params),
        // تراکنشِ تودرتو معنا ندارد؛ همان بافت جاری ادامه می‌یابد.
        transaction: (inner) => inner(wrapped)
      }
      return fn(wrapped)
    })
  }
}

/**
 * نقل‌قولِ شناسه (نام جدول/ستون) برای SQL.
 *
 * هیچ‌جای این ماژول نامِ جدول از ورودیِ کاربر نمی‌آید — از کاتالوگِ خودِ
 * PostgreSQL می‌آید. ولی نقل‌قول در هر حال اجباری است: نامِ جدول‌ها snake_case
 * و بعضاً مشابه کلماتِ رزرو نیستند، اما نبودِ نقل‌قول یک اشتباهِ خاموش است و
 * روزی که جدولی با نامِ حساس اضافه شود، بی‌هیچ هشداری می‌شکند.
 * دو برابر کردنِ کوتیشن، تزریق از طریق نام را هم بی‌اثر می‌کند.
 */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}
