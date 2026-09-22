/**
 * قراردادِ «پاکسازیِ کامل» (`install.sh reset`).
 *
 * ## چرا این آزمون وجود دارد
 * دستورِ قدیمیِ README برای حذف، `rm -rf VirtualLife` بود: کلِ مخزن نابود می‌شد
 * و بعد از صفر باید clone می‌گرفتید. دو مرز در آن نسخه مبهم بود — «وضعیتِ ربات
 * دقیقاً چه چیزهایی است؟» و «چه چیزی به سیستم‌عامل تعلق دارد؟» — و همان ابهام
 * در پاکسازیِ دستی هم دردسر می‌ساخت.
 *
 * آزمونِ واقعی، نه خواندنِ متن: همین `offline-deps/install.sh` را در یک مخزنِ
 * ساختگی اجرا می‌کند و می‌بیند **چه چیزی رفت و چه چیزی ماند**. ملاکِ نهایی هم
 * همان چیزی است که واقعاً اهمیت دارد: بعد از پاکسازی، نصبِ دوباره باید ممکن
 * باشد (اسکریپت + دو آرشیو + نمونهٔ env سر جایشان).
 */
import { spawnSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const ROOT = join(__dirname, '..')
const INSTALL_SOURCE = readFileSync(join(ROOT, 'offline-deps', 'install.sh'), 'utf8')

const bashAvailable = spawnSync('bash', ['-c', 'true']).status === 0
const withBash = bashAvailable ? test : test.skip

/** مخزنِ ساختگی با همان چیزهایی که یک نصبِ واقعی می‌سازد. */
function makeSandbox(): string {
  const sandbox = mkdtempSync(join(tmpdir(), 'vl-reset-'))
  mkdirSync(join(sandbox, 'offline-deps'), { recursive: true })
  writeFileSync(join(sandbox, 'offline-deps', 'install.sh'), INSTALL_SOURCE)
  writeFileSync(join(sandbox, 'offline-deps', 'dist.tar.gz'), 'archive')
  writeFileSync(join(sandbox, 'offline-deps', 'node_modules-linux.tar.gz'), 'archive')
  writeFileSync(join(sandbox, '.env.example'), 'BOT_TOKEN=\n')
  writeFileSync(join(sandbox, '.env'), 'BOT_TOKEN=123:abc\n')
  writeFileSync(join(sandbox, 'README.md'), 'docs\n')

  // آنچه نصب می‌سازد و باید برود: دیتابیسِ داخلی، لاگ، PID، قفل، بکاپ، وضعیت
  mkdirSync(join(sandbox, '.tools', 'pgdata'), { recursive: true })
  mkdirSync(join(sandbox, '.tools', 'backups', 'b1'), { recursive: true })
  writeFileSync(join(sandbox, '.tools', 'pgdata', 'PG_VERSION'), '16\n')
  writeFileSync(join(sandbox, '.tools', 'bot.log'), 'log\n')
  writeFileSync(join(sandbox, '.tools', 'bot.pid'), '999999\n')
  writeFileSync(join(sandbox, '.tools', 'update.lock'), '')
  writeFileSync(join(sandbox, '.tools', 'update.state.json'), '{"phase":"idle"}\n')
  writeFileSync(join(sandbox, '.tools', '.pguser'), 'ghost-service-user\n')
  mkdirSync(join(sandbox, 'dist', 'modules'), { recursive: true })
  writeFileSync(join(sandbox, 'dist', 'app.js'), '// built\n')

  // و آنچه نصب باز Extract می‌کند — وجودش یعنی `--purge` لازم است
  mkdirSync(join(sandbox, 'node_modules', 'pg'), { recursive: true })
  writeFileSync(join(sandbox, 'node_modules', 'pg', 'package.json'), '{}\n')
  return sandbox
}

function runReset(sandbox: string, args: string[]): { output: string; code: number } {
  const run = spawnSync('bash', ['offline-deps/install.sh', 'reset', ...args], {
    cwd: sandbox,
    encoding: 'utf8'
  })
  return { output: `${run.stdout ?? ''}${run.stderr ?? ''}`, code: run.status ?? -1 }
}

describe('install.sh reset — پاکسازیِ کاملِ وضعیتِ ربات', () => {
  withBash('بدون --yes و بدون ترمینال، هیچ چیزی پاک نمی‌شود', () => {
    const sandbox = makeSandbox()
    try {
      const { output, code } = runReset(sandbox, [])
      expect(code).toBe(1)
      expect(output).toContain('--yes')
      // مهم‌ترین شرط: «رد شدن» یعنی دست‌نزدن.
      expect(existsSync(join(sandbox, '.tools', 'pgdata'))).toBe(true)
      expect(existsSync(join(sandbox, 'dist'))).toBe(true)
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })

  withBash('--yes همهٔ وضعیتِ ربات را می‌برد و باقیِ نصب را نگه می‌دارد', () => {
    const sandbox = makeSandbox()
    try {
      const { output, code } = runReset(sandbox, ['--yes'])
      expect(code).toBe(0)
      expect(output).toContain('پاکسازی کامل شد')

      // رفت: دیتابیس، وضعیتِ زمانِ اجرا، بستهٔ بازشده
      expect(existsSync(join(sandbox, '.tools'))).toBe(false)
      expect(existsSync(join(sandbox, 'dist'))).toBe(false)

      // ماند: کد، بسته‌های آفلاین، نمونهٔ env، و .env (تنظیمات اپراتور)
      expect(existsSync(join(sandbox, 'offline-deps', 'install.sh'))).toBe(true)
      expect(existsSync(join(sandbox, 'offline-deps', 'dist.tar.gz'))).toBe(true)
      expect(existsSync(join(sandbox, 'offline-deps', 'node_modules-linux.tar.gz'))).toBe(true)
      expect(existsSync(join(sandbox, '.env.example'))).toBe(true)
      expect(existsSync(join(sandbox, '.env'))).toBe(true)
      expect(existsSync(join(sandbox, 'README.md'))).toBe(true)
      // node_modules هم می‌ماند (نصبِ دوباره سریع‌تر) — پاکش‌کردن کار --purge است
      expect(existsSync(join(sandbox, 'node_modules'))).toBe(true)
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })

  withBash('--purge ریستِ کارخانه‌ای می‌کند: node_modules و .env هم می‌روند', () => {
    const sandbox = makeSandbox()
    try {
      const { code } = runReset(sandbox, ['--yes', '--purge'])
      expect(code).toBe(0)
      expect(existsSync(join(sandbox, 'node_modules'))).toBe(false)
      expect(existsSync(join(sandbox, '.env'))).toBe(false)
      // و همچنان چیزهایی که نصبِ دوباره به آن‌ها نیاز دارد دست‌نخورده‌اند
      expect(existsSync(join(sandbox, '.env.example'))).toBe(true)
      expect(existsSync(join(sandbox, 'offline-deps', 'node_modules-linux.tar.gz'))).toBe(true)
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })

  withBash('دوبار اجرا هم بی‌خطر است (idempotent)', () => {
    const sandbox = makeSandbox()
    try {
      expect(runReset(sandbox, ['--yes']).code).toBe(0)
      const second = runReset(sandbox, ['--yes'])
      expect(second.code).toBe(0)
      expect(second.output).toContain('پاکسازی کامل شد')
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })

  withBash('اگر بستهٔ نصب ناقص باشد، صریح می‌گوید و نصبِ دوباره را وعده نمی‌دهد', () => {
    const sandbox = makeSandbox()
    try {
      rmSync(join(sandbox, 'offline-deps', 'dist.tar.gz'))
      const { output, code } = runReset(sandbox, ['--yes'])
      expect(code).toBe(1)
      expect(output).toContain('نصبِ دوباره')
      expect(output).toContain('dist.tar.gz')
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })

  test('راهنمای دستورها در خودِ اسکریپت، reset را هم فهرست می‌کند', () => {
    expect(INSTALL_SOURCE).toContain('reset [--yes] [--purge]')
    expect(INSTALL_SOURCE).toContain('bash offline-deps/install.sh reset --yes')
  })
})
