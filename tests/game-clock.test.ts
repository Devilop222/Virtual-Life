/**
 * ساعت مرکزی بازی — تست‌های قراردادی مدل زمانی.
 *
 * ده سناریوی اصلی مدل زمانی این‌جا قفل می‌شوند تا هیچ تغییری در آینده
 * نتواند بی‌سروصدا تبدیل‌ها را جابه‌جا کند:
 *
 *   ۱ دقیقهٔ واقعی = ۳۰ دقیقهٔ بازی
 *   ۲ دقیقهٔ واقعی = ۱ ساعت بازی
 *   ۴۸ دقیقهٔ واقعی = ۱ روز بازی
 *   ۱ روز واقعی   = ۳۰ روز بازی = ۱ ماه بازی
 *   ۱۲ روز واقعی  = ۱ سال بازی
 */
import {
  GAME_DAYS_PER_MONTH,
  GAME_DAYS_PER_YEAR,
  GAME_MONTHS_PER_YEAR,
  GAME_MINUTES_PER_REAL_MINUTE,
  REAL_DAY_MS,
  REAL_MS_PER_GAME_DAY,
  REAL_MS_PER_GAME_HOUR,
  REAL_MS_PER_GAME_MINUTE,
  REAL_MS_PER_GAME_MONTH,
  REAL_MS_PER_GAME_YEAR,
  cycleAmount,
  cycleRate,
  dayIndex,
  daysUntil,
  formatGameMinutes,
  gameClockLine,
  gameDays,
  gameDaysSince,
  gameHours,
  gameHoursSince,
  gameMinutes,
  gameMoment,
  gameMonths,
  gameYears,
  ratePerGameHour,
  ratePerGameMinute,
  weekIndex,
  worldDay
} from '../src/utils/game-time'

describe('ساعت بازی · تبدیل‌های پایه', () => {
  test('۱ دقیقهٔ واقعی = ۳۰ دقیقهٔ بازی', () => {
    expect(GAME_MINUTES_PER_REAL_MINUTE).toBe(30)
    // یک دقیقهٔ بازی = ۲ ثانیهٔ واقعی؛ پس هر دقیقهٔ واقعی = ۳۰ دقیقهٔ بازی
    expect(gameMinutes(30)).toBe(60_000)
    expect(REAL_MS_PER_GAME_MINUTE).toBe(2_000)
    expect(REAL_MS_PER_GAME_MINUTE * 30).toBe(60_000)
  })

  test('۲ دقیقهٔ واقعی = ۱ ساعت بازی', () => {
    expect(REAL_MS_PER_GAME_HOUR).toBe(2 * 60 * 1000)
  })

  test('۴۸ دقیقهٔ واقعی = ۱ روز بازی', () => {
    expect(REAL_MS_PER_GAME_DAY).toBe(48 * 60 * 1000)
  })

  test('۱ روز واقعی = ۳۰ روز بازی = ۱ ماه بازی', () => {
    expect(REAL_MS_PER_GAME_MONTH).toBe(REAL_DAY_MS)
    expect(GAME_DAYS_PER_MONTH).toBe(30)
  })

  test('۱۲ روز واقعی = ۱ سال بازی (۳۶۰ روز بازی، ۱۲ ماه)', () => {
    expect(REAL_MS_PER_GAME_YEAR).toBe(12 * REAL_DAY_MS)
    expect(GAME_DAYS_PER_YEAR).toBe(360)
    expect(GAME_MONTHS_PER_YEAR).toBe(12)
  })
})

describe('ساعت بازی · مدت‌ها و زمان سپری‌شده', () => {
  test('هر واحد مدت، درست به میلی‌ثانیهٔ واقعی تبدیل می‌شود', () => {
    expect(gameHours(1)).toBe(2 * 60 * 1000)
    expect(gameDays(1)).toBe(48 * 60 * 1000)
    expect(gameDays(30)).toBe(REAL_DAY_MS)
    expect(gameMonths(1)).toBe(REAL_DAY_MS)
    expect(gameYears(1)).toBe(12 * REAL_DAY_MS)
  })

  test('زمان سپری‌شده بر حسب واحدهای بازی شمرده می‌شود', () => {
    const tenRealMinutesAgo = new Date(Date.now() - 10 * 60 * 1000)
    expect(gameMinutesSinceForTest(tenRealMinutesAgo)).toBeGreaterThanOrEqual(299)
    expect(gameMinutesSinceForTest(tenRealMinutesAgo)).toBeLessThanOrEqual(301)

    const twoRealHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
    // ۲ ساعت واقعی = ۶۰ ساعت بازی
    expect(Math.round(gameHoursSince(twoRealHoursAgo))).toBe(60)

    const oneRealDayAgo = new Date(Date.now() - REAL_DAY_MS)
    // ۱ روز واقعی = ۳۰ روز بازی
    expect(gameDaysSince(oneRealDayAgo)).toBe(30)
  })

  test('زمان باقی‌مانده تا یک سررسید روی ساعت بازی گزارش می‌شود', () => {
    const inOneRealDay = new Date(Date.now() + REAL_DAY_MS)
    expect(daysUntil(inOneRealDay)).toBeGreaterThanOrEqual(29)
    expect(daysUntil(inOneRealDay)).toBeLessThanOrEqual(30)
  })
})

describe('ساعت بازی · چرخه‌های روزانه و هفتگی', () => {
  test('روزشمار با هر ۴۸ دقیقهٔ واقعی یک عدد جلو می‌رود', () => {
    const now = Date.now()
    expect(dayIndex(now + REAL_MS_PER_GAME_DAY)).toBe(dayIndex(now) + 1)
    expect(dayIndex(now + REAL_MS_PER_GAME_DAY * 30)).toBe(dayIndex(now) + 30)
    expect(weekIndex(now + REAL_MS_PER_GAME_DAY * 7)).toBe(weekIndex(now) + 1)
  })

  test('تقویم دنیا از یک مبدأ ثابت جلو می‌رود (Restart ساعت را صفر نمی‌کند)', () => {
    const now = Date.now()
    const moment = gameMoment(now)
    // تقویم با گذر زمان واقعی جلو می‌رود؛ با یک روز واقعی، ۳۰ روز بازی
    const later = gameMoment(now + REAL_DAY_MS)
    expect(worldDay(now + REAL_DAY_MS) - worldDay(now)).toBe(30)
    expect(later.day).toBe(moment.day)
    expect(moment.year).toBeGreaterThanOrEqual(1)
    expect(moment.month).toBeGreaterThanOrEqual(1)
    expect(moment.month).toBeLessThanOrEqual(12)
    expect(moment.day).toBeGreaterThanOrEqual(1)
    expect(moment.day).toBeLessThanOrEqual(30)
    expect(moment.hour).toBeGreaterThanOrEqual(0)
    expect(moment.hour).toBeLessThanOrEqual(23)
  })
})

describe('ساعت بازی · پول و اقتصاد', () => {
  test('نرخ «هر دقیقهٔ واقعی» به «هر ساعت بازی» دو برابر می‌شود (بدون تورم)', () => {
    // ۳٬۰۰۰ تومان در دقیقهٔ واقعی = ۶٬۰۰۰ تومان در ساعت بازی
    expect(ratePerGameHour(3_000)).toBe(6_000)
    // و همان مبلغ به‌ازای هر دقیقهٔ بازی، سی‌امِ نرخ قبلی است
    expect(ratePerGameMinute(3_000)).toBe(100)
    // درآمد یک شیفت ۳۰ دقیقه‌ای واقعی هیچ تغییری نمی‌کند: ۹۰٬۰۰۰ تومان
    const gameHoursIn30RealMinutes = 30 * (GAME_MINUTES_PER_REAL_MINUTE / 60)
    expect(ratePerGameHour(3_000) * gameHoursIn30RealMinutes).toBe(90_000)
  })

  test('مبلغ‌های دوره‌ای با ریتم تازهٔ بازی هم‌تراز می‌شوند', () => {
    // پاداش «روزانهٔ» ۵۰٬۰۰۰ تومانی حالا هر روز بازی پرداخت می‌شود (۳۰ برابر زودتر)
    expect(cycleAmount(50_000)).toBe(1_667)
    // جریان پول در زمان واقعی ثابت: ۳۰ روز بازی = ۱ روز واقعی
    expect(cycleAmount(50_000) * 30).toBe(50_010)
    // نرخ سود سالانه هم به همان نسبت کوچک می‌شود
    expect(cycleRate(0.4)).toBeCloseTo(0.0133333, 6)
  })

  test('اجارهٔ یک‌ماهه دقیقاً ۳۰ روز بازی (≈ ۲۴ ساعت واقعی) اعتبار دارد', () => {
    const oneGameMonth = gameMonths(1)
    expect(oneGameMonth).toBe(REAL_DAY_MS)
    expect(oneGameMonth / REAL_MS_PER_GAME_DAY).toBe(30)
    // در دنیای واقعی، نزدیک به ۲۴ ساعت
    expect(oneGameMonth / (60 * 60 * 1000)).toBe(24)
  })
})

describe('ساعت بازی · نمایش برای بازیکن', () => {
  test('خط ساعت بازی و مدت‌های خوانا', () => {
    const line = gameClockLine()
    expect(line).toContain('سال')
    expect(line).toContain('ماه')
    expect(line).toContain('روز')
    expect(line).toContain('ساعت')

    expect(formatGameMinutes(30)).toContain('دقیقهٔ بازی')
    expect(formatGameMinutes(120)).toContain('ساعت بازی')
    expect(formatGameMinutes(60 * 24 * 2)).toContain('روز بازی')
    expect(formatGameMinutes(60 * 24 * 45)).toContain('ماه')
    expect(formatGameMinutes(60 * 24 * 400)).toContain('سال')
  })
})

/** کمکی: دقایق بازیِ سپری‌شده از یک لحظه (بدون وابستگی به نام صادرشده). */
function gameMinutesSinceForTest(from: Date): number {
  return Math.floor((Date.now() - from.getTime()) / REAL_MS_PER_GAME_MINUTE)
}
