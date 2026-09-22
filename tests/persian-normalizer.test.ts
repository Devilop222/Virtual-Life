import { normalizePersianText } from '../src/utils/commands'

describe('Enhanced Persian Text Normalizer', () => {
  test('unifies Arabic Kaf to Persian Keheh', () => {
    expect(normalizePersianText('كسب و كار')).toBe('کسب و کار')
  })

  test('unifies Arabic Yeh to Persian Yeh', () => {
    expect(normalizePersianText('زندگي')).toBe('زندگی')
    expect(normalizePersianText('شناسنامي')).toBe('شناسنامی')
  })

  test('normalizes Zero-Width Non-Joiner (ZWNJ) gracefully', () => {
    expect(normalizePersianText('کسب‌وکارهای من')).toBe('کسب وکارهای من')
  })

  test('strips emojis and punctuation cleanly', () => {
    expect(normalizePersianText('🎓 تحصیلات !')).toBe('تحصیلات')
    expect(normalizePersianText('💼 کار')).toBe('کار')
  })
})