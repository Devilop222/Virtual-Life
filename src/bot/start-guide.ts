import { InlineKeyboard } from 'grammy'
import type { Context } from 'grammy'
import { panel, fa } from './ui-kit'
import { BRAND } from '../config/brand'
import { EXACT_SECTIONS, SECTION_KEYWORDS, SECTION_PURPOSE } from './command-catalog'
import { normalizePersianText } from '../utils/commands'
import { editPanel, sendPanel, ackCallback } from './panel'

/**
 * راهنمای شروع — چند صفحهٔ کوتاه برای بازیکنی که شخصیتش را ساخته است.
 *
 * چرا جدا از «راهنما»؟ «راهنما» مرجع کامل بازی است؛ این‌جا نقشهٔ آغاز مسیر
 * است: بازی چیست، اولین کارها کدام‌اند، چطور حرکت کنم. /start برای بازیکنِ
 * ثبت‌شده به همین‌جا می‌رسد تا هر بار «شخصیتت را بساز» نشنود.
 *
 * قانون سخت: هیچ کلمه‌ای از حفظ نوشته نمی‌شود. هر کلیدواژه با کاتالوگ مرکزی
 * ساخته می‌شود و آزمون `tests/start-guide.test.ts` می‌سنجد که هر کلمه واقعاً
 * همان بخش را باز می‌کند.
 */

export const START_GUIDE_CALLBACK = 'guide:page'

export interface StartGuidePage {
  icon: string
  title: string
  sections: Parameters<typeof panel>[0]['sections']
  footer?: string
}

/**
 * کلمهٔ درستِ یک بخش، همراه با *کاربرد* آن: «کلمه» — کاربرد.
 *
 * قالب «عنوان: «کلمه»» عمداً کنار گذاشته شد: برای بخش‌هایی که عنوان و
 * کلیدواژه‌شان یکی است («شناسنامه: «شناسنامه»») خطی می‌ساخت که هیچ چیزی به
 * بازیکن نمی‌گفت.
 */
function keywordLine(section: string): string {
  const keyword = SECTION_KEYWORDS[section]
  // بخش بدون کلیدواژه خطش حذف می‌شود، نه اینکه شناسهٔ داخلی به بازیکن برسد.
  if (!keyword) return ''
  const purpose = SECTION_PURPOSE[section]
  return purpose ? `«${keyword}» — ${purpose}` : `«${keyword}»`
}

function keywordLines(sections: string[]): string[] {
  return sections.map(keywordLine).filter((line) => line.length > 0)
}

/** کلیدواژهٔ یک بخش برای ساختن جمله. */
function keyword(section: string): string {
  return `«${SECTION_KEYWORDS[section]}»`
}

/** محتوای صفحه‌ها؛ تابع است تا همیشه با کاتالوگ زندهٔ کلمه‌ها هم‌خوان بماند. */
export function buildStartGuidePages(): StartGuidePage[] {
  return [
    // ── ۱ — احوال‌پرسی و چیستی بازی ─────────────────────────────────────
    {
      icon: '🌍',
      title: `به ${BRAND.nameFa} خوش برگشتی`,
      sections: [
        {
          lines: [
            `${BRAND.nameFa} یک زندگی است که در تلگرام جریان دارد:`,
            'کار می‌کنی، درس می‌خوانی، خانه می‌گیری، ازدواج می‌کنی،',
            'کسب‌وکار راه می‌اندازی و در منطقه‌ات اثر می‌گذاری.',
            '',
            'شخصیتت ساخته شده و ساعت بازی از همین حالا می‌گذرد؛',
            'یعنی زندگی شخصیتت منتظر باز کردن پنل نمی‌ماند.',
            '',
            'این چند صفحه، مسیر شروع را کوتاه و روشن جلوی چشمت می‌گذارد.'
          ]
        }
      ],
      footer: 'برای دیدن بخش‌های بیشتر، بازی را در گروه منطقه‌ات دنبال کن.'
    },

    // ── ۲ — ساعت دنیا ───────────────────────────────────────────────────
    {
      icon: '🕐',
      title: 'ساعت این دنیا',
      sections: [
        {
          lines: [
            'زمان این‌جا تندتر از دنیای واقعی می‌گذرد:',
            '• هر ۱ دقیقهٔ واقعی = ۳۰ دقیقه در بازی',
            '• هر ۴۸ دقیقهٔ واقعی = ۱ روز کامل بازی',
            '• هر ۱ روز واقعی = ۱ ماه بازی',
            '• هر ۱۲ روز واقعی = ۱ سال بازی',
            '',
            'یعنی یک روزِ این دنیا را در کمتر از یک ساعت تجربه می‌کنی.',
            'کار، دستمزد، اجاره و پیری با همین ساعت جلو می‌روند —',
            'حتی وقتی چند ساعتی از بازی دور باشی.'
          ]
        }
      ],
      footer: `ساعت دقیق بازی را در ${keyword('status')} و ${keyword('identity')} ببین.`
    },

    // ── ۳ — اولین کارها ─────────────────────────────────────────────────
    {
      icon: '🧭',
      title: 'اولین کارهایی که به کارت می‌آید',
      sections: [
        {
          title: 'خودت را ببین',
          lines: keywordLines(['identity', 'status', 'skills', 'life'])
        },
        {
          title: 'پول دربیاور',
          lines: keywordLines(['occupation', 'education', 'my_biz'])
        },
        {
          title: 'زندگی را بچین',
          lines: keywordLines(['housing', 'banking', 'clinic', 'home'])
        },
        {
          title: 'محیطت را بشناس',
          lines: keywordLines(['region', 'city', 'news'])
        }
      ],
      footer: 'هیچ‌کدام اجباری نیست؛ ترتیب پیشنهادی در صفحه‌های بعدی است.'
    },

    // ── ۴ — کلمه‌های پرکاربرد ───────────────────────────────────────────
    {
      icon: '⌨️',
      title: 'کلمه‌هایی که زیاد به کارت می‌آید',
      sections: [
        {
          title: 'کارهای روزمره',
          lines: keywordLines([
            'identity',
            'occupation',
            'my_job',
            'education',
            'housing',
            'banking',
            'shop',
            'market',
            'family',
            'rank'
          ])
        },
        {
          title: 'لذت و رقابت',
          lines: keywordLines([
            'quests',
            'fortune',
            'streak',
            'lottery',
            'leaderboard',
            'achievements'
          ])
        },
        {
          title: 'شهر و جامعه',
          lines: keywordLines(['city', 'news', 'challenge', 'policy', 'group_info'])
        }
      ],
      footer: `فهرست کامل کلمه‌ها با کاربرد هر بخش: ${keyword('help')}`
    },

    // ── ۵ — مسیر پیشنهادی ───────────────────────────────────────────────
    {
      icon: '🛤️',
      title: 'مسیر پیشنهادی آغاز',
      sections: [
        {
          lines: [
            `۱. ${keyword('status')} را بفرست تا با وضعیت امروزت شروع کنی.`,
            `۲. اولین درآمد: از ${keyword('occupation')} یک کار پاره‌وقت بگیر.`,
            `۳. آینده‌سازی: با ${keyword('education')} ثبت‌نام کن یا در ${keyword('skills')} مهارتت را بالا ببر.`,
            `۴. سقفی برای خودت: با ${keyword('housing')} خانه بخر یا اجاره کن.`,
            `۵. پس‌انداز: در ${keyword('banking')} حساب باز کن و پس‌انداز را جدی بگیر.`,
            `۶. جایگاهت: با ${keyword('region')} منطقه‌ات را بشناس و در ${keyword('city')} شهر بساز.`
          ]
        },
        {
          lines: [
            'این ترتیب پیشنهادی است، نه قانون؛',
            'میراث تو با انتخاب‌های خودت ساخته می‌شود.'
          ]
        }
      ],
      footer: `هر روز یک قدم: پاداش ${keyword('streak')} و ${keyword('quests')} منتظرت می‌ماند.`
    },

    // ── ۶ — حرکت در بازی ────────────────────────────────────────────────
    {
      icon: '🎮',
      title: 'حرکت در بازی',
      sections: [
        {
          lines: [
            'بازی کاملاً متنی و دکمه‌ای است و دو راهِ حرکت داری:',
            '',
            `⌨️ *کلمه بفرست* — کلمهٔ هر بخش را در چت بنویس، مثل ${keyword('identity')} یا ${keyword('occupation')}.`,
            '🔘 *دکمه بزن* — دکمه‌های زیر پنل‌ها پیش می‌برند و برمی‌گردانند.',
            '',
            'پنل «بازگشت» به همان جایی برمی‌گردد که بودی، و «بستن» پنل را می‌بندد.',
            'اگر ربات از تو عدد یا متنی خواست، جواب را در همان چت بنویس؛',
            'تا ۱۵ دقیقه فرصت داری و با «انصراف» بسته می‌شود.',
            '',
            'هیچ منوی ثابتی پایین صفحه نیست؛ همه‌چیز با کلمه و دکمهٔ درون پنل‌هاست.'
          ]
        }
      ],
      footer: 'این راهنمای شروع با /start همیشه در دسترس است.'
    }
  ]
}

/** صفحهٔ راهنما را به متن پنل تبدیل می‌کند. */
export function renderStartGuidePage(
  pageIndex: number
): { text: string; page: StartGuidePage } | null {
  const pages = buildStartGuidePages()
  if (pageIndex < 0 || pageIndex >= pages.length) {
    return null
  }
  const page = pages[pageIndex]!
  return {
    page,
    text: panel({
      icon: page.icon,
      title: page.title,
      sections: page.sections,
      footer: page.footer
    })
  }
}

/**
 * کیبورد صفحه‌گردان راهنما: قبلی / شماره / بعدی + بستن.
 * در صفحهٔ نخست «قبلی» نیست و در صفحهٔ آخر جایش را
 * «راهنمای کامل» می‌گیرد تا بازیکن به مرجع فصل‌ها برسد.
 */
export function buildStartGuideKeyboard(pageIndex: number): InlineKeyboard {
  const total = buildStartGuidePages().length
  const kb = new InlineKeyboard()
  if (pageIndex > 0) {
    kb.add({ text: '⬅️ قبلی', callback_data: `${START_GUIDE_CALLBACK}:${pageIndex - 1}`, style: 'primary' })
  }
  kb.text(`${fa(pageIndex + 1)} / ${fa(total)}`, `${START_GUIDE_CALLBACK}:${pageIndex}`)
  if (pageIndex + 1 < total) {
    kb.add({ text: 'بعدی ➡️', callback_data: `${START_GUIDE_CALLBACK}:${pageIndex + 1}`, style: 'primary' })
    kb.row().add({ text: 'بستن', callback_data: 'panel:close', style: 'danger' })
  } else {
    kb.row().add({ text: '❓ راهنمای کامل', callback_data: 'help:main', style: 'success' })
    kb.row().add({ text: 'بستن', callback_data: 'panel:close', style: 'danger' })
  }
  return kb
}

/** آیا این callback دادهٔ راهنمای شروع است؟ عدد صفحه را برمی‌گرداند. */
export function parseStartGuideCallback(data: string | undefined): number | null {
  if (!data) return null
  const prefix = `${START_GUIDE_CALLBACK}:`
  if (!data.startsWith(prefix)) return null
  const raw = data.slice(prefix.length)
  if (!/^\d+$/.test(raw)) return null
  const page = Number(raw)
  if (page < 0 || page >= buildStartGuidePages().length) return null
  return page
}

/** گشودن راهنما با ویرایش پنل جاری (دکمه) یا ارسال پنل تازه (متن). */
export async function openStartGuide(
  ctx: Context,
  pageIndex: number,
  via: 'edit' | 'send'
): Promise<void> {
  const rendered = renderStartGuidePage(pageIndex)
  if (!rendered) return
  const keyboard = buildStartGuideKeyboard(pageIndex)
  const options = { text: rendered.text, keyboard }
  if (via === 'edit') {
    await editPanel(ctx, options)
  } else {
    await sendPanel(ctx, options)
  }
}

/** دست‌نخورده بودن پیوند راهنما با کاتالوگ؛ برای آزمون‌ها. */
export function guideKeywordsAreReal(): boolean {
  const pages = buildStartGuidePages()
  for (const page of pages) {
    for (const section of page.sections) {
      for (const line of section.lines ?? []) {
        const matches = line.matchAll(/«([^»]+)»/g)
        for (const match of matches) {
          const word = normalizePersianText(match[1]!)
          // کلمه‌های غیرکلیدواژه (مثل «انصراف») هم باید بی‌خطر باشند؛
          // فقط کلمه‌هایی که ادعای بخش بودن دارند بررسی می‌شوند.
          if (Object.values(SECTION_KEYWORDS).some((k) => normalizePersianText(k) === word)) {
            if (!EXACT_SECTIONS[word]) {
              return false
            }
          }
        }
      }
    }
  }
  return true
}

/**
 * ثبت دکمه‌های صفحه‌گردان راهنمای شروع؛ از start.handler صدا زده می‌شود.
 *
 * راهنمای شروع برای بازیکنی است که شخصیت دارد. کاربرِ بی‌شخصیت (مثلاً از
 * پنل گروه) پنلِ مشترک را ویرایش‌نشدنی می‌بیند و به ثبت‌نام خصوصی هدایت
 * می‌شود؛ پنل گروه برای بقیه دست‌نخورده می‌ماند.
 */
export function registerStartGuideCallbacks(
  bot: import('grammy').Bot,
  container: { playerService: { isRegistered: (id: bigint) => Promise<boolean> } }
): void {
  bot.callbackQuery(new RegExp(`^${START_GUIDE_CALLBACK}:\\d+$`), async (ctx) => {
    const page = parseStartGuideCallback(ctx.callbackQuery?.data)
    if (page === null) {
      await ackCallback(ctx, 'این صفحه از راهنما دیگر در دسترس نیست.', true)
      return
    }
    if (ctx.from) {
      const registered = await container.playerService
        .isRegistered(BigInt(ctx.from.id))
        .catch(() => false)
      if (!registered) {
        await ackCallback(
          ctx,
          'راهنمای شروع برای بازیکنانِ دارای شخصیت است. اول در چت خصوصی ربات /start را بفرست تا شخصیتت ساخته شود.',
          true
        )
        return
      }
    }
    await ackCallback(ctx)
    await openStartGuide(ctx, page, 'edit')
  })
}
