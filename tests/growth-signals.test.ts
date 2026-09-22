/**
 * دو سیگنالی که ساخته شده بودند ولی هیچ‌جا دیده نمی‌شدند.
 *
 * ## حفره‌ای که این آزمون از تکرارش جلوگیری می‌کند
 *
 * `ShopService.getInventoryValue` و `AchievementService.getSummary` هر دو
 * وجود داشتند، کار می‌کردند و **صفر فراخوانِ تولیدی** داشتند. دومی حتی
 * کامنتِ خودش می‌گفت «خط خلاصهٔ نشان‌ها برای شناسنامه» — ولی شناسنامه هیچ‌وقت
 * آن را صدا نمی‌زد. نتیجه: دو عدد کاملاً محاسبه‌شده که هیچ بازیکنی نمی‌دید.
 *
 * این آزمون سه چیز را قفل می‌کند: عدد روی پنل می‌آید، نبودنش پنل را نمی‌شکند،
 * و «ارزش انبار» با قیمت فروشگاه فهمیده می‌شود (نه قیمت معاملهٔ بازیکنی).
 */
import { renderInventoryPanel, renderIdentityCard } from '../src/bot/renders'
import type { PlayerIdentityView } from '../src/modules/identity/player.service'
import { fa } from '../src/utils/format'

const rows = [
  { quantity: 3, item: { name: 'قهوه', rarity: 'COMMON', effects: null } }
]

const identity = (over: Partial<PlayerIdentityView> = {}): PlayerIdentityView =>
  ({
    telegramUserId: 1n,
    firstName: 'آرش',
    lastName: 'ک.',
    username: null,
    gender: 'MALE',
    age: 30,
    birthdayInDays: 5,
    lifeStageLabel: 'جوان',
    biography: '',
    maritalStatus: 'SINGLE',
    socialLevel: 'MIDDLE',
    health: 90,
    maxHealth: 100,
    healthLabel: 'سالم',
    fatigue: 10,
    experience: 120,
    balance: { toString: () => '1000000' },
    educationDegree: 'دیپلم',
    educationField: null,
    educationRank: 1,
    occupation: null,
    jobTitle: null,
    isWorkingNow: false,
    homeGroup: null,
    skills: [],
    groupCount: 1,
    productivityScore: 80,
    productivityLabel: 'خوب',
    productivityMultiplier: 1,
    ...over
  }) as unknown as PlayerIdentityView

describe('پنل انبار: ارزش دارایی دیده می‌شود', () => {
  test('وقتی ارزش داده شود، به‌صورت پول روی پنل می‌آید', () => {
    const out = renderInventoryPanel(rows, 0, 250_000)
    expect(out).toContain('ارزش انبار')
    expect(out).toContain(fa(250_000))
  })

  test('قیمت با واحدش می‌آید تا با عدد خام اشتباه گرفته نشود', () => {
    const out = renderInventoryPanel(rows, 0, 12_000)
    expect(out).toContain('تومان')
  })

  test('ارزش صفر روی پنل خط اضافه نمی‌کند', () => {
    // انبار ارزش‌دار ولی ارزشِ رُندش صفر است؛ خطِ «۰ تومان» فقط شلوغی است.
    expect(renderInventoryPanel(rows, 0, 0)).not.toContain('ارزش انبار')
  })

  test('نبودن ارزش، پنل را نمی‌شکند (فراخوان‌های قدیمی)', () => {
    const out = renderInventoryPanel(rows, 0)
    expect(out).toContain('انبار من')
    expect(out).not.toContain('ارزش انبار')
  })

  test('انبار خالی همان حالت خالی را نشان می‌دهد، نه ارزش را', () => {
    const out = renderInventoryPanel([], 0, 500_000)
    expect(out).toContain('انبار خالی است')
    expect(out).not.toContain('ارزش انبار')
  })
})

describe('شناسنامه: نشان‌ها روی کارت می‌آیند', () => {
  // سطرهای جدولی ایموجیِ ابتدای برچسب را حذف می‌کنند؛ پس متنِ سطر
  // «نشان‌ها: …» است، نه «🏅 نشان‌ها: …».
  const ACHIEVEMENT_ROW = 'نشان‌ها'

  test('شمار و آیکنِ نشان‌ها روی کارت دیده می‌شود', () => {
    const out = renderIdentityCard(identity(), {
      achievements: { count: 4, icons: ['🥇', '🎖️'] }
    })
    expect(out).toContain(ACHIEVEMENT_ROW)
    expect(out).toContain(fa(4))
    expect(out).toContain('🥇')
  })

  test('بدون نشان، حالت خالیِ روشن نوشته می‌شود (نه عدد صفر)', () => {
    const out = renderIdentityCard(identity(), {
      achievements: { count: 0, icons: [] }
    })
    expect(out).toContain(ACHIEVEMENT_ROW)
    expect(out).toContain('هنوز نشانی نگرفته')
  })

  test('نبودن دادهٔ نشان‌ها، کارت را خراب نمی‌کند', () => {
    const out = renderIdentityCard(identity())
    expect(out).toContain('شناسنامه')
    expect(out).not.toContain(ACHIEVEMENT_ROW)
  })

  test('خلاصهٔ نشان‌ها مقدارِ تحریف‌شده نشان نمی‌دهد', () => {
    // عدد و آیکن‌ها باید همان چیزی باشند که سرویس داده؛ نه بیشتر، نه کمتر.
    const out = renderIdentityCard(identity(), {
      achievements: { count: 2, icons: ['🥇', '🎖️'] }
    })
    expect(out).toContain('🥇 🎖️')
    expect(out).not.toContain('🥉')
  })
})
