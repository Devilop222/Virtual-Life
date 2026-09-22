import { z } from 'zod'
import { Gender } from '@prisma/client'

export const biographySchema = z
  .string()
  .trim()
  .min(3, 'very_short')
  .max(600, 'too_long')

export const telegramTextSchema = z
  .string()
  .trim()
  .max(4096, 'too_long')

export const genderSchema = z.enum([Gender.MALE, Gender.FEMALE])

export const safeCallbackSchema = z
  .string()
  .min(1, 'too_short')
  .max(128, 'too_long')
  .regex(/^[a-z0-9:_-]+$/i, 'invalid_format')

export const percentSchema = z.number().int().min(0).max(100)

export const nonNegativeMoneySchema = z.number().nonnegative()

export type BiographyResult = z.infer<typeof biographySchema>

/**
 * پاک‌سازی متن آزاد ورودی کاربر (نام، بیوگرافی، نام حیوان، متن آگهی و مانند آن).
 * نویسه‌های مارک‌داون حذف می‌شوند تا متن در پنل‌ها (که با parse_mode مارک‌داون
 * فرستاده می‌شوند) هرگز باعث خطای «can't parse entities» نشود.
 */
export function plainInput(value: string): string {
  return value.replace(/[*_`[\]~]/g, '').replace(/[<>]/g, '').trim()
}