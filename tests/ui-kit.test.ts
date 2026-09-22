import {
  panel,
  table,
  bullets,
  numbered,
  fa,
  money,
  bar,
  barWithPercent
} from '../src/bot/ui-kit'
import {
  activityStateLabels,
  playerStatusLabels,
  loanStatusLabels,
  propertyStatusLabels,
  businessStatusLabels,
  workSessionStatusLabels,
  jobPostingStatusLabels,
  jobApplicationStatusLabels,
  label
} from '../src/utils/classes/labels'

describe('UI kit formatting', () => {
  test('fa formats numbers with persian digits and separators', () => {
    expect(fa(1000)).toBe('۱٬۰۰۰')
    expect(fa(0)).toBe('۰')
    expect(fa(null)).toBe('۰')
    expect(fa(undefined)).toBe('۰')
  })

  test('money appends the persian currency unit', () => {
    expect(money(500000)).toContain('تومان')
    expect(money(0)).toBe('۰ تومان')
  })

  test('bar stays inside bounds', () => {
    expect(bar(0, 10)).toBe('▱▱▱▱▱▱▱▱▱▱')
    expect(bar(100, 10)).toBe('▰▰▰▰▰▰▰▰▰▰')
    expect(bar(-50, 10)).toBe('▱▱▱▱▱▱▱▱▱▱')
    expect(bar(500, 10)).toBe('▰▰▰▰▰▰▰▰▰▰')
    expect(bar(50, 10)).toBe('▰▰▰▰▰▱▱▱▱▱')
    expect([...bar(50, 10)]).toHaveLength(10)
  })

  test('barWithPercent shows a persian percentage', () => {
    expect(barWithPercent(50)).toContain('۵۰٪')
  })

  test('table renders label and value on a single line', () => {
    const rows = table([{ label: 'نام', value: 'علی' }])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toBe('نام: علی')
  })

  test('bullets and numbered build persian lists', () => {
    expect(bullets(['یک', 'دو'])).toEqual(['• یک', '• دو'])
    expect(numbered(['یک', 'دو'])).toEqual(['۱. یک', '۲. دو'])
  })

  test('panel puts a bold title above the divider and never trails a border', () => {
    const out = panel({
      icon: '🏦',
      title: 'بانک',
      sections: [{ title: 'حساب', rows: [{ label: 'موجودی', value: '۱۰۰ تومان' }] }],
      footer: 'راهنما'
    })
    const lines = out.split('\n')

    expect(lines[0]).toBe('🏦 *بانک*')
    expect(lines[1]).toBe('')
    expect(out).not.toMatch(/[━┈]/)
    expect(out).toContain('*حساب*')
    expect(out).toContain('موجودی: ۱۰۰ تومان')
    expect(out).toContain('راهنما')
    // پنل نباید با خط جداکننده تمام شود؛ پانویس آخرین سطر است
    expect(out.endsWith('راهنما')).toBe(true)
  })

  test('panel skips sections that would render nothing', () => {
    const out = panel({
      title: 'خالی',
      sections: [{ rows: [] }, { lines: [] }, { lines: ['یک سطر'] }]
    })

    expect(out).toContain('یک سطر')
    expect(out.split('\n').filter((l) => l.trim() === '')).toHaveLength(1)
  })
})

describe('Persian labels for internal enums', () => {
  test('no label map leaks an english value', () => {
    const maps = [
      activityStateLabels,
      playerStatusLabels,
      loanStatusLabels,
      propertyStatusLabels,
      businessStatusLabels,
      workSessionStatusLabels,
      jobPostingStatusLabels,
      jobApplicationStatusLabels
    ]

    for (const map of maps) {
      for (const value of Object.values(map)) {
        expect(value.length).toBeGreaterThan(0)
        // هر برچسب باید حرف فارسی داشته باشد و حروف لاتین نداشته باشد
        expect(/[\u0600-\u06FF]/.test(value)).toBe(true)
        expect(/[A-Za-z]/.test(value)).toBe(false)
      }
    }
  })

  test('label falls back safely for unknown or empty keys', () => {
    expect(label(activityStateLabels, 'WORKING')).toBe('مشغول کار')
    expect(label(activityStateLabels, 'SOMETHING_ELSE')).toBe('نامشخص')
    expect(label(activityStateLabels, null)).toBe('نامشخص')
    expect(label(activityStateLabels, undefined, 'آزاد')).toBe('آزاد')
  })

  test('activity and player status cover every used state', () => {
    expect(Object.keys(activityStateLabels)).toEqual(
      expect.arrayContaining(['IDLE', 'WORKING', 'STUDYING', 'RESTING', 'SLEEPING', 'TRAVELING'])
    )
    expect(Object.keys(playerStatusLabels)).toEqual(
      expect.arrayContaining(['ACTIVE', 'INACTIVE', 'DEAD', 'BANNED'])
    )
  })
})

describe('Telegram-native polish', () => {
  test('a row icon does not repeat the section hierarchy', () => {
    expect(table([{ label: '💰 موجودی', value: '۱۰۰ تومان' }])).toEqual(['موجودی: ۱۰۰ تومان'])
    expect(panel({ icon: '⚠️', title: '⛔ تغییر وضعیت', sections: [] })).toBe('⚠️ *تغییر وضعیت*')
  })
  test('unknown numeric values never render NaN or infinity', () => {
    expect(fa(NaN)).toBe('نامشخص')
    expect(fa(Infinity)).toBe('نامشخص')
  })
})
