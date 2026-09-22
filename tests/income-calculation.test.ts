import { IncomeCalculationService } from '../src/modules/occupation/income-calculation.service'

describe('IncomeCalculationService', () => {
  const service = new IncomeCalculationService()

  test('calculates correct part-time pay based on elapsed minutes and multipliers', () => {
    const result = service.calculatePartTimeIncome(
      {
        basePayPerMinute: 200,
        difficulty: 2,
        skillLevelAverage: 2,
        playerExperience: 50,
        // ۱۵ دقیقهٔ واقعی = ۴۵۰ دقیقهٔ بازی (ساعت مرکزی: هر دقیقهٔ واقعی ۳۰ دقیقهٔ بازی)
        elapsedMinutes: 450
      },
      0.2,
      0.8,
      0.3
    )

    expect(result.elapsedMinutes).toBe(450)
    // دستمزد مؤثر «در دقیقهٔ بازی» است؛ معادلِ هر دقیقهٔ واقعی‌اش باید بالاتر از پایه باشد
    expect(result.effectivePayPerMinute * 30).toBeGreaterThan(200)
    expect(result.totalEarnedMoney).toBe(result.effectivePayPerMinute * 450)
    expect(result.fatigueGained).toBe(12) // 0.8 در دقیقهٔ واقعی = ۱۲ برای ۱۵ دقیقهٔ واقعی
    expect(result.healthDrain).toBe(3) // 0.2 در دقیقهٔ واقعی = ۳ برای ۱۵ دقیقهٔ واقعی
  })

  test('handles zero elapsed time gracefully', () => {
    const result = service.calculatePartTimeIncome(
      {
        basePayPerMinute: 200,
        difficulty: 1,
        elapsedMinutes: 0.2
      },
      0.1,
      0.5,
      0.2
    )

    expect(result.elapsedMinutes).toBe(0)
    expect(result.totalEarnedMoney).toBe(0)
  })
})