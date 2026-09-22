/**
 * وضعیتِ کدِ در حال اجرا: کامیت، شاخه، درختِ کاری و مهرِ بستهٔ `dist`.
 *
 * ## چرا این فایل وجود دارد؟
 * روی سرورِ آفلاین، «کدِ مخزن» و «کدِ در حال اجرا» می‌توانند دو چیز باشند:
 * `dist.tar.gz` کامپایل‌شده است و `install.sh` هرگز کامپایل نمی‌کند. پس اگر
 * بستهٔ کهنه روی سرور باز شود، ربات بی‌هیچ خطایی رفتارِ قدیمی را ادامه می‌دهد.
 * تا پیش از این، تنها جایی که این واگرایی را می‌دید کسی بود که به CLI سرور
 * دست داشت. این ماژول همان سنجشِ `check_artifact_freshness` را به داخلِ خودِ
 * ربات می‌آورد تا مالک از تلگرام بفهمد کدِ در حال اجرا با مخزن می‌خواند یا نه.
 *
 * ## قاعدهٔ تازگی
 * عیناً همان قاعدهٔ `install.sh`: کامیتِ مهر تا HEAD اگر هیچ فایلی جز
 * `offline-deps/`، `tests/`، `docs/`، `scripts/` و `*.md` را عوض نکرده باشد،
 * بسته تازه شمرده می‌شود؛ چون هیچ‌کدام از آن‌ها داخل `dist` نمی‌نشینند.
 * دو پیاده‌سازیِ یک قاعده یعنی واگرایی؛ اگر یکی عوض شد، دیگری هم باید.
 *
 * ## چه چیزی هرگز برنمی‌گردد؟
 * توکن، رمز، `DATABASE_URL` یا هر رازِ دیگری. تنها خروجیِ گیت نامِ فایل‌هایی
 * است که عوض شده‌اند — نه محتوایشان.
 */
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { logger } from '../../utils/logger'
import { parsePorcelainPaths, runGit } from './git'

/** مهلتِ هر فرمانِ گیت (میلی‌ثانیه). سرورِ بی‌اینترنت باید سریع شکست بخورد. */
const GIT_TIMEOUT_MS = 10_000
/** مدتِ اعتبارِ حافظهٔ نهان. بزن‌وبازکردن پنل نباید هر بار `git` را اجرا کند. */
const CACHE_MS = 15_000

export interface ArtifactState {
  /** کامیتِ ثبت‌شده در `dist/BUILD_INFO.json`. */
  commit: string | null
  commitShort: string | null
  builtAt: string | null
  /** `true` = بسته با همین کد ساخته شده · `null` = مهر ساخت نیست (بستهٔ قدیمی). */
  fresh: boolean | null
}

export interface CodeState {
  version: string | null
  commit: string | null
  commitShort: string | null
  branch: string | null
  /** فایل‌های عوض‌شدهٔ کامیت‌نشده (حداکثر ۵ نام). */
  dirtyFiles: string[]
  dirtyCount: number
  /** آیا این نسخه از یک مخزنِ گیت اجرا می‌شود؟ */
  fromGit: boolean
  /** آیا گیت روی این سرور در دسترس بود؟ */
  gitAvailable: boolean
  artifact: ArtifactState
}

/** گیت با مهلتِ کوتاه — پنلِ مالک نباید منتظرِ یک مخزنِ کند بماند. */
function git(repoRoot: string, args: string[], trim = true): Promise<string | null> {
  return runGit(repoRoot, args, { trim, timeoutMs: GIT_TIMEOUT_MS })
}

/** خواندنِ نسخه از `package.json` — بدون throw اگر فایل نبود. */
function readVersion(repoRoot: string): string | null {
  try {
    const raw = readFileSync(join(repoRoot, 'package.json'), 'utf8')
    const parsed = JSON.parse(raw) as { version?: unknown }
    return typeof parsed.version === 'string' ? parsed.version : null
  } catch {
    return null
  }
}

/** خواندنِ مهرِ ساختِ بستهٔ `dist`. */
function readArtifact(repoRoot: string): { commit: string | null; builtAt: string | null } {
  try {
    const raw = readFileSync(join(repoRoot, 'dist', 'BUILD_INFO.json'), 'utf8')
    const parsed = JSON.parse(raw) as { commit?: unknown; builtAt?: unknown }
    return {
      commit: typeof parsed.commit === 'string' ? parsed.commit : null,
      builtAt: typeof parsed.builtAt === 'string' ? parsed.builtAt : null
    }
  } catch {
    return { commit: null, builtAt: null }
  }
}

/**
 * مسیرهایی که بودنِ تغییر در آن‌ها یعنی بستهٔ `dist` کهنه است.
 * عیناً همان استثناهای `check_artifact_freshness` در `install.sh`.
 */
function affectsRuntime(path: string): boolean {
  return !(
    path.startsWith('offline-deps/') ||
    path.startsWith('tests/') ||
    path.startsWith('docs/') ||
    path.startsWith('scripts/') ||
    path.endsWith('.md')
  )
}

export class CodeStateReader {
  private readonly repoRoot: string
  private cache: { at: number; value: CodeState } | null = null
  private inFlight: Promise<CodeState> | null = null

  constructor(repoRoot: string = process.cwd()) {
    this.repoRoot = repoRoot
  }

  /** خواندنِ وضعیت؛ نتیجه تا `CACHE_MS` نگه داشته می‌شود. */
  async read(): Promise<CodeState> {
    const now = Date.now()
    if (this.cache && now - this.cache.at < CACHE_MS) {
      return this.cache.value
    }
    // درخواست‌های هم‌زمان یک `git` می‌سازند، نه چند تا.
    if (this.inFlight) {
      return this.inFlight
    }
    this.inFlight = this.collect()
      .catch((error) => {
        logger.warn({ err: error }, 'code state read failed')
        return emptyCodeState()
      })
      .then((value) => {
        this.cache = { at: Date.now(), value }
        this.inFlight = null
        return value
      })
    return this.inFlight
  }

  /** پاک‌کردنِ حافظهٔ نهان — پس از یک استقرار، وضعیت باید تازه خوانده شود. */
  invalidate(): void {
    this.cache = null
  }

  private async collect(): Promise<CodeState> {
    const version = readVersion(this.repoRoot)
    const fromGit = existsSync(join(this.repoRoot, '.git', 'HEAD'))
    const stamp = readArtifact(this.repoRoot)

    if (!fromGit) {
      return {
        version,
        commit: null,
        commitShort: null,
        branch: null,
        dirtyFiles: [],
        dirtyCount: 0,
        fromGit: false,
        gitAvailable: false,
        artifact: { ...stamp, commitShort: short(stamp.commit), fresh: null }
      }
    }

    const commit = await git(this.repoRoot, ['rev-parse', 'HEAD'])
    const branch = await git(this.repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])
    // `trim: false` الزامی است؛ فاصلهٔ ابتدای خط‌های porcelain بخشی از داده
    // است. گرفتنش همان باگی بود که نامِ فایل‌ها را یک نویسه می‌برید.
    const porcelain = await git(this.repoRoot, ['status', '--porcelain'], false)

    const dirtyAll = parsePorcelainPaths(porcelain ?? '').filter(
      (path) => !path.startsWith('.tools/')
    )

    return {
      version,
      commit,
      commitShort: short(commit),
      branch,
      dirtyFiles: dirtyAll.slice(0, 5),
      dirtyCount: dirtyAll.length,
      fromGit: true,
      gitAvailable: commit !== null,
      artifact: {
        ...stamp,
        commitShort: short(stamp.commit),
        fresh: await this.artifactFresh(commit, stamp.commit)
      }
    }
  }

  /**
   * سنجشِ تازگیِ بسته.
   *
   * `null` یعنی «نمی‌دانیم» — بستهٔ بی‌مهر یا گیتِ ناخوانا. عمداً «تازه» یا
   * «کهنه» حدس زده نمی‌شود؛ ادعای درست‌نما بدتر از اعتراف به ندانستن است.
   */
  private async artifactFresh(head: string | null, built: string | null): Promise<boolean | null> {
    if (!head || !built) {
      return null
    }
    if (head === built) {
      return true
    }
    // مهرِ کامیت هرگز کامیتِ خودش نیست: بسته ساخته می‌شود و سپس در کامیتی جدا
    // کامیت می‌گردد. پس اگر تنها تغییرِ آن کامیت‌ها خودِ بسته بوده، کد یکی است.
    const exists = await git(this.repoRoot, ['cat-file', '-e', `${built}^{commit}`])
    if (exists === null) {
      return false
    }
    const diff = await git(this.repoRoot, ['diff', '--name-only', built, head])
    if (diff === null) {
      return null
    }
    return !diff.split('\n').some((path) => path.length > 0 && affectsRuntime(path))
  }
}

function short(commit: string | null): string | null {
  return commit ? commit.slice(0, 7) : null
}

function emptyCodeState(): CodeState {
  return {
    version: null,
    commit: null,
    commitShort: null,
    branch: null,
    dirtyFiles: [],
    dirtyCount: 0,
    fromGit: false,
    gitAvailable: false,
    artifact: { commit: null, commitShort: null, builtAt: null, fresh: null }
  }
}
