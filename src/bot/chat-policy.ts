/**
 * سیاست محیط اجرا (Group / Private) — تنها منبع حقیقت.
 *
 * منطق محصول:
 *  • بخش اصلی بازی در «گروه» انجام می‌شود؛ گروه همان منطقهٔ بازی است.
 *  • چت خصوصی برای آشنایی (onboarding)، امور ذاتاً خصوصی (لینک دعوت)،
 *    نگاه‌انداختن به وضعیت شخصی و سوابق خود بازیکن است.
 *  • هیچ شرط پراکنده‌ای در handlerها برای Group/Private ننویس؛ فقط این جدول.
 *
 * اجرا در دو نقطهٔ متمرکز انجام می‌شود (هر دو از همین جدول می‌خوانند):
 *  ۱. `handleSection` در text.handler — مسیر پیام متنی.
 *  ۲. `chatPolicyMiddleware` در همین فایل — میان‌افزار سراسری grammy که
 *     دکمه‌های «پرش بین بخش‌ها» (مثل خانواده از داخل آمار) را نگه می‌دارد
 *     تا سیاست با ناوبری دکمه‌ای دور زده نشود.
 *
 * قانون دسته‌بندی:
 *  • GROUP_ONLY: بازی اجتماعی/اقتصادی/ملکی/تولیدی/بازاری/منطقه‌ای.
 *  • BOTH: نمایش وضعیت شخصی، سوابق، پیشرفت، امور مالی شخصی و راهنما.
 *  • PRIVATE_ONLY: فقط لینک دعوت (مال خود بازیکن است).
 */

import type { Bot, Context, NextFunction } from 'grammy'
import type { Container } from '../services/container'
import { playerBlockReason } from '../modules/identity/player-state-machine'
import { panel } from './ui-kit'
import { ackCallback, sendPanel } from './panel'
import { buildClosePanelKeyboard } from './keyboards/main.keyboard'
import {
  isSectionAllowedHere,
  sectionKeyword,
  sectionPolicy,
  sectionTitle
} from './command-catalog'

/**
 * جدول‌های بخش‌ها (سیاست محیط، عنوان انسانی و کلیدواژهٔ پیشنهادی) در
 * `command-catalog.ts` زندگی می‌کنند تا راهنما، پیام‌های هدایت و مسیر پیام
 * همه از یک منبع بخوانند. این فایل همان جدول‌ها را برای سازگاری با
 * importهای موجود بازصادرات می‌کند و «اجرای» سیاست را بر عهده دارد.
 */
export type { ChatPolicy, CatalogEntry } from './command-catalog'
export {
  ALL_SECTIONS,
  EXACT_SECTIONS,
  SECTION_CHAT_POLICY,
  SECTION_KEYWORDS,
  SECTION_TITLES,
  catalogForPolicy,
  isSectionAllowedHere,
  sectionKeyword,
  sectionPolicy,
  sectionTitle
} from './command-catalog'

/**
 * دکمه‌هایی که از یک بخش به بخش دیگر می‌پرند (callback → بخش مقصد).
 * میان‌افزار سراسری با همین جدول، دورزدن سیاست از راه دکمه را می‌بندد.
 * دکمه‌هایی که داخل همان بخش می‌مانند (صفحه‌بندی، به‌روزرسانی، بازگشت)
 * از جدول پیش‌وندها نیز بررسی می‌شوند تا پنل قدیمی نتواند سیاست را دور بزند.
 */
export const ENTRY_CALLBACK_SECTION: Record<string, string> = {
  'fam:main': 'family',
  'auc:main': 'auction',
  'chal:main': 'challenge',
  'pol:main': 'policy',
  'br:main': 'branches',
  'loan:main': 'loans',
  'rent:main': 'rental',
  'gym:main': 'gym',
  'ad:main': 'ads',
  'pet:main': 'pets',
  'dep:main': 'deposits',
  'clinic:main': 'clinic',
  'report:main': 'report',
  'credit:refresh': 'credit',
  'ledger:0': 'ledger',
  'history:0': 'history',
  'sup:main': 'support',
  'will:main': 'will'
}

/**
 * پیشوندهای callback که **عمداً** به هیچ بخشی نگاشت نشده‌اند.
 *
 * ## چرا این جدول لازم است؟
 * نگهبانِ سراسری با «بخش» کار می‌کند: پیشوند → بخش → سیاست محیط + وضعیت
 * حساب. پس هر پیشوندی که در `CALLBACK_PREFIX_SECTION` نباشد، از نگهبان
 * رد می‌شود. این یک حفرهٔ واقعی ساخت: دکمه‌های تأییدِ دومرحله‌ای (`act`)
 * هیچ بخشی ندارند — و چون هر کدام به بخشِ دیگری تعلق دارند، نمی‌توان یک
 * نگاشتِ درست برایشان نوشت — پس بازیکنِ فوت‌شده یا مسدود می‌توانست توکنِ
 * باقی‌مانده را بزند و ملک بخرد یا شرکت تأسیس کند.
 *
 * راه‌حل دو بخش دارد: کنش‌های بی‌بخش خودشان نگهبان دارند، و این جدول آن
 * نگهبان‌ها را **اعلام** می‌کند تا آزمونِ `callback-guard-contract` بتواند
 * اثبات کند هر پیشوندِ موجود یا بخش دارد یا نگهبانِ اعلام‌شده. افزودنِ یک
 * `foo:...` تازه بدون تصمیم دربارهٔ نگهبانش، آزمون را قرمز می‌کند.
 *
 * این یک «فهرست استثنا» نیست که کسی بعداً دور بزند: هر ورودی باید بگوید
 * نگهبانش کجاست و چرا بخش ندارد.
 *
 * ## محلِ دقیقِ هر نگهبان در کد
 *  • `act`    — گاردِ وضعیتِ کنشگر در `confirm-action.ts`، پیش از مصرف توکن
 *  • `adm`    — `panelOwnerMiddleware` + بررسیِ ادمین در `admin.service.ts`
 *  • `deploy` — بررسیِ مالکیتِ ربات در `deploy.handler.ts`
 *  • `op`     — دروازهٔ مالکِ ربات + الزامِ چتِ خصوصی در `ops.handler.ts`
 *  • `bk`     — همان دروازه، به‌علاوهٔ تأییدِ دوم پیش از بازیابی
 *  • `panel`  — `panelOwnerMiddleware` (مالکیتِ پیام)
 *  • `reg`    — `panelOwnerMiddleware` + الزامِ چتِ خصوصی در همان میان‌افزار
 *  • `skill`  — بررسیِ وضعیت در `skill.service.ts`
 *  • `skills` — فقط‌خواندنی؛ بازترسیمِ نمای مهارت‌ها در `text.handler.ts`
 *  • `guide`  — راهنمای شروع در `start-guide.ts`، خودش ثبت‌نام را می‌سنجد
 *
 * متنِ دو فیلد زیر عمداً فارسیِ خالص است: آزمونِ `ui-consistency` هر رشتهٔ
 * فارسی را برای واژهٔ فنی یا شناسهٔ داخلی می‌سنجد و حق دارد — روزی کسی ممکن
 * است همین متن را داخل یک پنل نشان بدهد. پس اشارهٔ کد در همین کامنت می‌ماند
 * و داده فقط به زبانِ بازیکن حرف می‌زند.
 */
export interface UnmappedCallbackPrefix {
  /** چه چیزی این پیشوند را محافظت می‌کند (به زبانِ بازیکن). */
  guard: string
  /** چرا نمی‌تواند بخش داشته باشد. */
  why: string
  /**
   * نشانیِ نگهبان در سورس: فایلی که باید رشتهٔ `needle` را داشته باشد.
   *
   * چرا این لازم است؟ فیلدِ `guard` یک **ادعا** است و آزمون نمی‌تواند
   * درستی‌اش را بسنجد. بدون نشانی، کافی است کسی بررسیِ وضعیت را از
   * `skill.service` بردارد تا این جدول به سندِ دروغ تبدیل شود — درست
   * همان حالتی که خودِ حفرهٔ `act` از آن زاده شد. آزمونِ
   * `callback-guard-contract` همین نشانی را در همان فایل می‌جوید.
   */
  evidence: { file: string; needle: string }
}

export const UNMAPPED_CALLBACK_PREFIXES: Readonly<Record<string, UnmappedCallbackPrefix>> = {
  act: {
    guard: 'پیش از تأیید، وضعیت کنشگر سنجیده می‌شود؛ توکنِ بازمانده هم پاک می‌شود',
    why: 'عملیاتِ تأییدشده به بخش‌های مختلف تعلق دارند؛ یک بخشِ واحد اشتباه بود',
    evidence: { file: 'src/bot/confirm-action.ts', needle: 'actorStanding(' }
  },
  adm: {
    guard: 'مالکیتِ پیام و بررسیِ ادمین بودن، هر دو پیش از اجرا',
    why: 'پنل مدیریت قواعد محیط بازی را ندارد و نگهبانِ اختصاصی خودش را دارد',
    evidence: {
      file: 'src/bot/middleware/panel-owner.middleware.ts',
      needle: 'adminService.isAdmin'
    }
  },
  deploy: {
    guard: 'فقط مالکِ ربات، و فقط در اجرای واقعی روی سرور',
    why: 'این فرمان بخشِ بازی نیست؛ ابزارِ نگهداریِ سرور است',
    evidence: { file: 'src/bot/handlers/deploy.handler.ts', needle: 'isOwner' }
  },
  panel: {
    guard: 'مالکیتِ پیام (کسی جز صاحبِ پنل نمی‌تواند ببنددش)',
    why: 'بستن و جابه‌جایی بین پنل‌ها هیچ اثری روی وضعیت بازی ندارد',
    evidence: { file: 'src/bot/handlers/text.handler.ts', needle: "callbackQuery('panel:close'" }
  },
  reg: {
    guard: 'مالکیتِ پیام و اجبارِ چتِ خصوصی',
    why: 'ساختِ شخصیت پیش از وجودِ بازیکن رخ می‌دهد؛ بخشی برای سنجیدن نیست',
    evidence: {
      file: 'src/bot/middleware/panel-owner.middleware.ts',
      needle: "data.startsWith('reg:')"
    }
  },
  skill: {
    guard: 'سرویسِ مهارت وضعیتِ شخصیت را خودش می‌سنجد',
    why: 'تمرین مهارت بخشِ مستقل ندارد؛ از پنل مهارت‌ها باز می‌شود',
    evidence: { file: 'src/modules/skills/skill.service.ts', needle: "=== 'BANNED'" }
  },
  skills: {
    guard: 'فقط‌خواندنی؛ همان پنل دوباره نمایش داده می‌شود',
    why: 'به‌روزرسانیِ نمایشِ مهارت‌ها هیچ نوشتاری ندارد؛ بخش لازم نیست',
    evidence: {
      file: 'src/bot/handlers/text.handler.ts',
      needle: "callbackQuery('skills:refresh'"
    }
  },
  guide: {
    guard: 'فقط‌خواندنی و خودش ثبت‌نامِ بازیکن را می‌سنجد',
    why: 'راهنمای شروع پیش از شکل‌گیری حساب هم لازم است؛ محدودکردنش به بخش، ورودِ تازه‌وارد را می‌بست',
    evidence: { file: 'src/bot/start-guide.ts', needle: 'isRegistered(' }
  },
  op: {
    guard: 'فقط مالکِ واقعیِ ربات و فقط در چت خصوصی، در هر گام دوباره',
    why: 'مرکز کنترل بخشی از بازی نیست؛ نگهبانِ بخش‌ها برای بازیکن است و این‌جا معنا ندارد',
    evidence: { file: 'src/bot/handlers/ops.handler.ts', needle: 'gateOwnerPrivate(' }
  },
  bk: {
    guard: 'مالکِ ربات در چت خصوصی، به‌علاوهٔ تأییدِ دوم و بکاپِ ایمنی پیش از جایگزینی',
    why: 'بکاپ و بازیابی ابزارِ نگهداریِ سرور است، نه بخشی از بازی برای بازیکن',
    evidence: { file: 'src/bot/handlers/ops.handler.ts', needle: 'bk:r2:' }
  }
}

/** Every family of callbacks is guarded, not only its landing-page button. */
export const CALLBACK_PREFIX_SECTION: Readonly<Record<string, string>> = {
  id: 'identity',
  help: 'help',
  house: 'housing',
  work: 'occupation',
  job: 'my_job',
  biz: 'my_biz',
  payroll: 'my_biz',
  bank: 'banking',
  edu: 'education',
  shop: 'shop',
  inv: 'inventory',
  fam: 'family',
  auc: 'auction',
  gym: 'gym',
  loan: 'loans',
  chal: 'challenge',
  pol: 'policy',
  br: 'branches',
  ad: 'ads',
  rent: 'rental',
  lottery: 'lottery',
  city: 'city',
  news: 'news',
  region: 'region',
  manage: 'manage',
  election: 'city',
  project: 'city',
  trade: 'market',
  mkt: 'market',
  residence: 'home',
  streak: 'streak',
  credit: 'credit',
  will: 'will',
  ledger: 'ledger',
  history: 'history',
  stats: 'stats',
  rank: 'rank',
  mission: 'mission',
  quest: 'quests',
  ach: 'achievements',
  fortune: 'fortune',
  dep: 'deposits',
  clinic: 'clinic',
  passport: 'passport',
  lb: 'leaderboard',
  report: 'report',
  pet: 'pets',
  sup: 'support',
  transfer: 'banking',
  rebirth: 'rebirth',
  notif: 'notifications'
}

/**
 * بخش‌هایی که حتی بازیکن مسدود هم می‌تواند باز کند.
 *
 * `support` عمداً اینجاست: پیام «حسابت مسدود است» بازیکن را به «با مدیر
 * گروهت در میان بگذار» می‌فرستد؛ اگر راهِ رسمیِ ثبت اعتراض بسته باشد، آن
 * جمله بی‌عمل می‌ماند. این استثنا فقط در چت خصوصی اثر دارد، چون سیاستِ خودِ
 * بخش `PRIVATE_ONLY` است.
 */
const BAN_EXEMPT_SECTIONS: ReadonlySet<string> = new Set(['help', 'group_info', 'support'])

/**
 * بخش‌های خواندنیِ مربوط به خودِ بازیکن که با حساب مسدود یا پایان‌یافته هم
 * باز می‌شوند — ولی فقط در چت خصوصی.
 *
 * چرا لازم است؟ دلیلِ اخطار و خبرِ مسدودسازی در اعلان‌های بازیکن ثبت می‌شود؛
 * اگر راهِ خواندنش بسته باشد، بازیکن فقط «حسابت مسدود است» را می‌بیند و هرگز
 * نمی‌فهمد چرا.
 *
 * تنها نوشتاریِ مجاز در این بخش «خواندم» است: یک یادداشتِ خوانده‌شدن روی
 * اعلان‌های **خودِ بازیکن**. هیچ پول، ملک، وضعیت یا دارایی‌ای را تغییر نمی‌دهد،
 * پس مسدود/فوت‌بودن مانع آن نیست — و همان یادداشت است که به سیاست نگهداری
 * اجازه می‌دهد اعلان‌های خوانده‌شده را زودتر پاک کند.
 *
 * چرا فقط خصوصی؟ متنِ پیام در گروه برای همه دیده می‌شود؛ دلیلِ اخطارِ یک
 * بازیکن نباید در گروه عمومی شود.
 */
const PRIVATE_READ_ONLY_SECTIONS: ReadonlySet<string> = new Set(['notifications'])

/**
 * بخش‌هایی که بازیکنِ فوت‌شده هم می‌تواند باز کند.
 *
 * `rebirth` تنها راهِ ادامهٔ بازی برای کسی است که شخصیتش مرده. اگر این‌جا
 * نبود، «مرگ» برای همیشه حساب را قفل می‌کرد و جملهٔ «/start را بفرست» در
 * پیام مرگ بی‌عمل می‌ماند (چون `telegram_user_id` یکتاست و ثبت‌نامِ دوباره
 * مسیر دیگری ندارد). این استثنا **فقط در چت خصوصی** اثر دارد، چون سیاستِ
 * خودِ بخش `PRIVATE_ONLY` است.
 */
const DEAD_EXEMPT_SECTIONS: ReadonlySet<string> = new Set(['rebirth'])

/** آیا این چت یک گروه است؟ */
export function isGroupChat(chatType: string | undefined): boolean {
  return chatType === 'group' || chatType === 'supergroup'
}

// ─────────────────────────────────────────────────────────── پیام‌ها

/**
 * جملهٔ «کدام کلمه را بفرستی». اگر بخشی کلیدواژهٔ انسانی نداشت، جملهٔ
 * عمومی می‌سازد تا شناسهٔ داخلی بخش هرگز در پیام بازیکن ظاهر نشود.
 */
function keywordHint(section: string, where: string): string {
  const keyword = sectionKeyword(section)
  return keyword
    ? `${where} کلمهٔ «${keyword}» را بفرست تا باز شود.`
    : `${where} از منوی اصلی وارد این بخش شو.`
}

/** پیام انسانی «این بخش در گروه انجام می‌شود» برای مسیر پیام متنی. */
export function groupOnlyNotice(section: string): string {
  return panel({
    icon: '🏘️',
    title: sectionTitle(section),
    sections: [
      {
        lines: ['این بخش بازی در گروه انجام می‌شود.', '', keywordHint(section, 'در گروه منطقه‌ات')]
      }
    ],
    footer: '💡 بازی اصلی میراث در گروه است؛ همین‌جا می‌توانی شناسنامه، وضعیت و آمار خودت را ببینی.'
  })
}

/** همان پیام برای مسیر دکمه (هشدار کوتاه، بدون پیام تازه). */
export function groupOnlyAlert(section: string): string {
  const keyword = sectionKeyword(section)
  const title = sectionTitle(section)
  if (!keyword) {
    return `«${title}» فقط در گروه باز می‌شود.`
  }
  // وقتی عنوان و کلیدواژه یکی‌اند («بازار»)، تکرارشان در یک جمله فقط متن را
  // شلوغ می‌کند؛ بازیکن همین حالا همان کلمه را زده است.
  return title === keyword
    ? `«${keyword}» فقط در گروه باز می‌شود؛ همان کلمه را در گروه منطقه‌ات بفرست.`
    : `«${title}» فقط در گروه باز می‌شود؛ در گروه منطقه‌ات «${keyword}» را بفرست.`
}

/** پیام انسانی «این بخش مخصوص چت خصوصی است» برای مسیر پیام متنی. */
export function privateOnlyNotice(section: string): string {
  return panel({
    icon: '🔒',
    title: sectionTitle(section),
    sections: [
      {
        lines: ['این بخش مخصوص چت خصوصی ربات است.', '', keywordHint(section, 'در چت خصوصی ربات')]
      }
    ]
  })
}

/** همان پیام برای مسیر دکمه. */
export function privateOnlyAlert(section: string): string {
  return `«${sectionTitle(section)}» فقط در چت خصوصی ربات باز می‌شود.`
}

export function bannedNotice(): string {
  return panel({
    icon: '⛔',
    title: 'حساب مسدود',
    sections: [
      {
        lines: [
          'حسابت مسدود است و فعلاً نمی‌توانی بازی کنی.',
          '',
          'اگر فکر می‌کنی اشتباهی رخ داده، همین‌جا در چت خصوصی کلمهٔ «پشتیبانی» را',
          'بفرست تا اعتراضت به‌صورت رسمی ثبت شود؛ راهنما و اطلاعات گروه هم باز است.'
        ]
      }
    ]
  })
}

export function bannedAlert(): string {
  return 'حسابت مسدود است و فعلاً نمی‌توانی بازی کنی.'
}

/**
 * پیام «محیط بازی در این گروه راه‌اندازی نشده».
 * گروهی که مدیرش بازی را فعال نکرده، هیچ‌گاه نباید خودش را محیطِ فعال جلوه دهد.
 */
export function notSetupNotice(): string {
  return panel({
    icon: '🌍',
    title: 'راه‌اندازی نشده',
    sections: [
      {
        lines: [
          'این گروه هنوز برای بازی راه‌اندازی نشده است.',
          '',
          'برای فعال‌سازی بازی در این گروه، یکی از مدیران گروه',
          'باید یک بار /start را بفرستد.'
        ]
      }
    ],
    footer: '💡 بعد از راه‌اندازی، همین‌جا می‌توانی با کلمه‌های بازی وارد محیط شوی.'
  })
}

export function notSetupAlert(): string {
  return 'این گروه هنوز برای بازی راه‌اندازی نشده است؛ یکی از مدیران گروه باید /start را بفرستد.'
}

export function deadNotice(): string {
  return panel({
    icon: '🕊️',
    title: 'پایان داستان',
    sections: [
      {
        lines: [
          'داستان این شخصیت به پایان رسیده و دیگر نمی‌تواند فعالیتی آغاز کند.',
          'دارایی‌هایش طبق وصیت به وارثش منتقل شده است.',
          'برای شروع یک زندگی تازه /start را بفرست.'
        ]
      }
    ]
  })
}

export function deadAlert(): string {
  return 'داستان این شخصیت به پایان رسیده است.'
}

// ─────────────────────────────────────────────────────────── نگهبان‌ها

export type EntryGuardResult = 'allowed' | 'wrong_chat' | 'banned' | 'dead' | 'not_setup'

/**
 * وضعیتِ حسابِ کنشگر از دیدِ «اجازهٔ کنش».
 *
 * چرا این تابع جدا شد؟ قاعدهٔ «چه کسی اجازهٔ کنش دارد» پیش‌تر فقط داخلِ
 * `checkSectionEntry` بود و تنها از مسیر «ورود به بخش» قابلِ پرسیدن بود. اما
 * همهٔ کنش‌ها از مسیر بخش نمی‌آیند: دکمه‌های تأییدِ دومرحله‌ای
 * (`act:go:*`) هیچ بخشی ندارند و اجرایشان از همان گروهِ حساس‌ترین
 * عملیات‌های بازی است (خرید ملک، تأسیس شرکت، استخدام، فروش، وصیت).
 * نتیجه: بازیکنی که وسطِ یک صفحهٔ تأیید می‌مرد یا مسدود می‌شد، همچنان
 * می‌توانست توکنِ باقی‌مانده را بزند و عملیات انجام می‌شد.
 *
 * حالا قاعده یک منبع دارد و هر مسیری که «اجازهٔ کنش» می‌خواهد از همین‌جا
 * می‌پرسد — افزودنِ وضعیتِ تازه در آینده فقط همین‌جا انجام می‌شود.
 */
export type ActorStanding = 'active' | 'dead' | 'banned'

export async function actorStanding(
  container: Container,
  telegramUserId: bigint
): Promise<ActorStanding> {
  const player = await container.playerRepository.findByTelegramUserId(telegramUserId)
  if (!player) {
    return 'active'
  }
  // قاعده از دامنه می‌آید، نه از یک نسخهٔ محلیِ همین فایل: تنها جایی که
  // «فوت‌شده یا مسدود» تعریف می‌شود `playerBlockReason` است. اگر روزی وضعیت
  // تازه‌ای اضافه شود، همین مسیر خودش آن را می‌گیرد.
  return playerBlockReason(player.status) ?? 'active'
}

/**
 * پاسخِ استانداردِ مسیرِ دکمه به کنشگرِ غیرمجاز.
 *
 * یک منبع، تا هر مسیری که از `actorStanding` محافظت می‌گیرد، همان جملهٔ
 * آشنای بازیکن را بگوید — نه یک متنِ تازه که فقط همان‌جا وجود دارد.
 */
export async function denyBlockedActor(ctx: Context, standing: ActorStanding): Promise<void> {
  if (standing === 'banned') {
    await ackCallback(ctx, bannedAlert(), true)
    return
  }
  await ackCallback(ctx, deadAlert(), true)
}

/** پنلِ کاملِ غیرمجاز بودن — برای مسیرهایی که باید پیام جایگزین هم نشان دهند. */
export function blockedActorPanel(standing: ActorStanding): string {
  return standing === 'banned' ? bannedNotice() : deadNotice()
}

/**
 * بررسی متمرکز ورود به یک بخش: سیاست محیط + وضعیت حساب + فعال‌بودن محیط گروه.
 * `true` یعنی آزاد؛ در غیر این صورت خودش پیام انسانی مناسب را نشان
 * داده است (پنل تازه در مسیر پیام، هشدار کوتاه در مسیر دکمه).
 */
export async function guardSectionEntry(
  ctx: Context,
  container: Container,
  section: string,
  via: 'message' | 'callback'
): Promise<boolean> {
  const result = await checkSectionEntry(ctx, container, section)

  if (result === 'allowed') {
    return true
  }

  if (via === 'message') {
    if (result === 'wrong_chat') {
      const text =
        sectionPolicy(section) === 'GROUP_ONLY'
          ? groupOnlyNotice(section)
          : privateOnlyNotice(section)
      await sendPanel(ctx, { text, keyboard: buildClosePanelKeyboard() })
    } else if (result === 'banned') {
      await sendPanel(ctx, { text: bannedNotice(), keyboard: buildClosePanelKeyboard() })
    } else if (result === 'not_setup') {
      await sendPanel(ctx, { text: notSetupNotice(), keyboard: buildClosePanelKeyboard() })
    } else {
      await sendPanel(ctx, { text: deadNotice(), keyboard: buildClosePanelKeyboard() })
    }
    return false
  }

  if (result === 'wrong_chat') {
    const alert =
      sectionPolicy(section) === 'GROUP_ONLY' ? groupOnlyAlert(section) : privateOnlyAlert(section)
    await ackCallback(ctx, alert, true)
  } else if (result === 'banned') {
    await ackCallback(ctx, bannedAlert(), true)
  } else if (result === 'not_setup') {
    await ackCallback(ctx, notSetupAlert(), true)
  } else {
    await ackCallback(ctx, deadAlert(), true)
  }
  return false
}

/**
 * بررسی خالص ورود به بخش، بدون ارسال پیام؛ برای جاهایی که خودشان
 * نحوهٔ نمایش را انتخاب می‌کنند (مثلاً `handleSection` با حالت ویرایش).
 */
export async function checkSectionEntry(
  ctx: Context,
  container: Container,
  section: string
): Promise<EntryGuardResult> {
  if (!isSectionAllowedHere(section, ctx.chat?.type)) {
    return 'wrong_chat'
  }

  if (BAN_EXEMPT_SECTIONS.has(section)) {
    return 'allowed'
  }

  if (PRIVATE_READ_ONLY_SECTIONS.has(section) && !isGroupChat(ctx.chat?.type)) {
    return 'allowed'
  }

  const fromId = ctx.from?.id
  if (fromId === undefined) {
    return 'allowed'
  }

  const standing = await actorStanding(container, BigInt(fromId))
  if (standing === 'banned') {
    return 'banned'
  }
  if (standing === 'dead' && !DEAD_EXEMPT_SECTIONS.has(section)) {
    return 'dead'
  }

  // محیطِ راه‌اندازی‌نشده: بخش‌های گروهیِ بازی فقط در گروهی باز می‌شوند که
  // مدیرش بازی را فعال کرده باشد. نمایشِ وضعیت شخصی (BOTH) ربطی به محیط
  // گروه ندارد و آزاد می‌ماند.
  if (isGroupChat(ctx.chat?.type) && sectionPolicy(section) === 'GROUP_ONLY' && ctx.chat) {
    const group = await container.groupRepository
      .findByTelegramGroupId(BigInt(ctx.chat.id))
      .catch(() => null)
    if (!group) {
      return 'not_setup'
    }
  }

  return 'allowed'
}

/**
 * میان‌افزار سراسری سیاست محیط برای دکمه‌ها.
 * هم ورودی بخش و هم تراکنش و صفحه‌بندی بررسی می‌شوند.
 * ادمین، ثبت‌نام و مالکیت پیام نگهبان‌های مستقل دارند.
 */
export function chatPolicyMiddleware(container: Container) {
  return async (ctx: Context, next: NextFunction): Promise<void> => {
    const data = ctx.callbackQuery?.data
    if (data) {
      const section = ENTRY_CALLBACK_SECTION[data] ?? CALLBACK_PREFIX_SECTION[data.split(':')[0]!]
      if (section && !(await guardSectionEntry(ctx, container, section, 'callback'))) {
        return
      }
    }
    await next()
  }
}

/** ثبت میان‌افزار روی ربات؛ از bot.ts صدا زده می‌شود. */
export function registerChatPolicy(bot: Bot, container: Container): void {
  bot.use(chatPolicyMiddleware(container))
}
