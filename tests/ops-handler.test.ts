/**
 * مرکز کنترلِ مالک — آزمونِ یکپارچهٔ دسترسی و جریان دکمه‌ها.
 *
 * ## چرا این آزمون مهم‌ترین آزمونِ این قابلیت است
 * این پنل می‌تواند سرور را به‌روزرسانی کند، کلِ دادهٔ بازی را بازگرداند و لاگ
 * سرور را بخواند. یک اشتباه در گاردِ دسترسی، یک حادثهٔ امنیتی است، نه یک
 * باگِ نمایشی. پس این‌جا گارد **واقعاً** اجرا می‌شود: هندلرها روی یک `Bot`
 * واقعی grammy ثبت می‌شوند و Update ساختگی از `bot.handleUpdate` عبور می‌کند؛
 * یعنی ackCallback، editPanel و ترتیبِ بررسی‌ها همه مسیرِ واقعی خود را می‌روند.
 *
 * سنجیده می‌شود که برای **غیرمالک** هیچ داده‌ای بیرون نمی‌رود و هیچ سرویسی
 * صدا زده نمی‌شود — چون گزارشِ درستِ وضعیت خودش اطلاعاتِ حساس است.
 */
import { Bot } from 'grammy'
import type { UserFromGetMe } from 'grammy/types'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { registerOpsHandlers, renderControlCenter } from '../src/bot/handlers/ops.handler'
import { registerDeployHandlers } from '../src/bot/handlers/deploy.handler'
import type { Container } from '../src/services/container'
import type { SystemSnapshot } from '../src/modules/ops/system-status.service'
import type { BackupManifest } from '../src/modules/ops/backup.service'

const OWNER_ID = 6910416744
const STRANGER_ID = 31337
const BACKUP_ID = '20260920123456ab4f'

const ME = {
  id: 1,
  is_bot: true,
  first_name: 'bot',
  username: 'b',
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false
} as unknown as UserFromGetMe

interface ApiCall {
  method: string
  payload: Record<string, unknown>
}

function backupManifest(overrides: Partial<BackupManifest> = {}): BackupManifest {
  return {
    formatVersion: 1,
    id: BACKUP_ID,
    kind: 'manual',
    createdAt: '2026-09-20T08:34:00.000Z',
    durationMs: 120,
    appVersion: '1.0.0',
    commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    commitShort: 'aaaaaaa',
    node: 'v22.22.3',
    migrations: ['20260101000000_a'],
    tables: [{ name: 'players', rows: 12, sha256: 'h' }],
    totalRows: 12,
    dataSha256: 'd',
    dataBytes: 100,
    fileBytes: 100,
    integrity: 'ok',
    integrityNote: 'سالم است.',
    ...overrides
  }
}

function snapshot(overrides: Partial<SystemSnapshot> = {}): SystemSnapshot {
  return {
    runtime: { pid: 42, uptimeSec: 3661, node: 'v22.22.3', env: 'production', rssMb: 180, heapUsedMb: 60 },
    code: {
      version: '1.0.0',
      commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      commitShort: 'aaaaaaa',
      branch: 'main',
      dirtyFiles: [],
      dirtyCount: 0,
      fromGit: true,
      gitAvailable: true,
      artifact: { commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', commitShort: 'aaaaaaa', builtAt: '2026-09-20T00:00:00.000Z', fresh: true }
    },
    database: {
      reachable: true,
      latencyMs: 8,
      version: '16.4',
      sizeBytes: 24_000_000,
      tables: 58,
      error: null,
      migrations: { onDisk: 47, applied: 47, pending: [], missing: [], drifted: [], failed: [], ok: true }
    },
    population: { players: 120, groups: 6 },
    deploy: {
      available: true,
      unavailableReason: null,
      phase: 'success',
      startedAt: null,
      finishedAt: new Date('2026-09-19T10:00:00.000Z'),
      message: null,
      targetCommit: 'aaaaaaa',
      remoteReachable: true,
      locked: false
    },
    deployLockHeld: false,
    ops: { phase: 'idle', operation: null, startedAt: null, finishedAt: null, message: null, backupId: null, actorId: null },
    backups: {
      count: 2,
      newest: { id: BACKUP_ID, kind: 'manual', createdAt: '2026-09-20T08:34:00.000Z', totalRows: 12, fileBytes: 100, commitShort: 'aaaaaaa', integrity: 'ok', tables: 1 },
      invalid: 0,
      unverified: 0,
      totalBytes: 200,
      lockHeld: false
    },
    upgrades: { available: true, reason: null },
    ...overrides
  }
}

interface Harness {
  calls: ApiCall[]
  container: Container
  spy: {
    isOwner: jest.Mock
    isAdmin: jest.Mock
    requestRestore: jest.Mock
    remove: jest.Mock
    prune: jest.Mock
    create: jest.Mock
    verify: jest.Mock
    snapshot: jest.Mock
  }
}

/**
 * `owner` = مالکِ ربات، `admin` = ادمینِ فعالِ غیرمالک، `stranger` = کاربر عادی.
 *
 * تفکیکِ این سه لازم است چون قراردادِ دسترسی دو لایه دارد: مدیریتِ بکاپ برای
 * هر ادمینِ فعال باز است، ولی به‌روزرسانیِ سرور و لاگ مالک‌محور می‌مانند.
 */
function build(
  role: 'owner' | 'admin' | 'stranger',
  root: string,
  manifest: BackupManifest | null = backupManifest()
): Harness {
  const calls: ApiCall[] = []
  const spy = {
    isOwner: jest.fn(async (id: bigint) => role === 'owner' && id === BigInt(OWNER_ID)),
    // ادمینِ فعال: مالک هم یک ادمین است، و در نقشِ `admin` کاربرِ دوم (نه مالک).
    isAdmin: jest.fn(async (id: bigint) =>
      role === 'owner'
        ? id === BigInt(OWNER_ID)
        : role === 'admin'
          ? id === BigInt(STRANGER_ID)
          : false
    ),
    requestRestore: jest.fn(() => ({ started: true, reason: null, outcome: null })),
    remove: jest.fn(() => true),
    prune: jest.fn(() => []),
    create: jest.fn(async () => backupManifest()),
    verify: jest.fn(async () => ({ id: BACKUP_ID, ok: true, integrity: 'ok' as const, note: 'سالم است.', tables: 1, rows: 12, dataSha256: 'd' })),
    snapshot: jest.fn(async () => snapshot())
  }

  const container = {
    adminService: { isOwner: spy.isOwner, isAdmin: spy.isAdmin },
    deployService: {
      status: () => snapshot().deploy,
      availability: () => ({ available: true, reason: null }),
      requestUpdate: jest.fn(),
      syncFromRemote: jest.fn()
    },
    backupService: {
      list: () => [
        {
          id: BACKUP_ID,
          kind: 'manual' as const,
          createdAt: '2026-09-20T08:34:00.000Z',
          totalRows: 12,
          fileBytes: 100,
          commitShort: 'aaaaaaa',
          integrity: 'ok' as const,
          tables: 1
        }
      ],
      readManifest: () => manifest,
      verify: spy.verify,
      create: spy.create,
      remove: spy.remove,
      prune: spy.prune,
      requestRestore: spy.requestRestore,
      dirPath: (id: string) => join(root, '.tools', 'backups', id)
    },
    systemStatusService: { snapshot: spy.snapshot, codeInfo: async () => snapshot().code }
  } as unknown as Container

  const bot = new Bot('test:token', { botInfo: ME })
  bot.api.config.use((_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> })
    const result =
      method === 'getMe'
        ? ME
        : { message_id: 5, date: 1_700_000_000, chat: { id: 1, type: 'private' } }
    return Promise.resolve({ ok: true, result } as never)
  })
  registerOpsHandlers(bot, container)
  registerDeployHandlers(bot, container)

  return { calls, container, spy }
}

function callbackUpdate(data: string, userId: number, chatType: 'private' | 'group' = 'private') {
  return {
    update_id: 1,
    callback_query: {
      id: 'cq1',
      from: { id: userId, is_bot: false, first_name: 'u' },
      chat_instance: 'ci',
      data,
      message: {
        message_id: 5,
        date: 1_700_000_000,
        text: 'old',
        chat: { id: userId, type: chatType }
      }
    }
  }
}

function commandUpdate(command: string, userId: number, chatType: 'private' | 'group' = 'private') {
  return {
    update_id: 2,
    message: {
      message_id: 7,
      date: 1_700_000_000,
      text: command,
      chat: { id: userId, type: chatType },
      from: { id: userId, is_bot: false, first_name: 'u' },
      entities: [{ type: 'bot_command', offset: 0, length: command.length }]
    }
  }
}

/** همهٔ متنی که در این نوبت به تلگرام رفت. */
function outgoingText(calls: ApiCall[]): string {
  return calls
    .map((call) => JSON.stringify(call.payload))
    .join('\n')
}

describe('مرکز کنترل: مرزِ دسترسی', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'legacy-ops-handler-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  test('در گروه حتی مالک هم پنل نمی‌گیرد و هیچ سرویسی خوانده نمی‌شود', async () => {
    const harness = build('owner', root)
    const bot = new Bot('test:token', { botInfo: ME })
    const calls: ApiCall[] = []
    bot.api.config.use((_p, method, payload) => {
      calls.push({ method, payload: payload as Record<string, unknown> })
      return Promise.resolve({ ok: true, result: { message_id: 1, date: 1, chat: { id: 1, type: 'private' } } } as never)
    })
    registerOpsHandlers(bot, harness.container)

    await bot.handleUpdate(commandUpdate('/botupdate', OWNER_ID, 'group') as never)

    expect(outgoingText(calls)).toContain('چت خصوصی')
    expect(harness.spy.snapshot).not.toHaveBeenCalled()
    expect(harness.spy.isOwner).not.toHaveBeenCalled()
  })

  test('برای غیرمالک هیچ داده‌ای بیرون نمی‌رود', async () => {
    const harness = build('stranger', root)
    const bot = new Bot('test:token', { botInfo: ME })
    const calls: ApiCall[] = []
    bot.api.config.use((_p, method, payload) => {
      calls.push({ method, payload: payload as Record<string, unknown> })
      return Promise.resolve({ ok: true, result: { message_id: 1, date: 1, chat: { id: 1, type: 'private' } } } as never)
    })
    registerOpsHandlers(bot, harness.container)

    await bot.handleUpdate(commandUpdate('/botupdate', STRANGER_ID) as never)

    expect(harness.spy.snapshot).not.toHaveBeenCalled()
    const text = outgoingText(calls)
    expect(text).not.toContain('مرکز کنترل')
    // هیچ نشانه‌ای از وجودِ چنین قابلیتی هم نباید بدهد
    expect(text).not.toContain('بکاپ')
    expect(text).not.toContain('دیتابیس')
  })

  test('برای غیرمالک، فشار دادنِ دکمهٔ پنل هم کاری نمی‌کند', async () => {
    const harness = build('stranger', root)
    const bot = new Bot('test:token', { botInfo: ME })
    const calls: ApiCall[] = []
    bot.api.config.use((_p, method, payload) => {
      calls.push({ method, payload: payload as Record<string, unknown> })
      return Promise.resolve({ ok: true, result: { message_id: 1, date: 1, chat: { id: 1, type: 'private' } } } as never)
    })
    registerOpsHandlers(bot, harness.container)

    await bot.handleUpdate(callbackUpdate('op:panel', STRANGER_ID) as never)

    expect(outgoingText(calls)).not.toContain('مرکز کنترل')
    expect(harness.spy.snapshot).not.toHaveBeenCalled()
  })

  test('برای مالک، پنل با وضعیتِ واقعی ساخته می‌شود', async () => {
    const harness = build('owner', root)
    const bot = new Bot('test:token', { botInfo: ME })
    const calls: ApiCall[] = []
    bot.api.config.use((_p, method, payload) => {
      calls.push({ method, payload: payload as Record<string, unknown> })
      return Promise.resolve({ ok: true, result: { message_id: 1, date: 1, chat: { id: 1, type: 'private' } } } as never)
    })
    registerOpsHandlers(bot, harness.container)
    await bot.handleUpdate(commandUpdate('/botupdate', OWNER_ID) as never)

    const text = outgoingText(calls)
    expect(text).toContain('مرکز کنترل')
    expect(text).toContain('aaaaaaa')
    expect(text).toContain('16.4')
    expect(text).toContain('۱۲')
    expect(harness.spy.snapshot).toHaveBeenCalled()
  })

  test('ادمینِ فعال مرکز کنترل را می‌گیرد، ولی دکمهٔ مالک به او نشان داده نمی‌شود', async () => {
    const harness = build('admin', root)
    const bot = new Bot('test:token', { botInfo: ME })
    const calls: ApiCall[] = []
    bot.api.config.use((_p, method, payload) => {
      calls.push({ method, payload: payload as Record<string, unknown> })
      return Promise.resolve({ ok: true, result: { message_id: 1, date: 1, chat: { id: 1, type: 'private' } } } as never)
    })
    registerOpsHandlers(bot, harness.container)

    await bot.handleUpdate(commandUpdate('/botupdate', STRANGER_ID) as never)

    const text = outgoingText(calls)
    expect(text).toContain('مرکز کنترل')
    // بکاپ برایش باز است…
    expect(text).toContain('bk:panel')
    // …ولی دکمه‌های مالک‌محور رندر نمی‌شوند (دکمهٔ بی‌دسترسی = بن‌بست).
    expect(text).not.toContain('deploy:panel')
    expect(text).not.toContain('op:logs')
  })

  test('ادمینِ فعال می‌تواند پنلِ بکاپ‌ها را باز کند', async () => {
    const harness = build('admin', root)
    const bot = new Bot('test:token', { botInfo: ME })
    const calls: ApiCall[] = []
    bot.api.config.use((_p, method, payload) => {
      calls.push({ method, payload: payload as Record<string, unknown> })
      return Promise.resolve({ ok: true, result: { message_id: 1, date: 1, chat: { id: 1, type: 'private' } } } as never)
    })
    registerOpsHandlers(bot, harness.container)

    await bot.handleUpdate(callbackUpdate('bk:panel', STRANGER_ID) as never)

    expect(outgoingText(calls)).toContain('بکاپ')
    expect(harness.spy.isAdmin).toHaveBeenCalled()
  })
})

describe('بازیابی: تأییدِ دومرحله‌ای و گاردها', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'legacy-ops-handler-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  async function press(data: string, role: 'owner' | 'stranger' = 'owner', manifest = backupManifest()) {
    const harness = build(role, root, manifest)
    const bot = new Bot('test:token', { botInfo: ME })
    const calls: ApiCall[] = []
    bot.api.config.use((_p, method, payload) => {
      calls.push({ method, payload: payload as Record<string, unknown> })
      return Promise.resolve({ ok: true, result: { message_id: 1, date: 1, chat: { id: 1, type: 'private' } } } as never)
    })
    registerOpsHandlers(bot, harness.container)
    await bot.handleUpdate(callbackUpdate(data, OWNER_ID) as never)
    return { harness, text: outgoingText(calls) }
  }

  test('یک لمس، بازیابی را شروع نمی‌کند', async () => {
    const { harness, text } = await press(`bk:r:${BACKUP_ID}`)
    expect(harness.spy.requestRestore).not.toHaveBeenCalled()
    // صفحهٔ تأیید باید صریح بگوید چه اتفاقی می‌افتد
    expect(text).toContain('بکاپِ ایمنی')
    expect(text).toContain('تراکنش')
  })

  test('تأییدِ دوم بازیابی را شروع می‌کند', async () => {
    const { harness } = await press(`bk:r2:${BACKUP_ID}`)
    expect(harness.spy.requestRestore).toHaveBeenCalledWith(BACKUP_ID, BigInt(OWNER_ID))
  })

  test('غیرمالک با تأییدِ دوم هم نمی‌تواند بازیابی کند', async () => {
    const { harness } = await press(`bk:r2:${BACKUP_ID}`, 'stranger')
    expect(harness.spy.requestRestore).not.toHaveBeenCalled()
  })

  test('اگر شروع نشد، دلیل به مالک گفته می‌شود و پنل خراب نمی‌شود', async () => {
    const harness = build('owner', root)
    harness.spy.requestRestore.mockReturnValue({ started: false, reason: 'یک عملیاتِ سنگینِ دیگر همین حالا در جریان است.', outcome: null })
    const bot = new Bot('test:token', { botInfo: ME })
    const calls: ApiCall[] = []
    bot.api.config.use((_p, method, payload) => {
      calls.push({ method, payload: payload as Record<string, unknown> })
      return Promise.resolve({ ok: true, result: { message_id: 1, date: 1, chat: { id: 1, type: 'private' } } } as never)
    })
    registerOpsHandlers(bot, harness.container)

    await bot.handleUpdate(callbackUpdate(`bk:r2:${BACKUP_ID}`, OWNER_ID) as never)

    expect(outgoingText(calls)).toContain('در جریان')
  })

  test('بکاپِ خراب حتی دکمهٔ بازیابی هم ندارد', async () => {
    const { text } = await press(`bk:r:${BACKUP_ID}`, 'owner', backupManifest({ integrity: 'invalid' }))
    expect(text).toContain('خراب')
  })

  test('شناسهٔ دست‌کاری‌شده به هیچ سرویسی نمی‌رسد', async () => {
    const { harness } = await press('bk:v:../../etc/passwd')
    expect(harness.spy.verify).not.toHaveBeenCalled()
    expect(harness.spy.requestRestore).not.toHaveBeenCalled()
  })

  test('بکاپِ ناموجود «دیگر وجود ندارد» می‌دهد، نه خطا', async () => {
    const { text } = await press(`bk:view:${BACKUP_ID}`, 'owner', null as unknown as BackupManifest)
    expect(text).toContain('وجود ندارد')
  })

  test('حذف هم تأییدِ دوم می‌خواهد', async () => {
    const first = await press(`bk:del:${BACKUP_ID}`)
    expect(first.harness.spy.remove).not.toHaveBeenCalled()
    const second = await press(`bk:del2:${BACKUP_ID}`)
    expect(second.harness.spy.remove).toHaveBeenCalledWith(BACKUP_ID)
  })
})

describe('متنِ پنلِ وضعیت', () => {
  test('هم‌خوانیِ کامل به‌صورت صریح گفته می‌شود', () => {
    const text = renderControlCenter(snapshot())
    expect(text).toContain('مرکز کنترل')
    expect(text).toContain('هم‌خوان')
    expect(text).toContain('همه‌چیز مرتب است')
  })

  test('ناسالمی‌ها در پانویس هشدار داده می‌شوند', () => {
    const text = renderControlCenter(
      snapshot({
        database: {
          reachable: false,
          latencyMs: null,
          version: null,
          sizeBytes: null,
          tables: null,
          error: 'دیتابیس پاسخ نداد.',
          migrations: null
        },
        code: {
          ...snapshot().code,
          artifact: { commit: null, commitShort: null, builtAt: null, fresh: false }
        },
        backups: { count: 1, newest: null, invalid: 1, unverified: 0, totalBytes: 0, lockHeld: false }
      })
    )
    expect(text).toContain('جواب نمی‌دهد')
    expect(text).toContain('کدِ قدیمی')
    expect(text).toContain('خراب است')
  })
})
