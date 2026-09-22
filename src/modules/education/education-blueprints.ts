export enum DegreeLevel {
  DIPLOMA = 'DIPLOMA',
  ASSOCIATE = 'ASSOCIATE',
  BACHELOR = 'BACHELOR',
  MASTER = 'MASTER',
  DOCTORATE = 'DOCTORATE'
}

export const degreeLabels: Record<DegreeLevel, string> = {
  [DegreeLevel.DIPLOMA]: 'دیپلم',
  [DegreeLevel.ASSOCIATE]: 'کاردانی',
  [DegreeLevel.BACHELOR]: 'کارشناسی (لیسانس)',
  [DegreeLevel.MASTER]: 'کارشناسی ارشد (فوق لیسانس)',
  [DegreeLevel.DOCTORATE]: 'دکتری تخصصی (PhD)'
}

export interface EducationField {
  key: string
  title: string
  category: string
  supportedDegrees: DegreeLevel[]
  baseTuitionCost: number
  gameDurationMinutes: number
  requiredSkills: string[]
  gainedSkills: string[]
  gainedExp: number
  /**
   * دسته‌های شغلیِ هم‌حوزه با این رشته.
   *
   * تا پیش از این، «رشته» فقط یک رشته‌متن روی شناسنامه بود و دو لیسانسِ
   * «پزشکی» و «حقوق» برای بازی هیچ فرقی نداشتند. حالا فارغ‌التحصیلِ هر رشته
   * در دسته‌های هم‌حوزهٔ خودش دستمزد بهتری می‌گیرد و در بقیهٔ دسته‌ها هیچ
   * برتری ندارد — یعنی انتخاب رشته یک تصمیمِ دارای پیامد است، نه یک برچسب.
   */
  affinityCategories: string[]
}

export const EDUCATION_FIELDS: readonly EducationField[] = [
  {
    key: 'software_engineering',
    title: 'مهندسی کامپیوتر و نرم‌افزار',
    category: 'مهندسی',
    supportedDegrees: [DegreeLevel.ASSOCIATE, DegreeLevel.BACHELOR, DegreeLevel.MASTER, DegreeLevel.DOCTORATE],
    baseTuitionCost: 2_500_000,
    gameDurationMinutes: 120, // 2 game hours of study time
    requiredSkills: [],
    gainedSkills: ['برنامه‌نویسی'],
    gainedExp: 200,
    affinityCategories: ['فناوری']
  },
  {
    key: 'civil_engineering',
    title: 'مهندسی عمران و سازه',
    category: 'مهندسی',
    supportedDegrees: [DegreeLevel.ASSOCIATE, DegreeLevel.BACHELOR, DegreeLevel.MASTER, DegreeLevel.DOCTORATE],
    baseTuitionCost: 2_000_000,
    gameDurationMinutes: 120,
    requiredSkills: [],
    gainedSkills: ['فنی'],
    gainedExp: 180,
    affinityCategories: ['ساختمانی', 'فنی']
  },
  {
    key: 'medicine',
    title: 'پزشکی عمومی و بالینی',
    category: 'علوم پزشکی',
    supportedDegrees: [DegreeLevel.BACHELOR, DegreeLevel.DOCTORATE],
    baseTuitionCost: 6_000_000,
    gameDurationMinutes: 240, // longer curriculum for medical paths
    requiredSkills: ['ارتباطات'],
    gainedSkills: ['آموزش', 'فنی'],
    gainedExp: 400,
    affinityCategories: ['درمانی']
  },
  {
    key: 'law',
    title: 'حقوق و قضا',
    category: 'علوم انسانی',
    supportedDegrees: [DegreeLevel.BACHELOR, DegreeLevel.MASTER, DegreeLevel.DOCTORATE],
    baseTuitionCost: 1_600_000,
    gameDurationMinutes: 100,
    requiredSkills: [],
    gainedSkills: ['ارتباطات'],
    gainedExp: 150,
    affinityCategories: ['اداری', 'تخصصی']
  },
  {
    key: 'business_management',
    title: 'مدیریت بازرگانی و کسب‌وکار',
    category: 'مدیریت',
    supportedDegrees: [DegreeLevel.ASSOCIATE, DegreeLevel.BACHELOR, DegreeLevel.MASTER, DegreeLevel.DOCTORATE],
    baseTuitionCost: 1_800_000,
    gameDurationMinutes: 90,
    requiredSkills: [],
    gainedSkills: ['مدیریت', 'تجارت'],
    gainedExp: 160,
    affinityCategories: ['فروش', 'اداری']
  },
  {
    key: 'accounting',
    title: 'حسابداری و امور مالی',
    category: 'اقتصاد',
    supportedDegrees: [DegreeLevel.ASSOCIATE, DegreeLevel.BACHELOR, DegreeLevel.MASTER],
    baseTuitionCost: 1_500_000,
    gameDurationMinutes: 80,
    requiredSkills: [],
    gainedSkills: ['تجارت'],
    gainedExp: 130,
    affinityCategories: ['اداری']
  }
]


export const degreeOrder: Record<DegreeLevel, number> = {
  [DegreeLevel.DIPLOMA]: 1,
  [DegreeLevel.ASSOCIATE]: 2,
  [DegreeLevel.BACHELOR]: 3,
  [DegreeLevel.MASTER]: 4,
  [DegreeLevel.DOCTORATE]: 5
}

/**
 * رتبهٔ مدرک فعلی بازیکن (بدون مدرک = دیپلم/۱) — منبع واحد برای
 * محاسبهٔ درآمد پاره‌وقت، اضافه‌کاری و شرط مدرک آگهی‌های استخدام.
 */
/**
 * رتبهٔ عددی مدرک (۱=دیپلم … ۵=دکتری) — منبع واحد برای محاسبهٔ درآمد
 * پاره‌وقت، اضافه‌کاری، بهره‌وری و شرط مدرک آگهی‌های استخدام.
 * `undefined` هم مثل «بدون مدرک» (= دیپلم) رفتار می‌کند.
 */
export function educationRankOf(currentDegree: string | null | undefined): number {
  return degreeOrder[(currentDegree as DegreeLevel) ?? DegreeLevel.DIPLOMA] ?? 1
}

export function canEnrollInDegree(currentDegree: DegreeLevel, targetDegree: DegreeLevel): boolean {
  const currentRank = degreeOrder[currentDegree]
  const targetRank = degreeOrder[targetDegree]
  // Allow normal sequential upgrade or direct Bachelor from Diploma
  if (currentDegree === DegreeLevel.DIPLOMA && targetDegree === DegreeLevel.BACHELOR) return true
  return targetRank === currentRank + 1
}

/**
 * یادگیریِ رشته → شغل‌های قفل‌گشوده.
 * هر مقطع، دسته‌هایی از مشاغل پاره‌وقت را باز می‌کند. این نگاشت فقط برای
 * نمایشِ «این مدرک چه درهایی را باز می‌کند» است — قفلِ واقعیِ آگهی‌های
 * استخدام در `BusinessService.eligibilityProblems` بررسی می‌شود.
 */
export const DEGREE_UNLOCKS: Record<DegreeLevel, readonly string[]> = {
  [DegreeLevel.DIPLOMA]: ['خدماتی پایه، فروش اولیه، کشاورزی'],
  [DegreeLevel.ASSOCIATE]: ['فنی متوسط، اداری، حسابداری پایه'],
  [DegreeLevel.BACHELOR]: ['درمان مقدماتی، مهندسی، مدیریت شعبه'],
  [DegreeLevel.MASTER]: ['تخصص پیشرفته، مربیگری، تحلیل مالی'],
  [DegreeLevel.DOCTORATE]: ['پژوهش، پزشکی تخصصی، کارآفرینی سطح بالا'],
}

/** شغل‌های هم‌ردیفِ مدرک برای پنلِ «مسیر رشد» */
export function unlocksForDegree(degree: DegreeLevel): readonly string[] {
  return DEGREE_UNLOCKS[degree] ?? []
}

/** مهارت‌های هر رشته برای خلاصهٔ مسیرِ تحصیلی */
export function fieldSummary(field: EducationField): string {
  const skills = field.gainedSkills.length > 0 ? field.gainedSkills.join('، ') : 'مهارت پایه'
  return `${field.title} — ${skills} — ${field.gainedExp} XP`
}

/**
 * دسته‌های شغلیِ هم‌حوزهٔ رشته، به شکل آمادهٔ نمایش.
 *
 * این همان چیزی است که پنل «تحصیل» نشان می‌دهد تا بازیکن بداند رشته‌اش
 * کجا برایش پول بیشتری می‌سازد — تصمیمِ تحصیل باید با دیدِ پیامدش گرفته شود.
 */
export function fieldAffinitySummary(field: EducationField): string {
  return field.affinityCategories.length > 0
    ? field.affinityCategories.join('، ')
    : 'همهٔ دسته‌ها یکسان'
}

/**
 * مقطع بعدیِ ثبت‌نام‌پذیر در یک رشته.
 *
 * کوچک‌ترین مقطعی که هم رشته ارائه‌اش می‌دهد و هم پیش‌نیاز تحصیلی‌اش
 * فراهم است — یعنی «قدم بعدی» نردبان برای همین بازیکن. اگر هیچ مقطعی
 * باقی نمانده باشد (مثلاً دکتری گرفته)، `null` برمی‌گردد و رابط کاربری
 * باید دکمهٔ ثبت‌نامِ بی‌اثر نشان ندهد (نقطهٔ کور قبلی بعد از کارشناسی).
 */
export function nextEnrollableDegree(
  currentDegree: DegreeLevel,
  field: { supportedDegrees: readonly DegreeLevel[] }
): DegreeLevel | null {
  const candidates = (Object.values(DegreeLevel) as DegreeLevel[])
    .filter((degree) => field.supportedDegrees.includes(degree))
    .filter((degree) => canEnrollInDegree(currentDegree, degree))
    .sort((a, b) => degreeOrder[a] - degreeOrder[b])
  return candidates[0] ?? null
}