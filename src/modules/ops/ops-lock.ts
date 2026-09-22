/**
 * قفلِ فایلیِ فرآیندی — یک پیاده‌سازی برای همهٔ عملیات‌های سنگینِ سرور.
 *
 * ## چرا فایل و نه متغیرِ درون‌حافظه؟
 * عملیاتِ سنگین (استقرار، بکاپ، بازیابی) عمداً **detached** اجرا می‌شوند تا
 * مرگِ خودِ ربات وسطِ کار، سرور را نیمه‌کاره رها نکند. یعنی کار در فرآیندی
 * دیگر ادامه می‌یابد و ربات ممکن است وسطِ آن ری‌استارت شود. قفلِ
 * درون‌حافظه‌ای با ری‌استارت پاک می‌شود و راهِ اجرای دوم را باز می‌کند؛
 * قفلِ فایلی می‌ماند. (این درس از پیاده‌سازیِ استقرار گرفته شده است.)
 *
 * ## چرا یک کلاس و نه دو کپی؟
 * پیش‌تر استقرار منطقِ قفل را درونِ خود داشت. عملیاتِ عملیاتیِ تازه هم به
 * همان رفتار نیاز دارد و **دو** عملیات نباید هم‌زمان دیتابیس را دست بزنند:
 * بازیابی وسطِ یک استقرار یعنی دیتابیسِ نیمه‌بازیابی‌شده روی کدِ نیمه‌جدید.
 * قفلِ تکراری یعنی دو منبعِ حقیقت؛ پس هر دو از همین کلاس استفاده می‌کنند و
 * می‌توانند قفلِ یکدیگر را هم *ببینند*.
 *
 * ## قرارداد
 *  • ساخت با `wx` — **اتمیِ انحصاری**. بین دو درخواستِ موازی فقط یکی برنده است.
 *  • قفلِ رهاشده (crash) با سنِ فایل تشخیص داده می‌شود و خودش باز می‌شود.
 *  • آزادسازیِ ناموفق هیچ‌وقت استثنا پرتاب نمی‌کند؛ قفلِ رهاشده خودش منقضی می‌شود.
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'

/** پوشهٔ حالتِ زمان اجرا (در `.gitignore` است). */
export function toolsDir(repoRoot: string): string {
  return join(repoRoot, '.tools')
}

/** قفلِ استقرار — تنها یک به‌روزرسانی هم‌زمان. */
export function updateLockPath(repoRoot: string): string {
  return join(toolsDir(repoRoot), 'update.lock')
}

/** قفلِ عملیاتِ عملیاتی (بکاپ/بازیابی). */
export function opsLockPath(repoRoot: string): string {
  return join(toolsDir(repoRoot), 'ops.lock')
}

/**
 * لاگِ فرآیندِ ربات — همان فایلی که `install.sh` با `nohup ... >> bot.log` می‌نویسد.
 * نامش این‌جا تکرار می‌شود چون قراردادِ مشترکِ bash و Node است؛ عوض‌کردنش
 * باید در هر دو جا هم‌زمان انجام شود.
 */
export function botLogPath(repoRoot: string): string {
  return join(toolsDir(repoRoot), 'bot.log')
}

/** اطلاعاتی که داخلِ فایلِ قفل نوشته می‌شود — برای عیب‌یابیِ قفلِ رهاشده. */
export interface LockInfo {
  pid: number | null
  at: string | null
}

export class FileLock {
  private readonly path: string
  private readonly staleMs: number

  constructor(path: string, staleMs: number) {
    this.path = path
    this.staleMs = staleMs
  }

  filePath(): string {
    return this.path
  }

  /**
   * گرفتنِ قفل. `true` یعنی برنده شدیم.
   *
   * ترتیب عمدی است: اول تلاشِ ساختِ اتمی، و **فقط** اگر فایل از قبل بود
   * سنش سنجیده می‌شود. اگر اول سن را بخوانیم و بعد بسازیم، بین آن دو یک
   * پنجرهٔ مسابقه باز می‌شود که در آن دو فرآیند هم‌زمان برنده می‌شوند.
   */
  tryAcquire(): boolean {
    if (this.write()) {
      return true
    }
    if (this.ageMs() > this.staleMs) {
      this.release()
      return this.write()
    }
    return false
  }

  /** آیا قفل **زنده** است؟ قفلِ کهنه «گرفته‌شده» شمرده نمی‌شود. */
  isHeld(): boolean {
    if (!existsSync(this.path)) {
      return false
    }
    return this.ageMs() <= this.staleMs
  }

  /** آزادسازی — هرگز پرتاب نمی‌کند. */
  release(): void {
    try {
      if (existsSync(this.path)) {
        unlinkSync(this.path)
      }
    } catch {
      // آزادسازیِ ناموفق نباید درخواست را بشکند؛ قفلِ رهاشده با سنِ فایل
      // تشخیص داده می‌شود و خودش منقضی می‌گردد.
    }
  }

  /** چه کسی و کِی قفل را گرفت؟ (برای گزارشِ وضعیت؛ رازی در آن نیست.) */
  info(): LockInfo {
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as { pid?: unknown; at?: unknown }
      return {
        pid: typeof parsed.pid === 'number' ? parsed.pid : null,
        at: typeof parsed.at === 'string' ? parsed.at : null
      }
    } catch {
      return { pid: null, at: null }
    }
  }

  private write(): boolean {
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      const fd = openSync(this.path, 'wx')
      writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }))
      closeSync(fd)
      return true
    } catch {
      return false
    }
  }

  private ageMs(): number {
    try {
      return Date.now() - statSync(this.path).mtimeMs
    } catch {
      // فایل خوانده نشد → نامعلوم. `+∞` یعنی «بسیار کهنه» و اجازهٔ تلاشِ دوباره
      // می‌دهد؛ بلوکه‌شدنِ همیشگی به‌خاطر یک خطای خواندن، بدتر از دو اجرا نیست
      // ولی در عمل فایلِ ناخوانا یعنی قفلِ شکسته.
      return Number.POSITIVE_INFINITY
    }
  }
}
