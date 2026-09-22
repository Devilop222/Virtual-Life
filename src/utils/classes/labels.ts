import {
  BusinessStatus,
  JobApplicationStatus,
  JobPostingStatus,
  LoanStatus,
  PlayerActivityState,
  PlayerStatus,
  PropertyStatus,
  WorkSessionStatus
} from '@prisma/client'

/**
 * برچسب‌های فارسی برای نمایش در رابط کاربری.
 * هیچ enum یا کلید انگلیسی نباید مستقیم به کاربر نشان داده شود.
 */

export const activityStateLabels: Record<PlayerActivityState, string> = {
  IDLE: 'آزاد',
  WORKING: 'مشغول کار',
  STUDYING: 'مشغول تحصیل',
  RESTING: 'در حال استراحت',
  SLEEPING: 'در خواب',
  TRAVELING: 'در سفر'
}

export const playerStatusLabels: Record<PlayerStatus, string> = {
  ACTIVE: 'فعال',
  INACTIVE: 'غیرفعال',
  DEAD: 'فوت‌شده',
  BANNED: 'محروم'
}

export const loanStatusLabels: Record<LoanStatus, string> = {
  ACTIVE: 'در جریان',
  PAID: 'تسویه‌شده',
  DEFAULTED: 'معوق',
  CLOSED: 'بسته‌شده'
}

export const propertyStatusLabels: Record<PropertyStatus, string> = {
  AVAILABLE: 'آمادهٔ فروش',
  OWNED: 'ملکی',
  RENTED: 'اجاره‌ای'
}

export const businessStatusLabels: Record<BusinessStatus, string> = {
  ACTIVE: 'فعال',
  BANKRUPT: 'ورشکسته',
  CLOSED: 'تعطیل'
}

export const workSessionStatusLabels: Record<WorkSessionStatus, string> = {
  ACTIVE: 'در جریان',
  COMPLETED: 'پایان‌یافته',
  CANCELLED: 'لغوشده'
}

export const jobPostingStatusLabels: Record<JobPostingStatus, string> = {
  OPEN: 'باز',
  CLOSED: 'بسته'
}

export const jobApplicationStatusLabels: Record<JobApplicationStatus, string> = {
  PENDING: 'در انتظار بررسی',
  ACCEPTED: 'پذیرفته‌شده',
  REJECTED: 'رد‌شده',
  CANCELLED: 'لغوشده'
}

/** برچسب فارسی با بازگشت ایمن؛ اگر کلید ناشناخته بود، متن جایگزین امن برمی‌گرداند. */
export function label<T extends string>(
  map: Record<string, string>,
  key: T | null | undefined,
  fallback = 'نامشخص'
): string {
  if (!key) return fallback
  return map[key] ?? fallback
}
