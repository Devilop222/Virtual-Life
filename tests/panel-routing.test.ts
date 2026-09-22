import { normalizePersianText } from '../src/utils/commands'

describe('Exact Panel Trigger Routing (Deterministic Isolation)', () => {
  const expectedRoutes: Record<string, string> = {
    'خانه': 'housing',
    'خونه': 'housing',
    'بانک': 'banking',
    'شناسنامه': 'identity',
    'کار': 'occupation',
    'شغل': 'occupation',
    'تحصیلات': 'education',
    'تحصیل': 'education',
    'دانش': 'education',
    'راهنما': 'help',
    'کمک': 'help'
  }

  test('normalizes Arabic-style Persian input to exact canonical trigger', () => {
    expect(normalizePersianText('خانه')).toBe('خانه')
    expect(normalizePersianText('خونه')).toBe('خونه')
    expect(normalizePersianText('دانش')).toBe('دانش')
  })

  test('normalized trigger maps to the intended panel via exact matching', () => {
    const trigger = normalizePersianText('🏠 خانه')
    expect(expectedRoutes[trigger]).toBe('housing')
  })

  test('irrelevant keywords do not accidentally open other panels', () => {
    // A text containing the substring 'کار' must NOT match 'کار' when fully normalized with emoji/extra words
    expect(normalizePersianText('کارخانه')).not.toBe('کار')
    expect(expectedRoutes[normalizePersianText('کارخانه')]).toBeUndefined()
    expect(expectedRoutes[normalizePersianText('کارگر')]).toBeUndefined()
  })

  test('بیمارستان (hospital) does not match بانک or خانه triggers', () => {
    expect(expectedRoutes[normalizePersianText('بیمارستان')]).toBeUndefined()
  })
})