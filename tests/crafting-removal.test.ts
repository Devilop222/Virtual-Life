/**
 * قفلِ حذفِ کاملِ «کارگاه».
 *
 * چرا حذف شد: کارگاه یک Sink بود که موادِ اولیهٔ *سودمند* را به آیتم‌های
 * کاملاً بی‌اثر تبدیل می‌کرد. خروجی‌ها با `effects: {}` ساخته می‌شدند (هیچ
 * اثری روی سلامت/خستگی/تجربه نداشتند) و قیمتِ خودشان از جمعِ موادِ اولیه
 * کمتر بود؛ پس نه مصرف‌شدنی بودند، نه خریداری داشتند، نه بازگشتِ سرمایه.
 * یک وعدهٔ محصول بدون backend — همان چیزی که نباید در بازی بماند.
 *
 * این آزمون تضمین می‌کند هیچ بازماندهٔ مسیردهی برنگردد: کلیدواژه، عنوان،
 * سیاست محیط، پیشوندِ callback، دکمهٔ کیبورد و مبحثِ راهنما.
 */
import { join } from 'path'
import { existsSync } from 'fs'
import {
  ALL_SECTIONS,
  EXACT_SECTIONS,
  SECTION_CHAT_POLICY,
  SECTION_KEYWORDS,
  SECTION_TITLES
} from '../src/bot/command-catalog'
import { CALLBACK_PREFIX_SECTION, UNMAPPED_CALLBACK_PREFIXES } from '../src/bot/chat-policy'
import { HELP_TOPICS, getHelpTopic } from '../src/bot/help-content'
import { buildHousingMenuKeyboard } from '../src/bot/keyboards/main.keyboard'
import { readText } from './helpers/source'

const SECTION = 'craft'
const KEYWORD = 'کارگاه'

describe('کارگاه به‌طور کامل حذف شده است', () => {
  test('هیچ بخشی با شناسهٔ craft در کاتالوگ نیست', () => {
    expect(SECTION_CHAT_POLICY[SECTION]).toBeUndefined()
    expect(SECTION_TITLES[SECTION]).toBeUndefined()
    expect(SECTION_KEYWORDS[SECTION]).toBeUndefined()
    expect(ALL_SECTIONS).not.toContain(SECTION)
  })

  test('کلیدواژهٔ «کارگاه» دیگر به هیچ بخشی نمی‌رسد', () => {
    expect(EXACT_SECTIONS[KEYWORD]).toBeUndefined()
    const sections = Object.values(EXACT_SECTIONS)
    expect(sections).not.toContain(SECTION)
  })

  test('هیچ پیشوندِ callback مربوط به کارگاه نگاشت نشده', () => {
    const craftPrefixes = Object.keys(CALLBACK_PREFIX_SECTION).filter((key) =>
      key.startsWith(`${SECTION}`)
    )
    expect(craftPrefixes).toEqual([])
    expect(CALLBACK_PREFIX_SECTION['craft:main']).toBeUndefined()
    expect(UNMAPPED_CALLBACK_PREFIXES[SECTION]).toBeUndefined()
  })

  test('مبحثِ راهنمای کارگاه دیگر وجود ندارد', () => {
    expect(getHelpTopic(SECTION)).toBeUndefined()
    expect(HELP_TOPICS.some((topic) => topic.key === SECTION)).toBe(false)
  })

  test('دکمهٔ کارگاه از کیبورد خانه حذف شده است', () => {
    const buttons = buildHousingMenuKeyboard(false).inline_keyboard.flat()
    const craftButtons = buttons.filter(
      (button) => 'callback_data' in button && button.callback_data.startsWith(`${SECTION}:`)
    )
    expect(craftButtons).toEqual([])
  })

  test('سرویس و ماژولِ کارگاه از سورس پاک شده‌اند', () => {
    const container = readText(join(__dirname, '..', 'src', 'services', 'container.ts'))
    expect(container).not.toMatch(/craftService|CraftService/)

    expect(existsSync(join(__dirname, '..', 'src', 'modules', 'crafting'))).toBe(false)
  })

  test('هیچ فایلی در لایهٔ ربات callback کارگاه نمی‌سازد یا نمی‌شنود', () => {
    const features = readText(
      join(__dirname, '..', 'src', 'bot', 'handlers', 'features.handler.ts')
    )
    const keyboard = readText(
      join(__dirname, '..', 'src', 'bot', 'keyboards', 'main.keyboard.ts')
    )
    const renders = readText(join(__dirname, '..', 'src', 'bot', 'renders.ts'))

    for (const [name, content] of Object.entries({ features, keyboard, renders })) {
      expect(`${name}:${/craft/i.test(content) ? 'leak' : 'clean'}`).toBe(`${name}:clean`)
    }
  })
})
