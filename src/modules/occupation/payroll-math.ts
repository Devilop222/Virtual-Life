/**
 * ریاضیات مشترک اقتصاد کسب‌وکار و استخدام.
 *
 * تنها مرجع محاسبهٔ ساعات عملیاتی، ضریب نیروی انسانی و انباشت حقوق.
 * PayrollService، مسیرهای ترک کار در BusinessRepository و رندرهای پنل همه از
 * همین توابع خالص استفاده می‌کنند تا هیچ‌وقت دو نسخه از فرمول در بازی نباشد.
 *
 * اصول طراحی:
 *  • **هیچ‌چیز بدون کارکرد پول نمی‌سازد.** پایهٔ درآمد، دقیقه‌های کاری است که
 *    واقعاً در این کسب‌وکار ثبت شده (`deliveredMinutes`) و پایهٔ حقوق، دقیقه‌های
 *    کاری است که خودِ آن کارمند ثبت کرده (`workedMinutes`). پیش از این هر دو
 *    از «زمانِ گذشته» می‌آمدند؛ یعنی یک کارمندِ بیکار هم حقوق می‌گرفت و یک
 *    کسب‌وکارِ خالی هم درآمد می‌ساخت.
 *  • سقف‌ها می‌مانند و نقش گارد دارند: کسب‌وکار روزی ۱۲ ساعت بازی «باز» است و
 *    کارمند روزی ۸ ساعت بازی می‌تواند کارکرد ثبت کند. پس نه یک شیفتِ رهاشده
 *    می‌تواند هفته‌ها کارکرد بسازد، نه تعدادِ سر کارمندان یک‌جا درآمد می‌شکند.
 *  • ضریب نیرو فقط از کارمندانِ **کارکرده** ساخته می‌شود؛ نگه‌داشتنِ نیروی
 *    بیکار روی کاغذ نه درآمدی می‌سازد و نه حقوقی.
 */

import {
  GAME_DAYS_PER_MONTH,
  GAME_MINUTES_PER_REAL_MINUTE,
  GAME_MINUTES_PER_HOUR,
  formatGameHours,
  gameMinutesBetween,
  gameMinutesSince,
  gameMonthStart,
  ratePerGameHour,
  ratePerGameMinute
} from '../../utils/game-time'

/** دقیقهٔ عملیاتی هر روز *بازی* برای درآمد/هزینهٔ کسب‌وکار (۱۲ ساعت بازی). */
export const OPEN_MINUTES_PER_DAY = 12 * 60
/** دقیقهٔ ثبت‌شدهٔ حقوق برای هر کارمند در روز *بازی* (۸ ساعت کار رسمی). */
export const SALARY_MINUTES_PER_DAY = 8 * 60

/** یک ماهِ بازی بر حسب دقیقهٔ بازی (۳۰ روزِ بازی × ۲۴ ساعت). */
export const GAME_MINUTES_PER_MONTH = GAME_DAYS_PER_MONTH * 24 * 60

/**
 * قراردادِ حجمی: کارفرما تعیین می‌کند در هر ماهِ بازی چند ساعت کار بدهد.
 *
 * واحدِ ذخیره در دیتابیس «دقیقهٔ بازی در ماهِ بازی» است، ولی بازیکن و کارفرما
 * فقط در «ساعتِ بازی در ماه» فکر می‌کنند؛ این تولی یک جا ترجمه می‌شود.
 *
 * سقف بالا تصادفی نیست: ۲۴۰ ساعت در ماه = ۸ ساعت در روزِ بازی، همان حجمی که
 * یک انسان می‌تواند کار کند. پایین هم ۳۰ ساعت در ماه (روزی یک ساعت) است تا
 * استخدام به یک قراردادِ تشریفاتی تبدیل نشود.
 */
export const DEFAULT_CONTRACT_GAME_HOURS_PER_MONTH = 240
export const MIN_CONTRACT_GAME_HOURS_PER_MONTH = 30
export const MAX_CONTRACT_GAME_HOURS_PER_MONTH = 240

/** تبدیل «ساعت بازی در ماه» → واحد ذخیرهٔ قرارداد. */
export function contractMinutesFromGameHours(gameHoursPerMonth: number): number {
  const hours = Number.isFinite(gameHoursPerMonth) ? gameHoursPerMonth : 0
  const clamped = Math.max(
    MIN_CONTRACT_GAME_HOURS_PER_MONTH,
    Math.min(MAX_CONTRACT_GAME_HOURS_PER_MONTH, Math.floor(hours))
  )
  return clamped * 60
}

/** خواندنِ قرارداد در واحدی که بازیکن می‌فهمد (ساعت بازی در ماه). */
export function contractGameHoursPerMonth(contractMinutesPerMonth: number): number {
  const minutes = Number.isFinite(contractMinutesPerMonth) ? contractMinutesPerMonth : 0
  return Math.round(minutes / 60)
}

/**
 * باقی‌ماندهٔ حجم قرارداد در همین ماهِ بازی (دقیقهٔ بازی).
 *
 * سقفِ قرارداد **تجمعی روی ماهِ بازی** است، نه سهمِ یک بازهٔ تسویه. اگر سقف را
 * به‌نسبتِ طولِ بازه پخش می‌کردیم، دستمزد به *تعداد* تسویه وابسته می‌شد: کارفرمایی
 * که هر ساعتِ بازی تسویه می‌کرد، به‌ازای هر بازه فقط کسرِ کوچکی از قرارداد را
 * می‌پرداخت و جمعِ پرداخت‌ها در برابر تسویهٔ یک‌ماهه‌ای فرق می‌کرد. اینجا هر
 * دقیقهٔ کارکرد یک‌بار از حجمِ ماه کم می‌شود، پس پنج تسویه و یک تسویه نتیجهٔ
 * یکسان می‌دهند و هیچ کارکردی هم بیرون از سقف نمی‌ماند.
 */
export function remainingContractMinutes(
  contractMinutesPerMonth: number,
  workedMinutesThisMonth: number
): number {
  const contract = Number.isFinite(contractMinutesPerMonth)
    ? Math.max(0, Math.floor(contractMinutesPerMonth))
    : 0
  const worked = Number.isFinite(workedMinutesThisMonth)
    ? Math.max(0, Math.floor(workedMinutesThisMonth))
    : 0
  return Math.max(0, contract - worked)
}

/** ارزشِ کامل یک قرارداد در یک ماهِ بازی — سقفِ واقعیِ پرداخت. */
export function contractValue(
  salaryPerMinute: number,
  contractMinutesPerMonth: number
): number {
  const rate = ratePerGameMinute(salaryPerMinute)
  const minutes = Number.isFinite(contractMinutesPerMonth) ? contractMinutesPerMonth : 0
  return Math.round(Math.max(0, rate) * Math.max(0, minutes))
}
/**
 * سقف انباشت پیش از تسویه.
 *
 * پنجرهٔ تسویه یک بازهٔ *واقعی* است (همان ۷ روزی که بود) و فقط به زبان تقویم
 * بازی بیان می‌شود؛ بی‌این‌که از سی دقیقه‌ای‌بودن هر روز بازی ساخته شود،
 * بازیکنی که یک روز واقعی سر نمی‌زند، ۳۰ برابر کمتر از قبل درآمد می‌گرفت.
 */
export const MAX_ACCRUAL_MINUTES = 7 * 24 * 60 * GAME_MINUTES_PER_REAL_MINUTE

/** دقیقهٔ *بازی* از یک لحظه تا الان، با سقف بازهٔ تسویه. */
export function minutesSince(from: Date): number {
  const minutes = gameMinutesSince(from)
  return Math.max(0, Math.min(MAX_ACCRUAL_MINUTES, minutes))
}

/**
 * لنگر انباشت حقوق یک کارمند: جدیدترینِ «آخرین تسویهٔ کل»، «لحظهٔ استخدام»
 * و «آخرین پرداختِ جدایی». هر سه مسیر (تسویهٔ کل، استعفا، اخراج) از همین
 * تابع استفاده می‌کنند، پس هیچ بازه‌ای دوبار پرداخت نمی‌شود.
 */
export function salaryAnchorAt(
  lastPayrollAt: Date,
  employment: { hiredAt: Date; paidUntilAt: Date | null }
): Date {
  let anchor = lastPayrollAt > employment.hiredAt ? lastPayrollAt : employment.hiredAt
  if (employment.paidUntilAt && employment.paidUntilAt > anchor) {
    anchor = employment.paidUntilAt
  }
  return anchor
}

/** کسری از بازه که داخل ساعت‌های عملیاتیِ هر روز جا می‌شود. */
export function cappedByWorkday(elapsedMinutes: number, perDay: number): number {
  const elapsed = Math.max(0, Math.floor(elapsedMinutes))
  const wholeDays = Math.floor(elapsed / 1440)
  const remainder = elapsed % 1440
  return Math.min(elapsed, wholeDays * perDay + Math.min(remainder, perDay))
}

/** دقیقهٔ مشمول درآمد/هزینهٔ عملیاتی (سقف ۷ روز، سپس ساعت کاری روز). */
export function businessMinutes(elapsedMinutes: number): number {
  const clamped = Math.max(0, Math.min(MAX_ACCRUAL_MINUTES, Math.floor(elapsedMinutes)))
  return cappedByWorkday(clamped, OPEN_MINUTES_PER_DAY)
}

/**
 * سقف کارکردِ قابل‌قبول در یک بازه (ارثیهٔ نامش تغییر نکرده تا همهٔ فراخوان‌ها
 * بی‌صدا معنای غلط نگیرند).
 *
 * «سقف» است، نه «مقدار»: مقدار واقعی از شیفت‌های ثبت‌شده می‌آید. کارمندی که
 * در یک روز بازی دو شیفت بگیرد، بیش از ۸ ساعت بازی کارکرد نمی‌گیرد.
 */
export function salaryMinutes(elapsedMinutes: number): number {
  const clamped = Math.max(0, Math.min(MAX_ACCRUAL_MINUTES, Math.floor(elapsedMinutes)))
  return cappedByWorkday(clamped, SALARY_MINUTES_PER_DAY)
}

/**
 * کارکرد قابل‌اعتبارِ یک شیفت، بر حسب دقیقهٔ بازی.
 *
 * تنها جایی که «شیفت» به «کارکرد» تبدیل می‌شود. هر دو سر بازه از دیتابیس
 * می‌آیند (نه از «الان»)، پس با ری‌استارت یا آفلاین‌بودن بازیکن عدد عوض
 * نمی‌شود. سقف روزانه اینجا هم اعمال می‌شود تا یک شیفتِ رهاشده کارکردِ چند
 * روز را یک‌جا نسازد.
 */
export function creditedWorkMinutes(startedAt: Date, endedAt: Date): number {
  const minutes = gameMinutesBetween(startedAt, endedAt)
  return Math.min(SALARY_MINUTES_PER_DAY, Math.max(0, minutes))
}

/**
 * معادل ماهانهٔ حقوق یک کارمند روی تقویم بازی.
 *
 * این عدد فقط برای نمایش است، اما باید همان چیزی باشد که دفتر پرداخت واقعاً
 * محاسبه می‌کند: یک ماه بازی ۳۰ روز است و حقوق روزی حداکثر ۸ ساعت بازی
 * (`salaryMinutes`) انباشته می‌شود. پیش از این، سه جای پنل‌ها سه روایت مختلف از
 * همین یک مفهوم نشان می‌دادند — «۲۴×۳۰»، «۸×۳۰» و یک ضریب قدیمیِ «۴۸۰×۳۰» که
 * عددی ۳۰ برابر واقعیت می‌ساخت. حالا همهٔ پنل‌ها از همین یک تابع می‌خوانند.
 */
export function monthlySalaryFor(salaryPerMinute: number): number {
  const perGameDay = Math.round((ratePerGameHour(salaryPerMinute) * SALARY_MINUTES_PER_DAY) / 60)
  return perGameDay * GAME_DAYS_PER_MONTH
}

/**
 * پلِ واحدِ دستمزد.
 *
 * بازیکن و کارفرما فقط در «تومان در ساعت بازی» فکر می‌کنند، اما نرخ در دیتابیس
 * «تومان در دقیقهٔ واقعی» ذخیره می‌شود (`salaryPerMinute`). هر ورودی متنی و هر
 * پیام خطای مربوط به حقوق باید از همین‌جا رد شود؛ وگرنه عددی که کارفرما می‌نویسد
 * بی‌سروصدا دو برابر (هر دقیقهٔ واقعی نیم‌ساعت بازی است) خوانده می‌شود.
 */
export function salaryFromGameHourInput(perGameHour: number): number {
  const gameHoursPerRealMinute = GAME_MINUTES_PER_REAL_MINUTE / 60
  return Math.round(perGameHour * gameHoursPerRealMinute)
}

/** کمترین نیاز نیرویی هر کسب‌وکار (مالک + حداقل یک همکار معنادار باشد). */
const MIN_REQUIRED_STAFF = 2

/**
 * «نیاز نیرویی» کسب‌وکار: نصف ظرفیت (گردِ بالا)، حداقل ۲.
 * با پر شدنش درآمد به سقف کامل می‌رسد؛ نیروی اضافه فقط حقوق می‌گیرد.
 */
export function requiredStaff(capacity: number): number {
  const cap = Math.max(1, Math.floor(capacity))
  return Math.max(MIN_REQUIRED_STAFF, Math.ceil(cap / 2))
}

/**
 * توان نیروی انسانیِ هر کارمند برای درآمد کسب‌وکار.
 *
 * منبع عدد، همان ضریب کارِ هستهٔ زندگی است (سلامت، خستگی، مهارت، سابقه،
 * مدرک، سن) که دستمزد خودِ بازیکن را هم می‌سازد؛ اینجا فقط در بازهٔ
 * ۰٫۶۰ تا ۱٫۵۰ مهار می‌شود تا یک کارمندِ حرفه‌ای درآمد شرکت را چند برابر
 * نکند (بدون سقف، استخدام ۲۰ کارمندِ سطح‌بالا یک ماشین تورم می‌شد).
 */
export const MIN_EMPLOYEE_PRODUCTIVITY = 0.6
export const MAX_EMPLOYEE_PRODUCTIVITY = 1.5

/** مهار ضریب کار در بازهٔ قابل‌توازن برای درآمد کسب‌وکار. */
export function employeeProductivity(multiplier: number): number {
  const value = Number.isFinite(multiplier) ? multiplier : 1
  return Math.max(MIN_EMPLOYEE_PRODUCTIVITY, Math.min(MAX_EMPLOYEE_PRODUCTIVITY, value))
}

/**
 * توان کاریِ واقعی = بهره‌وریِ کسانی که در این بازه کارکردِ ثبت‌شده دارند.
 *
 * دو تفاوت با نسخهٔ قبلی، هر دو برای بستنِ یک حفرهٔ اقتصادی:
 *  • مالک دیگر «۱ واحدِ رایگان» نیست؛ فقط وقتی در توان شمرده می‌شود که خودش
 *    شیفت ثبت کرده باشد (`ownerWorkedMinutes`). وگرنه مالکِ بیکار با نیروی
 *    کارمندها درآمد می‌گرفت.
 *  • کارمندِ استخدام‌شده‌ای که سر کار نیامده هیچ توانی نمی‌سازد؛ وگرنه کارفرما
 *    می‌توانست چند بازیکنِ پرآمار را بی‌هزینه روی کاغذ نگه دارد تا ضریب
 *    درآمد را بالا ببرد.
 *
 * ترتیب جمع‌شدن عوض نمی‌کند (جمع است، نه ضرب) و بهره‌وری هر کارمند در
 * `employeeProductivity` مهار می‌شود.
 */
export function staffPower(
  lines: ReadonlyArray<{ productivity?: number; isActive?: boolean; workedMinutes?: number }>,
  ownerWorkedMinutes = 0
): number {
  const owner = ownerWorkedMinutes > 0 ? 1 : 0
  return lines.reduce((sum, line) => {
    if (line.isActive === false || (line.workedMinutes ?? 0) <= 0) {
      return sum
    }
    return sum + employeeProductivity(line.productivity ?? 1)
  }, owner)
}

/**
 * ضریب تحقق درآمد = توان نیرو ÷ نیاز نیرویی (سقف ۱).
 * مالکِ تنها ≈ یک‌سوم تا یک‌دومِ درآمدِ سقف را می‌سازد.
 */
export function staffingFactorFromPower(power: number, capacity: number): number {
  const safe = Number.isFinite(power) ? Math.max(0, power) : 0
  return Math.min(1, safe / requiredStaff(capacity))
}

export interface PayrollProjectionInput {
  baseRevenuePerMinute: number
  operatingCostPerMinute: number
  /** شمارندهٔ کارمندان فعال (فقط برای نمایش/گارد؛ درآمد از کارکرد می‌آید). */
  activeEmployees: number
  capacity: number
  /**
   * بازهٔ تسویه از آخرین تسویهٔ کسب‌وکار. دیگر پایهٔ درآمد نیست؛ فقط دو کار
   * می‌کند: سقف ساعت کاری و مبنای هزینهٔ عملیاتی (کسب‌وکار بسته هم هزینه دارد).
   */
  elapsedMinutes: number
  treasury: number
  /**
   * دقیقهٔ کارِ *تحویل‌شده* در این بازه در این کسب‌وکار، وزن‌داده‌شده با بهره‌وریِ
   * هر کس (کارمند یا مالک). تنها منبع درآمد.
   */
  deliveredMinutes: number
  /** کارکردِ ثبت‌شدهٔ مالک در همین بازه (ورودی توانِ نیرو). */
  ownerWorkedMinutes?: number
  /** یک خط به‌ازای هر کارمندِ درحسابرسی (فعال یا بدهی‌دارِ سابق). */
  lines: Array<{
    salaryPerMinute: number
    unpaidSalary: number
    /** سقفِ بازهٔ همین کارمند (از استخدام یا آخرین تسویه، هرکدام جدیدتر). */
    anchorElapsedMinutes: number
    /** کارکردِ ثبت‌شدهٔ این کارمند در همان بازه — تنها منبع حقوق. */
    workedMinutes: number
    /**
     * باقی‌ماندهٔ حجم قرارداد در همین ماهِ بازی — کارکردِ پیش از این بازه از آن
     * کم شده است، چون سقف ماهانه و تجمعی است.
     */
    contractMinutesRemaining: number
    /** بهره‌وری واقعی کارمند (۰٫۶..۱٫۵)؛ پیش‌فرض ۱ = کارمند تازه‌کار. */
    productivity?: number
    /** کارمندِ رفته توان تولیدی ندارد و فقط بدهی‌اش پرداخت می‌شود. */
    isActive?: boolean
  }>
}

export interface PayrollProjection {
  /** دقیقهٔ کارِ تحویل‌شده‌ای که واقعاً پول ساخت (پس از اعمال سقف ساعت کاری). */
  deliveredMinutes: number
  grossRevenue: number
  operatingCost: number
  /** توان کل نیرو (مالک + کارمندان فعال) — ورودیِ ضریب تحقق درآمد. */
  staffPower: number
  staffingFactor: number
  lines: Array<{ accrued: number; priorUnpaid: number; owed: number; paid: number; unpaid: number }>
  totalOwed: number
  totalPayroll: number
  paidEmployees: number
  unpaidEmployees: number
  totalUnpaidDebt: number
  treasuryBefore: number
  treasuryAfter: number
  netProfit: number
}

/**
 * پیش‌بینی کامل یک تسویه — نسخهٔ خالص و قابل تست.
 * ترتیب: درآمد به خزانه → کسر هزینهٔ عملیاتی → پرداخت حقوق تا سقف خزانه؛
 * مانده به‌عنوان بدهی می‌نشیند (پول از هیچ ساخته نمی‌شود).
 */
export function projectPayroll(input: PayrollProjectionInput): PayrollProjection {
  const elapsed = Math.max(0, Math.min(MAX_ACCRUAL_MINUTES, Math.floor(input.elapsedMinutes)))
  // ساعت کاری کسب‌وکار: سقف درآمد کاری و مبنای هزینهٔ عملیاتی (اجاره و آب و برق
  // با باز و بسته بودن کار ندارند).
  const openMinutes = businessMinutes(elapsed)
  // درآمد فقط به کارکردی می‌رسد که در همین سقف جا شود؛ یک شیفتِ رهاشده
  // نمی‌تواند بیشتر از یک روزِ کاریِ کامل درآمد بسازد.
  const delivered = Math.max(0, Math.min(Math.floor(input.deliveredMinutes), openMinutes))
  // نرخ‌های ذخیره‌شده در دیتابیس «در دقیقهٔ واقعی» هستند؛ ترجمه به دقیقهٔ بازی
  // فقط از همین‌جا و از همان تابع مرکزی ساعت انجام می‌شود.
  const revenuePerGameMinute = ratePerGameMinute(input.baseRevenuePerMinute)
  const costPerGameMinute = ratePerGameMinute(input.operatingCostPerMinute)
  const power = staffPower(input.lines, input.ownerWorkedMinutes ?? 0)
  const factor = staffingFactorFromPower(power, input.capacity)
  const grossRevenue = Math.round(Math.max(0, revenuePerGameMinute) * delivered * factor)
  const operatingCost = Math.round(Math.max(0, costPerGameMinute) * openMinutes)

  const treasuryBefore = Math.max(0, Math.round(input.treasury))
  let treasury = Math.max(0, treasuryBefore + grossRevenue - operatingCost)

  const lines = input.lines.map((line) => {
    // حقوق = نرخ × کارکردِ واقعی، با سقفِ روزانه. کارمندِ بیکار عدد صفر می‌گیرد
    // (قبلاً `anchorElapsedMinutes` یعنی «زمان گذشت» و همین ماشینِ پول‌سازی بود).
    const worked = Math.max(0, Math.floor(line.workedMinutes))
    // دو سقف با دو هدفِ متفاوت: سقفِ قرارداد حجمِ ماهانهٔ توافق‌شده را نگه
    // می‌دارد و سقفِ روزانه جلوی «بانک‌کردنِ» یک شیفتِ طولانی را می‌گیرد.
    const payable = Math.min(
      worked,
      salaryMinutes(line.anchorElapsedMinutes),
      Math.max(0, Math.floor(line.contractMinutesRemaining))
    )
    const accrued = Math.round(Math.max(0, ratePerGameMinute(line.salaryPerMinute)) * payable)
    const priorUnpaid = Math.max(0, Math.round(line.unpaidSalary))
    return { accrued, priorUnpaid, owed: accrued + priorUnpaid, paid: 0, unpaid: 0 }
  })

  let totalOwed = 0
  let totalPayroll = 0
  let paidEmployees = 0
  let unpaidEmployees = 0
  let totalUnpaidDebt = 0

  for (const line of lines) {
    totalOwed += line.owed
    if (line.owed <= 0) continue
    const payable = Math.min(line.owed, treasury)
    line.paid = payable
    line.unpaid = line.owed - payable
    treasury -= payable
    totalPayroll += payable
    if (payable > 0) paidEmployees += 1
    if (line.unpaid > 0) {
      unpaidEmployees += 1
      totalUnpaidDebt += line.unpaid
    }
  }

  return {
    deliveredMinutes: delivered,
    grossRevenue,
    operatingCost,
    staffPower: Math.round(power * 100) / 100,
    staffingFactor: factor,
    lines,
    totalOwed,
    totalPayroll,
    paidEmployees,
    unpaidEmployees,
    totalUnpaidDebt,
    treasuryBefore,
    treasuryAfter: treasury,
    netProfit: grossRevenue - operatingCost - totalPayroll
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  پایشِ کم‌کارکردی — «کمتر از حجمِ قرارداد کار کرده»
// ─────────────────────────────────────────────────────────────────────────────

/**
 * آستانهٔ هشدارِ کم‌کارکردی.
 *
 * چرا «کمتر از حجم» به‌تنهایی هشدار نیست؟ چون حجم یک **سقف** است، نه تعهد.
 * کارمندی که ۱۴۹ ساعت از ۱۵۰ ساعت را کار کرده هیچ مشکلی ندارد، و هشدارِ
 * ماهانه برای یک ساعت اختلاف، اعلانِ مدیریتی را به نویزِ نادیده‌گرفتنی تبدیل
 * می‌کند. مرزِ ۹۰٪ یعنی «کمتر از نُه‌دهمِ انتظار» — تفاوتی که واقعاً یک تصمیمِ
 * مدیریتی می‌خواهد.
 */
export const UNDERWORK_WARN_RATIO = 0.9

/**
 * بازهٔ «ماهِ بازیِ بسته‌شده» نسبت به یک لحظهٔ واقعی.
 *
 * گزارشِ عملکرد، ماهی که **تمام شده** را می‌سنجد و نه ماهی که در جریان است:
 * سنجیدنِ ماهِ نیمه‌کاره، هر کارمندی را در روزِ اولِ ماه «کم‌کار» نشان می‌داد.
 *
 * این تابع تنها جایی است که این مرز ساخته می‌شود؛ اگر سرویس و تست هر کدام
 * مرزِ خودشان را حساب کنند، یک روز دیر یا زود بازه‌ٔ گزارش با بازهٔ سنجه فرق
 * می‌کند (و همان اشتباه یک بار واقعاً رخ داد: `now - ۱` ماهِ جاری را می‌دهد،
 * نه ماهِ بسته‌شده را).
 */
export function closedGameMonthRange(now: number = Date.now()): { start: Date; end: Date } {
  const end = gameMonthStart(now)
  return { start: gameMonthStart(end.getTime() - 1), end }
}

export interface UnderworkInput {
  /** حجمِ قراردادِ ماهانهٔ کارمند (دقیقهٔ بازی). */
  contractMinutes: number
  /** کارکردِ واقعیِ ثبت‌شدهٔ کارمند در ماهِ بسته‌شده (دقیقهٔ بازی). */
  workedMinutes: number
  /** چند روزِ بازی از آن ماه، کارمند زیرِ این قرارداد بوده (۱ تا ۳۰). */
  availableDays: number
}

export interface UnderworkReport {
  /** حجمِ موردانتظارِ همان ماه، تعدیل‌شده با روزهای در دسترس. */
  expectedMinutes: number
  workedMinutes: number
  /** چقدر کمتر از انتظار کار کرده (هرگز منفی نیست). */
  shortfallMinutes: number
  /** نسبتِ کارکرد به انتظار (۰ به‌معنای انتظارِ صفر). */
  ratio: number
  shouldWarn: boolean
}

/**
 * سنجشِ کارکردِ یک کارمند در برابر حجمِ قراردادش.
 *
 * **تعدیلِ ماهِ اول:** کارمندی که وسطِ ماه استخدام شده، ماهِ اول را طبیعتاً
 * ناقص کار می‌کند. اگر با حجمِ کامل سنجیده شود، هر استخدامِ تازه خودبه‌خود
 * «کم‌کار» اعلام می‌شود. پس حجم به نسبتِ روزهای در دسترس کوچک می‌شود و ادعا
 * دقیقاً به همان روزها بسته می‌شود.
 */
export function underworkReport(input: UnderworkInput): UnderworkReport {
  const contract = Math.max(
    0,
    Math.round(Number.isFinite(input.contractMinutes) ? input.contractMinutes : 0)
  )
  const worked = Math.max(
    0,
    Math.round(Number.isFinite(input.workedMinutes) ? input.workedMinutes : 0)
  )
  const days = Math.max(
    0,
    Math.min(
      GAME_DAYS_PER_MONTH,
      Math.floor(Number.isFinite(input.availableDays) ? input.availableDays : 0)
    )
  )
  const expectedMinutes = Math.round((contract * days) / GAME_DAYS_PER_MONTH)
  const ratio = expectedMinutes > 0 ? worked / expectedMinutes : 1
  return {
    expectedMinutes,
    workedMinutes: worked,
    shortfallMinutes: Math.max(0, expectedMinutes - worked),
    ratio: Math.round(ratio * 1000) / 1000,
    shouldWarn: expectedMinutes > 0 && worked < expectedMinutes * UNDERWORK_WARN_RATIO
  }
}

/**
 * متنِ هشدارِ کم‌کارکردی برای کارفرما.
 *
 * فقط **گزارش و پیشنهاد** است: سیستم هرگز خودش کسی را اخراج نمی‌کند و
 * قراردادی را عوض نمی‌کند. تصمیم، دستِ کارفرماست — همان‌طور که یک مدیرِ واقعی
 * گزارشِ عملکرد می‌گیرد و خودش تصمیم می‌گیرد.
 *
 * متن برای بازیکن نوشته شده: هر دو عدد با واحدِ «ساعت بازی» و ارقامِ فارسی.
 *
 * عمداً هر دو خط **ساعت** هستند و نه «روز»: کارفرما دارد دو عدد را با هم
 * مقایسه می‌کند («۴۸ از ۱۵۰ ساعت») و اگر یکی به روز یا دقیقه ترجمه شود،
 * مقایسه در ذهنش نمی‌نشیند.
 */
export function underworkMessage(input: {
  employeeName: string
  report: UnderworkReport
}): string {
  const hours = (minutes: number) => formatGameHours(minutes / GAME_MINUTES_PER_HOUR)
  return [
    `👤 ${input.employeeName}`,
    `⏱ کارکردِ این ماه: ${hours(input.report.workedMinutes)}`,
    `🎯 حجمِ قرارداد: ${hours(input.report.expectedMinutes)}`,
    '',
    '📉 کمتر از حجمِ قرارداد کار کرده.',
    '',
    '💡 پیشنهاد',
    'اگر این روند ادامه پیدا کنه، بهتره حجم قراردادش رو بازبینی کنی یا نیروی تازه بگیری.'
  ].join('\n')
}
