import { readdirSync } from 'fs'
import { join } from 'path'
import { readText } from './helpers/source'
import ts from 'typescript'

const SRC = join(__dirname, '..', 'src')

function sourceFiles(dir = SRC, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      sourceFiles(full, acc)
    } else if (entry.name.endsWith('.ts')) {
      acc.push(full)
    }
  }
  return acc
}

const FILES = sourceFiles()

function read(path: string): string {
  return readText(path)
}

/** رشته‌های تک‌کوتیشنی که فارسی دارند و کامنت نیستند. */
function persianLiterals(content: string): string[] {
  const source = ts.createSourceFile('ui.ts', content, ts.ScriptTarget.Latest, true)
  const out: string[] = []
  function visit(node: ts.Node): void {
    if (ts.isStringLiteral(node) && /[\u0600-\u06ff]/.test(node.text)) out.push(node.text)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return out
}

/**
 * فقط بخشِ **نمایش‌داده‌شدهٔ** متن‌ها.
 *
 * چرا جدا از `persianLiterals`؟ یک قالب مثل `${state.population} بازیکن` در
 * سطحِ کد یک «رشتهٔ فارسی» است، ولی بازیکن هرگز واژهٔ `state` را نمی‌بیند.
 * اگر همان را بسنجیم، تست یا پر از استثنا می‌شود یا نادرست رد می‌کند؛ پس این‌جا
 * فقط head و میان‌رشته‌های قالب بیرون کشیده می‌شوند — دقیقاً آنچه چاپ می‌شود.
 */
function renderedPersianFragments(content: string): string[] {
  const source = ts.createSourceFile('ui.ts', content, ts.ScriptTarget.Latest, true)
  const out: string[] = []
  function visit(node: ts.Node): void {
    let chunks: string[] = []
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      chunks = [node.text]
    } else if (ts.isTemplateExpression(node)) {
      chunks = [node.head.text, ...node.templateSpans.map((span) => span.literal.text)]
    }
    for (const chunk of chunks) {
      if (/[\u0600-\u06ff]/.test(chunk)) out.push(chunk)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return out
}

describe('User facing text stays clean persian', () => {
  test('no persian message leaks internal enum values', () => {
    const enumLike = /\b(ACTIVE|IDLE|WORKING|STUDYING|RESTING|SLEEPING|TRAVELING|PART_TIME|FULL_TIME|COMPLETED|PENDING|BANNED|DEAD)\b/

    for (const file of FILES) {
      for (const value of persianLiterals(read(file))) {
        expect(value).not.toMatch(enumLike)
      }
    }
  })

  test('no persian message leaks developer vocabulary', () => {
    // «Session»، «callback»، «Prisma» و مانند آن نباید به بازیکن نشان داده شوند
    const devWords = /\b(Session|session|callback|Callback|Prisma|PrismaClient|TypeError|Escrow|Idempotent)\b/

    for (const file of FILES) {
      for (const value of persianLiterals(read(file))) {
        expect(value).not.toMatch(devWords)
      }
    }
  })

  test('no rendered text exposes the internals of the system', () => {
    // فهرست کامل واژه‌های فنی که بازیکن هرگز نباید ببیند؛ روی همان بخشی
    // سنجیده می‌شود که واقعاً چاپ می‌شود (نه نام متغیرهای داخل قالب).
    const internals =
      /\b(Handler|handler|Service|service|Repository|repository|Callback|callback|Database|database|Prisma|prisma|SQL|Exception|exception|Middleware|middleware|Schema|schema|Payload|payload|Entity|Token|token|UUID|uuid|undefined|NaN|Internal Error|internal error|TODO|FIXME|Lorem|null)\b/

    const leaks: string[] = []
    for (const file of FILES) {
      for (const fragment of renderedPersianFragments(read(file))) {
        const hit = fragment.match(new RegExp(internals.source, 'g'))
        if (hit) leaks.push(`${file}: ${[...new Set(hit)].join(',')} — ${fragment.slice(0, 80)}`)
      }
    }
    expect(leaks).toEqual([])
  })

  test('no rendered text keeps a placeholder', () => {
    // «...» خالی، `{{name}}` و `<value>` نشانهٔ متنی است که تمام نشده
    const placeholder = /\{\{\w+\}\}|<[a-z_]+>|%s\b|\bTBD\b/
    const leaks: string[] = []
    for (const file of FILES) {
      for (const fragment of renderedPersianFragments(read(file))) {
        if (placeholder.test(fragment)) leaks.push(`${file}: ${fragment.slice(0, 80)}`)
      }
    }
    expect(leaks).toEqual([])
  })

  test('persian messages avoid latin words other than bot commands', () => {
    // فقط دستورهای واقعی تلگرام و نام‌های رسمی مجاز هستند.
    //
    // فایل‌های مدیریتی (پنل و راهنمای ادمین) مخاطبشان اپراتور است، نه بازیکن،
    // و عمداً راهنمای پیکربندی ربات را دارند؛ ولی همین فهرست در متنِ
    // بازیکن‌محور ممنوع است تا دانشِ راه‌اندازی به UI بازیکن برنگردد.
    const allowed = /^(start|admin|help|streak|lottery|invite|botupdate|plot|PhD)$/
    const operatorOnly = /admin/i

    for (const file of FILES) {
      if (operatorOnly.test(file)) continue
      for (const value of persianLiterals(read(file))) {
        const latinWords = value.match(/[A-Za-z]{2,}/g) ?? []
        for (const word of latinWords) {
          expect(word).toMatch(allowed)
        }
      }
    }
  })

  test('none of the player-facing text tells the player how to configure the bot', () => {
    // «برو در BotFather Group Privacy را خاموش کن» دانشِ راه‌اندازی ربات است:
    // بازیکن نه دسترسی‌اش را دارد و نه نقشی در آن. جای درستش چت خصوصیِ
    // ثبت‌کنندهٔ گروه و راهنمای ادمین است.
    const devKnowledge = /BotFather|mybots|Group Privacy|Bot Settings|@BotFather/i
    const leaks: string[] = []

    for (const file of FILES) {
      if (/admin/i.test(file)) continue
      for (const fragment of renderedPersianFragments(read(file))) {
        if (devKnowledge.test(fragment)) leaks.push(`${file}: ${fragment.slice(0, 80)}`)
      }
    }

    expect(leaks).toEqual([])
  })
})

describe('Panels are built through the shared UI kit', () => {
  const RENDER_FILES = [
    join(SRC, 'bot', 'renders.ts'),
    join(SRC, 'bot', 'handlers', 'text.handler.ts'),
    join(SRC, 'bot', 'handlers', 'expansion.handler.ts'),
    join(SRC, 'bot', 'handlers', 'features.handler.ts'),
    join(SRC, 'bot', 'handlers', 'group.handler.ts')
  ]

  test('no handler hand-rolls a panel border', () => {
    for (const file of RENDER_FILES) {
      // خط جداکننده فقط باید از ui-kit بیاید تا ظاهر همه پنل‌ها یکی بماند
      expect(read(file)).not.toContain("'━━")
    }
  })

  test('renders module has no leftover local divider constants', () => {
    const content = read(join(SRC, 'bot', 'renders.ts'))
    expect(content).not.toMatch(/const\s+(DIVIDER|THIN_DIVIDER)\s*=/)
  })

  test('every render function goes through panel()', () => {
    const content = read(join(SRC, 'bot', 'renders.ts'))
    const names = [...content.matchAll(/export function (render\w+)/g)].map((m) => m[1]!)

    expect(names.length).toBeGreaterThan(20)

    for (const name of names) {
      const start = content.indexOf(`export function ${name}`)
      const next = content.indexOf('\nexport function', start + 10)
      const body = content.slice(start, next === -1 ? content.length : next)
      expect(body).toContain('panel({')
    }
  })

  test('shared texts are panels, not hand-built strings', () => {
    const content = read(join(SRC, 'utils', 'classes', 'texts.ts'))
    expect(content).toContain("from '../../bot/ui-kit'")
    expect(content).not.toContain("'━━")
  })
})

describe('Grammy is imported statically', () => {
  test('no handler pays a dynamic import cost per callback', () => {
    for (const file of FILES) {
      expect(read(file)).not.toContain("await import('grammy')")
    }
  })
})

describe('Callback errors are never swallowed', () => {
  const HANDLERS = [
    join(SRC, 'bot', 'handlers', 'text.handler.ts'),
    join(SRC, 'bot', 'handlers', 'expansion.handler.ts')
  ]

  test('handlers route failures through the shared error helper', () => {
    for (const file of HANDLERS) {
      const content = read(file)
      expect(content).toContain('handleCallbackError')

      // الگوی قدیمی: خطای غیرمنتظره بی‌صدا رد می‌شد
      expect(content).not.toMatch(
        /catch \(err\) \{\s*if \(err instanceof AppError\) await ackCallback/
      )
    }
  })

  test('the error helper logs context and keeps player messages specific', () => {
    const helper = read(join(SRC, 'bot', 'handler-errors.ts'))

    for (const field of ['feature', 'action', 'callbackData', 'userId', 'chatId']) {
      expect(helper).toContain(field)
    }

    // خطاهای دامنه نباید Log شوند؛ فقط پیام فارسی خودشان را نشان می‌دهند
    expect(helper).toMatch(/instanceof AppError[\s\S]{0,120}persianMessage/)
    expect(helper).toContain('logUnexpected')
  })
})
