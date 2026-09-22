import { Prisma, PrismaClient, TransactionType } from '@prisma/client'
import { ConflictError, NotFoundError } from '../../utils/classes/errors'
import { cycleAmount, dayIndex, stableHash } from '../../utils/game-time'

type FortuneKind = 'neutral' | 'gain' | 'loss' | 'jackpot'

interface FortuneOutcome {
  kind: FortuneKind
  amount: number
  message: string
}

/** پیام‌های بدون اثر مالی؛ طعم روایت بدون دست‌کاری اقتصاد. */
const NEUTRAL_MESSAGES: readonly string[] = [
  'امروز روز خوبی برای مذاکره است؛ با آدم‌ها حرف بزن.',
  'ستاره‌ها می‌گویند صبر امروز بهتر از عجله است.',
  'هوای امروز برای کار کردن عالی است.',
  'امروز حواست به خرج‌های کوچک باشد.',
  'یک تصمیم درست امروز، هفتهٔ آینده‌ات را می‌سازد.',
  'امروز وقت خوبی برای سر زدن به حساب بانکی‌ات است.',
  'شاید امروز کسی به کمکت نیاز داشته باشد.',
  'برنامه‌ریزی امروز از تلاش فردا ارزشمندتر است.'
]

const GAIN_MESSAGES: readonly string[] = [
  'پولی که فکر می‌کردی گم شده، پیدا شد!',
  'یک بدهی قدیمی به تو پرداخت شد.',
  'در جیب کتت اسکناسی پیدا کردی!',
  'یک آشنا قرض قدیمی‌اش را برگرداند.'
]

const LOSS_MESSAGES: readonly string[] = [
  'یک هزینهٔ کوچک غیرمنتظره پیش آمد.',
  'مقداری پول از جیبت افتاد.',
  'قبض کوچکی را باید پرداخت می‌کردی.',
  'برای تعمیر یک وسیله هزینه دادی.'
]

const JACKPOT_MESSAGE = 'روز شگفت‌انگیزی است! جایزهٔ بزرگ امروز نصیب تو شد! 🎉'

/**
 * مبلغ‌های شانس روزانه — روی «روز بازی» هم‌تراز شده‌اند.
 *
 * روز بازی ۴۸ دقیقهٔ واقعی است (نه ۲۴ ساعت)، پس اگر مبلغ ثابت می‌ماند،
 * بازیکن ۳۰ برابر بیشتر شانس می‌کشید و اقتصاد تورم می‌گرفت.
 */
const JACKPOT_AMOUNT = cycleAmount(250_000)

/**
 * شانس روزانه.
 *
 * طراحی:
 *  • نتیجه قطعی است (hash از شناسه + شمارهٔ روز)، پس بستن و باز کردن پنل یا
 *    عوض کردن دستگاه نتیجه را تغییر نمی‌دهد و farm ممکن نیست.
 *  • ضرر همیشه با گارد `balance >= amount` و داخلِ همان تراکنشی اعمال می‌شود که
 *    نتیجه را ذخیره می‌کند؛ موجودی هرگز منفی نمی‌شود و اگر پول کافی نباشد، ضرر
 *    به پیامِ بی‌اثر تبدیل می‌گردد (نه پیامی که پولی پشتش نیست).
 *  • Unique روی (بازیکن، روز) تضمین می‌کند هر روز فقط یک بار؛ ادعا آخرین نوشتارِ
 *    تراکنش است تا کشیدنِ تکراری حتی یک ریال هم جابه‌جا نکند.
 *  • ارقام کوچک‌اند تا این سیستم هرگز جایگزین کار کردن نشود.
 */
export class FortuneService {
  constructor(private readonly db: PrismaClient) {}

  /** نتیجهٔ قطعی امروز برای این بازیکن. */
  private outcomeFor(playerId: string, day: number): FortuneOutcome {
    const roll = stableHash(`fortune:${playerId}:${day}`) % 100
    const variant = stableHash(`variant:${playerId}:${day}`)

    if (roll < 55) {
      return {
        kind: 'neutral',
        amount: 0,
        message: NEUTRAL_MESSAGES[variant % NEUTRAL_MESSAGES.length]!
      }
    }
    if (roll < 80) {
      const amount = FORTUNE_GAIN_RANGE.min + (variant % FORTUNE_GAIN_RANGE.variants) * FORTUNE_GAIN_RANGE.step
      return {
        kind: 'gain',
        amount,
        message: GAIN_MESSAGES[variant % GAIN_MESSAGES.length]!
      }
    }
    if (roll < 95) {
      const amount = FORTUNE_LOSS_RANGE.min + (variant % FORTUNE_LOSS_RANGE.variants) * FORTUNE_LOSS_RANGE.step
      return {
        kind: 'loss',
        amount,
        message: LOSS_MESSAGES[variant % LOSS_MESSAGES.length]!
      }
    }
    return { kind: 'jackpot', amount: JACKPOT_AMOUNT, message: JACKPOT_MESSAGE }
  }

  /** وضعیت امروز بدون کشیدن شانس (برای رندر پنل). */
  async getStatus(telegramUserId: bigint): Promise<{
    drawnToday: boolean
    kind: FortuneKind | null
    amount: number
    message: string | null
  }> {
    const player = await this.db.player.findUnique({
      where: { telegramUserId },
      select: { id: true }
    })
    if (!player) {
      throw new NotFoundError('Player not found')
    }

    const row = await this.db.dailyFortune.findUnique({
      where: { playerId_dayIndex: { playerId: player.id, dayIndex: dayIndex() } }
    })

    if (!row) {
      return { drawnToday: false, kind: null, amount: 0, message: null }
    }
    return {
      drawnToday: true,
      kind: row.kind as FortuneKind,
      amount: Number(row.amount),
      message: row.message
    }
  }

  /** کشیدن شانس امروز. */
  async draw(telegramUserId: bigint): Promise<FortuneOutcome> {
    const player = await this.db.player.findUnique({
      where: { telegramUserId },
      select: { id: true }
    })
    if (!player) {
      throw new NotFoundError('Player not found')
    }

    const day = dayIndex()
    const planned = this.outcomeFor(player.id, day)

    // ادعا و اثر مالی در یک تراکنش. ردیفِ «شانسِ امروز» *آخرین* نوشتار است:
    //  • اگر از پیش کشیده شده باشد (P2002)، پرتاب باعث برگشتِ کل تراکنش می‌شود،
    //    پس پولی هم جابه‌جا نمی‌ماند؛
    //  • اگر پرداخت بمیرد، ادعایی ثبت نمی‌ماند و بازیکن می‌تواند دوباره بکشد
    //    (پیش‌تر ردیفِ ادعا بیرون از تراکنش نوشته می‌شد و شانسِ روز برای همیشه
    //    می‌سوخت: نه پولی می‌رسید و نه کشیدنِ دوباره ممکن بود).
    return this.db.$transaction(async (tx) => {
      let outcome = planned

      if (planned.kind === 'loss') {
        // ضرر با گاردِ موجودی اعمال می‌شود: یا دقیقاً همان مقدار کسر می‌شود یا
        // نتیجه به «بی‌اثر» تبدیل می‌گردد تا آنچه ذخیره و نمایش داده می‌شود با
        // موجودیِ واقعی و دفترِ کل یکی بماند.
        const debited = await tx.player.updateMany({
          where: { id: player.id, balance: { gte: planned.amount } },
          data: { balance: { decrement: planned.amount } }
        })
        if (debited.count !== 1) {
          outcome = {
            kind: 'neutral',
            amount: 0,
            message: 'امروز شانس با تو مهربان بود؛ هزینهٔ پیش‌بینی‌نشده منتفی شد.'
          }
        } else {
          await tx.financialTransaction.create({
            data: {
              amount: planned.amount,
              type: TransactionType.FORTUNE_LOSS,
              sourcePlayerId: player.id,
              reference: 'هزینهٔ پیش‌بینی‌نشدهٔ روز'
            }
          })
        }
      } else if (planned.amount > 0) {
        await tx.player.update({
          where: { id: player.id },
          data: { balance: { increment: planned.amount } }
        })
        await tx.financialTransaction.create({
          data: {
            amount: planned.amount,
            type: TransactionType.REWARD_PAYOUT,
            destinationPlayerId: player.id,
            reference: 'شانس روزانه'
          }
        })
      }

      try {
        // Unique روی (بازیکن، روز): تنها ضامن یک‌بار کشیدن در روز
        await tx.dailyFortune.create({
          data: {
            playerId: player.id,
            dayIndex: day,
            kind: outcome.kind,
            amount: outcome.amount,
            message: outcome.message
          }
        })
      } catch (error) {
        // فقط نقضِ یکتایی یعنی «امروز کشیده‌ای». خطای واقعیِ دیتابیس باید بالا
        // برود تا تراکنش برگردد و بازیکن پیامِ درست ببیند.
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          throw new ConflictError(
            'Already drawn',
            'شانس امروزت را کشیده‌ای. فردا دوباره سر بزن! 🎲'
          )
        }
        throw error
      }

      return outcome
    })
  }
}

/**
 * بازهٔ مبلغ سود روزانه: کف + گام × (۰ تا variants-۱).
 * بیرون‌صادر شده تا آزمون توازنِ اقتصاد همان فرمول را بخواند، نه اینکه
 * عددها را دوباره بنویسد — همان کلاس خطایی که در راهنما رفع شد.
 */
export const FORTUNE_GAIN_RANGE = {
  min: cycleAmount(20_000),
  step: cycleAmount(5_000),
  variants: 13
} as const

/** بازهٔ مبلغ هزینهٔ روزانه — همان ساختار سود. */
export const FORTUNE_LOSS_RANGE = {
  min: cycleAmount(15_000),
  step: cycleAmount(5_000),
  variants: 10
} as const

export const FORTUNE_INFO = {
  neutralChance: 55,
  gainChance: 25,
  lossChance: 15,
  jackpotChance: 5,
  jackpotAmount: JACKPOT_AMOUNT,
  gainRange: FORTUNE_GAIN_RANGE,
  lossRange: FORTUNE_LOSS_RANGE
} as const
