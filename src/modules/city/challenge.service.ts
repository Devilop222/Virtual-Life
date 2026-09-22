import { GameEventType, PrismaClient, TransactionType } from '@prisma/client'
import { ConflictError, NotFoundError } from '../../utils/classes/errors'
import { EventService } from '../events/event.service'
import { cycleAmount, weekIndex, stableHash } from '../../utils/game-time'

export interface ChallengeGoal {
  key: string
  title: string
  emoji: string
  /** تعداد مشارکت لازم برای تکمیل. */
  target: number
  unit: string
}

/** اهداف چرخشی هفتگی؛ انتخاب قطعی با hash منطقه + هفته. */
export const CHALLENGE_GOALS: readonly ChallengeGoal[] = [
  { key: 'work_shifts', title: 'انجام شیفت‌های کاری', emoji: '💼', target: 40, unit: 'شیفت' },
  { key: 'market_trades', title: 'معامله در بازار بازیکنان', emoji: '🤝', target: 15, unit: 'معامله' },
  { key: 'travel_stamps', title: 'کسب مُهر سفر تازه', emoji: '🧭', target: 8, unit: 'مُهر' }
]

/** پاداش هر مشارکت‌کننده پس از تکمیل هدف. */
/**
 * پاداش چالش هفتگی هر بازیکن.
 *
 * چالش روی «هفتـهٔ بازی» است (۵٫۶ ساعت واقعی)، پس مبلغ با `cycleAmount`
 * هم‌تراز شده تا درآمد چالش در زمان واقعی همان قبلی بماند.
 */
export const CHALLENGE_REWARD = cycleAmount(150_000)

export interface ChallengeView {
  goalTitle: string
  emoji: string
  targetValue: number
  currentValue: number
  progressPercent: number
  isCompleted: boolean
  myContributed: number
  canClaimReward: boolean
  rewardPerPlayer: number
  unit: string
}

/**
 * چالش جمعی هفتگی منطقه.
 *
 * هر هفته یک هدف برای منطقه انتخاب می‌شود (قطعی، بدون تایمر). ساکنان با
 * انجام همان کارهای روزمره (کار، معامله، سفر) امتیاز جمعی می‌سازند و اگر هدف
 * کامل شود، هر مشارکت‌کننده یک بار پاداش ثابت می‌گیرد.
 *
 * Idempotency پاداش با Unique روی (چالش، بازیکن) + شرط claimedAt تضمین شده است.
 */
export class ChallengeService {
  constructor(
    private readonly db: PrismaClient,
    private readonly eventService: EventService
  ) {}

  private goalFor(groupId: string, week: number): ChallengeGoal {
    const index = stableHash(`challenge:${groupId}:${week}`) % CHALLENGE_GOALS.length
    return CHALLENGE_GOALS[index]!
  }

  /** چالش جاری منطقه را می‌سازد اگر نباشد. */
  async getOrCreateCurrent(groupId: string): Promise<string> {
    const week = weekIndex()
    const existing = await this.db.regionalChallenge.findFirst({
      where: { groupId, weekKey: week }
    })
    if (existing) {
      return existing.id
    }

    const goal = this.goalFor(groupId, week)
    const created = await this.db.regionalChallenge.create({
      data: {
        groupId,
        weekKey: week,
        goalKey: goal.key,
        goalTitle: goal.title,
        targetValue: goal.target,
        rewardPerPlayer: CHALLENGE_REWARD
      }
    })
    return created.id
  }

  /**
   * ثبت امتیاز مشارکت بازیکن در چالش جاری.
   * خطاها بی‌صدا نادیده گرفته می‌شوند تا مسیر اصلی بازی نشکند.
   */
  async addProgress(groupId: string, playerId: string): Promise<void> {
    try {
      const challengeId = await this.getOrCreateCurrent(groupId)

      await this.db.regionalChallengeContribution.upsert({
        where: { challengeId_playerId: { challengeId, playerId } },
        create: { challengeId, playerId, points: 1 },
        update: { points: { increment: 1 } }
      })

      // بازمحاسبهٔ مجموع و تکمیل
      const agg = await this.db.regionalChallengeContribution.aggregate({
        where: { challengeId },
        _sum: { points: true }
      })
      const total = agg._sum.points ?? 0

      const challenge = await this.db.regionalChallenge.findUniqueOrThrow({
        where: { id: challengeId },
        select: { targetValue: true, isCompleted: true }
      })

      if (!challenge.isCompleted && total >= challenge.targetValue) {
        const completed = await this.db.regionalChallenge.updateMany({
          where: { id: challengeId, isCompleted: false },
          data: { isCompleted: true, currentValue: total, completedAt: new Date() }
        })
        if (completed.count === 1) {
          await this.eventService
            .recordRegionEvent({
              groupId,
              type: GameEventType.CHALLENGE_COMPLETED,
              priority: 4,
              title: '🎉 چالش هفتگی منطقه کامل شد!',
              detail: 'همهٔ مشارکت‌کنندگان می‌توانند پاداششان را بگیرند.',
              dedupeKey: `chal-done:${challengeId}`
            })
            .catch(() => undefined)
          return
        }
      }

      await this.db.regionalChallenge.updateMany({
        where: { id: challengeId },
        data: { currentValue: total }
      })
    } catch {
      // چالش هرگز مسیر اصلی را نمی‌شکند
    }
  }

  /** دریافت پاداش مشارکت‌کننده پس از تکمیل چالش. */
  async claimReward(
    telegramUserId: bigint
  ): Promise<{ amount: number; goalTitle: string }> {
    const player = await this.db.player.findUnique({
      where: { telegramUserId },
      select: { id: true }
    })
    if (!player) {
      throw new NotFoundError('Player not found')
    }

    const contribution = await this.db.regionalChallengeContribution.findFirst({
      where: {
        playerId: player.id,
        claimedAt: null,
        challenge: { isCompleted: true }
      },
      orderBy: { updatedAt: 'desc' },
      include: { challenge: { select: { id: true, goalTitle: true } } }
    })
    if (!contribution) {
      throw new ConflictError(
        'Nothing to claim',
        'پاداش فعالی برای تو نیست؛ یا چالش هنوز کامل نشده یا قبلاً گرفته‌ای.'
      )
    }

    await this.db.$transaction(async (tx) => {
      const locked = await tx.regionalChallengeContribution.updateMany({
        where: { id: contribution.id, claimedAt: null },
        data: { claimedAt: new Date() }
      })
      if (locked.count !== 1) {
        throw new ConflictError('Concurrent claim', 'پاداش همین حالا پرداخت شد.')
      }

      await tx.player.update({
        where: { id: player.id },
        data: { balance: { increment: CHALLENGE_REWARD } }
      })
      // پاداش چالش پیش‌تر بدون هیچ ردیف دفتر کلی به کیف پول اضافه می‌شد:
      // پول «از هیچ» ساخته می‌شد و آشتی‌دادن دفتر کل با موجودی می‌شکست.
      await tx.financialTransaction.create({
        data: {
          amount: CHALLENGE_REWARD,
          type: TransactionType.REWARD_PAYOUT,
          destinationPlayerId: player.id,
          reference: `پاداش چالش منطقه — ${contribution.challenge.goalTitle}`
        }
      })
    })

    await this.eventService
      .recordPlayerEvent({
        playerId: player.id,
        type: GameEventType.CHALLENGE_COMPLETED,
        title: '🎁 پاداش چالش منطقه',
        amount: CHALLENGE_REWARD,
        dedupeKey: `chal-reward:${contribution.challengeId}:${player.id}`
      })
      .catch(() => undefined)

    return { amount: CHALLENGE_REWARD, goalTitle: contribution.challenge.goalTitle }
  }

  /** نمای چالش جاری برای ساکن منطقه. */
  async getView(
    telegramUserId: bigint | null,
    groupId: string
  ): Promise<ChallengeView> {
    const challengeId = await this.getOrCreateCurrent(groupId)
    const challenge = await this.db.regionalChallenge.findUniqueOrThrow({
      where: { id: challengeId }
    })
    const goal =
      CHALLENGE_GOALS.find((g) => g.key === challenge.goalKey) ??
      ({ emoji: '🎯', unit: 'بار' } as ChallengeGoal)

    let myContributed = 0
    let canClaim = false

    if (telegramUserId !== null) {
      const player = await this.db.player.findUnique({
        where: { telegramUserId },
        select: { id: true }
      })
      if (player) {
        const contribution = await this.db.regionalChallengeContribution.findUnique({
          where: { challengeId_playerId: { challengeId, playerId: player.id } }
        })
        myContributed = contribution?.points ?? 0
        canClaim = Boolean(contribution && !contribution.claimedAt && challenge.isCompleted)
      }
    }

    return {
      goalTitle: challenge.goalTitle,
      emoji: goal.emoji,
      targetValue: challenge.targetValue,
      currentValue: Math.min(challenge.currentValue, challenge.targetValue),
      progressPercent: Math.min(
        100,
        Math.round((challenge.currentValue / Math.max(1, challenge.targetValue)) * 100)
      ),
      isCompleted: challenge.isCompleted,
      myContributed,
      canClaimReward: canClaim,
      rewardPerPlayer: Number(challenge.rewardPerPlayer),
      unit: goal.unit
    }
  }
}

export const CHALLENGE_INFO = {
  goals: CHALLENGE_GOALS,
  reward: CHALLENGE_REWARD
} as const
