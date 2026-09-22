import { readdirSync } from 'fs'
import { join } from 'path'

/**
 * همهٔ فایل‌های `.ts` یک درخت، به‌صورت بازگشتی.
 *
 * چند تستِ «اینورینت» باید کل سورس را بگردند؛ این تابع یک‌جا زندگی می‌کند تا
 * هر تست پیمایشِ مخصوص خودش را نسازد و مسیرِ دایرکتوری هم یک‌جا عوض شود.
 */
export function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      sourceFiles(full, acc)
    } else if (entry.name.endsWith('.ts')) {
      acc.push(full)
    }
  }
  return acc
}
