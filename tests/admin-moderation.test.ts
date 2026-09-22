import { resolve } from 'node:path'
import { readText } from './helpers/source'
import { BotAdminRole, NotificationType, PlayerStatus, PrismaClient } from '@prisma/client'
import type { InlineKeyboard } from 'grammy'
import {
  ADMIN_MESSAGE_LIMITS,
  AdminService,
  PLAYER_DATA_PLAN,
  WARNING_BAN_THRESHOLD,
  WARNING_REASON_LIMITS,
  textLimitText,
  validateAdminMessage,
  validateWarningReason
} from '../src/modules/admin/admin.service'
import { buildAdminModerationKeyboard } from '../src/bot/handlers/admin.handler'
import { ConflictError, NotFoundError, UnauthorizedError, ValidationError } from '../src/utils/classes/errors'

const OWNER_ID = 6910416744n
const ADMIN_ID = 8369939024n
const STRANGER_ID = 123n
const TARGET_ID = 999n

const PLAYER_ROW = {
  id: 'p1',
  firstName: 'بازیکن',
  lastName: 'هدف',
  balance: 250_000n,
  status: PlayerStatus.ACTIVE,
  warnings: []
}

const MODEL_METHODS = [
  'findUnique',
  'findFirst',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  'create',
  'createMany',
  'update',
  'updateMany',
  'delete',
  'deleteMany',
  'upsert'
] as const

/** هر مدلی که سرویس مدیریت لمس می‌کند؛ فهرستِ صریح تا تایپ‌ها `undefined` نگیرند. */
const MODEL_NAMES = [
  'achievementGrant',
  'adminLog',
  'auction',
  'auctionBid',
  'bankAccount',
  'botAdmin',
  'business',
  'businessBranch',
  'businessEmployee',
  'dailyFortune',
  'dailyQuest',
  'electionCandidate',
  'financialTransaction',
  'gameEvent',
  'gymMembership',
  'insurancePolicy',
  'jobApplication',
  'jobPosting',
  'loan',
  'lotteryTicket',
  'marketListing',
  'marriage',
  'marriageProposal',
  'migration',
  'notification',
  'pet',
  'player',
  'playerGroup',
  'playerInventory',
  'playerLoan',
  'playerReport',
  'playerSkill',
  'playerWarning',
  'property',
  'referral',
  'regionalChallengeContribution',
  'relationship',
  'rentalContract',
  'termDeposit',
  'travelStamp',
  'userState',
  'vote',
  'weeklyChest',
  'workSession'
] as const

type LooseModel = Record<(typeof MODEL_METHODS)[number], jest.Mock>
type MockQuery = {
  $transaction: jest.Mock
  $queryRaw: jest.Mock
  $executeRaw: jest.Mock
  models: Map<string, LooseModel>
} & Record<(typeof MODEL_NAMES)[number], LooseModel>

/**
 * پایگاه‌دادهٔ ماک با پروکسی: هر مدلِ Prisma که سرویس لمس کند، خودبه‌خود
 * ماک می‌شود. اگر روزی مدلی به اسکیما اضافه شود و مسیر حذف حساب آن را
 * نبیند، تستِ پوششِ اسکیما (پایین همین فایل) جلویش را می‌گیرد.
 */
function makeQuery() {
  const models = new Map<string, LooseModel>()

  const defaults: Record<string, unknown> = {
    findUnique: null,
    findFirst: null,
    findMany: [],
    count: 0,
    aggregate: { _sum: {} },
    groupBy: [],
    create: { id: 'created-id' },
    createMany: { count: 0 },
    update: {},
    updateMany: { count: 0 },
    delete: {},
    deleteMany: { count: 0 },
    upsert: {}
  }

  const modelFor = (name: string): LooseModel => {
    let model = models.get(name)
    if (!model) {
      const fresh = {} as Record<string, jest.Mock>
      for (const method of MODEL_METHODS) {
        fresh[method] = jest.fn().mockResolvedValue(defaults[method])
      }
      model = fresh as unknown as LooseModel
      models.set(name, model)
    }
    return model
  }

  const base: Record<string | symbol, unknown> = {
    $queryRaw: jest.fn().mockResolvedValue([{ role: BotAdminRole.ADMIN, isActive: true }]),
    $executeRaw: jest.fn().mockResolvedValue(1),
    $queryRawUnsafe: jest.fn().mockResolvedValue([])
  }

  const handler = {
    get(target: Record<string | symbol, unknown>, prop: string) {
      if (prop in target) {
        return target[prop]
      }
      return modelFor(prop)
    }
  }

  const tx = new Proxy(
    { ...base, $queryRaw: jest.fn().mockResolvedValue([{ role: BotAdminRole.ADMIN, isActive: true }]) },
    handler
  ) as unknown as MockQuery

  const db = new Proxy(
    {
      ...base,
      $transaction: jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx))
    },
    handler
  ) as unknown as MockQuery
  db.models = models
  tx.models = models

  return { db, tx, models, modelFor }
}

/** کاربری که هیچ ردیف ادمینی ندارد: نه در جدول، نه در قفلِ تراکنش. */
function makeStrangerService() {
  const ctx = makeService(BotAdminRole.ADMIN, STRANGER_ID)
  ctx.db.botAdmin.findUnique.mockResolvedValue(null)
  ctx.authorized.mockResolvedValue([])
  return ctx
}

/** متنِ کوئریِ قالبیِ Prisma؛ برای دیدن اینکه چه قفلی گرفته شده است. */
function sqlText(arg: unknown): string {
  return arg === null || arg === undefined ? '' : String(arg)
}

function makeService(actorRole: BotAdminRole = BotAdminRole.ADMIN, actorId = ADMIN_ID) {
  const { db, tx, models, modelFor } = makeQuery()
  const authorized = jest.fn().mockResolvedValue([{ role: actorRole, isActive: true }])
  db.$queryRaw = authorized
  tx.$queryRaw = authorized
  // ادمینِ مجازِ اجراکننده
  db.botAdmin.findUnique.mockImplementation(({ where }: { where: { telegramUserId: bigint } }) =>
    where.telegramUserId === actorId
      ? Promise.resolve({ telegramUserId: actorId, role: actorRole, isActive: true })
      : Promise.resolve(null)
  )
  const service = new AdminService(db as unknown as PrismaClient)
  return { service, db, tx, models, modelFor, authorized }
}

describe('پوشش استاتیک: هیچ رابطه‌ای با بازیکن نباید از نقشهٔ حذف جا بماند', () => {
  const schema = readText(resolve(__dirname, '../prisma/schema.prisma'))

  const schemaRelations = [...schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^}/gm)]
    .map((match) => ({ name: match[1] ?? '', body: match[2] ?? '' }))
    .filter((model) => model.name !== 'Player')
    .flatMap((model) =>
      model.body
        .split('\n')
        .map((line) => line.match(/^\s*(\w+)\s+Player(\[\])?\??\s/))
        .map((match) => (match?.[1] ? `${model.name}.${match[1]}` : null))
        .filter((key): key is string => key !== null)
    )

  test('اسکیما واقعاً رابطه‌هایی با Player دارد (تست خالی نیست)', () => {
    expect(schemaRelations.length).toBeGreaterThan(40)
  })

  test('هر رابطهٔ اسکیما در PLAYER_DATA_PLAN یک قاعدهٔ صریح دارد', () => {
    const planned = Object.keys(PLAYER_DATA_PLAN)
    const missing = schemaRelations.filter((relation) => !planned.includes(relation))
    expect(missing).toEqual([])
  })

  test('هیچ قاعدهٔ کهنه‌ای در PLAYER_DATA_PLAN نمانده باشد', () => {
    const stale = Object.keys(PLAYER_DATA_PLAN)
      .filter((key) => key !== 'UserState.telegramUserId')
      .filter((key) => !schemaRelations.includes(key))
    expect(stale).toEqual([])
  })
})

describe('قانون متنِ اقدام مدیریتی', () => {
  test('مرزها با چیزی که پنل نشان می‌دهد یکی است', () => {
    expect(WARNING_BAN_THRESHOLD).toBe(3)
    expect(textLimitText(WARNING_REASON_LIMITS)).toContain('۳')
    expect(textLimitText(ADMIN_MESSAGE_LIMITS)).toContain('۵۰۰')
  })

  test('دلیل اخطار کوتاه، خالی یا بیش‌ازحد رد می‌شود', () => {
    expect(() => validateWarningReason('')).toThrow(ValidationError)
    expect(() => validateWarningReason('ab')).toThrow(ValidationError)
    expect(() => validateWarningReason('   ')).toThrow(ValidationError)
    expect(() => validateWarningReason('x'.repeat(WARNING_REASON_LIMITS.max + 1))).toThrow(
      ValidationError
    )
  })

  test('متن سالم تمیز و بدون نشانه‌های قالب‌بندی برگردانده می‌شود', () => {
    expect(validateWarningReason('  فریب در معاملهٔ بازار  ')).toBe('فریب در معاملهٔ بازار')
    expect(validateAdminMessage('سلام، موجودی‌ات بررسی شد.')).toBe('سلام، موجودی‌ات بررسی شد.')
    expect(() => validateAdminMessage('ok')).toThrow(ValidationError)
    expect(() => validateAdminMessage('m'.repeat(ADMIN_MESSAGE_LIMITS.max + 1))).toThrow(
      ValidationError
    )
  })
})

describe('صدور اخطار', () => {
  function armed(actorRole = BotAdminRole.ADMIN, actorId = ADMIN_ID) {
    const ctx = makeService(actorRole, actorId)
    ctx.tx.player.findUnique.mockResolvedValue({ ...PLAYER_ROW })
    ctx.tx.playerWarning.count.mockResolvedValue(1)
    return ctx
  }

  test('ادمین نبودن، پیش از هر نوشتاری رد می‌شود', async () => {
    const { service, tx } = makeStrangerService()
    await expect(service.issueWarning(STRANGER_ID, TARGET_ID, 'رفتار نامناسب')).rejects.toThrow(
      UnauthorizedError
    )
    expect(tx.playerWarning.create).not.toHaveBeenCalled()
  })

  test('هدفِ ادمینِ ربات اخطار نمی‌گیرد؛ اول باید دسترسی‌اش گرفته شود', async () => {
    const { service, db, tx } = makeService()
    db.botAdmin.findUnique.mockImplementation(({ where }: { where: { telegramUserId: bigint } }) =>
      where.telegramUserId === TARGET_ID
        ? Promise.resolve({ telegramUserId: TARGET_ID, role: BotAdminRole.ADMIN, isActive: true })
        : Promise.resolve({ telegramUserId: ADMIN_ID, role: BotAdminRole.ADMIN, isActive: true })
    )
    await expect(service.issueWarning(ADMIN_ID, TARGET_ID, 'رفتار نامناسب')).rejects.toThrow(
      ConflictError
    )
    expect(tx.playerWarning.create).not.toHaveBeenCalled()
  })

  test('دلیل نامعتبر اصلاً به دیتابیس نمی‌رسد', async () => {
    const { service, tx } = armed()
    await expect(service.issueWarning(ADMIN_ID, TARGET_ID, '!')).rejects.toThrow(ValidationError)
    expect(tx.playerWarning.create).not.toHaveBeenCalled()
  })

  test('اخطار اول و دوم فقط ثبت می‌شود؛ مسدودسازی رخ نمی‌دهد', async () => {
    const { service, tx } = armed()
    tx.playerWarning.count.mockResolvedValue(2)
    const result = await service.issueWarning(ADMIN_ID, TARGET_ID, 'تبلیغ نامربوط در گروه')

    expect(result).toEqual({ activeCount: 2, banned: false, remainingUntilBan: 1 })
    expect(tx.playerWarning.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ playerId: 'p1', issuedBy: ADMIN_ID, reason: 'تبلیغ نامربوط در گروه' })
      })
    )
    expect(tx.player.updateMany).not.toHaveBeenCalled()
    expect(tx.adminLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'warning_issue' }) })
    )
  })

  test('دلیلِ اخطار به خودِ بازیکن هم می‌رسد، نه فقط به پنل ادمین', async () => {
    const { service, tx } = armed()
    tx.playerWarning.count.mockResolvedValue(1)

    await service.issueWarning(ADMIN_ID, TARGET_ID, 'تبلیغ نامربوط در گروه')

    expect(tx.notification.create).toHaveBeenCalledTimes(1)
    const notice = tx.notification.create.mock.calls[0]![0] as {
      data: { playerId: string; title: string; message: string; type: string; dedupeKey: string }
    }
    expect(notice.data.playerId).toBe('p1')
    expect(notice.data.type).toBe(NotificationType.WARNING)
    expect(notice.data.message).toContain('تبلیغ نامربوط در گروه')
    expect(notice.data.message).toContain('۲ اخطار دیگر')
    expect(notice.data.dedupeKey).toBe('warning:created-id')
    expect(notice.data.message).not.toMatch(/undefined|NaN|\[object Object\]/)
  })

  test('اخطارِ بازیکنِ ازقبل مسدود، شمارِ باقی‌ماندهٔ گمراه‌کننده نمی‌سازد', async () => {
    const { service, tx } = armed()
    tx.player.findUnique.mockResolvedValue({ ...PLAYER_ROW, status: PlayerStatus.BANNED })
    tx.playerWarning.count.mockResolvedValue(4)

    const result = await service.issueWarning(ADMIN_ID, TARGET_ID, 'تخلف پس از مسدودسازی')

    expect(result.banned).toBe(false)
    const notice = tx.notification.create.mock.calls[0]![0] as { data: { message: string } }
    expect(notice.data.message).toContain('حساب مسدود است')
    expect(notice.data.message).not.toContain('اخطار دیگر')
  })

  test('اخطار سوم همان‌جا مسدود می‌کند، نوبت کاری را می‌بندد و به بازیکن خبر می‌دهد', async () => {
    const { service, tx } = armed()
    tx.playerWarning.count.mockResolvedValue(WARNING_BAN_THRESHOLD)
    tx.player.updateMany.mockResolvedValue({ count: 1 })
    tx.workSession.findMany.mockResolvedValue([{ id: 'w1', jobKey: 'bakery' }])
    tx.workSession.updateMany.mockResolvedValue({ count: 1 })

    const result = await service.issueWarning(ADMIN_ID, TARGET_ID, 'سومین تخلف ثبت‌شده')

    expect(result.banned).toBe(true)
    expect(result.remainingUntilBan).toBe(0)
    // نوشتار شرطی: اگر کس دیگری همزمان بن کرده باشد، این نوشتار صفر می‌زند
    expect(tx.player.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'p1', status: { not: PlayerStatus.BANNED } },
        data: expect.objectContaining({ status: PlayerStatus.BANNED, activityState: 'IDLE' })
      })
    )
    expect(tx.playerWarning.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'created-id', causedBan: false } })
    )
    // فقط یک اعلان: همان خبرِ مسدودسازی (اخطارِ سوم جداگانه تکرار نمی‌شود)
    expect(tx.notification.create).toHaveBeenCalledTimes(1)
    expect(tx.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          playerId: 'p1',
          type: NotificationType.WARNING,
          dedupeKey: 'warning-ban:created-id'
        })
      })
    )
    expect(tx.notification.create.mock.calls[0]![0].data.message).toContain('سومین تخلف ثبت‌شده')
    expect(tx.workSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'w1', playerId: 'p1', status: 'ACTIVE' },
        data: expect.objectContaining({ status: 'CANCELLED' })
      })
    )
    // ظرفیت شغل آزاد می‌شود تا بازیکن دیگری جای او کار کند
    expect(sqlText(tx.$executeRaw.mock.calls[0]?.[0])).toContain('job_capacities')
    expect(tx.adminLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'warning_issue_auto_ban' }) })
    )
  })

  test('بازندهٔ رقابتِ همزمان، بن را دوباره ثبت نمی‌کند', async () => {
    const { service, tx } = armed()
    tx.playerWarning.count.mockResolvedValue(4)
    tx.player.updateMany.mockResolvedValue({ count: 0 })

    const result = await service.issueWarning(ADMIN_ID, TARGET_ID, 'اخطار چهارم، بعد از بن')

    expect(result.banned).toBe(false)
    // خبرِ مسدودسازی تکراری ساخته نمی‌شود؛ فقط اعلانِ خودِ اخطار
    const notices = tx.notification.create.mock.calls.map(
      (call) => (call[0] as { data: { dedupeKey?: string } }).data.dedupeKey
    )
    expect(notices).toEqual(['warning:created-id'])
    expect(tx.adminLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'warning_issue' }) })
    )
  })

  test('ردیف بازیکن پیش از نوشتن قفل می‌شود (FOR UPDATE)', async () => {
    const { service, authorized } = armed()
    await service.issueWarning(ADMIN_ID, TARGET_ID, 'رفتار نامناسب در گروه')
    const statements = authorized.mock.calls.map((call) => sqlText(call[0]))
    expect(statements.some((sql) => sql.includes('FOR UPDATE'))).toBe(true)
  })
})

describe('لغو اخطار', () => {
  function armed() {
    const ctx = makeService()
    ctx.tx.player.findUnique.mockResolvedValue({ ...PLAYER_ROW, status: PlayerStatus.BANNED })
    return ctx
  }

  test('لغو، مسدودسازی را خاموش برنمی‌گرداند', async () => {
    const { service, tx } = armed()
    tx.playerWarning.updateMany.mockResolvedValue({ count: 1 })
    tx.playerWarning.count.mockResolvedValue(2)

    const result = await service.revokeWarning(ADMIN_ID, TARGET_ID, 'w1')

    expect(result).toEqual({ activeCount: 2, stillBanned: true })
    expect(tx.playerWarning.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'w1', playerId: 'p1', isActive: true },
        data: expect.objectContaining({ isActive: false })
      })
    )
    expect(tx.player.updateMany).not.toHaveBeenCalled()
    expect(tx.adminLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'warning_revoke' }) })
    )
  })

  test('اخطارِ تکراری یا متعلق به بازیکن دیگر لغو نمی‌شود', async () => {
    const { service, tx } = armed()
    tx.playerWarning.updateMany.mockResolvedValue({ count: 0 })
    await expect(service.revokeWarning(ADMIN_ID, TARGET_ID, 'w-other')).rejects.toThrow(NotFoundError)
    expect(tx.adminLog.create).not.toHaveBeenCalled()
  })

  test('بازیکنِ ناموجود، خطای روشن می‌دهد', async () => {
    const { service, tx } = armed()
    tx.player.findUnique.mockResolvedValue(null)
    await expect(service.revokeWarning(ADMIN_ID, TARGET_ID, 'w1')).rejects.toThrow(NotFoundError)
  })
})

describe('پیام مدیریت به بازیکن', () => {
  test('پیام حتی اگر خصوصی نرسد، در اعلان‌های بازی می‌ماند', async () => {
    const { service, tx } = makeService()
    tx.player.findUnique
      .mockResolvedValueOnce({ ...PLAYER_ROW })
      .mockResolvedValueOnce({ firstName: 'بازیکن' })
    tx.notification.create.mockResolvedValue({ id: 'n1' })

    const result = await service.sendPlayerMessage(ADMIN_ID, TARGET_ID, 'موجودی‌ات بررسی و اصلاح شد.')

    expect(result).toEqual({ firstName: 'بازیکن', notificationId: 'n1' })
    expect(tx.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ playerId: 'p1', message: 'موجودی‌ات بررسی و اصلاح شد.' })
      })
    )
    expect(tx.adminLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'message_send' }) })
    )
  })

  test('پیام خالی یا خیلی بلند ثبت نمی‌شود', async () => {
    const { service, tx } = makeService()
    await expect(service.sendPlayerMessage(ADMIN_ID, TARGET_ID, 'hi')).rejects.toThrow(ValidationError)
    expect(tx.notification.create).not.toHaveBeenCalled()
  })
})

describe('نمای مدیریتِ اخطارها', () => {
  test('شمارش فعال و فاصله تا مسدودسازی از آستانه می‌آید', async () => {
    const { service, db } = makeService()
    db.player.findUnique.mockResolvedValue({
      id: 'p1',
      firstName: 'بازیکن',
      lastName: null,
      status: PlayerStatus.ACTIVE,
      warnings: [{ id: 'w1', reason: 'a', issuedBy: ADMIN_ID, isActive: true, causedBan: false, createdAt: new Date(), revokedAt: null }]
    })
    db.playerWarning.count.mockResolvedValue(2)

    const view = await service.getModerationView(ADMIN_ID, TARGET_ID)

    expect(view.activeCount).toBe(2)
    expect(view.threshold).toBe(WARNING_BAN_THRESHOLD)
    expect(view.remainingUntilBan).toBe(1)
  })

  test('برای بازیکن مسدود، «فاصله تا بن» صفر است نه عدد گمراه‌کننده', async () => {
    const { service, db } = makeService()
    db.player.findUnique.mockResolvedValue({
      id: 'p1',
      firstName: 'بازیکن',
      lastName: null,
      status: PlayerStatus.BANNED,
      warnings: []
    })
    db.playerWarning.count.mockResolvedValue(3)

    const view = await service.getModerationView(ADMIN_ID, TARGET_ID)
    expect(view.remainingUntilBan).toBe(0)
    expect(view.status).toBe(PlayerStatus.BANNED)
  })

  test('بازیکنِ ناشناخته با پیامِ راهنما رد می‌شود', async () => {
    const { service } = makeService()
    await expect(service.getModerationView(ADMIN_ID, TARGET_ID)).rejects.toThrow(NotFoundError)
  })
})

describe('حذف حساب کاربری', () => {
  function armedPreview() {
    const ctx = makeService()
    ctx.db.player.findUnique.mockResolvedValue({ id: 'p1', firstName: 'بازیکن', balance: 250_000n })
    ctx.tx.player.findUnique.mockResolvedValue({ id: 'p1', firstName: 'بازیکن', balance: 250_000n })
    ctx.db.bankAccount.aggregate.mockResolvedValue({ _sum: { balance: 40_000n } })
    ctx.tx.bankAccount.aggregate.mockResolvedValue({ _sum: { balance: 40_000n } })
    return ctx
  }

  test('پیش‌نمایش هیچ نوشتی انجام نمی‌دهد', async () => {
    const { service, db, tx } = armedPreview()
    const preview = await service.getDeletionPreview(ADMIN_ID, TARGET_ID)

    expect(preview.removedFunds).toBe(290_000)
    expect(preview.blockers).toEqual([])
    expect(tx.player.delete).not.toHaveBeenCalled()
    expect(db.player.delete).not.toHaveBeenCalled()
  })

  test('ادمینِ ربات، کسب‌وکارِ کارمنددار، وام فعال و حراجیِ باز مانع حذف‌اند', async () => {
    const { service, db } = armedPreview()
    db.botAdmin.findUnique.mockResolvedValue({ telegramUserId: TARGET_ID, role: BotAdminRole.ADMIN, isActive: true })
    db.business.count.mockResolvedValue(1)
    db.loan.count.mockResolvedValue(1)
    db.auction.count.mockResolvedValue(1)

    const preview = await service.getDeletionPreview(ADMIN_ID, TARGET_ID)
    const titles = preview.blockers.map((blocker) => blocker.title)

    expect(titles).toEqual(
      expect.arrayContaining([
        'دسترسی مدیریت فعال',
        'کسب‌وکار با کارمند',
        'وام بانکی تسویه‌نشده',
        'برندهٔ موقت حراجی'
      ])
    )
    for (const blocker of preview.blockers) {
      expect(blocker.hint.length).toBeGreaterThan(20)
    }
  })

  test('اثرهای حذف (ازدواج، نوبت کاری، چالش) صریح گفته می‌شود', async () => {
    const { service, db } = armedPreview()
    db.marriage.count.mockResolvedValue(1)
    db.workSession.count.mockResolvedValue(2)
    db.regionalChallengeContribution.aggregate.mockResolvedValue({ _sum: { points: 120 } })

    const preview = await service.getDeletionPreview(ADMIN_ID, TARGET_ID)
    const joined = preview.settlements.join(' ')

    expect(joined).toContain('همسر')
    expect(joined).toContain('نوبت کاری')
    expect(joined).toContain('چالش')
    expect(preview.removals.map((row) => row.label)).toEqual(expect.arrayContaining(['نوبت کاری', 'ازدواج و پیشنهاد']))
    expect(preview.removals.every((row) => row.count > 0)).toBe(true)
  })

  test('هنگام وجود مانع، حذف اجرا نمی‌شود و هیچ ردیفی پاک نمی‌شود', async () => {
    const { service, tx } = armedPreview()
    tx.loan.count.mockResolvedValue(1)

    await expect(service.deletePlayer(ADMIN_ID, TARGET_ID)).rejects.toThrow(ConflictError)
    expect(tx.player.delete).not.toHaveBeenCalled()
    expect(tx.bankAccount.deleteMany).not.toHaveBeenCalled()
  })

  test('مسیر موفق: وضعیت مشترک بسته می‌شود، پول سند می‌گیرد، داده‌ها پاک و ردیف بازیکن حذف می‌شود', async () => {
    const { service, tx, models } = armedPreview()
    tx.marriage.findMany.mockResolvedValue([
      {
        id: 'm1',
        playerAId: 'p1',
        playerBId: 'sp1',
        playerA: { id: 'p1', maritalStatus: 'MARRIED' },
        playerB: { id: 'sp1', maritalStatus: 'MARRIED' }
      }
    ])
    tx.marriageProposal.updateMany.mockResolvedValue({ count: 1 })
    tx.business.findMany.mockResolvedValue([{ id: 'b1' }])

    const result = await service.deletePlayer(ADMIN_ID, TARGET_ID)

    expect(result).toEqual({ firstName: 'بازیکن', removedFunds: 290_000 })

    // همسر رها نمی‌شود: وضعیت، اعلان و سرگذشت
    expect(tx.player.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'sp1', maritalStatus: 'MARRIED' },
        data: { maritalStatus: 'DIVORCED' }
      })
    )
    expect(tx.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ playerId: 'sp1' }) })
    )
    expect(tx.gameEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ playerId: 'sp1', type: 'DIVORCE_REGISTERED' }) })
    )

    // سندِ پولِ خارج‌شده از گردش
    expect(tx.financialTransaction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ amount: 290_000, type: 'WITHDRAWAL', sourcePlayerId: 'p1' })
      })
    )

    // زنجیرهٔ کسب‌وکار پیش از خودِ شرکت پاک می‌شود
    const businessDeletes = tx.businessEmployee.deleteMany.mock.invocationCallOrder
    const companyDeletes = tx.business.deleteMany.mock.invocationCallOrder
    expect(businessDeletes.every((order) => order < companyDeletes[0]!)).toBe(true)

    expect(tx.jobApplication.deleteMany).toHaveBeenCalled()
    expect(tx.playerWarning.deleteMany).toHaveBeenCalledWith({ where: { playerId: 'p1' } })
    expect(tx.relationship.deleteMany).toHaveBeenCalled()
    expect(tx.userState.deleteMany).toHaveBeenCalledWith({ where: { telegramUserId: TARGET_ID } })
    expect(tx.player.delete).toHaveBeenCalledWith({ where: { id: 'p1' } })
    expect(tx.adminLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'player_delete' }) })
    )

    // دفتر کل و تاریخچه هرگز پاک نمی‌شوند؛ فقط اشاره‌شان تهی می‌شود
    expect(models.get('financialTransaction')?.deleteMany).not.toHaveBeenCalled()
    expect(models.get('gameEvent')?.deleteMany).not.toHaveBeenCalled()

    // هر مدلی که واقعاً لمس شد، در فهرستِ تایپ‌شدهٔ ماک‌ها هست؛ اگر مدلی به
    // اسکیما اضافه شود و اینجا نباشد، تست با خطای تایپ نمی‌گذرد و همین‌جا می‌ایستد
    const declared = MODEL_NAMES as readonly string[]
    expect([...models.keys()].filter((name) => !declared.includes(name))).toEqual([])
  })

  test('حذفِ ادمینِ ربات پیش از هر نوشتاری رد می‌شود', async () => {
    const { service, db, tx } = armedPreview()
    db.botAdmin.findUnique.mockImplementation(({ where }: { where: { telegramUserId: bigint } }) =>
      where.telegramUserId === TARGET_ID
        ? Promise.resolve({ telegramUserId: TARGET_ID, role: BotAdminRole.OWNER, isActive: true })
        : Promise.resolve({ telegramUserId: ADMIN_ID, role: BotAdminRole.ADMIN, isActive: true })
    )
    await expect(service.deletePlayer(ADMIN_ID, TARGET_ID)).rejects.toThrow(ConflictError)
    expect(tx.player.delete).not.toHaveBeenCalled()
  })

  test('پیش‌نمایشِ کهنه جای تصمیمِ لحظهٔ حذف را نمی‌گیرد', async () => {
    const { service, tx } = armedPreview()
    // تراکنش، مانعی را می‌بیند که در پیش‌نمایشِ بیرون از تراکنش نبود
    tx.playerLoan.count.mockResolvedValue(1)
    await expect(service.deletePlayer(ADMIN_ID, TARGET_ID)).rejects.toThrow(ConflictError)
    expect(tx.player.delete).not.toHaveBeenCalled()
  })
})

describe('کیبوردِ مدیریتِ اخطارها', () => {
  const warnings = [
    { id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d', reason: 'رفتار نامناسب', issuedBy: OWNER_ID, isActive: true, causedBan: false, createdAt: new Date('2026-09-01T00:00:00Z'), revokedAt: null },
    { id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', reason: 'فریب در بازار', issuedBy: ADMIN_ID, isActive: false, causedBan: true, createdAt: new Date('2026-08-01T00:00:00Z'), revokedAt: new Date('2026-08-02T00:00:00Z') }
  ]

  type CallbackButton = { text: string; callback_data: string }
  const flat = (keyboard: InlineKeyboard): CallbackButton[] =>
    keyboard.inline_keyboard.flat().filter((button): button is CallbackButton => {
      const data = (button as { callback_data?: string }).callback_data
      return typeof data === 'string'
    })

  test('هیچ callback_data از سقف ۶۴ بایتی تلگرام بزرگ‌تر نیست', () => {
    const buttons = flat(buildAdminModerationKeyboard(TARGET_ID, warnings))
    expect(buttons.length).toBeGreaterThan(0)
    for (const button of buttons) {
      expect(Buffer.byteLength(button.callback_data)).toBeLessThanOrEqual(64)
    }
  })

  test('شناسهٔ اخطار با پیشوند کوتاهِ «adm:wrev» می‌رود، نه شکل بلندِ تأیید', () => {
    const data = flat(buildAdminModerationKeyboard(TARGET_ID, warnings)).map(
      (button) => button.callback_data
    )
    expect(data.some((item) => item.includes('adm:wrev:'))).toBe(true)
    expect(data.every((item) => !item.startsWith('adm:confirm:warning_revoke'))).toBe(true)
    expect(new Set(data).size).toBe(data.length)
  })

  test('برای گروه/بازیکن با شناسهٔ بلند هم در سقف می‌ماند', () => {
    const keyboard = buildAdminModerationKeyboard(-1001234567890n, warnings)
    for (const button of flat(keyboard)) {
      expect(Buffer.byteLength(button.callback_data)).toBeLessThanOrEqual(64)
    }
  })
})

describe('قفل‌شدن مسیرهای مدیریت برای غیرادمین', () => {
  test('هیچ‌کدام از اقدام‌های تازه بدون ردیف ادمین اجرا نمی‌شود', async () => {
    const { service, tx, authorized } = makeStrangerService()
    authorized.mockResolvedValue([])

    await expect(service.issueWarning(STRANGER_ID, TARGET_ID, 'دلیل معتبر اینجا')).rejects.toThrow(UnauthorizedError)
    await expect(service.revokeWarning(STRANGER_ID, TARGET_ID, 'w1')).rejects.toThrow(UnauthorizedError)
    await expect(service.sendPlayerMessage(STRANGER_ID, TARGET_ID, 'یک پیام بلندتر از سه نویسه')).rejects.toThrow(UnauthorizedError)
    await expect(service.getModerationView(STRANGER_ID, TARGET_ID)).rejects.toThrow(UnauthorizedError)
    await expect(service.deletePlayer(STRANGER_ID, TARGET_ID)).rejects.toThrow(UnauthorizedError)
    expect(tx.player.delete).not.toHaveBeenCalled()
    expect(tx.playerWarning.create).not.toHaveBeenCalled()
  })

  test('ادمین اصلی هم از این مسیرها می‌گذرد و OWNER تنها مدیرِ ادمین‌هاست', async () => {
    const { service, tx } = makeService(BotAdminRole.OWNER, OWNER_ID)
    tx.player.findUnique.mockResolvedValue({ ...PLAYER_ROW })
    tx.playerWarning.count.mockResolvedValue(1)
    const result = await service.issueWarning(OWNER_ID, TARGET_ID, 'تخلف ثبت‌شده در گروه')
    expect(result.activeCount).toBe(1)
  })
})
