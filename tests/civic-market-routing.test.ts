import { readText } from './helpers/source'
import { UserStateRepository } from '../src/database/repositories/user-state.repository'
import { join } from 'path'
import { InlineKeyboard } from 'grammy'
import {
  buildCityKeyboard,
  buildInventoryListKeyboard,
  buildMarketListKeyboard,
  buildMyListingsKeyboard,
  buildMarketCancelKeyboard
} from '../src/bot/keyboards/main.keyboard'

const HANDLER_SOURCES = [
  join(__dirname, '..', 'src', 'bot', 'handlers', 'text.handler.ts'),
  join(__dirname, '..', 'src', 'bot', 'handlers', 'expansion.handler.ts'),
  join(__dirname, '..', 'src', 'bot', 'handlers', 'start.handler.ts'),
  // سیستم‌های تکمیل‌شده (خانواده تا آگهی)
  join(__dirname, '..', 'src', 'bot', 'handlers', 'features.handler.ts')
]

const SOURCES = HANDLER_SOURCES.map((file) => readText(file))
const ALL_SOURCE = SOURCES.join('\n')

function registeredHandlers(): Array<{ kind: 'exact' | 'regex'; pattern: string }> {
  const out: Array<{ kind: 'exact' | 'regex'; pattern: string }> = []
  for (const content of SOURCES) {
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
  return HANDLERS.some((handler) => {
    if (handler.kind === 'exact') return handler.pattern === callbackData
    try {
      return new RegExp(handler.pattern).test(callbackData)
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

describe('City panel reaches projects and elections', () => {
  const cityCallbacks = callbacksOf(buildCityKeyboard())

  test('the city keyboard exposes both civic features', () => {
    expect(cityCallbacks).toContain('city:projects')
    expect(cityCallbacks).toContain('city:elections')
  })

  test('no city button is dead', () => {
    for (const cb of cityCallbacks) {
      expect(hasHandler(cb)).toBe(true)
    }
  })

  test('donating to every blueprint project routes to a handler', () => {
    for (const key of ['park', 'clinic', 'bazaar', 'terminal']) {
      expect(hasHandler(`project:donate:${key}:100000`)).toBe(true)
    }
  })

  test('candidacy and voting are both reachable', () => {
    expect(hasHandler('election:candidacy')).toBe(true)
    expect(hasHandler('election:vote:some-player-id')).toBe(true)
  })

  test('the projects panel is opened from the city panel, not only from itself', () => {
    // پیش‌تر handleCityProjects تنها از داخل خود donate صدا زده می‌شد (حلقهٔ بسته)
    expect(ALL_SOURCE).toContain("bot.callbackQuery('city:projects'")
    expect(ALL_SOURCE).toContain("bot.callbackQuery('city:elections'")
  })
})

describe('Player market is reachable from the inventory', () => {
  const inventory = buildInventoryListKeyboard(
    [
      { id: 'inv-1', name: 'آب' },
      { id: 'inv-2', name: 'نان' }
    ],
    0,
    2
  )
  const inventoryCallbacks = callbacksOf(inventory)

  test('every inventory row offers both use and sell', () => {
    expect(inventoryCallbacks).toContain('inv:use:inv-1')
    expect(inventoryCallbacks).toContain('mkt:sell:inv-1')
    expect(inventoryCallbacks).toContain('inv:use:inv-2')
    expect(inventoryCallbacks).toContain('mkt:sell:inv-2')
  })

  test('the inventory links to the market and to my listings', () => {
    expect(inventoryCallbacks).toContain('mkt:list:0')
    expect(inventoryCallbacks).toContain('mkt:mine')
  })

  test('no inventory button is dead', () => {
    for (const cb of inventoryCallbacks) {
      expect(hasHandler(cb)).toBe(true)
    }
  })

  test('market listing buttons route to the escrow purchase handler', () => {
    const keyboard = buildMarketListKeyboard(
      [{ id: 'l1', itemName: 'آب', totalPrice: 30_000 }],
      0,
      1
    )
    const callbacks = callbacksOf(keyboard)

    expect(callbacks).toContain('trade:buy:l1')
    for (const cb of callbacks) {
      expect(hasHandler(cb)).toBe(true)
    }
  })

  test('my listings offer a working cancel button', () => {
    const keyboard = buildMyListingsKeyboard([{ id: 'l1', itemName: 'آب' }])
    const callbacks = callbacksOf(keyboard)

    expect(callbacks).toContain('mkt:cancel:l1')
    for (const cb of callbacks) {
      expect(hasHandler(cb)).toBe(true)
    }
  })

  test('the sell prompt can be cancelled', () => {
    for (const cb of callbacksOf(buildMarketCancelKeyboard())) {
      expect(hasHandler(cb)).toBe(true)
    }
  })

  test('an empty market page still renders working navigation', () => {
    const keyboard = buildMarketListKeyboard([], 0, 1)
    const callbacks = callbacksOf(keyboard)

    expect(callbacks.length).toBeGreaterThan(0)
    for (const cb of callbacks) {
      expect(hasHandler(cb)).toBe(true)
    }
  })
})

describe('Free-text input routes survive normalization', () => {
  const textHandler = readText(HANDLER_SOURCES[0]!)

  test('the sell prompt state is consumed by the text router', () => {
    expect(textHandler).toContain("pendingContext?.startsWith('market_sell:')")
  })

  test('pending free-text state is checked before the Persian normalizer bails out', () => {
    // «let» شده تا TTL بتواند context منقضی را پاک کند؛ قرارداد همان است:
    // خواندنِ state باید پیش از bailout نرمال‌ساز رخ دهد
    const stateIndex = textHandler.indexOf('pendingContext = pendingState?.currentContext')
    const bailIndex = textHandler.indexOf('if (!normalized) {\n      return\n    }')

    expect(stateIndex).toBeGreaterThan(-1)
    expect(bailIndex).toBeGreaterThan(-1)
    // ورودی «2 150000» پس از نرمال‌سازی خالی می‌شود؛ اگر زودتر return شود، آگهی هرگز ثبت نمی‌شود
    expect(stateIndex).toBeLessThan(bailIndex)
  })

  test('the market sell handler receives the raw trimmed text, not the normalized text', () => {
    expect(textHandler).toContain('handleMarketSellText(ctx, container, inventoryId, trimmed)')
  })
})

describe('Abandoned input flows cannot strand or ambush the player', () => {
  const textHandler = readText(HANDLER_SOURCES[0]!)

  test('the handler no longer keeps its own copy of the TTL', () => {
    // پیش‌تر یک ثابتِ ۱۵ دقیقه‌ای هم در هندلر بود. چون مخزن زودتر پاک
    // می‌کرد، استثناهای هندلر (مثلِ ثبت‌نام) عملاً بی‌اثر بودند.
    expect(textHandler).not.toContain('PENDING_INPUT_TTL_MS')
    expect(textHandler).toContain('findByTelegramUserIdWithExpiry')
  })

  test('an expired input flow is reported, not silently dropped', async () => {
    // رفتارِ واقعیِ مخزن، نه متنِ سورس
    const deleteMany = jest.fn().mockResolvedValue({ count: 1 })
    const pendingSince = new Date(Date.now() - 20 * 60 * 1000)
    const db = {
      userState: {
        findUnique: jest.fn().mockResolvedValue({
          id: 's1',
          telegramUserId: 1n,
          currentContext: 'pet_name:cat',
          stateData: {},
          pendingSince,
          updatedAt: pendingSince
        }),
        deleteMany
      }
    }
    const repo = new UserStateRepository(db as never)
    const read = await repo.findByTelegramUserIdWithExpiry(1n)
    expect(read.state).toBeNull()
    expect(read.expiredContext).toBe('pet_name:cat')
    expect(deleteMany).toHaveBeenCalledTimes(1)
  })

  test('registration survives a pause that would kill any other flow', async () => {
    const pendingSince = new Date(Date.now() - 40 * 60 * 1000)
    const deleteMany = jest.fn().mockResolvedValue({ count: 0 })
    const row = {
      id: 's1',
      telegramUserId: 1n,
      currentContext: 'registration',
      stateData: { step: 'bio' },
      pendingSince,
      updatedAt: pendingSince
    }
    const db = {
      userState: { findUnique: jest.fn().mockResolvedValue(row), deleteMany }
    }
    const repo = new UserStateRepository(db as never)
    const read = await repo.findByTelegramUserIdWithExpiry(1n)
    expect(read.expiredContext).toBeNull()
    expect(read.state?.currentContext).toBe('registration')
    expect(deleteMany).not.toHaveBeenCalled()

    // همان وقفه برای یک جریانِ ورودیِ عادی کشنده است
    db.userState.findUnique = jest
      .fn()
      .mockResolvedValue({ ...row, currentContext: 'family_gift' })
    const other = await repo.findByTelegramUserIdWithExpiry(1n)
    expect(other.expiredContext).toBe('family_gift')
    expect(deleteMany).toHaveBeenCalledTimes(1)
  })

  test('loans are never granted without an explicit confirmation panel', () => {
    expect(textHandler).toContain('bank:loan_go:')
    expect(textHandler).toContain('requestCollateralLoan')
    // the picker precedes the confirm — no one-click money creation
    const picker = textHandler.indexOf('انتخاب وثیقهٔ وام')
    const confirm = textHandler.indexOf('تأیید وام')
    const execute = textHandler.indexOf('bank:loan_go:')
    expect(picker).toBeGreaterThan(-1)
    expect(confirm).toBeGreaterThan(picker)
    expect(execute).toBeGreaterThan(confirm)
  })
})
