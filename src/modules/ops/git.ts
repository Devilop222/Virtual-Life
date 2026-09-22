/**
 * اجرای گیت و پارسِ خروجی‌اش — یک پیاده‌سازی برای همهٔ مصرف‌کننده‌ها.
 *
 * ## چرا این‌جا جمع شد؟
 * دو جا گیت را صدا می‌زدند: سرویسِ استقرار و خوانندهٔ وضعیتِ کد. هر دو
 * خروجی را با `.trim()` می‌گرفتند و بعد هر خط را با `slice(3)` می‌بریدند —
 * و همین یک اشتباهِ کوچک یک باگِ واقعی بود:
 *
 *   `git status --porcelain` برای فایلی که فقط در درختِ کاری عوض شده
 *   `" M src/app.ts"` می‌دهد — سه نویسه پیش از مسیر، که **اولی فاصله است**.
 *   `trim()` روی کلِ خروجی، همان فاصلهٔ ابتدایی را برمی‌دارد، پس `slice(3)`
 *   حالا یک نویسه از خودِ نامِ فایل را می‌خورد: `"rc/app.ts"`.
 *
 * پیامدش خطرناک نبود (شمارشِ فایل‌ها درست می‌ماند، پس گاردِ «تغییراتِ محلی
 * هست، خودکار جلو نرو» سالم بود) ولی **نامِ فایل‌ها دروغ** می‌شد — و مالک
 * بر اساس همان نام‌ها تصمیم می‌گیرد چه چیزی را کامیت کند. یک ابزارِ مدیریتی
 * که نامِ اشتباه نشان می‌دهد، اعتماد را از بین می‌برد.
 *
 * پس هر دو مصرف‌کننده از همین‌جا می‌خوانند تا قاعده یک جا اصلاح شود.
 */
import { execFile } from 'child_process'

export interface GitOptions {
  /** مهلتِ فرمان (میلی‌ثانیه). پیش‌فرض ۱۰ ثانیه. */
  timeoutMs?: number
  /**
   * `trim` روی خروجی.
   *
   * پیش‌فرض `true` برای فرمان‌هایی مثل `rev-parse` که یک مقدار می‌دهند.
   * برای `status --porcelain` باید `false` باشد — فاصلهٔ ابتدای خط بخشی از
   * داده است، نه آرایش.
   */
  trim?: boolean
}

/**
 * اجرای گیت بدون امکانِ پرسیدنِ رمز.
 *
 * `GIT_TERMINAL_PROMPT=0` حیاتی است: گیتِ منتظرِ رمز روی سرورِ بی‌اینترنت تا
 * ابد هنگ می‌کند و پنلِ مالک هرگز جواب نمی‌گیرد. `null` یعنی فرمان شکست خورد
 * یا نبود — نه استثنا؛ نبودِ گیت یک وضعیتِ واقعی است، نه خطای برنامه.
 */
export function runGit(repoRoot: string, args: string[], options: GitOptions = {}): Promise<string | null> {
  const { timeoutMs = 10_000, trim = true } = options
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      {
        cwd: repoRoot,
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GIT_ASKPASS: '',
          SSH_ASKPASS: ''
        }
      },
      (error, stdout) => {
        if (error) {
          resolve(null)
          return
        }
        resolve(trim ? stdout.trim() : stdout)
      }
    )
  })
}

/**
 * مسیرِ فایل‌ها از خروجی `git status --porcelain`.
 *
 * قالب: دو نویسهٔ وضعیت + یک فاصله + مسیر. برای تغییرِ نام، گیت
 * `«قدیم -> جدید»` می‌دهد؛ مسیرِ **جدید** چیزی است که روی دیسک وجود دارد و
 * همان چیزی است که مالک باید ببیند.
 */
export function parsePorcelainPaths(output: string): string[] {
  return output
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const rest = line.slice(3)
      const arrow = rest.indexOf(' -> ')
      return (arrow === -1 ? rest : rest.slice(arrow + 4)).trim()
    })
    .filter((path) => path.length > 0)
}
