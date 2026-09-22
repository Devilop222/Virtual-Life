import 'dotenv/config'
import { z } from 'zod'

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  BOT_TOKEN: z.string().min(1, 'BOT_TOKEN is required'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  PORT: z.coerce.number().int().positive().default(3000),
  HEALTH_PATH: z.string().default('/health'),
  GAME_START_AGE: z.coerce.number().int().min(0).default(18),
  GAME_MAX_AGE: z.coerce.number().int().max(150).default(120),
  /**
   * فایل‌آیدی استیکر «لحظه‌های مهم» (اختیاری). اگر تنظیم شود، ربات در
   * تولد شخصیت (پایان ثبت‌نام) همان استیکر را می‌فرستد؛ بدون تنظیم،
   * هیچ اثری ندارد. استیکر هرگز نباید مسیر بازی را بشکند.
   */
  MILESTONE_STICKER_FILE_ID: z.string().optional()
})

const parsed = envSchema.safeParse(process.env)

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')
  throw new Error(`Invalid environment configuration:\n${issues}`)
}

export const config = parsed.data
export type Environment = typeof config