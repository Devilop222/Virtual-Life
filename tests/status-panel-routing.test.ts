import { join } from 'path'
import { readText } from './helpers/source'
import { normalizePersianText } from '../src/utils/commands'
import { VALID_ACTIVITY_SECTIONS } from '../src/modules/activity/activity.service'
import { EXACT_SECTIONS } from '../src/bot/command-catalog'

const SRC = (rel: string) => readText(join(__dirname, '..', rel))

/** جدول کلیدواژه‌ها؛ مستقیم از کاتالوگ مرکزی خوانده می‌شود. */
function exactSections(): Record<string, string> {
  return EXACT_SECTIONS
}

describe('وضعیت من — status panel routing', () => {
  const sections = exactSections()

  test('«وضعیت من» and «وضعیتم» route to the status section', () => {
    expect(sections[normalizePersianText('وضعیت من')]).toBe('status')
    expect(sections[normalizePersianText('وضعیتم')]).toBe('status')
  })

  test('the status section is actually rendered in handleSection', () => {
    const src = SRC('src/bot/handlers/text.handler.ts')
    expect(src).toContain("section === 'status'")
    // قصدِ آزمون این است که وضعیت از رندرکنندهٔ واقعی رد شود، نه اینکه
    // قالب‌بندیِ آرگومان‌ها یخ بزند؛ پنل حالا سن را هم می‌گیرد تا نرخ
    // فرسودگیِ بدن را نشان دهد.
    expect(src).toContain('renderStatusPanel(profile,')
    expect(src).toContain("showMoney: chatType === 'private'")
  })

  test('renderStatusPanel is exported and built through the UI kit', () => {
    const src = SRC('src/bot/renders.ts')
    expect(src).toContain('export function renderStatusPanel')
    const body = src.slice(src.indexOf('export function renderStatusPanel'))
    expect(body).toContain('panel({')
  })
})

describe('Persian keywords replace slash commands', () => {
  const sections = exactSections()

  test('reward keywords are present and normalize-safe', () => {
    expect(sections['استریک']).toBe('streak')
    expect(sections['قرعه کشی']).toBe('lottery')
    expect(sections['دعوت']).toBe('invite')
    expect(sections['دعوت دوستان']).toBe('invite')

    // هر کلید باید از نرمال‌ساز خودش جان سالم به در ببرد
    for (const key of ['استریک', 'قرعه کشی', 'دعوت', 'دعوت دوستان']) {
      expect(normalizePersianText(key)).toBe(key)
    }
  })

  test('expansion.handler no longer registers these as bot commands', () => {
    const src = SRC('src/bot/handlers/expansion.handler.ts')
    expect(src).not.toContain("bot.command('streak'")
    expect(src).not.toContain("bot.command('lottery'")
    expect(src).not.toContain("bot.command('invite'")
  })

  test('the panels are shared helpers routed from the text handler', () => {
    const expansion = SRC('src/bot/handlers/expansion.handler.ts')
    expect(expansion).toContain('export async function showStreakPanel')
    expect(expansion).toContain('export async function showLotteryPanel')
    expect(expansion).toContain('export async function showInvitePanel')

    const text = SRC('src/bot/handlers/text.handler.ts')
    expect(text).toContain('showStreakPanel(ctx, container)')
    expect(text).toContain('showLotteryPanel(ctx, container)')
    expect(text).toContain('showInvitePanel(ctx, container)')
  })

  test('the live claim/buy buttons still have handlers', () => {
    const expansion = SRC('src/bot/handlers/expansion.handler.ts')
    expect(expansion).toContain("bot.callbackQuery('streak:claim'")
    expect(expansion).toContain("bot.callbackQuery('lottery:buy'")
  })
})

describe('warm registration welcome', () => {
  test('welcomeNew opens with the brand and closes with the help keyword', () => {
    const src = SRC('src/utils/classes/texts.ts')
    expect(src).toContain('به بازی «${BRAND.nameFa}» خوش آمدی.')
    expect(src).toContain('در هر مرحله می‌توانی «راهنما» یا «انصراف» را بفرستی.')
  })
})

describe('new sections count as real gameplay', () => {
  test('status, streak and lottery can establish the initial residence', () => {
    expect(VALID_ACTIVITY_SECTIONS.has('status')).toBe(true)
    expect(VALID_ACTIVITY_SECTIONS.has('streak')).toBe(true)
    expect(VALID_ACTIVITY_SECTIONS.has('lottery')).toBe(true)
  })

  test('private-only invite is not a group gameplay activity', () => {
    expect(VALID_ACTIVITY_SECTIONS.has('invite')).toBe(false)
  })
})
