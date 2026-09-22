import {
  Prisma,
  PrismaClient,
  PlayerStatus,
  TransactionType,
  NotificationType
} from '@prisma/client'
import { BANK_TRANSFER, bankTransferNetOf, bankTransferTaxOf } from '../../config/economy'
import { ConflictError, NotFoundError, ValidationError } from '../../utils/classes/errors'
import { gameDayStart } from '../../utils/game-time'
import { logger } from '../../utils/logger'
import { RegionFundService } from '../economy/tax.service'
import { NotificationService } from '../notification/notification.service'
import { PlayerRepository } from '../../database/repositories/player.repository'
import { BankingService } from './banking.service'

/**
 * انتقالِ بانکی — حساب به حساب، با سقفِ روزانهٔ جمعی و مالیات به صندوق منطقه.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  چرا سرویسِ جدا از انتقالِ نقدی؟
 * ─────────────────────────────────────────────────────────────────────────────
 *  دو مسیرِ پول در بازی دو *قرارداد* متفاوت دارند:
 *
 *    نقدی (جیب → جیب):  سقفِ کوچک در هر تراکنش، بدون مالیات، بدون سقفِ روزانه.
 *    بانکی (حساب → حساب): سقفِ بزرگ ولی **جمعیِ روزانه**، با مالیاتِ ۰٫۱٪.
 *
 *  اگر هر دو از یک تابع رد شوند، دیر یا زود یکی سقفِ دیگری را دور می‌زند (انتقالِ
 *  نقدیِ بزرگ، یا انتقالِ بانکیِ بدون مالیات). پس منبعِ پول هم متفاوت است —
 *  `Player.balance` در برابر `BankAccount.balance` — و هیچ انتزاعی روی هر دو
 *  ساخته نشده.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  دفتر کل: چرا دو ردیف؟
 * ─────────────────────────────────────────────────────────────────────────────
 *  فرستنده *ناخالص* می‌دهد، گیرنده *خالص* می‌گیرد و اختلاف به صندوق منطقه می‌رود.
 *  ممیزیِ اقتصاد (`reconcilePrivateSector`) داراییِ هر بازیکن را ریال به ریال با
 *  دفتر کل می‌سنجد، پس هر ردیف باید دقیقاً یک حرکتِ واقعی باشد:
 *
 *    BANK_TRANSFER  خالص   → فرستنده منفی، گیرنده مثبت
 *    TAX_PAYMENT    مالیات → فقط فرستنده منفی (صندوق منطقه طرفِ بازیکنی ندارد)
 *
 *  اگر به‌جای خالص، ناخالص در ردیفِ اول نوشته شود، حسابِ هر دو طرف به اندازهٔ
 *  مالیات واگرا می‌شود؛ و اگر مالیات هم مثل یک خروجِ جدا از ناخالص ثبت شود،
 *  خروجِ فرستنده دو بار شمرده می‌شود. پس جمعِ «خروجیِ امروز» هم از جمعِ همین
 *  دو ردیف می‌آید: `net + tax = gross`.
 */

export interface BankTransferPreview {
  senderName: string
  receiverName: string
  receiverId: string
  /** مبلغی که از حسابِ فرستنده کم می‌شود (همان عددی که بازیکن وارد می‌کند). */
  gross: number
  /** مالیاتِ ۰٫۱٪ — به صندوقِ منطقهٔ فرستنده می‌رود. */
  tax: number
  /** مبلغی که به حسابِ گیرنده می‌نشیند. */
  net: number
  senderBankBalance: number
  /** چقدر از سقفِ امروزِ فرستنده باقی مانده است. */
  remainingToday: number
  affordable: boolean
}

export interface BankTransferResult {
  gross: number
  tax: number
  net: number
  receiverName: string
  senderBankBalance: number
  receiverBankBalance: number
  /** صندوقِ منطقه‌ای که مالیات به آن رسید (`null` = بازیکن منطقه ندارد). */
  taxToRegion: string | null
  /** سقفِ باقی‌ماندهٔ امروزِ فرستنده پس از همین انتقال. */
  remainingToday: number
  receiverNotified: boolean
}

/** سقفِ امروز چه وضعی دارد — برای پیش‌نمایش و برای پیامِ خطا. */
export interface DailyUsage {
  /** مجموعِ ناخالصِ انتقال‌های بانکیِ خروجیِ امروز. */
  spent: number
  remaining: number
  limit: number
}

/** مالیات به منطقهٔ سکونت می‌رود — همان قاعدهٔ `TaxService.withholdIncomeTax`. */
const TAX_REGION_SELECT = { homeGroupId: true, currentRegionId: true } as const

export class BankTransferService {
  constructor(
    private readonly db: PrismaClient,
    private readonly playerRepository: PlayerRepository,
    private readonly notificationService: NotificationService,
    /** حسابِ گیرنده از همین‌جا ساخته/خوانده می‌شود تا منطقِ شمارهٔ کارت تکرار نشود. */
    private readonly bankingService: BankingService,
    private readonly regionFund: RegionFundService = new RegionFundService()
  ) {}

  private displayName(player: { firstName: string; lastName: string | null }): string {
    return `${player.firstName} ${player.lastName ?? ''}`.trim()
  }

  /**
   * مجموعِ خروجیِ بانکیِ امروزِ یک بازیکن (روزِ بازی، نه روزِ تقویمی).
   *
   * چرا از دفتر کل و نه یک ستونِ شمارنده؟ ستونِ شمارنده یعنی منبعِ دومِ حقیقت
   * که با هر تغییرِ مسیرِ پول واگرا می‌شود و در بازیابی از بکاپ خودش را
   * بازنمی‌سازد. دفتر کل خودش سندِ واقعی است و نمایهٔ
   * `(source_player_id, type, created_at)` همین جمع را ارزان می‌کند.
   */
  async dailyUsage(senderPlayerId: string, now: number = Date.now()): Promise<DailyUsage> {
    const since = gameDayStart(now)
    const [moved, taxed] = await Promise.all([
      this.sumToday(this.db, senderPlayerId, since, TransactionType.BANK_TRANSFER),
      this.sumToday(this.db, senderPlayerId, since, TransactionType.TAX_PAYMENT, true)
    ])
    const spent = moved + taxed
    const limit = BANK_TRANSFER.dailyOutgoingLimit
    return { spent, remaining: Math.max(0, limit - spent), limit }
  }

  /** جمعِ یک نوع ردیف در بازهٔ امروز برای یک فرستنده. */
  private async sumToday(
    db: PrismaClient | Prisma.TransactionClient,
    senderPlayerId: string,
    since: Date,
    type: TransactionType,
    transferTaxOnly = false
  ): Promise<number> {
    const aggregate = await db.financialTransaction.aggregate({
      where: {
        sourcePlayerId: senderPlayerId,
        type,
        createdAt: { gte: since },
        ...(transferTaxOnly
          ? { reference: { startsWith: BANK_TRANSFER.taxReference } }
          : {})
      },
      _sum: { amount: true }
    })
    return Math.max(0, Math.round(Number(aggregate._sum.amount ?? 0)))
  }

  private assertAmount(amount: number): void {
    if (!Number.isFinite(amount) || !Number.isInteger(amount)) {
      throw new ValidationError('Invalid amount', 'مبلغِ انتقال باید عددِ درست باشد.')
    }
    if (amount < BANK_TRANSFER.minAmount) {
      throw new ValidationError(
        'Amount below minimum',
        `کمترین مبلغِ انتقالِ بانکی ${BANK_TRANSFER.minAmount.toLocaleString('fa-IR')} تومان است.`
      )
    }
  }

  /** پیش‌نمایشِ انتقال — همان چیزی که صفحهٔ تأیید نشان می‌دهد. بدونِ نوشتن. */
  async preview(
    senderTelegramUserId: bigint,
    receiverTelegramUserId: bigint,
    amount: number
  ): Promise<BankTransferPreview> {
    const { sender, receiver } = await this.resolveParties(
      senderTelegramUserId,
      receiverTelegramUserId
    )
    this.assertAmount(amount)

    const [account, usage] = await Promise.all([
      this.db.bankAccount.findUnique({ where: { playerId: sender.id }, select: { balance: true } }),
      this.dailyUsage(sender.id)
    ])
    const senderBankBalance = Math.max(0, Math.round(Number(account?.balance ?? 0)))
    const gross = Math.round(amount)

    return {
      senderName: this.displayName(sender),
      receiverName: this.displayName(receiver),
      receiverId: receiver.id,
      gross,
      tax: bankTransferTaxOf(gross),
      net: bankTransferNetOf(gross),
      senderBankBalance,
      remainingToday: usage.remaining,
      affordable: senderBankBalance >= gross
    }
  }

  /**
   * اجرای انتقالِ بانکی.
   *
   * همه‌چیز در یک تراکنشِ Serializable: خواندنِ جمعِ امروز و کسرِ شرطی باید
   * کنارِ هم اتمیک باشند، وگرنه دو درخواستِ هم‌زمانِ یک بازیکن هر دو سقفِ
   * باقی‌ماندهٔ یکسان را می‌بینند و از سقف رد می‌شوند. در سطحِ Serializable
   * پستگرس یکی را برمی‌گرداند و ما همان را به «دوباره تلاش کن» ترجمه می‌کنیم —
   * هرگز دو بار پول جابه‌جا نمی‌شود.
   */
  async execute(
    senderTelegramUserId: bigint,
    receiverTelegramUserId: bigint,
    amount: number
  ): Promise<BankTransferResult> {
    const { sender, receiver } = await this.resolveParties(
      senderTelegramUserId,
      receiverTelegramUserId
    )
    this.assertAmount(amount)
    const gross = Math.round(amount)

    const senderName = this.displayName(sender)
    const receiverName = this.displayName(receiver)

    const senderAccount = await this.db.bankAccount.findUnique({
      where: { playerId: sender.id },
      select: { id: true }
    })
    if (!senderAccount) {
      throw new ConflictError(
        'Sender has no bank account',
        'اول باید حسابِ بانکی باز کنی؛ انتقالِ بانکی از حساب انجام می‌شود.'
      )
    }
    // حسابِ گیرنده لازم است تا پول جایی برای نشستن داشته باشد؛ اگر ندارد،
    // همین حالا ساخته می‌شود (همان قاعدهٔ شمارهٔ کارت، بدون تکرارِ کد).
    const receiverAccountId = (await this.bankingService.getOrCreateAccount(receiverTelegramUserId))
      .id

    const tax = bankTransferTaxOf(gross)
    const net = bankTransferNetOf(gross)

    let taxToRegion: string | null = null
    await this.db.$transaction(
      async (tx) => {
        // ۱) سقفِ روزانهٔ جمعی — داخل همان تراکنش خوانده می‌شود.
        const movedToday = await this.sumToday(
          tx,
          sender.id,
          gameDayStart(),
          TransactionType.BANK_TRANSFER
        )
        const taxToday = await this.sumToday(
          tx,
          sender.id,
          gameDayStart(),
          TransactionType.TAX_PAYMENT,
          true
        )
        const usedToday = movedToday + taxToday
        if (usedToday + gross > BANK_TRANSFER.dailyOutgoingLimit) {
          const remaining = Math.max(0, BANK_TRANSFER.dailyOutgoingLimit - usedToday)
          throw new ConflictError(
            'Daily bank transfer limit exceeded',
            [
              'سقفِ انتقالِ بانکیِ امروزت پر شده است.',
              `امروز فرستادی: ${usedToday.toLocaleString('fa-IR')} تومان`,
              `باقی‌مانده: ${remaining.toLocaleString('fa-IR')} تومان`,
              'فردا (روزِ بازیِ تازه) سقف بازنشانی می‌شود.'
            ].join('\n')
          )
        }

        // ۲) کسرِ شرطی از حسابِ فرستنده — تنها جای برداشت.
        const debited = await tx.bankAccount.updateMany({
          where: { id: senderAccount.id, balance: { gte: new Prisma.Decimal(gross) } },
          data: { balance: { decrement: new Prisma.Decimal(gross) } }
        })
        if (debited.count !== 1) {
          throw new ConflictError(
            'Insufficient bank balance',
            'موجودیِ حسابت این مبلغ را ندارد. انتقالِ بانکی از حساب انجام می‌شود، نه از جیب.'
          )
        }

        // ۳) واریزِ خالص به حسابِ گیرنده.
        await tx.bankAccount.update({
          where: { id: receiverAccountId },
          data: { balance: { increment: new Prisma.Decimal(net) } }
        })

        // ۴) دفتر کل — هر ردیف یک حرکتِ واقعی (پایینِ همین فایل توضیح داده شده).
        await tx.financialTransaction.create({
          data: {
            amount: new Prisma.Decimal(net),
            type: TransactionType.BANK_TRANSFER,
            sourcePlayerId: sender.id,
            destinationPlayerId: receiver.id,
            reference: `انتقال بانکی به ${receiverName}`
          }
        })
        if (tax > 0) {
          await tx.financialTransaction.create({
            data: {
              amount: new Prisma.Decimal(tax),
              type: TransactionType.TAX_PAYMENT,
              sourcePlayerId: sender.id,
              reference: `${BANK_TRANSFER.taxReference} — به ${receiverName}`
            }
          })
        }

        // ۵) مالیات به صندوقِ منطقهٔ *فرستنده* می‌رود (همان قاعدهٔ مالیاتِ درآمد).
        if (tax > 0) {
          const home = await tx.player.findUnique({
            where: { id: sender.id },
            select: TAX_REGION_SELECT
          })
          const groupId = home?.homeGroupId ?? home?.currentRegionId ?? null
          if (groupId) {
            await this.regionFund.credit(tx, groupId, tax)
            taxToRegion = groupId
          }
        }
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    )

    const [freshSender, freshReceiver] = await Promise.all([
      this.db.bankAccount.findUniqueOrThrow({
        where: { id: senderAccount.id },
        select: { balance: true }
      }),
      this.db.bankAccount.findUniqueOrThrow({
        where: { id: receiverAccountId },
        select: { balance: true }
      })
    ])
    const senderBankBalance = Math.round(Number(freshSender.balance))
    const receiverBankBalance = Math.round(Number(freshReceiver.balance))

    // اعلان‌ها بیرون از تراکنش: پول که قطعی شد خبر می‌رود.
    const receiverNotified = await this.notificationService
      .announce({
        playerId: receiver.id,
        type: NotificationType.EVENT,
        level: 'CRITICAL',
        title: 'انتقالِ بانکی دریافت کردی',
        message: [
          `مبلغ: ${net.toLocaleString('fa-IR')} تومان`,
          `فرستنده: ${senderName}`,
          `موجودیِ حساب: ${receiverBankBalance.toLocaleString('fa-IR')} تومان`
        ].join('\n')
      })
      .catch((error: unknown) => {
        logger.warn({ err: error }, 'bank transfer notification to receiver failed')
        return false
      })

    await this.notificationService
      .announce({
        playerId: sender.id,
        type: NotificationType.EVENT,
        level: 'IMPORTANT',
        title: 'انتقالِ بانکی انجام شد',
        message: [
          `گیرنده: ${receiverName}`,
          `کسرشده از حسابت: ${gross.toLocaleString('fa-IR')} تومان`,
          `مالیات انتقال: ${tax.toLocaleString('fa-IR')} تومان`,
          `موجودیِ حساب: ${senderBankBalance.toLocaleString('fa-IR')} تومان`,
          taxToRegion ? '💡 مالیات به صندوق منطقه رسید.' : ''
        ]
          .filter((line) => line !== '')
          .join('\n')
      })
      .catch((error: unknown) => {
        logger.warn({ err: error }, 'bank transfer notification to sender failed')
        return false
      })

    // سقفِ باقی‌مانده پس از انتقال، از همان منبعی که پیش از آن سنجیده شد: دفتر کل.
    const { remaining } = await this.dailyUsage(sender.id)

    return {
      gross,
      tax,
      net,
      receiverName,
      senderBankBalance,
      receiverBankBalance,
      taxToRegion,
      remainingToday: remaining,
      receiverNotified
    }
  }

  /** هر دو طرف باید بازیکنِ واقعی و فعال باشند؛ هیچ‌کدام نمی‌تواند خودش باشد. */
  private async resolveParties(senderTelegramUserId: bigint, receiverTelegramUserId: bigint) {
    if (senderTelegramUserId === receiverTelegramUserId) {
      throw new ValidationError('Cannot transfer to self', 'نمی‌توانی به خودت انتقال بدهی.')
    }

    const [sender, receiver] = await Promise.all([
      this.playerRepository.findByTelegramUserId(senderTelegramUserId),
      this.playerRepository.findByTelegramUserId(receiverTelegramUserId)
    ])

    if (!sender || sender.status !== PlayerStatus.ACTIVE) {
      throw new NotFoundError('Sender not found or inactive')
    }
    if (!receiver || receiver.status !== PlayerStatus.ACTIVE) {
      throw new NotFoundError('Receiver not found or inactive')
    }

    return { sender, receiver }
  }
}

/** متنِ سقف‌ها برای راهنما و صفحهٔ تأیید — از همان تنظیمات، نه عددِ دستی. */
export function bankTransferLimitsText(): string {
  const limit = BANK_TRANSFER.dailyOutgoingLimit.toLocaleString('fa-IR')
  return `انتقالِ بانکی: سقفِ ${limit} تومان در هر روزِ بازی، مالیاتِ ۰٫۱٪`
}
