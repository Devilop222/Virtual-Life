import { GameEventType, PlayerStatus, PrismaClient, TransactionType } from '@prisma/client'
import { ConflictError, NotFoundError, ValidationError } from '../../utils/classes/errors'
import { EventService } from '../events/event.service'
import { resolveCityAuthority } from './authority'
import { logger } from '../../utils/logger'
import { dayIndex } from '../../utils/game-time'

/** مدت اعتبار Cache پروژه‌های هر گروه. */
const CACHE_TTL_MS = 60 * 1000

/**
 * سقف یک کمکِ شهری. یک منبع برای هر سه مصرف‌کننده: اعتبارسنجی سرویس،
 * متن خطا و سقفِ پیشنهادی در ورودیِ «مبلغ دلخواه» — وگرنه UI سقفی را وعده
 * می‌داد که سرویس ردش می‌کرد.
 */
export const MAX_PROJECT_DONATION = 500_000_000

export interface RegionProjectView {
  key: string
  title: string
  description: string
  targetAmount: number
  collectedAmount: number
  isCompleted: boolean
  progressPercent: number
  /** مبلغی که برای تکمیل پروژه باقی مانده (هرگز منفی نمی‌شود). */
  remainingAmount: number
  /** چند بازیکنِ یگانه در این پروژه کمک کرده‌اند. */
  participantCount: number
  /** لحظهٔ آغاز رسمی توسط شهردار (اگر آغاز شده باشد). */
  startedAt: Date | null
  completedAt: Date | null
  /**
   * آیا شهردار این پروژه را رسماً آغاز کرده است؟
   * کمک‌ها می‌توانند ردیف پروژه را خودکار بسازند، ولی «آغاز رسمی» یعنی
   * منطقه هدفش را اعلام کرده و شهردار پشت آن ایستاده. این پرچم همان تفاوت
   * را برای بازیکن قابل دیدن می‌کند.
   */
  isLaunched: boolean
}

/**
 * اثر تجمعی پروژه‌های تکمیل‌شدهٔ یک منطقه.
 * ضریب‌ها همیشه مقدار بی‌اثر (۱ یا ۰) دارند تا نقاط مصرف بدون شرط اضافه کار کنند.
 */
export interface RegionBuffs {
  restFatigueMultiplier: number
  restHealthMultiplier: number
  shopDiscount: number
  migrationDiscount: number
}

const NEUTRAL_BUFFS: RegionBuffs = {
  restFatigueMultiplier: 1,
  restHealthMultiplier: 1,
  shopDiscount: 0,
  migrationDiscount: 0
}

/** تعریف ثابت پروژه‌های شهری. */
export const PROJECT_BLUEPRINTS = {
  park: {
    title: 'پارک مرکزی',
    description: 'فضای سبز برای استراحت بهتر ساکنان — ریکاوری خستگی ۲۵٪ مؤثرتر',
    targetAmount: 50_000_000
  },
  clinic: {
    title: 'درمانگاه شهر',
    description: 'دسترسی بهتر به درمان — بازیابی سلامت در استراحت ۲۵٪ بیشتر',
    targetAmount: 80_000_000
  },
  bazaar: {
    title: 'بازارچهٔ محلی',
    description: 'تقویت تجارت محلی — تخفیف ۱۰٪ خرید از فروشگاه برای همه',
    targetAmount: 120_000_000
  },
  terminal: {
    title: 'پایانهٔ مسافربری',
    description: 'اتصال بهتر جاده‌ها — تخفیف ۳۰٪ هزینهٔ مهاجرت برای ساکنان',
    targetAmount: 200_000_000
  }
} as const

type ProjectKey = keyof typeof PROJECT_BLUEPRINTS

export interface ProjectDonationRow {
  id: string
  amount: number
  createdAt: Date
  donorName: string
}

export interface MyDonationRow {
  id: string
  amount: number
  createdAt: Date
  projectTitle: string
  projectCompleted: boolean
}

interface CacheEntry {
  keys: Set<string>
  expiresAt: number
}

/**
 * پروژه‌های عمومی منطقه.
 *
 * منطق اقتصادی:
 *  • پول کمک‌ها واقعاً از موجودی اهداکننده کسر می‌شود (Sink واقعی)
 *  • تکمیل با شرط اتمیک `collected < target` انجام می‌شود تا دو کمک همزمان
 *    باعث عبور از هدف یا تکمیل دوباره نشود
 *  • پس از تکمیل، اثر بافر در نقطهٔ دقیق Gameplay اعمال می‌شود
 */
export class ProjectsService {
  private readonly cache = new Map<string, CacheEntry>()

  constructor(
    private readonly db: PrismaClient,
    private readonly eventService: EventService
  ) {}

  /** فهرست پروژه‌های یک گروه با پیشرفت. */
  async listProjects(groupId: string): Promise<RegionProjectView[]> {
    const rows = await this.db.regionProject.findMany({ where: { groupId } })
    const byKey = new Map(rows.map((r) => [r.key, r]))

    // تعداد مشارکت‌کنندگانِ یگانه برای همهٔ پروژه‌های منطقه با یک Query خوانده
    // می‌شود (groupBy) تا پنل شهر به ازای هر پروژه یک Query نزند.
    const participants = await this.participantCounts(rows.map((row) => row.id))

    const views: RegionProjectView[] = []
    for (const [key, bp] of Object.entries(PROJECT_BLUEPRINTS)) {
      const row = byKey.get(key)
      const collected = row ? Number(row.collectedAmount) : 0
      const completed = row?.isCompleted ?? false
      views.push({
        key,
        title: bp.title,
        description: bp.description,
        targetAmount: bp.targetAmount,
        collectedAmount: collected,
        isCompleted: completed,
        progressPercent: Math.min(100, Math.round((collected / bp.targetAmount) * 100)),
        remainingAmount: Math.max(0, bp.targetAmount - collected),
        participantCount: row ? (participants.get(row.id) ?? 0) : 0,
        startedAt: row?.startedAt ?? null,
        completedAt: row?.completedAt ?? null,
        isLaunched: (row?.startedByPlayerId ?? null) !== null
      })
    }
    return views
  }

  /** تعداد اهداکنندگانِ یگانهٔ هر پروژه — یک Query برای مجموع پروژه‌ها. */
  private async participantCounts(projectIds: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>()
    if (projectIds.length === 0) {
      return out
    }
    const grouped = await this.db.projectDonation.groupBy({
      by: ['projectId', 'donorId'],
      where: { projectId: { in: projectIds } }
    })
    for (const row of grouped) {
      out.set(row.projectId, (out.get(row.projectId) ?? 0) + 1)
    }
    return out
  }

  /**
   * کمک‌های پروژه‌های یک منطقه، صفحه‌بندی‌شده و با نامِ اهداکننده.
   *
   * عمداً فقط مبلغ و زمان و نامِ نمایشی برمی‌گردد — موجودی یا داراییِ هیچ
   * بازیکنی در این فهرست نیست. کمک به پروژهٔ عمومی است، ولی پولِ بازیکن نه.
   */
  async listProjectDonations(
    groupId: string,
    projectKey: string,
    page = 0,
    pageSize = 8
  ): Promise<{ title: string; total: number; items: ProjectDonationRow[] }> {
    const bp = PROJECT_BLUEPRINTS[projectKey as ProjectKey]
    if (!bp) {
      throw new ValidationError('Unknown project', 'این پروژه در فهرست شهر وجود ندارد.')
    }
    const project = await this.db.regionProject.findUnique({
      where: { groupId_key: { groupId, key: projectKey } },
      select: { id: true, title: true }
    })
    if (!project) {
      return { title: bp.title, total: 0, items: [] }
    }

    const safeSize = Math.max(1, Math.min(20, Math.floor(pageSize)))
    const safePage = Math.max(0, Math.floor(page))
    const [rows, total] = await Promise.all([
      this.db.projectDonation.findMany({
        where: { projectId: project.id },
        orderBy: { createdAt: 'desc' },
        skip: safePage * safeSize,
        take: safeSize,
        include: { donor: { select: { firstName: true, lastName: true } } }
      }),
      this.db.projectDonation.count({ where: { projectId: project.id } })
    ])

    return {
      title: project.title,
      total,
      items: rows.map((row) => ({
        id: row.id,
        amount: Number(row.amount),
        createdAt: row.createdAt,
        // نامِ عکسِ‌لحظه‌ای مرجع است؛ نامِ فعلیِ حساب فقط اگر حساب هنوز باشد
        // جایگزینش می‌شود (بازیکن ممکن است نامش را عوض کرده باشد).
        donorName:
          [row.donor?.firstName, row.donor?.lastName].filter(Boolean).join(' ').trim() ||
          row.donorName ||
          'بازیکن'
      }))
    }
  }

  /** رویهٔ مشارکت‌های خودِ بازیکن — قابل‌ردیابی، با نامِ پروژه. */
  async listMyDonations(
    playerId: string,
    page = 0,
    pageSize = 8
  ): Promise<{ total: number; totalAmount: number; items: MyDonationRow[] }> {
    const safeSize = Math.max(1, Math.min(20, Math.floor(pageSize)))
    const safePage = Math.max(0, Math.floor(page))
    const [rows, total, aggregate] = await Promise.all([
      this.db.projectDonation.findMany({
        where: { donorId: playerId },
        orderBy: { createdAt: 'desc' },
        skip: safePage * safeSize,
        take: safeSize,
        include: { project: { select: { title: true, isCompleted: true } } }
      }),
      this.db.projectDonation.count({ where: { donorId: playerId } }),
      this.db.projectDonation.aggregate({
        where: { donorId: playerId },
        _sum: { amount: true }
      })
    ])

    return {
      total,
      totalAmount: Number(aggregate._sum.amount ?? 0),
      items: rows.map((row) => ({
        id: row.id,
        amount: Number(row.amount),
        createdAt: row.createdAt,
        projectTitle: row.project?.title ?? 'پروژهٔ حذف‌شده',
        projectCompleted: row.project?.isCompleted ?? false
      }))
    }
  }

  /**
   * آغازِ رسمیِ یک پروژه توسط شهردارِ فعال منطقه.
   *
   * طراحی:
   *  • اختیار از `resolveCityAuthority` خوانده می‌شود (همان قاعده‌ای که پنل
   *    سیاست و پنل شهر استفاده می‌کنند) — نگهبان در سرویس است، نه در UI.
   *  • اگر پروژه با کمکِ بازیکنان ساخته شده ولی هنوز رسماً آغاز نشده باشد،
   *    همین عملیات آن را «آغازشده» می‌کند (شرط اتمیک روی ستون خالی) تا
   *    دوبار کلیک یا دو شهردار همزمان وضعیت متناقض نسازند.
   *  • اعلام عمومی در منطقه ثبت می‌شود؛ بدون پول و بدون ردیف دفتر کل، چون
   *    این تصمیمِ مدیریتی است و چیزی جابه‌جا نمی‌کند.
   */
  async launchProject(
    telegramUserId: bigint,
    groupId: string,
    projectKey: string
  ): Promise<{ title: string; targetAmount: number; collectedAmount: number }> {
    const bp = PROJECT_BLUEPRINTS[projectKey as ProjectKey]
    if (!bp) {
      throw new ValidationError('Unknown project', 'این پروژه در فهرست شهر وجود ندارد.')
    }

    const player = await this.db.player.findUnique({
      where: { telegramUserId },
      select: { id: true }
    })
    if (!player) {
      throw new NotFoundError('Player not found')
    }

    const authority = await resolveCityAuthority(this.db, groupId)
    if (!authority || authority.playerId !== player.id) {
      throw new ConflictError(
        'Not the mayor',
        'فقط شهردارِ فعالِ منطقه می‌تواند یک پروژه را رسماً آغاز کند.'
      )
    }

    const existing = await this.db.regionProject.findUnique({
      where: { groupId_key: { groupId, key: projectKey } }
    })
    if (existing?.isCompleted) {
      throw new ConflictError('Already completed', 'این پروژه تکمیل شده و دوباره آغاز نمی‌شود.')
    }
    if (existing && existing.startedByPlayerId !== null) {
      throw new ConflictError('Already launched', 'این پروژه پیش‌تر رسماً آغاز شده است.')
    }

    const collectedAmount = existing ? Number(existing.collectedAmount) : 0

    if (existing) {
      const launched = await this.db.regionProject.updateMany({
        where: { id: existing.id, startedByPlayerId: null },
        data: { startedByPlayerId: player.id, startedAt: new Date() }
      })
      if (launched.count !== 1) {
        throw new ConflictError(
          'Already launched',
          'همین حالا این پروژه رسماً آغاز شد؛ پنل را تازه کن.'
        )
      }
    } else {
      try {
        await this.db.regionProject.create({
          data: {
            groupId,
            key: projectKey,
            title: bp.title,
            description: bp.description,
            targetAmount: bp.targetAmount,
            startedByPlayerId: player.id,
            startedAt: new Date()
          }
        })
      } catch {
        // ساخت همزمان (کمکِ بازیکن یا کلیکِ دوباره): یعنی دیگر «آغازنشده» نیست
        throw new ConflictError('Already launched', 'این پروژه در همین لحظه آغاز شد.')
      }
    }

    this.invalidate(groupId)

    await this.eventService
      .recordRegionEvent({
        groupId,
        type: GameEventType.PROJECT_STARTED,
        priority: 4,
        title: `🏗️ پروژهٔ «${bp.title}» رسماً آغاز شد`,
        detail: `هدف: ${bp.targetAmount.toLocaleString('fa-IR')} تومان کمک مردمی — ${bp.description}`,
        dedupeKey: `project-launch:${groupId}:${projectKey}`
      })
      .catch(() => undefined)

    return { title: bp.title, targetAmount: bp.targetAmount, collectedAmount }
  }

  /**
   * تضمین وجود ردیف پروژه در یک منطقه.
   *
   * پروژه‌ها همیشه در پنل شهر دیده می‌شوند، پس اولین کمک باید خودش ردیف را
   * بسازد؛ در غیر این صورت بازیکن پیام «پروژه آغاز نشده» می‌گیرد و هیچ راهی
   * برای آغاز کردن ندارد. ساخت همزمان با Unique Constraint بی‌خطر است.
   */
  private async ensureProject(groupId: string, projectKey: ProjectKey) {
    const existing = await this.db.regionProject.findUnique({
      where: { groupId_key: { groupId, key: projectKey } }
    })
    if (existing) {
      return existing
    }

    const bp = PROJECT_BLUEPRINTS[projectKey]
    try {
      const created = await this.db.regionProject.create({
        data: {
          groupId,
          key: projectKey,
          title: bp.title,
          description: bp.description,
          targetAmount: bp.targetAmount,
          startedByPlayerId: null
        }
      })
      this.invalidate(groupId)
      return created
    } catch {
      // ساخت همزمان توسط بازیکن دیگر؛ همان ردیف خوانده می‌شود
      return this.db.regionProject.findUniqueOrThrow({
        where: { groupId_key: { groupId, key: projectKey } }
      })
    }
  }

  /**
   * کمک مالی به پروژه.
   * کسر موجودی و افزایش صندوق هر دو شرطی‌اند؛ اگر کمکِ شما پروژه را کامل کند،
   * رخداد خبری با اولویت بالا ثبت می‌شود تا کل منطقه مطلع شود.
   */
  async donate(
    telegramUserId: bigint,
    groupId: string,
    projectKey: string,
    amount: number
  ): Promise<{ donated: number; completedNow: boolean; projectTitle: string }> {
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw new ValidationError('Invalid donation', 'مبلغ کمک باید عددی صحیح و مثبت باشد.')
    }
    if (amount > MAX_PROJECT_DONATION) {
      throw new ValidationError(
        'Donation too large',
        `سقف هر کمک ${MAX_PROJECT_DONATION.toLocaleString('fa-IR')} تومان است.`
      )
    }

    const blueprint = PROJECT_BLUEPRINTS[projectKey as ProjectKey]
    if (!blueprint) {
      throw new ValidationError('Unknown project', 'پروژهٔ موردنظر یافت نشد.')
    }

    const player = await this.db.player.findUnique({
      where: { telegramUserId },
      select: { id: true, status: true, firstName: true, lastName: true }
    })
    if (!player) {
      throw new NotFoundError('Player not found')
    }
    // نامِ عکسِ‌لحظه‌ای: سابقهٔ کمک باید پس از حذفِ حساب هم خواندنی بماند.
    const donorName =
      [player.firstName, player.lastName].filter(Boolean).join(' ').trim() || 'بازیکن'
    // قفلِ شخصیتِ فوت‌شده: مرگ باید در سرویس اعمال شود، نه فقط در UI.
    if (player.status === PlayerStatus.DEAD) {
      throw new ConflictError('Player is dead', 'شخصیت فوت‌شده امکان کمک مالی ندارد.')
    }
    if (player.status === PlayerStatus.BANNED) {
      throw new ConflictError('Player is banned', 'حساب مسدود امکان کمک مالی ندارد.')
    }

    const project = await this.ensureProject(groupId, projectKey as ProjectKey)
    if (project.isCompleted) {
      throw new ConflictError('Already completed', 'این پروژه قبلاً تکمیل شده است.')
    }

    const remaining =
      Number(project.targetAmount) - Number(project.collectedAmount)
    // سیاستِ «بیش از باقی‌مانده»: فقط به‌اندازهٔ باقی‌مانده کسر می‌شود و باقیِ
    // پول دست نمی‌خورد. عدد اعلامی به بازیکن هم همان مبلغِ واقعیِ کسرشده است
    // (`donated`)، پس پنل هیچ‌وقت بیش از واقع وعده نمی‌دهد.
    const applied = Math.min(amount, remaining)
    const willComplete = Number(project.collectedAmount) + applied >= Number(project.targetAmount)

    // کسر، افزایش صندوق و ردیف دفتر کل در یک تراکنش: اگر وضعیت پروژه بین
    // خواندن و نوشتن عوض شود (کمکِ همزمان)، throw خودِ rollback مبلغ را
    // برمی‌گرداند. پیش‌تر کسر بیرون از تراکنش بود و جبرانِ دستی‌اش (که در
    // خطای میانه می‌توانست شکست بخورد) پول اهداکننده را از بین می‌برد.
    await this.db.$transaction(async (tx) => {
      const debited = await tx.player.updateMany({
        where: { id: player.id, balance: { gte: applied } },
        data: { balance: { decrement: applied } }
      })
      if (debited.count !== 1) {
        throw new ValidationError(
          'Insufficient balance',
          'موجودیت برای این کمک کافی نیست.'
        )
      }

      const updated = await tx.regionProject.updateMany({
        where: {
          id: project.id,
          isCompleted: false,
          collectedAmount: project.collectedAmount
        },
        data: {
          collectedAmount: { increment: applied },
          ...(willComplete ? { isCompleted: true, completedAt: new Date() } : {})
        }
      })

      if (updated.count !== 1) {
        throw new ConflictError(
          'Concurrent donation',
          'وضعیت پروژه تغییر کرده است؛ دوباره تلاش کن.'
        )
      }

      // نوعِ اختصاصی `PROJECT_DONATION` و نه `TRANSFER`.
      //
      // `TRANSFER` در ممیزیِ عرضهٔ پول یعنی «پول از یک بازیکن به بازیکنِ دیگر»،
      // پس کمک به پروژه جریانِ خصوصی-به-خصوصی شمرده می‌شد؛ در حالی که پول واقعاً
      // از بخش خصوصی بیرون می‌رفت و خرجِ پروژهٔ شهر می‌شد. نتیجه: ترازِ بخش
      // عمومی در ممیزی اقتصاد دروغ می‌شد و مبلغِ کمک‌ها در ستونِ اشتباه می‌نشتست.
      await tx.financialTransaction.create({
        data: {
          amount: applied,
          type: TransactionType.PROJECT_DONATION,
          sourcePlayerId: player.id,
          reference: `کمک به پروژه: ${project.title}`
        }
      })

      // رکوردِ مستقلِ مشارکت، در همان تراکنشِ پول. بدون آن، «چقدر کمک کردم»
      // و «چند نفر مشارکت کردند» قابل‌پاسخ نبود و جمعِ کمک‌ها با
      // `collectedAmount` قابل‌آشتی‌دادن نبود.
      await tx.projectDonation.create({
        data: {
          projectId: project.id,
          groupId,
          donorId: player.id,
          donorName: donorName,
          amount: applied,
          gameDay: dayIndex()
        }
      })
    })

    this.invalidate(groupId)

    // خبرِ تکمیل، پس از تراکنش و از مسیرِ قابل‌ترمیم اعلام می‌شود. اگر همین
    // لحظه ربات خاموش شود، پروژه تکمیل‌شده می‌ماند ولی `announcedAt` تهی است
    // و چرخهٔ دوره‌ای بعداً خبر را می‌فرستد.
    let completedNow = false
    if (willComplete && !project.isCompleted) {
      completedNow = true
      await this.announceCompletion(project.id)
    }

    return { donated: applied, completedNow, projectTitle: project.title }
  }

  /**
   * اعلامِ یک‌بارهٔ تکمیل پروژه.
   *
   * چرا نوشتار شرطی و پیش از ثبت خبر؟ چون ثبت رخداد در `EventService`
   * idempotent نیست (کلید ضدتکرار فقط در سطح همان رخداد اثر دارد). با
   * `updateMany` شرطی روی `announcedAt: null`، فقط یک اجرا برندهٔ «حق اعلام»
   * می‌شود — پس دو کمکِ همزمان یا دو اجرای چرخهٔ ترمیم، خبر تکراری نمی‌سازند.
   */
  private async announceCompletion(projectId: string): Promise<boolean> {
    const claimed = await this.db.regionProject.findUnique({
      where: { id: projectId },
      select: { id: true, groupId: true, title: true, description: true }
    })
    if (!claimed) {
      return false
    }

    const won = await this.db.regionProject.updateMany({
      where: { id: projectId, isCompleted: true, announcedAt: null },
      data: { announcedAt: new Date() }
    })
    if (won.count !== 1) {
      return false
    }

    try {
      await this.eventService.recordRegionEvent({
        groupId: claimed.groupId,
        type: GameEventType.PROJECT_COMPLETED,
        title: `🎉 پروژهٔ «${claimed.title}» با کمک مردم تکمیل شد!`,
        detail: claimed.description,
        dedupeKey: `project-done:${projectId}`,
        priority: 4
      })
    } catch (error) {
      // اعلام شکست خورد؛ حق اعلام آزاد می‌شود تا چرخهٔ بعدی دوباره تلاش کند.
      // بدون این بازگشت، پروژه برای همیشه تکمیل‌شدهٔ بی‌خبر می‌ماند.
      logger.warn({ err: error, projectId }, 'project completion announcement failed')
      await this.db.regionProject
        .updateMany({ where: { id: projectId, announcedAt: { not: null } }, data: { announcedAt: null } })
        .catch(() => undefined)
      return false
    }

    this.invalidate(claimed.groupId)
    return true
  }

  /**
   * ترمیمِ اعلام‌های جامانده — از چرخهٔ دوره‌ای سرور.
   *
   * بدون این چرخه، پروژه‌ای که ربات بین «تکمیل» و «ثبت خبر» پایین بیاید
   * برای همیشه بی‌اعلام می‌ماند؛ چون مسیر تکمیل دیگر هیچ‌وقت اجرا نمی‌شود.
   */
  async recoverPendingAnnouncements(limit = 5): Promise<number> {
    const pending = await this.db.regionProject.findMany({
      where: { isCompleted: true, announcedAt: null },
      orderBy: { completedAt: 'asc' },
      take: Math.max(1, limit),
      select: { id: true }
    })

    let announced = 0
    for (const row of pending) {
      if (await this.announceCompletion(row.id)) {
        announced += 1
      }
    }
    if (announced > 0) {
      logger.info({ announced }, 'project completion announcements recovered')
    }
    return announced
  }

  /**
   * اثر پروژه‌های تکمیل‌شدهٔ یک منطقه.
   *
   * با یک Query (و Cache یک‌دقیقه‌ای) تمام بافرها یک‌جا برگردانده می‌شوند تا
   * نقاط مصرف (استراحت، خرید، مهاجرت) لازم نباشد جداگانه Query بزنند.
   */
  async getRegionBuffs(groupId: string | null | undefined): Promise<RegionBuffs> {
    if (!groupId) {
      return NEUTRAL_BUFFS
    }

    const [completed, group] = await Promise.all([
      this.completedKeys(groupId),
      this.db.group.findUnique({
        where: { id: groupId },
        select: { activePolicy: true }
      })
    ])

    const buffs = {
      restFatigueMultiplier: completed.has('park') ? 1.25 : 1,
      restHealthMultiplier: completed.has('clinic') ? 1.25 : 1,
      shopDiscount: completed.has('bazaar') ? 0.1 : 0,
      migrationDiscount: completed.has('terminal') ? 0.3 : 0
    }

    // ترکیب سیاست فعال شهردار با بافر پروژه‌ها
    switch (group?.activePolicy) {
      case 'bazaar_discount':
        buffs.shopDiscount += 0.03
        break
      case 'park_boost':
        buffs.restFatigueMultiplier *= 1.05
        buffs.restHealthMultiplier *= 1.05
        break
      case 'open_city':
        buffs.migrationDiscount += 0.1
        break
      default:
        break
    }

    return buffs
  }

  /** کلیدهای پروژه‌های تکمیل‌شده با Cache. */
  private async completedKeys(groupId: string): Promise<Set<string>> {
    const cached = this.cache.get(groupId)
    if (cached && cached.expiresAt > Date.now()) {
      return cached.keys
    }

    const completed = await this.db.regionProject.findMany({
      where: { groupId, isCompleted: true },
      select: { key: true }
    })
    const keys = new Set(completed.map((r) => r.key))
    this.store(groupId, keys)
    return keys
  }

  private store(key: string, keys: Set<string>): void {
    if (this.cache.size >= 500) {
      for (const k of this.cache.keys()) {
        this.cache.delete(k)
        break
      }
    }
    this.cache.set(key, { keys, expiresAt: Date.now() + CACHE_TTL_MS })
  }

  private invalidate(groupId: string): void {
    this.cache.delete(groupId)
  }
}
