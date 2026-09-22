import {
  BusinessStatus,
  PrismaClient,
  TransactionType,
  WorkSession,
  WorkSessionStatus,
  WorkSessionType,
  PlayerActivityState
} from '@prisma/client'
import { MIN_HEALTH, MAX_FATIGUE } from '../../modules/life/life-core'
import { TaxService } from '../../modules/economy/tax.service'
import { gameMonthStart } from '../../utils/game-time'
import { creditedMinutesOf, completedShifts } from '../../modules/occupation/work-minutes'

/** پیامِ ثابتِ «شیفت فعال تکراری» — سرویس از روی آن پیامِ فارسی می‌سازد. */
export const ACTIVE_SESSION_TAKEN = 'Player already has an active work session'

/**
 * آیا این خطا یعنی «بازیکن از قبل شیفت فعال دارد»؟
 *
 * دو مسیر این را تولید می‌کند: بررسی داخل تراکنش (حالت عادی) و نقضِ شاخصِ
 * یکتای `one_active_work_session_per_player` (حالت رقابتی واقعی). هر دو باید
 * یک پیامِ انسانیِ یکسان به بازیکن بدهند، نه Stack trace.
 */
export function isActiveSessionConflict(error: unknown): boolean {
  if (error instanceof Error && error.message === ACTIVE_SESSION_TAKEN) {
    return true
  }
  const code = (error as { code?: string } | null)?.code
  if (code !== 'P2002') {
    return false
  }
  const target = (error as { meta?: { target?: unknown } }).meta?.target
  const flat = Array.isArray(target) ? target.join(',') : String(target ?? '')
  return flat.includes('one_active_work_session_per_player') || flat.includes('player_id')
}

/**
 * حداقلِ دادهٔ بازیکن که چرخهٔ خودکار برای تسویه لازم دارد.
 *
 * عمداً یک زیرمجموعهٔ انتخاب‌شده است (نه کل ردیفِ بازیکن): چرخه برای هر شیفت
 * یک بازیکن می‌خواند و خواندنِ همهٔ ستون‌ها بی‌دلیل حجم و کوئری را بالا می‌برد.
 */
export interface SweepSessionPlayer {
  id: string
  fatigue: number
  health: number
  experience: number
  age: number
  startedAt: Date | null
  currentDegree: string | null
  graduationField: string | null
}

export interface CreateWorkSessionInput {
  playerId: string
  jobKey: string
  jobTitle: string
  sessionType: WorkSessionType
  businessId?: string
  payPerMinute: number
}

/**
 * محل کاری که بازیکن می‌تواند در آن شیفت بگیرد.
 *
 * دو حالت، هر دو به یک مقصد می‌رسند: کارمندِ یک کسب‌وکار، یا مالکی که خودش
 * پشت کسب‌وکارش می‌ایستد. مالک دستمزد ساعتی ندارد (سودش همان درآمدِ
 * کسب‌وکار است)، پس نرخش صفر است.
 */
export interface Workplace {
  businessId: string
  businessName: string
  title: string
  payPerMinute: number
  isOwner: boolean
  /**
   * حجمِ قراردادِ ماهانهٔ کارمند (دقیقهٔ بازی در ماهِ بازی).
   * مالکِ کسب‌وکار قرارداد ندارد، پس مقدارش `null` است.
   */
  contractMinutesPerMonth: number | null
  /** کارکردِ همین ماهِ بازی — سنجهٔ سقفِ قرارداد. */
  workedMinutesThisMonth: number
}

export class WorkSessionRepository {
  constructor(private readonly db: PrismaClient) {}

  async findActiveSession(playerId: string): Promise<WorkSession | null> {
    return this.db.workSession.findFirst({
      where: {
        playerId,
        status: WorkSessionStatus.ACTIVE
      }
    })
  }

  /**
   * تعداد شیفت‌های فعال به تفکیک شغل — یک کوئری تجمیعی، بدون N+1.
   *
   * برای آشتی‌دادنِ شمارندهٔ ظرفیت با واقعیت استفاده می‌شود: اگر ربات وسطِ
   * یک شیفت بمیرد، `releaseSlot` هرگز صدا زده نمی‌شود و آن ظرفیت برای همیشه
   * «اشغال» می‌ماند. این شمارش، منبع حقیقتِ بازگشتِ ظرفیت است.
   */
  /**
   * شیفت‌های فعالی که ممکن است بدنشان تمام شده باشد — منبعِ چرخهٔ خودکار.
   *
   * ترتیب `startedAt` صعودی است: قدیمی‌ترین شیفت، سررسیدشده‌ترین شیفت است، پس
   * یک بستهٔ کوچک هم روی مهم‌ترین ردیف‌ها کار می‌کند و هیچ شیفتی برای همیشه در
   * صف نمی‌ماند.
   *
   * تصمیمِ «سررسید شده یا نه» اینجا گرفته نمی‌شود: نرخ خستگی هر شغل فرق دارد و
   * در دیتابیس نیست. این کوئری فقط دادهٔ لازمِ همان تصمیم را در **یک**
   * رفت‌وبرگشت می‌آورد (بدون N+1).
   */
  async findActiveSessionsForSweep(
    limit: number
  ): Promise<Array<{ session: WorkSession; player: SweepSessionPlayer }>> {
    const take = Math.max(1, Math.min(200, Math.floor(limit)))
    const rows = await this.db.workSession.findMany({
      where: { status: WorkSessionStatus.ACTIVE },
      orderBy: { startedAt: 'asc' },
      take,
      include: {
        player: {
          select: {
            id: true,
            fatigue: true,
            health: true,
            experience: true,
            age: true,
            startedAt: true,
            currentDegree: true,
            graduationField: true
          }
        }
      }
    })
    return rows.map((row) => ({ session: row, player: row.player }))
  }

  async countActiveByJob(): Promise<Map<string, number>> {
    const rows = await this.db.workSession.groupBy({
      by: ['jobKey'],
      where: { status: WorkSessionStatus.ACTIVE },
      _count: { _all: true }
    })
    return new Map(rows.map((row) => [row.jobKey, row._count._all]))
  }

  /**
   * محل کارِ فعلی بازیکن: اول استخدام فعال، وگرنه کسب‌وکارِ خودش.
   *
   * استخدام مقدم است چون دستمزد دارد؛ کسب‌وکارِ خودآدم آخرین گزینه است و
   * فقط اگر جایی شاغل نباشد.
   */
  async findWorkplace(playerId: string): Promise<Workplace | null> {
    const employment = await this.db.businessEmployee.findFirst({
      where: { playerId, isActive: true, business: { status: BusinessStatus.ACTIVE } },
      select: {
        title: true,
        salaryPerMinute: true,
        contractMinutesPerMonth: true,
        business: { select: { id: true, name: true } }
      }
    })
    if (employment) {
      return {
        businessId: employment.business.id,
        businessName: employment.business.name,
        title: employment.title,
        payPerMinute: Number(employment.salaryPerMinute),
        isOwner: false,
        contractMinutesPerMonth: employment.contractMinutesPerMonth,
        workedMinutesThisMonth: await this.workedMinutesThisMonth(
          employment.business.id,
          playerId
        )
      }
    }

    const owned = await this.db.business.findFirst({
      where: { ownerId: playerId, status: BusinessStatus.ACTIVE },
      select: { id: true, name: true },
      orderBy: { createdAt: 'asc' }
    })
    if (!owned) {
      return null
    }
    return {
      businessId: owned.id,
      businessName: owned.name,
      title: owned.name,
      payPerMinute: 0,
      isOwner: true,
      contractMinutesPerMonth: null,
      workedMinutesThisMonth: await this.workedMinutesThisMonth(owned.id, playerId)
    }
  }

  /**
   * کارکردِ یک بازیکن در این کسب‌وکار از **آغاز ماهِ بازیِ جاری**.
   *
   * سقفِ قرارداد ماهانه است، پس عددی که "چقدر جا مانده" را می‌گوید باید
   * از مرزِ ماه شمرده شود، نه از آخرین تسویه. مرزِ ماه از ساعت مرکزی بازی
   * می‌آید تا هیچ‌جا تقویم دست‌ساز نداشته باشیم.
   */
  async workedMinutesThisMonth(businessId: string, playerId: string): Promise<number> {
    const since = gameMonthStart()
    const shifts = await completedShifts(this.db, businessId, since)
    return creditedMinutesOf(shifts, playerId, since)
  }

  async startSession(input: CreateWorkSessionInput): Promise<WorkSession> {
    return this.db.$transaction(async (tx) => {
      const active = await tx.workSession.findFirst({
        where: { playerId: input.playerId, status: WorkSessionStatus.ACTIVE }
      })
      if (active) {
        throw new Error(ACTIVE_SESSION_TAKEN)
      }

      await tx.player.update({
        where: { id: input.playerId },
        data: { activityState: PlayerActivityState.WORKING }
      })

      return tx.workSession.create({
        data: {
          playerId: input.playerId,
          jobKey: input.jobKey,
          jobTitle: input.jobTitle,
          sessionType: input.sessionType,
          businessId: input.businessId,
          payPerMinute: input.payPerMinute,
          status: WorkSessionStatus.ACTIVE
        }
      })
    })
  }

  /**
   * تسویهٔ شیفت.
   *
   * @param result.earnedMoney دستمزد *ناخالص* محاسبه‌شده برای شیفت. مالیات بر
   *   درآمد در همین تراکنش «در مبدأ» کسر می‌شود: روی ردیف شیفت دستمزد
   *   ناخالص می‌ماند (تاریخچهٔ شغل)، دفتر کل هم همان ناخالص را به‌عنوان
   *   درآمد و هم مالیات را به‌عنوان خروج ثبت می‌کند، و کیف پول مبلغ خالص را
   *   می‌گیرد — پس جمع دفتر کل با تغییر موجودی برابر است.
   */
  async endSession(
    sessionId: string,
    result: {
      earnedMoney: number
      earnedExp: number
      healthDrain: number
      fatigueGained: number
    }
  ): Promise<WorkSession> {
    return this.db.$transaction(async (tx) => {
      // قفل نشست با نوشتار شرطی: دو تسویهٔ همزمان، نشست را دوباره تسویه
      // نمی‌کنند (کلیک دوبارهٔ «پایان شیفت» فقط یک بار پول می‌دهد).
      const locked = await tx.workSession.updateMany({
        where: { id: sessionId, status: WorkSessionStatus.ACTIVE },
        data: {
          status: WorkSessionStatus.COMPLETED,
          endedAt: new Date(),
          earnedMoney: Math.max(0, Math.round(result.earnedMoney)),
          earnedExp: result.earnedExp,
          healthDrain: result.healthDrain,
          fatigueGained: result.fatigueGained
        }
      })
      if (locked.count !== 1) {
        throw new Error('Active work session not found')
      }

      const updatedSession = await tx.workSession.findUniqueOrThrow({
        where: { id: sessionId }
      })

      const player = await tx.player.findUnique({ where: { id: updatedSession.playerId } })
      // کف و سقفِ واقعی از هستهٔ زندگی می‌آیند؛ پیش‌تر کف سلامت اینجا ۱ بود
      // ولی در اضافه‌کاری ۰ — دو قانون برای یک عدد، و ۰ یعنی «فوت‌شده» روی پنل
      // در حالی که بازیکن زنده و سر کار بود.
      const newHealth = Math.max(MIN_HEALTH, (player?.health ?? 100) - result.healthDrain)
      const newFatigue = Math.min(MAX_FATIGUE, (player?.fatigue ?? 0) + result.fatigueGained)

      // مالیات بر درآمد در همان تراکنشِ پرداخت کسر می‌شود: دستمزد ناخالص در
      // دفتر کل ثبت می‌گردد، مالیاتش به صندوق منطقهٔ بازیکن می‌رود و کیف پول
      // فقط مبلغ خالص را می‌گیرد. پس جمع دفتر کل همیشه با تغییر موجودی یکی است.
      const grossEarned = Math.max(0, Math.round(result.earnedMoney))
      const taxed = await new TaxService().withholdIncomeTax(tx, {
        playerId: updatedSession.playerId,
        gross: grossEarned,
        reference: `کار پاره‌وقت: ${updatedSession.jobTitle}`
      })

      await tx.player.update({
        where: { id: updatedSession.playerId },
        data: {
          activityState: PlayerActivityState.IDLE,
          balance: { increment: taxed.net },
          experience: { increment: result.earnedExp },
          health: newHealth,
          fatigue: newFatigue
        }
      })

      if (grossEarned > 0) {
        await tx.financialTransaction.create({
          data: {
            amount: grossEarned,
            type: TransactionType.SALARY_PAYMENT,
            destinationPlayerId: updatedSession.playerId,
            reference: `دستمزد کار پاره‌وقت: ${updatedSession.jobTitle}`
          }
        })
      }

      return updatedSession
    })
  }
}