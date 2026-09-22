import {
  buildStartGuideKeyboard,
  buildStartGuidePages,
  parseStartGuideCallback,
  renderStartGuidePage
} from '../src/bot/start-guide'
import { EXACT_SECTIONS, SECTION_KEYWORDS } from '../src/bot/command-catalog'
import { normalizePersianText } from '../src/utils/commands'

/**
 * راهنمای شروعِ بازیکنِ ثبت‌شده:
 *  • دو حالته بودن /start — بازیکنِ بی‌شخصیت آنبوردینگ می‌گیرد، بازیکنِ
 *    دارای شخصیت این راهنمای چندصفحه‌ای را (نه دوباره «شخصیتت را بساز»).
 *  • هر کلمهٔ کلیدیِ معرفی‌شده باید واقعاً در کاتالوگ بخش‌ها وجود داشته باشد.
 */

describe('start guide pages', () => {
  test('the guide has the full multi-page walk (≥۶ صفحه)', () => {
    const pages = buildStartGuidePages()
    expect(pages.length).toBeGreaterThanOrEqual(6)
  })

  test('page 1 welcomes back — it never says “build your character”', () => {
    const rendered = renderStartGuidePage(0)!
    expect(rendered.text).toContain('خوش برگشتی')
    expect(rendered.text).not.toContain('شخصیتت را بساز')
  })

  test('every quoted keyword in the guide really opens a section', () => {
    for (const page of buildStartGuidePages()) {
      for (const section of page.sections) {
        for (const line of section.lines ?? []) {
          for (const match of line.matchAll(/«([^»]+)»/g)) {
            const word = normalizePersianText(match[1]!)
            const isCatalogKeyword = Object.values(SECTION_KEYWORDS).some(
              (k) => normalizePersianText(k) === word
            )
            if (isCatalogKeyword) {
              expect(EXACT_SECTIONS[word]).toBeDefined()
            }
          }
        }
      }
    }
  })

  test('guide keywords are drawn from the live catalog (structure check)', () => {
    // راهنما (در هر صفحه‌ای) باید بخش‌های «اولین کارها» را با کلمهٔ واقعی کاتالوگ بپوشاند
    const all = buildStartGuidePages()
      .flatMap((page) => page.sections.flatMap((s) => s.lines ?? []))
      .join('\n')
    expect(all).toContain(`«${SECTION_KEYWORDS['identity']}»`)
    expect(all).toContain(`«${SECTION_KEYWORDS['occupation']}»`)
    expect(all).toContain(`«${SECTION_KEYWORDS['banking']}»`)
  })

  test('هر خط کلمه، کاربردِ آن را هم می‌گوید — نه تکرارِ خودِ کلمه', () => {
    // قالب قدیمی «شناسنامه: «شناسنامه»» خطی بود که چیزی به بازیکن نمی‌گفت.
    const lines = buildStartGuidePages().flatMap((page) =>
      page.sections.flatMap((s) => s.lines ?? [])
    )
    const keywordLines = lines.filter((line) =>
      Object.values(SECTION_KEYWORDS).some((k) => line.startsWith(`«${k}»`))
    )
    expect(keywordLines.length).toBeGreaterThan(0)
    for (const line of keywordLines) {
      expect(line).toMatch(/^«[^»]+» — .{8,}/u)
    }
    for (const line of lines) {
      const repeated = line.match(/^([^:]+): «([^»]+)»\s*$/)
      if (repeated) expect(repeated[1]).not.toBe(repeated[2])
    }
  })

  test('out-of-range pages render nothing and parse to null', () => {
    const total = buildStartGuidePages().length
    expect(renderStartGuidePage(-1)).toBeNull()
    expect(renderStartGuidePage(total)).toBeNull()
    expect(parseStartGuideCallback(`guide:page:${total}`)).toBeNull()
    expect(parseStartGuideCallback('guide:page:-1')).toBeNull()
    expect(parseStartGuideCallback('guide:page:x')).toBeNull()
    expect(parseStartGuideCallback('guide:page:0')).toBe(0)
    expect(parseStartGuideCallback('other:0')).toBeNull()
  })

  test('navigation keyboard: first page has no previous, last page offers the full help', () => {
    const total = buildStartGuidePages().length

    const first = buildStartGuideKeyboard(0)
    const firstData = first.inline_keyboard.flat().map((b) => ('callback_data' in b ? b.callback_data : undefined))
    expect(firstData).not.toContain('guide:page:-1')
    expect(firstData).toContain('guide:page:1')

    const last = buildStartGuideKeyboard(total - 1)
    const lastData = last.inline_keyboard.flat().map((b) => ('callback_data' in b ? b.callback_data : undefined))
    expect(lastData).toContain(`guide:page:${total - 2}`)
    expect(lastData).toContain('help:main')
    expect(lastData).not.toContain(`guide:page:${total}`)

    // دکمهٔ شمارهٔ صفحه همیشه همان صفحه را دوباره باز می‌کند (بی‌خرابکاری)
    expect(lastData).toContain(`guide:page:${total - 1}`)
  })
})
