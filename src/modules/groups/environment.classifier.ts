import { GroupEnvironmentLevel } from '@prisma/client'
import { REGION_CONFIG } from '../../config/region.config'

export interface EnvironmentClassificationRule {
  min: number
  max: number | null
  level: GroupEnvironmentLevel
}

/** آستانه‌ها از تنظیمات مرکزی خوانده می‌شوند تا در کد پراکنده نباشند. */
export const DEFAULT_ENVIRONMENT_RULES: readonly EnvironmentClassificationRule[] = [
  {
    min: REGION_CONFIG.populationThresholds.village.min,
    max: REGION_CONFIG.populationThresholds.village.max,
    level: GroupEnvironmentLevel.VILLAGE
  },
  {
    min: REGION_CONFIG.populationThresholds.city.min,
    max: REGION_CONFIG.populationThresholds.city.max,
    level: GroupEnvironmentLevel.CITY
  },
  {
    min: REGION_CONFIG.populationThresholds.province.min,
    max: REGION_CONFIG.populationThresholds.province.max,
    level: GroupEnvironmentLevel.PROVINCE
  },
  {
    min: REGION_CONFIG.populationThresholds.country.min,
    max: REGION_CONFIG.populationThresholds.country.max,
    level: GroupEnvironmentLevel.COUNTRY
  }
]

export class EnvironmentClassifier {
  constructor(private readonly rules: readonly EnvironmentClassificationRule[] = DEFAULT_ENVIRONMENT_RULES) {}

  /** @param gamePopulation شمارِ شهروندانِ بازی — نه شمارِ اعضای تلگرام. */
  classify(gamePopulation: number): GroupEnvironmentLevel {
    if (!Number.isInteger(gamePopulation) || gamePopulation < 0) {
      throw new RangeError(`gamePopulation must be a non-negative integer, got ${gamePopulation}`)
    }

    const rule = this.rules.find(
      (r) => gamePopulation >= r.min && (r.max === null || gamePopulation <= r.max)
    )

    if (!rule) {
      throw new RangeError(`No classification rule matches game population ${gamePopulation}`)
    }

    return rule.level
  }
}

/**
 * رتبهٔ سطح در جدولِ آستانه‌ها — از **همان** جدول ساخته می‌شود، نه از یک نقشهٔ
 * دستیِ دوم. اگر روزی سطحی جابه‌جا یا اضافه شود، این تابع خودش دنبال می‌کند و
 * «ارتقا/تنزل» نمی‌تواند از رفتارِ طبقه‌بندی جدا بیفتد.
 */
export function environmentRank(
  level: GroupEnvironmentLevel,
  rules: readonly EnvironmentClassificationRule[] = DEFAULT_ENVIRONMENT_RULES
): number {
  const index = rules.findIndex((rule) => rule.level === level)
  if (index < 0) {
    throw new RangeError(`Unknown environment level ${level}`)
  }
  return index
}

/** جهتِ یک تغییرِ سطح — دو پیامِ متفاوت دارند و هرگز نباید با هم قاطی شوند. */
export function levelChangeDirection(
  from: GroupEnvironmentLevel,
  to: GroupEnvironmentLevel,
  rules: readonly EnvironmentClassificationRule[] = DEFAULT_ENVIRONMENT_RULES
): 'up' | 'down' | 'same' {
  const a = environmentRank(from, rules)
  const b = environmentRank(to, rules)
  if (a === b) return 'same'
  return b > a ? 'up' : 'down'
}

export const environmentClassifier = new EnvironmentClassifier()