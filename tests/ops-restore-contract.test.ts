/**
 * قراردادِ بازیابی بین bash و TypeScript.
 *
 * ## چرا این آزمون وجود دارد
 * بازیابی از دو نیمهٔ متفاوت ساخته شده که در دو زبانِ متفاوت نوشته شده‌اند:
 * `install.sh` چرخهٔ فرآیندی را می‌چرخاند (خاموش/روشن/بررسیِ سلامت) و
 * `dist/modules/ops/restore-cli.js` کارِ دیتابیس را انجام می‌دهد. هیچ
 * کامپایلری این مرز را نمی‌بیند: اگر نامِ یک کلید در پروندهٔ وضعیت یا مسیرِ
 * کلاینت عوض شود، TypeScript سالم کامپایل می‌شود، bash سالم اجرا می‌شود، و
 * فقط نتیجه در زمانِ فاجعه غلط می‌شود. پس قرارداد صریحاً قفل می‌شود.
 *
 * ## و چرا «ممنوعیتِ pg_dump»
 * بستهٔ PostgreSQL این پروژه دقیقاً سه باینری دارد: `initdb`، `pg_ctl`،
 * `postgres`. نه `pg_dump`، نه `pg_restore`، نه `psql` — این با باز کردنِ
 * تاربال سنجیده شد، نه از روی حدس. پس هر پیاده‌سازی‌ای که بکاپ را به آن
 * ابزارها بسپارد، روی سرورِ واقعی محکوم به شکست است — و بدترین نوع شکست:
 * همه‌چیز تا روزِ بازیابی سالم به نظر می‌رسد.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { sourceFiles } from './helpers/source-tree'

const ROOT = join(__dirname, '..')
const INSTALL = readFileSync(join(ROOT, 'offline-deps', 'install.sh'), 'utf8')

/** خط‌های کد، بدون کامنت — تا «توضیح دربارهٔ چیزی» با «استفاده از آن» قاطی نشود. */
function codeLines(content: string, style: 'ts' | 'sh'): string[] {
  return content
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim()
      if (style === 'ts') {
        return !(trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*'))
      }
      return !trimmed.startsWith('#')
    })
    .map((line) => line.replace(/\/\/.*$/, '').replace(/(^|\s)#.*$/, '$1'))
}

/**
 * قراردادِ چرخهٔ به‌روزرسانی.
 *
 * ## باگی که این آزمون از برگشتنش جلوگیری می‌کند
 * فرمانِ `/botupdate` یک فراقندِ **detached** پرتاب می‌کند و خودش چند لحظه
 * بعد می‌میرد. پس نتیجهٔ نهایی را فقط همین فراقند می‌تواند بنویسد. پیش‌تر
 * هیچ‌کس آن را نمی‌نوشت و نتیجه این بود: هر به‌روزرسانیِ موفق به چشمِ مالک
 * «نیمه‌کاره» می‌رفت، قفل باز نمی‌شد و پنل تا انقضای زمانی می‌گفت «در جریان
 * است». این آزمون آن شکستِ خاموش را غیرممکن می‌کند.
 */
describe('قراردادِ چرخهٔ به‌روزرسانی', () => {
  test('مسیرِ update وضعیت را در همان مسیر و با همان کلیدهای سرویس می‌نویسد', () => {
    const service = readFileSync(
      join(ROOT, 'src', 'modules', 'deploy', 'deploy.service.ts'),
      'utf8'
    )
    // مسیرها
    expect(service).toContain("'update.state.json'")
    expect(INSTALL).toContain('update.state.json')
    expect(service).toContain("'update.lock'")
    expect(INSTALL).toContain('UPDATE_LOCK')

    // کلیدها: هر کدام باید در قالبِ bash هم باشد
    for (const key of ['phase', 'startedAt', 'finishedAt', 'message', 'targetCommit']) {
      expect(INSTALL).toContain(`${key}:`)
    }
  })

  test('به‌روزرسانی در هر مسیر — موفق یا ناموفق — وضعیت را می‌بندد', () => {
    const update = INSTALL.slice(INSTALL.indexOf('  update)'))
    const body = update.slice(0, update.indexOf('\n  install)'))

    // شروع
    expect(body).toContain('set_deploy_state running')
    // پایانِ موفق
    expect(body).toContain('set_deploy_state success')
    // پایانِ ناموفق — و مهم‌تر: از یک تله، تا `die` هم پوشش داده شود
    expect(body).toContain('trap finish_deploy EXIT')
    expect(body).toContain('set_deploy_state failed')
    // قفل در هر مسیر آزاد می‌شود
    expect(body).toContain('release_deploy_lock')
  })

  test('قالبِ bash واقعاً اجرا می‌شود و همان چیزی را می‌نویسد که سرویس می‌خواند', () => {
    // استخراج و **اجرای** همان رشتهٔ داخل install.sh — نه بازنویسی آن در تست.
    // اگر قالب روزی عوض شود، اینجا می‌شکند؛ مقایسهٔ متنی نمی‌تواند آن را بگیرد.
    // از داخلِ همین تابع استخراج می‌شود: فایل دو قالبِ مشابه دارد
    // (وضعیتِ بازیابی و وضعیتِ استقرار) و جست‌وجوی سراسری، اولی را می‌گیرد.
    const fnStart = INSTALL.indexOf('set_deploy_state()')
    expect(fnStart).toBeGreaterThan(-1)
    const marker = '"$NODE_BIN" -e '
    const start = INSTALL.indexOf(marker, fnStart)
    expect(start).toBeGreaterThan(fnStart)
    const open = start + marker.length + 1
    const end = INSTALL.indexOf("' >/dev/null", open)
    expect(end).toBeGreaterThan(open)
    const template = INSTALL.slice(open, end)

    const dir = mkdtempSync(join(tmpdir(), 'deploy-state-'))
    const statePath = join(dir, 'update.state.json')
    try {
      // یک ردیفِ قبلی از خودِ ربات: `targetCommit` و `actorId` باید حفظ شوند.
      writeFileSync(
        statePath,
        JSON.stringify({
          phase: 'running',
          startedAt: '2026-09-20T10:00:00.000Z',
          finishedAt: null,
          message: 'از طرف ربات',
          targetCommit: 'abc123',
          remoteReachable: true,
          actorId: '6910416744'
        })
      )

      const run = (phase: string, message: string): void => {
        process.env.DEPLOY_PHASE = phase
        process.env.DEPLOY_MESSAGE = message
        process.env.DEPLOY_STATE_PATH = statePath
        // eslint-disable-next-line @typescript-eslint/no-implied-eval
        new Function('require', 'process', template)(require, process)
      }

      run('success', 'تمام شد')
      const afterSuccess = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown>

      expect(afterSuccess.phase).toBe('success')
      expect(afterSuccess.message).toBe('تمام شد')
      expect(afterSuccess.finishedAt).toEqual(expect.any(String))
      // لنگرِ زمانِ شروع و نسخهٔ در حال استقرار گم نمی‌شوند
      expect(afterSuccess.startedAt).toBe('2026-09-20T10:00:00.000Z')
      expect(afterSuccess.targetCommit).toBe('abc123')
      expect(afterSuccess.remoteReachable).toBe(true)
      expect(afterSuccess.actorId).toBe('6910416744')

      run('running', 'در جریان')
      const afterRunning = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown>
      expect(afterRunning.phase).toBe('running')
      expect(afterRunning.finishedAt).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
      delete process.env.DEPLOY_PHASE
      delete process.env.DEPLOY_MESSAGE
      delete process.env.DEPLOY_STATE_PATH
    }
  })

  test('مسیرِ update همان پایپ‌لاینی است که دستورِ سرور اجرا می‌کند', () => {
    // تنها یک موتور به‌روزرسانی: فرمان تلگرام هم همین اسکریپت را صدا می‌زند
    const service = readFileSync(
      join(ROOT, 'src', 'modules', 'deploy', 'deploy.service.ts'),
      'utf8'
    )
    expect(service).toContain("'offline-deps/install.sh'")
    expect(service).toContain("spawn('bash', [scriptPath, 'update']")
  })
})

describe('قراردادِ چرخهٔ بازیابی', () => {
  test('install.sh دستورِ restore را دارد و کلاینتِ درست را صدا می‌زند', () => {
    expect(INSTALL).toContain('restore)')
    expect(INSTALL).toContain('dist/modules/ops/restore-cli.js')
    expect(INSTALL).toContain('acquire_restore_lock')
  })

  test('کلاینتِ بازیابی در سورس وجود دارد و از argv شناسه را می‌خواند', () => {
    const cli = join(ROOT, 'src', 'modules', 'ops', 'restore-cli.ts')
    expect(existsSync(cli)).toBe(true)
    const source = readFileSync(cli, 'utf8')
    expect(source).toContain('process.argv[2]')
    expect(source).toContain('restoreNow')
  })

  test('پروندهٔ وضعیت را هر دو طرف با همان کلیدها می‌نویسند', () => {
    // کلیدها این‌جا فهرست شده‌اند تا تفاوت، صریح و قابلِ خواندن شکست بخورد،
    // نه با یک خطای «undefined» در زمانِ اجرا.
    const keys = ['phase', 'operation', 'startedAt', 'finishedAt', 'message', 'backupId', 'actorId']
    const stateSource = readFileSync(join(ROOT, 'src', 'modules', 'ops', 'ops-state.ts'), 'utf8')
    for (const key of keys) {
      expect(stateSource).toContain(`${key}:`)
      expect(INSTALL).toContain(`${key}:`)
    }
    // `operation` همیشه «restore» است؛ چرخهٔ بازیابی نوعِ دیگری ندارد.
    expect(INSTALL).toContain('"restore"')
  })

  test('مسیرِ پروندهٔ وضعیت در هر دو طرف یکی است', () => {
    expect(INSTALL).toContain('ops.state.json')
    const lockSource = readFileSync(join(ROOT, 'src', 'modules', 'ops', 'ops-lock.ts'), 'utf8')
    expect(lockSource).toContain('bot.log')
    expect(INSTALL).toContain('bot.log')
  })

  test('بازیابی/بکاپ به ابزارهایی که روی سرور نیستند وابسته نمی‌شود', () => {
    const banned = /['"`](pg_dump|pg_restore|psql)['"`]/
    const offenders: string[] = []

    for (const file of sourceFiles(join(ROOT, 'src'))) {
      for (const line of codeLines(readFileSync(file, 'utf8'), 'ts')) {
        if (banned.test(line)) {
          offenders.push(`${file}: ${line.trim()}`)
        }
      }
    }
    for (const name of ['install.sh', 'packaging.sh']) {
      const path = join(ROOT, 'offline-deps', name)
      for (const line of codeLines(readFileSync(path, 'utf8'), 'sh')) {
        if (/\b(pg_dump|pg_restore|psql)\b/.test(line) && !line.includes('tar')) {
          offenders.push(`${name}: ${line.trim()}`)
        }
      }
    }

    expect(offenders).toEqual([])
  })
})
