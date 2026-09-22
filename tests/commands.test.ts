import {
  normalizePersianText,
  parseCallback,
  validateGenderArg,
  isPersianText
} from '../src/utils/commands'

describe('Persian command utilities', () => {
  describe('normalizePersianText', () => {
    test('strips emojis from keyboard labels', () => {
      expect(normalizePersianText('🪪 شناسنامه')).toBe('شناسنامه')
    })

    test('collapses multiple spaces', () => {
      expect(normalizePersianText('زندگی   من')).toBe('زندگی من')
    })

    test('returns empty string for pure emoji/latin', () => {
      expect(normalizePersianText('hello!!!')).toBe('')
    })
  })

  describe('isPersianText', () => {
    test('detects Persian characters', () => {
      expect(isPersianText('سلام')).toBe(true)
      expect(isPersianText('hello')).toBe(false)
    })
  })

  describe('parseCallback', () => {
    test('parses valid callback data', () => {
      expect(parseCallback('reg:gender:MALE')).toEqual({ action: 'reg', args: ['gender', 'MALE'] })
    })

    test('rejects callback data with unsafe characters', () => {
      expect(parseCallback('reg:gender:MALE<script>')).toBeNull()
    })

    test('rejects overly long callback data', () => {
      expect(parseCallback('a'.repeat(200))).toBeNull()
    })
  })

  describe('validateGenderArg', () => {
    test('accepts valid genders', () => {
      expect(validateGenderArg('MALE')).toBe('MALE')
      expect(validateGenderArg('FEMALE')).toBe('FEMALE')
    })

    test('rejects invalid gender', () => {
      expect(validateGenderArg('OTHER')).toBeNull()
    })
  })
})