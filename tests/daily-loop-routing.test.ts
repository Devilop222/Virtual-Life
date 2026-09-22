import { InlineKeyboard } from 'grammy'
import {
  buildQuestKeyboard,
  buildAchievementKeyboard,
  buildFortuneKeyboard,
  buildDepositKeyboard,
  buildDepositCancelKeyboard,
  buildClinicKeyboard,
  buildRentalOwnerKeyboard,
  buildRentalMarketKeyboard,
  buildRentalCancelKeyboard,
  buildPassportKeyboard
} from '../src/bot/keyboards/main.keyboard'
import { normalizePersianText } from '../src/utils/commands'
import { EXACT_SECTIONS } from '../src/bot/command-catalog'
import { join } from 'path'
import { readText } from './helpers/source'

const HANDLER_SOURCES = [
  join(__dirname, '..', 'src', 'bot', 'handlers', 'text.handler.ts'),
  join(__dirname, '..', 'src', 'bot', 'handlers', 'expansion.handler.ts'),
  join(__dirname, '..', 'src', 'bot', 'handlers', 'start.handler.ts'),
  // سیستم‌های تکمیل‌شده (خانواده تا آگهی)
  join(__dirname, '..', 'src', 'bot', 'handlers', 'features.handler.ts')
]

function registeredHandlers(): Array<{ kind: 'exact' | 'regex'; pattern: string }> {
  const out: Array<{ kind: 'exact' | 'regex'; pattern: string }> = []
  for (const file of HANDLER_SOURCES) {
    const content = readText(file)
    for (const match of content.matchAll(/bot\.callbackQuery\('([^']+)'/g)) {
      out.push({ kind: 'exact', pattern: match[1]! })
    }
    for (const match of content.matchAll(/bot\.callbackQuery\(\/([^/]+)\//g)) {
      out.push({ kind: 'regex', pattern: match[1]! })
    }
  }
  return out
}

const HANDLERS = registeredHandlers()

function hasHandler(callbackData: string): boolean {
  return HANDLERS.some((h) => {
    if (h.kind === 'exact') return h.pattern === callbackData
    try {
      return new RegExp(h.pattern).test(callbackData)
    } catch {
      return false
    }
  })
}

function callbacksOf(keyboard: InlineKeyboard): string[] {
  return keyboard.inline_keyboard
    .flat()
    .flatMap((button) => ('callback_data' in button ? [button.callback_data] : []))
}

describe('All newly created keyboards route to live handlers', () => {
  test('quest keyboard routes claim and chest buttons', () => {
    const kb = buildQuestKeyboard(
      [{ key: 'work_shift', title: 'کار', done: true, claimed: false }],
      true,
      false
    )
    for (const cb of callbacksOf(kb)) {
      expect(hasHandler(cb)).toBe(true)
    }
  })

  test('achievement keyboard routes back', () => {
    for (const cb of callbacksOf(buildAchievementKeyboard())) {
      expect(hasHandler(cb)).toBe(true)
    }
  })

  test('fortune keyboard routes draw and refresh', () => {
    for (const cb of callbacksOf(buildFortuneKeyboard(false))) {
      expect(hasHandler(cb)).toBe(true)
    }
    for (const cb of callbacksOf(buildFortuneKeyboard(true))) {
      expect(hasHandler(cb)).toBe(true)
    }
  })

  test('deposit keyboards route open, break and cancel', () => {
    const kb = buildDepositKeyboard(
      [{ key: 'w1', label: 'یک‌هفته‌ای', termDays: 7 }],
      [{ id: 'd1', planLabel: 'یک‌هفته‌ای', matured: false }],
      10_000_000
    )
    for (const cb of callbacksOf(kb)) {
      expect(hasHandler(cb)).toBe(true)
    }
    for (const cb of callbacksOf(buildDepositCancelKeyboard())) {
      expect(hasHandler(cb)).toBe(true)
    }
  })

  test('clinic keyboard routes treat, insure and refresh', () => {
    for (const cb of callbacksOf(buildClinicKeyboard(true, false))) {
      expect(hasHandler(cb)).toBe(true)
    }
    for (const cb of callbacksOf(buildClinicKeyboard(false, true))) {
      expect(hasHandler(cb)).toBe(true)
    }
  })

  test('rental keyboards route toggle, price, rent, end and cancel', () => {
    const ownerKb = buildRentalOwnerKeyboard([
      { id: 'p1', title: 'خانه', listedForRent: false, tenantName: null }
    ])
    for (const cb of callbacksOf(ownerKb)) {
      expect(hasHandler(cb)).toBe(true)
    }

    const marketKb = buildRentalMarketKeyboard(
      [{ propertyId: 'p2', title: 'آپارتمان' }],
      false
    )
    for (const cb of callbacksOf(marketKb)) {
      expect(hasHandler(cb)).toBe(true)
    }

    for (const cb of callbacksOf(buildRentalCancelKeyboard())) {
      expect(hasHandler(cb)).toBe(true)
    }
  })

  test('passport keyboard routes to passport and achievements', () => {
    for (const cb of callbacksOf(buildPassportKeyboard())) {
      expect(hasHandler(cb)).toBe(true)
    }
  })
})

describe('Exact section mapping for new features', () => {
  // جدول واقعی کاتالوگ مرکزی؛ بدون پویش متن منبع
  const sections = EXACT_SECTIONS

  test('each new feature has dedicated persian triggers', () => {
    expect(sections[normalizePersianText('کارت روزانه')]).toBe('quests')
    expect(sections[normalizePersianText('نشان‌ها')]).toBe('achievements')
    expect(sections[normalizePersianText('شانس')]).toBe('fortune')
    expect(sections[normalizePersianText('سپرده')]).toBe('deposits')
    expect(sections[normalizePersianText('درمانگاه')]).toBe('clinic')
    expect(sections[normalizePersianText('بیمه')]).toBe('clinic')
    expect(sections[normalizePersianText('اجاره')]).toBe('rental')
    expect(sections[normalizePersianText('گذرنامه')]).toBe('passport')
  })

  test('new triggers never collide with core keywords', () => {
    expect(normalizePersianText('کارت')).not.toBe('کار')
    expect(sections[normalizePersianText('کار')]).toBe('occupation')
    expect(sections[normalizePersianText('بانک')]).toBe('banking')
    expect(sections[normalizePersianText('خانه')]).toBe('housing')
  })
})
