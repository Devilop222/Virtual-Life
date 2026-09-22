import { parseAmountDetailed, parseAmountInput, parseTransferCommand } from '../src/utils/commands'

describe('parseAmountInput', () => {
  test('accepts plain ASCII digits', () => {
    expect(parseAmountInput('500000')).toBe(500000)
  })

  test('accepts Persian digits', () => {
    expect(parseAmountInput('۵۰۰۰۰۰')).toBe(500000)
  })

  test('accepts Arabic digits', () => {
    expect(parseAmountInput('٥٠٠٠٠٠')).toBe(500000)
  })

  test('strips thousands separators', () => {
    expect(parseAmountInput('500,000')).toBe(500000)
    expect(parseAmountInput('۵۰۰٬۰۰۰')).toBe(500000)
  })

  test('accepts surrounding whitespace', () => {
    expect(parseAmountInput('  1000  ')).toBe(1000)
  })

  test('rejects zero and negative values', () => {
    expect(parseAmountInput('0')).toBeNull()
    expect(parseAmountInput('-1000')).toBeNull()
  })

  test('accepts K and M suffixes', () => {
    expect(parseAmountInput('110k')).toBe(110_000)
    expect(parseAmountInput('110K')).toBe(110_000)
    expect(parseAmountInput('1.5K')).toBe(1500)
    expect(parseAmountInput('1M')).toBe(1_000_000)
    expect(parseAmountInput('2.5m')).toBe(2_500_000)
  })

  test('accepts Persian digits with suffix', () => {
    expect(parseAmountInput('۵۰k')).toBe(50_000)
    expect(parseAmountInput('۲M')).toBe(2_000_000)
  })

  test('rejects non-numeric input', () => {
    expect(parseAmountInput('مبلغ')).toBeNull()
    expect(parseAmountInput('abc')).toBeNull()
    expect(parseAmountInput('')).toBeNull()
  })
})

/**
 * «میلیون» خودش حرفِ «و» دارد. اگر جداکنندهٔ حرف ربط کورکورانه روی هر «و»
 * بزند، «100 میلیون» به «100میلی» + «ن» می‌شکند و ورودیِ کاملاً درست رد
 * می‌شود — همان باگی که بازیکن در انتقال پول می‌دید.
 */
describe('مضارب واژه‌ای و حرف ربط «و»', () => {
  test('واژهٔ «میلیون» با هر رقم و با «تومان» خوانده می‌شود', () => {
    expect(parseAmountInput('100 میلیون')).toBe(100_000_000)
    expect(parseAmountInput('۱۰۰ میلیون')).toBe(100_000_000)
    expect(parseAmountInput('100 میلیون تومان')).toBe(100_000_000)
    expect(parseAmountInput('۱۰۰ میلیون تومان')).toBe(100_000_000)
    expect(parseAmountInput('100میلیون')).toBe(100_000_000)
  })

  test('«میلیارد» و اعشار درست خوانده می‌شوند', () => {
    expect(parseAmountInput('1 میلیارد')).toBe(1_000_000_000)
    expect(parseAmountInput('۲ میلیارد')).toBe(2_000_000_000)
    expect(parseAmountInput('1.5 میلیارد')).toBe(1_500_000_000)
    expect(parseAmountInput('۱٫۵ میلیارد')).toBe(1_500_000_000)
    expect(parseAmountInput('2.5 میلیون')).toBe(2_500_000)
  })

  test('«هزار» و «نیم» پشتیبانی می‌شوند', () => {
    expect(parseAmountInput('500 هزار')).toBe(500_000)
    expect(parseAmountInput('نیم میلیون')).toBe(500_000)
    expect(parseAmountInput('نیم میلیارد')).toBe(500_000_000)
  })

  test('حرف ربط «و» جمع می‌کند، ولی واژهٔ میلیون را نمی‌شکند', () => {
    expect(parseAmountInput('2 میلیون و 500 هزار')).toBe(2_500_000)
    expect(parseAmountInput('۱۰۰ میلیون و ۵۰۰ هزار')).toBe(100_500_000)
    expect(parseAmountInput('1 میلیارد و 200 میلیون')).toBe(1_200_000_000)
    // «و» چسبیده به رقم بعدی هم جداکننده است.
    expect(parseAmountInput('2 میلیون و500 هزار')).toBe(2_500_000)
  })

  test('واژهٔ ناشناخته رد می‌شود، نه بی‌صدا صفر', () => {
    expect(parseAmountInput('صد میلیون')).toBeNull()
    expect(parseAmountInput('100 میلیون ریال')).toBeNull()
    expect(parseAmountInput('میلیون')).toBeNull()
  })

  test('سرریز و سقف با دلیلِ دقیق رد می‌شوند', () => {
    expect(parseAmountDetailed('1000000000000000000000')).toEqual({
      ok: false,
      reason: 'too_large'
    })
    expect(parseAmountDetailed('999999999999999999999 میلیارد')).toEqual({
      ok: false,
      reason: 'too_large'
    })
    expect(parseAmountDetailed('100 میلیون', { max: 50_000_000 })).toEqual({
      ok: false,
      reason: 'too_large'
    })
    // سقف، ورودیِ مرزیِ خودش را رد نمی‌کند.
    expect(parseAmountDetailed('50 میلیون', { max: 50_000_000 })).toEqual({
      ok: true,
      value: 50_000_000
    })
  })

  test('صفر و منفی با دلیلِ خودشان برمی‌گردند', () => {
    expect(parseAmountDetailed('0')).toEqual({ ok: false, reason: 'zero' })
    expect(parseAmountDetailed('0 میلیون')).toEqual({ ok: false, reason: 'zero' })
    expect(parseAmountDetailed('-5 میلیون')).toEqual({ ok: false, reason: 'negative' })
    expect(parseAmountDetailed('0', { allowZero: true })).toEqual({ ok: true, value: 0 })
  })
})

describe('parseTransferCommand', () => {
  test('مبلغِ ساده و مبلغِ میلیونیِ کوتاه هر دو خوانده می‌شوند', () => {
    expect(parseTransferCommand('انتقال ۵۰۰۰۰۰')).toEqual({
      kind: 'transfer',
      amount: 500_000
    })
    expect(parseTransferCommand('انتقال 100 میلیون')).toEqual({
      kind: 'transfer',
      amount: 100_000_000
    })
    expect(parseTransferCommand('انتقال پول 1.5 میلیارد')).toEqual({
      kind: 'transfer',
      amount: 1_500_000_000
    })
  })

  test('متنِ بی‌ربط دستور انتقال نیست', () => {
    expect(parseTransferCommand('سلام')).toEqual({ kind: 'none' })
    expect(parseTransferCommand('')).toEqual({ kind: 'none' })
  })

  test('کلیدواژهٔ بی‌مبلغ و مبلغِ نامعتبر، خطای خودشان را دارند', () => {
    expect(parseTransferCommand('انتقال')).toEqual({
      kind: 'transfer_invalid',
      reason: 'missing_amount'
    })
    expect(parseTransferCommand('انتقال صفر')).toEqual({
      kind: 'transfer_invalid',
      reason: 'not_a_number'
    })
  })
})
