import {
  GameEventType,
  NotificationType,
  PlayerGroupStatus,
  Prisma,
  PrismaClient,
  TransactionType
} from '@prisma/client'
import { ConflictError, NotFoundError, ValidationError } from '../../utils/classes/errors'
import { money } from '../../utils/format'
import { EventService } from '../events/event.service'
import type { NotificationLevel } from '../notification/push'
import { MAYOR_TERM_MS } from './authority'
import { gameDaysSince, hoursUntil } from '../../utils/game-time'

/** شرایط نامزدی — سکونت روی روزهای *بازی* سنجیده می‌شود. */
const CANDIDACY_MIN_RESIDENCE_DAYS = 7
const CANDIDACY_MIN_EXPERIENCE = 100
/** ودیهٔ نامزدی — پس از پایان انتخابات به همهٔ نامزدها برمی‌گردد (ضد Spam). */
export const CANDIDACY_DEPOSIT = 300_000

/**
 * انتخابات منطقه.
 *
 * چرخهٔ عمر Lazy:
 *   OPEN → (پایان مهلت) → CLOSED با تعیین برنده → دورهٔ بعد OPEN
 *
 * هیچ تایمری وجود ندارد؛ هنگام اولین بازدید، وضعیت دوره‌ها به‌روزرسانی می‌شود:
 *   • انتخابات بازِ گذشته → بسته و برنده اعلام می‌شود (اکثریت آرا؛ تساوی → نامزد قدیمی‌تر)
 *   • اگر انتخابات فعالی نیست → دورهٔ جدید OPEN می‌شود
 *
 * امنیت:
 *   • رأی یک‌بار در هر انتخابات (Unique Constraint)
 *   • فقط ساکنان ACTIVE همان گروه
 *   • ودیهٔ نامزدی پس از پایان به همه برمی‌گردد
 */
export class ElectionsService {
  constructor(
    private readonly db: PrismaClient,
    private readonly eventService: EventService,
    private readonly notificationService?: {
      announce: (input: {
        playerId: string
        title: string
        message: string
        type?: NotificationType
        level: NotificationLevel
        dedupeKey?: string
      }) => Promise<boolean>
    }
  ) {}

  /** وضعیت انتخابات گروه + لیست نامزدها و نتایج. */
  async getElectionState(groupId: string) {
    await this.settleExpiredElections(groupId)

    const election = await this.db.election.findFirst({
      where: { groupId, status: 'OPEN' },
      include: {
        candidates: {
          include: {
            player: { select: { firstName: true, lastName: true } }
          }
        },
        votes: { select: { candidateId: true } }
      }
    })

    if (!election) {
      return { phase: 'none' as const }
    }

    const tally = new Map<string, number>()
    for (const vote of election.votes) {
      tally.set(vote.candidateId, (tally.get(vote.candidateId) ?? 0) + 1)
    }

    const candidates = election.candidates.map((c) => ({
      playerId: c.playerId,
      name: `${c.player.firstName} ${c.player.lastName ?? ''}`.trim(),
      votes: tally.get(c.playerId) ?? 0
    }))

    const totalVotes = election.votes.length
    const hoursLeft = hoursUntil(election.endsAt)

    return {
      phase: 'open' as const,
      electionId: election.id,
      candidates,
      totalVotes,
      hoursLeft,
      endsAt: election.endsAt
    }
  }

  /** ثبت نام candidacy با شرط سابقهٔ اقامت و تجربه. */
  async registerCandidacy(telegramUserId: bigint, groupId: string) {
    const player = await this.db.player.findUnique({
      where: { telegramUserId },
      select: {
        id: true,
        balance: true,
        experience: true,
        residenceSince: true,
        homeGroupId: true
      }
    })
    if (!player) {
      throw new NotFoundError('Player not found')
    }
    if (player.homeGroupId !== groupId) {
      throw new ValidationError(
        'Not a resident',
        'فقط ساکنان اصلی این منطقه می‌توانند نامزد شوند.'
      )
    }

    const residenceDays = player.residenceSince ? gameDaysSince(player.residenceSince) : 0

    if (residenceDays < CANDIDACY_MIN_RESIDENCE_DAYS || player.experience < CANDIDACY_MIN_EXPERIENCE) {
      throw new ValidationError(
        'Eligibility not met',
        `شرایط نامزدی: حداقل ${CANDIDACY_MIN_RESIDENCE_DAYS.toLocaleString('fa-IR')} روز سکونت و \`${CANDIDACY_MIN_EXPERIENCE.toLocaleString('fa-IR')}\` تجربه.\nوضعیت تو: ${residenceDays.toLocaleString('fa-IR')} روز سکونت، ${player.experience.toLocaleString('fa-IR')} تجربه`
      )
    }

    const election = await this.getOrCreateOpenElection(groupId)

    // ودیه + ثبت نامزدی در یک تراکنش: اگر نامزدی تکراری باشد (Unique)
    // کل تراکنش برمی‌گردد و ودیه هرگز بی‌دلیل کسر نمی‌ماند.
    await this.db.$transaction(async (tx) => {
      const debited = await tx.player.updateMany({
        where: { id: player.id, balance: { gte: CANDIDACY_DEPOSIT } },
        data: { balance: { decrement: CANDIDACY_DEPOSIT } }
      })
      if (debited.count !== 1) {
        throw new ValidationError(
          'Insufficient deposit',
          `ودیهٔ نامزدی \`${CANDIDACY_DEPOSIT.toLocaleString('fa-IR')}\` تومان است (پس از انتخابات برگردانده می‌شود).`
        )
      }

      try {
        await tx.electionCandidate.create({
          data: { electionId: election.id, playerId: player.id }
        })
      } catch {
        throw new ConflictError('Already a candidate', 'تو قبلاً نامزد شده‌ای!')
      }

      // ودیهٔ نامزدی هم مثل هر کسر دیگری ردیف دفتر کل دارد (پس از انتخابات
      // با همان مبلغ به بازیکن برمی‌گردد).
      await tx.financialTransaction.create({
        data: {
          amount: CANDIDACY_DEPOSIT,
          type: TransactionType.TRANSFER,
          sourcePlayerId: player.id,
          reference: 'ودیهٔ نامزدی انتخابات'
        }
      })
    })

    return { title: election.title }
  }

  /** رأی دادن به یک نامزد. */
  async castVote(telegramUserId: bigint, groupId: string, candidatePlayerId: string) {
    const voter = await this.db.player.findUnique({
      where: { telegramUserId },
      select: { id: true }
    })
    if (!voter) {
      throw new NotFoundError('Player not found')
    }

    const membership = await this.db.playerGroup.findFirst({
      where: {
        playerId: voter.id,
        groupId,
        status: PlayerGroupStatus.ACTIVE
      }
    })
    if (!membership) {
      throw new ValidationError('Not a member', 'فقط اعضای همین منطقه حق رأی دارند.')
    }

    const election = await this.db.election.findFirst({
      where: { groupId, status: 'OPEN' }
    })
    if (!election) {
      throw new ConflictError('No open election', 'الان انتخابات فعالی جریان ندارد.')
    }
    // مهلت رأی‌گیری تمام شده؟ تسویهٔ تنبل هنوز دوره را نبسته، اما رأی جدید نباید ثبت شود.
    if (election.endsAt.getTime() <= Date.now()) {
      throw new ConflictError(
        'Election ended',
        'مهلت رأی‌گیری تمام شده است؛ منتظر اعلام نتیجه باش.'
      )
    }

    const isCandidate = await this.db.electionCandidate.findUnique({
      where: { electionId_playerId: { electionId: election.id, playerId: candidatePlayerId } }
    })
    if (!isCandidate) {
      throw new ValidationError('Invalid candidate', 'این گزینه یکی از نامزدهای رسمی نیست.')
    }

    try {
      await this.db.vote.create({
        data: { electionId: election.id, voterId: voter.id, candidateId: candidatePlayerId }
      })
    } catch {
      throw new ConflictError('Already voted', 'تو قبلاً رأی داده‌ای! 🗳️')
    }

    return {}
  }

  /** بستن انتخابات منقضی + اعلام برنده + بازگشت ودیه‌ها. */
  private async settleExpiredElections(groupId: string): Promise<void> {
    const expired = await this.db.election.findMany({
      where: { groupId, status: 'OPEN', endsAt: { lt: new Date() } }
    })

    for (const election of expired) {
      const tally = await this.db.vote.groupBy({
        by: ['candidateId'],
        where: { electionId: election.id },
        _count: { candidateId: true },
        orderBy: { _count: { candidateId: 'desc' } }
      })

      let winnerId: string | null =
        tally.length > 0 ? tally[0]!.candidateId : null

      // خروجی تراکنش = فهرست نامزدهایی که ودیه‌شان برگشت؛ اعلان‌ها بیرون از
      // تراکنش می‌روند تا یک پیام ناموفق، بازگشت پول را برنگرداند.
      const refunded = await this.db.$transaction(async (tx) => {
        // قفل وضعیت: اگر دو بازدید همزمان این انتخابات منقضی را ببینند،
        // فقط اولی آن را می‌بندد و ودیه‌ها را برمی‌گرداند؛ دومی صفر ردیف می‌زند
        // و از بازگشت دوبارهٔ ودیه (پول‌سازی) جلوگیری می‌شود.
        const closed = await tx.election.updateMany({
          where: { id: election.id, status: 'OPEN' },
          data: { status: 'CLOSED', winnerId }
        })
        if (closed.count !== 1) {
          return []
        }

        // بازگشت ودیه به همهٔ نامزدها
        const candidates = await tx.electionCandidate.findMany({
          where: { electionId: election.id },
          select: { playerId: true }
        })
        for (const c of candidates) {
          await tx.player.update({
            where: { id: c.playerId },
            data: { balance: { increment: CANDIDACY_DEPOSIT } }
          })
          await tx.financialTransaction.create({
            data: {
              amount: CANDIDACY_DEPOSIT,
              type: TransactionType.TRANSFER,
              destinationPlayerId: c.playerId,
              reference: 'بازگشت ودیهٔ نامزدی'
            }
          })
        }
        return candidates.map((c) => c.playerId)
      })

      // ودیه بی‌صدا به کیف نامزدها برمی‌گشت؛ پولی که بازیکن خودش پرداخت کرده
      // باید برگشتش را ببیند. کلید ضدتکرار ترکیبی از دورهٔ انتخابات و نامزد
      // است تا در هر دوره هر نامزد فقط یک خبر بگیرد.
      for (const candidateId of refunded) {
        await this.notificationService
          ?.announce({
            playerId: candidateId,
            type: NotificationType.EVENT,
            level: 'CRITICAL',
            dedupeKey: `candidacy-refund:${election.id}:${candidateId}`,
            title: '🗳️ ودیهٔ نامزدی برگشت',
            message: [
              `انتخابات «${election.title}» بسته شد.`,
              `ودیهٔ ${money(CANDIDACY_DEPOSIT)} تومان به کیفت برگشت.`,
              winnerId === candidateId
                ? '🏆 تو برندهٔ انتخابات شدی؛ از پنل «شهر» می‌توانی نرخ بگذاری و پروژهٔ عمومی باز کنی.'
                : 'دورهٔ بعدی نامزدی از پنل «شهر» باز می‌شود.'
            ].join('\n')
          })
          .catch(() => undefined)
      }

      if (winnerId) {
        const w = await this.db.player.findUnique({
          where: { id: winnerId },
          select: { id: true, firstName: true, lastName: true }
        })
        if (w) {
          await this.eventService
            .recordRegionEvent({
              groupId,
              type: GameEventType.ELECTION_WON,
              title: `🗳️ ${w.firstName} به‌عنوان شهردار جدید انتخاب شد!`,
              dedupeKey: `election-win:${election.id}`,
              priority: 4
            })
            .catch(() => {})

          // شهردار تازه اختیارات واقعی دارد (سیاست‌گذاری، پروژهٔ شهری)؛ خبرِ
          // شخصی لازم است تا نداند «برنده شدم» فقط یک عنوان تشریفاتی نیست.
          await this.notificationService
            ?.announce({
              playerId: winnerId,
              type: NotificationType.EVENT,
              level: 'IMPORTANT',
              dedupeKey: `mayor-won:${election.id}`,
              title: '🏆 شهردار منطقه شدی',
              message: [
                `انتخابات «${election.title}» تمام شد و تو با بیشترین رأی برنده شدی.`,
                'حالا در پنل «شهر» می‌توانی نرخ‌ها را تعیین کنی و پروژهٔ عمومی آغاز کنی.',
                'دورهٔ شهرداری محدود است؛ تا پایانش از اختیاراتت استفاده کن.'
              ].join('\n')
            })
            .catch(() => undefined)
        }
      }
    }
  }

  /** ساخت یا یافتن انتخابات بازِ جاری. */
  private async getOrCreateOpenElection(groupId: string) {
    const existing = await this.db.election.findFirst({
      where: { groupId, status: 'OPEN' }
    })
    if (existing) return existing

    try {
      return await this.db.election.create({
        data: {
          groupId,
          title: 'انتخابات شهردار',
          status: 'OPEN',
          endsAt: new Date(Date.now() + MAYOR_TERM_MS)
        }
      })
    } catch (error) {
      // دو نامزدیِ همزمانِ لحظهٔ شروع دوره: ایندکسِ partial یکتا
      // (یک OPEN به‌ازای هر منطقه) اجازهٔ دورهٔ دوم نمی‌دهد؛ همان دورهٔ
      // تازه‌ساخته‌شدهٔ رقیب برمی‌گردد تا ودیه و نامزدی روی همان بنشیند.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const winner = await this.db.election.findFirst({
          where: { groupId, status: 'OPEN' }
        })
        if (winner) return winner
      }
      throw error
    }
  }
}
