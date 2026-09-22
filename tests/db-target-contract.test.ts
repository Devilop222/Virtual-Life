/**
 * قراردادِ «کدام دیتابیس؟» — یک قاعده، برای نصب و همهٔ ابزارها.
 *
 * ## باگی که این آزمون از برگشتنش جلوگیری می‌کند
 * روی سرور، نصب با این خط می‌مرد:
 *
 *   خطا در ساخت دیتابیس: connect ECONNREFUSED 127.0.0.1:5433
 *
 * در حالی که نصب‌کننده چند لحظه قبل دیتابیسِ داخلی را روی ۵۴۳۲ ساخته و در
 * `.env` ثبت کرده بود. عددِ ۵۴۳۳ هیچ‌جای کد نبود: یک
 * `export DATABASE_URL=…5433…` جامانده در شلِ اپراتور بود که **بی‌صدا** بر
 * `.env` غلبه می‌کرد، چون `db-setup.js` آدرس را از متغیرِ محیطی می‌خواند و
 * نصب‌کننده آن را صریح به او نمی‌داد.
 *
 * پس قاعده صریح شد و این‌جا قفل می‌شود: هدف = `--url` > `.env`؛ متغیرِ محیطیِ
 * شل هرگز هدف را عوض نمی‌کند (فقط اگر فرق داشته باشد، یک هشدار می‌دهد).
 *
 * تست‌ها **کدِ منتشرشده** را اجرا می‌کنند: بدنهٔ توابع از خودِ `install.sh`
 * بیرون کشیده می‌شود (نه کپیِ دستی) و `db-setup.js` واقعاً اجرا می‌شود؛ پس اگر
 * کسی قاعده را عوض کند، همین‌جا شکست می‌خورد.
 */
import { execFileSync, spawnSync } from 'child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const ROOT = join(__dirname, '..')
const INSTALL_PATH = join(ROOT, 'offline-deps', 'install.sh')
const INSTALL = readFileSync(INSTALL_PATH, 'utf8')
const DB_SETUP = join(ROOT, 'offline-deps', 'scripts', 'db-setup.js')

const bashAvailable = spawnSync('bash', ['-c', 'true']).status === 0
const withBash = bashAvailable ? test : test.skip

/** بدنهٔ یک تابع sh را از همان فایلِ منتشرشده بیرون می‌کشد. */
function shellFunction(name: string): string {
  const lines = INSTALL.split(/\r?\n/)
  const start = lines.findIndex((line) => line.startsWith(`${name}() {`))
  if (start < 0) throw new Error(`تابع «${name}» در install.sh پیدا نشد`)
  const end = lines.indexOf('}', start)
  if (end < 0) throw new Error(`بدنهٔ تابع «${name}» بسته نشده`)
  return lines.slice(start, end + 1).join('\n')
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** یک دایرکتوری با `.env` دلخواه. */
function makeRoot(dotenv: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'vl-dbtarget-'))
  writeFileSync(join(dir, '.env'), dotenv === '' ? '' : `${dotenv}\n`)
  return dir
}

type ResolveResult = { target: string; output: string }

/**
 * تابعِ واقعیِ `resolve_db_target` را اجرا می‌کند و هدفِ انتخابی + پیام‌ها را
 * برمی‌گرداند. `ENV_FILE` و `DATABASE_URL_AMBIENT` همان متغیرهایی هستند که
 * خودِ install.sh پر می‌کند.
 */
function runResolver(options: {
  dotenv?: string
  ambient?: string
  urlArg?: string
}): ResolveResult {
  const root = makeRoot(options.dotenv ?? '')
  const script = [
    'set -euo pipefail',
    'info() { echo "INFO $*"; }',
    'warn() { echo "WARN $*"; }',
    'die() { echo "DIE $*"; exit 1; }',
    `ENV_FILE=${shQuote(join(root, '.env'))}`,
    'DATABASE_URL_AMBIENT="${VL_AMBIENT:-}"',
    'DB_URL_ARG="${VL_ARG:-}"',
    'DB_TARGET_URL=""',
    'DB_TARGET_SOURCE=""',
    'DB_TARGET_WARNED=0',
    shellFunction('get_env'),
    shellFunction('redact_url'),
    shellFunction('resolve_db_target'),
    'resolve_db_target',
    'echo "TARGET=$DATABASE_URL"'
  ].join('\n')

  const stdout = execFileSync('bash', ['-c', script], {
    encoding: 'utf8',
    env: { ...process.env, VL_AMBIENT: options.ambient ?? '', VL_ARG: options.urlArg ?? '' }
  })
  rmSync(root, { recursive: true, force: true })
  const match = stdout.match(/^TARGET=(.*)$/m)
  return { target: match?.[1] ?? '', output: stdout }
}

describe('قاعدهٔ «کدام دیتابیس؟» (install.sh)', () => {
  withBash('`--url` بر `.env` و بر متغیرِ محیطی غلبه می‌کند', () => {
    const { target } = runResolver({
      dotenv: 'DATABASE_URL=postgresql://u@127.0.0.1:5432/from_file',
      ambient: 'postgresql://u@127.0.0.1:5433/from_shell',
      urlArg: 'postgresql://u@127.0.0.1:5444/from_arg'
    })
    expect(target).toBe('postgresql://u@127.0.0.1:5444/from_arg')
  })

  withBash('متغیرِ محیطیِ جامانده هدف را عوض نمی‌کند — همان باگی که نصب را می‌کشت', () => {
    const { target, output } = runResolver({
      dotenv: 'DATABASE_URL=postgresql://u@127.0.0.1:5432/from_file',
      ambient: 'postgresql://u@127.0.0.1:5433/legacy_ux_test'
    })
    expect(target).toBe('postgresql://u@127.0.0.1:5432/from_file')
    // و بی‌صدا هم نیست: اپراتور باید بفهمد یک export جامانده است.
    expect(output).toContain('WARN')
    expect(output).toContain('127.0.0.1:5433')
    expect(output).toContain('نادیده گرفته می‌شود')
  })

  withBash('`.env` خالی + متغیرِ محیطی → هدف خالی می‌ماند تا دیتابیسِ داخلی ساخته شود', () => {
    const { target, output } = runResolver({
      dotenv: '',
      ambient: 'postgresql://u@127.0.0.1:5433/legacy_ux_test'
    })
    expect(target).toBe('')
    expect(output).toContain('WARN')
  })

  withBash('رمز در پیام‌ها چاپ نمی‌شود', () => {
    const { output } = runResolver({
      dotenv: 'DATABASE_URL=postgresql://u:sekret-pass@127.0.0.1:5432/from_file',
      ambient: 'postgresql://u:other-secret@127.0.0.1:5433/legacy_ux_test'
    })
    // خطِ `TARGET=` خودِ آدرسِ کارشده است (باید به ابزارها برسد)؛ آن‌چه نباید
    // رمز را ببیند، پیام‌هایی است که آدم می‌خواند یا لاگ می‌شود.
    const messages = output
      .split('\n')
      .filter((line) => !line.startsWith('TARGET='))
      .join('\n')
    expect(messages).toContain('postgresql://u@127.0.0.1:5432/from_file')
    expect(messages).not.toContain('sekret-pass')
    expect(messages).not.toContain('other-secret')
  })

  test('هر دو ابزارِ دیتابیس با هدفِ صریح صدا زده می‌شوند (نه با حدس از محیط)', () => {
    const code = INSTALL.split(/\r?\n/)
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n')
    expect(code).toContain('db-setup.js" "$REPO_ROOT" --url="$DB_TARGET_URL"')
    expect(code).toContain('migrate.js" "$REPO_ROOT" --url="$DB_TARGET_URL"')
    // خطِ قدیمی که متغیرِ محیطی را می‌خواند دیگر نباید برگردد.
    expect(code).not.toContain('export DATABASE_URL="$(get_env DATABASE_URL)"')
  })
})

describe('ابزارهای دیتابیس روی خط فرمان (اجرای واقعی)', () => {
  /** هدفی که ابزار گزارش می‌کند (خطِ «هدف: …») — پیش از هر اتصال چاپ می‌شود. */
  function reportedTarget(args: string[], ambient?: string): string {
    const root = makeRoot('DATABASE_URL=postgresql://u@127.0.0.1:5432/from_file')
    const env: NodeJS.ProcessEnv = { ...process.env }
    if (ambient) env.DATABASE_URL = ambient
    else delete env.DATABASE_URL
    const run = spawnSync(process.execPath, [DB_SETUP, root, ...args], { encoding: 'utf8', env })
    rmSync(root, { recursive: true, force: true })
    const combined = `${run.stdout}${run.stderr}`
    const match = combined.match(/هدف: (\S+) — از ([^\n]+)/)
    if (!match) throw new Error(`هدفِ گزارش‌شده پیدا نشد:\n${combined}`)
    return match[1] ?? ''
  }

  test('با `--url` صریح، متغیرِ محیطیِ کهنه در هدف دخالت نمی‌کند', () => {
    expect(
      reportedTarget(
        ['--url=postgresql://u@127.0.0.1:59999/explicit'],
        'postgresql://u@127.0.0.1:5433/from_shell'
      )
    ).toBe('u@127.0.0.1:59999/explicit')
  })

  test('و اگر کسی `--url` ندهد، متغیرِ محیطی بر `.env` می‌چربد — دلیلِ اینکه نصب‌کننده آن را صریح می‌دهد', () => {
    expect(reportedTarget([], 'postgresql://u@127.0.0.1:5433/from_shell')).toBe(
      'u@127.0.0.1:5433/from_shell'
    )
    expect(reportedTarget([])).toBe('u@127.0.0.1:5432/from_file')
  })
})
