import {
  GameEventType,
  NotificationType,
  PrismaClient,
  TransactionType
} from '@prisma/client'
import { insufficientFunds } from '../../utils/format'
import { ConflictError, NotFoundError } from '../../utils/classes/errors'
import { EventService } from '../events/event.service'
import { NotificationService } from '../notification/notification.service'
import { cycleAmount, dayIndex, daysUntil, gameDays } from '../../utils/game-time'
import { BASE_MAX_HEALTH, resolveMaxHealth } from './max-health'

/** هزینهٔ درمان هر واحد سلامت. */
const COST_PER_HP = 12_000
/** آستانهٔ هشدار سلامت. */
export const HEALTH_WARNING_THRESHOLD = 25
/** حق بیمهٔ هفتگی. */
/**
 * حق بیمهٔ دوره‌ای درمانگاه. دوره ۷ روز *بازی* است (۵٫۶ ساعت واقعی)، پس مبلغ
 * با `cycleAmount` هم‌تراز می‌شود تا هزینهٔ بیمه در زمان واقعی ثابت بماند.
 */
const INSURANCE_PREMIUM = cycleAmount(1_000_000)
const INSURANCE_DAYS = 7
const INSURANCE_COVER_RATE = 0.5

export interface ClinicView {
  health: number
  /** سقف واقعی سلامت (عضو باشگاه = ۱۲۰). */
  maxHealth: number
  missingHealth: number
  fullCost: number
  discountedCost: number
  insured: boolean
  insuranceDaysLeft: number
  coverRatePercent: number
  premium: number
  insuranceDays: number
  needsTreatment: boolean
  isCritical: boolean
  /**
   * چند واحد سلامت با موجودی فعلی قابل خرید است.
   *
   * چرا لازم است؟ پیش از این درمانگاه فقط «همه یا هیچ» بود: اگر موجودی
   * بازیکن به کل هزینهٔ درمان کامل نمی‌رسید، هیچ راهی برای بازیابی سلامت
   * نداشت. بازیکنِ بی‌خانه (که حتی نمی‌تواند استراحت کند) در آن حالت با
   * سلامتِ صفر گیر می‌افتاد بدون هیچ راه پیشگیری — یعنی مرگ برایش اجباری
   * بود، نه انتخابی. این عدد راه «درمان اضطراری» را نشان می‌دهد.
   */
  affordableUnits: number
  /** هزینهٔ همان واحدهای قابل‌خرید. */
  affordableCost: number
}

export interface TreatmentResult {
  healedAmount: number
  paid: number
  saved: number
  newHealth: number
}

/**
 * درمانگاه و بیمهٔ سلامت.
 *
 * چرا لازم است: سلامت تا امروز فقط با استراحت طولانی یا آیتم برمی‌گشت و افت
 * شدید هیچ پیامد یا مسیر جبران سریعی نداشت. درمانگاه راه «گران اما فوری» را
 * اضافه می‌کند و بیمه تصمیم مالی پیشگیرانه می‌سازد.
 *
 * تعادل: هزینه به‌ازای هر واحد سلامت ثابت است، پس درمان کامل از سلامت پایین
 * گران‌تر از یک روز کار است — بازیکن انگیزه دارد نگذارد سلامتش سقوط کند.
 * پروژهٔ درمانگاه شهر (بافر استراحت) مسیر «ارزان اما کند» را بهتر می‌کند؛
 * دو راهبرد کنار هم می‌مانند و هیچ‌کدام دیگری را بی‌معنا نمی‌کند.
 */
export class ClinicService {
  constructor(
    private readonly db: PrismaClient,
    private readonly eventService: EventService,
    private readonly notificationService: NotificationService
  ) {}

  /** سقف سلامت بازیکن (با عضویت فعال باشگاه ۱۲۰، وگرنه ۱۰۰). */
  private async resolveMaxHealth(playerId: string): Promise<number> {
    try {
      // منبع واحد سقف سلامت (باشگاه فعال = ۱۲۰) — همان چیزی که استراحت،
      // کالای فروشگاه و درمان واقعی هم می‌بینند.
      return await resolveMaxHealth(this.db, playerId)
    } catch {
      return BASE_MAX_HEALTH
    }
  }

  /** وضعیت درمانگاه برای رندر پنل. */
  async getView(telegramUserId: bigint): Promise<ClinicView> {
    const player = await this.db.player.findUnique({
      where: { telegramUserId },
      select: { id: true, health: true, balance: true }
    })
    if (!player) {
      throw new NotFoundError('Player not found')
    }

    const policy = await this.activePolicy(player.id)
    // سقف واقعی (عضو باشگاه = ۱۲۰): پیش‌نمایش هزینه باید با درمانِ واقعی یکی
    // باشد، وگرنه برای عضو باشگاه کمتر از مبلغ کسرشده نشان داده می‌شد.
    const maxHealth = await this.resolveMaxHealth(player.id)
    const missing = Math.max(0, maxHealth - player.health)
    const fullCost = missing * COST_PER_HP
    const coverRate = policy ? Number(policy.coverRate) : 0

    const balance = Number(player.balance ?? 0)
    const unitCost = COST_PER_HP * (1 - coverRate)
    const affordableUnits = unitCost > 0 ? Math.min(missing, Math.floor(balance / unitCost)) : 0

    return {
      health: player.health,
      maxHealth,
      missingHealth: missing,
      fullCost,
      discountedCost: Math.round(fullCost * (1 - coverRate)),
      insured: Boolean(policy),
      insuranceDaysLeft: policy ? daysUntil(policy.coversUntil) : 0,
      coverRatePercent: Math.round(INSURANCE_COVER_RATE * 100),
      premium: INSURANCE_PREMIUM,
      insuranceDays: INSURANCE_DAYS,
      needsTreatment: missing > 0,
      isCritical: player.health < HEALTH_WARNING_THRESHOLD,
      affordableUnits,
      affordableCost: Math.round(affordableUnits * unitCost)
    }
  }

  /** بیمهٔ فعال بازیکن (اگر هست). */
  private async activePolicy(playerId: string) {
    return this.db.insurancePolicy.findFirst({
      where: { playerId, coversUntil: { gt: new Date() } },
      orderBy: { coversUntil: 'desc' }
    })
  }

  /**
   * درمان کامل تا سقف سلامت.
   * پرداخت و افزایش سلامت هر دو داخل یک تراکنش با شرط انجام می‌شوند تا
   * دو کلیک همزمان دو بار پول نگیرد.
   */
  async treat(telegramUserId: bigint): Promise<TreatmentResult> {
    const player = await this.db.player.findUnique({
      where: { telegramUserId },
      select: { id: true, health: true }
    })
    if (!player) {
      throw new NotFoundError('Player not found')
    }

    const maxHealth = await this.resolveMaxHealth(player.id)
    const missing = Math.max(0, maxHealth - player.health)
    if (missing === 0) {
      throw new ConflictError('Already healthy', 'سلامت تو در بهترین حالت است و نیازی به درمان نداری.')
    }

    const policy = await this.activePolicy(player.id)
    const coverRate = policy ? Number(policy.coverRate) : 0
    const fullCost = missing * COST_PER_HP
    const paid = Math.round(fullCost * (1 - coverRate))

    const result = await this.db.$transaction(async (tx) => {
      const debited = await tx.player.updateMany({
        where: { id: player.id, balance: { gte: paid }, health: player.health },
        data: { balance: { decrement: paid }, health: maxHealth }
      })
      if (debited.count !== 1) {
        // یا موجودی کافی نیست، یا سلامت بین خواندن و نوشتن عوض شده.
        // خواندنِ خودِ موجودی (به‌جای count) به همان یک کوئری، شمارِ واقعی
        // را هم می‌دهد تا پیام خطا فقط «کافی نیست» نگوید.
        const fresh = await tx.player.findUnique({
          where: { id: player.id },
          select: { balance: true }
        })
        const balanceNow = Number(fresh?.balance ?? 0)
        if (balanceNow < paid) {
          throw new ConflictError(
            'Insufficient balance',
            insufficientFunds(
              paid,
              balanceNow,
              'درمان کامل',
              'می‌توانی در خانه استراحت کنی (رایگان ولی کندتر) یا فقط بخشی از سلامتت را بازیابی کنی.'
            )
          )
        }
        throw new ConflictError(
          'Health changed',
          'وضعیت سلامتت همین حالا تغییر کرد؛ دوباره تلاش کن.'
        )
      }

      await tx.financialTransaction.create({
        data: {
          amount: paid,
          type: TransactionType.MEDICAL_EXPENSE,
          sourcePlayerId: player.id,
          reference: policy
            ? `درمان در درمانگاه (با پوشش بیمه ${Math.round(coverRate * 100)}٪)`
            : 'درمان در درمانگاه'
        }
      })

      return { healedAmount: missing, paid, saved: fullCost - paid, newHealth: maxHealth }
    })

    await this.eventService
      .recordPlayerEvent({
        playerId: player.id,
        type: GameEventType.MEDICAL_TREATMENT,
        title: `درمان ${missing.toLocaleString('fa-IR')} واحد سلامت`,
        amount: paid
      })
      .catch(() => undefined)

    return result
  }

  /**
   * درمان اضطراری: به‌اندازهٔ موجودی.
   *
   * چرا لازم است؟ «همه یا هیچ» یعنی بازیکنی که پولش به درمان کامل نمی‌رسد
   * هیچ راهی برای برگرداندن سلامت ندارد. این تابع آن دریچهٔ بسته را باز
   * می‌کند: هر تومانی که داری به واحد سلامت تبدیل می‌شود. عمداً گران‌تر از
   * درمان کامل نیست — همان نرخ واحد است — ولی بازیکن را به‌سمت
   * «درمانِ ناقص و بازگشت به کار» می‌برد، نه مرگِ اجباری.
   *
   * اگر حتی یک واحد هم در توان نباشد، خطای روشن می‌دهد (نه سکوت، نه کسر صفر).
   */
  async treatEmergency(telegramUserId: bigint): Promise<TreatmentResult> {
    const player = await this.db.player.findUnique({
      where: { telegramUserId },
      select: { id: true, health: true, balance: true }
    })
    if (!player) {
      throw new NotFoundError('Player not found')
    }

    const maxHealth = await this.resolveMaxHealth(player.id)
    const missing = Math.max(0, maxHealth - player.health)
    if (missing === 0) {
      throw new ConflictError('Already healthy', 'سلامت تو در بهترین حالت است و نیازی به درمان نداری.')
    }

    const policy = await this.activePolicy(player.id)
    const coverRate = policy ? Number(policy.coverRate) : 0
    const unitCost = COST_PER_HP * (1 - coverRate)
    const balance = Math.max(0, Number(player.balance ?? 0))
    const units = Math.min(missing, Math.floor(balance / unitCost))
    if (units <= 0) {
      throw new ConflictError(
        'Insufficient balance',
        'موجودی‌ات حتی برای یک واحد درمان هم کافی نیست. اول با کار کردن درآمد بساز (اگر سلامتت اجازه دهد) یا در خانه استراحت کن.'
      )
    }

    const paid = Math.round(units * unitCost)
    const newHealth = player.health + units

    const result = await this.db.$transaction(async (tx) => {
      // نوشتار شرطی روی «سلامت و موجودیِ خوانده‌شده»: اگر بین خواندن و نوشتن
      // مسیر دیگری سلامت یا پول را عوض کند، این تراکنش صفر ردیف می‌زند و
      // درمان روی وضعیتِ تازه اعمال نمی‌شود.
      const debited = await tx.player.updateMany({
        where: { id: player.id, balance: { gte: paid }, health: player.health },
        data: { balance: { decrement: paid }, health: newHealth }
      })
      if (debited.count !== 1) {
        throw new ConflictError(
          'State changed',
          'وضعیت سلامتت همین حالا تغییر کرد؛ دوباره تلاش کن.'
        )
      }

      await tx.financialTransaction.create({
        data: {
          amount: paid,
          type: TransactionType.MEDICAL_EXPENSE,
          sourcePlayerId: player.id,
          reference: policy
            ? `درمان اضطراری (با پوشش بیمه ${Math.round(coverRate * 100)}٪)`
            : 'درمان اضطراری در درمانگاه'
        }
      })

      return {
        healedAmount: units,
        paid,
        // «صرفه‌جویی بیمه» فقط همان اختلاف نرخ است؛ نه کلِ هزینهٔ درمان کامل.
        saved: Math.max(0, Math.round(units * COST_PER_HP) - paid),
        newHealth
      }
    })

    await this.eventService
      .recordPlayerEvent({
        playerId: player.id,
        type: GameEventType.MEDICAL_TREATMENT,
        title: `درمان اضطراری ${units.toLocaleString('fa-IR')} واحد سلامت`,
        amount: paid
      })
      .catch(() => undefined)

    return result
  }

  /** خرید بیمهٔ هفتگی؛ اگر بیمهٔ فعال باشد، مدت آن تمدید می‌شود. */
  async buyInsurance(
    telegramUserId: bigint
  ): Promise<{ coversUntil: Date; extended: boolean; premium: number }> {
    const player = await this.db.player.findUnique({
      where: { telegramUserId },
      select: { id: true, balance: true }
    })
    if (!player) {
      throw new NotFoundError('Player not found')
    }

    const result = await this.db.$transaction(async (tx) => {
      // کسر شرطی، نقطهٔ صف‌شدن است: خریدِ همزمانِ دوم روی همین ردیفِ
      // بازیکن تا پایان این تراکنش منتظر می‌ماند، سپس بیمهٔ *تازهٔ*
      // (مشارکت‌شدهٔ) تراکنشِ اول را می‌بیند و از انتهایش تمدید می‌کند —
      // دقیقاً همان الگویی که عضویت باشگاه اجرا می‌کند. اگر مبدأِ تمدید
      // پیش از تراکنش خوانده شود، دو خریدِ همزمان هر دو از «الان» می‌شمارند
      // و ۲ میلیون می‌گیرند ولی ۷ روز تحویل می‌دهند.
      const debited = await tx.player.updateMany({
        where: { id: player.id, balance: { gte: INSURANCE_PREMIUM } },
        data: { balance: { decrement: INSURANCE_PREMIUM } }
      })
      if (debited.count !== 1) {
        throw new ConflictError(
          'Insufficient balance',
          insufficientFunds(
            INSURANCE_PREMIUM,
            Number(player.balance),
            'بیمهٔ درمان',
            'بیمه اختیاری است؛ می‌توانی بعداً که درآمد ثابت داشتی بخری.'
          )
        )
      }

      const existing = await tx.insurancePolicy.findFirst({
        where: { playerId: player.id, coversUntil: { gt: new Date() } },
        orderBy: { coversUntil: 'desc' },
        select: { coversUntil: true }
      })
      const base = existing ? existing.coversUntil.getTime() : Date.now()
      const coversUntil = new Date(base + gameDays(INSURANCE_DAYS))

      await tx.insurancePolicy.create({
        data: {
          playerId: player.id,
          premium: INSURANCE_PREMIUM,
          coverRate: INSURANCE_COVER_RATE,
          coversUntil
        }
      })

      await tx.financialTransaction.create({
        data: {
          amount: INSURANCE_PREMIUM,
          type: TransactionType.INSURANCE_PREMIUM,
          sourcePlayerId: player.id,
          reference: existing ? 'تمدید بیمهٔ درمان' : 'خرید بیمهٔ درمان'
        }
      })

      return { coversUntil, extended: Boolean(existing) }
    })

    return { ...result, premium: INSURANCE_PREMIUM }
  }

  /**
   * هشدار سلامت پایین.
   *
   * روزی یک بار و فقط زمانی که سلامت زیر آستانه است؛ کلید یکتای روزانه از
   * تکرار جلوگیری می‌کند. خطا هرگز مسیر اصلی را نمی‌شکند.
   */
  async warnIfCritical(playerId: string, health: number): Promise<void> {
    if (health >= HEALTH_WARNING_THRESHOLD) {
      return
    }

    // هزینهٔ ذکرشده در هشدار باید تا سقف واقعی (عضو باشگاه = ۱۲۰) باشد
    const maxHealth = await this.resolveMaxHealth(playerId).catch(() => BASE_MAX_HEALTH)
    const missing = Math.max(0, maxHealth - health)
    await this.notificationService
      .notifyPlayerById(
        playerId,
        '❤️ سلامتت در وضعیت بحرانی است',
        `سلامت تو ${health.toLocaleString('fa-IR')} است. ` +
          `با کلمهٔ «درمانگاه» می‌توانی با ${(missing * COST_PER_HP).toLocaleString('fa-IR')} تومان ` +
          'کامل درمان شوی، یا در خانه استراحت کن.',
        NotificationType.WARNING,
        `health-warn:${playerId}:${dayIndex()}`,
        'IMPORTANT'
      )
      .catch(() => undefined)
  }
}

export const CLINIC_INFO = {
  costPerHp: COST_PER_HP,
  warningThreshold: HEALTH_WARNING_THRESHOLD,
  premium: INSURANCE_PREMIUM,
  insuranceDays: INSURANCE_DAYS,
  coverRatePercent: Math.round(INSURANCE_COVER_RATE * 100)
} as const
