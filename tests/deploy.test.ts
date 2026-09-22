/**
 * `/botupdate` — آزمونِ ایمنیِ استقرار از داخل تلگرام.
 *
 * این تنها قابلیتی است که یک پیام می‌تواند به فرآیندِ shell تبدیل شود، پس
 * آزمون‌ها عمداً روی **مسیرهایی** متمرکزند که شکستشان فاجعه است، نه روی
 * خوش‌بینیِ «کار می‌کند»:
 *
 *   ۱. بیرون از production هیچ فرآیندی اجرا نمی‌شود.
 *   ۲. نبودِ بستهٔ رسمی یا مخزن گیت، قابلیت را می‌بندد (حدس نمی‌زنیم).
 *   ۳. قفلِ هم‌زمانی واقعاً مانع اجرای دوم می‌شود.
 *   ۴. قفلِ رهاشده (crash) خودش منقضی می‌شود و راه را باز می‌کند.
 *   ۵. فازِ «در حال اجرا»ی رهاشده به «ناموفق» تفسیر می‌شود، نه «در حال اجرا».
 *   ۶. مخزنِ بدون ریموت = آفلاین، نه خطا — معماریِ این پروژه آفلاین است.
 *   ۷. سرورِ هم‌کامیت با ریموت → استقرارِ بی‌مورد انجام نمی‌شود.
 *   ۸. تغییراتِ محلیِ کامیت‌نشده → استقرار متوقف می‌شود (داده نابود نمی‌گردد).
 *   ۹. تغییرِ ریموت → `merge --ff-only` واقعاً کد را می‌آورد.
 *  ۱۰. تاریخِ واگرا → خودکار جلو نمی‌رویم.
 */
import { execFileSync } from 'child_process'
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { DeployService } from '../src/modules/deploy/deploy.service'

const ORIGINAL_ENV = { ...process.env }

/**
 * این تنها آزمونی است که فرآیندِ واقعیِ `git` را اجرا می‌کند (مخزنِ موقت،
 * fetch، clone). هر سنجهٔ آن چند برابر آزمون‌های خالص طول می‌کشد و زیر بارِ
 * اجرای موازیِ کل مجموعه می‌تواند از مهلتِ پیش‌فرضِ ۵ ثانیه بگذرد؛ مهلتِ
 * کوتاه‌تر یعنی آزمونِ ناپایدار و ناپایدار یعنی هشدارِ بی‌اعتبار.
 */
jest.setTimeout(60_000)

/**
 * حذفِ پوشهٔ موقت با تحملِ قفلِ کوتاهِ سیستم‌عامل.
 *
 * روی Windows، پس از پایانِ یک فرآیندِ `git` ممکن است دستگیرهٔ پوشه چند لحظه
 * باز بماند و `rmSync` با `EPERM` بیفتد. آن خطا هیچ ربطی به رفتارِ محصول ندارد
 * ولی آزمون را ناپایدار می‌کند (و آزمونِ ناپایدار یعنی هشدارِ بی‌اعتبار).
 */
function removeTempDir(dir: string): void {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'ENOTEMPTY') throw error
      if (attempt === 4) return // پوشهٔ موقتِ سیستم است؛ ماندنش چیزی را نمی‌شکند
      // انتظارِ کوتاهِ همگام (بدونِ وابستگی): دستگیرهٔ ویندوز معمولاً فوراً آزاد می‌شود.
      const until = Date.now() + 50 * (attempt + 1)
      while (Date.now() < until) {
        /* انتظار */
      }
    }
  }
}

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

/**
 * یک مخزنِ «سرور» با ریموتِ محلی می‌سازد — دقیقاً همان شکلِ دیسکی که
 * سرویسِ استقرار انتظار دارد: کارِ checkout، `.git/HEAD`، و اسکریپتِ رسمی.
 */
function makeServerRepo(options: { withRemote?: boolean; withScript?: boolean } = {}): {
  root: string
  remote: string | null
  cleanup: () => void
} {
  const base = mkdtempSync(join(tmpdir(), 'legacy-deploy-'))
  const root = join(base, 'server')
  mkdirSync(root, { recursive: true })
  gitIn(root, ['init', '--quiet', '-b', 'main'])
  gitIn(root, ['config', 'user.email', 'test@example.com'])
  gitIn(root, ['config', 'user.name', 'test'])
  writeFileSync(join(root, 'README.md'), 'server\n')
  if (options.withScript !== false) {
    mkdirSync(join(root, 'offline-deps'), { recursive: true })
    writeFileSync(join(root, 'offline-deps', 'install.sh'), '#!/usr/bin/env bash\necho update\n')
  }
  gitIn(root, ['add', '-A'])
  gitIn(root, ['commit', '--quiet', '-m', 'initial'])

  let remote: string | null = null
  if (options.withRemote) {
    remote = join(base, 'origin.git')
    mkdirSync(remote, { recursive: true })
    gitIn(remote, ['init', '--quiet', '--bare', '-b', 'main'])
    gitIn(root, ['remote', 'add', 'origin', remote])
    gitIn(root, ['push', '--quiet', '-u', 'origin', 'main'])
  }

  return {
    root,
    remote,
    cleanup: () => removeTempDir(base)
  }
}

/** یک کامیتِ تازه روی ریموت می‌سازد (شبیه‌سازیِ انتشارِ نسخهٔ جدید). */
function pushNewCommit(remote: string, file: string, body: string): string {
  const clone = mkdtempSync(join(tmpdir(), 'legacy-clone-'))
  try {
    gitIn(clone, ['clone', '--quiet', remote, '.'])
    gitIn(clone, ['config', 'user.email', 'test@example.com'])
    gitIn(clone, ['config', 'user.name', 'test'])
    writeFileSync(join(clone, file), body)
    gitIn(clone, ['add', '-A'])
    gitIn(clone, ['commit', '--quiet', '-m', `add ${file}`])
    gitIn(clone, ['push', '--quiet', 'origin', 'main'])
    return gitIn(clone, ['rev-parse', 'HEAD'])
  } finally {
    removeTempDir(clone)
  }
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
})

describe('DeployService — دروازهٔ محیط', () => {
  it('بیرون از production هیچ قابلیتی اعلام نمی‌کند', () => {
    process.env.NODE_ENV = 'development'
    const repo = makeServerRepo()
    try {
      const service = new DeployService(repo.root)
      const availability = service.availability()
      expect(availability.available).toBe(false)
      expect(availability.reason).toContain('سرورِ بازی')
      expect(service.status().available).toBe(false)
    } finally {
      repo.cleanup()
    }
  })

  it('در production و با بستهٔ رسمی، قابلیت باز است', () => {
    process.env.NODE_ENV = 'production'
    const repo = makeServerRepo()
    try {
      const service = new DeployService(repo.root)
      expect(service.availability()).toEqual({ available: true, reason: null })
    } finally {
      repo.cleanup()
    }
  })

  it('بدون اسکریپتِ رسمی استقرار، حدس نمی‌زنیم و قابلیت بسته می‌ماند', () => {
    process.env.NODE_ENV = 'production'
    const repo = makeServerRepo({ withScript: false })
    try {
      const service = new DeployService(repo.root)
      const availability = service.availability()
      expect(availability.available).toBe(false)
      expect(availability.reason).toContain('استقرار')
    } finally {
      repo.cleanup()
    }
  })

  it('وضعیت اولیه «بیکار» است و چیزی برای گزارش ندارد', () => {
    process.env.NODE_ENV = 'production'
    const repo = makeServerRepo()
    try {
      const status = new DeployService(repo.root).status()
      expect(status.phase).toBe('idle')
      expect(status.locked).toBe(false)
      expect(status.startedAt).toBeNull()
    } finally {
      repo.cleanup()
    }
  })
})

/**
 * دروازهٔ «همان دیتابیس؟».
 *
 * نصب/آپدیت طبق قرارداد هدف را فقط از `.env` می‌خواند، ولی خودِ ربات با آدرسِ
 * محیطِ فرآیندش کار می‌کند. اگر این دو واگرا شوند، مهاجرت روی یک دیتابیس اجرا
 * می‌شود و ربات روی دیگری می‌نویسد: استقراری «موفق» با داده‌ای دو نیمه. این
 * آزمون قفل می‌کند که در این حالت هیچ فرآیندی پرتاب نمی‌شود.
 */
describe('DeployService — هدفِ دیتابیسِ ربات با .env', () => {
  it('اگر آدرس‌ها فرق کنند، به‌روزرسانی متوقف و بدونِ رمز گزارش می‌شود', async () => {
    process.env.NODE_ENV = 'production'
    process.env.DATABASE_URL = 'postgresql://u:runtime-secret@127.0.0.1:5433/legacy_ux_test'
    const repo = makeServerRepo()
    writeFileSync(
      join(repo.root, '.env'),
      'DATABASE_URL=postgresql://u:file-secret@127.0.0.1:5432/virtual_life\n'
    )
    try {
      const service = new DeployService(repo.root)
      const result = await service.requestUpdate(1n)
      expect(result.started).toBe(false)
      expect(result.reason).toContain('یکی نیست')
      expect(result.reason).toContain('فایلِ تنظیمات')
      expect(result.reason).toContain('127.0.0.1:5433/legacy_ux_test')
      expect(result.reason).toContain('127.0.0.1:5432/virtual_life')
      // پیام به تلگرام می‌رود؛ رمز هرگز:
      expect(result.reason).not.toContain('runtime-secret')
      expect(result.reason).not.toContain('file-secret')

      const state = JSON.parse(
        readFileSync(join(repo.root, '.tools', 'update.state.json'), 'utf8')
      )
      expect(state.phase).toBe('failed')
      expect(state.message).toContain('نصف')
      expect(service.status().locked).toBe(false)
    } finally {
      repo.cleanup()
    }
  })

  it('با آدرسِ یکسان، دروازه چیزی را مسدود نمی‌کند (حتی با نقل‌قول در .env)', async () => {
    process.env.NODE_ENV = 'production'
    process.env.DATABASE_URL = 'postgresql://u@127.0.0.1:5432/virtual_life'
    const repo = makeServerRepo()
    writeFileSync(join(repo.root, '.env'), 'DATABASE_URL="postgresql://u@127.0.0.1:5432/virtual_life"\n')
    try {
      const result = await new DeployService(repo.root).requestUpdate(1n)
      expect(result.reason ?? '').not.toContain('یکی نیست')
    } finally {
      repo.cleanup()
    }
  })
})

describe('DeployService — قفلِ استقرار', () => {
  it('قفلِ زنده دومین درخواست را رد می‌کند و دلیلش را می‌گوید', async () => {
    process.env.NODE_ENV = 'production'
    const repo = makeServerRepo({ withRemote: true })
    try {
      const service = new DeployService(repo.root)
      // قفل را دستی و تازه می‌گذاریم تا رفتارِ «در حال اجرا» را بسنجیم.
      mkdirSync(join(repo.root, '.tools'), { recursive: true })
      writeFileSync(join(repo.root, '.tools', 'update.lock'), '{"pid":1}')

      const result = await service.requestUpdate(6910416744n)
      expect(result.started).toBe(false)
      expect(result.reason).toContain('در جریان')
      expect(service.status().locked).toBe(true)
    } finally {
      repo.cleanup()
    }
  })

  it('قفلِ کهنه (crash) خودش منقضی می‌شود و مانع کار نمی‌ماند', () => {
    process.env.NODE_ENV = 'production'
    const repo = makeServerRepo()
    try {
      mkdirSync(join(repo.root, '.tools'), { recursive: true })
      const lock = join(repo.root, '.tools', 'update.lock')
      writeFileSync(lock, '{"pid":1}')
      // قفل را ۲۱ دقیقه در گذشته مهر می‌زنیم: فرآیند قبلی مرده است.
      const old = new Date(Date.now() - 21 * 60 * 1000)
      utimesSync(lock, old, old)

      const service = new DeployService(repo.root)
      expect(service.status().locked).toBe(false)
    } finally {
      repo.cleanup()
    }
  })

  it('«در حال اجرا»ی رهاشده به «ناموفق» تفسیر می‌شود، نه اجرای ابدی', () => {
    process.env.NODE_ENV = 'production'
    const repo = makeServerRepo()
    try {
      mkdirSync(join(repo.root, '.tools'), { recursive: true })
      writeFileSync(
        join(repo.root, '.tools', 'update.state.json'),
        JSON.stringify({
          phase: 'running',
          startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
          finishedAt: null,
          message: null,
          targetCommit: 'abc123',
          remoteReachable: null,
          actorId: '1'
        })
      )

      const status = new DeployService(repo.root).status()
      expect(status.phase).toBe('failed')
      expect(status.message).toContain('نیمه‌کاره')
    } finally {
      repo.cleanup()
    }
  })
})

describe('DeployService — هماهنگ‌سازی با مخزن', () => {
  it('مخزنِ بدون ریموت = آفلاین؛ نه خطا و نه تصمیمِ خطرناک', async () => {
    process.env.NODE_ENV = 'production'
    const repo = makeServerRepo({ withRemote: false })
    try {
      const outcome = await new DeployService(repo.root).syncFromRemote()
      expect(outcome.kind).toBe('offline')
    } finally {
      repo.cleanup()
    }
  })

  it('سرورِ هم‌کامیت با ریموت: استقرارِ بی‌مورد انجام نمی‌شود', async () => {
    process.env.NODE_ENV = 'production'
    const repo = makeServerRepo({ withRemote: true })
    try {
      const service = new DeployService(repo.root)
      const outcome = await service.syncFromRemote()
      expect(outcome.kind).toBe('up-to-date')

      const result = await service.requestUpdate(6910416744n)
      expect(result.started).toBe(false)
      expect(result.upToDate).toBe(true)
      // هیچ فرآیندی اجرا نشده: نه قفلی مانده، نه لاگی ساخته شده.
      expect(existsSync(join(repo.root, '.tools', 'update.lock'))).toBe(false)
      expect(existsSync(join(repo.root, '.tools', 'update.log'))).toBe(false)
    } finally {
      repo.cleanup()
    }
  })

  it('کامیتِ تازه روی ریموت با ff-only آورده می‌شود', async () => {
    process.env.NODE_ENV = 'production'
    const repo = makeServerRepo({ withRemote: true })
    try {
      const target = pushNewCommit(repo.remote!, 'NEW.md', 'fresh\n')

      const outcome = await new DeployService(repo.root).syncFromRemote()
      expect(outcome.kind).toBe('updated')
      if (outcome.kind === 'updated') {
        expect(outcome.to).toBe(target)
      }
      expect(existsSync(join(repo.root, 'NEW.md'))).toBe(true)
      expect(gitIn(repo.root, ['rev-parse', 'HEAD'])).toBe(target)
    } finally {
      repo.cleanup()
    }
  })

  it('تغییراتِ محلیِ کامیت‌نشده: به‌روزرسانی متوقف می‌شود، داده نابود نمی‌گردد', async () => {
    process.env.NODE_ENV = 'production'
    const repo = makeServerRepo({ withRemote: true })
    try {
      pushNewCommit(repo.remote!, 'NEW.md', 'fresh\n')
      // دستکاریِ محلیِ سرور — همان چیزی که هرگز نباید بی‌صدا پاک شود.
      writeFileSync(join(repo.root, 'LOCAL.md'), 'mine\n')
      const before = gitIn(repo.root, ['rev-parse', 'HEAD'])

      const service = new DeployService(repo.root)
      const outcome = await service.syncFromRemote()
      expect(outcome.kind).toBe('dirty')

      const result = await service.requestUpdate(6910416744n)
      expect(result.started).toBe(false)
      expect(result.reason).toContain('LOCAL.md')
      // فایلِ محلی سرِ جایش مانده و تاریخ عوض نشده.
      expect(existsSync(join(repo.root, 'LOCAL.md'))).toBe(true)
      expect(gitIn(repo.root, ['rev-parse', 'HEAD'])).toBe(before)
    } finally {
      repo.cleanup()
    }
  })

  it('تاریخِ واگرا: خودکار جلو نمی‌رویم', async () => {
    process.env.NODE_ENV = 'production'
    const repo = makeServerRepo({ withRemote: true })
    try {
      pushNewCommit(repo.remote!, 'REMOTE.md', 'remote\n')
      // کامیتِ محلیِ جدا روی سرور: تاریخ دیگر خطی نیست.
      writeFileSync(join(repo.root, 'LOCAL.md'), 'local\n')
      gitIn(repo.root, ['add', '-A'])
      gitIn(repo.root, ['commit', '--quiet', '-m', 'local divergence'])
      const before = gitIn(repo.root, ['rev-parse', 'HEAD'])

      const outcome = await new DeployService(repo.root).syncFromRemote()
      expect(outcome.kind).toBe('error')
      expect(gitIn(repo.root, ['rev-parse', 'HEAD'])).toBe(before)
    } finally {
      repo.cleanup()
    }
  })

  it('گزارش وضعیت هرگز توکن یا رشتهٔ اتصالِ دیتابیس را بیرون نمی‌دهد', () => {
    process.env.NODE_ENV = 'production'
    process.env.BOT_TOKEN = '123456:SUPER-SECRET-TOKEN'
    process.env.DATABASE_URL = 'postgresql://user:pass@host:5432/db'
    const repo = makeServerRepo()
    try {
      const serialized = JSON.stringify(new DeployService(repo.root).status())
      expect(serialized).not.toContain('SUPER-SECRET-TOKEN')
      expect(serialized).not.toContain('postgresql://user:pass')
    } finally {
      repo.cleanup()
    }
  })
})

describe('DeployService — عیب‌یابیِ موجود در دیسک', () => {
  it('فایل‌های وضعیت و قفل در مسیر مستندشده‌اند (قابل بررسی برای Owner)', () => {
    process.env.NODE_ENV = 'production'
    const repo = makeServerRepo()
    try {
      const service = new DeployService(repo.root)
      expect(service.stateFilePath()).toBe(join(repo.root, '.tools', 'update.state.json'))
      expect(service.lockFilePath()).toBe(join(repo.root, '.tools', 'update.lock'))
      // مسیرها باید داخل مخزن بمانند تا هیچ‌وقت جای دیگری نوشته نشود.
      expect(service.stateFilePath().startsWith(repo.root)).toBe(true)
    } finally {
      repo.cleanup()
    }
  })

  it('وضعیتِ خوانا با فایلِ خرابِ وضعیت از پا نمی‌افتد', () => {
    process.env.NODE_ENV = 'production'
    const repo = makeServerRepo()
    try {
      mkdirSync(join(repo.root, '.tools'), { recursive: true })
      writeFileSync(join(repo.root, '.tools', 'update.state.json'), '{ not json')
      const status = new DeployService(repo.root).status()
      expect(status.phase).toBe('idle')
    } finally {
      repo.cleanup()
    }
  })

  it('قفل واقعاً انحصاری است: ساختِ دوبارهٔ همان فایل شکست می‌خورد', () => {
    process.env.NODE_ENV = 'production'
    const repo = makeServerRepo()
    try {
      const lock = join(repo.root, '.tools', 'update.lock')
      mkdirSync(join(repo.root, '.tools'), { recursive: true })
      closeSync(openSync(lock, 'wx'))
      expect(() => openSync(lock, 'wx')).toThrow()
      // و سرویس هم همان را باور می‌کند.
      expect(new DeployService(repo.root).status().locked).toBe(true)
      expect(readFileSync(lock, 'utf8').length).toBeGreaterThanOrEqual(0)
    } finally {
      repo.cleanup()
    }
  })
})
