import { PrismaClient } from '@prisma/client'
import { logger } from '../../utils/logger'
import { ResidenceService } from '../residence/residence.service'
import { RewardsService } from '../rewards/rewards.service'

/**
 * فعالیت‌هایی که «Gameplay واقعی» محسوب می‌شوند.
 * تنها این فعالیت‌ها می‌توانند باعث تعیین اقامت اولیه شوند.
 * دیدن پیام، عضو شدن در گروه، /start یا ورودی نامعتبر در این فهرست نیست.
 */
export const VALID_ACTIVITY_SECTIONS = new Set<string>([
  'identity',
  'status',
  'occupation',
  'my_biz',
  'education',
  'housing',
  'banking',
  'shop',
  'inventory',
  'mission',
  'credit',
  'ledger',
  'stats',
  'quests',
  'achievements',
  'fortune',
  'streak',
  'lottery',
  'deposits',
  'clinic',
  'rental',
  'passport',
  'family',
  'pets',
  'auction',
  'gym',
  'loans',
  'challenge',
  'policy',
  'branches',
  'ads',
  'report',
  'history',
  'my_job',
  'market'
])

export interface ActivityResult {
  /** آیا این فعالیت باعث ثبت اقامت اولیه شد؟ */
  residenceEstablished: boolean
  /** عنوان منطقه‌ای که اقامت در آن ثبت شد. */
  residenceTitle?: string
  /**
   * شناسهٔ داخلی بازیکن و منطقه، تنها وقتی فعالیت معتبر و در گروه بوده است.
   *
   * مصرف‌کننده‌ها (مُهر سفر، کارت روزانه) از همین مقادیر استفاده می‌کنند تا
   * دوباره Query نزنند؛ مسیر داغ پیام‌های گروه سنگین نمی‌شود.
   */
  playerId?: string
  groupId?: string
}

/**
 * موتور فعالیت.
 *
 * تنها نقطهٔ مرکزی تعیین اقامت اولیه؛ این منطق در هیچ Handler دیگری تکرار نمی‌شود.
 * برای کاهش بار دیتابیس، فقط زمانی Query اجرا می‌شود که فعالیت واقعاً معتبر باشد
 * و بازیکن هنوز اقامت نداشته باشد.
 */
export class ActivityService {
  constructor(
    private readonly db: PrismaClient,
    private readonly residenceService: ResidenceService,
    private readonly rewardsService: RewardsService
  ) {}

  /** آیا این بخش یک فعالیت معتبر Gameplay است؟ */
  isValidActivity(section: string): boolean {
    return VALID_ACTIVITY_SECTIONS.has(section)
  }

  /**
   * ثبت فعالیت بازیکن در یک منطقه.
   * اگر اولین فعالیت معتبر باشد، اقامت ثبت می‌شود؛ در غیر این صورت فقط
   * حضور موقت (Travel) به‌روزرسانی می‌گردد.
   *
   * این‌جا همچنین *عضویت محلی* بازیکن تثبیت می‌شود: رأی در انتخابات، رتبهٔ
   * گروه، مقاصد مهاجرت و جمعیت منطقه همه به ردیف PlayerGroup تکیه دارند؛
   * بازیکنی که در گروه فعالیت می‌کند باید عضو همان منطقه هم باشد، حتی اگر
   * هیچ‌وقت در آن گروه /start نفرستاده باشد.
   */
  async registerActivity(
    telegramUserId: bigint,
    telegramGroupId: bigint | null,
    section: string
  ): Promise<ActivityResult> {
    if (!this.isValidActivity(section)) {
      return { residenceEstablished: false }
    }

    // فعالیت در چت خصوصی هرگز اقامت ایجاد نمی‌کند
    if (telegramGroupId === null) {
      return { residenceEstablished: false }
    }

    try {
      const player = await this.db.player.findUnique({
        where: { telegramUserId },
        select: { id: true, homeGroupId: true, status: true }
      })
      if (!player) {
        return { residenceEstablished: false }
      }

      // شخصیتِ پایان‌یافته یا مسدود دیگر بازیکن فعال نیست؛ حضورش در گروه
      // نباید اقامت، عضویت یا پاداشی تازه بسازد.
      if (player.status === 'DEAD' || player.status === 'BANNED') {
        return { residenceEstablished: false }
      }

      const group = await this.db.group.findUnique({
        where: { telegramGroupId },
        select: { id: true, title: true, status: true }
      })
      if (!group || group.status !== 'ACTIVE') {
        return { residenceEstablished: false }
      }

      // تثبیت عضویت محلی. ردیف موجود ارتقا می‌یابد نه تنزل:
      // «ترک کرده» با فعالیت دوباره فعال می‌شود، اما «اخراج/مسدود» دست‌نخورده
      // می‌ماند تا دور زدن مجازات با یک پیام ممکن نشود.
      const membership = await this.db.playerGroup.findUnique({
        where: { playerId_groupId: { playerId: player.id, groupId: group.id } },
        select: { status: true }
      })
      if (!membership) {
        await this.db.playerGroup.create({
          data: { playerId: player.id, groupId: group.id }
        })
      } else if (membership.status === 'LEFT') {
        await this.db.playerGroup.update({
          where: { playerId_groupId: { playerId: player.id, groupId: group.id } },
          data: { status: 'ACTIVE' }
        })
      }

      // اقامت از قبل تعیین شده: فقط حضور موقت ثبت می‌شود (Group ≠ Residence)
      if (player.homeGroupId) {
        await this.residenceService.trackPresence(player.id, group.id)
        return {
          residenceEstablished: false,
          playerId: player.id,
          groupId: group.id
        }
      }

      const { established } = await this.residenceService.establishInitialResidence(
        player.id,
        group.id
      )

      if (established) {
        await this.residenceService.trackPresence(player.id, group.id)

        // مرحلهٔ دوم پاداش معرفی: معرف با اقامت گرفتن دعوت‌شده پاداش می‌گیرد
        await this.rewardsService
          .settleReferralResidenceBonus(player.id)
          .catch((error: unknown) => {
            logger.debug({ err: error, playerId: player.id }, 'referral residence bonus failed')
          })

        return {
          residenceEstablished: true,
          residenceTitle: group.title,
          playerId: player.id,
          groupId: group.id
        }
      }

      return {
        residenceEstablished: false,
        playerId: player.id,
        groupId: group.id
      }
    } catch (error) {
      // ثبت فعالیت هرگز نباید مسیر اصلی بازی را بشکند
      logger.debug({ err: error, section }, 'failed to register activity')
      return { residenceEstablished: false }
    }
  }
}
