import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { getHelpTopic, HELP_TOPICS, HELP_CATEGORIES } from '../src/bot/help-content'
import { fa, money } from '../src/utils/format'
import { ratePerGameHour } from '../src/utils/game-time'
import { TAX_RATES } from '../src/config/economy'
import { MARKET_CONFIG } from '../src/config/market.config'
import { CLINIC_INFO } from '../src/modules/health/clinic.service'
import { GYM_WEEKLY_FEE } from '../src/modules/gym/gym.service'
import { DEPOSIT_LIMITS, DEPOSIT_PLANS } from '../src/modules/banking/deposit.service'
import { MIN_LOAN_AMOUNT } from '../src/modules/banking/banking.service'
import { PLAYER_LOAN_INFO } from '../src/modules/lending/player-loan.service'
import { POST_SALARY_MIN } from '../src/modules/occupation/business.service'
import { BRANCH_INFO } from '../src/modules/occupation/branch.service'
import { RENTAL_INFO } from '../src/modules/housing/rental.service'
import { SHOP_CATEGORIES } from '../src/modules/shop/shop-catalog'
import { MAX_ACTIVE_LISTINGS } from '../src/modules/market/trade.service'
import { AD_INFO } from '../src/modules/news/ad.service'
import { CHALLENGE_INFO } from '../src/modules/city/challenge.service'
import { TICKET_PRICE } from '../src/modules/city/lottery.service'
import { CANDIDACY_DEPOSIT } from '../src/modules/city/elections.service'
import { QUEST_REWARDS } from '../src/modules/quests/daily-quest.service'
import { FORTUNE_INFO } from '../src/modules/rewards/fortune.service'
import { ACHIEVEMENTS } from '../src/modules/achievements/achievement.service'
import { PET_INFO } from '../src/modules/pets/pet.service'
import { PASSPORT_INFO } from '../src/modules/residence/passport.service'
import { FAMILY_RULES } from '../src/modules/family/family-warmth'
import { MARRIAGE_INFO } from '../src/modules/family/marriage.service'
import { mahrRuleLines } from '../src/modules/family/mahr'
import { environmentThresholdsText } from '../src/modules/groups/group.service'
import { transferHowToLines, transferLimitsText } from '../src/modules/finance/transfer.service'
import { bankTransferLimitsText } from '../src/modules/banking/bank-transfer.service'

/**
 * راهنما باید هر عددی که می‌گوید را از همان منبع حقیقتِ سرویس بخواند.
 *
 * ریشهٔ این آزمون یک کلاس خطای واقعی بود: متن راهنما مبلغ‌ها را دستی نوشته
 * بود و بعد از تغییر چرخهٔ زمانی بازی (روز بازی ۳۰ برابر کوتاه‌تر شد و
 * مبلغ‌های تکرارشونده با `cycleAmount` هم‌تراز شدند) راهنما ۳۰ برابر عدد
 * واقعی را به بازیکن می‌گفت — مثلاً پاداش استریک «۷۵ هزار» در حالی که پنل
 * ۲٬۵۰۰ تومان می‌داد، یا بیمهٔ درمان «یک میلیون» در حالی که ۳۳٬۳۳۳ بود.
 * حالا هیچ‌کدام دست‌نویس نیست؛ این آزمون همان پیوند را قفل می‌کند.
 */
describe('Help numbers come from the services they describe', () => {
  function body(key: string): string {
    const topic = getHelpTopic(key)
    expect(topic).toBeDefined()
    return topic!.body
  }

  test('clinic help quotes the live health price and insurance', () => {
    const text = body('clinic')
    expect(text).toContain(money(CLINIC_INFO.costPerHp))
    expect(text).toContain(money(CLINIC_INFO.premium))
    expect(text).toContain(fa(CLINIC_INFO.insuranceDays))
    expect(text).toContain(fa(CLINIC_INFO.coverRatePercent))
  })

  test('gym help quotes the live weekly fee', () => {
    expect(body('gym')).toContain(money(GYM_WEEKLY_FEE))
  })

  test('deposit help lists the live plans and limits', () => {
    const text = body('deposits')
    for (const plan of DEPOSIT_PLANS) {
      expect(text).toContain(plan.label)
    }
    expect(text).toContain(money(DEPOSIT_LIMITS.minPrincipal))
    expect(text).toContain(money(DEPOSIT_LIMITS.maxTotalActive))
    expect(text).toContain(`${fa(Math.round(DEPOSIT_LIMITS.breakPenaltyRate * 100))}٪`)
  })

  test('bank help quotes the live loan floor and tax-free fees', () => {
    const text = body('bank')
    expect(text).toContain(money(MIN_LOAN_AMOUNT))
    for (const line of transferHowToLines()) {
      expect(text).toContain(line)
    }
    // هر دو مسیرِ پول باید از خودِ سرویس‌ها نقل شوند: سقفِ نقدی از
    // `TransferService` و سقفِ روزانهٔ بانکی از `BankTransferService`.
    expect(text).toContain(transferLimitsText())
    expect(text).toContain(bankTransferLimitsText())
  })

  test('player-loan help quotes the live range and term', () => {
    const text = body('loans')
    expect(text).toContain(money(PLAYER_LOAN_INFO.minPrincipal))
    expect(text).toContain(money(PLAYER_LOAN_INFO.maxPrincipal))
    expect(text).toContain(fa(PLAYER_LOAN_INFO.termDays))
  })

  test('business help quotes the live salary range in game hours', () => {
    expect(body('business')).toContain(money(ratePerGameHour(POST_SALARY_MIN)))
  })

  test('tax rates appear as percentages, never as literals', () => {
    const text = body('rules')
    expect(text).toContain(`${fa(Math.round(TAX_RATES.incomeTaxRate * 100))}٪`)
    expect(text).toContain(`${fa(Math.round(TAX_RATES.businessProfitTaxRate * 100))}٪`)
  })

  test('shop help quotes the live dynamic price bounds', () => {
    const text = body('shop')
    expect(text).toContain(SHOP_CATEGORIES.join('، '))
    expect(text).toContain(`${fa(Math.round(MARKET_CONFIG.minPriceMultiplier * 100))}٪`)
    expect(text).toContain(`${fa(Math.round(MARKET_CONFIG.maxPriceMultiplier * 100))}٪`)
  })

  test('trade help quotes the live listing cap', () => {
    expect(body('trade')).toContain(fa(MAX_ACTIVE_LISTINGS))
  })

  test('rental help quotes the live contract term and price band', () => {
    const text = body('rental')
    expect(text).toContain(fa(RENTAL_INFO.contractDays))
    expect(text).toContain(`${fa(Math.round(RENTAL_INFO.priceMinRatio * 100))}٪`)
    expect(text).toContain(`${fa(Math.round(RENTAL_INFO.priceMaxRatio * 100))}٪`)
  })

  test('ads help quotes the live fee and length cap', () => {
    const text = body('ads')
    expect(text).toContain(money(AD_INFO.fee))
    expect(text).toContain(fa(AD_INFO.maxLength))
  })

  test('lottery, election and branch help quote their live constants', () => {
    expect(body('lottery')).toContain(money(TICKET_PRICE))
    expect(body('elections')).toContain(money(CANDIDACY_DEPOSIT))
    expect(body('branches')).toContain(fa(BRANCH_INFO.maxPerBusiness))
  })

  test('daily-reward help quotes the live card and fortune rules', () => {
    const quests = body('quests')
    expect(quests).toContain(fa(QUEST_REWARDS.cardsPerDay))
    expect(quests).toContain(fa(QUEST_REWARDS.cardsPerWeek))
    // پلهٔ پاداش کارت همان دستمزد یک ساعت کار است؛ اگر روزی عوض شود،
    // راهنما هم باید عوض شود و این خط جلوش را می‌گیرد.
    expect(quests).toContain(money(QUEST_REWARDS.card))
    expect(quests).toContain(money(QUEST_REWARDS.allThree))
    expect(quests).toContain(money(QUEST_REWARDS.chest))

    const fortune = body('fortune')
    expect(fortune).toContain(fa(FORTUNE_INFO.neutralChance))
    expect(fortune).toContain(fa(FORTUNE_INFO.gainChance))
    expect(fortune).toContain(fa(FORTUNE_INFO.lossChance))
    expect(fortune).toContain(fa(FORTUNE_INFO.jackpotChance))
  })

  test('challenge help quotes the live reward', () => {
    expect(body('challenge')).toContain(money(CHALLENGE_INFO.reward))
  })

  test('achievement help counts the live badge list', () => {
    expect(body('achievements')).toContain(fa(ACHIEVEMENTS.length))
  })

  test('pet and passport help quote their live numbers', () => {
    expect(body('pets')).toContain(fa(PET_INFO.sickAfterDays))
    expect(body('passport')).toContain(fa(PASSPORT_INFO.travelerTarget))
  })

  test('family help quotes the live warmth and marriage rules', () => {
    const text = body('family')
    expect(text).toContain(fa(FAMILY_RULES.warmthMin))
    expect(text).toContain(fa(FAMILY_RULES.warmthMax))
    expect(text).toContain(fa(FAMILY_RULES.activityWarmthGain))
    expect(text).toContain(fa(FAMILY_RULES.giftMaxGain))
    expect(text).toContain(fa(FAMILY_RULES.decayPerDay))
    expect(text).toContain(money(MARRIAGE_INFO.divorceCost))
    expect(text).toContain(fa(MARRIAGE_INFO.proposalTtlHours))
    for (const line of mahrRuleLines()) {
      expect(text).toContain(line)
    }
  })

  test('group help quotes the live region thresholds', () => {
    expect(body('group')).toContain(environmentThresholdsText())
  })
})

/** دکمه‌های «❓» داخل پنل‌ها باید به موضوعی برسند که واقعاً وجود دارد. */
describe('Contextual help buttons point at real topics', () => {
  const SRC = join(__dirname, '..', 'src')

  function walk(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) return walk(full)
      return entry.name.endsWith('.ts') ? [full] : []
    })
  }

  test('every help:topic callback resolves to a defined topic', () => {
    const files = walk(SRC)
    const keys = new Set<string>()
    for (const file of files) {
      const content = readFileSync(file, 'utf8')
      for (const match of content.matchAll(/help:topic:([a-z_]+)(?::([a-z_]+))?/g)) {
        // فرم فصل‌دار (help:topic:<chapter>:<topic>) و فرم تک‌موضوعی هر دو.
        keys.add(match[2] ?? match[1]!)
      }
    }
    expect(keys.size).toBeGreaterThan(3)
    for (const key of keys) {
      expect(getHelpTopic(key)).toBeDefined()
    }
  })

  test('every topic key is a plain identifier so callbacks stay short', () => {
    for (const topic of HELP_TOPICS) {
      expect(topic.key).toMatch(/^[a-z][a-z0-9_]*$/)
      expect(`help:topic:${topic.key}`.length).toBeLessThanOrEqual(64)
    }
  })

  test('every chapter key is a plain identifier and unique', () => {
    const keys = HELP_CATEGORIES.map((category) => category.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const key of keys) {
      expect(key).toMatch(/^[a-z][a-z0-9_]*$/)
      expect(`help:cat:${key}`.length).toBeLessThanOrEqual(64)
    }
  })
})
