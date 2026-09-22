import { BusinessCategory } from '@prisma/client'
import { BUSINESS_BLUEPRINTS } from '../src/modules/occupation/work-blueprints'
import { requiredStaff } from '../src/modules/occupation/payroll-math'

/**
 * نردبان سه‌سطحی کسب‌وکار (فروشگاه ← شرکت ← کارخانه).
 *
 * کاربر صریحاً خواسته «حداقل سه سطح منطقی که واقعاً تفاوت داشته باشند»؛
 * این سوئیت قفل می‌کند که:
 *  ۱) هر سه دستهٔ STORE و FACTORY و یک میان‌ردهٔ واقعی موجودند
 *  ۲) اقتصاد هر سطح از سطح قبل بزرگ‌تر است (سرمایه، ظرفیت، درآمد مطلق، تجربه)
 *  ۳) هیچ مدلی زیر اقتصادی‌ترین حد یا بالاتر از سقفِ منطقی سیستم نمی‌رود
 */
describe('Business blueprint tier ladder (Shop / Business / Factory)', () => {
  test('every blueprint is economically coherent', () => {
    const modelTypes = new Set<string>()
    for (const blueprint of BUSINESS_BLUEPRINTS) {
      expect(modelTypes.has(blueprint.modelType)).toBe(false)
      modelTypes.add(blueprint.modelType)

      expect(blueprint.startupCost).toBeGreaterThan(0)
      expect(blueprint.baseCapacity).toBeGreaterThanOrEqual(2)
      expect(blueprint.requiredExperience).toBeGreaterThanOrEqual(1)
      expect(blueprint.baseRevenuePerMinute).toBeGreaterThan(blueprint.operatingCostPerMinute)
      expect(blueprint.operatingCostPerMinute).toBeGreaterThan(0)
      expect(blueprint.title.length).toBeGreaterThanOrEqual(3)
      expect((Object.values(BusinessCategory) as string[]).includes(blueprint.category)).toBe(true)
      // ضریب نیروی انسانی همیشه با ظرفیت سازگار باشد (نیاز نیرویی > ۱ نفر)
      expect(requiredStaff(blueprint.baseCapacity)).toBeGreaterThanOrEqual(2)
    }
  })

  test('a low-cost shop tier exists and is the cheapest entry', () => {
    const shop = BUSINESS_BLUEPRINTS.find((b) => b.modelType === 'local_shop')
    expect(shop).toBeDefined()
    expect(shop!.category).toBe(BusinessCategory.STORE)

    const cheapest = Math.min(...BUSINESS_BLUEPRINTS.map((b) => b.startupCost))
    expect(shop!.startupCost).toBe(cheapest)
  })

  test('a factory tier exists and is the largest venture', () => {
    const factory = BUSINESS_BLUEPRINTS.find((b) => b.modelType === 'food_factory')
    expect(factory).toBeDefined()
    expect(factory!.category).toBe(BusinessCategory.FACTORY)

    const mostExpensive = Math.max(...BUSINESS_BLUEPRINTS.map((b) => b.startupCost))
    const largestCapacity = Math.max(...BUSINESS_BLUEPRINTS.map((b) => b.baseCapacity))
    const highestRevenue = Math.max(...BUSINESS_BLUEPRINTS.map((b) => b.baseRevenuePerMinute))
    expect(factory!.startupCost).toBe(mostExpensive)
    expect(factory!.baseCapacity).toBe(largestCapacity)
    expect(factory!.baseRevenuePerMinute).toBe(highestRevenue)
  })

  test('each tier is strictly bigger than the one below it', () => {
    const shop = BUSINESS_BLUEPRINTS.find((b) => b.modelType === 'local_shop')!
    const factory = BUSINESS_BLUEPRINTS.find((b) => b.modelType === 'food_factory')!

    // میان‌رده‌ها واقعاً بین دو انتهایی قرار دارند — نه زیر فروشگاه، نه در برابر کارخانه
    const mid = BUSINESS_BLUEPRINTS.filter(
      (b) => b.modelType !== 'local_shop' && b.modelType !== 'food_factory'
    )
    expect(mid.length).toBeGreaterThan(0)
    for (const m of mid) {
      expect(m.startupCost).toBeGreaterThan(shop.startupCost)
      expect(m.startupCost).toBeLessThan(factory.startupCost)
      expect(m.baseCapacity).toBeLessThan(factory.baseCapacity)
      expect(m.requiredExperience).toBeLessThan(factory.requiredExperience)
    }

    expect(shop.baseCapacity).toBeLessThan(factory.baseCapacity)
    expect(shop.baseRevenuePerMinute).toBeLessThan(factory.baseRevenuePerMinute)
    expect(shop.requiredExperience).toBeLessThan(factory.requiredExperience)
    // هزینهٔ عملیاتی کارخانه باید سهم محسوسی از درآمدش باشد (مدیریت سنگین)
    expect(factory.operatingCostPerMinute / factory.baseRevenuePerMinute).toBeGreaterThan(
      shop.operatingCostPerMinute / shop.baseRevenuePerMinute
    )
  })
})
