import { DegreeLevel } from '../education/education-blueprints'

export interface PartTimeJobDefinition {
  key: string
  name: string
  category: string
  difficulty: number
  basePayPerMinute: number
  requiredSkills: string[]
  requiredEducation?: DegreeLevel
  minExperience?: number
  baseCapacity: number
  healthDrainPerMinute: number
  fatigueRatePerMinute: number
  experienceRatePerMinute: number
  minimumAge: number
}

export const JOB_CATEGORIES: readonly string[] = [
  'خدماتی',
  'فنی',
  'ساختمانی',
  'اداری',
  'فروش',
  'آموزشی',
  'درمانی',
  'حمل‌ونقل',
  'کشاورزی',
  'رستوران و پذیرایی',
  'فناوری',
  'امنیت',
  'ورزش',
  'تخصصی'
]

export const PART_TIME_JOBS: readonly PartTimeJobDefinition[] = [
  {
    key: 'babysitting',
    name: 'مراقبت از کودک',
    category: 'خدماتی',
    difficulty: 1,
    basePayPerMinute: 3_000,
    requiredSkills: ['ارتباطات'],
    baseCapacity: 10,
    healthDrainPerMinute: 0.1,
    fatigueRatePerMinute: 0.5,
    experienceRatePerMinute: 0.2,
    minimumAge: 16
  },
  {
    key: 'cleaning',
    name: 'نظافت و رفت‌وروب',
    category: 'خدماتی',
    difficulty: 2,
    basePayPerMinute: 4_000,
    requiredSkills: [],
    baseCapacity: 8,
    healthDrainPerMinute: 0.3,
    fatigueRatePerMinute: 0.9,
    experienceRatePerMinute: 0.2,
    minimumAge: 16
  },
  {
    key: 'courier',
    name: 'پیک و خدمات شهری',
    category: 'خدماتی',
    difficulty: 2,
    basePayPerMinute: 5_500,
    requiredSkills: ['ارتباطات'],
    baseCapacity: 8,
    healthDrainPerMinute: 0.3,
    fatigueRatePerMinute: 0.7,
    experienceRatePerMinute: 0.4,
    minimumAge: 18
  },
  {
    key: 'laundry',
    name: 'کارگر خشک‌شویی',
    category: 'خدماتی',
    difficulty: 2,
    basePayPerMinute: 4_300,
    requiredSkills: ['فنی'],
    baseCapacity: 6,
    healthDrainPerMinute: 0.2,
    fatigueRatePerMinute: 0.7,
    experienceRatePerMinute: 0.2,
    minimumAge: 16
  },
  {
    key: 'mechanic',
    name: 'مکانیک خودرو',
    category: 'فنی',
    difficulty: 3,
    basePayPerMinute: 7_000,
    requiredSkills: ['فنی'],
    minExperience: 1,
    baseCapacity: 5,
    healthDrainPerMinute: 0.4,
    fatigueRatePerMinute: 1.0,
    experienceRatePerMinute: 0.4,
    minimumAge: 20
  },
  {
    key: 'plumber',
    name: 'لوله‌کش ساختمان',
    category: 'فنی',
    difficulty: 3,
    basePayPerMinute: 6_500,
    requiredSkills: ['فنی'],
    baseCapacity: 5,
    healthDrainPerMinute: 0.3,
    fatigueRatePerMinute: 1.0,
    experienceRatePerMinute: 0.3,
    minimumAge: 18
  },
  {
    key: 'electrician',
    name: 'برق‌کار ساختمان',
    category: 'فنی',
    difficulty: 4,
    basePayPerMinute: 8_500,
    requiredSkills: ['فنی'],
    requiredEducation: DegreeLevel.ASSOCIATE,
    minExperience: 1,
    baseCapacity: 4,
    healthDrainPerMinute: 0.4,
    fatigueRatePerMinute: 1.1,
    experienceRatePerMinute: 0.4,
    minimumAge: 20
  },
  {
    key: 'construction',
    name: 'کارگر ساختمان',
    category: 'ساختمانی',
    difficulty: 3,
    basePayPerMinute: 6_500,
    requiredSkills: ['فنی'],
    baseCapacity: 8,
    healthDrainPerMinute: 0.5,
    fatigueRatePerMinute: 1.2,
    experienceRatePerMinute: 0.5,
    minimumAge: 18
  },
  {
    key: 'caster',
    name: 'کارگر بتن‌ریز',
    category: 'ساختمانی',
    difficulty: 4,
    basePayPerMinute: 7_500,
    requiredSkills: ['فنی'],
    baseCapacity: 6,
    healthDrainPerMinute: 0.6,
    fatigueRatePerMinute: 1.3,
    experienceRatePerMinute: 0.5,
    minimumAge: 20
  },
  {
    key: 'painter',
    name: 'نقاش ساختمان',
    category: 'ساختمانی',
    difficulty: 2,
    basePayPerMinute: 5_200,
    requiredSkills: ['فنی'],
    baseCapacity: 6,
    healthDrainPerMinute: 0.3,
    fatigueRatePerMinute: 0.9,
    experienceRatePerMinute: 0.3,
    minimumAge: 18
  },
  {
    key: 'clerical',
    name: 'کارمند اداری',
    category: 'اداری',
    difficulty: 2,
    basePayPerMinute: 5_500,
    requiredSkills: ['ارتباطات'],
    baseCapacity: 10,
    healthDrainPerMinute: 0.1,
    fatigueRatePerMinute: 0.5,
    experienceRatePerMinute: 0.3,
    minimumAge: 18
  },
  {
    key: 'accountant',
    name: 'دستیار حسابداری',
    category: 'اداری',
    difficulty: 2,
    basePayPerMinute: 6_000,
    requiredSkills: ['تجارت'],
    requiredEducation: DegreeLevel.ASSOCIATE,
    baseCapacity: 4,
    healthDrainPerMinute: 0.1,
    fatigueRatePerMinute: 0.5,
    experienceRatePerMinute: 0.3,
    minimumAge: 20
  },
  {
    key: 'secretary',
    name: 'منشی و دفتریار',
    category: 'اداری',
    difficulty: 2,
    basePayPerMinute: 5_200,
    requiredSkills: ['ارتباطات'],
    requiredEducation: DegreeLevel.DIPLOMA,
    baseCapacity: 6,
    healthDrainPerMinute: 0.1,
    fatigueRatePerMinute: 0.4,
    experienceRatePerMinute: 0.2,
    minimumAge: 18
  },
  {
    key: 'sales',
    name: 'فروشندگی',
    category: 'فروش',
    difficulty: 2,
    basePayPerMinute: 4_500,
    requiredSkills: ['تجارت', 'ارتباطات'],
    baseCapacity: 6,
    healthDrainPerMinute: 0.1,
    fatigueRatePerMinute: 0.4,
    experienceRatePerMinute: 0.3,
    minimumAge: 16
  },
  {
    key: 'cashier',
    name: 'صندوق‌دار فروشگاه',
    category: 'فروش',
    difficulty: 1,
    basePayPerMinute: 3_800,
    requiredSkills: [],
    baseCapacity: 8,
    healthDrainPerMinute: 0.1,
    fatigueRatePerMinute: 0.4,
    experienceRatePerMinute: 0.2,
    minimumAge: 16
  },
  {
    key: 'market_vendor',
    name: 'دستفروش بازارچه',
    category: 'فروش',
    difficulty: 2,
    basePayPerMinute: 4_200,
    requiredSkills: ['تجارت'],
    baseCapacity: 8,
    healthDrainPerMinute: 0.2,
    fatigueRatePerMinute: 0.6,
    experienceRatePerMinute: 0.3,
    minimumAge: 16
  },
  {
    key: 'tutor',
    name: 'معلم خصوصی',
    category: 'آموزشی',
    difficulty: 2,
    basePayPerMinute: 6_000,
    requiredSkills: ['آموزش', 'ارتباطات'],
    requiredEducation: DegreeLevel.ASSOCIATE,
    baseCapacity: 5,
    healthDrainPerMinute: 0.1,
    fatigueRatePerMinute: 0.5,
    experienceRatePerMinute: 0.4,
    minimumAge: 20
  },
  {
    key: 'assistant_teacher',
    name: 'دستیار آموزشی',
    category: 'آموزشی',
    difficulty: 3,
    basePayPerMinute: 7_000,
    requiredSkills: ['آموزش'],
    requiredEducation: DegreeLevel.BACHELOR,
    baseCapacity: 4,
    healthDrainPerMinute: 0.1,
    fatigueRatePerMinute: 0.5,
    experienceRatePerMinute: 0.5,
    minimumAge: 22
  },
  {
    key: 'nurse',
    name: 'پرستار',
    category: 'درمانی',
    difficulty: 4,
    basePayPerMinute: 8_500,
    requiredSkills: ['ارتباطات', 'فنی'],
    requiredEducation: DegreeLevel.BACHELOR,
    baseCapacity: 4,
    healthDrainPerMinute: 0.4,
    fatigueRatePerMinute: 1.1,
    experienceRatePerMinute: 0.5,
    minimumAge: 22
  },
  {
    key: 'pharmacy',
    name: 'دستیار داروخانه',
    category: 'درمانی',
    difficulty: 3,
    basePayPerMinute: 6_500,
    requiredSkills: ['تجارت'],
    requiredEducation: DegreeLevel.ASSOCIATE,
    baseCapacity: 4,
    healthDrainPerMinute: 0.2,
    fatigueRatePerMinute: 0.6,
    experienceRatePerMinute: 0.3,
    minimumAge: 20
  },
  {
    key: 'driver',
    name: 'راننده (بار و مسافر)',
    category: 'حمل‌ونقل',
    difficulty: 3,
    basePayPerMinute: 6_500,
    requiredSkills: ['فنی'],
    minExperience: 1,
    baseCapacity: 6,
    healthDrainPerMinute: 0.2,
    fatigueRatePerMinute: 1.0,
    experienceRatePerMinute: 0.4,
    minimumAge: 20
  },
  {
    key: 'taxi',
    name: 'راننده تاکسی',
    category: 'حمل‌ونقل',
    difficulty: 2,
    basePayPerMinute: 5_800,
    requiredSkills: ['ارتباطات'],
    baseCapacity: 10,
    healthDrainPerMinute: 0.2,
    fatigueRatePerMinute: 0.8,
    experienceRatePerMinute: 0.3,
    minimumAge: 18
  },
  {
    key: 'gardening',
    name: 'باغبان',
    category: 'کشاورزی',
    difficulty: 2,
    basePayPerMinute: 4_500,
    requiredSkills: ['فنی'],
    baseCapacity: 6,
    healthDrainPerMinute: 0.2,
    fatigueRatePerMinute: 0.8,
    experienceRatePerMinute: 0.3,
    minimumAge: 18
  },
  {
    key: 'farmhand',
    name: 'کارگر مزرعه',
    category: 'کشاورزی',
    difficulty: 3,
    basePayPerMinute: 5_000,
    requiredSkills: [],
    baseCapacity: 6,
    healthDrainPerMinute: 0.4,
    fatigueRatePerMinute: 1.1,
    experienceRatePerMinute: 0.4,
    minimumAge: 18
  },
  {
    key: 'waiter',
    name: 'پیش‌خدمت رستوران',
    category: 'رستوران و پذیرایی',
    difficulty: 2,
    basePayPerMinute: 4_200,
    requiredSkills: ['ارتباطات'],
    baseCapacity: 8,
    healthDrainPerMinute: 0.2,
    fatigueRatePerMinute: 0.7,
    experienceRatePerMinute: 0.3,
    minimumAge: 16
  },
  {
    key: 'cook',
    name: 'آشپز رستوران',
    category: 'رستوران و پذیرایی',
    difficulty: 3,
    basePayPerMinute: 6_000,
    requiredSkills: ['فنی'],
    minExperience: 1,
    baseCapacity: 6,
    healthDrainPerMinute: 0.3,
    fatigueRatePerMinute: 0.9,
    experienceRatePerMinute: 0.4,
    minimumAge: 20
  },
  {
    key: 'barista',
    name: 'متصدی کافی‌شاپ',
    category: 'رستوران و پذیرایی',
    difficulty: 2,
    basePayPerMinute: 4_800,
    requiredSkills: ['ارتباطات'],
    baseCapacity: 8,
    healthDrainPerMinute: 0.1,
    fatigueRatePerMinute: 0.6,
    experienceRatePerMinute: 0.3,
    minimumAge: 16
  },
  {
    key: 'programmer',
    name: 'کارآموز برنامه‌نویسی',
    category: 'فناوری',
    difficulty: 3,
    basePayPerMinute: 9_000,
    requiredSkills: ['برنامه‌نویسی'],
    requiredEducation: DegreeLevel.BACHELOR,
    baseCapacity: 4,
    healthDrainPerMinute: 0.1,
    fatigueRatePerMinute: 0.5,
    experienceRatePerMinute: 0.5,
    minimumAge: 21
  },
  {
    key: 'it_support',
    name: 'پشتیبان فنی',
    category: 'فناوری',
    difficulty: 3,
    basePayPerMinute: 7_500,
    requiredSkills: ['برنامه‌نویسی', 'ارتباطات'],
    requiredEducation: DegreeLevel.ASSOCIATE,
    baseCapacity: 4,
    healthDrainPerMinute: 0.1,
    fatigueRatePerMinute: 0.6,
    experienceRatePerMinute: 0.4,
    minimumAge: 20
  },
  {
    key: 'security',
    name: 'نگهبان و حراست',
    category: 'امنیت',
    difficulty: 2,
    basePayPerMinute: 5_200,
    requiredSkills: ['فنی'],
    baseCapacity: 8,
    healthDrainPerMinute: 0.2,
    fatigueRatePerMinute: 0.8,
    experienceRatePerMinute: 0.3,
    minimumAge: 18
  },
  {
    key: 'fitness_trainer',
    name: 'مربی بدنسازی',
    category: 'ورزش',
    difficulty: 3,
    basePayPerMinute: 7_500,
    requiredSkills: ['آموزش', 'فنی'],
    requiredEducation: DegreeLevel.ASSOCIATE,
    baseCapacity: 4,
    healthDrainPerMinute: 0.2,
    fatigueRatePerMinute: 0.9,
    experienceRatePerMinute: 0.4,
    minimumAge: 20
  },
  {
    key: 'referee',
    name: 'داور مسابقات محلی',
    category: 'ورزش',
    difficulty: 2,
    basePayPerMinute: 5_000,
    requiredSkills: ['ارتباطات'],
    baseCapacity: 6,
    healthDrainPerMinute: 0.1,
    fatigueRatePerMinute: 0.5,
    experienceRatePerMinute: 0.3,
    minimumAge: 18
  },
  {
    key: 'translator',
    name: 'مترجم محلی',
    category: 'تخصصی',
    difficulty: 3,
    basePayPerMinute: 8_000,
    requiredSkills: ['ارتباطات'],
    requiredEducation: DegreeLevel.BACHELOR,
    baseCapacity: 3,
    healthDrainPerMinute: 0.1,
    fatigueRatePerMinute: 0.4,
    experienceRatePerMinute: 0.4,
    minimumAge: 21
  }
]

/**
 * سه سطح کسب‌وکار — تمایز واقعی نه فقط عدد بزرگ‌تر.
 *
 * Tier 1 = Shop / فروشگاه   : ورود آسان، سرمایه و ریسک کم، ظرفیت ۳-۴ نفر،
 *                            نیاز نیرویی کم، سود روزانه محدود.
 * Tier 2 = Business / شرکت  : سرمایه متوسط، ظرفیت ۶-۱۰، نیاز به مهارت و سابقهٔ
 *                            متوسط، سود متناسب با مدیریت تیم.
 * Tier 3 = Factory / کارخانه: سرمایه سنگین، ظرفیت ۱۵-۲۰، هزینهٔ عملیاتی بالا،
 *                            سود فقط وقتی که تیم کامل و پرداخت حقوق منظم باشد.
 *
 * هر سطح رشد، ظرفیت و ریسک متفاوتی دارد؛ کارمندِ اضافه از «نیاز نیرو» فقط
 * هزینه است و سود را می‌سوزاند (در payroll-math اثبات شده).
 */
export type BusinessTier = 1 | 2 | 3

export interface BusinessBlueprint {
  category: 'SERVICE' | 'STORE' | 'GYM' | 'EDUCATION' | 'WORKSHOP' | 'FACTORY' | 'OFFICE'
  modelType: string
  title: string
  tier: BusinessTier
  /** ضریب ریسک: هرچه بالاتر، نوسان هزینه/درآمد و نیاز به مدیریت بیشتر. */
  riskFactor: number
  startupCost: number
  baseCapacity: number
  baseRevenuePerMinute: number
  operatingCostPerMinute: number
  requiredSkills: string[]
  requiredExperience: number
  /** آستانهٔ اجتماعی برای تأسیس (LOW/MIDDLE/HIGH/ELITE) — Tier 3 نیازمند HIGH. */
  requiredSocialLevel?: 'LOW' | 'MIDDLE' | 'HIGH' | 'ELITE'
  description: string
}

/**
 * سقف کسب‌وکارهای فعال هر بازیکن (ضد انحصار).
 * در همان تراکنش تأسیس بررسی می‌شود تا دو درخواست همزمان سقف را نشکنند.
 */
export const MAX_ACTIVE_BUSINESSES_PER_OWNER = 3

export const BUSINESS_BLUEPRINTS: readonly BusinessBlueprint[] = [
  {
    // ── Tier 1: Shop — ورود آسان (فروشگاه محلی)
    category: 'STORE',
    modelType: 'local_shop',
    title: 'فروشگاه محلی',
    tier: 1,
    riskFactor: 0.1,
    startupCost: 5_000_000,
    baseCapacity: 3,
    baseRevenuePerMinute: 3_200,
    operatingCostPerMinute: 450,
    requiredSkills: ['تجارت', 'ارتباطات'],
    requiredExperience: 2,
    description: 'ویترین کوچک محله؛ سه کارمند کافی است، سود محدود اما ریسک ناچیز.'
  },
  {
    category: 'WORKSHOP',
    modelType: 'repair_workshop',
    title: 'کارگاه فنی و تعمیرات',
    tier: 1,
    riskFactor: 0.15,
    startupCost: 10_000_000,
    baseCapacity: 4,
    baseRevenuePerMinute: 6_000,
    operatingCostPerMinute: 900,
    requiredSkills: ['فنی'],
    requiredExperience: 8,
    description: 'کارگاه تعمیرات؛ چهار نفره، درآمد متوسط، هزینهٔ ابزار دارد.'
  },
  {
    category: 'GYM',
    modelType: 'taekwondo_gym',
    title: 'باشگاه تکواندو',
    tier: 1,
    riskFactor: 0.12,
    startupCost: 8_000_000,
    baseCapacity: 5,
    baseRevenuePerMinute: 5_000,
    operatingCostPerMinute: 800,
    requiredSkills: ['آموزش', 'ارتباطات'],
    requiredExperience: 5,
    description: 'باشگاه رزمی کوچک؛ پنج مربی، درآمد پایدار فصلی.'
  },
  {
    // ── Tier 2: Business — شرکت متوسط
    category: 'STORE',
    modelType: 'supermarket',
    title: 'فروشگاه و سوپرمارکت',
    tier: 2,
    riskFactor: 0.25,
    startupCost: 14_000_000,
    baseCapacity: 6,
    baseRevenuePerMinute: 7_500,
    operatingCostPerMinute: 1_100,
    requiredSkills: ['تجارت', 'ارتباطات'],
    requiredExperience: 5,
    description: 'سوپرمارکت محله؛ شش کارمند، گردش روزانه، نیاز به مدیریت موجودی.'
  },
  {
    category: 'GYM',
    modelType: 'fitness_gym',
    title: 'باشگاه بدنسازی',
    tier: 2,
    riskFactor: 0.3,
    startupCost: 20_000_000,
    baseCapacity: 10,
    baseRevenuePerMinute: 9_000,
    operatingCostPerMinute: 1_400,
    requiredSkills: ['مدیریت', 'فنی'],
    requiredExperience: 10,
    description: 'باشگاه بدنسازی متوسط؛ ده مربی، تجهیزات گران، سود وابسته به پر بودن سانس‌ها.'
  },
  {
    category: 'EDUCATION',
    modelType: 'training_center',
    title: 'مرکز آموزش مهارت',
    tier: 2,
    riskFactor: 0.28,
    startupCost: 26_000_000,
    baseCapacity: 8,
    baseRevenuePerMinute: 11_000,
    operatingCostPerMinute: 1_700,
    requiredSkills: ['آموزش', 'مدیریت'],
    requiredExperience: 15,
    description: 'آموزشگاه مهارت؛ هشت مدرس، شهریه‌محور، نیاز به اعتبار محلی.'
  },
  {
    // ── Tier 3: Factory / Office — کارخانه و شرکت بزرگ
    category: 'OFFICE',
    modelType: 'software_company',
    title: 'شرکت فناوری اطلاعات',
    tier: 3,
    riskFactor: 0.45,
    startupCost: 45_000_000,
    baseCapacity: 10,
    baseRevenuePerMinute: 15_000,
    operatingCostPerMinute: 2_200,
    requiredSkills: ['برنامه‌نویسی', 'مدیریت'],
    requiredExperience: 20,
    requiredSocialLevel: 'HIGH',
    description: 'استودیو نرم‌افزار؛ ده متخصص، هزینهٔ حقوق بالا، سود فقط با تیم کامل.'
  },
  {
    // سطح سه (کارخانه): بالاترین سرمایه، ظرفیت و درآمد؛ هزینهٔ عملیاتی و
    // نیروی انسانی سنگین — سود فقط با مدیریت واقعیٔ کارمندان ساخته می‌شود.
    category: 'FACTORY',
    modelType: 'food_factory',
    title: 'کارخانه مواد غذایی',
    tier: 3,
    riskFactor: 0.5,
    startupCost: 90_000_000,
    baseCapacity: 20,
    baseRevenuePerMinute: 26_000,
    operatingCostPerMinute: 4_500,
    requiredSkills: ['فنی', 'مدیریت'],
    requiredExperience: 25,
    requiredSocialLevel: 'HIGH',
    description: 'کارخانهٔ تمام‌عیار؛ بیست کارگر، خط تولید پرهزینه، سود نجومی اگر مدیریت شود و ضرر سنگین اگر نه.'
  }
]

/**
 * نرخ خستگیِ پیش‌فرض یک شیفتِ محل کار (کارمند یا صاحب کسب‌وکار).
 *
 * شیفت‌های «محل کار» شغلِ بازار نیستند، پس نرخ خستگی از Blueprint شغل نمی‌آید
 * و به این عدد تکیه می‌کنند. تنها جایی که این پیش‌فرض تعریف می‌شود همین‌جاست
 * تا تسویهٔ شیفت و چرخهٔ خودکار هر دو یک عدد ببینند.
 */
export const DEFAULT_SHIFT_FATIGUE_PER_REAL_MINUTE = 0.5

/**
 * نرخ خستگیِ یک شیفت بر حسب «نقطه در دقیقهٔ واقعی» — همان واحدی که در
 * Blueprint ذخیره شده است.
 *
 * فراخوان‌دهنده نباید خودش این عدد را به دقیقهٔ بازی تبدیل کند؛ تبدیل دقیقاً
 * یک‌بار و در لایهٔ محاسبه انجام می‌شود (باگِ پیشین: دو بار تبدیل، خستگیِ
 * ۳۰ برابر کمتر).
 */
export function shiftFatigueRatePerRealMinute(jobKey: string): number {
  return (
    PART_TIME_JOBS.find((job) => job.key === jobKey)?.fatigueRatePerMinute ??
    DEFAULT_SHIFT_FATIGUE_PER_REAL_MINUTE
  )
}

/** آیا این کسب‌وکار Tier 1 است؟ (فروشگاه/کارگاه) */
export function isShopTier(blueprint: BusinessBlueprint): boolean {
  return blueprint.tier === 1
}

/** آیا این کسب‌وکار Tier 3 است؟ (کارخانه/شرکت بزرگ) */
export function isFactoryTier(blueprint: BusinessBlueprint): boolean {
  return blueprint.tier === 3
}

/** برچسب فارسی Tier برای نمایش در پنل‌ها. */
export const TIER_LABELS: Record<BusinessTier, string> = {
  1: 'فروشگاه',
  2: 'شرکت',
  3: 'کارخانه'
}