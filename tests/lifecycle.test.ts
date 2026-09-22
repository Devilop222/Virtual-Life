import { LifeCycleService, LifeStage } from '../src/modules/lifecycle/lifecycle.service'

describe('LifeCycleService', () => {
  const service = new LifeCycleService()

  test('determines correct life stage based on character age', () => {
    expect(service.getLifeStage(10)).toBe(LifeStage.CHILDHOOD)
    expect(service.getLifeStage(16)).toBe(LifeStage.ADOLESCENCE)
    expect(service.getLifeStage(25)).toBe(LifeStage.YOUTH)
    expect(service.getLifeStage(40)).toBe(LifeStage.ADULTHOOD)
    expect(service.getLifeStage(55)).toBe(LifeStage.MIDDLE_AGE)
    expect(service.getLifeStage(75)).toBe(LifeStage.SENIORITY)
  })

  test('formats human-friendly health levels without lying about numbers', () => {
    expect(service.formatHumanHealth(100)).toContain('سالم')
    expect(service.formatHumanHealth(70)).toContain('خوب')
    expect(service.formatHumanHealth(50)).toContain('متوسط')
    expect(service.formatHumanHealth(0)).toContain('فوت')
    // برچسب هیچ‌وقت درصدِ ساختگی ندارد؛ عدد واقعی را خودِ پنل با بار نشان می‌دهد
    expect(service.formatHumanHealth(86)).not.toContain('٪')
    expect(service.formatHumanHealth(10)).toContain('خطر')
  })
})
