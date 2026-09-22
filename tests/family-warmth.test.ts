import {
  ACTIVITY_WARMTH_GAIN,
  BONUS_WARMTH_GAIN,
  coupleBonusMultiplier,
  coupleBonusOf,
  decayedWarmth,
  gainWarmth,
  giftWarmthGain,
  GIFT_MAX,
  GIFT_MIN,
  WARMTH_INITIAL,
  WARMTH_MAX,
  WARMTH_MIN,
  warmthLabel
} from '../src/modules/family/family-warmth'

const DAY = 86_400_000

describe('Family warmth — decay over neglect', () => {
  const anchor = Date.UTC(2026, 8, 1)

  test('a fresh marriage keeps full warmth on day one', () => {
    expect(decayedWarmth(WARMTH_INITIAL, anchor, anchor)).toBe(WARMTH_INITIAL)
    // کمتر از یک روز کامل هنوز فرسایش ندارد
    expect(decayedWarmth(WARMTH_INITIAL, anchor, anchor + DAY - 1)).toBe(WARMTH_INITIAL)
  })

  test('every full day without interaction costs one warmth point', () => {
    expect(decayedWarmth(100, anchor, anchor + DAY)).toBe(99)
    expect(decayedWarmth(100, anchor, anchor + 10 * DAY)).toBe(90)
    expect(decayedWarmth(100, anchor, anchor + 10 * DAY + 1000)).toBe(90)
  })

  test('warmth never decays below the floor — the marriage is never hopeless', () => {
    expect(decayedWarmth(100, anchor, anchor + 1000 * DAY)).toBe(WARMTH_MIN)
    expect(decayedWarmth(20, anchor, anchor + 100 * DAY)).toBe(WARMTH_MIN)
  })

  test('corrupt stored values read as a warm start, never as a punishment', () => {
    expect(decayedWarmth(Number.NaN, anchor, anchor)).toBe(WARMTH_INITIAL)
    expect(decayedWarmth(500, anchor, anchor)).toBe(WARMTH_MAX)
    expect(decayedWarmth(-5, anchor, anchor)).toBe(WARMTH_MIN)
  })
})

describe('Family warmth — couple bonus multiplier', () => {
  test('a warm marriage earns the full bonus; neglect shrinks it in steps', () => {
    expect(coupleBonusMultiplier(100)).toBe(1)
    expect(coupleBonusMultiplier(80)).toBe(1)
    expect(coupleBonusMultiplier(79)).toBe(0.8)
    expect(coupleBonusMultiplier(60)).toBe(0.8)
    expect(coupleBonusMultiplier(59)).toBe(0.6)
    expect(coupleBonusMultiplier(40)).toBe(0.6)
    expect(coupleBonusMultiplier(39)).toBe(0.5)
    expect(coupleBonusMultiplier(WARMTH_MIN)).toBe(0.5)
  })

  test('the paid amount is the base scaled by the multiplier, rounded', () => {
    expect(coupleBonusOf(100, 50_000)).toBe(50_000)
    expect(coupleBonusOf(70, 50_000)).toBe(40_000)
    expect(coupleBonusOf(45, 50_000)).toBe(30_000)
    expect(coupleBonusOf(20, 50_000)).toBe(25_000)
  })

  test('newlyweds are never punished: initial warmth pays the historical base amount', () => {
    expect(coupleBonusOf(WARMTH_INITIAL, 50_000)).toBe(50_000)
  })
})

describe('Family warmth — gifts and gains', () => {
  test('a gift below the minimum earns nothing (it is not a valid gift)', () => {
    expect(giftWarmthGain(GIFT_MIN - 1)).toBe(0)
    expect(giftWarmthGain(0)).toBe(0)
    expect(giftWarmthGain(Number.NaN)).toBe(0)
  })

  test('every valid gift shows care: at least one point, then one per 500k', () => {
    expect(giftWarmthGain(GIFT_MIN)).toBe(1)
    expect(giftWarmthGain(500_000)).toBe(1)
    expect(giftWarmthGain(999_999)).toBe(1)
    expect(giftWarmthGain(1_000_000)).toBe(2)
    expect(giftWarmthGain(2_500_000)).toBe(5)
  })

  test('one giant gift cannot buy a whole relationship — gain is capped', () => {
    expect(giftWarmthGain(GIFT_MAX)).toBe(8)
    expect(giftWarmthGain(1_000_000_000)).toBe(8)
  })

  test('gains stack but never exceed the ceiling', () => {
    expect(gainWarmth(98, ACTIVITY_WARMTH_GAIN)).toBe(WARMTH_MAX)
    expect(gainWarmth(100, BONUS_WARMTH_GAIN)).toBe(WARMTH_MAX)
    expect(gainWarmth(50, -5)).toBe(50) // رشد منفی وجود ندارد
  })

  test('labels describe the four relationship states', () => {
    expect(warmthLabel(90)).toBe('صمیمی')
    expect(warmthLabel(65)).toBe('پایدار')
    expect(warmthLabel(45)).toBe('سرد')
    expect(warmthLabel(20)).toBe('در آستانهٔ بحران')
  })
})
