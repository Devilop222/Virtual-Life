import { join } from 'path'
import { readText } from './helpers/source'
import { groupOnlyAlert, groupOnlyNotice } from '../src/bot/chat-policy'
import { EXACT_SECTIONS, SECTION_KEYWORDS, catalogForPolicy, sectionTitle } from '../src/bot/command-catalog'
import { normalizePersianText } from '../src/utils/commands'

const SRC = readText(join(__dirname, '..', 'src/bot/handlers/features.handler.ts'))

describe('پیام یکدست «این بخش در گروه است»', () => {
  test('برای هر بخش گروه‌محور، نام و کلمهٔ درست همان بخش را می‌گوید', () => {
    for (const entry of catalogForPolicy('GROUP_ONLY')) {
      const keyword = SECTION_KEYWORDS[entry.section]!
      expect(EXACT_SECTIONS[normalizePersianText(keyword)]).toBe(entry.section)
      expect(groupOnlyNotice(entry.section)).toContain(`«${keyword}»`)
      expect(groupOnlyNotice(entry.section)).toContain(entry.title)
      expect(groupOnlyAlert(entry.section)).toContain(`«${keyword}»`)
      expect(groupOnlyAlert(entry.section)).toContain(entry.title)
    }
  })

  test('سه بخش هم‌خانواده از یک منبع متن استفاده می‌کنند', () => {
    // ریشهٔ باگ قبلی: مزایده، چالش و قوانین هرکدام پیام دست‌ساز و متفاوت داشتند؛
    // حالا هر سه از همان سازندهٔ مرکزی سیاست محیط می‌آیند.
    const sections = ['auction', 'challenge', 'policy'] as const
    const skeleton = (section: string) => {
      const words = [sectionTitle(section), SECTION_KEYWORDS[section]!]
      return groupOnlyNotice(section).replace(new RegExp(words.join('|'), 'g'), '§')
    }
    expect(new Set(sections.map(skeleton)).size).toBe(1)
    expect(SRC).toContain("section === 'auction' || section === 'challenge' || section === 'policy'")
    // فقط یک بار صدا زده می‌شود تا هیچ مسیر دست‌ساز دیگری باقی نماند
    expect(SRC.match(/groupOnlyNotice\(/g)!.length).toBe(1)
    expect(SRC).not.toContain('کاربردی نیست')
  })

  test('بخش ناشناخته هم پیام عمومی و بی‌خطا می‌گیرد', () => {
    const text = groupOnlyNotice('no_such_section')
    expect(text).not.toContain('undefined')
    expect(text).not.toContain('no_such_section')
    expect(text).toContain('در گروه')
  })
})
