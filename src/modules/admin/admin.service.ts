import {
  BotAdmin,
  BotAdminRole,
  DegreeLevel,
  EventScope,
  GameEventType,
  MaritalStatus,
  NotificationType,
  PlayerActivityState,
  PlayerReportStatus,
  PlayerStatus,
  Prisma,
  PrismaClient,
  TransactionType,
  WorkSessionStatus
} from '@prisma/client'
import { RegionFundService } from '../economy/tax.service'
import {
  ConflictError,
  NotFoundError,
  UnauthorizedError,
  ValidationError
} from '../../utils/classes/errors'
import { MARRIAGE_INFO } from '../family/marriage.service'
import { gameHours } from '../../utils/game-time'
import { logger } from '../../utils/logger'
import { degreeLabels } from '../education/education-blueprints'
import { GYM_MAX_HEALTH } from '../health/max-health'
import { DEATH_CAUSE, DeathService } from '../inheritance/death.service'
import type { InheritanceService, StalledInheritanceView } from '../inheritance/inheritance.service'
import { plainInput } from '../../utils/validation'
import {
  ADMIN_REPORT_PAGE_SIZE,
  REPORT_ANSWER_LIMITS,
  type AdminReportPage,
  type AdminReportView
} from '../support/support.service'

/**
 * ادمین‌های ثابت اولیه.
 *
 * این فهرست فقط برای Bootstrap است: اگر ردیفی در دیتابیس نباشد ساخته می‌شود،
 * وگرنه دیتابیس منبع حقیقت است. ادمین اصلی (`OWNER`) هرگز حذف نمی‌شود.
 */
/**
 * شناسهٔ تلگرام ادمین اصلی (مالک ربات) — تنها منبع حقیقت.
 * همهٔ گاردهای «فقط مالک» و «حذف‌ناپذیری مالک» باید همین ثابت را بخوانند تا
 * عدد در شش‌جای کد تکرار نشود و تغییرِ مالکیت فقط یک‌جا اعمال شود.
 */
export const PRIMARY_OWNER_TELEGRAM_ID = 6910416744n

export const BOOTSTRAP_ADMINS: ReadonlyArray<{ telegramUserId: bigint; role: BotAdminRole }> = [
  { telegramUserId: PRIMARY_OWNER_TELEGRAM_ID, role: BotAdminRole.OWNER },
  { telegramUserId: 8369939024n, role: BotAdminRole.ADMIN }
]

/**
 * مرزهای مجاز هر فیلد قابل تنظیم.
 * یک منبع حقیقت: هم اعتبارسنجی سرویس و هم متن راهنمای پنل از همین‌جا می‌خوانند،
 * پس هیچ‌وقت «۰ تا ۱۰۰» در پیام و «۰ تا ۱۰۰۰» در کد نخواهیم داشت.
 */
export const ADMIN_FIELD_LIMITS = {
  balance: { min: 0, max: 1_000_000_000_000, unit: 'تومان' },
  // سقف سلامتِ واقعی (عضو باشگاه = ۱۲۰)؛ سقف ۱۰۰ ادمین را از تنظیمِ سلامتِ
  // قانونیِ عضو باشگاه ناتوان می‌کرد.
  health: { min: 0, max: GYM_MAX_HEALTH, unit: '٪' },
  fatigue: { min: 0, max: 100, unit: '٪' },
  experience: { min: 0, max: 10_000_000, unit: 'امتیاز' },
  skillLevel: { min: 1, max: 20, unit: 'سطح' }
} as const

export type AdminAdjustableField = keyof typeof ADMIN_FIELD_LIMITS

/** حدِ یک فیلد به شکل آمادهٔ نمایش. */
export function fieldLimitText(field: AdminAdjustableField): string {
  const limit = ADMIN_FIELD_LIMITS[field]
  return `${limit.min.toLocaleString('fa-IR')} تا ${limit.max.toLocaleString('fa-IR')}`
}

/**
 * آستانهٔ مسدودسازی خودکار: سه اخطار *فعال*.
 * تنها منبع حقیقت این عدد؛ هم سرویس، هم متن پنل و هم راهنمای اقدام از
 * همین ثابت می‌خوانند تا «۳ اخطار» در پیام و «۵ اخطار» در کد ممکن نشود.
 */
export const WARNING_BAN_THRESHOLD = 3

/** مرزهای متنِ دلیلِ اخطار؛ همان عددی که پنل به ادمین نشان می‌دهد. */
export const WARNING_REASON_LIMITS = { min: 3, max: 200 } as const

/** مرزهای پیامی که ادمین برای بازیکن می‌فرستد. */
export const ADMIN_MESSAGE_LIMITS = { min: 3, max: 500 } as const

/** بازهٔ مجاز یک متن مدیریتی، به شکل آمادهٔ نمایش. */
export function textLimitText(limits: { min: number; max: number }): string {
  return `${limits.min.toLocaleString('fa-IR')} تا ${limits.max.toLocaleString('fa-IR')} نویسه`
}

/**
 * اعتبارسنجی دلیل اخطار — همان تابعی که `issueWarning` هم صدا می‌زند.
 * لایهٔ پیام برای پاسخِ فوری و سرویس برای نوشتن، هر دو از یک قانون می‌خوانند.
 */
export function validateWarningReason(raw: string): string {
  return cleanModerationText(raw, WARNING_REASON_LIMITS, 'دلیل اخطار')
}

/** اعتبارسنجی پیام ادمین به بازیکن؛ همان قاعدهٔ بالا. */
export function validateAdminMessage(raw: string): string {
  return cleanModerationText(raw, ADMIN_MESSAGE_LIMITS, 'پیام')
}

export interface AdminMetrics {
  totalPlayers: number
  activePlayers: number
  bannedPlayers: number
  workingPlayers: number
  totalGroups: number
  totalBusinesses: number
  totalBankAccounts: number
  totalProperties: number
  totalLoans: number
  totalAdmins: number
  /** مجموع گردش مالی ثبت‌شده — با SUM در دیتابیس، نه با خواندن ردیف‌ها. */
  totalEconomyVolume: number
  adminLogCount: number
}

const DEFAULT_PAGE_SIZE = 10
const MAX_PAGE_SIZE = 10
const ADMIN_LOG_PAGE_SIZE = 8

/** برچسب فارسی نقش ادمین. */
export const botAdminRoleLabels: Record<BotAdminRole, string> = {
  [BotAdminRole.OWNER]: 'ادمین اصلی',
  [BotAdminRole.ADMIN]: 'ادمین'
}

/** برچسب فارسی وضعیت حساب بازیکن. */
export const playerStatusAdminLabels: Record<PlayerStatus, string> = {
  [PlayerStatus.ACTIVE]: 'فعال',
  [PlayerStatus.INACTIVE]: 'غیرفعال',
  [PlayerStatus.DEAD]: 'فوت‌شده',
  [PlayerStatus.BANNED]: 'مسدود'
}

export interface AdminListItem {
  admin: BotAdmin
  /** این ادمین در بازی شخصیت ثبت‌شده دارد؟ */
  hasPlayer: boolean
  playerName: string | null
}

export interface AdminLogEntry {
  id: string
  actorUserId: bigint
  action: string
  targetUserId: bigint | null
  details: Prisma.JsonValue
  createdAt: Date
}

/** یک اخطار ثبت‌شده، همان‌طور که پنل مدیریت نشان می‌دهد. */
export interface WarningEntry {
  id: string
  reason: string
  issuedBy: bigint
  isActive: boolean
  causedBan: boolean
  createdAt: Date
  revokedAt: Date | null
}

/** نمای moderation یک بازیکن: اخطارها + فاصله تا مسدودسازی خودکار. */
export interface ModerationView {
  telegramUserId: bigint
  firstName: string
  lastName: string | null
  status: PlayerStatus
  warnings: WarningEntry[]
  /** شمار اخطارهای فعال (همان عددی که با آستانه مقایسه می‌شود). */
  activeCount: number
  threshold: number
  /** چند اخطار فعال دیگر تا مسدودسازی خودکار؛ اگر مسدود است صفر. */
  remainingUntilBan: number
}

/** دلیلِ موجه برای انجام‌نشدنِ حذف حساب. */
export interface DeletionBlocker {
  title: string
  hint: string
}

/**
 * پیش‌نمایش حذف حساب: چه چیزی پاک می‌شود، چه چیزی برای دیگران تعیین تکلیف
 * می‌شود، و چه چیزی مانع حذف است. پنل تأیید دقیقاً همین را نشان می‌دهد؛
 * یعنی ادمین پیش از تأیید، اثر واقعی اقدام را می‌بیند.
 */
export interface DeletionPreview {
  telegramUserId: bigint
  firstName: string
  blockers: DeletionBlocker[]
  /** ردیف‌هایی که همراه حساب پاک می‌شوند (فقط موارد غیرصفر). */
  removals: Array<{ label: string; count: number }>
  /** اثرهایی که روی دیگران یا روی دنیا ثبت می‌شود. */
  settlements: string[]
  /** پولی که با حذف حساب از گردش خصوصی خارج می‌شود. */
  removedFunds: number
}

/**
 * نحوهٔ تعیین تکلیف هر داده‌ای که به بازیکن وصل است.
 *
 * چرا این جدول؟ رابطه‌های `players` در اسکیما زیادند (۴۵ رابطه) و «حذف کاربر»
 * بدون یک فهرست صریح، یا با شکستِ کلید خارجی ناتمام می‌ماند یا دادهٔ دیگران
 * را کورکورانه آبشار می‌کند. آزمون `tests/admin-moderation.test.ts` این جدول
 * را با خودِ `prisma/schema.prisma` می‌سنجد؛ پس رابطهٔ تازه بدون تصمیم
 * صریح نمی‌تواند اضافه شود.
 *
 *  • `delete`          — دادهٔ منحصراً متعلق به خودش؛ پیش از ردیف بازیکن پاک می‌شود.
 *  • `cascade`         — کلید خارجی در دیتابیس آبشاری است (باز هم صریح پاک می‌شود).
 *  • `set_null`        — سند مالی/تاریخی است و باید بماند؛ فقط اشاره‌اش تهی می‌شود.
 *  • `settle`          — پیش از حذف، وضعیت مشترک با دیگران بسته/تعیین تکلیف می‌شود.
 *  • `block`           — تا وقتی در وضعیت فعال است، حذف حساب انجام نمی‌شود.
 *  • `self`            — فیلدی روی خودِ ردیف بازیکن (اقدام جدا نمی‌خواهد).
 *  • `by_telegram_id`  — کلیدش شناسهٔ تلگرام است، نه شناسهٔ بازیکن.
 */
export type PlayerDataHandling =
  | 'delete'
  | 'cascade'
  | 'set_null'
  | 'settle'
  | 'block'
  | 'self'
  | 'by_telegram_id'

/** کلید: `Model.relationField` از `prisma/schema.prisma`. */
export const PLAYER_DATA_PLAN: Readonly<Record<string, PlayerDataHandling>> = {
  'Group.residents': 'self',
  'Group.visitors': 'self',
  'PlayerGroup.player': 'delete',
  'PlayerSkill.player': 'delete',
  'Relationship.player': 'delete',
  'Relationship.relatedPlayer': 'delete',
  'Notification.player': 'delete',
  'Property.owner': 'delete',
  'RentalContract.tenant': 'block',
  'BankAccount.player': 'delete',
  'Loan.player': 'block',
  'Vote.voter': 'delete',
  'WorkSession.player': 'settle',
  'Business.owner': 'block',
  'BusinessEmployee.player': 'delete',
  'JobApplication.player': 'delete',
  'FinancialTransaction.sourcePlayer': 'set_null',
  'FinancialTransaction.destinationPlayer': 'set_null',
  'Migration.player': 'cascade',
  'LotteryTicket.player': 'cascade',
  'MarketListing.seller': 'cascade',
  'Referral.referrer': 'cascade',
  'Referral.referee': 'cascade',
  'ElectionCandidate.player': 'block',
  'GameEvent.player': 'set_null',
  'PlayerInventory.player': 'delete',
  'DailyQuest.player': 'delete',
  'WeeklyChest.player': 'delete',
  'AchievementGrant.player': 'delete',
  'TermDeposit.player': 'block',
  'DailyFortune.player': 'delete',
  'InsurancePolicy.player': 'delete',
  'TravelStamp.player': 'delete',
  'Marriage.playerA': 'settle',
  'Marriage.playerB': 'settle',
  'MarriageProposal.proposer': 'settle',
  'MarriageProposal.target': 'settle',
  'PlayerWarning.player': 'cascade',
  // گزارشِ پشتیبانی دادهٔ خودِ بازیکن است و با او می‌رود
  'PlayerReport.player': 'cascade',
  'Pet.player': 'cascade',
  'AuctionBid.bidder': 'block',
  'GymMembership.player': 'delete',
  'PlayerLoan.lender': 'block',
  'PlayerLoan.borrower': 'block',
  'RegionalChallengeContribution.player': 'delete',
  // وصیتِ بازیکن مال خودش است و با او می‌رود؛ اما پروندهٔ میراثی که او وارثِ
  // آن شده (سندِ انتقال دارایی و حق مالیِ دیگری) پاک نمی‌شود — وگرنه حذفِ
  // بازیکن، سابقهٔ میراثی که واقعاً اتفاق افتاده را از بین می‌برد.
  'Will.owner': 'cascade',
  'Will.heir': 'block',
  'InheritanceCase.deceased': 'cascade',
  'InheritanceCase.heir': 'block',
  // سابقهٔ کمک به پروژهٔ شهری، مانند دفتر کل و رخدادهای زندگی، سندِ مالی است:
  // پول واقعاً خرج شده و پیشرفت پروژه با آن ساخته شده، پس حذفِ حساب نباید آن
  // را از بین ببرد (وگرنه «جمع کمک‌ها = پیشرفت پروژه» میشکند). فقط اشاره‌اش
  // تهی می‌شود و نامِ عکسِ‌لحظه‌ای در `donor_name` خواندنی می‌ماند.
  'ProjectDonation.donor': 'set_null',
  // کلیدش شناسهٔ تلگرام است و کلید خارجی ندارد؛ صریح پاک می‌شود
  'UserState.telegramUserId': 'by_telegram_id'
}

/**
 * سرویس مدیریت ربات.
 *
 * قواعد ثابت:
 *  • منبع حقیقت دسترسی، جدول `bot_admins` است (نه متغیر محیطی).
 *  • فقط `OWNER` می‌تواند ادمین اضافه/حذف کند.
 *  • هیچ ادمینی نمی‌تواند ادمین اصلی را حذف کند؛ آخرین OWNER هم حذف‌شدنی نیست.
 *  • حذف ادمین فقط همان ردیف را برمی‌دارد؛ دادهٔ بازیکن دست‌نخورده می‌ماند.
 *  • هر تغییر روی بازیکن در یک تراکنش، با نوشتار شرطی و با ثبت `AdminLog`
 *    (شامل مقدار پیشین و پسین) انجام می‌شود.
 */
export class AdminService {
  /** نوشتن در صندوق عمومی منطقه فقط از این سرویس مجاز است (تک‌نویسنده). */
  private readonly regionFund = new RegionFundService()

  /**
   * @param deathService اختیاری: اگر تنظیمِ سلامت توسط مدیر به صفر برسد،
   *        همین سرویس مرگ را ثبت و میراث را اجرا می‌کند. مدیر می‌تواند سلامت
   *        را روی صفر بگذارد (`ADMIN_FIELD_LIMITS.health.min = 0`)، پس این
   *        تنها مسیرِ واقعیِ رسیدن به «صفر = مرده» است.
   */
  constructor(
    private readonly db: PrismaClient,
    private readonly deathService?: DeathService,
    /**
     * اختیاری: پرونده‌های میراثی که چرخهٔ خودکار رهایشان کرده، فقط با تلاش
     * دستیِ مدیر جمع می‌شوند — وگرنه دارایی متوفی برای همیشه یخ می‌ماند.
     */
    private readonly inheritanceService?: InheritanceService
  ) {}

  /** ساخت ادمین‌های اولیه در صورت نبود؛ چندبار اجراشدنی. */
  async bootstrap(): Promise<void> {
    for (const seed of BOOTSTRAP_ADMINS) {
      await this.db.botAdmin.upsert({
        where: { telegramUserId: seed.telegramUserId },
        // ردیف موجود هرگز بازنویسی نمی‌شود؛ ادمین حذف‌شده خودکار برنمی‌گردد
        update: {},
        create: {
          telegramUserId: seed.telegramUserId,
          role: seed.role,
          isActive: true
        }
      })
    }
  }

  async findAdmin(telegramUserId: bigint): Promise<BotAdmin | null> {
    return this.db.botAdmin.findUnique({ where: { telegramUserId } })
  }

  async isAdmin(telegramUserId: bigint): Promise<boolean> {
    const admin = await this.findAdmin(telegramUserId)
    return admin !== null && admin.isActive
  }

  /**
   * شناسهٔ تلگرامیِ همهٔ ادمین‌های فعال، مالک اول.
   *
   * برای دامنهٔ دستورهای مدیریتی در تلگرام لازم است: `BotCommandScopeChat`
   * دستور را فقط در چتِ همان کاربرها نشان می‌دهد، و ادمین تازه بدون این
   * فهرست هیچ راهی برای پیدا کردنِ پنلِ مدیریتی‌اش ندارد.
   *
   * ترتیب عمدی است: مالک اول برمی‌گردد تا گزارش‌ها و تست‌های وابسته به
   * «اولین دامنهٔ چتی» پایدار بمانند.
   */
  async listActiveAdminTelegramIds(): Promise<bigint[]> {
    const rows = await this.db.botAdmin.findMany({
      where: { isActive: true },
      orderBy: { createdAt: 'asc' },
      take: 100,
      select: { telegramUserId: true }
    })
    const ids = rows.map((row) => row.telegramUserId)
    // مالکِ اصلی همیشه اول — ادمین‌بودن در دیتابیس ممکن است پاک شده باشد.
    return [
      ...ids.filter((id) => id === PRIMARY_OWNER_TELEGRAM_ID),
      ...ids.filter((id) => id !== PRIMARY_OWNER_TELEGRAM_ID)
    ]
  }

  async isOwner(telegramUserId: bigint): Promise<boolean> {
    const admin = await this.findAdmin(telegramUserId)
    return (
      telegramUserId === PRIMARY_OWNER_TELEGRAM_ID &&
      admin !== null &&
      admin.isActive &&
      admin.role === BotAdminRole.OWNER
    )
  }

  /** گارد دسترسی ادمین؛ در نبود دسترسی هیچ پیامی برنمی‌گرداند (Handler بی‌صدا رد می‌کند). */
  async assertAdmin(telegramUserId: bigint): Promise<BotAdmin> {
    const admin = await this.findAdmin(telegramUserId)
    if (!admin || !admin.isActive) {
      throw new UnauthorizedError('Unauthorized admin access', 'دسترسی مدیریت نداری.')
    }
    return admin
  }

  async assertOwner(telegramUserId: bigint): Promise<BotAdmin> {
    const admin = await this.assertAdmin(telegramUserId)
    if (telegramUserId !== PRIMARY_OWNER_TELEGRAM_ID || admin.role !== BotAdminRole.OWNER) {
      throw new UnauthorizedError('Owner only', 'این بخش فقط برای ادمین اصلی است.')
    }
    return admin
  }

  // ─────────────────────────────────── مدیریت ادمین‌ها

  /**
   * فهرست ادمین‌ها با صفحه‌بندی.
   *
   * صفحه‌بندی اینجا لوکس نیست: متن پنل تلگرام سقف ۴۰۹۶ نویسه دارد و هر ادمین
   * چهار خط می‌گیرد، پس فهرستِ بی‌مرز از حدود ۵۰ ادمین به بعد اصلاً ارسال
   * نمی‌شود. اندازهٔ صفحه از همان `DEFAULT_PAGE_SIZE` بقیهٔ فهرست‌ها می‌آید.
   */
  async listAdmins(actorTelegramUserId: bigint, page = 0) {
    await this.assertOwner(actorTelegramUserId)
    const safePage = Math.max(0, Math.floor(page))

    const [total, admins] = await Promise.all([
      this.db.botAdmin.count(),
      this.db.botAdmin.findMany({
        orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
        skip: safePage * DEFAULT_PAGE_SIZE,
        take: DEFAULT_PAGE_SIZE
      })
    ])

    const playerIds = await this.db.player.findMany({
      where: { telegramUserId: { in: admins.map((a) => a.telegramUserId) } },
      select: { telegramUserId: true, firstName: true, lastName: true }
    })
    const nameOf = new Map(
      playerIds.map((p) => [p.telegramUserId, `${p.firstName} ${p.lastName ?? ''}`.trim()])
    )

    return {
      total,
      page: safePage,
      pageSize: DEFAULT_PAGE_SIZE,
      items: admins.map((admin) => ({
        admin,
        hasPlayer: nameOf.has(admin.telegramUserId),
        playerName: nameOf.get(admin.telegramUserId) ?? null
      }))
    }
  }

  /**
   * افزودن ادمین.
   * نام/نام کاربری از خود پیام تلگرام گرفته می‌شود تا در فهرست قابل شناسایی باشد.
   */
  async addAdmin(
    actorTelegramUserId: bigint,
    target: { telegramUserId: bigint; firstName?: string; username?: string }
  ): Promise<BotAdmin> {
    const actor = await this.assertOwner(actorTelegramUserId)

    if (target.telegramUserId === PRIMARY_OWNER_TELEGRAM_ID || target.telegramUserId === actor.telegramUserId) {
      throw new ConflictError('Self admin', 'خودت از قبل ادمین هستی.')
    }

    const existing = await this.db.botAdmin.findUnique({
      where: { telegramUserId: target.telegramUserId }
    })
    if (existing?.isActive) {
      throw new ConflictError('Already admin', 'این کاربر از قبل ادمین است.')
    }

    const admin = await this.authorizedTransaction(actorTelegramUserId, true, async (tx) => {
      const saved = await tx.botAdmin.upsert({
        where: { telegramUserId: target.telegramUserId },
        create: {
          telegramUserId: target.telegramUserId,
          firstName: target.firstName ?? null,
          username: target.username ?? null,
          role: BotAdminRole.ADMIN,
          isActive: true,
          grantedBy: actor.telegramUserId
        },
        update: {
          role: BotAdminRole.ADMIN,
          firstName: target.firstName ?? undefined,
          username: target.username ?? undefined,
          isActive: true,
          grantedBy: actor.telegramUserId
        }
      })
      await tx.adminLog.create({
        data: {
          actorUserId: actor.telegramUserId,
          action: 'admin_add',
          targetUserId: target.telegramUserId,
          details: { role: BotAdminRole.ADMIN }
        }
      })
      return saved
    })

    return admin
  }

  /**
   * حذف ادمین — فقط از فهرست ادمین‌ها.
   * حساب بازیکن، موجودی، دارایی و تاریخچهٔ او دست‌نخورده می‌ماند.
   */
  async removeAdmin(
    actorTelegramUserId: bigint,
    targetTelegramUserId: bigint
  ): Promise<{ removedName: string | null }> {
    const actor = await this.assertOwner(actorTelegramUserId)

    const target = await this.db.botAdmin.findUnique({
      where: { telegramUserId: targetTelegramUserId }
    })
    if (!target || !target.isActive) {
      throw new NotFoundError('Admin not found', 'چنین ادمینی در فهرست نیست.')
    }
    if (targetTelegramUserId === PRIMARY_OWNER_TELEGRAM_ID || target.role === BotAdminRole.OWNER) {
      throw new ConflictError('Owner is protected', 'ادمین اصلی حذف‌شدنی نیست.')
    }
    if (target.telegramUserId === PRIMARY_OWNER_TELEGRAM_ID || target.telegramUserId === actor.telegramUserId) {
      throw new ConflictError('Self removal', 'نمی‌توانی دسترسی خودت را بگیری.')
    }

    // آخرین خط دفاعی: هیچ‌وقت بدون OWNER نمان
    const ownerCount = await this.db.botAdmin.count({
      where: { role: BotAdminRole.OWNER, isActive: true }
    })
    if (ownerCount <= 0) {
      throw new ConflictError('No owner left', 'ادمین اصلی فعالی وجود ندارد؛ اول آن را بازگردان.')
    }

    await this.authorizedTransaction(actorTelegramUserId, true, async (tx) => {
      // نوشتار شرطی: اگر همزمان حذف شده باشد، count صفر می‌شود و خطا می‌دهیم
      const removed = await tx.botAdmin.updateMany({
        where: { telegramUserId: targetTelegramUserId, isActive: true, role: BotAdminRole.ADMIN },
        data: { isActive: false }
      })
      if (removed.count !== 1) {
        throw new ConflictError('Already removed', 'این ادمین همین حالا حذف شد.')
      }
      await tx.adminLog.create({
        data: {
          actorUserId: actor.telegramUserId,
          action: 'admin_remove',
          targetUserId: targetTelegramUserId,
          details: { keptPlayerData: true }
        }
      })
    })

    return { removedName: target.firstName ?? target.username }
  }

  // ─────────────────────────────────── داشبورد

  async getDashboardMetrics(adminTelegramUserId: bigint): Promise<AdminMetrics> {
    await this.assertAdmin(adminTelegramUserId)

    const [
      totalPlayers,
      activePlayers,
      bannedPlayers,
      workingPlayers,
      totalGroups,
      totalBusinesses,
      totalBankAccounts,
      totalProperties,
      totalLoans,
      totalAdmins,
      adminLogCount,
      volume
    ] = await Promise.all([
      this.db.player.count(),
      this.db.player.count({ where: { status: PlayerStatus.ACTIVE } }),
      this.db.player.count({ where: { status: PlayerStatus.BANNED } }),
      this.db.player.count({ where: { activityState: 'WORKING' } }),
      this.db.group.count(),
      this.db.business.count(),
      this.db.bankAccount.count(),
      this.db.property.count(),
      this.db.loan.count({ where: { status: 'ACTIVE' } }),
      this.db.botAdmin.count({ where: { isActive: true } }),
      this.db.adminLog.count(),
      // SUM در دیتابیس؛ پیش‌تر ۱۰۰۰ ردیف خوانده و در Node جمع می‌شد
      this.db.financialTransaction.aggregate({
        _sum: { amount: true }
      })
    ])

    return {
      totalPlayers,
      activePlayers,
      bannedPlayers,
      workingPlayers,
      totalGroups,
      totalBusinesses,
      totalBankAccounts,
      totalProperties,
      totalLoans,
      totalAdmins,
      totalEconomyVolume: Number(volume._sum.amount ?? 0),
      adminLogCount
    }
  }

  // ─────────────────────────────────── فهرست‌ها

  /** جست‌وجوی بازیکن با شناسهٔ تلگرام یا بخشی از نام. */
  async listPlayers(adminTelegramUserId: bigint, page = 0, search?: string) {
    await this.assertAdmin(adminTelegramUserId)
    const safePage = Math.max(0, Math.floor(page))
    const skip = safePage * DEFAULT_PAGE_SIZE
    const where = searchWhere(search)

    const [total, items] = await Promise.all([
      this.db.player.count({ where }),
      this.db.player.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: DEFAULT_PAGE_SIZE,
        select: {
          id: true,
          telegramUserId: true,
          firstName: true,
          lastName: true,
          username: true,
          age: true,
          status: true,
          activityState: true,
          balance: true,
          workSessions: {
            orderBy: [{ startedAt: 'desc' }],
            take: 1,
            select: { jobTitle: true, status: true }
          }
        }
      })
    ])

    return { total, page: safePage, pageSize: DEFAULT_PAGE_SIZE, items }
  }

  async listGroups(adminTelegramUserId: bigint, page = 0, search?: string) {
    await this.assertAdmin(adminTelegramUserId)
    const safePage = Math.max(0, Math.floor(page))

    const term = normalizeAdminSearch(search ?? '')
    const where: Prisma.GroupWhereInput = !term
      ? {}
      : /^-?\d+$/.test(term)
        ? { telegramGroupId: BigInt(term) }
        : { title: { contains: term, mode: 'insensitive' } }
    const [total, items] = await Promise.all([
      this.db.group.count({ where }),
      this.db.group.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: safePage * DEFAULT_PAGE_SIZE,
        take: DEFAULT_PAGE_SIZE
      })
    ])

    return { total, page: safePage, pageSize: DEFAULT_PAGE_SIZE, items }
  }

  async listAdminLogs(adminTelegramUserId: bigint, page = 0) {
    await this.assertAdmin(adminTelegramUserId)
    const safePage = Math.max(0, Math.floor(page))

    const [total, items] = await Promise.all([
      this.db.adminLog.count(),
      this.db.adminLog.findMany({
        orderBy: { createdAt: 'desc' },
        skip: safePage * ADMIN_LOG_PAGE_SIZE,
        take: ADMIN_LOG_PAGE_SIZE
      })
    ])

    const entries: AdminLogEntry[] = items.map((row) => ({
      id: row.id,
      actorUserId: row.actorUserId,
      action: row.action,
      targetUserId: row.targetUserId,
      details: row.details,
      createdAt: row.createdAt
    }))

    return { total, page: safePage, pageSize: ADMIN_LOG_PAGE_SIZE, items: entries }
  }

  // ─────────────────────────────────── گزارش‌های بازیکنان

  /**
   * صفِ گزارش‌های بازیکنان.
   *
   * ترتیبِ نمایش «بازها اول» است و از ترتیبِ اعلانِ خودِ نوعِ شمارشی در
   * دیتابیس می‌آید (`OPEN` پیش از `ANSWERED` و `ANSWERED` پیش از `CLOSED`)؛
   * پس صفِ ادمین همیشه کارهای باقی‌مانده را اول نشان می‌دهد.
   */
  async listReports(adminTelegramUserId: bigint, page = 0): Promise<AdminReportPage> {
    await this.assertAdmin(adminTelegramUserId)
    const safePage = Math.max(0, Math.floor(page))

    const [total, openCount, rows] = await Promise.all([
      this.db.playerReport.count(),
      this.db.playerReport.count({ where: { status: PlayerReportStatus.OPEN } }),
      this.db.playerReport.findMany({
        orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
        skip: safePage * ADMIN_REPORT_PAGE_SIZE,
        take: ADMIN_REPORT_PAGE_SIZE,
        include: {
          player: { select: { firstName: true, lastName: true, telegramUserId: true } }
        }
      })
    ])

    return {
      total,
      openCount,
      page: safePage,
      pageSize: ADMIN_REPORT_PAGE_SIZE,
      items: rows.map((row) => toAdminReportView(row))
    }
  }

  /** یک گزارش با متن و پاسخش؛ برای پنل جزئیاتِ ادمین. */
  async getReport(
    adminTelegramUserId: bigint,
    reportId: string
  ): Promise<AdminReportView | null> {
    await this.assertAdmin(adminTelegramUserId)
    const row = await this.db.playerReport.findUnique({
      where: { id: reportId },
      include: { player: { select: { firstName: true, lastName: true, telegramUserId: true } } }
    })
    return row ? toAdminReportView(row) : null
  }

  /**
   * پاسخ به گزارش بازیکن.
   *
   * تختهٔ اعلان و گزارش مدیریت *در همان تراکنش* نوشته می‌شوند تا «پاسخ داده
   * شد» و «اخبار به بازیکن رسید» هرگز از هم جدا نیفتند؛ پیام خصوصی (Push)
   * بیرون تراکنش و از لایهٔ هندلر می‌رود تا شکستِ سرویسِ تلگرام، پاسخِ ثبت‌شده
   * را برنگرداند.
   */
  async replyToReport(
    adminTelegramUserId: bigint,
    reportId: string,
    rawAnswer: string
  ): Promise<{ playerId: string; playerName: string; telegramUserId: bigint; answer: string }> {
    await this.assertAdmin(adminTelegramUserId)
    const answer = cleanModerationText(rawAnswer, REPORT_ANSWER_LIMITS, 'پاسخ')

    return this.authorizedTransaction(adminTelegramUserId, false, async (tx) => {
      const report = await tx.playerReport.findUnique({
        where: { id: reportId },
        include: {
          player: { select: { firstName: true, lastName: true, telegramUserId: true } }
        }
      })
      if (!report) {
        throw new NotFoundError('Report not found', 'این گزارش پیدا نشد؛ فهرست را تازه کن.')
      }
      if (report.status === PlayerReportStatus.CLOSED) {
        throw new ConflictError(
          'Report closed',
          'این گزارش بسته شده است؛ اگر بازیکن دوباره بنویسد گزارش تازه‌ای ثبت می‌شود.'
        )
      }

      await tx.playerReport.update({
        where: { id: report.id },
        data: {
          answer,
          status: PlayerReportStatus.ANSWERED,
          answeredBy: adminTelegramUserId,
          answeredAt: new Date()
        }
      })

      await tx.notification.create({
        data: {
          playerId: report.playerId,
          title: '📨 پاسخ پشتیبانی',
          message: answer,
          type: NotificationType.INFO,
          dedupeKey: `report-answered:${report.id}:${report.updatedAt.getTime()}`
        }
      })

      await this.writeLog(tx, adminTelegramUserId, 'report_reply', report.player.telegramUserId, {
        reportId: report.id,
        category: report.category,
        length: answer.length
      })

      return {
        playerId: report.playerId,
        playerName: `${report.player.firstName} ${report.player.lastName ?? ''}`.trim(),
        telegramUserId: report.player.telegramUserId,
        answer
      }
    })
  }

  /**
   * بستن گزارش بدون پاسخ (تکراری، بی‌ربط یا حل‌شده از راه دیگر).
   * بازیکن اعلان می‌گیرد تا «بی‌پاسخ نماندن» تضمین شود.
   */
  async closeReport(
    adminTelegramUserId: bigint,
    reportId: string,
    rawReason?: string
  ): Promise<{ playerId: string; playerName: string; telegramUserId: bigint; reason: string | null }> {
    await this.assertAdmin(adminTelegramUserId)
    const reason =
      rawReason && rawReason.trim().length > 0
        ? cleanModerationText(rawReason, REPORT_ANSWER_LIMITS, 'دلیل بستن')
        : null

    return this.authorizedTransaction(adminTelegramUserId, false, async (tx) => {
      const report = await tx.playerReport.findUnique({
        where: { id: reportId },
        include: {
          player: { select: { firstName: true, lastName: true, telegramUserId: true } }
        }
      })
      if (!report) {
        throw new NotFoundError('Report not found', 'این گزارش پیدا نشد؛ فهرست را تازه کن.')
      }
      if (report.status === PlayerReportStatus.CLOSED) {
        throw new ConflictError('Report closed', 'این گزارش از قبل بسته شده است.')
      }

      await tx.playerReport.update({
        where: { id: report.id },
        data: {
          status: PlayerReportStatus.CLOSED,
          ...(reason ? { answer: reason } : {}),
          answeredBy: adminTelegramUserId,
          answeredAt: new Date()
        }
      })

      await tx.notification.create({
        data: {
          playerId: report.playerId,
          title: '📪 گزارش پشتیبانی بسته شد',
          message: reason ?? 'گزارشت بررسی و بسته شد.',
          type: NotificationType.INFO,
          dedupeKey: `report-closed:${report.id}`
        }
      })

      await this.writeLog(tx, adminTelegramUserId, 'report_close', report.player.telegramUserId, {
        reportId: report.id,
        category: report.category
      })

      return {
        playerId: report.playerId,
        playerName: `${report.player.firstName} ${report.player.lastName ?? ''}`.trim(),
        telegramUserId: report.player.telegramUserId,
        reason
      }
    })
  }

  // ─────────────────────────────────── پرونده‌های میراثِ گیرکرده

  /**
   * پرونده‌هایی که چرخهٔ خودکار از آن‌ها گذشته است.
   *
   * چرا ادمین لازم است؟ ترمیم خودکار سه حالت را هرگز برنمی‌دارد:
   * `NO_HEIR` (به تصمیم انسانی نیاز دارد)، `FAILED` و پرونده‌هایی که سقف
   * تلاش را پر کرده‌اند. بدون این صف، پول و ملکِ آن متوفی تا ابد بلاتکلیف
   * می‌مانْد و هیچ‌کس هم خبردار نمی‌شد.
   */
  async listStalledInheritance(
    adminTelegramUserId: bigint,
    limit = 5
  ): Promise<StalledInheritanceView[]> {
    await this.assertAdmin(adminTelegramUserId)
    if (!this.inheritanceService) return []
    return this.inheritanceService.stalledCases(limit)
  }

  /**
   * تلاش دوبارهٔ دستی برای یک پروندهٔ گیرکرده.
   *
   * قصد پیش از اجرا ثبت می‌شود: اگر اجرا خطا بدهد، ردِ اقدام مدیر در گزارش
   * می‌ماند. خودِ اجرا بی‌خطر است — هر مرحله یک نوشتار شرطی است، پس فراخوانی
   * دوباره هرگز پولی را دوبار منتقل نمی‌کند؛ فقط مرحلهٔ نیمه‌کاره را تمام می‌کند.
   */
  async retryInheritanceCase(
    adminTelegramUserId: bigint,
    caseId: string
  ): Promise<{ deceasedName: string; status: string } | null> {
    await this.assertAdmin(adminTelegramUserId)
    if (!this.inheritanceService) return null

    const row = await this.db.inheritanceCase.findUnique({
      where: { id: caseId },
      select: {
        status: true,
        lastError: true,
        attempts: true,
        deceased: { select: { telegramUserId: true, firstName: true, lastName: true } }
      }
    })
    if (!row) return null

    // پروندهٔ بی‌وارث با «تلاش دوباره» حل نمی‌شود: انتقال وارث ندارد. تصمیم در
    // خودِ چرخهٔ زندگی گرفته می‌شود — با «زندگی تازه»ٔ همان بازیکن، دارایی
    // محفوظ به صندوق منطقه می‌رود. این بررسی سمت سرور است، نه فقط پنهان‌کردن
    // دکمه؛ وگرنه دکمهٔ بی‌اثر یا صدا‌زدن مستقیم callback باید همان‌جا می‌مرد.
    if (row.status === 'NO_HEIR') {
      throw new ConflictError(
        'Case has no heir',
        'این پرونده وارثی ندارد؛ «تلاش دوباره» چیزی عوض نمی‌کند. دارایی محفوظ می‌ماند و وقتی همان بازیکن «زندگی تازه» را شروع کند، به صندوق منطقه می‌رسد.'
      )
    }

    await this.db.$transaction((tx) =>
      this.writeLog(tx, adminTelegramUserId, 'inheritance_retry', row.deceased.telegramUserId, {
        caseId,
        statusBefore: row.status,
        attemptsBefore: row.attempts,
        lastError: row.lastError
      })
    )

    const summary = await this.inheritanceService.retry(caseId)
    return {
      deceasedName: `${row.deceased.firstName} ${row.deceased.lastName ?? ''}`.trim(),
      status: summary?.status ?? row.status
    }
  }

  // ─────────────────────────────────── نمای بازیکن

  async getPlayerAdminView(adminTelegramUserId: bigint, targetTelegramUserId: bigint) {
    await this.assertAdmin(adminTelegramUserId)

    const player = await this.db.player.findUnique({
      where: { telegramUserId: targetTelegramUserId },
      select: {
        id: true,
        telegramUserId: true,
        firstName: true,
        lastName: true,
        username: true,
        gender: true,
        age: true,
        startedAt: true,
        biography: true,
        balance: true,
        health: true,
        fatigue: true,
        experience: true,
        status: true,
        activityState: true,
        maritalStatus: true,
        socialLevel: true,
        currentDegree: true,
        graduationField: true,
        isEnrolled: true,
        enrolledFieldKey: true,
        streakCount: true,
        createdAt: true,
        lastActivityAt: true,
        homeGroup: { select: { title: true, environmentLevel: true } },
        workSessions: {
          orderBy: [{ startedAt: 'desc' }],
          take: 1,
          select: { id: true, jobTitle: true, status: true, startedAt: true }
        },
        skills: {
          orderBy: [{ level: 'desc' }, { points: 'desc' }],
          take: 8,
          select: { id: true, level: true, points: true, skill: { select: { name: true } } }
        }
      }
    })
    if (!player) {
      throw new NotFoundError(
        'Player not found',
        'بازیکن موردنظر یافت نشد. شناسه را بررسی کن؛ او باید ابتدا در چت خصوصی ثبت‌نام کند.'
      )
    }
    return player
  }

  async getPlayerLifeView(actor: bigint, target: bigint) {
    await this.assertAdmin(actor)
    const player = await this.db.player.findUnique({
      where: { telegramUserId: target },
      select: { id: true, firstName: true }
    })
    if (!player)
      throw new NotFoundError('Player missing', 'این بازیکن پیدا نشد. شناسه را بررسی کن.')
    const [jobs, businesses, marriages, pendingProposals] = await Promise.all([
      this.db.businessEmployee.findMany({
        where: { playerId: player.id, isActive: true },
        include: { business: { select: { name: true } } },
        take: 10,
        orderBy: { hiredAt: 'desc' }
      }),
      this.db.business.findMany({
        where: { ownerId: player.id },
        take: 10,
        orderBy: { createdAt: 'desc' }
      }),
      this.db.marriage.findMany({
        where: { isActive: true, OR: [{ playerAId: player.id }, { playerBId: player.id }] },
        include: {
          playerA: { select: { firstName: true } },
          playerB: { select: { firstName: true } }
        },
        take: 10
      }),
      this.db.marriageProposal.count({
        where: {
          status: 'PENDING',
          // عمر پیشنهاد ازدواج روی تقویم بازی است؛ همان پنجرهٔ MARRIAGE_INFO
          // ولی با تبدیل واحدِ ساعت بازی به لحظهٔ واقعی.
          createdAt: { gte: new Date(Date.now() - gameHours(MARRIAGE_INFO.proposalTtlHours)) },
          OR: [{ proposerId: player.id }, { targetId: player.id }]
        }
      })
    ])
    return { player, jobs, businesses, marriages, pendingProposals }
  }

  async listPlayerSkills(adminTelegramUserId: bigint, targetTelegramUserId: bigint) {
    await this.assertAdmin(adminTelegramUserId)
    const player = await this.db.player.findUnique({
      where: { telegramUserId: targetTelegramUserId },
      select: {
        id: true,
        skills: {
          orderBy: [{ level: 'desc' }, { points: 'desc' }],
          select: { id: true, level: true, points: true, skill: { select: { name: true } } }
        }
      }
    })
    if (!player) {
      throw new NotFoundError(
        'Player not found',
        'بازیکن موردنظر یافت نشد. شناسه را بررسی کن؛ او باید ابتدا در چت خصوصی ثبت‌نام کند.'
      )
    }
    return player.skills
  }

  // ─────────────────────────────────── تغییرات بازیکن

  /** افزودن/کسر موجودی به‌صورت اتمیک، با ردیف دفتر مالی و گزارش ادمین. */
  async adjustBalance(
    adminTelegramUserId: bigint,
    targetTelegramUserId: bigint,
    delta: number
  ): Promise<{ before: number; after: number }> {
    await this.assertAdmin(adminTelegramUserId)
    // منفی هم مجاز است: «کسر موجودی» دقیقاً همین مسیر را با دلتای منفی می‌آید
    assertNonZeroAmount(delta, 'مبلغ تغییر موجودی')

    return this.authorizedTransaction(adminTelegramUserId, false, async (tx) => {
      const player = await this.requirePlayer(tx, targetTelegramUserId)
      const before = Number(player.balance)
      const after = before + delta
      if (after < ADMIN_FIELD_LIMITS.balance.min || after > ADMIN_FIELD_LIMITS.balance.max) {
        throw new ValidationError(
          'Balance out of range',
          'موجودی نتیجه از بازهٔ مجاز بیرون می‌زند.'
        )
      }

      // نوشتار شرطی: اگر موجودی همزمان عوض شده باشد، این نوشتار اثر نمی‌کند
      const updated = await tx.player.updateMany({
        where: { telegramUserId: targetTelegramUserId, balance: player.balance },
        data: { balance: after }
      })
      if (updated.count !== 1) {
        throw new ConflictError('Concurrent change', 'موجودی همین حالا عوض شد؛ دوباره تلاش کن.')
      }

      await tx.financialTransaction.create({
        data: {
          amount: Math.abs(delta),
          // افزایش = خلق پول از بخش عمومی (MINT)، کسر = خروج از گردش (BURN).
          // TRANSFER فقط برای جابه‌جایی دوطرفه است؛ ردیفِ تک‌طرفه با این نوع
          // «پولِ بی‌صاحب» خوانده می‌شود و آشتیِ دفتر کل را می‌شکند.
          type: delta > 0 ? TransactionType.REWARD_PAYOUT : TransactionType.WITHDRAWAL,
          destinationPlayerId: delta > 0 ? player.id : undefined,
          sourcePlayerId: delta < 0 ? player.id : undefined,
          reference: delta > 0 ? 'افزایش موجودی توسط ادمین' : 'کسر موجودی توسط ادمین'
        }
      })
      await this.writeLog(
        tx,
        adminTelegramUserId,
        delta > 0 ? 'balance_add' : 'balance_remove',
        targetTelegramUserId,
        {
          delta,
          before,
          after
        }
      )

      return { before, after }
    })
  }

  /** تنظیم مستقیم یک فیلد عددی با مرزهای `ADMIN_FIELD_LIMITS`. */
  async setField(
    adminTelegramUserId: bigint,
    targetTelegramUserId: bigint,
    field: AdminAdjustableField,
    value: number
  ): Promise<{ before: number; after: number }> {
    await this.assertAdmin(adminTelegramUserId)

    const limit = ADMIN_FIELD_LIMITS[field]
    if (!limit)
      throw new ValidationError(
        'Unsupported field',
        'این مقدار قابل تنظیم نیست. از گزینه‌های پنل انتخاب کن.'
      )
    if (!Number.isSafeInteger(value) || value < limit.min || value > limit.max) {
      throw new ValidationError(
        'Value out of range',
        `مقدار باید عددی صحیح بین ${fieldLimitText(field)} باشد.`
      )
    }

    // شناسهٔ بازیکن برای گاردِ پس از تراکنش لازم است (تنظیم سلامت روی صفر).
    let targetPlayerId: string | null = null
    const outcome = await this.authorizedTransaction(adminTelegramUserId, false, async (tx) => {
      const player = await this.requirePlayer(tx, targetTelegramUserId)
      targetPlayerId = player.id

      let before: number
      let data: Prisma.PlayerUpdateInput
      switch (field) {
        case 'balance':
          before = Number(player.balance)
          data = { balance: value }
          break
        case 'health':
          before = player.health
          data = { health: value }
          break
        case 'fatigue':
          before = player.fatigue
          data = { fatigue: value }
          break
        case 'experience':
          before = player.experience
          data = { experience: value }
          break
        default:
          throw new ValidationError('Unsupported field', 'این فیلد از این مسیر قابل تنظیم نیست.')
      }

      // پول همیشه با نوشتار شرطی جابه‌جا می‌شود: اگر موجودی بین خواندن و
      // نوشتن عوض شده باشد (کار، معامله یا ادمین دیگر) این تنظیم بی‌اثر
      // می‌ماند و تغییرِ همزمان بی‌صدا پاک نمی‌شود.
      if (field === 'balance') {
        const updated = await tx.player.updateMany({
          where: { id: player.id, balance: player.balance },
          data
        })
        if (updated.count !== 1) {
          throw new ConflictError('Concurrent change', 'موجودی همین حالا عوض شد؛ دوباره تلاش کن.')
        }
      } else {
        await tx.player.update({ where: { id: player.id }, data })
      }
      if (field === 'balance') {
        // ردیف دفتر فقط وقتی معنا دارد که پولی جابه‌جا شده باشد؛
        // تنظیمِ «روی همان مقدار قبلی» نباید ردیف صفر بسازد.
        const moved = Math.abs(value - before)
        if (moved > 0) {
          await tx.financialTransaction.create({
            data: {
              amount: moved,
              // همان تفکیکِ افزایش/کسرِ adjustBalance: MINT برای واریز، BURN برای برداشت
              type: value > before ? TransactionType.REWARD_PAYOUT : TransactionType.WITHDRAWAL,
              destinationPlayerId: value > before ? player.id : undefined,
              sourcePlayerId: value < before ? player.id : undefined,
              reference: 'تنظیم موجودی توسط ادمین'
            }
          })
        }
      }
      await this.writeLog(tx, adminTelegramUserId, `set_${field}`, targetTelegramUserId, {
        before,
        after: value
      })

      return { before, after: value }
    })

    // قانون بازی: سلامت صفر یعنی مرگ. مدیر می‌تواند سلامت را صفر کند، پس همان
    // لحظه مرگ (و میراث) ثبت می‌شود — نه اینکه بازیکن «زندهٔ صفرسلامت» بماند تا
    // کسی بعداً یادش بیفتد. عمداً بیرون تراکنش است تا تراکنشِ مدیر قفل نشود و
    // خطای میراث، تنظیمِ سلامت را باطل نکند (میراث خودش مرحله‌ای و مقاوم است).
    if (field === 'health' && value <= 0 && targetPlayerId && this.deathService) {
      await this.deathService
        .registerDeath(targetPlayerId, DEATH_CAUSE.admin)
        .catch((error) => {
          logger.error({ err: error, targetPlayerId }, 'death registration after admin health set failed')
        })
    }

    return outcome
  }

  /** تنظیم سطح یک مهارت ثبت‌شده. */
  async setSkillLevel(
    adminTelegramUserId: bigint,
    targetTelegramUserId: bigint,
    playerSkillId: string,
    level: number
  ): Promise<{ skillName: string; before: number; after: number }> {
    await this.assertAdmin(adminTelegramUserId)
    const limit = ADMIN_FIELD_LIMITS.skillLevel
    if (!Number.isSafeInteger(level) || level < limit.min || level > limit.max) {
      throw new ValidationError(
        'Skill level out of range',
        `سطح مهارت باید بین ${fieldLimitText('skillLevel')} باشد.`
      )
    }

    return this.authorizedTransaction(adminTelegramUserId, false, async (tx) => {
      const player = await this.requirePlayer(tx, targetTelegramUserId)
      const skill = await tx.playerSkill.findFirst({
        where: { id: playerSkillId, playerId: player.id },
        select: { id: true, level: true, skill: { select: { name: true } } }
      })
      if (!skill) {
        throw new NotFoundError('Skill not found', 'این مهارت برای آن بازیکن یافت نشد.')
      }

      await tx.playerSkill.update({ where: { id: skill.id }, data: { level } })
      await this.writeLog(tx, adminTelegramUserId, 'set_skill_level', targetTelegramUserId, {
        skill: skill.skill.name,
        before: skill.level,
        after: level
      })

      return { skillName: skill.skill.name, before: skill.level, after: level }
    })
  }

  /** تغییر وضعیت حساب. مسدودکردن، فعالیت را هم متوقف می‌کند. */
  async setAccountStatus(
    adminTelegramUserId: bigint,
    targetTelegramUserId: bigint,
    status: PlayerStatus
  ): Promise<{ before: PlayerStatus; after: PlayerStatus }> {
    await this.assertAdmin(adminTelegramUserId)
    if (!Object.values(PlayerStatus).includes(status)) {
      throw new ValidationError('Invalid status', 'وضعیت نامعتبر است.')
    }
    // مسدودکردنِ ادمینِ فعال وضعیت متناقض می‌سازد: بازیکنِ مسدودی که هنوز
    // پنل مدیریت را می‌چرخاند. ترتیب درست «اول دسترسی، بعد حساب» است.
    if (status === PlayerStatus.BANNED) {
      await this.assertNotBotAdmin(targetTelegramUserId)
    }

    const outcome = await this.authorizedTransaction(adminTelegramUserId, false, async (tx) => {
      const player = await this.requirePlayer(tx, targetTelegramUserId)
      const data: Prisma.PlayerUpdateInput = { status }
      if (status === PlayerStatus.BANNED || status === PlayerStatus.DEAD) {
        data.activityState = PlayerActivityState.IDLE
        data.isEnrolled = false
        data.enrolledFieldKey = null
        data.targetDegree = null
        data.studyStartedAt = null
        data.restStartedAt = null
      }
      await tx.player.update({ where: { id: player.id }, data })
      // بن/فوت یعنی پایان فعالیت: نوبت کاری فعال هم در همان تراکنش بسته و
      // ظرفیتش آزاد می‌شود — همان چیزی که پنل تأیید وعده داده است.
      if (status === PlayerStatus.BANNED || status === PlayerStatus.DEAD) {
        await this.cancelActiveShifts(tx, player.id)
      }
      await this.writeLog(tx, adminTelegramUserId, 'set_account_status', targetTelegramUserId, {
        before: player.status,
        after: status
      })
      return { before: player.status, after: status, playerId: player.id }
    })

    // مرگ فقط از یک مسیر می‌گذرد: وضعیت `DEAD` نوشته شد، ولی پروندهٔ میراث و
    // انتقال دارایی کارِ `DeathService` است. اگر این‌جا صدا زده نشود، بازیکن
    // «مردهٔ بی‌پرونده» می‌ماند و دارایی‌اش هرگز به وارث نمی‌رسد.
    // عمداً بیرون تراکنش است تا خطای میراث، تصمیمِ مدیر را باطل نکند؛ میراث
    // خودش مرحله‌ای و قابل ترمیم است و پرونده با خطایش ثبت می‌ماند.
    if (status === PlayerStatus.DEAD && this.deathService) {
      await this.deathService.registerDeath(outcome.playerId, DEATH_CAUSE.admin).catch((error) => {
        logger.error({ err: error, targetTelegramUserId }, 'death registration after admin status change failed')
      })
    }

    return { before: outcome.before, after: outcome.after }
  }

  /** تنظیم مدرک تحصیلی. */
  async setDegree(
    adminTelegramUserId: bigint,
    targetTelegramUserId: bigint,
    degree: DegreeLevel
  ): Promise<{ before: string; after: string }> {
    await this.assertAdmin(adminTelegramUserId)
    if (!(degree in degreeLabels)) {
      throw new ValidationError('Invalid degree', 'مقطع تحصیلی نامعتبر است.')
    }

    return this.authorizedTransaction(adminTelegramUserId, false, async (tx) => {
      const player = await this.requirePlayer(tx, targetTelegramUserId)
      await tx.player.update({ where: { id: player.id }, data: { currentDegree: degree } })
      await this.writeLog(tx, adminTelegramUserId, 'set_degree', targetTelegramUserId, {
        before: player.currentDegree,
        after: degree
      })
      return {
        before: degreeLabels[player.currentDegree as DegreeLevel] ?? player.currentDegree,
        after: degreeLabels[degree]
      }
    })
  }

  /** لغو ثبت‌نام تحصیلی (بدون بازگرداندن شهریه؛ یک اقدام اصلاحی است). */
  async stopEducation(adminTelegramUserId: bigint, targetTelegramUserId: bigint): Promise<void> {
    await this.assertAdmin(adminTelegramUserId)

    await this.authorizedTransaction(adminTelegramUserId, false, async (tx) => {
      const player = await this.requirePlayer(tx, targetTelegramUserId)
      if (!player.isEnrolled) {
        throw new ConflictError('Not enrolled', 'این بازیکن در حال تحصیل نیست.')
      }
      const wasStudying = player.activityState === PlayerActivityState.STUDYING
      await tx.player.update({
        where: { id: player.id },
        data: {
          isEnrolled: false,
          enrolledFieldKey: null,
          targetDegree: null,
          studyStartedAt: null,
          ...(wasStudying ? { activityState: PlayerActivityState.IDLE } : {})
        }
      })
      await this.writeLog(tx, adminTelegramUserId, 'stop_education', targetTelegramUserId, {
        field: player.enrolledFieldKey
      })
    })
  }

  /**
   * پایان‌دادن نوبت کاری فعال.
   * نوبت CANCELLED می‌شود و بازیکن آزاد؛ مزد پرداخت نمی‌شود چون این یک
   * اقدام اصلاحی ادمین است (مثلاً شیفت گیرکرده).
   */
  async stopActiveWork(
    adminTelegramUserId: bigint,
    targetTelegramUserId: bigint
  ): Promise<{ jobTitle: string }> {
    await this.assertAdmin(adminTelegramUserId)

    return this.authorizedTransaction(adminTelegramUserId, false, async (tx) => {
      const player = await this.requirePlayer(tx, targetTelegramUserId)
      const session = await tx.workSession.findFirst({
        where: { playerId: player.id, status: WorkSessionStatus.ACTIVE },
        orderBy: { startedAt: 'desc' },
        select: { id: true, jobTitle: true, jobKey: true }
      })
      if (!session) {
        throw new ConflictError('No active work', 'این بازیکن نوبت کاری فعالی ندارد.')
      }

      const closed = await tx.workSession.updateMany({
        where: { id: session.id, status: WorkSessionStatus.ACTIVE },
        data: { status: WorkSessionStatus.CANCELLED, endedAt: new Date() }
      })
      if (closed.count !== 1) {
        throw new ConflictError('Concurrent stop', 'نوبت کاری همین حالا بسته شد.')
      }

      // ظرفیت شغل آزاد می‌شود تا بازیکن دیگری بتواند وارد شود
      await tx.$executeRaw`UPDATE "job_capacities" SET "occupied" = GREATEST("occupied" - 1, 0) WHERE "job_key" = ${session.jobKey}`

      await tx.player.updateMany({
        where: { id: player.id, activityState: PlayerActivityState.WORKING },
        data: { activityState: PlayerActivityState.IDLE }
      })
      await this.writeLog(tx, adminTelegramUserId, 'stop_work', targetTelegramUserId, {
        jobKey: session.jobKey,
        jobTitle: session.jobTitle
      })

      return { jobTitle: session.jobTitle }
    })
  }

  /** بازنشانی وضعیت روزمره: فعالیت، تحصیل، استراحت، سلامت و خستگی. */
  async resetState(adminTelegramUserId: bigint, targetTelegramUserId: bigint): Promise<void> {
    await this.assertAdmin(adminTelegramUserId)

    await this.authorizedTransaction(adminTelegramUserId, false, async (tx) => {
      const player = await this.requirePlayer(tx, targetTelegramUserId)
      await tx.player.update({
        where: { id: player.id },
        data: {
          activityState: PlayerActivityState.IDLE,
          isEnrolled: false,
          enrolledFieldKey: null,
          targetDegree: null,
          studyStartedAt: null,
          restStartedAt: null,
          health: 100,
          fatigue: 0
        }
      })
      // ظرفیت شغلِ شیفتِ لغوشده آزاد می‌شود؛ وگرنه بازیکنان دیگر جا نمی‌گیرند
      await this.cancelActiveShifts(tx, player.id)
      await this.writeLog(tx, adminTelegramUserId, 'reset_state', targetTelegramUserId, {})
    })
  }

  /** صفرکردن استریک روزانه. */
  async resetStreak(adminTelegramUserId: bigint, targetTelegramUserId: bigint): Promise<void> {
    await this.assertAdmin(adminTelegramUserId)

    await this.authorizedTransaction(adminTelegramUserId, false, async (tx) => {
      const player = await this.requirePlayer(tx, targetTelegramUserId)
      const before = player.streakCount
      await tx.player.update({
        where: { id: player.id },
        data: { streakCount: 0, lastStreakAt: null }
      })
      await this.writeLog(tx, adminTelegramUserId, 'reset_streak', targetTelegramUserId, { before })
    })
  }

  // ─────────────────────────────────── moderation (اخطار و مسدودسازی)

  /**
   * نمای moderation یک بازیکن: همهٔ اخطارها (فعال و لغوشده) + شمار فعال‌ها.
   * همان اعدادی که پنل نشان می‌دهد؛ پس «یک اخطار تا مسدودسازی» همیشه واقعی است.
   */
  async getModerationView(
    adminTelegramUserId: bigint,
    targetTelegramUserId: bigint
  ): Promise<ModerationView> {
    await this.assertAdmin(adminTelegramUserId)

    const player = await this.db.player.findUnique({
      where: { telegramUserId: targetTelegramUserId },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        status: true,
        warnings: {
          orderBy: { createdAt: 'desc' },
          take: 20,
          select: {
            id: true,
            reason: true,
            issuedBy: true,
            isActive: true,
            causedBan: true,
            createdAt: true,
            revokedAt: true
          }
        }
      }
    })
    if (!player) {
      throw new NotFoundError(
        'Player not found',
        'بازیکن موردنظر یافت نشد. شناسه را بررسی کن؛ او باید ابتدا در چت خصوصی ثبت‌نام کند.'
      )
    }

    const activeCount = await this.db.playerWarning.count({
      where: { playerId: player.id, isActive: true }
    })

    return {
      telegramUserId: targetTelegramUserId,
      firstName: player.firstName,
      lastName: player.lastName,
      status: player.status,
      warnings: player.warnings,
      activeCount,
      threshold: WARNING_BAN_THRESHOLD,
      remainingUntilBan:
        player.status === PlayerStatus.BANNED
          ? 0
          : Math.max(0, WARNING_BAN_THRESHOLD - activeCount)
    }
  }

  /**
   * ثبت اخطار با دلیل؛ سومین اخطار فعال، همان‌جا و اتمیک مسدود می‌کند.
   *
   * چرا قفل ردیف؟ دو ادمین می‌توانند همزمان برای یک بازیکن اخطار بفرستند.
   * بدون `FOR UPDATE` هر دو تراکنش شمارش «۲» را می‌دیدند و هیچ‌کدام بن نمی‌کرد؛
   * یعنی بازیکن چهار اخطار داشت و آزاد بود. با قفل ردیف، شمارش پشت‌سرهم می‌شود.
   */
  async issueWarning(
    adminTelegramUserId: bigint,
    targetTelegramUserId: bigint,
    rawReason: string
  ): Promise<{ activeCount: number; banned: boolean; remainingUntilBan: number }> {
    await this.assertAdmin(adminTelegramUserId)
    await this.assertNotBotAdmin(targetTelegramUserId)
    const reason = cleanModerationText(rawReason, WARNING_REASON_LIMITS, 'دلیل اخطار')

    return this.authorizedTransaction(adminTelegramUserId, false, async (tx) => {
      const player = await this.requirePlayer(tx, targetTelegramUserId)
      await lockPlayerRow(tx, player.id)

      const warning = await tx.playerWarning.create({
        data: { playerId: player.id, issuedBy: adminTelegramUserId, reason }
      })

      const activeCount = await tx.playerWarning.count({
        where: { playerId: player.id, isActive: true }
      })

      let banned = false
      if (activeCount >= WARNING_BAN_THRESHOLD && player.status !== PlayerStatus.BANNED) {
        // نوشتار شرطی: اگر ادمین دیگری همزمان بن کرده باشد، این یکی صفر می‌زند
        const lock = await tx.player.updateMany({
          where: { id: player.id, status: { not: PlayerStatus.BANNED } },
          data: {
            status: PlayerStatus.BANNED,
            activityState: PlayerActivityState.IDLE,
            isEnrolled: false,
            enrolledFieldKey: null,
            targetDegree: null,
            studyStartedAt: null,
            restStartedAt: null
          }
        })
        banned = lock.count === 1
        if (banned) {
          // همان قاعدهٔ بنِ دستی: نوبت کاری فعال بسته و ظرفیت شغل آزاد می‌شود
          await this.cancelActiveShifts(tx, player.id)
          await tx.playerWarning.updateMany({
            where: { id: warning.id, causedBan: false },
            data: { causedBan: true }
          })
          await tx.notification.create({
            data: {
              playerId: player.id,
              title: '⛔ حساب مسدود شد',
              message: `به دلیل «${reason}» و رسیدن اخطارها به ${WARNING_BAN_THRESHOLD.toLocaleString('fa-IR')}، حساب تو مسدود شد.`,
              type: NotificationType.WARNING,
              dedupeKey: `warning-ban:${warning.id}`
            }
          })
        }
      }

      if (!banned) {
        // دلیلِ اخطار باید به خودِ بازیکن هم برسد، وگرنه «اخطار» فقط یک عدد
        // در پنل ادمین است. همان متن در اعلان‌های بازی (بخش «اعلان») می‌نشیند؛
        // بازیکنِ مسدود هم در چت خصوصی می‌تواند بخواندش.
        const remaining = Math.max(0, WARNING_BAN_THRESHOLD - activeCount)
        await tx.notification.create({
          data: {
            playerId: player.id,
            title: '⚠️ اخطار مدیریت',
            message: [
              `دلیل: «${reason}»`,
              remaining > 0
                ? `اخطارهای فعال: ${activeCount.toLocaleString('fa-IR')} از ${WARNING_BAN_THRESHOLD.toLocaleString('fa-IR')}؛ با ${remaining.toLocaleString('fa-IR')} اخطار دیگر حساب مسدود می‌شود.`
                : 'حساب مسدود است؛ این اخطار هم ثبت شد.'
            ].join('\n'),
            type: NotificationType.WARNING,
            dedupeKey: `warning:${warning.id}`
          }
        })
      }

      await this.writeLog(
        tx,
        adminTelegramUserId,
        banned ? 'warning_issue_auto_ban' : 'warning_issue',
        targetTelegramUserId,
        { reason, activeCount, threshold: WARNING_BAN_THRESHOLD, banned }
      )

      return {
        activeCount,
        banned,
        remainingUntilBan: Math.max(0, WARNING_BAN_THRESHOLD - activeCount)
      }
    })
  }

  /**
   * لغو یک اخطار (اشتباه ادمین).
   *
   * مسدودسازی را خودکار برنمی‌گرداند: بازگرداندن دسترسی یک تصمیم جداگانه است
   * و نباید از یک کلیک روی «لغو» به‌صورت خاموش اتفاق بیفتد. پنل همین را
   * صریح به ادمین می‌گوید.
   */
  async revokeWarning(
    adminTelegramUserId: bigint,
    targetTelegramUserId: bigint,
    warningId: string
  ): Promise<{ activeCount: number; stillBanned: boolean }> {
    await this.assertAdmin(adminTelegramUserId)

    return this.authorizedTransaction(adminTelegramUserId, false, async (tx) => {
      const player = await this.requirePlayer(tx, targetTelegramUserId)
      await lockPlayerRow(tx, player.id)

      const revoked = await tx.playerWarning.updateMany({
        where: { id: warningId, playerId: player.id, isActive: true },
        data: { isActive: false, revokedAt: new Date() }
      })
      if (revoked.count !== 1) {
        throw new NotFoundError(
          'Warning not found',
          'چنین اخطار فعالی برای این بازیکن پیدا نشد؛ فهرست اخطارها را به‌روزرسانی کن.'
        )
      }

      const activeCount = await tx.playerWarning.count({
        where: { playerId: player.id, isActive: true }
      })
      await this.writeLog(tx, adminTelegramUserId, 'warning_revoke', targetTelegramUserId, {
        warningId,
        activeCount
      })

      return { activeCount, stillBanned: player.status === PlayerStatus.BANNED }
    })
  }

  // ─────────────────────────────────── پیام ادمین به بازیکن

  /**
   * ثبت پیام ادمین برای یک بازیکن.
   *
   * پیام پیش از ارسال، در اعلان‌های بازی هم ثبت می‌شود؛ اگر بازیکن ربات را
   * مسدود کرده باشد و پیام خصوصی نرسد، متن در همان بازی باقی می‌ماند و
   * ادمین هم دقیقاً می‌فهمد چه اتفاقی افتاده است.
   */
  async sendPlayerMessage(
    adminTelegramUserId: bigint,
    targetTelegramUserId: bigint,
    rawText: string
  ): Promise<{ firstName: string; notificationId: string }> {
    await this.assertAdmin(adminTelegramUserId)
    const text = cleanModerationText(rawText, ADMIN_MESSAGE_LIMITS, 'پیام')

    return this.authorizedTransaction(adminTelegramUserId, false, async (tx) => {
      const player = await this.requirePlayer(tx, targetTelegramUserId)
      const named = await tx.player.findUnique({
        where: { id: player.id },
        select: { firstName: true }
      })
      const notification = await tx.notification.create({
        data: {
          playerId: player.id,
          title: '📩 پیام مدیریت',
          message: text,
          type: NotificationType.INFO
        },
        select: { id: true }
      })
      await this.writeLog(tx, adminTelegramUserId, 'message_send', targetTelegramUserId, {
        length: text.length
      })
      return { firstName: named?.firstName ?? '', notificationId: notification.id }
    })
  }

  // ─────────────────────────────────── حذف حساب کاربری

  /**
   * پیش‌نمایش حذف حساب؛ هیچ نوشتی انجام نمی‌دهد.
   * پنل تأییدِ ادمین دقیقاً خروجی همین تابع را نشان می‌دهد.
   */
  async getDeletionPreview(
    adminTelegramUserId: bigint,
    targetTelegramUserId: bigint
  ): Promise<DeletionPreview> {
    await this.assertAdmin(adminTelegramUserId)
    return this.buildDeletionPreview(this.db, targetTelegramUserId)
  }

  /**
   * حذف کامل حساب و داده‌های وابسته — در یک تراکنش.
   *
   * سه قانون:
   *  ۱. داده‌ای که حقِ دیگران است (کارمندِ کسب‌وکارش، ودیهٔ حراجی/انتخابات،
   *     بدهی و سپردهٔ فعال، قرارداد اجارهٔ فعال) هرگز کورکورانه آبشار نمی‌شود؛
   *     اگر در وضعیت فعال باشد، حذف انجام نمی‌شود و دلیلش گفته می‌شود.
   *  ۲. سند مالی و تاریخچهٔ منطقه می‌ماند: ردیف‌های دفتر کل و رخدادها با
   *     اشارهٔ تهی حفظ می‌شوند (`ON DELETE SET NULL` در خودِ دیتابیس).
   *  ۳. وضعیت مشترک پیش از حذف بسته می‌شود: ازدواج پایان می‌یابد (همسر
   *     «جداشده» می‌شود)، پیشنهاد باز لغو می‌شود و نوبت کاری فعال بسته و
   *     ظرفیت شغل آزاد می‌گردد.
   */
  async deletePlayer(
    adminTelegramUserId: bigint,
    targetTelegramUserId: bigint
  ): Promise<{ firstName: string; removedFunds: number }> {
    await this.assertAdmin(adminTelegramUserId)
    await this.assertNotBotAdmin(targetTelegramUserId)

    return this.authorizedTransaction(adminTelegramUserId, false, async (tx) => {
      const player = await tx.player.findUnique({
        where: { telegramUserId: targetTelegramUserId },
        select: { id: true, firstName: true, balance: true }
      })
      if (!player) {
        throw new NotFoundError(
          'Player not found',
          'بازیکن موردنظر یافت نشد. شناسه را بررسی کن؛ او باید ابتدا در چت خصوصی ثبت‌نام کند.'
        )
      }
      // قفل ردیف: پیش‌نمایشِ کهنه نمی‌تواند جای تصمیمِ لحظهٔ حذف را بگیرد
      await lockPlayerRow(tx, player.id)

      const preview = await this.buildDeletionPreview(tx, targetTelegramUserId)
      if (preview.blockers.length > 0) {
        throw new ConflictError('Deletion blocked', preview.blockers[0]!.hint)
      }

      // ── ۱. بستن وضعیت‌های مشترک
      await this.cancelActiveShifts(tx, player.id)
      const settlements = await this.closeSharedStates(tx, player.id)

      // ── ۲. پولی که با حذف حساب از گردش خصوصی خارج می‌شود، سند می‌گیرد
      if (preview.removedFunds > 0) {
        await tx.financialTransaction.create({
          data: {
            amount: preview.removedFunds,
            type: TransactionType.WITHDRAWAL,
            sourcePlayerId: player.id,
            reference: 'تسویهٔ نهایی پیش از حذف حساب کاربری توسط مدیریت'
          }
        })
      }

      // ── ۳. پاک‌کردن داده‌ها به ترتیب کلیدهای خارجی
      await this.erasePlayerData(tx, player.id)

      // ── ۴. وضعیت ورودیِ کلیدشده با شناسهٔ تلگرام (کلید خارجی ندارد)
      await tx.userState.deleteMany({ where: { telegramUserId: targetTelegramUserId } })

      // ── ۵. خودِ ردیف بازیکن
      await tx.player.delete({ where: { id: player.id } })

      await this.writeLog(tx, adminTelegramUserId, 'player_delete', targetTelegramUserId, {
        firstName: player.firstName,
        removedFunds: preview.removedFunds,
        removals: preview.removals,
        settlements
      })

      return { firstName: player.firstName, removedFunds: preview.removedFunds }
    })
  }

  /**
   * محاسبهٔ موانع، پاک‌شدنی‌ها و اثرهای حذف.
   * هم برای پیش‌نمایش (روی `db`) و هم داخل تراکنش حذف (روی `tx`) — یعنی
   * چیزی که ادمین می‌بیند و چیزی که اجرا می‌شود از یک منطق می‌آید.
   */
  private async buildDeletionPreview(
    q: Prisma.TransactionClient,
    targetTelegramUserId: bigint
  ): Promise<DeletionPreview> {
    const player = await q.player.findUnique({
      where: { telegramUserId: targetTelegramUserId },
      select: { id: true, firstName: true, balance: true }
    })
    if (!player) {
      throw new NotFoundError(
        'Player not found',
        'بازیکن موردنظر یافت نشد. شناسه را بررسی کن؛ او باید ابتدا در چت خصوصی ثبت‌نام کند.'
      )
    }
    const id = player.id

    const [
      adminRow,
      businesses,
      staffedBusinesses,
      unpaidStaff,
      activeLoans,
      activeDeposits,
      openPlayerLoans,
      activeRentals,
      leadingAuctions,
      openCandidacies,
      bankTotal,
      counts
    ] = await Promise.all([
      q.botAdmin.findUnique({ where: { telegramUserId: targetTelegramUserId } }),
      q.business.count({ where: { ownerId: id } }),
      q.business.count({ where: { ownerId: id, activeEmployees: { gt: 0 } } }),
      q.businessEmployee.count({
        where: { business: { ownerId: id }, OR: [{ isActive: true }, { unpaidSalary: { gt: 0 } }] }
      }),
      q.loan.count({ where: { playerId: id, status: { in: ['ACTIVE', 'DEFAULTED'] } } }),
      q.termDeposit.count({ where: { playerId: id, status: 'ACTIVE' } }),
      q.playerLoan.count({
        where: { OR: [{ lenderId: id }, { borrowerId: id }], status: { in: ['PENDING', 'ACTIVE'] } }
      }),
      q.rentalContract.count({
        where: { isActive: true, OR: [{ tenantId: id }, { property: { ownerId: id } }] }
      }),
      q.auction.count({ where: { isClosed: false, highestBidderId: id } }),
      q.electionCandidate.count({
        where: { playerId: id, election: { status: { in: ['UPCOMING', 'OPEN'] } } }
      }),
      q.bankAccount.aggregate({ where: { playerId: id }, _sum: { balance: true } }),
      Promise.all([
        q.workSession.count({ where: { playerId: id } }),
        q.property.count({ where: { ownerId: id } }),
        q.playerSkill.count({ where: { playerId: id } }),
        q.playerInventory.count({ where: { playerId: id } }),
        q.notification.count({ where: { playerId: id } }),
        q.relationship.count({ where: { OR: [{ playerId: id }, { relatedPlayerId: id }] } }),
        q.marketListing.count({ where: { sellerPlayerId: id } }),
        q.auctionBid.count({ where: { bidderId: id } }),
        q.vote.count({ where: { voterId: id } }),
        q.marriage.count({ where: { OR: [{ playerAId: id }, { playerBId: id }] } }),
        q.marriageProposal.count({ where: { OR: [{ proposerId: id }, { targetId: id }] } }),
        q.playerReport.count({ where: { playerId: id } }),
        q.regionalChallengeContribution.aggregate({
          where: { playerId: id },
          _sum: { points: true }
        })
      ])
    ])

    const blockers: DeletionBlocker[] = []
    if (adminRow?.isActive) {
      blockers.push({
        title: 'دسترسی مدیریت فعال',
        hint: 'این کاربر ادمین ربات است؛ اول با «حذف ادمین» دسترسی‌اش را بگیر، بعد حسابش را حذف کن.'
      })
    }
    if (staffedBusinesses > 0 || unpaidStaff > 0) {
      blockers.push({
        title: 'کسب‌وکار با کارمند',
        hint: 'کسب‌وکارش کارمند فعال یا حقوق معوق دارد؛ حذف حساب، شغل و طلب بازیکن دیگر را نابود می‌کند. اول کارمندان را آزاد و حقوق را تسویه کن.'
      })
    }
    if (activeLoans > 0) {
      blockers.push({
        title: 'وام بانکی تسویه‌نشده',
        hint: 'وام بانکی تسویه‌نشده دارد؛ حذف حساب بدهی را نابود می‌کند. اول وام را تسویه یا بسته کن.'
      })
    }
    if (activeDeposits > 0) {
      blockers.push({
        title: 'سپردهٔ فعال',
        hint: 'سپردهٔ مدت‌دار فعال دارد؛ اول آن را بشکن یا صبر کن تا سررسید شود.'
      })
    }
    if (openPlayerLoans > 0) {
      blockers.push({
        title: 'قرض باز با بازیکن',
        hint: 'قرض تسویه‌نشده با بازیکن دیگر دارد؛ اول قرض را تسویه یا رد کن.'
      })
    }
    if (activeRentals > 0) {
      blockers.push({
        title: 'قرارداد اجارهٔ فعال',
        hint: 'قرارداد اجارهٔ فعال دارد (به‌عنوان مستأجر یا موجر)؛ اول قرارداد را پایان بده.'
      })
    }
    if (leadingAuctions > 0) {
      blockers.push({
        title: 'برندهٔ موقت حراجی',
        hint: 'الان بالاترین پیشنهاد یک حراجی باز را دارد؛ تا پایان حراجی صبر کن، وگرنه حراجی آن منطقه قفل می‌شود.'
      })
    }
    if (openCandidacies > 0) {
      blockers.push({
        title: 'نامزدی در انتخابات باز',
        hint: 'در انتخابات جاری نامزد است و ودیه‌اش در گرو مانده؛ پس از پایان انتخابات اقدام کن.'
      })
    }

    const [
      workSessions,
      properties,
      skills,
      inventory,
      notifications,
      relationships,
      listings,
      bids,
      votes,
      marriages,
      proposals,
      reports,
      challengePoints
    ] = counts

    const removals = [
      { label: 'نوبت کاری', count: workSessions },
      { label: 'کسب‌وکار', count: businesses },
      { label: 'ملک', count: properties },
      { label: 'مهارت', count: skills },
      { label: 'کالای انبار', count: inventory },
      { label: 'اعلان', count: notifications },
      { label: 'رابطه', count: relationships },
      { label: 'آگهی بازار', count: listings },
      { label: 'پیشنهاد حراجی', count: bids },
      { label: 'رأی', count: votes },
      { label: 'ازدواج و پیشنهاد', count: marriages + proposals },
      { label: 'گزارش پشتیبانی', count: reports }
    ].filter((row) => row.count > 0)

    const settlements: string[] = []
    if (marriages > 0) {
      settlements.push('ازدواج فعالش پایان می‌یابد و همسر «جداشده» ثبت می‌شود (مهریه نزد همسر می‌ماند).')
    }
    if (proposals > 0) {
      settlements.push('پیشنهادهای ازدواج باز لغو می‌شود.')
    }
    if (workSessions > 0) {
      settlements.push('نوبت کاری فعال بسته و ظرفیت شغل آزاد می‌شود.')
    }
    const challengeSum = Number(challengePoints._sum.points ?? 0)
    if (challengeSum > 0) {
      settlements.push(
        `${challengeSum.toLocaleString('fa-IR')} امتیاز از پیشرفت چالش منطقه با حذف او کم می‌شود.`
      )
    }
    if (relationships > 0) {
      settlements.push('رابطه‌های او (از جمله همسر و دوستان) از شبکهٔ روابط پاک می‌شود.')
    }

    const removedFunds = Number(player.balance) + Number(bankTotal._sum.balance ?? 0)

    return {
      telegramUserId: targetTelegramUserId,
      firstName: player.firstName,
      blockers,
      removals,
      settlements,
      removedFunds
    }
  }

  /**
   * بستن وضعیت‌های مشترک پیش از حذف؛ فهرست کارهای انجام‌شده را برمی‌گرداند
   * تا در گزارش مدیریت بماند.
   */
  private async closeSharedStates(
    tx: Prisma.TransactionClient,
    playerId: string
  ): Promise<string[]> {
    const done: string[] = []

    const marriages = await tx.marriage.findMany({
      where: { isActive: true, OR: [{ playerAId: playerId }, { playerBId: playerId }] },
      select: {
        id: true,
        playerAId: true,
        playerBId: true,
        playerA: { select: { id: true, maritalStatus: true } },
        playerB: { select: { id: true, maritalStatus: true } }
      }
    })
    for (const marriage of marriages) {
      const spouse = marriage.playerAId === playerId ? marriage.playerB : marriage.playerA

      // همسر نباید به یک شخصیتِ حذف‌شده متأهل بماند: وضعیت تأهل و ردیفِ
      // «پایان زندگی مشترک» در سرگذشت و اعلان‌های او ثبت می‌شود. خودِ ردیف
      // ازدواج با حذف بازیکن پاک می‌شود (کلید خارجیِ لازم و RESTRICT)، پس
      // نوشتن `isActive: false` روی آن فقط کار بیهوده است.
      if (spouse.maritalStatus === MaritalStatus.MARRIED) {
        await tx.player.updateMany({
          where: { id: spouse.id, maritalStatus: MaritalStatus.MARRIED },
          data: { maritalStatus: MaritalStatus.DIVORCED }
        })
      }
      await tx.notification.create({
        data: {
          playerId: spouse.id,
          title: '💔 پایان زندگی مشترک',
          message: 'زندگی مشترک شما به پایان رسید؛ مهریه‌ای که گرفتی نزد خودت می‌ماند.',
          type: NotificationType.INFO,
          dedupeKey: `admin-erase-marriage:${marriage.id}`
        }
      })
      await tx.gameEvent.create({
        data: {
          scope: EventScope.PLAYER,
          type: GameEventType.DIVORCE_REGISTERED,
          playerId: spouse.id,
          title: '💔 پایان زندگی مشترک',
          detail: 'حساب همسر توسط مدیریت حذف شد و زندگی مشترک پایان یافت.',
          dedupeKey: `admin-erase-marriage-event:${marriage.id}`
        }
      })
      done.push(`marriage_settled:${marriage.id}`)
    }

    const proposals = await tx.marriageProposal.updateMany({
      where: {
        status: { in: ['PENDING', 'MAHR_SET'] },
        OR: [{ proposerId: playerId }, { targetId: playerId }]
      },
      data: { status: 'CANCELLED' }
    })
    if (proposals.count > 0) {
      done.push(`proposals_cancelled:${proposals.count}`)
    }

    return done
  }

  /**
   * پاک‌کردن همهٔ ردیف‌هایی که کلید خارجیِ RESTRICT به بازیکن دارند،
   * به ترتیبی که هیچ کلید خارجی نقض نشود.
   *
   * پیش‌شرط: موانع (`buildDeletionPreview`) بررسی و رفع شده باشند؛ پس اینجا
   * هیچ دادهٔ فعالِ متعلق به دیگران وجود ندارد.
   */
  private async erasePlayerData(tx: Prisma.TransactionClient, playerId: string): Promise<void> {
    const businesses = await tx.business.findMany({
      where: { ownerId: playerId },
      select: { id: true }
    })
    const businessIds = businesses.map((business) => business.id)

    // زنجیرهٔ کسب‌وکار: درخواست‌ها → آگهی‌ها → شعبه‌ها → کارمندان → خود شرکت
    if (businessIds.length > 0) {
      await tx.jobApplication.deleteMany({
        where: { jobPosting: { businessId: { in: businessIds } } }
      })
      await tx.jobPosting.deleteMany({ where: { businessId: { in: businessIds } } })
      await tx.businessBranch.deleteMany({ where: { businessId: { in: businessIds } } })
      await tx.businessEmployee.deleteMany({ where: { businessId: { in: businessIds } } })
    }
    await tx.jobApplication.deleteMany({ where: { playerId } })
    await tx.businessEmployee.deleteMany({ where: { playerId } })
    await tx.business.deleteMany({ where: { ownerId: playerId } })

    // زنجیرهٔ ملک: قراردادها (فقط غیرفعال؛ فعال مانع حذف است) → خود ملک
    await tx.rentalContract.deleteMany({
      where: { OR: [{ tenantId: playerId }, { property: { ownerId: playerId } }] }
    })
    await tx.property.deleteMany({ where: { ownerId: playerId } })

    // مالی شخصی: همه تسویه‌شده‌اند (فعال‌ها مانع حذف بودند)
    await tx.loan.deleteMany({ where: { playerId } })
    await tx.termDeposit.deleteMany({ where: { playerId } })
    await tx.bankAccount.deleteMany({ where: { playerId } })
    await tx.playerLoan.deleteMany({ where: { OR: [{ lenderId: playerId }, { borrowerId: playerId }] } })

    // بازار و شهر
    await tx.auctionBid.deleteMany({ where: { bidderId: playerId } })
    // رکوردِ حراجیِ جاری که این بازیکن رهبرش است را خنثی کن.
    //
    // چرا لازم است؟ `highestBidderId` کلید خارجی ندارد، پس حذف بازیکن خطایی
    // نمی‌دهد؛ اما `closeDue` هر حراجی را با `highestBidderId != null` برمی‌دارد
    // و برای برنده در `player_inventory` ردیف می‌سازد — و آن جدول کلید خارجی
    // دارد. پس تسویهٔ بعدی به `player_inventory_player_id_fkey` می‌خورد؛
    // چون `closeDue` هیچ try/catch ندارد، خطا از تراکنش بیرون می‌زند،
    // `take: 5` نیمه‌کاره می‌ماند و هر حراجیِ بعدیِ آن منطقه هم پردازش نمی‌شود.
    // خالی‌کردن برنده، همین حراجی را از چرخهٔ تسویه بیرون می‌برد.
    // پولش هم امانتِ قفل‌شده بود؛ با خنثی‌شدنِ رکورد به صندوق منطقه می‌رود
    // تا دفترِ بدهیِ یتیمِ بازیکنِ ناموجود نماند.
    const ledAuctions = await tx.auction.findMany({
      where: { isClosed: false, highestBidderId: playerId },
      select: { id: true, currentBid: true, groupId: true }
    })
    for (const auction of ledAuctions) {
      await tx.auction.update({
        where: { id: auction.id },
        data: { highestBidderId: null }
      })
      // نوع AUCTION_BID با destinationPlayerIdِ خالی = بازگشت ودیه به صندوق؛
      // پول تازه Mint نمی‌شود (پیشتر از کیفِ رهبر کسر و ثبت شده بود).
      await tx.financialTransaction.create({
        data: {
          amount: Number(auction.currentBid),
          type: TransactionType.AUCTION_BID,
          reference: `بازگشتِ ودیهٔ حراجیِ رهبرِ حذف‌شده به صندوق منطقه — حراجی ${auction.id}`
        }
      })
      // صندوقِ منطقه فقط از `RegionFundService` نوشته می‌شود؛ همان کانالی که
      // مالیات و بلیت قرعه‌کشی می‌ریزند و جایزه از آن پرداخت می‌شود. نوشتنِ
      // مستقیم روی `taxRevenue` قراردادِ تک‌نویسندهٔ آن ستون را می‌شکست.
      await this.regionFund.credit(tx, auction.groupId, Number(auction.currentBid))
    }
    await tx.marketListing.deleteMany({ where: { sellerPlayerId: playerId } })
    await tx.vote.deleteMany({ where: { voterId: playerId } })
    await tx.electionCandidate.deleteMany({ where: { playerId } })
    await tx.regionalChallengeContribution.deleteMany({ where: { playerId } })

    // دارایی و پیشرفت شخصی
    await tx.gymMembership.deleteMany({ where: { playerId } })
    await tx.insurancePolicy.deleteMany({ where: { playerId } })
    await tx.playerInventory.deleteMany({ where: { playerId } })
    await tx.travelStamp.deleteMany({ where: { playerId } })
    await tx.dailyFortune.deleteMany({ where: { playerId } })
    await tx.achievementGrant.deleteMany({ where: { playerId } })
    await tx.weeklyChest.deleteMany({ where: { playerId } })
    await tx.dailyQuest.deleteMany({ where: { playerId } })
    await tx.lotteryTicket.deleteMany({ where: { playerId } })
    await tx.migration.deleteMany({ where: { playerId } })
    await tx.referral.deleteMany({
      where: { OR: [{ referrerPlayerId: playerId }, { refereePlayerId: playerId }] }
    })
    await tx.pet.deleteMany({ where: { playerId } })

    // زندگی و روابط
    await tx.marriageProposal.deleteMany({
      where: { OR: [{ proposerId: playerId }, { targetId: playerId }] }
    })
    await tx.marriage.deleteMany({
      where: { OR: [{ playerAId: playerId }, { playerBId: playerId }] }
    })
    await tx.playerWarning.deleteMany({ where: { playerId } })
    await tx.playerReport.deleteMany({ where: { playerId } })
    await tx.relationship.deleteMany({
      where: { OR: [{ playerId }, { relatedPlayerId: playerId }] }
    })
    await tx.notification.deleteMany({ where: { playerId } })
    await tx.playerSkill.deleteMany({ where: { playerId } })
    await tx.playerGroup.deleteMany({ where: { playerId } })
    await tx.workSession.deleteMany({ where: { playerId } })

    // تاریخچهٔ منطقه و دفتر کل می‌ماند؛ فقط اشاره‌شان به این بازیکن تهی می‌شود
    // (`game_events.player_id` و `financial_transactions.*_player_id` در دیتابیس
    // `ON DELETE SET NULL` هستند)، پس رخداد/سند بی‌صاحب نمی‌شود و حذف نمی‌شود.
  }

  // ─────────────────────────────────── کمکی‌ها

  /**
   * هدفِ اقدامِ مدیریتی نباید ادمین فعال ربات باشد.
   *
   * چرا؟ دسترسی مدیریت در جدول جداگانه‌ای است؛ اگر شخصیتِ یک ادمین مسدود یا حذف
   * شود ولی ردیف ادمینش بماند، وضعیتِ متناقض می‌سازیم: بازیکنِ مسدودی که هنوز
   * پنل مدیریت را می‌چرخاند. ترتیب درست همیشه «اول دسترسی، بعد حساب» است.
   */
  private async assertNotBotAdmin(targetTelegramUserId: bigint): Promise<void> {
    const admin = await this.db.botAdmin.findUnique({
      where: { telegramUserId: targetTelegramUserId }
    })
    if (admin?.isActive) {
      throw new ConflictError(
        'Target is bot admin',
        'این کاربر ادمین ربات است؛ اول دسترسی مدیریتش را حذف کن.'
      )
    }
  }

  /** Lock the actor privilege until commit. Revocation cannot race a write. */
  private async authorizedTransaction<T>(
    actor: bigint,
    ownerOnly: boolean,
    operation: (tx: Prisma.TransactionClient) => Promise<T>
  ): Promise<T> {
    return this.db.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ role: BotAdminRole; isActive: boolean }>>`
        SELECT role, is_active AS "isActive" FROM bot_admins
        WHERE telegram_user_id = ${actor} FOR SHARE`
      const admin = rows[0]
      if (
        !admin?.isActive ||
        (ownerOnly && (actor !== PRIMARY_OWNER_TELEGRAM_ID || admin.role !== BotAdminRole.OWNER))
      ) {
        throw new UnauthorizedError(
          'Privilege revoked',
          'دسترسی این تغییر را نداری؛ از ادمین اصلی پیگیری کن.'
        )
      }
      return operation(tx)
    })
  }

  /**
   * بستن همهٔ نوبت‌های کاری فعال یک بازیکن + آزادسازی ظرفیت هر شغل.
   * همان قاعدهٔ `stopActiveWork`، برای مسیرهای دسته‌ای (بن/فوت/بازنشانی)؛
   * مزدی پرداخت نمی‌شود چون این اقدام اصلاحی است.
   */
  private async cancelActiveShifts(tx: Prisma.TransactionClient, playerId: string): Promise<void> {
    const sessions = await tx.workSession.findMany({
      where: { playerId, status: WorkSessionStatus.ACTIVE },
      select: { id: true, jobKey: true }
    })
    if (sessions.length === 0) {
      return
    }
    for (const session of sessions) {
      const closed = await tx.workSession.updateMany({
        where: { id: session.id, playerId, status: WorkSessionStatus.ACTIVE },
        data: { status: WorkSessionStatus.CANCELLED, endedAt: new Date() }
      })
      if (closed.count === 1) {
        await tx.$executeRaw`UPDATE "job_capacities" SET "occupied" = GREATEST("occupied" - 1, 0) WHERE "job_key" = ${session.jobKey}`
      }
    }
  }

  /** بازیکن هدف + فیلدهایی که برای نوشتن امن لازم داریم (در همان تراکنش). */
  private async requirePlayer(tx: Prisma.TransactionClient, telegramUserId: bigint) {
    const player = await tx.player.findUnique({
      where: { telegramUserId },
      select: {
        id: true,
        balance: true,
        health: true,
        fatigue: true,
        experience: true,
        status: true,
        activityState: true,
        isEnrolled: true,
        enrolledFieldKey: true,
        streakCount: true,
        currentDegree: true
      }
    })
    if (!player) {
      throw new NotFoundError(
        'Player not found',
        'بازیکن موردنظر یافت نشد. شناسه را بررسی کن؛ او باید ابتدا در چت خصوصی ثبت‌نام کند.'
      )
    }
    return player
  }

  private async writeLog(
    tx: Prisma.TransactionClient,
    actorUserId: bigint,
    action: string,
    targetUserId: bigint,
    details: Prisma.InputJsonValue
  ): Promise<void> {
    await tx.adminLog.create({
      data: { actorUserId, action, targetUserId, details }
    })
  }
}

/**
 * تبدیل یک ردیفِ گزارش (به‌همرا با بازیکنش) به نمای مشترکِ پنل مدیریت.
 * یک محلِ کانونی تا پنل فهرست و پنل جزئیات هرگز شکلِ متفاوتی نسازند.
 */
function toAdminReportView(row: {
  id: string
  category: AdminReportView['category']
  body: string
  section: string | null
  status: AdminReportView['status']
  answer: string | null
  answeredAt: Date | null
  createdAt: Date
  player: { firstName: string; lastName: string | null; telegramUserId: bigint }
}): AdminReportView {
  return {
    id: row.id,
    category: row.category,
    body: row.body,
    section: row.section,
    status: row.status,
    answer: row.answer,
    answeredAt: row.answeredAt,
    createdAt: row.createdAt,
    playerName: `${row.player.firstName} ${row.player.lastName ?? ''}`.trim(),
    telegramUserId: row.player.telegramUserId
  }
}

/**
 * پاک‌سازی و اندازه‌سنجی متن آزادِ مدیریتی (دلیل اخطار، پیام به بازیکن).
 *
 * این متن‌ها در پنل مارک‌داون رندر می‌شوند و به بازیکن هم می‌رسند؛ پس همان
 * `plainInput` بقیهٔ ورودی‌های آزاد پروژه پاک‌سازی می‌کند و مرزِ اندازه از
 * همان ثابتی می‌آید که پنل نشان می‌دهد.
 */
function cleanModerationText(
  raw: string,
  limits: { min: number; max: number },
  label: string
): string {
  const text = plainInput(raw ?? '')
  if (text.length < limits.min || text.length > limits.max) {
    throw new ValidationError(
      'Text out of range',
      `${label} باید ${textLimitText(limits)} باشد و فقط متن ساده داشته باشد.`
    )
  }
  return text
}

/**
 * قفل ردیف بازیکن تا پایان تراکنش.
 *
 * دو اقدام همزمان روی یک بازیکن (دو اخطار، اخطار و بن، دو حذف) با این قفل
 * پشت‌سرهم اجرا می‌شوند؛ وگرنه هر دو یک وضعیت را می‌خواندند و تصمیم
 * نادرست می‌گرفتند (مثلاً هیچ‌کدام مسدود نمی‌کرد).
 */
async function lockPlayerRow(tx: Prisma.TransactionClient, playerId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM players WHERE id = ${playerId} FOR UPDATE`
}

/** دلتای مجاز موجودی: عدد صحیح امن، صفر نباشد، و از مرزِ ورودی پنل رد نشود. */
function assertNonZeroAmount(amount: number, label: string): void {
  const maxDelta = ADMIN_FIELD_LIMITS.balance.max
  if (!Number.isSafeInteger(amount) || amount === 0) {
    throw new ValidationError('Invalid amount', `${label} باید عددی صحیح و غیرصفر باشد.`)
  }
  if (Math.abs(amount) > maxDelta) {
    throw new ValidationError(
      'Amount out of range',
      `${label} نباید از ${fieldLimitText('balance')} تومان بیشتر باشد.`
    )
  }
}

/** شرط جست‌وجو؛ ورودی خام هرگز به کوئری نمی‌رسد. */
function searchWhere(search: string | undefined): Prisma.PlayerWhereInput {
  const term = normalizeAdminSearch(search ?? '').replace(/^@/, '')
  if (!term) {
    return {}
  }
  const numeric = /^\d+$/.test(term)
  if (numeric) {
    return { telegramUserId: BigInt(term) }
  }
  return {
    OR: [
      { firstName: { contains: term, mode: 'insensitive' } },
      { lastName: { contains: term, mode: 'insensitive' } },
      { username: { contains: term, mode: 'insensitive' } }
    ]
  }
}

/** اندازهٔ صفحهٔ فهرست‌ها — برای صفحه‌بندی پنل. */
export const ADMIN_PAGE_SIZE = MAX_PAGE_SIZE

/** Search normalization preserves IDs and Latin usernames (keyword normalization does not). */
export function normalizeAdminSearch(value: string): string {
  return value
    .trim()
    .replace(/^@/, '')
    .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[يى]/g, 'ی')
    .replace(/ك/g, 'ک')
    .slice(0, 100)
}
