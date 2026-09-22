import {
  QUEST_REWARDS,
  HOURLY_FLOOR_WAGE,
  CHEAPEST_SHOP_ITEM
} from '../src/modules/quests/daily-quest.service'
import { STREAK_RULES, streakRewardForDay } from '../src/modules/rewards/rewards.service'
import { FORTUNE_INFO } from '../src/modules/rewards/fortune.service'
import { PART_TIME_JOBS } from '../src/modules/occupation/work-blueprints'
import { SHOP_ITEMS } from '../src/modules/shop/shop-catalog'
import { REST_FATIGUE_PER_REAL_MINUTE } from '../src/modules/housing/housing.service'
import { MAX_FATIGUE } from '../src/modules/life/life-core'
import {
  GAME_HOURS_PER_DAY,
  GAME_MINUTES_PER_HOUR,
  ratePerGameHour,
  ratePerGameMinute
} from '../src/utils/game-time'

/**
 * توازن اقتصاد پاداش‌های روزمره — اندازه‌گیری، نه حدس.
 *
 * اندازه‌گیریِ همین سنجه‌ها بود که یک ایراد واقعی را نشان داد: پاداش کارت
 * روزانه `cycleAmount(40_000)` = ۱٬۳۳۳ تومان بود، در حالی که
 *   • ارزان‌ترین کالای فروشگاه ۵٬۰۰۰ تومان است (کارتِ «خرید از فروشگاه»
 *     کمتر از هزینهٔ همان خریدی می‌داد که خودش می‌خواست)، و
 *   • ارزان‌ترین شغل بازار یک ساعت کار را ۶٬۰۰۰ تومان می‌پردازد،
 * در حالی که استریک روزانه فقط برای یک ضربه ۲٬۵۰۰ تومان می‌داد. یعنی تلاش
 * کمتر از یک ضربه می‌ارزید و کارت عملاً «تراپ» بود.
 *
 * این آزمون همان سنجه‌ها را قفل می‌کند تا دوباره واگرا نشوند. همهٔ عددها از
 * سرویس صاحبشان خوانده می‌شوند؛ هیچ‌کدام در این فایل دست‌نویس نیست.
 */

const GAME_MINUTES_PER_DAY = GAME_HOURS_PER_DAY * GAME_MINUTES_PER_HOUR // ۱۴۴۰

/** ارزان‌ترین شغلِ بازار — کفِ دستمزد ساعت. */
const cheapestJob = PART_TIME_JOBS.reduce((lowest, job) =>
  ratePerGameHour(job.basePayPerMinute) < ratePerGameHour(lowest.basePayPerMinute) ? job : lowest
)

/** یک ساعت کار در پایین‌ترین دستمزد بازار. */
const LOW_END_HOURLY = ratePerGameHour(cheapestJob.basePayPerMinute)

/**
 * دقیقه‌های کاریِ پایدار در یک روزِ بازی.
 *
 * یک بازیکن نمی‌تواند تمام روز کار کند: خستگی که کار می‌سازد باید با استراحت
 * برود. نسبت کار به کار+استراحت همان «چرخهٔ کاری» است و با همان نرخ‌های
 * سرویس حساب می‌شود (خستگیِ شغل و ریکاوری خانه)، پس این عدد هم دست‌نویس نیست.
 */
const workMinutesPerCycle = MAX_FATIGUE / ratePerGameMinute(cheapestJob.fatigueRatePerMinute)
const recoverMinutesPerCycle = MAX_FATIGUE / ratePerGameMinute(REST_FATIGUE_PER_REAL_MINUTE)
const dutyCycle = workMinutesPerCycle / (workMinutesPerCycle + recoverMinutesPerCycle)
const workableMinutesPerDay = Math.floor(GAME_MINUTES_PER_DAY * dutyCycle)

/** درآمد یک روزِ کامل کار در پایین‌ترین دستمزد — مخرجِ همهٔ نسبت‌ها. */
const LOW_END_DAILY_INCOME = Math.round((LOW_END_HOURLY / GAME_MINUTES_PER_HOUR) * workableMinutesPerDay)

/** ارزش انتظاریِ شانس روزانه از همان بازه‌های بیرون‌صادرشدهٔ سرویس. */
function expectedAmount(range: { min: number; step: number; variants: number }): number {
  const meanVariant = (range.variants - 1) / 2
  return range.min + meanVariant * range.step
}
const FORTUNE_EXPECTED_VALUE = Math.round(
  (FORTUNE_INFO.gainChance / 100) * expectedAmount(FORTUNE_INFO.gainRange) +
    (FORTUNE_INFO.jackpotChance / 100) * FORTUNE_INFO.jackpotAmount -
    (FORTUNE_INFO.lossChance / 100) * expectedAmount(FORTUNE_INFO.lossRange)
)

/** پاداش یک روزِ کامل: سه کارت + بونوس روز + استریک روز اول + شانس. */
const DAILY_REWARDS =
  QUEST_REWARDS.cardsPerDay * QUEST_REWARDS.card +
  QUEST_REWARDS.allThree +
  streakRewardForDay(1) +
  FORTUNE_EXPECTED_VALUE

describe('پاداش روزانه با «یک ساعت کار» سنجیده می‌شود', () => {
  test('پلهٔ مرجع از ارزان‌ترین شغل بازار می‌آید', () => {
    expect(HOURLY_FLOOR_WAGE).toBe(LOW_END_HOURLY)
    expect(LOW_END_HOURLY).toBeGreaterThan(0)
  })

  test('کارت روزانه هرگز کمتر از ارزان‌ترین خریدِ ممکن نیست', () => {
    // کارتِ «خرید از فروشگاه» از بازیکن می‌خواهد کالا بخرد؛ اگر پاداشش از
    // ارزان‌ترین کالا کمتر باشد، آن کارت به‌ضرر بازیکن است.
    expect(QUEST_REWARDS.card).toBeGreaterThanOrEqual(CHEAPEST_SHOP_ITEM)
    expect(CHEAPEST_SHOP_ITEM).toBe(Math.min(...SHOP_ITEMS.map((item) => item.price)))
  })

  test('یک کارتِ روزانه دست‌کم یک ساعت کار در پایین‌ترین دستمزد می‌ارزد', () => {
    expect(QUEST_REWARDS.card).toBeGreaterThanOrEqual(LOW_END_HOURLY)
  })

  test('تلاش از یک ضربه بیشتر می‌ارزد', () => {
    // پیش‌تر برعکس بود: استریکِ یک‌ضربه‌ای ۲٬۵۰۰ و کارتِ پرزحمت ۱٬۳۳۳.
    expect(QUEST_REWARDS.card).toBeGreaterThan(streakRewardForDay(1))
    expect(streakRewardForDay(STREAK_RULES.maxEffectiveStreak)).toBeGreaterThan(streakRewardForDay(1))
  })

  test('پله‌های جایزه از کوچک به بزرگ می‌چینند', () => {
    expect(QUEST_REWARDS.allThree).toBeGreaterThanOrEqual(QUEST_REWARDS.card)
    expect(QUEST_REWARDS.chest).toBeGreaterThan(QUEST_REWARDS.allThree)
    // صندوق هفته باید از جمع کارت‌های یک هفته کوچک‌تر باشد، وگرنه خودِ
    // کارت‌ها بی‌معنا می‌شوند و همه فقط منتظر صندوق می‌مانند.
    expect(QUEST_REWARDS.chest).toBeLessThan(QUEST_REWARDS.cardsPerWeek * QUEST_REWARDS.card)
  })

  test('یک روز پاداش، جانشین کار نمی‌شود و در همان حال بی‌مقدار هم نیست', () => {
    const share = DAILY_REWARDS / LOW_END_DAILY_INCOME

    // کف: پاداش‌ها باید در برابر یک روز کار واقعاً به چشم بیایند.
    expect(DAILY_REWARDS).toBeGreaterThanOrEqual(2 * LOW_END_HOURLY)
    // سقف: حتی در بدترین حالت (ارزان‌ترین شغل و بازیکنِ تازه) باید
    // به‌روشنی کمتر از یک‌سومِ درآمد همان روز بمانند تا کسی ترجیح ندهد
    // به‌جای کار کردن، فقط پاداش روزانه بگیرد.
    expect(share).toBeLessThan(1 / 3)
  })

  test('چرخهٔ کاری و درآمد روز، هر دو از نرخ‌های واقعی سرویس می‌آیند', () => {
    // یک روز بازی ۱۴۴۰ دقیقهٔ بازی است و بازیکن نمی‌تواند همهٔ آن را کار کند.
    expect(GAME_MINUTES_PER_DAY).toBe(1440)
    expect(dutyCycle).toBeGreaterThan(0.5)
    expect(dutyCycle).toBeLessThan(1)
    expect(workableMinutesPerDay).toBeLessThan(GAME_MINUTES_PER_DAY)

    // جدول اندازه‌گیری: با `jest --verbose` دیده می‌شود و سندِ گزارش است.
    const rows = [
      ['یک ساعت کار (پایین‌ترین دستمزد)', LOW_END_HOURLY],
      ['ارزان‌ترین کالای فروشگاه', CHEAPEST_SHOP_ITEM],
      ['پاداش یک کارت', QUEST_REWARDS.card],
      ['بونوس هر سه کارت', QUEST_REWARDS.allThree],
      ['صندوق هفتهٔ کامل', QUEST_REWARDS.chest],
      ['استریک روز ۱ / روز ۷', `${streakRewardForDay(1)} / ${streakRewardForDay(7)}`],
      ['ارزش انتظاری شانس روزانه', FORTUNE_EXPECTED_VALUE],
      ['درآمد یک روزِ کار', LOW_END_DAILY_INCOME],
      ['پاداش یک روزِ کامل', DAILY_REWARDS],
      ['سهم پاداش از درآمد روز', `${(DAILY_REWARDS / LOW_END_DAILY_INCOME * 100).toFixed(1)}٪`],
      ['سهم پاداش از یک ساعت کار', `${(DAILY_REWARDS / LOW_END_HOURLY).toFixed(1)}×`]
    ]
    console.table(rows.map(([سنجه, مقدار]) => ({ سنجه, مقدار })))
  })
})
