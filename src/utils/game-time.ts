/**
 * ⏳ ساعت مرکزی بازی — تنها منبع حقیقتِ زمان در کل Legacy Game.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  مدل زمانی (قرارداد رسمی بازی)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   ۱ دقیقهٔ واقعی  = ۳۰ دقیقهٔ بازی
 *   ۲ دقیقهٔ واقعی  = ۱ ساعت بازی
 *   ۴۸ دقیقهٔ واقعی = ۱ روز بازی
 *   ۱ روز واقعی    = ۳۰ روز بازی = ۱ ماه بازی
 *   ۱۲ روز واقعی   = ۱۲ ماه بازی = ۱ سال بازی
 *
 *   تقویم بازی: ۱ سال = ۱۲ ماه، ۱ ماه = ۳۰ روز، ۱ روز = ۲۴ ساعت، ۱ ساعت = ۶۰ دقیقه.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  چرا یک فایل؟
 * ─────────────────────────────────────────────────────────────────────────────
 *  پیش از این، هر سیستم برای خودش «روز»، «ساعت» و «مدت» را از زمان واقعی
 *  می‌ساخت: بعضی جاها یک روز واقعی = ۲۴ ساعت، بعضی جاها یک هفته = یک سال،
 *  بعضی جاها اصلاً واحدی تعریف نشده بود. نتیجه این بود که یک «ماه اجاره» در
 *  ذهنِ بازیکن با چیزی که در دیتابیس بود فرق داشت و هیچ سیستمی نمی‌دانست
 *  «الان در دنیای بازی چند روز گذشته».
 *
 *  حالا همه‌چیز از همین فایل می‌آید:
 *    • زمان بازی را از `gameNow`/`gameMoment` بگیر.
 *    • مدت‌ها را با `gameMinutes`/`gameHours`/`gameDays`/`gameMonths`/`gameYears`
 *      بساز (خروجی: میلی‌ثانیهٔ واقعیِ معادل، آماده برای `new Date()`).
 *    • زمانِ سپری‌شده را با `gameMinutesSince`/`gameHoursSince`/`gameDaysSince`
 *      بخوان — نه با تفریق دستی Timestamp.
 *    • نرخ‌های پولی که قبلاً «در دقیقهٔ واقعی» بودند را با `ratePerGameHour`
 *      به «در ساعت بازی» ترجمه کن (فرمول: هر دقیقهٔ واقعی نیم‌ساعت بازی است).
 *    • مبلغ‌های دوره‌ای (روزانه/هفتگی/ماهانه) را با `cyclePayout` مقیاس کن؛
 *      چون دوره‌ها ۳۰ برابر زودتر تکرار می‌شوند، مبلغ هم ۳۰ برابر کوچک‌تر
 *      می‌شود تا جریان پول در زمان واقعی ثابت بماند (بدون تورم).
 *
 *  هیچ سیستمی مجاز نیست ضریب، واحد یا تبدیل مستقل داشته باشد. اگر جایی تبدیل
 *  تازه‌ای لازم شد، همین‌جا اضافه‌اش کن.
 *
 *  همهٔ محاسبات Timestamp-based و Lazy است؛ هیچ تایمری وجود ندارد، پس Restart
 *  ربات ساعت دنیا را صفر نمی‌کند و Offline Progression خودبه‌خود کار می‌کند:
 *  ساعت بازی روی محور زمان واقعی سوار است و بی‌وقفه جلو می‌رود.
 */

// ─────────────────────────────────────────────────────────────────────────────
//  ثابت‌های مدل زمانی
// ─────────────────────────────────────────────────────────────────────────────

/** ضریب جریان زمان: در هر دقیقهٔ واقعی چند دقیقهٔ بازی می‌گذرد. */
export const GAME_MINUTES_PER_REAL_MINUTE = 30

/** دقیقهٔ بازی در هر ساعت بازی. */
export const GAME_MINUTES_PER_HOUR = 60
/** ساعت بازی در هر روز بازی. */
export const GAME_HOURS_PER_DAY = 24
/** روز بازی در هر ماه بازی. */
export const GAME_DAYS_PER_MONTH = 30
/** ماه بازی در هر سال بازی. */
export const GAME_MONTHS_PER_YEAR = 12
/** روز بازی در هر هفتـهٔ بازی (تقویم بازی هفتهٔ رسمی ندارد؛ فقط ریتم). */
export const GAME_DAYS_PER_WEEK = 7
/** روز بازی در هر سال بازی. */
export const GAME_DAYS_PER_YEAR = GAME_DAYS_PER_MONTH * GAME_MONTHS_PER_YEAR // 360

/** میلی‌ثانیهٔ واقعی که یک دقیقهٔ بازی طول می‌کشد. */
export const REAL_MS_PER_GAME_MINUTE = 60_000 / GAME_MINUTES_PER_REAL_MINUTE // 2٬000
/** میلی‌ثانیهٔ واقعی که یک ساعت بازی طول می‌کشد (۲ دقیقهٔ واقعی). */
export const REAL_MS_PER_GAME_HOUR = REAL_MS_PER_GAME_MINUTE * GAME_MINUTES_PER_HOUR // 120٬000
/** میلی‌ثانیهٔ واقعی که یک روز بازی طول می‌کشد (۴۸ دقیقهٔ واقعی). */
export const REAL_MS_PER_GAME_DAY = REAL_MS_PER_GAME_HOUR * GAME_HOURS_PER_DAY // 2٬880٬000
/** میلی‌ثانیهٔ واقعی که یک هفتهٔ بازی طول می‌کشد (۵٫۶ ساعت واقعی). */
export const REAL_MS_PER_GAME_WEEK = REAL_MS_PER_GAME_DAY * GAME_DAYS_PER_WEEK
/** میلی‌ثانیهٔ واقعی که یک ماه بازی طول می‌کشد (۱ روز واقعی). */
export const REAL_MS_PER_GAME_MONTH = REAL_MS_PER_GAME_DAY * GAME_DAYS_PER_MONTH // 86٬400٬000
/** میلی‌ثانیهٔ واقعی که یک سال بازی طول می‌کشد (۱۲ روز واقعی). */
export const REAL_MS_PER_GAME_YEAR = REAL_MS_PER_GAME_MONTH * GAME_MONTHS_PER_YEAR

/** یک روز واقعی بر حسب میلی‌ثانیه — فقط برای کمیت‌های زیرساختی (پاک‌سازی داده و…). */
export const REAL_DAY_MS = 24 * 60 * 60 * 1000

/**
 * لحظهٔ تولد دنیای بازی (مبدأ تقویم بازی) — ثابت و تغییرناپذیر.
 *
 * تقویم دنیا از این لحظه شمرده می‌شود: «سال ۱ بازی» با این مبدأ شروع شده و
 * چون مبدأ یک عدد ثابت است، Restart یا جابه‌جایی سرور هرگز تقویم را صفر
 * نمی‌کند (مشکل رایج ساعت‌های In-Memory).
 */
export const GAME_EPOCH_MS = Date.UTC(2026, 0, 1)

/**
 * شمارهٔ روزِ مبدأ بر حسب تقویم واقعی.
 *
 * چرا لازم است؟ شمارهٔ روزِ بازی (dayIndex) کلید ضدتکرار بسیاری از سیستم‌ها
 * است و در دیتابیس ذخیره شده. اگر روزشمار بازی از صفر شروع می‌شد، اعداد
 * ذخیره‌شدهٔ قبلی «آیندهٔ دور» به‌نظر می‌رسیدند و بازیکن تا مدت‌ها نمی‌توانست
 * پاداش روزانه‌اش را بگیرد. با پیوستن به شمارهٔ روزِ مبدأ، روزشمار یکنوا
 * ادامه پیدا می‌کند (فقط ۳۰ برابر سریع‌تر جلو می‌رود).
 */
const EPOCH_REAL_DAY_INDEX = Math.floor(GAME_EPOCH_MS / REAL_DAY_MS)

// ─────────────────────────────────────────────────────────────────────────────
//  تبدیل‌های خالص (بدون وابستگی به «الان»)
// ─────────────────────────────────────────────────────────────────────────────

/** مدت واقعی (میلی‌ثانیه) → مدت بازی (میلی‌ثانیه). */
export function realMsToGameMs(realMs: number): number {
  return (Number.isFinite(realMs) ? realMs : 0) * GAME_MINUTES_PER_REAL_MINUTE
}

/** مدت بازی (میلی‌ثانیه) → مدت واقعی (میلی‌ثانیه). */
export function gameMsToRealMs(gameMs: number): number {
  return (Number.isFinite(gameMs) ? gameMs : 0) / GAME_MINUTES_PER_REAL_MINUTE
}

/** مدت واقعیِ معادل n دقیقهٔ بازی (برای `new Date(now + …)`). */
export function gameMinutes(minutes: number): number {
  return Math.round((Number.isFinite(minutes) ? minutes : 0) * REAL_MS_PER_GAME_MINUTE)
}

/** مدت واقعیِ معادل n ساعت بازی. */
export function gameHours(hours: number): number {
  return Math.round((Number.isFinite(hours) ? hours : 0) * REAL_MS_PER_GAME_HOUR)
}

/** مدت واقعیِ معادل n روز بازی (هر روز ۴۸ دقیقه واقعی). */
export function gameDays(days: number): number {
  return Math.round((Number.isFinite(days) ? days : 0) * REAL_MS_PER_GAME_DAY)
}

/** مدت واقعیِ معادل n هفتـهٔ بازی (n×۷ روز بازی). */
export function gameWeeks(weeks: number): number {
  return gameDays((Number.isFinite(weeks) ? weeks : 0) * GAME_DAYS_PER_WEEK)
}

/** مدت واقعیِ معادل n ماه بازی (هر ماه ۳۰ روز بازی = ۱ روز واقعی). */
export function gameMonths(months: number): number {
  return gameDays((Number.isFinite(months) ? months : 0) * GAME_DAYS_PER_MONTH)
}

/** مدت واقعیِ معادل n سال بازی (هر سال ۱۲ روز واقعی). */
export function gameYears(years: number): number {
  return gameMonths((Number.isFinite(years) ? years : 0) * GAME_MONTHS_PER_YEAR)
}

/**
 * طولِ یک بازهٔ بستهٔ واقعی، بر حسب دقیقهٔ بازی.
 *
 * برای مدت‌هایی که *ذخیره* شده‌اند (مثل شروع/پایان یک شیفت کاری) لازم است:
 * `gameMinutesSince` فقط تا «الان» را می‌شمارد، ولی حقوق باید دقیقاً همان
 * مدتی را بپردازد که در دیتابیس ثبت شده — نه مدتی که از آن لحظه تا الان
 * گذشته. هر دو سر بازه از تقویم بازی خوانده می‌شوند، پس جواب قطعی است و به
 * زمانِ اجرای محاسبه بستگی ندارد.
 */
export function gameMinutesBetween(from: Date | number, to: Date | number): number {
  const start = typeof from === 'number' ? from : from.getTime()
  const end = typeof to === 'number' ? to : to.getTime()
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return 0
  }
  return Math.floor((end - start) / REAL_MS_PER_GAME_MINUTE)
}

// ─────────────────────────────────────────────────────────────────────────────
//  ریتم بازی‌باز (بازه‌هایی که باید همان طول واقعی را داشته باشند)
// ─────────────────────────────────────────────────────────────────────────────
//
//  همهٔ مدت‌ها روی تقویم بازی تعریف می‌شوند، اما دو دسته بازه وجود دارد:
//
//   ۱. بازهٔ *دنیای بازی* — مثلاً «یک ماه اجاره» یا «هفت روز عضویت». چون ماه
//      بازی یک روز واقعی است، این بازه‌ها در زمان واقعی هم کوتاه می‌شوند و
//      قیمت‌شان با `cycleAmount` هم‌تراز می‌گردد (بدون تورم).
//   ۲. بازهٔ *ریتم بازی‌باز* — مثلاً «بین دو اضافه‌کاری ۳۰ دقیقه استراحت کن»
//      یا «پنجرهٔ آماری هفت‌روزه». این‌ها برای کنترل سرعتِ عمل در دنیای واقعی
//      هستند (نه یک رخدادِ دنیای بازی) و باید همان طول واقعی را نگه دارند؛
//      وگرنه بازیکن در هر ساعت واقعی ۳۰ برابر بیشتر از قبل کار می‌کند.
//
//  توابع زیر فقط همین دستهٔ دوم را می‌سازند و بقیهٔ سیستم هم آن‌ها را می‌فهمد.

/** معادل دقیقهٔ بازیِ یک بازهٔ واقعی (برای انباشت‌هایی که با دقیقه کار می‌کنند). */
export function realMinutesAsGameMinutes(realMinutes: number): number {
  const safe = Number.isFinite(realMinutes) ? realMinutes : 0
  return Math.round(safe * GAME_MINUTES_PER_REAL_MINUTE)
}

/** میلی‌ثانیهٔ واقعیِ یک بازهٔ «ریتم بازی‌باز» بر حسب دقیقه. */
export function playtimeMinutes(realMinutes: number): number {
  const safe = Number.isFinite(realMinutes) ? realMinutes : 0
  return Math.round(safe * 60_000)
}

/** میلی‌ثانیهٔ واقعیِ یک بازهٔ «ریتم بازی‌باز» بر حسب ساعت. */
export function playtimeHours(realHours: number): number {
  const safe = Number.isFinite(realHours) ? realHours : 0
  return Math.round(safe * 3_600_000)
}

/** میلی‌ثانیهٔ واقعیِ یک بازهٔ «ریتم بازی‌باز» بر حسب روز. */
export function playtimeDays(realDays: number): number {
  const safe = Number.isFinite(realDays) ? realDays : 0
  return Math.round(safe * REAL_DAY_MS)
}

/** همان بازهٔ واقعی، ولی بیان‌شده در واحد «روز بازی» (برای سقف‌های انباشت). */
export function realDaysAsGameDays(realDays: number): number {
  const safe = Number.isFinite(realDays) ? realDays : 0
  return Math.round(safe * GAME_MINUTES_PER_REAL_MINUTE)
}

// ─────────────────────────────────────────────────────────────────────────────
//  «الان» در دنیای بازی
// ─────────────────────────────────────────────────────────────────────────────

/** میلی‌ثانیهٔ بازیِ سپری‌شده از مبدأ دنیا. */
export function gameElapsedMs(now: number = Date.now()): number {
  return realMsToGameMs(Math.max(0, now - GAME_EPOCH_MS))
}

/** شمارهٔ روز دنیای بازی (از مبدأ) — مبنای تقویم نمایشی. */
export function worldDay(now: number = Date.now()): number {
  return Math.floor(Math.max(0, now - GAME_EPOCH_MS) / REAL_MS_PER_GAME_DAY)
}

/**
 * لحظهٔ کامل بازی: تقویم دنیا + واحدهای دقیق + کلیدهای چرخه‌ای.
 *
 * این تنها شکلی است که UI باید برای نمایش زمان استفاده کند.
 */
export interface GameMoment {
  /** سال بازی (از ۱). */
  year: number
  /** ماه بازی (۱ تا ۱۲). */
  month: number
  /** روز ماه بازی (۱ تا ۳۰). */
  day: number
  /** ساعت بازی (۰ تا ۲۳). */
  hour: number
  /** دقیقهٔ بازی (۰ تا ۵۹). */
  minute: number
  /** شمارهٔ روز بازی (کلید چرخه‌های روزانه). */
  dayIndex: number
  /** شمارهٔ هفتـهٔ بازی (کلید چرخه‌های هفتگی). */
  weekIndex: number
  /** میلی‌ثانیهٔ بازیِ سپری‌شده از مبدأ. */
  elapsedMinutes: number
}

/** تقویم کامل بازی در یک لحظهٔ واقعی (پیش‌فرض: همین حالا). */
export function gameMoment(now: number = Date.now()): GameMoment {
  const elapsedMinutes = Math.floor(gameElapsedMs(now) / 60_000)
  const minuteOfDay = elapsedMinutes % GAME_MINUTES_PER_HOUR
  const hourOfDay = Math.floor(elapsedMinutes / GAME_MINUTES_PER_HOUR) % GAME_HOURS_PER_DAY
  const totalDays = worldDay(now)
  const dayOfMonth = totalDays % GAME_DAYS_PER_MONTH
  const totalMonths = Math.floor(totalDays / GAME_DAYS_PER_MONTH)
  const monthOfYear = totalMonths % GAME_MONTHS_PER_YEAR

  return {
    year: Math.floor(totalMonths / GAME_MONTHS_PER_YEAR) + 1,
    month: monthOfYear + 1,
    day: dayOfMonth + 1,
    hour: hourOfDay,
    minute: minuteOfDay,
    dayIndex: dayIndex(now),
    weekIndex: weekIndex(now),
    elapsedMinutes
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  کلیدهای چرخه‌ای (روزانه / هفتگی / ماهانه)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * شمارهٔ روزِ بازی — کلید همهٔ چرخه‌های روزانه.
 *
 * یکنوا و پیوسته با تاریخچهٔ قبلی بازی (روی شمارهٔ روزِ مبدأ سوار است) و
 * هر روز بازی (۴۸ دقیقهٔ واقعی) یک عدد جلو می‌رود.
 */
export function dayIndex(ts: number = Date.now()): number {
  return EPOCH_REAL_DAY_INDEX + Math.floor(Math.max(0, ts - GAME_EPOCH_MS) / REAL_MS_PER_GAME_DAY)
}

/** شمارهٔ هفتـهٔ بازی — کلید همهٔ چرخه‌های هفتگی (هر هفتهٔ بازی ۵٫۶ ساعت واقعی). */
export function weekIndex(ts: number = Date.now()): number {
  return Math.floor(dayIndex(ts) / GAME_DAYS_PER_WEEK)
}

/** شمارهٔ ماه بازی — کلید چرخه‌های ماهانه. */
export function monthIndex(ts: number = Date.now()): number {
  return Math.floor(dayIndex(ts) / GAME_DAYS_PER_MONTH)
}

/** شمارهٔ سال بازی — کلید چرخه‌های سالانه. */
export function yearIndex(ts: number = Date.now()): number {
  return Math.floor(dayIndex(ts) / GAME_DAYS_PER_YEAR)
}

/** روز چندم هفتـهٔ بازی هستیم (۰ تا ۶). */
export function dayOfWeek(ts: number = Date.now()): number {
  return dayIndex(ts) % GAME_DAYS_PER_WEEK
}

// ─────────────────────────────────────────────────────────────────────────────
//  زمانِ سپری‌شده (Offline Progression همان‌جا اتفاق می‌افتد)
// ─────────────────────────────────────────────────────────────────────────────

/** دقایق بازیِ سپری‌شده از یک لحظهٔ واقعی تا الان. */
export function gameMinutesSince(from: Date | number, now: number = Date.now()): number {
  const start = typeof from === 'number' ? from : from.getTime()
  const elapsed = Math.max(0, now - start)
  return Math.floor(elapsed / REAL_MS_PER_GAME_MINUTE)
}

/** ساعت‌های بازیِ سپری‌شده از یک لحظهٔ واقعی تا الان (اعشاری و دقیق). */
export function gameHoursSince(from: Date | number, now: number = Date.now()): number {
  const start = typeof from === 'number' ? from : from.getTime()
  const elapsed = Math.max(0, now - start)
  return elapsed / REAL_MS_PER_GAME_HOUR
}

/** روزهای بازیِ کاملِ سپری‌شده از یک لحظهٔ واقعی تا الان. */
export function gameDaysSince(from: Date | number, now: number = Date.now()): number {
  const start = typeof from === 'number' ? from : from.getTime()
  const elapsed = Math.max(0, now - start)
  return Math.floor(elapsed / REAL_MS_PER_GAME_DAY)
}

/** هفتـه‌های بازیِ کاملِ سپری‌شده از یک لحظهٔ واقعی تا الان. */
export function gameWeeksSince(from: Date | number, now: number = Date.now()): number {
  return Math.floor(gameDaysSince(from, now) / GAME_DAYS_PER_WEEK)
}

/**
 * آغاز روزِ بازیِ جاری (نیمه‌شب تقویم بازی) به‌عنوان یک لحظهٔ واقعی.
 *
 * برای «محدودیت‌های روزانه» لازم است: اگر مرز روز با نیمه‌شب تقویم واقعی حساب
 * شود، روزِ بازی (۴۸ دقیقه) هر بار در میانه بریده می‌شود و شمارش «امروز» با
 * بقیهٔ بازی یکی نمی‌ماند.
 */
export function gameDayStart(ts: number = Date.now()): Date {
  const intoDay = Math.max(0, ts - GAME_EPOCH_MS) % REAL_MS_PER_GAME_DAY
  return new Date(ts - intoDay)
}

/**
 * آغاز ماهِ بازیِ جاری (نیمه‌شب اول ماه) به‌عنوان یک لحظهٔ واقعی.
 *
 * برای «محدودیت‌های ماهانه» لازم است — مثل حجمِ قراردادِ کار. ماهِ بازی
 * دقیقاً ۳۰ روزِ بازی است و هر روز ۴۸ دقیقهٔ واقعی، پس مرز ماه با ضربِ ساده
 * به دست می‌آید: تعداد روزهای گذشته از اول ماه، هر کدام یک روزِ کاملِ بازی.
 */
export function gameMonthStart(ts: number = Date.now()): Date {
  const intoDay = Math.max(0, ts - GAME_EPOCH_MS) % REAL_MS_PER_GAME_DAY
  const dayIntoMonth = worldDay(ts) % GAME_DAYS_PER_MONTH
  return new Date(ts - intoDay - dayIntoMonth * REAL_MS_PER_GAME_DAY)
}

/** سهمِ باقی‌مانده از یک روز بازی (۰ تا ۱) — برای محاسبهٔ «چقدر از امروز گذشته». */
export function fractionOfGameDay(now: number = Date.now()): number {
  const into = Math.max(0, now - GAME_EPOCH_MS) % REAL_MS_PER_GAME_DAY
  return into / REAL_MS_PER_GAME_DAY
}

// ─────────────────────────────────────────────────────────────────────────────
//  زمان باقی‌مانده تا یک سررسید
// ─────────────────────────────────────────────────────────────────────────────

/** ساعت‌های بازیِ باقی‌مانده تا یک لحظهٔ واقعی (رو به بالا، هرگز منفی). */
export function hoursUntil(target: Date, now: number = Date.now()): number {
  return Math.max(0, Math.ceil((target.getTime() - now) / REAL_MS_PER_GAME_HOUR))
}

/** روزهای بازیِ باقی‌مانده تا یک لحظهٔ واقعی (رو به بالا، هرگز منفی). */
export function daysUntil(target: Date, now: number = Date.now()): number {
  return Math.max(0, Math.ceil((target.getTime() - now) / REAL_MS_PER_GAME_DAY))
}

/** دقایق بازیِ باقی‌مانده تا یک لحظهٔ واقعی (رو به بالا، هرگز منفی). */
export function minutesUntil(target: Date, now: number = Date.now()): number {
  return Math.max(0, Math.ceil((target.getTime() - now) / REAL_MS_PER_GAME_MINUTE))
}

// ─────────────────────────────────────────────────────────────────────────────
//  پول و زمان — پلِ بین نرخ‌های قدیمی و واحدهای بازی
// ─────────────────────────────────────────────────────────────────────────────

/**
 * نرخِ «هر دقیقهٔ واقعی» را به «هر ساعت بازی» ترجمه می‌کند.
 *
 * چرا ×۲؟ چون هر دقیقهٔ واقعی نیم‌ساعت بازی است؛ پولی که قبلاً در یک دقیقهٔ
 * واقعی پرداخت می‌شد، در نیم‌ساعت بازی همان ارزش را دارد، پس نرخ ساعتیِ بازی
 * دو برابر عددِ قبلی است. نتیجه: درآمدِ بازیکن به‌ازای هر دقیقهٔ واقعیِ کار
 * هیچ تغییری نمی‌کند — نه تورم، نه ریاضت.
 */
export function ratePerGameHour(ratePerRealMinute: number): number {
  const safe = Number.isFinite(ratePerRealMinute) ? ratePerRealMinute : 0
  return safe * (GAME_MINUTES_PER_HOUR / GAME_MINUTES_PER_REAL_MINUTE)
}

/**
 * نرخِ «هر دقیقهٔ واقعی» را به «هر دقیقهٔ بازی» ترجمه می‌کند (÷۳۰).
 *
 * برای انباشت‌هایی که با دقیقه کار می‌کنند (دستمزد کارمند، درآمد کسب‌وکار،
 * خستگی و تجربهٔ هر دقیقه) استفاده می‌شود: مدت کار بر حسب دقیقهٔ بازی شمرده
 * می‌شود و نرخ هم به همان واحد درمی‌آید؛ حاصل‌ضرب این دو عدد دقیقاً همان پولی
 * است که قبلاً پرداخت می‌شد، اما هر دو طرف فرمول حالا به یک زبان حرف می‌زنند.
 */
export function ratePerGameMinute(ratePerRealMinute: number): number {
  const safe = Number.isFinite(ratePerRealMinute) ? ratePerRealMinute : 0
  return safe / GAME_MINUTES_PER_REAL_MINUTE
}

/**
 * مبلغِ یک دورهٔ تکراری (روزانه/هفتگی/ماهانه) را با ریتم تازهٔ بازی هم‌تراز
 * می‌کند.
 *
 * دوره‌های بازی ۳۰ برابر زودتر از قبل تکرار می‌شوند (یک روز بازی = ۴۸ دقیقهٔ
 * واقعی، یک ماه بازی = ۱ روز واقعی)، پس اگر مبلغ ثابت بماند، بازیکن ۳۰ برابر
 * بیشتر پول می‌گیرد یا می‌دهد. مقیاس‌کردن مبلغ همان چیزی است که اقتصاد را
 * از تورم نجات می‌دهد: جریان پول در زمان واقعی ثابت می‌ماند.
 */
export function cycleAmount(perRealPeriodAmount: number): number {
  const safe = Number.isFinite(perRealPeriodAmount) ? perRealPeriodAmount : 0
  if (safe === 0) return 0
  return Math.round(safe / GAME_MINUTES_PER_REAL_MINUTE)
}

/**
 * نرخِ یک دورهٔ تکراری (سود روزانه/سالانه، کارمزد هر قرارداد) را با ریتم
 * تازهٔ بازی هم‌تراز می‌کند.
 *
 * چون دورهٔ بازی ۳۰ برابر کوتاه‌تر از دورهٔ واقعیِ قبلی است، نرخ هم باید
 * سی‌برابر کوچک‌تر شود؛ وگرنه سود بانکی یا کارمزد قرض در زمان واقعی ۳۰ برابر
 * می‌شد (تورم). درصدها با سه رقم اعشار گرد می‌شوند تا ریاضیات دفتر کل
 * دقیق بماند.
 */
export function cycleRate(ratePerRealPeriod: number): number {
  const safe = Number.isFinite(ratePerRealPeriod) ? ratePerRealPeriod : 0
  return safe / GAME_MINUTES_PER_REAL_MINUTE
}

// ─────────────────────────────────────────────────────────────────────────────
//  نمایش برای بازیکن
// ─────────────────────────────────────────────────────────────────────────────

const FA_DIGITS = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹']

/** ارقام لاتین را به فارسی تبدیل می‌کند (بدون وابستگی به لایهٔ پیام). */
function toFaDigits(value: string): string {
  return value.replace(/\d/g, (d) => FA_DIGITS[Number(d)] ?? d)
}

/** ساعت بازی به شکل «۱۴:۳۰» با ارقام فارسی. */
export function formatGameHour(moment: GameMoment = gameMoment()): string {
  const hh = String(moment.hour).padStart(2, '0')
  const mm = String(moment.minute).padStart(2, '0')
  return toFaDigits(`${hh}:${mm}`)
}

/** خطِ کوتاهِ ساعت دنیای بازی — آماده برای گذاشتن در هر پنل. */
export function gameClockLine(now: number = Date.now()): string {
  const m = gameMoment(now)
  return `🕐 سال ${toFaDigits(String(m.year))} • ماه ${toFaDigits(String(m.month))} • روز ${toFaDigits(String(m.day))} — ساعت ${formatGameHour(m)}`
}

/**
 * تعداد ساعتِ بازی با ارقام فارسی.
 *
 * چرا جدا از `formatGameMinutes`؟ چون برخی کمیت‌ها **واحدِ ذهنی**شان ساعت است،
 * نه مدتِ سپری‌شده: «حجمِ قراردادِ ماهانه» یا «کارکردِ این ماه». اگر همان عدد
 * با `formatGameMinutes` نمایش داده شود، از ۲۴ ساعت به بعد خودبه‌خود به «روز»
 * می‌رود و قراردادِ ۲۴۰ ساعته تبدیل به «۱۰ روز بازی» می‌شود — جمله‌ای که کارفرما
 * نمی‌فهمد با ساعتِ کار چه نسبتی دارد. اینجا عدد همیشه در همان واحدی می‌ماند که
 * بازیکن در آن فکر و تصمیم می‌گیرد.
 */
export function formatGameHours(hours: number): string {
  const safe = Math.max(0, Math.round(Number.isFinite(hours) ? hours : 0))
  return `${toFaDigits(String(safe))} ساعت بازی`
}

/** مدتِ بازی (بر حسب دقیقه) را به متن فارسیِ خوانا تبدیل می‌کند. */
export function formatGameMinutes(totalMinutes: number): string {
  const minutes = Math.max(0, Math.round(Number.isFinite(totalMinutes) ? totalMinutes : 0))
  if (minutes < 60) return `${toFaDigits(String(minutes))} دقیقهٔ بازی`
  const hours = Math.floor(minutes / GAME_MINUTES_PER_HOUR)
  if (hours < GAME_HOURS_PER_DAY) {
    const rest = minutes % GAME_MINUTES_PER_HOUR
    return rest === 0
      ? `${toFaDigits(String(hours))} ساعت بازی`
      : `${toFaDigits(String(hours))} ساعت و ${toFaDigits(String(rest))} دقیقهٔ بازی`
  }
  const days = Math.floor(hours / GAME_HOURS_PER_DAY)
  const restHours = hours % GAME_HOURS_PER_DAY
  if (days < GAME_DAYS_PER_MONTH) {
    return restHours === 0
      ? `${toFaDigits(String(days))} روز بازی`
      : `${toFaDigits(String(days))} روز و ${toFaDigits(String(restHours))} ساعت بازی`
  }
  const months = Math.floor(days / GAME_DAYS_PER_MONTH)
  const restDays = days % GAME_DAYS_PER_MONTH
  if (months < GAME_MONTHS_PER_YEAR) {
    return restDays === 0
      ? `${toFaDigits(String(months))} ماه بازی`
      : `${toFaDigits(String(months))} ماه و ${toFaDigits(String(restDays))} روز بازی`
  }
  const years = Math.floor(months / GAME_MONTHS_PER_YEAR)
  const restMonths = months % GAME_MONTHS_PER_YEAR
  return restMonths === 0
    ? `${toFaDigits(String(years))} سال بازی`
    : `${toFaDigits(String(years))} سال و ${toFaDigits(String(restMonths))} ماه بازی`
}

/** تعداد روزهای بازی تا تولد بعدی (شروع سال تازهٔ زندگی). */
export function gameDaysToNextBirthday(startedAt: Date | null | undefined, now: number = Date.now()): number {
  if (!startedAt) return GAME_DAYS_PER_YEAR
  const elapsed = Math.max(0, now - startedAt.getTime())
  const intoYear = elapsed % REAL_MS_PER_GAME_YEAR
  const remaining = REAL_MS_PER_GAME_YEAR - intoYear
  return Math.max(1, Math.min(GAME_DAYS_PER_YEAR, Math.ceil(remaining / REAL_MS_PER_GAME_DAY)))
}

/**
 * عدد شبه‌تصادفی قطعی از یک رشته.
 *
 * برای انتخاب‌های «تصادفیِ ثابت» (کارت روز، شانس روز، قیمت سهام روز) استفاده
 * می‌شود تا نتیجه در هر بار خواندن یکسان بماند و به Math.random وابسته نباشد.
 */
export function stableHash(seed: string): number {
  let hash = 2166136261
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return Math.abs(hash)
}

/**
 * راهنمای کوتاهِ زمان برای بازیکن تازه‌وارد.
 *
 * این متن برای Player نوشته شده، نه Developer: هیچ اصطلاح فنی، عدد پشت‌صحنه
 * یا نام داخلی در آن نیست — فقط منطق دنیا.
 */
export const GAME_TIME_INTRO_LINES: readonly string[] = [
  'دنیای این‌جا تندتر از دنیای واقعی نفس می‌کشد:',
  '• هر ۱ دقیقهٔ واقعی = ۳۰ دقیقه در بازی',
  '• هر ۲ دقیقهٔ واقعی = ۱ ساعت بازی',
  '• هر ۴۸ دقیقهٔ واقعی = ۱ روز کامل بازی',
  '• هر ۱ روز واقعی = ۱ ماه بازی',
  '• هر ۱۲ روز واقعی = ۱ سال بازی',
  '',
  'یعنی یک روزِ دنیای میراث را در کمتر از یک ساعت تجربه می‌کنی. کار، دستمزد،',
  'اجاره، قرارداد، بیماری و پیری همه با همین ساعت جلو می‌روند — حتی وقتی چند',
  'ساعتی از بازی دور باشی، زندگیِ شخصیتت متوقف نمی‌شود و کارهای زمان‌دارش',
  'در همان فاصله انجام شده‌اند.',
  '',
  'ساعت بازی را همیشه بالای شناسنامه و پنل‌ها می‌بینی.'
]
