/**
 * وضعیتِ کد و تازگیِ بستهٔ اجرایی.
 *
 * قاعدهٔ تازگی **دو** پیاده‌سازی دارد: `check_artifact_freshness` در
 * `offline-deps/install.sh` و `CodeStateReader` در سورس. اگر یکی عوض شود و
 * دیگری نه، پنلِ مالک می‌گوید «بسته کهنه است» در حالی که نصب می‌گوید
 * «هم‌خوان» — و مالک نمی‌داند کدام را باور کند. این آزمون‌ها قاعده را روی
 * مخزنِ واقعیِ گیت می‌سنجند، نه روی یک ماک.
 */
import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { CodeStateReader } from '../src/modules/ops/code-state'

jest.setTimeout(60_000)

function gitIn(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.com'
    }
  })
    .toString()
    .trim()
}

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'legacy-code-'))
  gitIn(root, ['init', '--quiet', '--initial-branch=main'])
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'x', version: '9.9.9' }))
  // مثل مخزنِ واقعی: `dist` هیچ‌وقت کامیت نمی‌شود؛ آن‌چه منتشر می‌شود خودِ
  // تاربال `offline-deps/dist.tar.gz` است. این تفاوت تعیین‌کننده است.
  writeFileSync(join(root, '.gitignore'), 'dist\n')
  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(join(root, 'offline-deps'), { recursive: true })
  writeFileSync(join(root, 'src', 'app.ts'), 'export const a = 1\n')
  writeFileSync(join(root, 'offline-deps', 'dist.tar.gz'), 'package\n')
  gitIn(root, ['add', '.'])
  gitIn(root, ['commit', '--quiet', '-m', 'اول'])
  return root
}

function stampArtifact(root: string, commit: string): void {
  mkdirSync(join(root, 'dist'), { recursive: true })
  writeFileSync(
    join(root, 'dist', 'BUILD_INFO.json'),
    JSON.stringify({ commit, builtAt: '2026-09-20T00:00:00Z', node: 'v22.22.3' })
  )
}

describe('وضعیتِ کد', () => {
  let root: string

  beforeEach(() => {
    root = makeRepo()
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  test('بدون مخزنِ گیت، همه‌چیز «نامعلوم» است نه «تازه»', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'legacy-plain-'))
    try {
      writeFileSync(join(plain, 'package.json'), JSON.stringify({ version: '1.2.3' }))
      const state = await new CodeStateReader(plain).read()
      expect(state.fromGit).toBe(false)
      expect(state.commit).toBeNull()
      expect(state.artifact.fresh).toBeNull()
      // نسخهٔ بسته از `package.json` خوانده می‌شود، نه از گیت
      expect(state.version).toBe('1.2.3')
    } finally {
      rmSync(plain, { recursive: true, force: true })
    }
  })

  test('کامیت و شاخه از مخزن خوانده می‌شوند', async () => {
    const state = await new CodeStateReader(root).read()
    expect(state.commit).toBe(gitIn(root, ['rev-parse', 'HEAD']))
    expect(state.commitShort).toHaveLength(7)
    expect(state.branch).toBe('main')
    expect(state.version).toBe('9.9.9')
  })

  test('بستهٔ مهرشده روی همین کامیت، تازه است', async () => {
    stampArtifact(root, gitIn(root, ['rev-parse', 'HEAD']))
    const state = await new CodeStateReader(root).read()
    expect(state.artifact.fresh).toBe(true)
  })

  test('تغییرِ سورس پس از ساخت، بسته را کهنه می‌کند', async () => {
    stampArtifact(root, gitIn(root, ['rev-parse', 'HEAD']))
    writeFileSync(join(root, 'src', 'app.ts'), 'export const a = 2\n')
    gitIn(root, ['commit', '--quiet', '-am', 'تغییرِ رفتار'])

    const state = await new CodeStateReader(root).read()
    expect(state.artifact.fresh).toBe(false)
  })

  test('کامیتی که فقط خودِ بستهٔ آفلاین را عوض کرده، بسته را کهنه نمی‌کند', async () => {
    // همان قراردادِ `install.sh`: بسته ساخته می‌شود و در کامیتی جدا کامیت
    // می‌گردد که تنها `offline-deps/` را عوض می‌کند؛ پس کدِ اجرایی همان است.
    const built = gitIn(root, ['rev-parse', 'HEAD'])
    stampArtifact(root, built)
    writeFileSync(join(root, 'offline-deps', 'dist.tar.gz'), 'package-v2\n')
    gitIn(root, ['add', '.'])
    gitIn(root, ['commit', '--quiet', '-m', 'بستهٔ تازه'])

    const state = await new CodeStateReader(root).read()
    expect(state.commit).not.toBe(built)
    expect(state.artifact.fresh).toBe(true)
  })

  test('تغییرِ تست یا مستندات، بسته را کهنه نمی‌کند', async () => {
    const built = gitIn(root, ['rev-parse', 'HEAD'])
    stampArtifact(root, built)
    mkdirSync(join(root, 'tests'), { recursive: true })
    writeFileSync(join(root, 'tests', 'x.test.ts'), 'x\n')
    writeFileSync(join(root, 'NOTES.md'), 'یادداشت\n')
    gitIn(root, ['add', '.'])
    gitIn(root, ['commit', '--quiet', '-m', 'تست و یادداشت'])

    const state = await new CodeStateReader(root).read()
    expect(state.artifact.fresh).toBe(true)
  })

  test('تغییراتِ ذخیره‌نشده گزارش می‌شوند و پوشهٔ حالتِ زمان اجرا نه', async () => {
    writeFileSync(join(root, 'src', 'app.ts'), 'export const a = 3\n')
    mkdirSync(join(root, '.tools'), { recursive: true })
    writeFileSync(join(root, '.tools', 'bot.log'), 'x\n')

    const state = await new CodeStateReader(root).read()
    expect(state.dirtyCount).toBe(1)
    expect(state.dirtyFiles[0]).toBe('src/app.ts')
  })

  test('بستهٔ بی‌مهر «نامعلوم» است، نه «تازه» و نه «کهنه»', async () => {
    const state = await new CodeStateReader(root).read()
    expect(state.artifact.fresh).toBeNull()
    expect(state.artifact.commit).toBeNull()
  })

  test('پس از پاک‌کردنِ حافظهٔ نهان، وضعیت تازه خوانده می‌شود', async () => {
    const reader = new CodeStateReader(root)
    const before = await reader.read()
    writeFileSync(join(root, 'src', 'app.ts'), 'export const a = 4\n')
    gitIn(root, ['commit', '--quiet', '-am', 'تغییرِ تازه'])

    expect((await reader.read()).commit).toBe(before.commit)
    reader.invalidate()
    expect((await reader.read()).commit).not.toBe(before.commit)
  })
})
