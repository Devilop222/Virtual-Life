/**
 * کاتالوگ مرکزی دستورهای متنی — تنها منبع حقیقت.
 *
 * چرا یک فایل جدا؟ پیش‌تر جدول کلیدواژه‌ها در `text.handler` و جدول
 * عنوان/سیاست بخش‌ها در `chat-policy` زندگی می‌کرد؛ یعنی دو منبع برای یک چیز.
 * نتیجه‌اش خطاهای خاموش بود: راهنما کلمه‌ای را معرفی می‌کرد که وجود نداشت و
 * پیامِ «این بخش در گروه است» کلمه‌ای را پیشنهاد می‌داد که بخش دیگری را باز
 * می‌کرد. حالا هر سه جدول این‌جا و کنار هم نگه داشته می‌شوند:
 *
 *  ۱. `EXACT_SECTIONS`     — کلیدواژهٔ نرمال‌شده → شناسهٔ بخش
 *  ۲. `SECTION_CHAT_POLICY` — هر بخش در گروه است، در چت خصوصی، یا هر دو
 *  ۳. `SECTION_TITLES` / `SECTION_KEYWORDS` — نام انسانی و کلمهٔ پیشنهادی بخش
 *
 * این فایل عمداً هیچ import داخلی ندارد (Leaf Module) تا راهنما، سیاست محیط و
 * هندلر پیام هر سه بتوانند بدون وابستگی دوری از آن بخوانند.
 *
 * قاعدهٔ کلیدها: شکلِ *نرمال‌شده* بنویس — بدون نیم‌فاصله، بدون اعراب،
 * حرف‌های عربی به فارسی. ورودی بازیکن با `normalizePersianText` نرمال می‌شود
 * و سپس عیناً با این کلیدها مقایقه می‌گردد؛ پس کلیدی که خودش نرمال نباشد
 * هرگز مطابقت نمی‌کند. آزمون `tests/command-catalog.test.ts` همین را نگهبانی
 * می‌کند.
 */

/** سیاست محیط اجرای هر بخش. */
export type ChatPolicy = 'GROUP_ONLY' | 'PRIVATE_ONLY' | 'BOTH'

/**
 * سیاست هر بخش. کلید = شناسهٔ بخش (همان مقداری که `EXACT_SECTIONS` تولید می‌کند).
 *
 * قانون دسته‌بندی:
 *  • GROUP_ONLY: بازی اجتماعی/اقتصادی/ملکی/تولیدی/بازاری/منطقه‌ای.
 *  • BOTH: نمایش وضعیت شخصی، سوابق، پیشرفت، امور مالی شخصی و راهنما.
 *  • PRIVATE_ONLY: فقط لینک دعوت (مال خود بازیکن است).
 */
export const SECTION_CHAT_POLICY: Record<string, ChatPolicy> = {
  // ── بازی گروهی (بخش اصلی میراث) ──
  occupation: 'GROUP_ONLY',
  my_biz: 'GROUP_ONLY',
  my_job: 'GROUP_ONLY',
  market: 'GROUP_ONLY',
  housing: 'GROUP_ONLY',
  education: 'GROUP_ONLY',
  shop: 'GROUP_ONLY',
  inventory: 'GROUP_ONLY',
  family: 'GROUP_ONLY',
  auction: 'GROUP_ONLY',
  gym: 'GROUP_ONLY',
  loans: 'GROUP_ONLY',
  challenge: 'GROUP_ONLY',
  policy: 'GROUP_ONLY',
  branches: 'GROUP_ONLY',
  ads: 'GROUP_ONLY',
  rental: 'GROUP_ONLY',
  lottery: 'GROUP_ONLY',
  city: 'GROUP_ONLY',
  news: 'GROUP_ONLY',
  region: 'GROUP_ONLY',
  manage: 'GROUP_ONLY',
  group_info: 'GROUP_ONLY',

  // ── فقط خصوصی ──
  invite: 'PRIVATE_ONLY',
  // گزارش/شکایت بازیکن باید خصوصی بماند: متنِ گزارش و پاسخِ مدیر نباید در
  // گروه (که برای همه دیده می‌شود) نوشته شود. همچنین بازیکنِ مسدود هم باید
  // بتواند اعتراضش را ثبت کند (در `chat-policy` استثنای مسدودی دارد).
  support: 'PRIVATE_ONLY',
  // «زندگی تازه» ذاتا خصوصی است: نام و جنسیتِ شخصیتِ تازه نباید در گروه
  // عمومی نوشته شود. تنها بخشی است که بازیکنِ فوت‌شده هم به آن دسترسی دارد
  // (استثنای `DEAD_EXEMPT_SECTIONS` در `chat-policy`)، وگرنه پایانِ داستان
  // برای همیشه حساب را قفل می‌کرد.
  rebirth: 'PRIVATE_ONLY',

  // ── هر دو محیط (وضعیت شخصی، سوابق، پیشرفت، مالی شخصی، راهنما) ──
  identity: 'BOTH',
  status: 'BOTH',
  help: 'BOTH',
  streak: 'BOTH',
  skills: 'BOTH',
  relationships: 'BOTH',
  home: 'BOTH',
  notifications: 'BOTH',
  life: 'BOTH',
  credit: 'BOTH',
  ledger: 'BOTH',
  stats: 'BOTH',
  rank: 'BOTH',
  mission: 'BOTH',
  history: 'BOTH',
  quests: 'BOTH',
  achievements: 'BOTH',
  fortune: 'BOTH',
  deposits: 'BOTH',
  clinic: 'BOTH',
  passport: 'BOTH',
  leaderboard: 'BOTH',
  report: 'BOTH',
  banking: 'BOTH',
  pets: 'BOTH',
  // وصیت مالی شخصیِ خودِ بازیکن است و به دیگران مربوط نیست؛ ولی در گروه هم
  // بازش می‌کنیم تا بازیکن مجبور نشود برای نوشتن وصیت از بازی بیرون برود.
  will: 'BOTH'
}

/** عنوان انسانی هر بخش برای پیام‌های راهنما و هشدارها. */
export const SECTION_TITLES: Record<string, string> = {
  occupation: 'کار و شغل',
  my_biz: 'کسب‌وکار',
  my_job: 'شغل من',
  market: 'بازار',
  housing: 'خانه',
  education: 'تحصیل',
  shop: 'فروشگاه',
  inventory: 'انبار',
  family: 'خانواده',
  auction: 'حراجی',
  gym: 'باشگاه',
  loans: 'قرض',
  challenge: 'چالش منطقه',
  policy: 'سیاست شهر',
  branches: 'شعبه‌ها',
  ads: 'آگهی',
  rental: 'اجاره',
  lottery: 'قرعه‌کشی',
  city: 'اقتصاد شهر',
  news: 'خبر منطقه',
  region: 'وضعیت منطقه',
  manage: 'مدیریت منطقه',
  group_info: 'اطلاعات گروه',
  invite: 'دعوت دوستان',
  support: 'پشتیبانی',
  // کلیدواژهٔ «زندگی تازه» فقط برای کسی معنا دارد که شخصیتش مرده؛ ولی طبق
  // قاعدهٔ کاتالوگ، هر بخش باید کلیدواژه‌ای داشته باشد که واقعاً به همان بخش
  // برسد. برای بازیکنِ زنده، همین کلمه یک توضیح کوتاه از پایانِ زندگی باز
  // می‌کند — نه یک کنش.
  rebirth: 'زندگی تازه',
  identity: 'شناسنامه',
  status: 'وضعیت من',
  help: 'راهنما',
  streak: 'استریک روزانه',
  skills: 'مهارت‌ها',
  relationships: 'روابط',
  home: 'محل زندگی',
  notifications: 'اعلان‌ها',
  life: 'زندگی من',
  credit: 'اعتبار مالی',
  ledger: 'دفتر مالی',
  stats: 'آمار زندگی',
  rank: 'رتبه',
  mission: 'مأموریت',
  history: 'سرگذشت',
  quests: 'کارت روزانه',
  achievements: 'نشان‌ها',
  fortune: 'شانس روزانه',
  deposits: 'سپرده',
  clinic: 'درمانگاه',
  passport: 'گذرنامه',
  leaderboard: 'لیدربورد',
  report: 'گزارش هفتگی',
  banking: 'بانک',
  pets: 'حیوان خانگی',
  will: 'وصیت و میراث'
}

/**
 * کلیدواژهٔ پیشنهادی هر بخش؛ همان چیزی که در پیام راهنما و هشدارِ
 * «این بخش در گروه است» نقل می‌شود.
 *
 * قاعدهٔ سخت: این کلمه باید واقعاً همین بخش را باز کند.
 * آزمون `tests/command-catalog.test.ts` تک‌تک این جدول را با
 * `EXACT_SECTIONS` می‌سنجد؛ پیش‌تر کلمهٔ پیشنهادی «وضعیت منطقه» کلمهٔ
 * «شهر» بود که بخش «اقتصاد شهر» را باز می‌کرد.
 */
export const SECTION_KEYWORDS: Record<string, string> = {
  occupation: 'کار',
  my_biz: 'کسب‌وکار',
  my_job: 'شغل من',
  market: 'بازار',
  housing: 'خانه',
  education: 'تحصیل',
  shop: 'فروشگاه',
  inventory: 'انبار',
  family: 'خانواده',
  auction: 'حراجی',
  gym: 'باشگاه',
  loans: 'قرض',
  challenge: 'چالش',
  policy: 'سیاست',
  branches: 'شعبه',
  ads: 'آگهی',
  rental: 'اجاره',
  lottery: 'قرعه‌کشی',
  city: 'اقتصاد',
  news: 'خبر',
  region: 'منطقه',
  manage: 'مدیریت',
  group_info: 'گروه',
  invite: 'دعوت دوستان',
  support: 'پشتیبانی',
  rebirth: 'زندگی تازه',
  identity: 'شناسنامه',
  status: 'وضعیت من',
  help: 'راهنما',
  streak: 'استریک',
  skills: 'مهارت‌ها',
  relationships: 'روابط',
  home: 'محل زندگی',
  notifications: 'اعلان‌ها',
  life: 'زندگی من',
  credit: 'اعتبار',
  ledger: 'دفتر مالی',
  stats: 'آمار',
  rank: 'رتبه',
  mission: 'مأموریت',
  history: 'تاریخچه',
  quests: 'کارت روزانه',
  achievements: 'نشان‌ها',
  fortune: 'شانس',
  deposits: 'سپرده',
  clinic: 'درمانگاه',
  passport: 'گذرنامه',
  leaderboard: 'لیدربورد',
  report: 'گزارش',
  banking: 'بانک',
  pets: 'حیوان',
  will: 'وصیت'
}

/**
 * کاربردِ هر بخش در یک خط، برای فهرست کلمه‌های راهنما.
 *
 * چرا جدا از `SECTION_TITLES`؟ عنوان فقط *نام* بخش است؛ چیزی که بازیکن به
 * آن نیاز دارد این است که بداند آن بخش چه چیزی به او می‌دهد و چه زمانی به
 * کارش می‌آید. پیش‌تر فهرست راهنما «عنوان — کلمه» را چاپ می‌کرد و برای بخش
 * «بانک» چیزی شبیه «بانک — «بانک»» تولید می‌شد که هیچ اطلاعاتی نداشت.
 * آزمون `tests/help-content.test.ts` این را نگهبانی می‌کند.
 */
export const SECTION_PURPOSE: Record<string, string> = {
  identity: 'هویت، سن، شغل و دارایی‌هایت در یک نگاه',
  status: 'وضعیت همین لحظه: فعالیت جاری، سلامت و خستگی',
  life: 'خلاصهٔ مسیر زندگی شخصیت تا امروز',
  skills: 'مهارت‌های ثبت‌شده و سطح هرکدام',
  relationships: 'سابقهٔ پیوندهای خانوادگی‌ات (ازدواج و طلاق)',
  home: 'محل زندگی فعلی و مهاجرت به منطقهٔ دیگر',

  occupation: 'فهرست شغل‌های آزاد و درخواست استخدام',
  my_job: 'شغل فعلی، دستمزد و فیش حقوقی',
  my_biz: 'کسب‌وکارهای خودت و گرداندنشان',
  branches: 'شعبه‌های کسب‌وکارت در منطقه‌های دیگر',
  education: 'ثبت‌نام رشته، شهریه و مدرک تحصیلی',
  gym: 'اشتراک هفتگی و بالا بردن سقف سلامت',
  loans: 'قرض گرفتن از بازیکنان دیگر و بازپرداخت',

  banking: 'موجودی، واریز، برداشت و وام بانکی',
  deposits: 'سپردهٔ مدت‌دار با سود مشخص',
  credit: 'امتیاز اعتباری و سقف وامی که می‌گیری',
  ledger: 'دفتر ورود و خروج پول، صفحه‌به‌صفحه',
  report: 'گزارش هفتگی درآمد و خرج',
  housing: 'خریدن، فروختن و اجاره دادن خانه',
  rental: 'خانه‌هایی که برای اجاره گذاشته‌اند',

  shop: 'خرید کالا از فروشگاه منطقه',
  inventory: 'کالاهای خودت و مصرف یا فروششان',
  market: 'خرید و فروش کالا بین بازیکنان',
  auction: 'حراجی هفتگی منطقه و پیشنهاد قیمت',
  ads: 'پرداخت برای دیده‌شدن در خبرهای منطقه',

  family: 'ازدواج، خواستگاری و وضعیت خانواده',
  pets: 'خرید، نام‌گذاری و نگهداری حیوان خانگی',
  will: 'تعیین وارث و انتقال دارایی پس از مرگ',
  rebirth: 'شروع زندگی تازه پس از مرگ شخصیت',

  city: 'اقتصاد منطقه: درآمد، خرج و شاخص‌ها',
  region: 'وضعیت کلی منطقه: جمعیت، سطح و شاخص اقتصادی',
  news: 'خبرهای تازهٔ منطقه و رویدادهای مهم',
  policy: 'سیاست فعال منطقه و اثرش روی اقتصاد',
  challenge: 'چالش گروهی منطقه و جایزه‌اش',
  manage: 'ابزار مدیریت منطقه، برای دهیار یا شهردار',
  group_info: 'نام، جمعیت و سطح همین منطقه',
  passport: 'مهر سفر و وضعیت گذرنامه‌ات',

  rank: 'رتبهٔ تو در منطقه و معیار آن',
  leaderboard: 'ثروتمندترین بازیکنان و منطقه‌ها',
  stats: 'آمار زندگی: دارایی، درآمد و رتبهٔ ثروت',
  history: 'رخدادهای ثبت‌شدهٔ زندگی شخصیت',
  mission: 'مأموریت‌های روزانه و جایزهشان',
  achievements: 'نشان‌های گرفته‌شده و بقیهٔ نشان‌ها',
  quests: 'کارت روزانه: یک کار، یک جایزه',
  streak: 'زنجیرهٔ روزهای پیاپی و پاداشش',
  fortune: 'شانس روزانه: یک گردونه، یک جایزه',
  lottery: 'خرید بلیت قرعه‌کشی هفتگی منطقه',
  clinic: 'سلامت و درمان؛ هزینه و بازیابی توان',

  notifications: 'رویدادهای مربوط به خودت: حقوق، فروش، وام',
  invite: 'ساختن لینک دعوت برای دوستانت',
  support: 'گزارش مشکل یا شکایت به پشتیبانی',
  help: 'همین راهنما؛ موضوع‌ها و کلمه‌های بازی'
}

/** کاربردِ یک بخش؛ بخش بدون کاربرد `null` می‌دهد تا فهرست، خطِ ناقص نسازد. */
export function sectionPurpose(section: string): string | null {
  return SECTION_PURPOSE[section] ?? null
}

/**
 * نگاشت عینِ متنِ نرمال‌شده → بخش.
 *
 * «تطبیق» در اینجا عینِ کلید است، نه پیش‌وند؛ پس «مهارت من» راهی به این
 * جدول ندارد. به ازای هر بخش، شکل‌های رایج نوشتن هم پذیرفته می‌شود
 * (با نیم‌فاصله/بی‌نیم‌فاصله، عربی/فارسی و نام‌های محاوره‌ای) تا بازیکن
 * مجبور نباشد شکل دقیق کلمه را حفظ کند.
 */
export const EXACT_SECTIONS: Record<string, string> = {
  // ── هویت و وضعیت شخصی ──
  'شناسنامه': 'identity',
  'شناسنامه من': 'identity',
  // «شناسنامه‌ی من» و «شناسنامه‌ام» پس از نرمال‌سازی نیم‌فاصله همین شکل‌اند
  'شناسنامه ی من': 'identity',
  'شناسنامه ام': 'identity',
  'کارت شناسایی': 'identity',
  'اطلاعات من': 'identity',
  'مشخصات من': 'identity',
  'مشخصات': 'identity',
  'وضعیت من': 'status',
  'وضعیتم': 'status',
  'وضعیت': 'status',
  'زندگی من': 'life',
  'زندگی': 'life',
  'راهنما': 'help',
  'راهنمایی': 'help',
  'کمک': 'help',
  'پشتیبانی': 'support',
  'تماس با پشتیبانی': 'support',
  // پایانِ زندگی و آغازی تازه — تنها بخشی که شخصیتِ فوت‌شده هم به آن می‌رسد.
  'زندگی تازه': 'rebirth',
  'زندگی دوباره': 'rebirth',
  'گزارش مشکل': 'support',
  'ثبت شکایت': 'support',

  // ── خانه و مسکن ──
  'خانه': 'housing',
  'خونه': 'housing',
  'مسکن': 'housing',
  'اجاره': 'rental',
  'بازار اجاره': 'rental',
  'محل زندگی': 'home',
  'اقامت': 'home',
  'مهاجرت': 'home',
  'گذرنامه': 'passport',
  'مهر سفر': 'passport',
  'سفر': 'passport',

  // ── پول و بانک ──
  'بانک': 'banking',
  'حساب': 'banking',
  'حساب بانکی': 'banking',
  'کیف پول': 'banking',
  'موجودی': 'banking',
  'وام': 'banking',
  'وام بانکی': 'banking',
  'سپرده': 'deposits',
  'سپرده مدت دار': 'deposits',
  'سپرده گذاری': 'deposits',
  'اعتبار': 'credit',
  'اعتبار مالی': 'credit',
  'امتیاز اعتباری': 'credit',
  'دفتر مالی': 'ledger',
  'تراکنش': 'ledger',
  'تراکنش ها': 'ledger',
  'تراکنشها': 'ledger',
  'صورتحساب': 'ledger',
  'درمانگاه': 'clinic',
  'بیمه': 'clinic',

  // ── تحصیل ──
  'تحصیلات': 'education',
  'تحصیل': 'education',
  'دانشگاه': 'education',
  'دانش': 'education',
  'مدرک': 'education',

  // ── کار و شغل ──
  'کار': 'occupation',
  'شغل': 'occupation',
  'شغل من': 'my_job',
  'فیش حقوقی': 'my_job',
  'شرکت های من': 'my_biz',
  'شرکت': 'my_biz',
  'کسب و کار': 'my_biz',
  'کسب و کارها': 'my_biz',
  'کسب وکار': 'my_biz',
  'کسب وکارها': 'my_biz',
  'کسبوکار': 'my_biz',
  'شعبه': 'branches',
  'شعبه ها': 'branches',
  'قرض': 'loans',
  'قرض بازیکنی': 'loans',
  'وام بازیکنی': 'loans',
  'باشگاه': 'gym',
  'باشگاه ورزشی': 'gym',
  'ورزش': 'gym',
  // ── خرید، فروش و بازار ──
  'فروشگاه': 'shop',
  'خرید': 'shop',
  'انبار': 'inventory',
  'بازار': 'market',
  'بازار بازیکنان': 'market',
  'معامله': 'market',
  'حراجی': 'auction',
  'حراج': 'auction',
  'مزایده': 'auction',
  'آگهی': 'ads',
  'اگهی': 'ads',
  'تبلیغات': 'ads',

  // ── خانواده و روابط ──
  'ازدواج': 'family',
  'خانواده': 'family',
  'خواستگاری': 'family',
  'همسر': 'family',
  'حیوان': 'pets',
  'حیوان خانگی': 'pets',
  'وصیت': 'will',
  'وصیتنامه': 'will',
  'وصیت نامه': 'will',
  'میراث': 'will',
  'وارث': 'will',
  'ارث': 'will',
  'روابط': 'relationships',
  // «دوستان» عمداً به «روابط» نمی‌رود: آن بخش سابقهٔ پیوندهای خودِ بازی
  // (ازدواج/طلاق) است و بازیکن هیچ راهی برای افزودن دوست ندارد. نزدیک‌ترین
  // قابلیتِ واقعی، بخش «دعوت دوستان» است که لینکِ اختصاصی می‌دهد.
  'دوستان': 'invite',
  'مهارت ها': 'skills',
  'مهارتها': 'skills',
  'مهارت': 'skills',

  // ── منطقه، شهر و گروه ──
  'گروه': 'group_info',
  'گروه من': 'group_info',
  'اطلاعات گروه': 'group_info',
  'منطقه من': 'group_info',
  'شهر': 'city',
  'اقتصاد شهر': 'city',
  'اقتصاد': 'city',
  'خبر': 'news',
  'خبرها': 'news',
  'اخبار': 'news',
  'منطقه': 'region',
  'وضعیت شهر': 'region',
  'مدیریت': 'manage',
  'مدیریت منطقه': 'manage',
  'چالش': 'challenge',
  'چالش منطقه': 'challenge',
  'سیاست': 'policy',
  'سیاست شهر': 'policy',
  'قرعه کشی': 'lottery',
  'قرعه': 'lottery',

  // ── پیشرفت، رقابت و پاداش ──
  'لیدربورد': 'leaderboard',
  'رتبه بندی': 'leaderboard',
  'رتبه': 'rank',
  'آمار': 'stats',
  'امار': 'stats',
  'آمار زندگی': 'stats',
  'امار زندگی': 'stats',
  'ماموریت': 'mission',
  'ماموریت ها': 'mission',
  'مأموریت': 'mission',
  'تاریخچه': 'history',
  'سرگذشت': 'history',
  'رویدادها': 'history',
  'کارت': 'quests',
  'کارت روزانه': 'quests',
  'کارت های روزانه': 'quests',
  'کارتهای روزانه': 'quests',
  'کارتها': 'quests',
  'کارت ها': 'quests',
  'نشان ها': 'achievements',
  'نشانها': 'achievements',
  'نشان': 'achievements',
  'دستاورد': 'achievements',
  'دستاورد ها': 'achievements',
  'دستاوردها': 'achievements',
  'گزارش': 'report',
  'گزارش هفتگی': 'report',
  'شانس': 'fortune',
  'شانس روزانه': 'fortune',
  'استریک': 'streak',
  'استریک روزانه': 'streak',
  'دعوت': 'invite',
  'دعوت دوستان': 'invite',
  'اعلان ها': 'notifications',
  'اعلانها': 'notifications',
  'اعلان': 'notifications'
}

/** همهٔ شناسه‌های بخشی که در کاتالوگ سیاست تعریف شده‌اند. */
export const ALL_SECTIONS: readonly string[] = Object.keys(SECTION_CHAT_POLICY)

/** سیاست محیط یک بخش؛ بخش ناشناخته محتاطانه «هر دو» فرض می‌شود. */
export function sectionPolicy(section: string): ChatPolicy {
  return SECTION_CHAT_POLICY[section] ?? 'BOTH'
}

/** عنوان انسانی یک بخش. */
export function sectionTitle(section: string): string {
  return SECTION_TITLES[section] ?? 'این بخش'
}

/**
 * کلیدواژهٔ پیشنهادی یک بخش (همان کلمه‌ای که راهنما نقل می‌کند).
 * برای بخش ناشناخته `null` برمی‌گرداند؛ پیش‌تر خودِ شناسهٔ داخلی بخش
 * (مثل `auction`) به بازیکن نشان داده می‌شد که اصطلاح توسعه‌دهنده است.
 */
export function sectionKeyword(section: string): string | null {
  return SECTION_KEYWORDS[section] ?? null
}

/** آیا این بخش در این محیط (گروه/خصوصی) باز می‌شود؟ */
export function isSectionAllowedHere(section: string, chatType: string | undefined): boolean {
  const policy = sectionPolicy(section)
  if (policy === 'BOTH') return true
  const inGroup = chatType === 'group' || chatType === 'supergroup'
  return policy === 'GROUP_ONLY' ? inGroup : !inGroup
}

/** یک رکورد کاتالوگ: بخش + عنوان + همهٔ کلمه‌هایی که آن را باز می‌کنند. */
export interface CatalogEntry {
  section: string
  title: string
  policy: ChatPolicy
  /** کلیدواژهٔ اصلی (همان چیزی که در پیام‌ها نقل می‌شود). */
  keyword: string
  /** بقیهٔ شکل‌های پذیرفته‌شده، به ترتیب الفبای جدول. */
  synonyms: string[]
}

/**
 * فهرست کامل بخش‌ها با همهٔ کلمه‌های مجاز، فقط برای یک سیاست محیط.
 *
 * راهنما از همین تابع ساخته می‌شود؛ پس فهرست دستورها هرگز نمی‌تواند
 * کلمه‌ای را معرفی کند که در بازی وجود ندارد.
 */
export function catalogForPolicy(policy: ChatPolicy): CatalogEntry[] {
  return ALL_SECTIONS.filter((section) => sectionPolicy(section) === policy).map((section) => {
    // هر بخش کاتالوگ کلیدواژهٔ انسانی دارد (تست «هر بخش سیاست، عنوان و
    // کلیدواژهٔ انسانی دارد» این قانون را قفل می‌کند). عنوان فقط پشتوانهٔ
    // نوعی است تا شناسهٔ داخلی بخش هرگز در فهرست دستورها نیفتد.
    const keyword = SECTION_KEYWORDS[section] ?? sectionTitle(section)
    const synonyms = Object.keys(EXACT_SECTIONS).filter(
      (key) => EXACT_SECTIONS[key] === section && key !== keyword
    )
    return { section, title: sectionTitle(section), policy, keyword, synonyms }
  })
}
