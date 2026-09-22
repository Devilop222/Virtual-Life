import {
  biographySchema,
  genderSchema,
  plainInput,
  safeCallbackSchema
} from '../src/utils/validation'
import { Gender } from '@prisma/client'

describe('Validation schemas', () => {
  describe('biographySchema', () => {
    test('accepts a valid biography', () => {
      expect(biographySchema.safeParse('من یک بازیکن دنیای مجازی هستم').success).toBe(true)
    })

    test('rejects too-short biography', () => {
      const result = biographySchema.safeParse('a')
      expect(result.success).toBe(false)
    })

    test('rejects too-long biography', () => {
      const result = biographySchema.safeParse('ب'.repeat(601))
      expect(result.success).toBe(false)
    })

    test('trims surrounding whitespace', () => {
      const result = biographySchema.parse('  بیوگرافی من  ')
      expect(result).toBe('بیوگرافی من')
    })
  })

  describe('genderSchema', () => {
    test('accepts valid genders', () => {
      expect(genderSchema.safeParse(Gender.MALE).success).toBe(true)
      expect(genderSchema.safeParse(Gender.FEMALE).success).toBe(true)
    })

    test('rejects invalid values', () => {
      expect(genderSchema.safeParse('OTHER').success).toBe(false)
    })
  })

  describe('safeCallbackSchema', () => {
    test('accepts safe callback data', () => {
      expect(safeCallbackSchema.safeParse('reg:gender:MALE').success).toBe(true)
    })

    test('rejects dangerous characters', () => {
      expect(safeCallbackSchema.safeParse("reg:gender:MALE'; DROP TABLE;").success).toBe(false)
    })
  })

  describe('plainInput', () => {
    test('strips markdown characters from free user text', () => {
      expect(plainInput('نام*حیوان_من')).toBe('نامحیوانمن')
      expect(plainInput('`متن` آگهی [تست]')).toBe('متن آگهی تست')
    })

    test('trims whitespace and keeps normal Persian text intact', () => {
      expect(plainInput('  سلام دنیا  ')).toBe('سلام دنیا')
    })
  })
})