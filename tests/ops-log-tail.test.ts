/**
 * خواندنِ لاگ و پاک‌سازیِ رازها.
 *
 * دلیلِ وجودِ این آزمون‌ها ساده است: پنلِ لاگ روی تلگرام می‌رود و اسکرین‌شاتِ
 * تلگرام بیرون می‌رود. اگر یک توکن داخلش بماند، توکن لو رفته است. پس هر
 * الگوی رازی که می‌شناسیم یک آزمونِ مثبت دارد، و هرچه ناشناخته بماند باید
 * در سقفِ طول و تعدادِ خط محدود شود تا فرصتِ لو رفتن کوچک بماند.
 */
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { MAX_LOG_LINES, redactSecrets, tailLog } from '../src/modules/ops/log-tail'

describe('پاک‌سازیِ رازها', () => {
  test('نشانیِ اتصالِ دیتابیس پاک می‌شود', () => {
    const line = 'connect failed for postgresql://virtual_life:s3cret@127.0.0.1:5432/virtual_life'
    const safe = redactSecrets(line)
    expect(safe).not.toContain('s3cret')
    expect(safe).not.toContain('5432')
    expect(safe).toContain('پاک')
  })

  test('توکنِ ربات تلگرام پاک می‌شود', () => {
    const token = '123456789:AAF-abcdefghijklmnopqrstuvwxyz012345'
    const safe = redactSecrets(`Bot.start failed with ${token}`)
    expect(safe).not.toContain(token)
    expect(safe).not.toContain('AAF-abcdefghijklmnopqrstuvwxyz012345')
  })

  test('توکنِ گیت‌هاب پاک می‌شود', () => {
    const token = 'ghp_abcdefghijklmnopqrstuvwx0123456789'
    const safe = redactSecrets(`remote origin https://${token}@github.com/x/y`)
    expect(safe).not.toContain(token)
  })

  test('متغیرهای محیطیِ حساس پاک می‌شوند ولی نامشان می‌ماند', () => {
    const safe = redactSecrets('BOT_TOKEN=123:abc  DATABASE_URL=postgresql://u:p@h/d  LOG_LEVEL=info')
    expect(safe).not.toContain('123:abc')
    expect(safe).not.toContain(':p@h/d')
    expect(safe).toContain('BOT_TOKEN')
    expect(safe).toContain('DATABASE_URL')
    // مقدارِ بی‌خطر باید دست‌نخورده بماند تا لاگ هنوز خواندنی باشد
    expect(safe).toContain('LOG_LEVEL=info')
  })

  test('متنِ بی‌خطر دست‌نخورده می‌ماند', () => {
    const line = 'Bot @legacy_bot started in 412ms'
    expect(redactSecrets(line)).toBe(line)
  })
})

describe('دنبالهٔ لاگ', () => {
  test('فایلِ نبود، «موجود نیست» گزارش می‌دهد و استثنا نمی‌سازد', () => {
    const tail = tailLog(join(tmpdir(), 'no-such-log-legacy.log'))
    expect(tail.present).toBe(false)
    expect(tail.lines).toEqual([])
  })

  test('فقط آخرین خطوط برگردانده می‌شوند', () => {
    const dir = mkdtempSync(join(tmpdir(), 'legacy-log-'))
    const path = join(dir, 'bot.log')
    try {
      for (let index = 0; index < 60; index += 1) {
        appendFileSync(path, `line-${index}\n`)
      }
      const tail = tailLog(path, 5)
      expect(tail.lines).toHaveLength(5)
      expect(tail.lines[4]).toBe('line-59')
      expect(tail.truncated).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('لاگِ بزرگ خوانده نمی‌شود بلکه فقط دنباله‌اش خوانده می‌شود', () => {
    const dir = mkdtempSync(join(tmpdir(), 'legacy-log-'))
    const path = join(dir, 'bot.log')
    try {
      // ۲۰۰ کیلوبایت — بیش از سقفِ خواندنِ ۶۴ کیلوبایتی
      writeFileSync(path, `${'x'.repeat(199)}\n`.repeat(1000))
      appendFileSync(path, 'آخرین خط\n')
      const tail = tailLog(path, MAX_LOG_LINES)
      expect(tail.present).toBe(true)
      expect(tail.lines.at(-1)).toBe('آخرین خط')
      // خطِ اولِ بریده نباید نمایش داده شود
      expect(tail.lines.every((line) => line.length <= 161)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('خطِ بسیار بلند کوتاه می‌شود تا پنل از هم نپاشد', () => {
    const dir = mkdtempSync(join(tmpdir(), 'legacy-log-'))
    const path = join(dir, 'bot.log')
    try {
      writeFileSync(path, `${'a'.repeat(5000)}\n`)
      const tail = tailLog(path)
      expect(tail.lines[0]?.length).toBeLessThanOrEqual(161)
      expect(tail.lines[0]?.endsWith('…')).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('رازها پیش از خروجی پاک می‌شوند، نه پس از آن', () => {
    const dir = mkdtempSync(join(tmpdir(), 'legacy-log-'))
    const path = join(dir, 'bot.log')
    try {
      writeFileSync(path, 'DATABASE_URL=postgresql://u:topsecret@127.0.0.1:5432/db\n')
      const tail = tailLog(path)
      expect(tail.lines.join('\n')).not.toContain('topsecret')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
