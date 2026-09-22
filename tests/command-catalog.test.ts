import { join } from 'path'
import { readText } from './helpers/source'
import {
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
} from '../src/bot/command-catalog'
import { ADMIN_PHRASES } from '../src/bot/handlers/admin.handler'
import { HELP_TOPICS } from '../src/bot/help-content'
import { normalizePersianText } from '../src/utils/commands'

const SRC = (rel: string) => readText(join(__dirname, '..', rel))

/** بخش‌هایی که واقعاً در مسیر پیام رسیدگی می‌شوند (از متن هندلرها). */
function routedSections(): Set<string> {
  const out = new Set<string>()
  const text = SRC('src/bot/handlers/text.handler.ts')
  const features = SRC('src/bot/handlers/features.handler.ts')
  for (const match of text.matchAll(/section === '([a-z_]+)'/g)) out.add(match[1]!)
  for (const match of text.matchAll(/case '([a-z_]+)':/g)) out.add(match[1]!)
  for (const match of features.matchAll(/section === '([a-z_]+)'/g)) out.add(match[1]!)
  for (const match of features.matchAll(/case '([a-z_]+)':/g)) out.add(match[1]!)
  return out
}

describe('کاتالوگ مرکزی دستورهای متنی', () => {
  test('هر کلیدواژه از نرمال‌ساز خودش جان سالم به در می‌برد', () => {
    for (const key of Object.keys(EXACT_SECTIONS)) {
      expect(normalizePersianText(key)).toBe(key)
    }
  })

  test('هیچ کلیدواژه‌ای با کلیدواژهٔ دیگری برخورد ندارد', () => {
    const seen = new Map<string, string>()
    for (const [key, section] of Object.entries(EXACT_SECTIONS)) {
      const normalized = normalizePersianText(key)
      expect(seen.get(normalized)).toBeUndefined()
      seen.set(normalized, section)
    }
    expect(seen.size).toBe(Object.keys(EXACT_SECTIONS).length)
  })

  test('عبارت‌های مدیریتی هیچ‌وقت با کلیدواژهٔ بازی برخورد نمی‌کنند', () => {
    for (const phrase of Object.keys(ADMIN_PHRASES)) {
      expect(EXACT_SECTIONS[normalizePersianText(phrase)]).toBeUndefined()
    }
  })

  test('کلیدواژهٔ طبیعی «شناسنامه» و شکل‌های رایجش به بخش هویت می‌رسد', () => {
    const naturalForms = [
      'شناسنامه',
      'شناسنامه.',
      '🪪 شناسنامه',
      'شناسنامه من',
      'شناسنامه‌ی من',
      'شناسنامه‌ام',
      'کارت شناسایی',
      'اطلاعات من',
      'مشخصات من',
      'مشخصات'
    ]
    for (const form of naturalForms) {
      const normalized = normalizePersianText(form)
      expect(EXACT_SECTIONS[normalized]).toBe('identity')
    }
  })

  test('هر بخش سیاست، عنوان و کلیدواژهٔ انسانی دارد', () => {
    for (const section of ALL_SECTIONS) {
      expect(SECTION_CHAT_POLICY[section]).toMatch(/^(GROUP_ONLY|PRIVATE_ONLY|BOTH)$/)
      expect(SECTION_TITLES[section]!.length).toBeGreaterThan(0)
      expect(sectionTitle(section)).not.toBe('این بخش')
      expect(SECTION_KEYWORDS[section]!.length).toBeGreaterThan(0)
      expect(sectionKeyword(section)).not.toBe(section)
    }
  })

  test('کلیدواژهٔ پیشنهادی هر بخش واقعاً همان بخش را باز می‌کند', () => {
    // ریشهٔ باگ قبلی: کلمهٔ پیشنهادی «وضعیت منطقه» کلمهٔ «شهر» بود و
    // پیام هدایت، بازیکن را به بخش دیگری می‌فرستاد.
    for (const [section, keyword] of Object.entries(SECTION_KEYWORDS)) {
      expect(EXACT_SECTIONS[normalizePersianText(keyword)]).toBe(section)
    }
  })

  test('هر بخش حداقل یک کلیدواژه دارد و هر کلیدواژه بخش شناخته‌شده', () => {
    const sectionsWithKeyword = new Set(Object.values(EXACT_SECTIONS))
    for (const section of ALL_SECTIONS) {
      expect(sectionsWithKeyword.has(section)).toBe(true)
    }
    for (const section of sectionsWithKeyword) {
      expect(SECTION_CHAT_POLICY[section]).toBeDefined()
    }
  })

  test('هر کلیدواژه به بخشی می‌رسد که واقعاً رسیدگی می‌شود', () => {
    const routed = routedSections()
    for (const section of new Set(Object.values(EXACT_SECTIONS))) {
      expect(routed.has(section)).toBe(true)
    }
  })

  test('کاتالوگ بر پایهٔ سیاست محیط کامل و بدون تکرار است', () => {
    const grouped = [...catalogForPolicy('GROUP_ONLY'), ...catalogForPolicy('BOTH'), ...catalogForPolicy('PRIVATE_ONLY')]
    expect(grouped.length).toBe(ALL_SECTIONS.length)
    expect(new Set(grouped.map((entry) => entry.section)).size).toBe(ALL_SECTIONS.length)
    for (const entry of grouped) {
      expect(sectionPolicy(entry.section)).toBe(entry.policy)
      expect(EXACT_SECTIONS[normalizePersianText(entry.keyword)]).toBe(entry.section)
      for (const synonym of entry.synonyms) {
        expect(EXACT_SECTIONS[synonym]).toBe(entry.section)
      }
    }
  })

  test('راهنما هر کلیدواژهٔ بازیکن را مستند می‌کند', () => {
    // دو فهرست راهنما: کلیدواژه‌های چت خصوصی و کلیدواژه‌های گروه.
    const bodyOf = (key: string) => HELP_TOPICS.find((topic) => topic.key === key)!.body
    const documented = (bodyOf('commands') + '\n' + bodyOf('commands_group'))
      .split('\n')
      .filter((line) => !line.startsWith('💡') && !line.startsWith('⚠️'))
      .join('\n')
    for (const entry of catalogForPolicy('BOTH')
      .concat(catalogForPolicy('PRIVATE_ONLY'))
      .concat(catalogForPolicy('GROUP_ONLY'))) {
      expect(documented).toContain(`«${entry.keyword}»`)
    }
  })

  test('سیاست محیط در ماتریس گروه/خصوصی درست عمل می‌کند', () => {
    expect(isSectionAllowedHere('market', 'private')).toBe(false)
    expect(isSectionAllowedHere('market', 'supergroup')).toBe(true)
    expect(isSectionAllowedHere('invite', 'private')).toBe(true)
    expect(isSectionAllowedHere('invite', 'group')).toBe(false)
    expect(isSectionAllowedHere('identity', 'private')).toBe(true)
    expect(isSectionAllowedHere('identity', 'group')).toBe(true)
  })
})
