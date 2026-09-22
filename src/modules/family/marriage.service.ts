import {
  GameEventType,
  Gender,
  MaritalStatus,
  MarriageEndReason,
  PlayerStatus,
  NotificationType,
  Prisma,
  PrismaClient,
  RelationshipStatus,
  RelationshipType,
  TransactionType
} from '@prisma/client'
import { ConflictError, NotFoundError, ValidationError } from '../../utils/classes/errors'
import type { NotificationLevel } from '../notification/push'
import { EventService } from '../events/event.service'
import { REAL_MS_PER_GAME_HOUR, cycleAmount, dayIndex, gameDaysSince, gameMonths } from '../../utils/game-time'
import {
  MAHR_RULES,
  isMahrSet,
  mahrRangeError,
  normalizeMahrOffer,
  validateMahrAmount
} from './mahr'
import { money } from '../../utils/format'
import {
  BONUS_WARMTH_GAIN,
  coupleBonusMultiplier,
  coupleBonusOf,
  gainWarmth,
  warmthLabel
} from './family-warmth'
import { readWarmth, warmthAnchorOf, writeWarmth } from './family-warmth.store'
import { settleWidowhoodForAll } from './widowhood'

export { MAHR_RULES, describeMahr, isMahrSet } from './mahr'

/** هزینهٔ ثبت طلاق که به شهر (Sink) پرداخت می‌شود. */
export const DIVORCE_COST = 5_000_000
/**
 * پاداش پایهٔ روزانهٔ زوجین.
 *
 * روزِ این پاداش، روز *بازی* است (۴۸ دقیقهٔ واقعی)، پس مبلغ با `cycleAmount`
 * هم‌تراز شده تا درآمد روزانهٔ زوجین در زمان واقعی ثابت بماند.
 */
export const COUPLE_DAILY_BONUS = cycleAmount(50_000)
/** باید در یک روز واقعی گذشته همسرت فعال بوده باشد تا بونوس تعلق بگیرد. */
export const SPOUSE_ACTIVE_MS = gameMonths(1)
/** عمر پیشنهاد ازدواج: یک ماه بازی (≈ ۲۴ ساعت واقعی) و پس از آن Lazy منقضی می‌شود. */
const PROPOSAL_TTL_MS = gameMonths(1)

/** وضعیت‌های پیشنهاد که هنوز «باز» شمار می‌شوند. */
const OPEN_STATUSES = ['PENDING', 'MAHR_SET'] as const
type OpenStatus = (typeof OPEN_STATUSES)[number]

export interface IncomingProposalView {
  id: string
  fromName: string
  /** مبلغ پیشنهادی مرد؛ ۰ یعنی «تعیین‌نشده». */
  offeredMahr: number
  status: OpenStatus
  createdAt: Date
  /** زن می‌تواند همین حالا قبول کند (پیشنهادِ مبلغ‌دار و وضعیت PENDING). */
  canAccept: boolean
  /** زن می‌تواند مهریه تعیین/تغییر دهد. */
  canSetMahr: boolean
}

export interface OutgoingProposalView {
  id: string
  targetName: string
  mahr: number
  status: OpenStatus
  createdAt: Date
  /** زن مهریه را تعیین کرده و منتظر تأیید مرد است. */
  awaitingMyAnswer: boolean
}

export interface MarriageView {
  genderIsMale: boolean
  hasSpouse: boolean
  spouseName: string | null
  marriedAt: Date | null
  mahr: number
  daysMarried: number
  /** پاداش امروز هم گرفته نشده و هم همسر فعال بوده؛ یعنی واقعاً قابل دریافت است. */
  bonusReady: boolean
  /** پاداش امروز مانده است ولی همسر اخیراً فعال نبوده؛ دکمه داده نمی‌شود. */
  bonusWaitingForSpouse: boolean
  bonusAmount: number
  /** گرمای فعلی رابطه (با فرسایش)؛ برای متأهل‌ها، وگرنه `null`. */
  warmth: number | null
  warmthLabelText: string | null
  /** ضریب فعلی پاداش روزانه بر اساس گرما. */
  bonusMultiplier: number | null
  /** آیا امروز «وقت مشترک» انجام شده؟ برای وضعیت دکمه. */
  activityDoneToday: boolean
  /** همسرِ بازیکن فوت کرده و آن ازدواج بسته شده است (وضعیتِ بازمانده: WIDOWED). */
  isWidowed: boolean
  incomingProposals: IncomingProposalView[]
  outgoingProposals: OutgoingProposalView[]
}

/**
 * ازدواج بین بازیکنان — جریان اجتماعی-اقتصادیِ دو مرحله‌ای.
 *
 * چرخه (بر پایهٔ رویهٔ رایج خواستگاری در ایران):
 *  ۱. مرد پیشنهاد می‌دهد (با یا بدون مبلغ پیشنهادی) ← PENDING
 *  ۲. زن یا قبول می‌کند، یا مهریه را تعیین/تغییر می‌دهد ← MAHR_SET،
 *     یا رد می‌کند.
 *  ۳. مرد در برابر مهریهٔ تعیین‌شده: تأیید عقد یا انصراف.
 *  • پیشنهاد بازِ پاسخ‌نداده پس از ۷۲ ساعت Lazy منقضی می‌شود.
 *
 * منطق مالی:
 *  • مهریه در لحظهٔ عقد از حساب مرد کسر و به‌حساب زن واریز می‌شود
 *    (انتقال است، نه Sink — مالِ زن است).
 *  • طلاق فقط هزینهٔ ثبت دارد؛ مهریهٔ پرداخت‌شده پس‌گرفته نمی‌شود.
 *    پس چرخهٔ عقد/طلاق زیانِ هزینهٔ ثبت دارد، بدون قاپیدن مهریه.
 *  • سقف مهریه (MAHR_RULES.max) فقط محافظ سرریزِ محاسبات است، نه محدودیت بازی؛
 *    تنها شرط واقعی، توان پرداخت مرد در لحظهٔ عقد است.
 *
 * safety:
 *  • عقد فقط در یک تراکنش با نوشتارهای شرطی ثبت می‌شود: قفل وضعیت پیشنهاد،
 *    «مجرد بودن هر دو طرف» و «موجودی کافی مرد» — پس نه چندزنیِ همزمان،
 *    نه دو پاسخِ همزمان، نه کسر بدون واریز.
 */
export class MarriageService {
  constructor(
    private readonly db: PrismaClient,
    private readonly eventService: EventService,
    private readonly notificationService?: {
      notifyPlayerById: (
        playerId: string,
        title: string,
        message: string,
        type?: NotificationType,
        dedupeKey?: string,
        level?: NotificationLevel
      ) => Promise<boolean>
    }
  ) {}

  /**
   * اعتبارسنجی مبلغ مهریه؛ `null` یعنی «تعیین‌نشده» (فقط در پیشنهاد مرد).
   * قواعد واقعی در `./mahr` زندگی می‌کنند؛ اینجا فقط نگاشت ورودی است.
   */
  private validateMahr(mahr: number | null): number {
    return normalizeMahrOffer(mahr)
  }

  /** آخرین لحظه‌ای که یک پیشنهاد هنوز معتبر شمرده می‌شود. */
  private static notExpiredBefore(): Date {
    return new Date(Date.now() - PROPOSAL_TTL_MS)
  }

  /**
   * آشتی‌دادنِ «ازدواجِ فوت‌شده» پیش از هر خواندن/نوشتاری که به وضعیتِ تأهل
   * وابسته است. بدون این کار، بازمانده همیشه متأهل شمرده می‌شد و هیچ‌وقت
   * نمی‌توانست دوباره ازدواج کند (بن‌بستِ چرخهٔ زندگی).
   */
  private async settleWidowhoodFor(playerId: string): Promise<void> {
    await settleWidowhoodForAll(this.db, [playerId], {
      notify: this.notificationService
        ? (playerId, title, message, type, dedupeKey, level) =>
            this.notificationService!.notifyPlayerById(
              playerId,
              title,
              message,
              type,
              dedupeKey,
              level
            )
        : undefined,
      recordEvent: (input) => this.eventService.recordPlayerEvent(input)
    })
  }

  /**
   * منقضی‌کردن Lazy پیشنهادها؛ بی‌تایمر.
   *
   * این نوشتار سراسری فقط در مسیرهای کم‌تردد (خواستگاری و عقد) اجرا می‌شود؛
   * مسیرهای پرتکرار مثل بازکردن پنل، اعتبار را با شرط `createdAt` در همان
   * Query می‌سنجند تا هر بار یک UPDATE سراسری به دیتابیس نزنند.
   */
  private async expireStale(): Promise<void> {
    await this.db.marriageProposal.updateMany({
      where: {
        status: { in: [...OPEN_STATUSES] },
        createdAt: { lt: MarriageService.notExpiredBefore() }
      },
      data: { status: 'EXPIRED' }
    })
  }

  /** شرط «باز و هنوز معتبر» برای همهٔ Queryهای پیشنهاد. */
  private static openAndFreshWhere(): Prisma.MarriageProposalWhereInput {
    return {
      status: { in: [...OPEN_STATUSES] },
      createdAt: { gte: MarriageService.notExpiredBefore() }
    }
  }

  /** پیشنهاد ازدواج (خواستگاری) — فقط آقایان آغاز می‌کنند. */
  async propose(
    proposerTgId: bigint,
    targetTgId: bigint,
    mahr: number | null
  ): Promise<{ targetName: string; mahr: number }> {
    const offer = this.validateMahr(mahr)
    if (proposerTgId === targetTgId) {
      throw new ValidationError('Self proposal', 'طرف پیشنهاد نمی‌تواند خودت باشی. روی پیام بازیکن موردنظر ریپلای کن.')
    }
    await this.expireStale()

    // پیش از سنجشِ وضعیتِ تأهل، بن‌بستِ «همسرِ فوت‌شده» آشتی داده می‌شود تا
    // هر دو طرف با وضعیتِ درست (WIDOWED) سنجیده شوند، نه با MARRIED کهنه.
    // (بدون این کار، بازمانده تا ابد از خواستگاری محروم می‌ماند.)
    const participants = await this.db.player.findMany({
      where: { telegramUserId: { in: [proposerTgId, targetTgId] } },
      select: { id: true }
    })
    for (const participant of participants) {
      await this.settleWidowhoodFor(participant.id)
    }

    const players = await this.db.player.findMany({
      where: { telegramUserId: { in: [proposerTgId, targetTgId] } },
      select: {
        id: true,
        telegramUserId: true,
        firstName: true,
        lastName: true,
        gender: true,
        maritalStatus: true,
        status: true
      }
    })
    const proposer = players.find((p) => p.telegramUserId === proposerTgId)
    const target = players.find((p) => p.telegramUserId === targetTgId)
    if (!proposer || proposer.status !== PlayerStatus.ACTIVE) {
      throw new ConflictError('Proposer not active', 'خواستگاری فقط برای بازیکنِ فعال ممکن است.')
    }
    if (!target) {
      throw new NotFoundError('Target not found', 'این بازیکن یافت نشد. روی پیام خودِ بازیکن ریپلای کن؛ او باید ثبت‌نام کرده باشد.')
    }
    if (target.status !== PlayerStatus.ACTIVE) {
      throw new NotFoundError('Target not active', 'این بازیکن فعال نیست.')
    }
    if (proposer.gender !== Gender.MALE) {
      throw new ValidationError(
        'Gender rule',
        'در این بازی خواستگاری را آقا آغاز می‌کند؛ خانم پاسخ می‌دهد.'
      )
    }
    if (target.gender !== Gender.FEMALE) {
      throw new ValidationError('Gender rule', 'همسر انتخابی باید خانم باشد.')
    }
    if (proposer.maritalStatus === MaritalStatus.MARRIED) {
      throw new ConflictError('Proposer married', 'تو هم‌اکنون متأهل هستی!')
    }
    if (target.maritalStatus === MaritalStatus.MARRIED) {
      throw new ConflictError('Target married', 'این بازیکن هم‌اکنون متأهل است.')
    }

    // همزمان فقط یک پیشنهاد باز؛ شمارش و درج در یک تراکنش Serializable تا
    // دو درخواست همزمان (دابل‌کلیک یا دو تب) نتوانند هر دو از گارد بگذرند.
    const proposal = await this.db
      .$transaction(
        async (tx) => {
          const openFromMe = await tx.marriageProposal.count({
            where: { proposerId: proposer.id, ...MarriageService.openAndFreshWhere() }
          })
          if (openFromMe > 0) {
            throw new ConflictError(
              'Open proposal exists',
              'یک پیشنهاد باز داری؛ اول پاسخ/لغو کن یا منتظر بمان.'
            )
          }
          // زن همزمان فقط یک پیشنهادِ باز دریافتی دارد تا ازدواج دونشه نشود
          const openToHer = await tx.marriageProposal.count({
            where: { targetId: target.id, ...MarriageService.openAndFreshWhere() }
          })
          if (openToHer > 0) {
            throw new ConflictError(
              'Target has open proposal',
              'این بازیکن همین حالا یک پیشنهاد باز دارد؛ بعد از پاسخ‌دادن او تلاش کن.'
            )
          }

          return tx.marriageProposal.create({
            data: { proposerId: proposer.id, targetId: target.id, mahr: offer }
          })
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
      )
      .catch((error: unknown) => {
        // P2034 = تعارض نوشتار همزمان؛ همان «یک پیشنهاد بیشتر نه» است
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2034'
        ) {
          throw new ConflictError(
            'Concurrent proposal',
            'درخواست همزمان دیگری ثبت شد؛ دوباره تلاش کن.'
          )
        }
        throw error
      })

    await this.notificationService
      ?.notifyPlayerById(
        target.id,
        '💌 پیشنهاد ازدواج',
        isMahrSet(offer)
          ? `${proposer.firstName} با مهریهٔ ${money(offer)} به تو پیشنهاد ازدواج داده است. در گروه، در پنل «خانواده» قبول کن، مهریه را تغییر بده یا رد کن.`
          : `${proposer.firstName} بدون تعیین مهریه به تو پیشنهاد ازدواج داده است. در گروه پنل «خانواده» را باز کن و مهریه را خودت تعیین کن تا او تأیید کند.`,
        undefined,
        `marriage-propose:${proposal.id}`,
        'CRITICAL'
      )
      .catch(() => undefined)

    return {
      targetName: `${target.firstName} ${target.lastName ?? ''}`.trim(),
      mahr: offer
    }
  }

  /** تعیین/تغییر مهریه توسط زن؛ مرد باید تأیید کند. */
  async setMahr(targetTgId: bigint, proposalId: string, mahr: number): Promise<void> {
    // صفر اینجا معنا ندارد: زن دارد مهریه را «تعیین» می‌کند، نه «تعیین‌نشده»
    const amount = validateMahrAmount(mahr)
    const target = await this.db.player.findUnique({
      where: { telegramUserId: targetTgId },
      select: { id: true }
    })
    if (!target) {
      throw new NotFoundError('Player not found')
    }

    const updated = await this.db.marriageProposal.updateMany({
      where: {
        id: proposalId,
        targetId: target.id,
        ...MarriageService.openAndFreshWhere()
      },
      data: { mahr: amount, status: 'MAHR_SET' }
    })
    if (updated.count !== 1) {
      throw new ConflictError(
        'Cannot set mahr',
        'این پیشنهاد باز نیست یا مهلت آن گذشته است.'
      )
    }

    const proposal = await this.db.marriageProposal.findUniqueOrThrow({
      where: { id: proposalId },
      select: { proposerId: true }
    })
    await this.notificationService
      ?.notifyPlayerById(
        proposal.proposerId,
        '⚖️ مهریه تعیین شد',
        `همسرِ آینده مهریه را ${money(amount)} تعیین کرده است. در گروه، در پنل «خانواده» تأیید کن یا انصراف بده.`,
        undefined,
        `marriage-mahr:${proposalId}:${amount}`,
        'IMPORTANT'
      )
      .catch(() => undefined)
  }

  /** زن پیشنهادِ مبلغ‌دار را همان‌طور که هست می‌پذیرد. */
  async acceptProposal(targetTgId: bigint, proposalId: string): Promise<void> {
    const target = await this.db.player.findUnique({
      where: { telegramUserId: targetTgId },
      select: { id: true }
    })
    if (!target) {
      throw new NotFoundError('Player not found')
    }
    const proposal = await this.db.marriageProposal.findFirst({
      where: {
        id: proposalId,
        targetId: target.id,
        status: 'PENDING',
        createdAt: { gte: MarriageService.notExpiredBefore() }
      },
      select: { id: true, mahr: true }
    })
    if (!proposal) {
      throw new ConflictError(
        'Cannot accept',
        'این پیشنهاد باز نیست؛ اگر مهریه را تو تعیین کرده‌ای، نوبت تأییدِ اوست.'
      )
    }
    if (!isMahrSet(Number(proposal.mahr))) {
      throw new ValidationError(
        'Mahr not set',
        'این پیشنهاد مهریه ندارد؛ اول خودت مهریه را تعیین کن تا او تأیید کند.'
      )
    }
    await this.finalize(target.id, proposalId)
  }

  /** مرد مهریهٔ تعیین‌شدهٔ زن را تأیید و عقد را ثبت می‌کند. */
  async confirmProposal(proposerTgId: bigint, proposalId: string): Promise<void> {
    const proposer = await this.db.player.findUnique({
      where: { telegramUserId: proposerTgId },
      select: { id: true }
    })
    if (!proposer) {
      throw new NotFoundError('Player not found')
    }
    await this.finalize(proposer.id, proposalId)
  }

  /**
   * عقد در یک تراکنش — تنها نقطهٔ ثبت ازدواج.
   * قفل‌ها: وضعیت پیشنهاد، مجردبودن هر دو، و موجودی کافی مرد.
   */
  private async finalize(actorId: string, proposalId: string): Promise<void> {
    await this.expireStale()

    const outcome = await this.db.$transaction(async (tx) => {
      const proposal = await tx.marriageProposal.findUnique({
        where: { id: proposalId },
        include: {
          proposer: {
            select: { id: true, firstName: true, lastName: true, status: true, balance: true, maritalStatus: true }
          },
          target: {
            select: { id: true, firstName: true, lastName: true, status: true, maritalStatus: true }
          }
        }
      })
      if (!proposal) {
        throw new NotFoundError('Proposal not found', 'این پیشنهاد یافت نشد. «خانواده» را دوباره باز کن تا درخواست‌های فعلی را ببینی.')
      }
      const actorIsTarget = proposal.targetId === actorId
      const actorIsProposer = proposal.proposerId === actorId
      if (!actorIsTarget && !actorIsProposer) {
        throw new ConflictError('Not your proposal', 'این پیشنهاد مربوط به تو نیست. از پنل «خانواده» خودت پاسخ بده.')
      }
      if (proposal.createdAt < MarriageService.notExpiredBefore()) {
        throw new ConflictError('Proposal expired', 'مهلت این پیشنهاد تمام شده است.')
      }
      // زن فقط از روی PENDING می‌تواند قبول کند؛ مرد فقط MAHR_SET را تأیید می‌کند
      const expectedStatus: OpenStatus = actorIsTarget ? 'PENDING' : 'MAHR_SET'
      if (proposal.status !== expectedStatus) {
        throw new ConflictError(
          'Wrong stage',
          actorIsTarget
            ? 'قبول در مرحلهٔ پیشنهادِ مرد است؛ حالا نوبت تأییدِ اوست.'
            : 'منتظر بمان زن مهریه را تعیین/پذیرش کند.'
        )
      }

      const mahr = Math.round(Number(proposal.mahr))
      if (!isMahrSet(mahr)) {
        throw new ValidationError(
          'Mahr not set',
          'بدون مهریهٔ تعیین‌شده عقد ثبت نمی‌شود؛ اول مهریه را مشخص کن.'
        )
      }

      const locked = await tx.marriageProposal.updateMany({
        where: { id: proposalId, status: expectedStatus },
        data: { status: 'ACCEPTED' }
      })
      if (locked.count !== 1) {
        throw new ConflictError('Concurrent answer', 'این پیشنهاد همین حالا پاسخ داده شد.')
      }

      if (
        proposal.proposer.status !== PlayerStatus.ACTIVE ||
        proposal.target.status !== PlayerStatus.ACTIVE
      ) {
        throw new ConflictError('Players must be active', 'هر دو بازیکن باید فعال باشند.')
      }
      if (proposal.target.maritalStatus === MaritalStatus.MARRIED) {
        throw new ConflictError('Target married', 'طرف مقابل هم‌اکنون متأهل است.')
      }

      // شرط مجردبودنِ مرد هم در همان نوشتار — قفلِ چندزنی
      const eligibleA = await tx.player.updateMany({
        where: { id: proposal.proposerId, maritalStatus: { not: MaritalStatus.MARRIED } },
        data: { maritalStatus: MaritalStatus.MARRIED }
      })
      if (eligibleA.count !== 1) {
        throw new ConflictError('Proposer married', 'خواستگار هم‌اکنون متأهل است.')
      }

      const debited = await tx.player.updateMany({
        where: { id: proposal.proposerId, balance: { gte: mahr } },
        data: { balance: { decrement: mahr } }
      })
      if (debited.count !== 1) {
        // پول برگشت می‌خورد (rollback) — پیشنهاد هم باز می‌گردد و مرد پس از
        // تأمین موجودی می‌تواند دوباره اقدام کند.
        throw new ConflictError(
          'Proposer cannot afford',
          'موجودی مرد برای پرداخت مهریه کافی نیست؛ عقد ثبت نشد.'
        )
      }

      const eligibleB = await tx.player.updateMany({
        where: { id: proposal.targetId, maritalStatus: { not: MaritalStatus.MARRIED } },
        data: { maritalStatus: MaritalStatus.MARRIED }
      })
      if (eligibleB.count !== 1) {
        throw new ConflictError('Target married', 'طرف مقابل هم‌اکنون متأهل است.')
      }

      // مهریه مالِ زن است: واریز + یک ردیفِ دفترِ کلِ انتقالی
      await tx.player.update({
        where: { id: proposal.targetId },
        data: { balance: { increment: mahr } }
      })
      await tx.financialTransaction.create({
        data: {
          amount: mahr,
          type: TransactionType.MAHR_PAYMENT,
          sourcePlayerId: proposal.proposerId,
          destinationPlayerId: proposal.targetId,
          reference: 'مهریهٔ عقد ازدواج'
        }
      })

      await tx.marriage.create({
        data: {
          playerAId: proposal.proposerId,
          playerBId: proposal.targetId,
          mahr,
          // لنگر گرما از لحظهٔ عقد؛ رابطهٔ تازه گرمای کامل دارد و از همین
          // لحظه فرسایشِ روزهای بی‌خبری شمارش می‌شود.
          lastWarmthAt: new Date()
        }
      })

      // پیوند خانوادگی دوسویه در شبکهٔ روابط
      await this.upsertSpouseRelationship(tx, proposal.proposerId, proposal.targetId, true)
      await this.upsertSpouseRelationship(tx, proposal.targetId, proposal.proposerId, true)

      return {
        mahr,
        proposerId: proposal.proposerId,
        targetId: proposal.targetId
      }
    })

    for (const playerId of [outcome.proposerId, outcome.targetId]) {
      await this.eventService
        .recordPlayerEvent({
          playerId,
          type: GameEventType.MARRIAGE_REGISTERED,
          title: '🎉 ازدواج رسمی ثبت شد',
          detail: `مهریهٔ ${money(outcome.mahr)}`,
          dedupeKey: `marriage-${playerId}:${proposalId}`
        })
        .catch(() => undefined)
    }

    await this.notificationService
      ?.notifyPlayerById(
        outcome.proposerId,
        '💍 عقد ثبت شد',
        `ازدواجت رسمی شد و مهریه (${money(outcome.mahr)}) پرداخت شد. در گروه پنل «خانواده» را ببین.`,
        undefined,
        `marriage-done-p:${proposalId}`,
        'CRITICAL'
      )
      .catch(() => undefined)
    await this.notificationService
      ?.notifyPlayerById(
        outcome.targetId,
        '💍 عقد ثبت شد',
        `ازدواجتان رسمی شد و مهریه (${money(outcome.mahr)}) به حساب تو واریز شد.`,
        undefined,
        `marriage-done-t:${proposalId}`,
        'CRITICAL'
      )
      .catch(() => undefined)
  }

  private async upsertSpouseRelationship(
    tx: Prisma.TransactionClient,
    playerId: string,
    partnerId: string,
    active: boolean
  ): Promise<void> {
    await tx.relationship.upsert({
      where: {
        playerId_relatedPlayerId_type: {
          playerId,
          relatedPlayerId: partnerId,
          type: RelationshipType.SPOUSE
        }
      },
      create: {
        playerId,
        relatedPlayerId: partnerId,
        type: RelationshipType.SPOUSE,
        status: active ? RelationshipStatus.ACTIVE : RelationshipStatus.BLOCKED,
        strength: 100
      },
      update: {
        status: active ? RelationshipStatus.ACTIVE : RelationshipStatus.BLOCKED,
        strength: active ? 100 : 10
      }
    })
  }

  /** رد پیشنهاد توسط زن. */
  async rejectProposal(targetTgId: bigint, proposalId: string): Promise<void> {
    const target = await this.db.player.findUnique({
      where: { telegramUserId: targetTgId },
      select: { id: true }
    })
    if (!target) {
      throw new NotFoundError('Player not found')
    }
    const updated = await this.db.marriageProposal.updateMany({
      where: { id: proposalId, targetId: target.id, ...MarriageService.openAndFreshWhere() },
      data: { status: 'REJECTED' }
    })
    if (updated.count !== 1) {
      throw new ConflictError('Not pending', 'این پیشنهاد دیگر در انتظار پاسخ نیست. پنل «خانواده» را به‌روزرسانی کن.')
    }
    const proposal = await this.db.marriageProposal.findUnique({
      where: { id: proposalId },
      select: { proposerId: true }
    })
    if (proposal) {
      await this.notificationService
        ?.notifyPlayerById(
          proposal.proposerId,
          '💔 پاسخ خواستگاری',
          'پیشنهاد ازدواجت پذیرفته نشد.',
          undefined,
          `marriage-reject:${proposalId}`,
          'IMPORTANT'
        )
        .catch(() => undefined)
    }
  }

  /** انصراف مرد: لغو پیش از پاسخ (PENDING) یا DECLINED پس از تعیین مهریه. */
  async withdrawProposal(proposerTgId: bigint, proposalId: string): Promise<void> {
    const proposer = await this.db.player.findUnique({
      where: { telegramUserId: proposerTgId },
      select: { id: true }
    })
    if (!proposer) {
      throw new NotFoundError('Player not found')
    }
    const proposal = await this.db.marriageProposal.findFirst({
      where: {
        id: proposalId,
        proposerId: proposer.id,
        ...MarriageService.openAndFreshWhere()
      },
      select: { status: true, targetId: true }
    })
    if (!proposal) {
      throw new ConflictError('Not cancellable', 'این پیشنهاد دیگر قابل لغو نیست. وضعیت فعلی را در «خانواده» بررسی کن.')
    }

    // نوشتار شرطی: بین خواندن و نوشتن، طرف مقابل ممکن است پیشنهاد را پذیرفته باشد
    // (`finalize` وضعیت را ACCEPTED می‌کند و عقد را می‌بندد). نوشتار بی‌قیدِ
    // پیشین آن ACCEPTED را با CANCELLED بازنویسی می‌کرد؛ نتیجه ازدواجِ ثبت‌شده
    // با پیشنهادِ «لغوشده» بود — یک وضعیت ناممکن. حالا همان لحظه رد می‌شود.
    const cancelled = await this.db.marriageProposal.updateMany({
      where: {
        id: proposalId,
        proposerId: proposer.id,
        status: proposal.status,
        createdAt: { gte: MarriageService.notExpiredBefore() }
      },
      data: { status: proposal.status === 'MAHR_SET' ? 'DECLINED' : 'CANCELLED' }
    })
    if (cancelled.count !== 1) {
      throw new ConflictError(
        'Already answered',
        'این پیشنهاد همین حالا پاسخ داده شد؛ وضعیت فعلی را در «خانواده» ببین.'
      )
    }
    await this.notificationService
      ?.notifyPlayerById(
        proposal.targetId,
        '✉️ انصراف خواستگار',
        'خواستگارت پیش از عقد منصرف شد.',
        undefined,
        `marriage-withdraw:${proposalId}`,
        'IMPORTANT'
      )
      .catch(() => undefined)
  }

  /**
   * طلاق توسط یکی از زوجین — فقط هزینهٔ ثبت (Sink).
   * مهریه از پیش مالِ همسر است و در طلاق پس‌گرفته نمی‌شود.
   */
  async divorce(
    initiatorTgId: bigint
  ): Promise<{ spouseName: string; paidFee: number }> {
    const initiator = await this.db.player.findUnique({
      where: { telegramUserId: initiatorTgId },
      select: { id: true }
    })
    if (!initiator) {
      throw new NotFoundError('Player not found')
    }

    const marriage = await this.db.marriage.findFirst({
      where: {
        isActive: true,
        OR: [{ playerAId: initiator.id }, { playerBId: initiator.id }]
      },
      include: {
        playerA: { select: { id: true, firstName: true, lastName: true } },
        playerB: { select: { id: true, firstName: true, lastName: true } }
      }
    })
    if (!marriage) {
      throw new ConflictError('Not married', 'ازدواج فعالی نداری. برای دیدن درخواست‌ها، «خانواده» را باز کن.')
    }

    const spouse =
      marriage.playerAId === initiator.id ? marriage.playerB : marriage.playerA

    await this.db.$transaction(async (tx) => {
      // قفل طلاق: تنها یک درخواست اثر می‌گذارد
      const locked = await tx.marriage.updateMany({
        where: { id: marriage.id, isActive: true },
        data: {
          isActive: false,
          divorcedAt: new Date(),
          endedAt: new Date(),
          endReason: MarriageEndReason.DIVORCED
        }
      })
      if (locked.count !== 1) {
        throw new ConflictError('Concurrent divorce', 'طلاق همین حالا ثبت شد.')
      }

      const debited = await tx.player.updateMany({
        where: { id: initiator.id, balance: { gte: DIVORCE_COST } },
        data: { balance: { decrement: DIVORCE_COST } }
      })
      if (debited.count !== 1) {
        throw new ValidationError(
          'Insufficient for divorce',
          `هزینهٔ ثبت طلاق ${money(DIVORCE_COST)} است و موجودی‌ات کافی نیست.`
        )
      }
      await tx.financialTransaction.create({
        data: {
          amount: DIVORCE_COST,
          type: TransactionType.DIVORCE_SETTLEMENT,
          sourcePlayerId: initiator.id,
          reference: 'هزینهٔ ثبت طلاق'
        }
      })

      await tx.player.updateMany({
        where: { id: initiator.id },
        data: { maritalStatus: MaritalStatus.DIVORCED }
      })
      await tx.player.updateMany({
        where: { id: spouse.id },
        data: { maritalStatus: MaritalStatus.DIVORCED }
      })
      await tx.relationship.updateMany({
        where: {
          OR: [
            { playerId: initiator.id, relatedPlayerId: spouse.id, type: RelationshipType.SPOUSE },
            { playerId: spouse.id, relatedPlayerId: initiator.id, type: RelationshipType.SPOUSE }
          ],
          status: RelationshipStatus.ACTIVE
        },
        data: { status: RelationshipStatus.BLOCKED, strength: 10 }
      })
    })

    await this.eventService
      .recordPlayerEvent({
        playerId: initiator.id,
        type: GameEventType.DIVORCE_REGISTERED,
        title: 'طلاق ثبت شد',
        amount: DIVORCE_COST,
        dedupeKey: `divorce:${marriage.id}`
      })
      .catch(() => undefined)

    await this.notificationService
      ?.notifyPlayerById(
        spouse.id,
        '💔 طلاق ثبت شد',
        'زندگی مشترکت به پایان رسید. مهریه‌ای که هنگام عقد گرفتی نزد خودت می‌ماند و پس گرفته نمی‌شود.',
        undefined,
        `divorce:${marriage.id}`,
        'CRITICAL'
      )
      .catch(() => undefined)

    return {
      spouseName: `${spouse.firstName} ${spouse.lastName ?? ''}`.trim(),
      paidFee: DIVORCE_COST
    }
  }

  /**
   * پاداش روزانهٔ زوجین؛ نیازمند فعالیت اخیر همسر.
   *
   * مبلغ با «گرمای رابطه» مقیاس می‌شود: زندگیِ گرم (۸۰+) همان پاداش کامل را
   * می‌گیرد و زندگیِ سردشده کمتر. گرفتنِ خودِ پاداش هم کمی گرما برمی‌گرداند —
   * سرنخ‌زدنِ روزانهٔ زوجین به هم. فرسایش گرما از آخرین تعامل حساب می‌شود
   * و همین‌جا به‌صورت تنبل (Lazy) اعمال و ذخیره می‌شود.
   */
  async claimCoupleBonus(
    telegramUserId: bigint
  ): Promise<{ amount: number; spouseName: string; warmth: number; multiplier: number }> {
    const me = await this.db.player.findUnique({
      where: { telegramUserId },
      select: { id: true }
    })
    if (!me) {
      throw new NotFoundError('Player not found')
    }

    // اگر همسر فوت کرده باشد، اول ازدواج بسته می‌شود؛ وگرنه پیامِ گمراه‌کنندهٔ
    // «منتظرِ فعالیتِ همسر» تا ابد تکرار می‌شد و پاداش هم هرگز نمی‌رسید.
    await this.settleWidowhoodFor(me.id)

    const marriage = await this.db.marriage.findFirst({
      where: {
        isActive: true,
        OR: [{ playerAId: me.id }, { playerBId: me.id }]
      },
      include: {
        playerA: {
          select: { id: true, firstName: true, lastName: true, lastActivityAt: true }
        },
        playerB: {
          select: { id: true, firstName: true, lastName: true, lastActivityAt: true }
        }
      }
    })
    if (!marriage) {
      throw new ConflictError('Not married', 'برای پاداش زوجین باید متأهل باشی.')
    }

    const spouse =
      marriage.playerAId === me.id ? marriage.playerB : marriage.playerA
    const day = dayIndex()
    if (marriage.lastBonusDayIndex === day) {
      throw new ConflictError('Bonus claimed', 'پاداش روزانهٔ زوجین امروز گرفته شده است.')
    }

    const spouseActive =
      spouse.lastActivityAt &&
      Date.now() - spouse.lastActivityAt.getTime() <= SPOUSE_ACTIVE_MS
    if (!spouseActive) {
      throw new ConflictError(
        'Spouse inactive',
        'همسرت دو روز اخیر فعالیتی نداشته است؛ با او در ارتباط باش!'
      )
    }

    const now = new Date()
    let bonusAmount = COUPLE_DAILY_BONUS
    let bonusWarmth = 0
    let bonusMultiplier = 1

    await this.db.$transaction(async (tx) => {
      // `{ not: day }` در SQL مقدار NULL را رد می‌کند؛ ازدواج تازه
      // lastBonusDayIndex تهی دارد و بدون این OR هرگز پاداش نمی‌گرفت.
      const claimed = await tx.marriage.updateMany({
        where: {
          id: marriage.id,
          OR: [{ lastBonusDayIndex: null }, { lastBonusDayIndex: { not: day } }]
        },
        data: { lastBonusDayIndex: day }
      })
      if (claimed.count !== 1) {
        throw new ConflictError('Concurrent claim', 'پاداش همین حالا گرفته شد.')
      }

      // گرمای واقعیِ همین لحظه (با فرسایش روزهای بی‌خبری) → ضریب پاداش
      const anchor = warmthAnchorOf(marriage)
      const currentWarmth = await readWarmth(tx, anchor)
      bonusMultiplier = coupleBonusMultiplier(currentWarmth)
      bonusAmount = coupleBonusOf(currentWarmth, COUPLE_DAILY_BONUS)
      bonusWarmth = gainWarmth(currentWarmth, BONUS_WARMTH_GAIN)
      await writeWarmth(tx, anchor, bonusWarmth, now)

      await tx.player.update({
        where: { id: me.id },
        data: { balance: { increment: bonusAmount } }
      })
      await tx.financialTransaction.create({
        data: {
          amount: bonusAmount,
          type: TransactionType.REWARD_PAYOUT,
          destinationPlayerId: me.id,
          reference: 'پاداش روزانهٔ زندگی مشترک'
        }
      })
    })

    await this.eventService
      .recordPlayerEvent({
        playerId: me.id,
        type: GameEventType.MARRIAGE_REGISTERED,
        title: '💞 پاداش زوجین',
        amount: bonusAmount,
        dedupeKey: `couple-bonus:${marriage.id}:${day}`
      })
      .catch(() => undefined)

    return {
      amount: bonusAmount,
      spouseName: `${spouse.firstName} ${spouse.lastName ?? ''}`.trim(),
      warmth: bonusWarmth,
      multiplier: bonusMultiplier
    }
  }

  /** نمای کامل پنل خانواده برای بازیکن. */
  async getView(telegramUserId: bigint): Promise<MarriageView> {
    const me = await this.db.player.findUnique({
      where: { telegramUserId },
      select: { id: true, gender: true, maritalStatus: true }
    })
    if (!me) {
      throw new NotFoundError('Player not found')
    }

    // پنل، پیش از هر چیز، ازدواجِ فوت‌شده را می‌بندد؛ وگرنه همسرِ فوت‌شده را
    // «زنده»، پاداشِ زوجین را «منتظرِ همسر» و وضعیت را «متأهل» نشان می‌داد.
    await this.settleWidowhoodFor(me.id)

    const [activeMarriage, incoming, outgoing] = await Promise.all([
      this.db.marriage.findFirst({
        where: {
          isActive: true,
          OR: [{ playerAId: me.id }, { playerBId: me.id }]
        },
        orderBy: { marriedAt: 'desc' },
        include: {
          playerA: { select: { id: true, firstName: true, lastName: true, lastActivityAt: true } },
          playerB: { select: { id: true, firstName: true, lastName: true, lastActivityAt: true } }
        }
      }),
      this.db.marriageProposal.findMany({
        where: { targetId: me.id, ...MarriageService.openAndFreshWhere() },
        orderBy: { createdAt: 'desc' },
        take: 3,
        include: {
          proposer: { select: { firstName: true, lastName: true } }
        }
      }),
      this.db.marriageProposal.findMany({
        where: { proposerId: me.id, ...MarriageService.openAndFreshWhere() },
        orderBy: { createdAt: 'desc' },
        take: 3,
        include: {
          target: { select: { firstName: true, lastName: true } }
        }
      })
    ])

    const spouse =
      activeMarriage &&
      (activeMarriage.playerAId === me.id
        ? activeMarriage.playerB
        : activeMarriage.playerA)

    // صداقت پنل با رفتار سرویس: `claimCoupleBonus` هم «امروز گرفته نشده» را
    // می‌سنجد و هم «فعالیت اخیر همسر» را. پیش‌تر پنل فقط شرط اول را می‌دید و
    // «پاداش آماده است» می‌گفت، ولی دکمه با خطای «همسرت فعال نبوده» رد می‌شد.
    const bonusClaimedToday = activeMarriage?.lastBonusDayIndex === dayIndex()
    const spouseActiveRecently =
      spouse?.lastActivityAt != null &&
      Date.now() - spouse.lastActivityAt.getTime() <= SPOUSE_ACTIVE_MS
    const bonusPending = Boolean(activeMarriage) && !bonusClaimedToday

    // گرمای رابطه برای نمایش در پنل؛ با فرسایشِ روزهای بی‌خبری خوانده می‌شود.
    let warmthValue: number | null = null
    if (activeMarriage && spouse) {
      warmthValue = await readWarmth(this.db, warmthAnchorOf(activeMarriage))
    }

    return {
      genderIsMale: me.gender === Gender.MALE,
      isWidowed: !activeMarriage && me.maritalStatus === MaritalStatus.WIDOWED,
      hasSpouse: Boolean(activeMarriage && spouse),
      spouseName: spouse
        ? `${spouse.firstName} ${spouse.lastName ?? ''}`.trim()
        : null,
      marriedAt: activeMarriage?.marriedAt ?? null,
      mahr: activeMarriage ? Number(activeMarriage.mahr) : 0,
      daysMarried: activeMarriage
        ? gameDaysSince(activeMarriage.marriedAt)
        : 0,
      bonusReady: bonusPending && spouseActiveRecently,
      bonusWaitingForSpouse: bonusPending && !spouseActiveRecently,
      // مبلغ واقعیِ امروز با احتساب گرما — پنل همان عددی را می‌گوید که سرویس پرداخت می‌کند.
      bonusAmount:
        warmthValue === null ? COUPLE_DAILY_BONUS : coupleBonusOf(warmthValue, COUPLE_DAILY_BONUS),
      warmth: warmthValue,
      warmthLabelText: warmthValue === null ? null : warmthLabel(warmthValue),
      bonusMultiplier: warmthValue === null ? null : coupleBonusMultiplier(warmthValue),
      activityDoneToday: activeMarriage?.lastActivityDayIndex === dayIndex(),
      incomingProposals: incoming.map((proposal) => ({
        id: proposal.id,
        offeredMahr: Number(proposal.mahr),
        status: proposal.status as OpenStatus,
        createdAt: proposal.createdAt,
        fromName:
          `${proposal.proposer.firstName} ${proposal.proposer.lastName ?? ''}`.trim(),
        canAccept: proposal.status === 'PENDING' && isMahrSet(Number(proposal.mahr)),
        canSetMahr: true
      })),
      outgoingProposals: outgoing.map((proposal) => ({
        id: proposal.id,
        mahr: Number(proposal.mahr),
        status: proposal.status as OpenStatus,
        createdAt: proposal.createdAt,
        targetName:
          `${proposal.target.firstName} ${proposal.target.lastName ?? ''}`.trim(),
        awaitingMyAnswer: proposal.status === 'MAHR_SET'
      }))
    }
  }

}

/**
 * خلاصهٔ عددی قواعد ازدواج — همه از همان منبع‌های حقیقت خوانده می‌شوند
 * تا متن راهنما و منطق سرویس هرگز از هم جدا نیفتند.
 */
export const MARRIAGE_INFO = {
  minMahr: MAHR_RULES.min,
  maxMahr: MAHR_RULES.max,
  mahrUnset: MAHR_RULES.unset,
  mahrRangeText: mahrRangeError(),
  divorceCost: DIVORCE_COST,
  coupleDailyBonus: COUPLE_DAILY_BONUS,
  proposalTtlHours: Math.round(PROPOSAL_TTL_MS / REAL_MS_PER_GAME_HOUR),
  spouseActiveHours: Math.round(SPOUSE_ACTIVE_MS / REAL_MS_PER_GAME_HOUR)
} as const

