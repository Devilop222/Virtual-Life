/**
 * مرحلهٔ زندگی و برچسب سلامت.
 *
 * تقویم سن (یک هفتهٔ واقعی = یک سال بازی) در `game-calendar.ts` است و این
 * ماژول فقط نگاشت سن به مرحلهٔ زندگی و توصیف انسانیِ سلامت را انجام می‌دهد.
 * عددها هرگز اینجا سخت‌شده نیستند؛ پنل‌ها عدد واقعی را کنار برچسب نشان
 * می‌دهند تا «برچسب» هیچ‌وقت ادعای دروغ نکند.
 */

export enum LifeStage {
  CHILDHOOD = 'CHILDHOOD',
  ADOLESCENCE = 'ADOLESCENCE',
  YOUTH = 'YOUTH',
  ADULTHOOD = 'ADULTHOOD',
  MIDDLE_AGE = 'MIDDLE_AGE',
  SENIORITY = 'SENIORITY'
}

export const lifeStageLabels: Record<LifeStage, string> = {
  [LifeStage.CHILDHOOD]: 'کودکی',
  [LifeStage.ADOLESCENCE]: 'نوجوانی',
  [LifeStage.YOUTH]: 'جوانی',
  [LifeStage.ADULTHOOD]: 'بزرگسالی',
  [LifeStage.MIDDLE_AGE]: 'میانسالی',
  [LifeStage.SENIORITY]: 'سالمندی'
}

export class LifeCycleService {
  getLifeStage(age: number): LifeStage {
    if (age < 12) return LifeStage.CHILDHOOD
    if (age < 18) return LifeStage.ADOLESCENCE
    if (age < 35) return LifeStage.YOUTH
    if (age < 50) return LifeStage.ADULTHOOD
    if (age < 65) return LifeStage.MIDDLE_AGE
    return LifeStage.SENIORITY
  }

  /** توصیف کوتاه سلامت؛ درصد و نوار واقعی را خودِ پنل نشان می‌دهد. */
  formatHumanHealth(health: number): string {
    if (health >= 85) return 'سالم و سربلند'
    if (health >= 65) return 'خوب'
    if (health >= 40) return 'متوسط'
    if (health >= 15) return 'ضعیف — به فکر خودت باش'
    if (health > 0) return 'در وضعیت خطر'
    return 'فوت‌شده'
  }
}

export const lifeCycleService = new LifeCycleService()
