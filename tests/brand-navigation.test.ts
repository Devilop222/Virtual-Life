import { join } from 'path'
import { readText } from './helpers/source'
import { normalizePersianText } from '../src/utils/commands'
import { BRAND } from '../src/config/brand'
import { texts } from '../src/utils/classes/texts'
import { EXACT_SECTIONS } from '../src/bot/command-catalog'

const SRC = (rel: string) => readText(join(__dirname, '..', rel))

describe('Brand identity: Legacy Game / میراث', () => {
  const scanFiles = [
    'src/utils/classes/texts.ts',
    'src/bot/help-content.ts',
    'src/bot/handlers/group.handler.ts',
    'src/bot/handlers/start.handler.ts',
    'src/bot/renders.ts',
    'src/config/brand.ts'
  ]

  test('the retired product name appears nowhere in player-facing code', () => {
    for (const file of scanFiles) {
      const src = SRC(file)
      expect(src).not.toMatch(/زندگی مجازی|دنیای مجازی|Virtual Life/i)
    }
  })

  test('brand name has a single source of truth', () => {
    expect(BRAND.name).toBe('Legacy Game')
    expect(BRAND.nameFa).toBe('میراث')
    // the welcome text must come from BRAND, not a hard-coded copy
    expect(texts.welcomeNew).toContain(BRAND.nameFa)
    const textsSrc = SRC('src/utils/classes/texts.ts')
    expect(textsSrc).toContain("from '../../config/brand'")
  })

  test('branding stays restrained — no keyword stuffing in operational panels', () => {
    // renders.ts (all operational panels) must not name the product at all
    expect(SRC('src/bot/renders.ts')).not.toContain('میراث')
  })
})

describe('Text-first router has no dead keywords', () => {
  const src = SRC('src/bot/handlers/text.handler.ts')
  const entries = Object.keys(EXACT_SECTIONS)

  test('the table is not empty', () => {
    expect(entries.length).toBeGreaterThan(40)
  })

  test('every keyword survives its own normalizer (a ZWNJ key could never match)', () => {
    for (const key of entries) {
      expect(normalizePersianText(key)).toBe(key)
    }
  })

  test('the life-card shortcut only points at words that actually route', () => {
    const lifeCopy = src.slice(src.indexOf("case 'life'"), src.indexOf("case 'skills'"))
    const quoted = [...lifeCopy.matchAll(/«([^»]+)»/g)].map((m) => m[1]!)
    for (const word of quoted) {
      expect(entries).toContain(word)
    }
  })
})

describe('Telegram command menu matches real handlers', () => {
  test('the command menu is minimal: entry point plus the admin-only help', () => {
    // منوی فرمان باید کوچک بماند: فقط «شروع بازی» برای بازیکنان و
    // «راهنمای مدیریت» برای ادمین‌ها. هر فرمان دیگری آلودگی منو است.
    const botSrc = SRC('src/bot/bot.ts')
    const advertised = [...botSrc.matchAll(/\{ command: '(\w+)'/g)].map((m) => m[1]!)
    expect(advertised).toEqual(['start', 'admin_help'])
  })

  test('every advertised /command is registered somewhere', () => {
    const botSrc = SRC('src/bot/bot.ts')
    const advertised = [...botSrc.matchAll(/\{ command: '(\w+)'/g)].map((m) => m[1]!)
    const handlerSources = [
      'src/bot/handlers/start.handler.ts',
      'src/bot/handlers/text.handler.ts',
      'src/bot/handlers/expansion.handler.ts'
    ]
      .map(SRC)
      .join('\n')
    for (const cmd of advertised) {
      expect(handlerSources).toContain(`bot.command('${cmd}'`)
    }
  })
})
