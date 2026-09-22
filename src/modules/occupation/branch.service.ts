import { GameEventType, PrismaClient, TransactionType } from '@prisma/client'
import { ConflictError, NotFoundError } from '../../utils/classes/errors'
import { EventService } from '../events/event.service'
import { TaxService } from '../economy/tax.service'
import { cycleAmount, gameDaysSince, realDaysAsGameDays } from '../../utils/game-time'

/** هزینهٔ راه‌اندازی هر شعبه (یک‌باره). */
export const BRANCH_SETUP_COST = 15_000_000
/** حداکثر شعبه برای هر کسب‌وکار. */
const MAX_BRANCHES_PER_BUSINESS = 2
/**
 * درآمد هر روز *بازی* شعبه — Lazy تا سقف انباشت.
 *
 * مبلغ با `cycleAmount` هم‌تراز شده است؛ چون شعبه هر روز بازی (۴۸ دقیقهٔ
 * واقعی) درآمد می‌سازد و بدون این هم‌ترازی، درآمد در زمان واقعی ۳۰ برابر
 * می‌شد.
 */
export const BRANCH_INCOME_PER_DAY = cycleAmount(400_000)
/** سقف انباشت درآمد: همان پنجرهٔ ۷ روزِ واقعیِ قبلی، بیان‌شده در روزهای بازی. */
const MAX_ACCUMULATE_DAYS = realDaysAsGameDays(7)

export interface BranchView {
  id: string
  businessName: string
  regionTitle: string
  pendingIncome: number
  pendingDays: number
  openedAt: Date
}

/**
 * شعبهٔ کسب‌وکار در مناطق دیگر.
 *
 * مدل مالی:
 *  • راه‌اندازی هزینهٔ سنگین یک‌باره دارد و Sink است.
 *  • شعبه درآمد غیرفعال می‌سازد که Lazy هنگام بازدید مالک برداشت می‌شود؛
 *    انباشت به سقف ۷ روز محدود است تا بازیکن غایب هم بی‌نهایت ذخیره نکند.
 *  • درآمد از هیچ ساخته نمی‌شود؟ می‌شود — پس نرخ عمداً پایین نگه داشته شده
 *    (۴۰۰ هزار در روز در برابر سرمایهٔ ۱۵ میلیون ≈ بازگشت ~۵ هفته) تا رقابت
 *    با کار فعال منصفانه بماند.
 */
export class BranchService {
  constructor(
    private readonly db: PrismaClient,
    private readonly eventService: EventService
  ) {}

  /** افتتاح شعبه در منطقهٔ مقصد. */
  async openBranch(
    ownerTgId: bigint,
    businessId: string,
    targetGroupId: string
  ): Promise<{ businessName: string; regionTitle: string; cost: number }> {
    const owner = await this.db.player.findUnique({
      where: { telegramUserId: ownerTgId },
      select: { id: true }
    })
    if (!owner) {
      throw new NotFoundError('Player not found')
    }

    const business = await this.db.business.findUnique({ where: { id: businessId } })
    if (!business || business.ownerId !== owner.id) {
      throw new NotFoundError('Business not found', 'این کسب‌وکار متعلق به تو نیست. از «کسب‌وکار» شرکت خودت را انتخاب کن.')
    }
    if (business.status !== 'ACTIVE') {
      throw new ConflictError('Business closed', 'کسب‌وکار تعطیل امکان افتتاح شعبه ندارد.')
    }

    const branchCount = await this.db.businessBranch.count({
      where: { businessId, status: 'ACTIVE' }
    })
    if (branchCount >= MAX_BRANCHES_PER_BUSINESS) {
      throw new ConflictError(
        'Branch limit',
        `هر کسب‌وکار حداکثر ${MAX_BRANCHES_PER_BUSINESS.toLocaleString('fa-IR')} شعبه می‌تواند داشته باشد.`
      )
    }

    const targetGroup = await this.db.group.findFirst({
      where: { id: targetGroupId, status: 'ACTIVE' },
      select: { title: true }
    })
    if (!targetGroup) {
      throw new NotFoundError('Region not found', 'منطقهٔ مقصد یافت نشد.')
    }

    await this.db.$transaction(async (tx) => {
      const debited = await tx.player.updateMany({
        where: { id: owner.id, balance: { gte: BRANCH_SETUP_COST } },
        data: { balance: { decrement: BRANCH_SETUP_COST } }
      })
      if (debited.count !== 1) {
        throw new ConflictError(
          'Insufficient balance',
          `راه‌اندازی شعبه ${BRANCH_SETUP_COST.toLocaleString('fa-IR')} تومان هزینه دارد.`
        )
      }

      // Unique روی (کسب‌وکار، منطقه): شعبهٔ تکراری ناممکن است
      await tx.businessBranch.create({
        data: { businessId, groupId: targetGroupId }
      })

      await tx.financialTransaction.create({
        data: {
          amount: BRANCH_SETUP_COST,
          type: TransactionType.BRANCH_SETUP,
          sourcePlayerId: owner.id,
          reference: `افتتاح شعبهٔ ${business.name} در ${targetGroup.title}`
        }
      })
    })

    await this.eventService
      .recordRegionEvent({
        groupId: targetGroupId,
        type: GameEventType.BRANCH_OPENED,
        priority: 3,
        title: `🏢 شعبهٔ تازهٔ «${business.name}» در این منطقه افتتاح شد`,
        dedupeKey: `branch:${businessId}:${targetGroupId}`
      })
      .catch(() => undefined)

    return {
      businessName: business.name,
      regionTitle: targetGroup.title,
      cost: BRANCH_SETUP_COST
    }
  }

  /** برداشت درآمد انباشتهٔ یک شعبه. */
  async collectIncome(
    ownerTgId: bigint,
    branchId: string
  ): Promise<{ amount: number; tax: number; net: number; days: number; regionTitle: string }> {
    const owner = await this.db.player.findUnique({
      where: { telegramUserId: ownerTgId },
      select: { id: true }
    })
    if (!owner) {
      throw new NotFoundError('Player not found')
    }

    const branch = await this.db.businessBranch.findUnique({
      where: { id: branchId },
      include: {
        business: { select: { ownerId: true, name: true } },
        group: { select: { title: true } }
      }
    })
    if (!branch || branch.business.ownerId !== owner.id) {
      throw new NotFoundError('Branch not found', 'این شعبه متعلق به تو نیست. از «شعبه» شعبه‌های کسب‌وکار خودت را ببین.')
    }
    if (branch.status !== 'ACTIVE') {
      throw new ConflictError('Branch closed', 'این شعبه فعال نیست.')
    }

    const elapsedDays = gameDaysSince(branch.lastCollectedAt)
    const payableDays = Math.min(elapsedDays, MAX_ACCUMULATE_DAYS)
    if (payableDays < 1) {
      throw new ConflictError(
        'Nothing to collect',
        'درآمد تازه هنوز انباشته نشده؛ فردا سر بزن.'
      )
    }

    const amount = payableDays * Math.round(Number(branch.incomePerDay))

    let tax = 0
    await this.db.$transaction(async (tx) => {
      // شرط زمان برداشت قبلی: دو کلیک همزمان دوبار پرداخت نمی‌کند
      const locked = await tx.businessBranch.updateMany({
        where: {
          id: branch.id,
          lastCollectedAt: branch.lastCollectedAt
        },
        data: { lastCollectedAt: new Date() }
      })
      if (locked.count !== 1) {
        throw new ConflictError('Concurrent collect', 'برداشت همین حالا انجام شد.')
      }

      // درآمد شعبه «سود توزیع‌شده» است: مالیات ۱۵٪ همان‌جا کسر می‌شود و به
      // صندوق منطقهٔ شعبه می‌رسد (نه به هیچ‌جا، مثل قبل).
      tax = await new TaxService().takeProfitTax(tx, {
        playerId: owner.id,
        amount,
        reference: `درآمد شعبهٔ ${branch.group.title}`,
        groupId: branch.groupId,
        sourceBusinessId: branch.businessId
      })

      await tx.player.update({
        where: { id: owner.id },
        data: { balance: { increment: amount - tax } }
      })
      await tx.financialTransaction.create({
        data: {
          amount,
          type: TransactionType.BUSINESS_REVENUE,
          destinationPlayerId: owner.id,
          reference: `درآمد شعبهٔ ${branch.group.title}`
        }
      })
    })

    return {
      amount,
      tax,
      net: amount - tax,
      days: payableDays,
      regionTitle: branch.group.title
    }
  }

  /** فهرست شعب مالک با درآمد در انتظار. */
  async getOwnerBoard(
    telegramUserId: bigint
  ): Promise<{
    branches: BranchView[]
    businesses: Array<{ id: string; name: string }>
    setupCost: number
    incomePerDay: number
  }> {
    const owner = await this.db.player.findUnique({
      where: { telegramUserId },
      select: { id: true }
    })
    if (!owner) {
      throw new NotFoundError('Player not found')
    }

    const [branches, businesses] = await Promise.all([
      this.db.businessBranch.findMany({
        where: { business: { ownerId: owner.id }, status: 'ACTIVE' },
        orderBy: { createdAt: 'desc' },
        include: {
          business: { select: { name: true } },
          group: { select: { title: true } }
        }
      }),
      this.db.business.findMany({
        where: { ownerId: owner.id, status: 'ACTIVE' },
        select: { id: true, name: true }
      })
    ])

    return {
      branches: branches.map((branch) => {
        const elapsedDays = gameDaysSince(branch.lastCollectedAt)
        const pendingDays = Math.min(elapsedDays, MAX_ACCUMULATE_DAYS)
        return {
          id: branch.id,
          businessName: branch.business.name,
          regionTitle: branch.group.title,
          pendingDays,
          pendingIncome: pendingDays * Math.round(Number(branch.incomePerDay)),
          openedAt: branch.createdAt
        }
      }),
      businesses,
      setupCost: BRANCH_SETUP_COST,
      incomePerDay: BRANCH_INCOME_PER_DAY
    }
  }

  /**
   * مناطق فعال برای انتخاب مقصد شعبه.
   *
   * ترتیب با «جمعیت بازی» است، نه با شمارِ اعضای تلگرام: عضوی که شخصیت
   * نساخته مشتریِ شعبه نیست و نباید ترتیب را عوض کند.
   */
  async listTargetRegions(): Promise<Array<{ id: string; title: string }>> {
    return this.db.group.findMany({
      where: { status: 'ACTIVE' },
      orderBy: [{ gamePopulation: 'desc' }, { createdAt: 'asc' }],
      take: 8,
      select: { id: true, title: true }
    })
  }
}

export const BRANCH_INFO = {
  setupCost: BRANCH_SETUP_COST,
  incomePerDay: BRANCH_INCOME_PER_DAY,
  maxPerBusiness: MAX_BRANCHES_PER_BUSINESS
} as const
