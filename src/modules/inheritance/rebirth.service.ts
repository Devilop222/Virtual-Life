/**
 * «زندگی تازه» — حلقهٔ گمشدهٔ زنجیرهٔ میراث.
 *
 * ## مشکلی که این فایل حل می‌کند
 * پیامِ مرگ به بازیکن می‌گفت «با /start یک شخصیت تازه بساز»، ولی این کار
 * **غیرممکن** بود: `players.telegram_user_id` یکتاست و ردیفِ بازیکن پس از مرگ
 * هم سرِ جایش می‌ماند. یعنی مرگ برای همیشه حساب را می‌بست و جملهٔ پیام دروغ
 * بود. از آن بدتر: پروندهٔ میراث هم `deceased_id` یکتا داشت، پس حتی ثبتِ مرگِ
 * دوم هم ممکن نبود.
 *
 * ## چرا زندگی تازه در همان ردیف آغاز می‌شود؟
 * کلِ سابقهٔ مالی (دفتر کل)، تاریخچه، پرونده‌های میراثِ گذشته و حکم‌های
 * ادمین با `player_id` گره خورده‌اند. ساختن ردیف دوم یعنی یا گم‌شدنِ آن
 * سابقه، یا دوباره‌نویسیِ همهٔ آن ارجاع‌ها. پس زندگی تازه همان ردیف را از نو
 * می‌سازد و شمارندهٔ `lives` می‌گوید چندمین بار است.
 *
 * ## چرا منتظر تسویهٔ میراث می‌مانیم؟
 * اگر زندگی تازه پیش از پایانِ انتقالِ دارایی شروع شود، وارث ممکن است بعداً
 * داراییِ کسی را بگیرد که «هنوز همان شخص است ولی حالا یک بازیکنِ جوانِ فعال
 * با موجودیِ تازه» — یعنی دو ادعا روی یک کیف پول. پس تا وقتی پروندهٔ زندگیِ
 * جاری به یک وضعیتِ پایانی نرسیده، زندگی تازه آغاز نمی‌شود.
 *
 * ## چرا پروندهٔ بی‌وارث باید تسویه شود؟
 * وضعیت `NO_HEIR` دارایی را «محفوظ» نگه می‌دارد و هیچ‌کس آن را برنمی‌دارد.
 * اگر زندگی تازه با صفرکردنِ موجودی شروع می‌شد، آن پول بی‌ردیف از بخش خصوصی
 * بیرون می‌رفت و ممیزیِ اقتصاد «پول گم‌شده» نشان می‌داد. پس پیش از شروع،
 * باقی‌ماندهٔ دارایی به صندوق منطقه می‌رسد — با یک ردیف دفتریِ صریح
 * (`UNCLAIMED_ESTATE`) و به‌روزرسانیِ پرونده. این هم اقتصاد را سالم نگه
 * می‌دارد و هم «بی‌وصیتی» را سودآور نمی‌کند.
 */
import {
  Gender,
  InheritanceStatus,
  PrismaClient,
  PlayerActivityState,
  PlayerStatus,
  TransactionType
} from '@prisma/client'
import { logger } from '../../utils/logger'
import { ConflictError, ValidationError } from '../../utils/classes/errors'
import { STARTING_BALANCE } from '../../config/economy'
import { biographySchema, genderSchema, plainInput } from '../../utils/validation'
import { RegionFundService } from '../economy/tax.service'
import { BASE_MAX_HEALTH } from '../health/max-health'
import { REAL_DAY_MS } from '../../utils/game-time'

/** کمترین طولِ معرفی؛ همان قاعدهٔ ثبت‌نام تا تجربهٔ بازیکن یکدست بماند. */
export const REBIRTH_MIN_BIOGRAPHY = 3
export const REBIRTH_MAX_BIOGRAPHY = 600

/**
 * محدودیتِ بازگشت پس از مرگ: **۴۸ ساعت واقعی**، نه بازی.
 *
 * این عدد عمداً از `REAL_DAY_MS` ساخته می‌شود و نه از تقویم بازی: یک ماهِ
 * بازی فقط یک روزِ واقعی است، پس «۴۸ ساعتِ بازی» عملاً دو دقیقهٔ انتظار
 * می‌شد و مرگ هیچ وزنی نداشت. مرگ یک وقفهٔ واقعی برای بازیکن است، پس واحدش
 * هم واقعی است.
 */
export const REBIRTH_COOLDOWN_MS = 2 * REAL_DAY_MS

/** متنِ انسانیِ زمانِ باقیمانده (بدون اصطلاح داخلی و بدون اشاره به نقشِ کسی). */
export function remainingWaitText(ms: number): string {
  const totalMinutes = Math.max(1, Math.ceil(Math.max(0, ms) / 60_000))
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  const parts: string[] = []
  if (hours > 0) {
    parts.push(`${hours.toLocaleString('fa-IR')} ساعت`)
  }
  if (minutes > 0) {
    parts.push(`${minutes.toLocaleString('fa-IR')} دقیقه`)
  }
  return parts.join(' و ')
}

export interface RebirthReadiness {
  /** آیا همین حالا می‌تواند زندگی تازه را شروع کند؟ */
  eligible: boolean
  /** دلیلِ انسانیِ «چرا نه» (فقط وقتی `eligible` نادرست است). */
  reason: string | null
  /** چندمین زندگی از این هم شروع می‌شود (۱ = زندگی اول). */
  nextLifeNumber: number
  /** وضعیت پروندهٔ زندگیِ جاری. */
  caseStatus: InheritanceStatus | null
  /** داراییِ نقدیِ باقی‌مانده که به صندوق منطقه می‌رسد (اگر پرونده بی‌وارث باشد). */
  residualEstate: number
  /** لحظه‌ای که انتظارِ پس از مرگ تمام می‌شود (فقط وقتی در انتظاریم). */
  eligibleAt?: Date | null
  /** میلی‌ثانیهٔ باقی‌مانده تا بازگشت مجاز (فقط وقتی در انتظاریم). */
  remainingMs?: number
}

/** گزینه‌های فراخوانی — از سمت سرور پر می‌شوند، نه از ورودی بازیکن. */
export interface RebirthAccess {
  /**
   * رد کردن محدودیتِ انتظار برای مدیرانِ واقعیِ ربات.
   *
   * این پرچم فقط از هندلر و بر اساس همان جدولِ مدیران پر می‌شود؛ هیچ مسیری
   * آن را از متن/کالبک بازیکن نمی‌خواند، پس با دست‌کاری درخواست قابل دور زدن نیست.
   */
  adminOverride?: boolean
}

export interface RebirthInput {
  gender: unknown
  biography: unknown
}

export interface RebirthResult {
  playerId: string
  lifeNumber: number
  /** داراییِ بی‌وارث که به صندوق منطقه رسید. */
  estateToRegion: number
}

/** وضعیت‌هایی که «میراث تمام شده» حساب می‌شوند. */
const SETTLED_STATUSES: readonly InheritanceStatus[] = [
  InheritanceStatus.COMPLETED,
  InheritanceStatus.NO_HEIR
]

export class RebirthService {
  constructor(
    private readonly db: PrismaClient,
    private readonly regionFund: RegionFundService = new RegionFundService()
  ) {}

  /**
   * آیا این بازیکن می‌تواند زندگی تازه را شروع کند؟
   *
   * این تابع هیچ نوشتنی ندارد و از پنل هم صدا زده می‌شود، پس باید ارزان و
   * بی‌عوارض باشد.
   */
  async readiness(playerId: string, access: RebirthAccess = {}): Promise<RebirthReadiness> {
    const player = await this.db.player.findUnique({
      where: { id: playerId },
      select: {
        id: true,
        lives: true,
        status: true,
        balance: true,
        homeGroupId: true,
        currentRegionId: true
      }
    })
    if (!player) {
      return { eligible: false, reason: 'حساب پیدا نشد.', nextLifeNumber: 1, caseStatus: null, residualEstate: 0 }
    }

    const nextLifeNumber = Math.max(1, player.lives) + 1

    if (player.status !== PlayerStatus.DEAD) {
      return {
        eligible: false,
        reason: 'این زندگی هنوز تمام نشده است.',
        nextLifeNumber,
        caseStatus: null,
        residualEstate: 0
      }
    }

    const latest = await this.db.inheritanceCase.findFirst({
      where: { deceasedId: playerId },
      orderBy: { lifeIndex: 'desc' },
      select: { status: true, lifeIndex: true, openedAt: true }
    })

    // مرگِ ثبت‌شده از مسیری که پرونده نساخته (پنل ادمین) نباید حساب را قفل کند.
    const caseStatus = latest?.status ?? null
    if (!caseStatus) {
      return {
        eligible: false,
        reason: 'امور این زندگی هنوز در سامانه ثبت نشده است؛ کمی بعد دوباره تلاش کن.',
        nextLifeNumber,
        caseStatus: null,
        residualEstate: 0
      }
    }

    if (!SETTLED_STATUSES.includes(caseStatus)) {
      return {
        eligible: false,
        reason:
          'امور دارایی‌هایت هنوز در جریان است. تا پایانِ این مرحله نمی‌توانی زندگی تازه را شروع کنی؛ چند دقیقهٔ دیگر دوباره ببین.',
        nextLifeNumber,
        caseStatus,
        residualEstate: 0
      }
    }

    // ── انتظارِ پس از مرگ (۴۸ ساعت واقعی) ──
    // پروندهٔ همین زندگی مرجعِ زمان است: `openedAt` لحظهٔ ثبت مرگ است، پس
    // ری‌استارت یا اجرای دوباره آن را جابه‌جا نمی‌کند.
    if (latest?.openedAt) {
      const eligibleAt = new Date(latest.openedAt.getTime() + REBIRTH_COOLDOWN_MS)
      const remainingMs = eligibleAt.getTime() - Date.now()
      if (remainingMs > 0 && !access.adminOverride) {
        return {
          eligible: false,
          reason: `زمانِ سوگواری هنوز تمام نشده است. حدوداً ${remainingWaitText(remainingMs)} دیگر می‌توانی زندگی تازه را شروع کنی.`,
          nextLifeNumber,
          caseStatus,
          residualEstate: 0,
          eligibleAt,
          remainingMs
        }
      }
    }

    const residualEstate = Math.max(0, Math.round(Number(player.balance ?? 0)))
    if (caseStatus === InheritanceStatus.NO_HEIR && residualEstate > 0) {
      const groupId = player.homeGroupId ?? player.currentRegionId
      if (!groupId) {
        return {
          eligible: false,
          reason:
            'دارایی‌ات بی‌وارث مانده و باید به صندوق یک منطقه برسد؛ ولی هنوز عضو هیچ منطقه‌ای نیستی. با «پشتیبانی» در میان بگذار.',
          nextLifeNumber,
          caseStatus,
          residualEstate
        }
      }
    }

    return { eligible: true, reason: null, nextLifeNumber, caseStatus, residualEstate }
  }

  /**
   * آغاز زندگی تازه.
   *
   * تمام نوشتن‌ها در یک تراکنش‌اند و همهٔ شرایط یک بار دیگر **داخل** تراکنش
   * سنجیده می‌شوند: `readiness` فقط برای نمایش است و ممکن است بین خواندن و
   * نوشتن عوض شود. گاردِ نهایی، نوشتارِ شرطی روی `status = DEAD` و
   * `lives = <شمارهٔ خوانده‌شده>` است؛ پس دو کلیکِ هم‌زمان فقط یکی را قبول
   * می‌کند و هرگز دو زندگیِ هم‌زمان ساخته نمی‌شود.
   */
  async startNewLife(
    playerId: string,
    input: RebirthInput,
    access: RebirthAccess = {}
  ): Promise<RebirthResult> {
    const parsedGender = genderSchema.safeParse(input.gender)
    if (!parsedGender.success) {
      throw new ValidationError('Invalid gender', 'لطفاً از دکمه‌های انتخاب جنسیت استفاده کن.')
    }
    const parsedBio = biographySchema.safeParse(input.biography)
    if (!parsedBio.success) {
      const tooLong = parsedBio.error.issues[0]?.code === 'too_big'
      throw new ValidationError(
        'Invalid biography',
        tooLong
          ? `معرفی شخصیت طولانی است. حداکثر ${REBIRTH_MAX_BIOGRAPHY} کاراکتر مجاز است.`
          : `معرفی شخصیت کوتاه است. یک متن ${REBIRTH_MIN_BIOGRAPHY} تا ${REBIRTH_MAX_BIOGRAPHY} نویسه‌ای بفرست.`
      )
    }
    const biography = plainInput(parsedBio.data)
    if (biography.length < REBIRTH_MIN_BIOGRAPHY) {
      throw new ValidationError('Invalid biography', 'معرفی شخصیت کوتاه است.')
    }
    const gender = genderSchema.parse(parsedGender.data) as Gender

    const ready = await this.readiness(playerId, access)
    if (!ready.eligible) {
      throw new ConflictError('Rebirth not available', ready.reason ?? 'زندگی تازه هنوز ممکن نیست.')
    }

    const lifeNumber = ready.nextLifeNumber
    const now = new Date()

    return this.db.$transaction(async (tx) => {
      const player = await tx.player.findUniqueOrThrow({
        where: { id: playerId },
        select: {
          id: true,
          lives: true,
          status: true,
          balance: true,
          homeGroupId: true,
          currentRegionId: true
        }
      })

      // گاردِ نهایی: همین وضعیت و همین شمارهٔ زندگی که `readiness` دید.
      if (player.status !== PlayerStatus.DEAD || Math.max(1, player.lives) + 1 !== lifeNumber) {
        throw new ConflictError('Life already restarted', 'زندگی تازه‌ای برایت شروع شده است.')
      }

      const residualEstate = Math.max(0, Math.round(Number(player.balance ?? 0)))
      const latest = await tx.inheritanceCase.findFirst({
        where: { deceasedId: playerId },
        orderBy: { lifeIndex: 'desc' },
        select: { id: true, status: true, openedAt: true }
      })

      // گاردِ زمان داخل تراکنش: بین `readiness` و این لحظه ممکن است پروندهٔ
      // زندگی عوض شده باشد. همان قاعده، یک‌بار دیگر و روی دادهٔ قفل‌شده.
      if (latest?.openedAt && !access.adminOverride) {
        const remainingMs = latest.openedAt.getTime() + REBIRTH_COOLDOWN_MS - Date.now()
        if (remainingMs > 0) {
          throw new ConflictError(
            'Rebirth cool-down',
            `زمانِ سوگواری هنوز تمام نشده است. حدوداً ${remainingWaitText(remainingMs)} دیگر می‌توانی زندگی تازه را شروع کنی.`
          )
        }
      }

      // ── تسویهٔ داراییِ بی‌وارث: پول نباید بی‌ردیف گم شود ──
      let estateToRegion = 0
      if (
        latest &&
        latest.status === InheritanceStatus.NO_HEIR &&
        residualEstate > 0
      ) {
        const groupId = player.homeGroupId ?? player.currentRegionId
        if (!groupId) {
          throw new ConflictError(
            'Rebirth not available',
            'دارایی بی‌وارث باید به صندوق یک منطقه برسد؛ ولی عضو هیچ منطقه‌ای نیستی. با پشتیبانی در میان بگذار.'
          )
        }

        // موجودی فقط اگر همان لحظه کافی بود صفر می‌شود (نوشتار شرطی).
        const drained = await tx.player.updateMany({
          where: { id: playerId, status: PlayerStatus.DEAD, balance: { gte: residualEstate }, lives: player.lives },
          data: { balance: 0 }
        })
        if (drained.count === 1) {
          await this.regionFund.credit(tx, groupId, residualEstate)
          await tx.financialTransaction.create({
            data: {
              amount: residualEstate,
              type: TransactionType.UNCLAIMED_ESTATE,
              sourcePlayerId: playerId,
              reference: 'دارایی بی‌وارث — به صندوق منطقه رسید'
            }
          })
          estateToRegion = residualEstate
        }

        await tx.inheritanceCase.updateMany({
          where: { id: latest.id, status: InheritanceStatus.NO_HEIR },
          data: {
            status: InheritanceStatus.COMPLETED,
            completedAt: now,
            lastError: null
          }
        })
      }

      const claimed = await tx.player.updateMany({
        where: {
          id: playerId,
          status: PlayerStatus.DEAD,
          lives: player.lives
        },
        data: {
          // ── شالودهٔ زندگی تازه ──
          status: PlayerStatus.ACTIVE,
          lives: lifeNumber,
          gender,
          biography,
          age: 18,
          health: BASE_MAX_HEALTH,
          fatigue: 0,
          experience: 0,
          // سرمایهٔ اولیه مثل روزِ ثبت‌نام؛ یک ردیف دفتری جبرانش را می‌نویسد.
          balance: STARTING_BALANCE,
          startedAt: now,
          healthSyncedAt: now,
          // ── پاک‌کردنِ آنچه به زندگیِ گذشته تعلق داشت ──
          currentDegree: 'DIPLOMA',
          graduationField: null,
          isEnrolled: false,
          enrolledFieldKey: null,
          targetDegree: null,
          studyStartedAt: null,
          occupationId: null,
          activityState: PlayerActivityState.IDLE,
          restStartedAt: null,
          maritalStatus: 'SINGLE',
          socialLevel: 'LOW',
          // منطقه و گروهِ بازیکن می‌ماند: دنیای بازی همان است، فقط شخصیت تازه است.
          residenceSince: null,
          lastOvertimeAt: null,
          lastMigrationAt: null,
          streakCount: 0,
          lastStreakAt: null,

          lastActivityAt: now
        }
      })
      if (claimed.count !== 1) {
        throw new ConflictError('Life already restarted', 'زندگی تازه‌ای برایت شروع شده است.')
      }

      await tx.financialTransaction.create({
        data: {
          // شناسهٔ ثابت: اجرای دوباره ردیف دوم نمی‌سازد.
          id: `rebirth-capital:${playerId}:${lifeNumber}`,
          amount: STARTING_BALANCE,
          type: TransactionType.REWARD_PAYOUT,
          destinationPlayerId: playerId,
          reference: `سرمایهٔ زندگی ${lifeNumber}`
        }
      })

      return { playerId, lifeNumber, estateToRegion }
    })
  }

  /**
   * پاکسازیِ پیوندهای زندگیِ گذشته.
   *
   * چرا جدا از تراکنشِ اصلی؟ چون هر یک از این جدول‌ها مالکِ قاعدهٔ خودش است و
   * اگر شکست بخورد نباید شروعِ زندگی تازه را برگرداند — بازیکن باید بتواند
   * بازی کند و یک ردیفِ جاماندهٔ بی‌خطر با یک تلاش دوباره پاک شود.
   *
   * نکته: دارایی‌های انتقال‌پذیر (ملک، کسب‌وکار، سپرده، انبار، دام) توسطِ
   * پروندهٔ میراث به وارث رسیده‌اند. این‌جا فقط چیزهایی پاک
   * می‌شوند که به *خودِ شخصیت* چسبیده‌اند و برای زندگی تازه معنا ندارند.
   */
  async cleanupPreviousLife(playerId: string): Promise<void> {
    try {
      await this.db.$transaction(async (tx) => {
        // مهارت‌ها در زندگی تازه از صفر شروع می‌شوند.
        await tx.playerSkill.deleteMany({ where: { playerId } })
        // عضویت باشگاه، بیمه و شانسِ روزانه به زندگی گذشته تعلق دارند.
        await tx.gymMembership.deleteMany({ where: { playerId } })
        await tx.insurancePolicy.deleteMany({ where: { playerId } })
        await tx.dailyFortune.deleteMany({ where: { playerId } })
        // مأموریت‌های روزانه با پیشرفتِ زندگیِ قبل ریست می‌شوند.
        await tx.dailyQuest.deleteMany({ where: { playerId } })
        // حکم‌های اخطار باقی می‌مانند: سابقهٔ انضباطی به شخصیت گره خورده و
        // با زندگی تازه پاک نمی‌شود.
      })
    } catch (error) {
      logger.warn({ err: error, playerId }, 'rebirth cleanup failed (non-fatal)')
    }
  }
}
