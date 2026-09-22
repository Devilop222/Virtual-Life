/**
 * `/botupdate` — به‌روزرسانیِ سرور از داخل خودِ ربات، به‌صورت ایمن و قابل‌بازیابی.
 *
 * ## چرا این‌قدر محافظه‌کار است؟
 * این تنها قابلیتی است که یک پیام تلگرام می‌تواند به فرآیندِ اجرای بازی روی
 * سرور تبدیل شود. سه خطر واقعی وجود دارد و طراحی عمداً دور هر سه می‌چرخد:
 *
 *  ۱. **مرگِ خودِ فرآیند.** استقرار خودش ربات را می‌کشد (`stop_bot`). اگر اسکریپت
 *     فرزندِ ربات باشد، با مرگِ ربات می‌میرد و سرور نیمه‌کاره رها می‌شود. پس
 *     **detached** اجرا می‌شود (`detached: true` + `unref` + stdio به فایل لاگ)؛
 *     ربات فقط «شروع شد» می‌گوید و برمی‌گردد.
 *
 *  ۲. **دو اجرای هم‌زمان.** قفل یک فایل است با ساختِ **اتمیِ انحصاری** (`wx`):
 *     بین دو درخواست موازی فقط یکی می‌تواند فایل را بسازد. قفلِ رهاشده (crash)
 *     با سنِ فایل تشخیص داده می‌شود.
 *
 *  ۳. **شکستِ خاموش.** هر اجرا وضعیت را در یک فایل می‌نویسد و لاگِ کامل در
 *     `.tools/update.log` می‌ماند.
 *
 * ## چه چیزی واقعاً منتقل می‌شود؟
 * معماریِ استقرار این پروژه **آفلاین** است: سرور به رجیستری npm دسترسی ندارد و
 * اسکریپتِ نصب هرگز کامپایل نمی‌کند — فقط `offline-deps/dist.tar.gz` را باز
 * می‌کند. پس کدِ تازه از دو راه می‌رسد و هر دو یک‌جا:
 *   • تغییراتِ سورس در مخزن،
 *   • و **`offline-deps/dist.tar.gz` کامیت‌شده** که `packaging.sh` روی دستگاهِ
 *     سازنده ساخته است.
 * چون هر دو در گیت‌اند، یک `merge --ff-only` هر دو را می‌آورد؛ بعد اسکریپتِ
 * نصب بستهٔ تازه را روی دیسک باز می‌کند و migration و restart را انجام می‌دهد.
 * اگر فقط سورس بیاید و بستهٔ کهنه بماند، سرور بی‌صدا کدِ قدیمی را اجرا می‌کند —
 * دقیقاً همان چیزی که `check_artifact_freshness` در اسکریپت نصب هشدار می‌دهد.
 *
 * ## چه چیزی هرگز انجام نمی‌شود؟
 *   • `reset --hard`، `checkout --force`، `clean -fd`، `push --force`
 *   • `npm install` / `npm ci` / دانلود موتور Prisma روی سرور
 *   • حذفِ تغییراتِ محلیِ کارنکرده — تشخیص داده و گزارش می‌شوند، نه نابود
 *   • چاپِ توکن، رمز، `DATABASE_URL` یا هر رازِ دیگری در پیام یا لاگ
 */
import { spawn } from 'child_process'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'fs'
import { join } from 'path'
import { logger } from '../../utils/logger'
import { parsePorcelainPaths, runGit } from '../ops/git'

/** حداکثر سنِ مجازِ قفل پیش از آن‌که «رهاشده» شمرده شود (۲۰ دقیقه). */
const LOCK_STALE_MS = 20 * 60 * 1000
/** حداقل فاصلهٔ دو درخواست (۵ دقیقه) — دو ری‌استارتِ پشت‌سرهم بی‌معناست. */
const COOLDOWN_MS = 5 * 60 * 1000
/** مهلتِ هر فرمانِ گیت (ثانیه). سرورِ بی‌اینترنت باید سریع شکست بخورد، نه هنگ کند. */
const GIT_TIMEOUT_MS = 30_000

export type DeployPhase = 'idle' | 'running' | 'success' | 'failed'

export interface DeployStatus {
  available: boolean
  unavailableReason: string | null
  phase: DeployPhase
  startedAt: Date | null
  finishedAt: Date | null
  message: string | null
  /** کامیتِ روی دیسک در آخرین اجرا. */
  targetCommit: string | null
  /** آیا ریموت گیت در دسترس بود؟ `null` یعنی هنوز سنجیده نشده. */
  remoteReachable: boolean | null
  locked: boolean
}

/** نتیجهٔ هماهنگ‌سازیِ گیت — ورودیِ تصمیم دربارهٔ اینکه اصلاً ری‌استارت لازم است یا نه. */
export type SyncOutcome =
  /** ریموت در دسترس نبود؛ با همان بستهٔ روی دیسک ادامه می‌دهیم. */
  | { kind: 'offline'; head: string | null }
  /** دیسک و ریموت یکی‌اند — استقرارِ بی‌مورد لازم نیست. */
  | { kind: 'up-to-date'; head: string | null; branch: string | null }
  /** تغییراتِ محلیِ کامیت‌نشده هست — خودکار جلو نمی‌رویم. */
  | { kind: 'dirty'; head: string | null; branch: string | null; files: string[] }
  /** با موفقیت جلو رفتیم. */
  | { kind: 'updated'; from: string; to: string; branch: string }
  /** خطای غیرمنتظرهٔ گیت. */
  | { kind: 'error'; message: string }

interface DeployStateFile {
  phase: DeployPhase
  startedAt: string | null
  finishedAt: string | null
  message: string | null
  targetCommit: string | null
  remoteReachable: boolean | null
  actorId: string | null
}

/** تنها فرمانِ shell که این سرویس اجرا می‌کند — ثابت، بدون هیچ ورودیِ کاربر. */
const UPDATE_SCRIPT = 'offline-deps/install.sh'

/**
 * اجرای گیت برای استقرار — با همان دوانتخابِ امنیتیِ مشترک
 * (`GIT_TERMINAL_PROMPT=0` تا گیتِ منتظرِ رمز روی سرورِ بی‌اینترنت هنگ نکند).
 *
 * برخلاف خوانندهٔ وضعیتِ کد، این‌جا شکست باید **استثنا** بدهد: هر گامِ
 * استقرار به خروجیِ گامِ قبل گره خورده و ادامه‌دادن با مقدارِ خالی یعنی
 * تصمیم‌گیری روی دادهٔ غایب.
 */
async function git(repoRoot: string, args: string[], trim = true): Promise<string> {
  const output = await runGit(repoRoot, args, { trim, timeoutMs: GIT_TIMEOUT_MS })
  if (output === null) {
    throw new Error(`git ${args.join(' ')} failed`)
  }
  return output
}

/**
 * مقدارِ یک کلید از فایلِ `.env` — همان قاعده‌ای که `get_env` در `install.sh`
 * دارد (خطِ `KEY=value`، حذفِ نقل‌قول، آخرین تعریف برنده).
 */
function readEnvValue(envPath: string, key: string): string | null {
  try {
    for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
      if (!match || match[1] !== key) continue
      const value = (match[2] ?? '').replace(/^["']|["']$/g, '').trim()
      return value === '' ? null : value
    }
  } catch {
    return null
  }
  return null
}

/** آدرسِ بی‌رمز: پیامِ استقرار به تلگرام می‌رود، پس رمز هرگز در آن نمی‌نشیند. */
function redactUrl(raw: string): string {
  return raw.replace(/(:\/\/[^:/@]*):[^@/]*@/, '$1@')
}

export class DeployService {
  private readonly repoRoot: string
  private readonly toolsDir: string
  private readonly lockPath: string
  private readonly statePath: string
  private readonly logPath: string

  constructor(repoRoot: string = process.cwd()) {
    this.repoRoot = repoRoot
    this.toolsDir = join(repoRoot, '.tools')
    this.lockPath = join(this.toolsDir, 'update.lock')
    this.statePath = join(this.toolsDir, 'update.state.json')
    this.logPath = join(this.toolsDir, 'update.log')
  }

  /**
   * آیا این محیط می‌تواند به‌روزرسانی کند؟
   *
   * بدون اسکریپتِ رسمیِ استقرار راهی برای فهمیدنِ «این نسخه چگونه بالا آمده»
   * نیست، و حدس زدن یعنی ریسکِ نابودکردنِ یک نصبِ سالم. پس همان‌جا می‌ایستیم.
   */
  availability(): { available: boolean; reason: string | null } {
    if (process.env.NODE_ENV !== 'production') {
      return {
        available: false,
        reason: 'این قابلیت فقط روی سرورِ بازی و در اجرای واقعی فعال است.'
      }
    }
    if (!existsSync(join(this.repoRoot, UPDATE_SCRIPT))) {
      return {
        available: false,
        reason: 'بستهٔ رسمی استقرار روی این سرور پیدا نشد؛ به‌روزرسانی خودکار ممکن نیست.'
      }
    }
    if (!existsSync(join(this.repoRoot, '.git', 'HEAD'))) {
      return {
        available: false,
        reason: 'این نسخه از مخزن گیت اجرا نمی‌شود؛ به‌روزرسانی خودکار ممکن نیست.'
      }
    }
    return { available: true, reason: null }
  }

  /** وضعیتِ فعلی — همیشه قابلِ خواندن، حتی وقتی هیچ‌وقت اجرایی نشده. */
  status(): DeployStatus {
    const availability = this.availability()
    const state = this.readState()
    const locked = this.isLocked()
    // فازِ «در حال اجرا» فقط وقتی معتبر است که قفل هم زنده باشد. وگرنه یعنی
    // فرآیند وسط کار مرده و نباید تا ابد «در حال اجرا» بماند.
    const orphaned = state.phase === 'running' && !locked

    return {
      available: availability.available,
      unavailableReason: availability.reason,
      phase: orphaned ? 'failed' : state.phase,
      startedAt: state.startedAt ? new Date(state.startedAt) : null,
      finishedAt: state.finishedAt ? new Date(state.finishedAt) : null,
      message: orphaned
        ? 'آخرین اجرا نیمه‌کاره ماند (فرآیند تمام نشد). لاگ سرور را ببین.'
        : state.message,
      targetCommit: state.targetCommit,
      remoteReachable: state.remoteReachable,
      locked
    }
  }

  /**
   * هماهنگ‌سازی با GitHub — پیش از هر استقراری.
   *
   * **`fetch` + `merge --ff-only`، هیچ چیز دیگری.** اگر تاریخ عوض شده باشد
   * (کسی روی سرور مستقیم کامیت کرده) `merge` بی‌خطر شکست می‌خورد و ما متوقف
   * می‌شویم؛ دوباره‌نویسیِ تاریخ این‌جا جایی ندارد.
   */
  async syncFromRemote(): Promise<SyncOutcome> {
    try {
      const branch = await git(this.repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])

      // تغییراتِ محلی هرگز نابود نمی‌شوند؛ فقط تشخیص داده می‌شوند. اگر سرور
      // دستکاری شده باشد، مالک باید خودش تصمیم بگیرد.
      // `trim: false` الزامی است: `git status --porcelain` خط‌هایی مثل
      // `" M path"` می‌دهد که نویسهٔ اولشان فاصلهٔ معنادار است. اگر کلِ خروجی
      // trim شود، `slice(3)` یک نویسه از خودِ نامِ فایل را می‌خورد و مالک
      // نامِ غلط می‌بیند (این باگ واقعاً وجود داشت).
      const porcelain = await git(this.repoRoot, ['status', '--porcelain'], false)
      const dirtyFiles = parsePorcelainPaths(porcelain).filter(
        (path) => !path.startsWith('.tools/')
      )

      let head: string
      try {
        head = await git(this.repoRoot, ['rev-parse', 'HEAD'])
      } catch {
        return { kind: 'error', message: 'نسخهٔ محلی قابل خواندن نیست.' }
      }

      // آیا ریموت اصلاً وجود دارد؟ نبودنش خطا نیست — یعنی آفلاین.
      try {
        await git(this.repoRoot, ['remote', 'get-url', 'origin'])
      } catch {
        return { kind: 'offline', head }
      }

      try {
        await git(this.repoRoot, ['fetch', '--prune', '--quiet', 'origin', branch])
      } catch (error) {
        // سرورِ آفلاین مسیر عادی دارد، نه مسیر استثنا: با بستهٔ روی دیسک
        // ادامه می‌دهیم. دلیلش فقط لاگ می‌شود (ممکن است راز داشته باشد).
        logger.info({ err: error }, 'git fetch failed — continuing offline')
        return { kind: 'offline', head }
      }

      const remoteRef = `origin/${branch}`
      let remoteHead: string
      try {
        remoteHead = await git(this.repoRoot, ['rev-parse', remoteRef])
      } catch {
        return { kind: 'offline', head }
      }

      if (remoteHead === head) {
        return { kind: 'up-to-date', head, branch }
      }

      const isAncestor = await git(this.repoRoot, ['merge-base', '--is-ancestor', head, remoteRef])
        .then(() => true)
        .catch(() => false)

      if (!isAncestor) {
        return {
          kind: 'error',
          message: `تاریخِ شاخهٔ «${branch}» روی سرور جلوتر یا جدا شده است؛ برای پیشگیری از نابودیِ تغییرات، خودکار جلو نمی‌رویم.`
        }
      }

      if (dirtyFiles.length > 0) {
        return { kind: 'dirty', head, branch, files: dirtyFiles }
      }

      await git(this.repoRoot, ['merge', '--ff-only', '--quiet', remoteRef])
      return { kind: 'updated', from: head, to: remoteHead, branch }
    } catch (error) {
      logger.warn({ err: error }, 'git sync unexpected failure')
      return { kind: 'error', message: 'هماهنگ‌سازی با مخزن ممکن نشد.' }
    }
  }

  /**
   * درخواستِ به‌روزرسانی.
   *
   * @param actorTelegramId فقط برای لاگ؛ اجازه پیش‌تر در لایهٔ دسترسی سنجیده شده.
   */
  async requestUpdate(actorTelegramId: bigint): Promise<{
    started: boolean
    reason: string | null
    /** اگر «چیزی برای به‌روزرسانی نبود»، این‌جا توضیحِ انسانی می‌آید. */
    upToDate: boolean
    status: DeployStatus
  }> {
    const availability = this.availability()
    if (!availability.available) {
      return {
        started: false,
        reason: availability.reason,
        upToDate: false,
        status: this.status()
      }
    }

    // فاصلهٔ اجباری پیش از هر کارِ سنگین.
    const previous = this.readState()
    if (previous.phase === 'success' && previous.finishedAt) {
      const since = Date.now() - new Date(previous.finishedAt).getTime()
      if (since < COOLDOWN_MS) {
        return {
          started: false,
          reason: 'همین چند لحظه پیش به‌روزرسانی انجام شد؛ کمی صبر کن.',
          upToDate: false,
          status: this.status()
        }
      }
    }

    // پیش از هر کارِ سنگین: ربات و اسکریپتِ استقرار باید یک دیتابیس را هدف
    // بگیرند. نصب/آپدیت طبق قرارداد هدف را فقط از `.env` می‌خواند، ولی خودِ ربات
    // آدرسِ *محیطِ فرآیندِ* خودش را استفاده می‌کند. اگر این دو فرق کنند،
    // مهاجرت روی یک دیتابیس اجرا می‌شود و ربات روی دیگری می‌نویسد — استقراری
    // «موفق» با داده‌ای که دو نیمه شده. پس صریح می‌ایستیم.
    const mismatch = this.databaseTargetMismatch()
    if (mismatch) {
      const message =
        'ربات با آدرسِ دیتابیسی متفاوت از فایلِ تنظیمات اجرا می‌شود؛ استقرار متوقف شد تا داده بین دو دیتابیس نصف نشود.'
      this.writeState({
        phase: 'failed',
        startedAt: previous.startedAt,
        finishedAt: new Date().toISOString(),
        message,
        targetCommit: previous.targetCommit,
        remoteReachable: previous.remoteReachable,
        actorId: actorTelegramId.toString()
      })
      return {
        started: false,
        reason: [
          'آدرسِ دیتابیسِ ربات با آدرسِ فایلِ تنظیمات یکی نیست؛ برای پیشگیری از نصف‌شدنِ داده، به‌روزرسانی متوقف شد.',
          `ربات: ${redactUrl(mismatch.runtime)}`,
          `فایلِ تنظیمات: ${redactUrl(mismatch.file)}`,
          'ربات را با همان آدرسِ فایلِ تنظیمات دوباره بالا بیاور و بعد تلاش کن.'
        ].join('\n'),
        upToDate: false,
        status: this.status()
      }
    }

    if (!this.acquireLock()) {
      return {
        started: false,
        reason: 'یک به‌روزرسانی همین حالا در جریان است.',
        upToDate: false,
        status: this.status()
      }
    }

    // از این‌جا به بعد قفل داریم؛ هر مسیر خروجی باید آن را آزاد کند.
    let sync: SyncOutcome
    try {
      sync = await this.syncFromRemote()
    } catch (error) {
      logger.warn({ err: error }, 'sync failed before deployment')
      sync = { kind: 'error', message: 'هماهنگ‌سازی با مخزن ممکن نشد.' }
    }

    const remoteReachable = sync.kind === 'updated' || sync.kind === 'up-to-date'

    if (sync.kind === 'up-to-date') {
      this.releaseLock()
      this.writeState({
        phase: 'success',
        startedAt: previous.startedAt,
        finishedAt: new Date().toISOString(),
        message: 'سرور از قبل روی آخرین نسخه بود؛ استقراری لازم نبود.',
        targetCommit: sync.head,
        remoteReachable: true,
        actorId: actorTelegramId.toString()
      })
      return { started: false, reason: null, upToDate: true, status: this.status() }
    }

    if (sync.kind === 'dirty') {
      this.releaseLock()
      const preview = sync.files.slice(0, 5).join('، ')
      this.writeState({
        phase: 'failed',
        startedAt: previous.startedAt,
        finishedAt: new Date().toISOString(),
        message: 'تغییراتِ محلیِ کامیت‌نشده روی سرور هست؛ برای امنیتِ داده‌ها خودکار جلو نرفتیم.',
        targetCommit: sync.head,
        remoteReachable,
        actorId: actorTelegramId.toString()
      })
      return {
        started: false,
        reason: `روی سرور تغییراتِ محلی وجود دارد (${preview}). برای پیشگیری از نابودی، به‌روزرسانی متوقف شد.`,
        upToDate: false,
        status: this.status()
      }
    }

    if (sync.kind === 'error') {
      this.releaseLock()
      this.writeState({
        phase: 'failed',
        startedAt: previous.startedAt,
        finishedAt: new Date().toISOString(),
        message: sync.message,
        targetCommit: previous.targetCommit,
        remoteReachable: false,
        actorId: actorTelegramId.toString()
      })
      return { started: false, reason: sync.message, upToDate: false, status: this.status() }
    }

    const target = sync.kind === 'updated' ? sync.to.slice(0, 12) : (sync.head?.slice(0, 12) ?? null)

    try {
      mkdirSync(this.toolsDir, { recursive: true })
      this.writeState({
        phase: 'running',
        startedAt: new Date().toISOString(),
        finishedAt: null,
        message:
          sync.kind === 'updated'
            ? `نسخهٔ ${target} دریافت شد؛ در حال استقرار و راه‌اندازی مجدد…`
            : 'ریموت در دسترس نبود؛ استقرار از بستهٔ روی دیسک…',
        targetCommit: target,
        remoteReachable,
        actorId: actorTelegramId.toString()
      })
      this.spawnDetached()
      return { started: true, reason: null, upToDate: false, status: this.status() }
    } catch (error) {
      logger.error({ err: error }, 'deploy spawn failed')
      this.releaseLock()
      this.writeState({
        phase: 'failed',
        startedAt: previous.startedAt,
        finishedAt: new Date().toISOString(),
        message: 'اجرای فرآیند به‌روزرسانی ممکن نشد.',
        targetCommit: target,
        remoteReachable,
        actorId: actorTelegramId.toString()
      })
      return {
        started: false,
        reason: 'اجرای فرآیند به‌روزرسانی ممکن نشد. لاگ سرور را ببین.',
        upToDate: false,
        status: this.status()
      }
    }
  }

  /**
   * آدرسِ دیتابیسِ *این فرآیند* با آدرسِ `.env` یکی است؟
   *
   * اگر یکی از دو طرف خالی باشد، عدمِ تطابق اعلام نمی‌شود: نبودِ `.env` یعنی
   * نصبِ دستی/توسعه، و آن‌جا این دروازه فقط یک هشدارِ درست‌نما می‌ساخت.
   */
  private databaseTargetMismatch(): { runtime: string; file: string } | null {
    const runtime = (process.env.DATABASE_URL ?? '').trim()
    const file = readEnvValue(join(this.repoRoot, '.env'), 'DATABASE_URL')
    if (runtime === '' || file === null || runtime === file) return null
    return { runtime, file }
  }

  /**
   * اجرای detached اسکریپتِ رسمی استقرار.
   *
   * `detached: true` + `unref()` فرزند را از چرخهٔ زندگیِ ربات بیرون می‌کند؛
   * وگرنه `stop_bot` که خودِ اسکریپت اجرا می‌کند، همان فرآیندی را می‌کشد که
   * باید ربات را دوباره بالا بیاورد. stdio به فایل لاگ می‌رود تا خروجیِ
   * اسکریپت پس از مرگِ والد گم نشود.
   *
   * هیچ ورودیِ کاربر به این فرمان نمی‌رسد: نامِ اسکریپت ثابت است و تنها
   * آرگومان `update` است.
   */
  private spawnDetached(): void {
    const scriptPath = join(this.repoRoot, UPDATE_SCRIPT)
    mkdirSync(this.toolsDir, { recursive: true })
    const out = openSync(this.logPath, 'a')
    try {
      const child = spawn('bash', [scriptPath, 'update'], {
        cwd: this.repoRoot,
        detached: true,
        stdio: ['ignore', out, out],
        env: { ...process.env }
      })
      // شکستِ اجرا (مثلاً نبودِ `bash`) به‌صورت غیرهمزمان روی رویداد `error`
      // می‌آید، نه به‌صورت throw. بدون این شنونده، Node با استثنای مدیریت‌نشده
      // کل ربات را می‌کشد — و ماروی/قفل رهاشده باقی می‌ماند.
      child.on('error', (error) => {
        logger.error({ err: error }, 'deployment process failed to start')
        const state = this.readState()
        this.releaseLock()
        this.writeState({
          phase: 'failed',
          startedAt: state.startedAt,
          finishedAt: new Date().toISOString(),
          message: 'اجرای فرآیند به‌روزرسانی ممکن نشد.',
          targetCommit: state.targetCommit,
          remoteReachable: state.remoteReachable,
          actorId: state.actorId
        })
      })
      child.unref()
      logger.info({ pid: child.pid }, 'deployment process started')
    } finally {
      closeSync(out)
    }
  }

  // ──────────────────────────────────────────────────────────── قفل

  /**
   * گرفتن قفل با ساختِ **انحصاری** فایل (`wx`).
   *
   * چرا فایل و نه متغیر در حافظه؟ چون فرآیندِ استقرار بیرون از ربات ادامه
   * می‌یابد و ممکن است ربات وسط کار restart شود؛ قفلِ درون‌حافظه‌ای پس از
   * restart هیچ معنایی ندارد و راه را برای اجرای دوم باز می‌کند.
   */
  private acquireLock(): boolean {
    const write = (): boolean => {
      try {
        mkdirSync(this.toolsDir, { recursive: true })
        const fd = openSync(this.lockPath, 'wx')
        writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }))
        closeSync(fd)
        return true
      } catch {
        return false
      }
    }

    if (write()) {
      return true
    }
    // فایل هست؛ اگر بسیار قدیمی است، اجرای قبلی مرده و قفل رهاشده.
    if (this.lockAgeMs() > LOCK_STALE_MS) {
      this.releaseLock()
      return write()
    }
    return false
  }

  private releaseLock(): void {
    try {
      if (existsSync(this.lockPath)) {
        unlinkSync(this.lockPath)
      }
    } catch {
      // آزادسازیِ ناموفق نباید درخواست را بشکند؛ قفلِ رهاشده با سن تشخیص
      // داده می‌شود و خودش منقضی می‌گردد.
    }
  }

  private isLocked(): boolean {
    if (!existsSync(this.lockPath)) {
      return false
    }
    return this.lockAgeMs() <= LOCK_STALE_MS
  }

  private lockAgeMs(): number {
    try {
      return Date.now() - statSync(this.lockPath).mtimeMs
    } catch {
      return Number.POSITIVE_INFINITY
    }
  }

  // ──────────────────────────────────────────────────────────── وضعیت

  /** مسیر فایلِ وضعیت — برای آزمون‌ها و برای ابزارهای بیرونی. */
  stateFilePath(): string {
    return this.statePath
  }

  /** مسیر فایلِ قفل — برای آزمون‌ها. */
  lockFilePath(): string {
    return this.lockPath
  }

  private readState(): DeployStateFile {
    const empty: DeployStateFile = {
      phase: 'idle',
      startedAt: null,
      finishedAt: null,
      message: null,
      targetCommit: null,
      remoteReachable: null,
      actorId: null
    }
    try {
      if (!existsSync(this.statePath)) {
        return empty
      }
      const parsed = JSON.parse(readFileSync(this.statePath, 'utf8')) as Partial<DeployStateFile>
      return { ...empty, ...parsed }
    } catch {
      return empty
    }
  }

  private writeState(state: DeployStateFile): void {
    try {
      mkdirSync(this.toolsDir, { recursive: true })
      writeFileSync(this.statePath, JSON.stringify(state, null, 2))
    } catch (error) {
      logger.warn({ err: error }, 'could not write deploy state')
    }
  }
}
