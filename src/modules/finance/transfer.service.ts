import { NotificationType, PlayerStatus, Prisma, PrismaClient, TransactionType } from '@prisma/client'
import { CASH_TRANSFER } from '../../config/economy'
import { BANK_TRANSFER_EXAMPLE, TRANSFER_EXAMPLE } from '../../utils/commands'
import { ConflictError, NotFoundError, ValidationError } from '../../utils/classes/errors'
import { NotificationService } from '../notification/notification.service'
import { PlayerRepository } from '../../database/repositories/player.repository'
import { logger } from '../../utils/logger'

/**
 * انتقال پول بین بازیکنان.
 *
 * مدل پول (صریح، چون «پول از هیچ‌جا ساخته نمی‌شود»):
 *  • منبع، **کیف پول** بازیکن است (`players.balance`) — همان پولی که در
 *    «شناسنامه» می‌بیند. حساب بانکی یک حسابِ جداست؛ انتقال از بانک یعنی
 *    اول «برداشت بانکی» و بعد انتقال. این مرز در پیام‌ها هم گفته می‌شود.
 *  • انتقال صفر-جمع است: هر تومان از کیف پول فرستنده کم و به کیف پول
 *    گیرنده اضافه می‌شود. هیچ ضریب، کارمزد یا خلق پولی در کار نیست.
 *  • یک ردیف `FinancialTransaction` با هر دو طرفِ بازیکن نوشته می‌شود تا
 *    در «دفتر مالی» هر دو بازیکن و در ممیزیِ عرضهٔ پول (نوع TRANSFER) دیده شود.
 *
 * اتمیک‌بودن و ضدتکرار:
 *  • کسرِ فرستنده با `updateMany` **شرطی** (`balance >= amount`) انجام می‌شود؛
 *    اگر ردیفی به‌روز نشد، یعنی پول کافی نیست و کل تراکنش برمی‌گردد.
 *  • تکرارِ دوباره از لایهٔ تأیید (`consumeConfirmation` با compare-and-delete)
 *    جلوگیری می‌شود؛ خودِ سرویس هم بی‌حالت است و هیچ پولی را «به خاطر» نمی‌سپارد.
 */
export const MIN_TRANSFER_AMOUNT = CASH_TRANSFER.minAmount
/**
 * سقفِ انتقالِ نقدی (جیب به جیب).
 *
 * از `config/economy` می‌آید چون سقفِ انتقالِ *بانکی* هم آن‌جاست: دو مسیرِ پول
 * باید کنارِ هم خوانده شوند، وگرنه روزی یکی سقفِ دیگری را دور می‌زند. مبلغهای
 * بزرگ از بانک می‌گذرند: آن‌جا سقفِ روزانه، مالیات و ممیزی هست.
 */
export const MAX_TRANSFER_AMOUNT = CASH_TRANSFER.maxAmount

export interface TransferPreview {
  senderName: string
  receiverName: string
  receiverId: string
  amount: number
  senderWallet: number
  /** آیا کیف پول فرستنده این مبلغ را دارد؟ */
  affordable: boolean
}

export interface TransferResult {
  amount: number
  receiverName: string
  receiverBalance: number
  senderBalance: number
  /** آیا پیام خصوصی به گیرنده واقعاً رسید؟ (بلاک‌بودن ربات → false) */
  receiverNotified: boolean
}

export class TransferService {
  constructor(
    private readonly db: PrismaClient,
    private readonly playerRepository: PlayerRepository,
    private readonly notificationService: NotificationService
  ) {}

  /** نام نمایشی بازیکن؛ نام‌خانوادگی اختیاری است. */
  private displayName(player: { firstName: string; lastName: string | null }): string {
    return `${player.firstName} ${player.lastName ?? ''}`.trim()
  }

  /**
   * پیش‌نمایشِ انتقال — همان داده‌هایی که صفحهٔ تأیید نشان می‌دهد.
   * هیچ نوشتاری ندارد.
   */
  async preview(
    senderTelegramUserId: bigint,
    receiverTelegramUserId: bigint,
    amount: number
  ): Promise<TransferPreview> {
    const { sender, receiver } = await this.resolveParties(
      senderTelegramUserId,
      receiverTelegramUserId
    )
    this.assertAmount(amount)

    return {
      senderName: this.displayName(sender),
      receiverName: this.displayName(receiver),
      receiverId: receiver.id,
      amount,
      senderWallet: Number(sender.balance),
      affordable: Number(sender.balance) >= amount
    }
  }

  /**
   * اجرای انتقال. تنها راهِ جابه‌جاییِ پول بین دو بازیکن.
   */
  async execute(
    senderTelegramUserId: bigint,
    receiverTelegramUserId: bigint,
    amount: number
  ): Promise<TransferResult> {
    const { sender, receiver } = await this.resolveParties(
      senderTelegramUserId,
      receiverTelegramUserId
    )
    this.assertAmount(amount)

    const senderName = this.displayName(sender)
    const receiverName = this.displayName(receiver)

    await this.db.$transaction(async (tx) => {
      // ۱) کسر شرطی از کیف پول فرستنده؛ اگر ردیفی به‌روز نشد پول کافی نبوده.
      const debited = await tx.player.updateMany({
        where: { id: sender.id, balance: { gte: amount } },
        data: { balance: { decrement: amount } }
      })
      if (debited.count !== 1) {
        throw new ConflictError(
          'Insufficient wallet balance',
          `کیف پولت این مبلغ را ندارد. انتقال از کیف پول انجام می‌شود؛ اگر پولت در بانک است اول برداشت کن.`
        )
      }

      // ۲) واریز به گیرنده — همان ردیفی که در مرحلهٔ قبل اعتبارسنجی شد.
      const credited = await tx.player.updateMany({
        where: { id: receiver.id, status: PlayerStatus.ACTIVE },
        data: { balance: { increment: amount } }
      })
      if (credited.count !== 1) {
        // پرتاب (نه return) تا تراکنش برگردد و پولِ فرستنده نسوزد
        throw new ConflictError(
          'Receiver unavailable',
          'حساب گیرنده دیگر فعال نیست؛ پولی جابه‌جا نشد.'
        )
      }

      // ۳) ردیف دفتر کل با هر دو طرف بازیکن → نوع TRANSFER در ممیزی عرضهٔ پول
      await tx.financialTransaction.create({
        data: {
          amount,
          type: TransactionType.TRANSFER,
          sourcePlayerId: sender.id,
          destinationPlayerId: receiver.id,
          reference: `انتقال به ${receiverName}`
        }
      })
    })

    const [freshSender, freshReceiver] = await Promise.all([
      this.db.player.findUniqueOrThrow({ where: { id: sender.id }, select: { balance: true } }),
      this.db.player.findUniqueOrThrow({ where: { id: receiver.id }, select: { balance: true } })
    ])
    const senderBalance = Number(freshSender.balance)
    const receiverBalance = Number(freshReceiver.balance)

    // اعلان‌ها پس از تراکنش: پول که قطعی شد خبر می‌رود، نه وسط تراکنش.
    const receiverNotified = await this.notificationService
      .announce({
        playerId: receiver.id,
        type: NotificationType.EVENT,
        level: 'CRITICAL',
        title: 'پول دریافت کردی',
        message: [
          `مبلغ: ${amount.toLocaleString('fa-IR')} تومان`,
          `فرستنده: ${senderName}`,
          `موجودی تازهٔ کیف پول: ${receiverBalance.toLocaleString('fa-IR')} تومان`
        ].join('\n'),
        dedupeKey: undefined
      })
      .catch((error: unknown) => {
        logger.warn({ err: error }, 'transfer notification to receiver failed')
        return false
      })

    await this.notificationService
      .announce({
        playerId: sender.id,
        type: NotificationType.EVENT,
        level: 'IMPORTANT',
        title: 'پول فرستادی',
        message: [
          `مبلغ: ${amount.toLocaleString('fa-IR')} تومان`,
          `گیرنده: ${receiverName}`,
          `موجودی تازهٔ کیف پول: ${senderBalance.toLocaleString('fa-IR')} تومان`
        ].join('\n')
      })
      .catch((error: unknown) => {
        logger.warn({ err: error }, 'transfer notification to sender failed')
        return false
      })

    return {
      amount,
      receiverName,
      receiverBalance,
      senderBalance,
      receiverNotified
    }
  }

  /** هر دو طرف باید بازیکنِ واقعی و فعال باشند؛ هیچ‌کدام نمی‌تواند خودش باشد. */
  private async resolveParties(senderTelegramUserId: bigint, receiverTelegramUserId: bigint) {
    if (senderTelegramUserId === receiverTelegramUserId) {
      throw new ValidationError('Cannot transfer to self', 'نمی‌توانی به خودت پول بدهی.')
    }

    const [sender, receiver] = await Promise.all([
      this.playerRepository.findByTelegramUserId(senderTelegramUserId),
      this.playerRepository.findByTelegramUserId(receiverTelegramUserId)
    ])

    if (!sender) {
      throw new NotFoundError('Sender not found', 'اول شخصیتت را در چت خصوصی ربات بساز.')
    }
    if (!receiver) {
      throw new NotFoundError(
        'Receiver not found',
        'این بازیکن هنوز شخصیت نساخته است؛ پولی به او نمی‌رسد.'
      )
    }
    if (sender.status === PlayerStatus.BANNED || sender.status === PlayerStatus.DEAD) {
      throw new ConflictError('Sender inactive', 'حساب تو فعال نیست و نمی‌توانی پول بفرستی.')
    }
    if (receiver.status === PlayerStatus.BANNED || receiver.status === PlayerStatus.DEAD) {
      throw new ConflictError(
        'Receiver inactive',
        'حساب این بازیکن فعال نیست؛ پولی به او نمی‌رسد.'
      )
    }

    return { sender, receiver }
  }

  /** مبلغ باید عددِ صحیحِ مثبت و در بازهٔ مجاز باشد. */
  private assertAmount(amount: number): void {
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw new ValidationError('Invalid amount', 'مبلغ باید یک عددِ کامل و بزرگ‌تر از صفر باشد.')
    }
    if (amount < MIN_TRANSFER_AMOUNT) {
      throw new ValidationError(
        'Amount too small',
        `کمترین مبلغِ انتقال ${MIN_TRANSFER_AMOUNT.toLocaleString('fa-IR')} تومان است.`
      )
    }
    if (amount > MAX_TRANSFER_AMOUNT) {
      throw new ValidationError(
        'Amount too large',
        [
          `انتقالِ نقدی تا ${MAX_TRANSFER_AMOUNT.toLocaleString('fa-IR')} تومان است.`,
          'برای مبلغهای بزرگ‌تر از «انتقالِ بانکی» استفاده کن: از حسابت کم می‌شود، سقفِ روزانه دارد و مالیاتش به منطقه می‌رسد.'
        ].join('\n')
      )
    }
  }
}

/** قالبِ قابل‌خواندنِ مبلغ برای راهنماها و پیام‌های خطا. */
export function transferLimitsText(): string {
  return `نقدی: ${MIN_TRANSFER_AMOUNT.toLocaleString('fa-IR')} تا ${MAX_TRANSFER_AMOUNT.toLocaleString('fa-IR')} تومان در هر تراکنش`
}

/**
 * «چطور پول بدهم» — تنها منبع حقیقت.
 * هم پنل بانک، هم صفحهٔ راهنمای بانک و هم پیام‌های خطا از همین‌جا می‌خوانند
 * تا سه نسخهٔ کمی متفاوت از یک توضیح ساخته نشود.
 */
export function transferHowToLines(): string[] {
  return [
    `نقدی (جیب به جیب): روی پیامِ بازیکن ریپلای کن و بنویس: ${TRANSFER_EXAMPLE}`,
    'مبلغ را کوتاه هم می‌شود نوشت: «انتقال ۸۰ هزار».',
    `بانکی (حساب به حساب): بنویس: ${BANK_TRANSFER_EXAMPLE}`,
    'نقدی از *کیف پول* می‌رود و سقفش کم است.',
    'بانکی از *حساب* می‌رود، سقفِ روزانه دارد و مالیات دارد.',
    'پیش از اجرا صفحهٔ تأیید می‌آید؛ تا تأیید نکنی پولی جابه‌جا نمی‌شود.'
  ]
}

/** نوعِ prisma برای payload تأیید؛ از `unknown` تایپ‌دار استفاده می‌شود. */
export type TransferPayload = Prisma.JsonObject & {
  receiverId: string
  amount: number
}
