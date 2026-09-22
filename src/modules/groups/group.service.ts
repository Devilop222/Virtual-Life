import {
  Group,
  GroupEnvironmentLevel,
  GroupType,
  PlayerGroupActivity,
  PlayerGroupRole,
  PlayerGroupStatus
} from '@prisma/client'
import { fa } from '../../utils/format'
import { REGION_CONFIG } from '../../config/region.config'
import { GroupRepository } from '../../database/repositories/group.repository'
import { PlayerGroupRepository } from '../../database/repositories/player-group.repository'
import { PlayerRepository } from '../../database/repositories/player.repository'
import { NotFoundError } from '../../utils/classes/errors'
import { plainInput } from '../../utils/validation'
import { EnvironmentClassifier } from './environment.classifier'
import { logger } from '../../utils/logger'

/**
 * عنوان گروه مستقیماً از تلگرام می‌آید و کاملاً در اختیار کاربر است.
 * همان‌جا که نام بازیکن در ثبت‌نام پاک‌سازی می‌شود، عنوان منطقه هم باید در
 * مرز ورود پاک شود: این عنوان در پنل شناسنامه، وضعیت منطقه، خبر، رتبه‌بندی
 * مناطق، مهاجرت و پنل ادمین با parse_mode مارک‌داون رندر می‌شود. بدون پاک‌سازی
 * یک عنوان مثل `*[x](t.me/...)*` هم کل پنل را ارسال‌نشدنی می‌کند و هم لینک
 * دلخواه در پیام‌های بازی جا می‌گذارد.
 */
export function sanitizeGroupTitle(title: string): string {
  return plainInput(title) || 'بدون عنوان'
}

/**
 * اطلاعات اعضای گروه از تلگرام.
 *
 * `null` یعنی «تلگرام این عدد را به ما نداد» (مثلاً ربات ادمین گروه نیست)؛
 * با صفر فرق دارد. صفر یک عدد واقعی است و سطح محیط را به روستا می‌برد، ولی
 * `null` فقط یعنی «نمی‌دانیم» و هرگز نباید مقدار قبلی دیتابیس را بازنویسی کند.
 */
export interface MemberInfo {
  totalCount: number | null
  realMemberCount: number | null
  ownerTelegramUserId?: bigint
  adminTelegramUserIds: bigint[]
}

export interface MemberInfoProvider {
  getMemberInfo(telegramGroupId: bigint): Promise<MemberInfo>
}

/**
 * ورودی ثبت/همگام‌سازی گروه.
 *
 * تعداد اعضا عمداً اینجا نیست: تنها منبع حقیقتِ جمعیت، تلگرام است
 * (`MemberInfoProvider`). اگر فراخوان‌کننده هم عددی بدهد، عدد نامشخصِ
 * تلگرام را با یک حدس بازنویسی می‌کرد — همان ریشهٔ باگ «سطح محیط: نامشخص».
 */
export interface RegisterGroupInput {
  telegramGroupId: bigint
  title: string
  type: GroupType
}

export interface EnsureGroupResult {
  group: Group
  /** این فراخوانی گروه را تازه ساخته است؟ */
  created: boolean
  environmentChanged: boolean
  /** سطحِ قبلی، اگر همین فراخوانی عوضش کرده باشد. */
  levelChangedFrom: GroupEnvironmentLevel | null
  /** مهرِ همان تغییر — کلیدِ ضدتکرار اعلان از همین ساخته می‌شود. */
  levelChangedAt: Date | null
  /** شمارِ اعضای تلگرام از تلگرام خوانده شد؟ */
  memberCountSynced: boolean
}

/**
 * جمعیتِ بازی یک منطقه: شمارِ شهروندانِ دارای عضویتِ فعال.
 *
 * این تنها معیارِ سطح محیط است. `realMemberCount` (شمارِ اعضای تلگرام منهای
 * ربات‌ها) عمداً در طبقه‌بندی دخالت نمی‌کند: عضوی که شخصیت نساخته و هیچ‌جای
 * اقتصاد بازی نیست، شهروند حساب نمی‌شود.
 */
export interface EnvironmentRefresh {
  gamePopulation: number
  environmentLevel: GroupEnvironmentLevel
  /** سطح قبل از این بازمحاسبه (برای ساخت اعلانِ تغییر)؛ اگر تغییر نکرده `null`. */
  levelChangedFrom: GroupEnvironmentLevel | null
  /** مهرِ زمانِ همان تغییرِ واقعی؛ اگر سطحی عوض نشده `null`. */
  levelChangedAt: Date | null
  /** ردیفِ گروه عوض شد؟ */
  changed: boolean
}

/**
 * جدول آستانه‌های سطح محیط، به شکل آمادهٔ نمایش.
 * از همان `REGION_CONFIG` خوانده می‌شود که منطق طبقه‌بندی می‌خواند؛ پس
 * متن راهنما و رفتار واقعی هرگز از هم جدا نمی‌افتند.
 */
export function environmentThresholdsText(): string {
  const t = REGION_CONFIG.populationThresholds
  const span = (min: number, max: number | null): string =>
    max === null
      ? `از ${fa(min)}`
      : min === max
        ? `${fa(min)}`
        : `${fa(min)} تا ${fa(max)}`
  return [
    `${ENVIRONMENT_LABELS[GroupEnvironmentLevel.VILLAGE]}: ${span(t.village.min, t.village.max)}`,
    `${ENVIRONMENT_LABELS[GroupEnvironmentLevel.CITY]}: ${span(t.city.min, t.city.max)}`,
    `${ENVIRONMENT_LABELS[GroupEnvironmentLevel.PROVINCE]}: ${span(t.province.min, t.province.max)}`,
    `${ENVIRONMENT_LABELS[GroupEnvironmentLevel.COUNTRY]}: ${span(t.country.min, t.country.max)}`
  ].join(' · ')
}

/**
 * سقفِ تعداد مناطقی که یک چرخه بازبینی می‌کند.
 *
 * مناطق (گروه‌های تلگرام) در برابر بازیکن‌ها کماند، ولی عدد بسته است تا یک
 * انفجارِ ثبت گروه هم‌زمان، چرخه را به یک پرس‌وجوی سنگین تبدیل نکند.
 */
export const ENVIRONMENT_SWEEP_BATCH = 100

/**
 * سقفِ صفحه‌های یک چرخهٔ بازبینی (۱۰ × ۱۰۰ = ۱۰۰۰ منطقه در هر تیک).
 *
 * چرخه باید **همهٔ** مناطق را ببیند ولی نباید به یک پرس‌وجوی بی‌کران تبدیل شود؛
 * صفحه‌بندی با کلیدِ شناسه دقیقاً همین را می‌دهد: پوششِ کامل در چند تیک، بدون
 * فشارِ هم‌زمان. جایگزینش (یک `take: 100` ساده) قدیمی‌ترین مناطق را برای همیشه
 * از بازبینی جا می‌گذاشت.
 */
export const ENVIRONMENT_SWEEP_PAGES = 10

/**
 * یک تغییرِ خودکارِ سطحِ منطقه — دادهٔ لازم برای خبر و اعلان.
 *
 * نام تاریخی‌اش «Promotion» ماند ولی جهتِ تغییر در `from`/`to` است: تنزل
 * همان‌قدر واقعی است و پیامِ خودش را دارد.
 */
export interface EnvironmentPromotion {
  groupId: string
  groupTitle: string
  from: GroupEnvironmentLevel
  to: GroupEnvironmentLevel
  population: number
  ownerTelegramUserId: bigint | null
  /** مهرِ این تغییرِ خاص (ISO) — در کلیدِ ضدتکرار اعلان می‌نشیند. */
  at: string
}

export class GroupService {
  constructor(
    private readonly groupRepository: GroupRepository,
    private readonly playerGroupRepository: PlayerGroupRepository,
    private readonly playerRepository: PlayerRepository,
    private readonly memberInfoProvider: MemberInfoProvider,
    private readonly classifier: EnvironmentClassifier
  ) {}

  private async syncLeadershipRoles(
    groupId: string,
    memberInfo: MemberInfo
  ): Promise<void> {
    const candidates: Array<{ id: bigint; role: PlayerGroupRole }> = []
    if (memberInfo.ownerTelegramUserId) {
      candidates.push({ id: memberInfo.ownerTelegramUserId, role: PlayerGroupRole.OWNER })
    }
    for (const adminId of memberInfo.adminTelegramUserIds) {
      if (adminId !== memberInfo.ownerTelegramUserId) {
        candidates.push({ id: adminId, role: PlayerGroupRole.ADMIN })
      }
    }

    if (candidates.length === 0) {
      return
    }

    // یک Query برای همهٔ نامزدها؛ پیش‌تر به‌ازای هر ادمین یک SELECT می‌رفت (N+1)
    const playerIds = await this.playerRepository.findIdsByTelegramUserIds(
      candidates.map((candidate) => candidate.id)
    )
    if (playerIds.size === 0) {
      return
    }

    await Promise.all(
      candidates.map(async (candidate) => {
        const playerId = playerIds.get(candidate.id)
        if (!playerId) return
        await this.playerGroupRepository.upsert({
          playerId,
          groupId,
          role: candidate.role,
          status: PlayerGroupStatus.ACTIVE
        })
      })
    )
  }

  /**
   * همگام‌سازی گروه با تلگرام؛ تنها نقطهٔ ثبت/به‌روزرسانی گروه.
   *
   * سه قانون:
   *  ۱. گروه همیشه ثبت می‌شود — حتی اگر تلگرام اطلاعات اعضا ندهد.
   *  ۲. عدد نامشخص (`null`) هرگز جای عدد ذخیره‌شده را نمی‌گیرد.
   *  ۳. سطح محیط از جمعیتِ بازی (شهروندانِ ثبت‌شده) می‌آید، نه از شمارِ
   *     اعضای تلگرام.
   */
  async ensureGroupUpdated(input: RegisterGroupInput): Promise<EnsureGroupResult> {
    // عنوان پاک‌سازی‌شده هم برای مقایسه و هم برای نوشتن استفاده می‌شود؛
    // وگرنه هر همگام‌سازی یک نوشتار بیهوده (و همیشه «تغییر کرد») می‌ساخت.
    const title = sanitizeGroupTitle(input.title)
    // نکتهٔ معماری: این متد **سطحِ محیط را نمی‌نویسد**. تنها نویسندهٔ
    // `environment_level` همان `refreshEnvironmentLevel` است؛ اگر دو جا بنویسند،
    // مهرِ تغییر (`levelChangedAt`) هیچ‌وقت قابلِ‌اعتماد نمی‌شود و اعلان‌ها یا
    // تکراری می‌شوند یا گم. پس فقط فیلدهای تلگرامی همگام می‌شوند و سطح/جمعیت
    // در پایان از همان مسیرِ واحد تازه می‌شود.

    // خواندن گروه از دیتابیس و شمارش اعضا از تلگرام به هم وابسته نیستند
    const [existing, memberInfo] = await Promise.all([
      this.groupRepository.findByTelegramGroupId(input.telegramGroupId),
      this.memberInfoProvider.getMemberInfo(input.telegramGroupId).catch(
        (): MemberInfo => ({
          totalCount: null,
          realMemberCount: null,
          adminTelegramUserIds: []
        })
      )
    ])

    const memberCountSynced = memberInfo.realMemberCount !== null
    const totalCount = memberInfo.totalCount ?? existing?.memberCount ?? 0
    const realMemberCount = memberInfo.realMemberCount ?? existing?.realMemberCount ?? 0

    // تنها چیزی که ارزشِ نوشتن دارد، فیلدهای تلگرامی است؛ جمعیت و سطح در ادامه
    // از مسیرِ واحد تازه می‌شوند.
    const needsWrite =
      !existing ||
      existing.memberCount !== totalCount ||
      existing.realMemberCount !== realMemberCount ||
      existing.title !== title ||
      existing.type !== input.type ||
      (memberInfo.ownerTelegramUserId !== undefined &&
        existing.ownerTelegramUserId !== memberInfo.ownerTelegramUserId)

    const group =
      needsWrite || !existing
        ? await this.groupRepository.upsert({
            telegramGroupId: input.telegramGroupId,
            title,
            type: input.type,
            memberCount: totalCount,
            realMemberCount,
            ownerTelegramUserId: memberInfo.ownerTelegramUserId ?? existing?.ownerTelegramUserId
          })
        : existing

    // نقش‌های محلی همیشه همگام می‌شوند؛ ادمین تازه نباید منتظر بماند
    await this.syncLeadershipRoles(group.id, memberInfo)

    const refresh = await this.refreshEnvironmentLevel(group.id)

    return {
      group: {
        ...group,
        gamePopulation: refresh.gamePopulation,
        environmentLevel: refresh.environmentLevel,
        levelChangedAt: refresh.levelChangedAt ?? group.levelChangedAt
      },
      created: !existing,
      environmentChanged: refresh.levelChangedFrom !== null,
      levelChangedFrom: refresh.levelChangedFrom,
      levelChangedAt: refresh.levelChangedAt,
      memberCountSynced
    }
  }

  /** جمعیتِ بازی یک منطقه؛ خطای خواندن به‌معنیِ «صفر شهروند» نیست، ولی
   * مسیرِ ثبتِ گروه نباید به‌خاطر یک شمارش بشکند. عدد ذخیره‌شده می‌ماند. */
  private async countGamePopulation(groupId: string): Promise<number> {
    return this.playerGroupRepository.countActivePlayers(groupId)
  }

  /**
   * بازمحاسبهٔ سطحِ محیط از جمعیتِ واقعیِ بازی.
   *
   * نقطهٔ صدازدن: هر بار که شهروندی به منطقه می‌پیوندد (یعنی مسیر عادیِ
   * بازی). «ارتقا با شمارِ اعضای تلگرام» یا با دخالت دستی وجود ندارد.
   *
   * هم‌زمانی: طبقه‌بندی تابعی خالص از جمعیت است و نوشتنِ شرطیِ
   * `updateEnvironment` فقط وقتی ردیف را عوض می‌کند که مقدارش فرق کند؛ پس دو
   * درخواستِ هم‌زمان حداکثر یک «تغییر» واقعی می‌سازند.
   */
  async refreshEnvironmentLevel(groupId: string): Promise<EnvironmentRefresh> {
    const group = await this.groupRepository.findById(groupId)
    if (!group) {
      throw new NotFoundError('Group not found')
    }

    const gamePopulation = await this.countGamePopulation(groupId)
    const environmentLevel = this.classifier.classify(gamePopulation)
    const write = await this.groupRepository.updateEnvironment(
      groupId,
      gamePopulation,
      environmentLevel
    )

    // «تغییر» فقط وقتی گزارش می‌شود که ردیف واقعاً نوشته شده *و* سطح فرق کرده
    // باشد. پنهان‌کردنِ این دو از هم، برای ارتقای هم‌زمان دو خبر می‌ساخت.
    const levelChanged = write.levelChanged && group.environmentLevel !== environmentLevel

    return {
      gamePopulation,
      environmentLevel,
      changed: write.changed,
      levelChangedFrom: levelChanged ? group.environmentLevel : null,
      levelChangedAt: levelChanged ? write.levelChangedAt : null
    }
  }

  /**
   * بازبینیِ خودکار سطحِ همهٔ مناطق — ارتقای «روستا → شهر» نباید منتظر کسی بماند.
   *
   * جمعیتِ بازی هر منطقه از عضویت‌های فعال ساخته می‌شود و همان عدد، سطح را
   * تعیین می‌کند. تا پیش از این، بازمحاسبه فقط در مسیر پیوستنِ یک بازیکن به
   * گروه اجرا می‌شد؛ یعنی اگر جمعیت با «حذف/غیرفعال شدنِ عضویت» یا با تغییر
   * آستانه عوض می‌شد، سطح تا آمدن بازیکنِ بعدی روی عدد قدیمی می‌ماند و پنلِ
   * منطقه یک واقعیتِ گذشته را نشان می‌داد.
   *
   * تصمیم اینجا گرفته نمی‌شود؛ همان `refreshEnvironmentLevel` صدا زده می‌شود که
   * طبقه‌بندیِ خالص و نوشتارِ شرطی دارد — پس دو چرخهٔ هم‌زمان فقط یک «تغییر»
   * واقعی می‌سازند.
   *
   * @returns فقط مناطق‌هایی که سطحشان واقعاً عوض شده است (برای اعلان).
   */
  async sweepEnvironmentLevels(limit: number = ENVIRONMENT_SWEEP_BATCH): Promise<EnvironmentPromotion[]> {
    const pageSize = Math.max(1, Math.floor(limit))
    const promotions: EnvironmentPromotion[] = []
    let afterId: string | null = null

    // صفحه‌به‌صفحه تا آخر (یا تا سقفِ صفحه‌ها): «همهٔ مناطق» بدونِ پرس‌وجوی بی‌کران.
    for (let page = 0; page < ENVIRONMENT_SWEEP_PAGES; page++) {
      const groups = await this.groupRepository.listPageAfter({ afterId, limit: pageSize })
      const last = groups[groups.length - 1]
      if (!last) {
        break
      }
      afterId = last.id

      for (const group of groups) {
        try {
          const refreshed = await this.refreshEnvironmentLevel(group.id)
          if (!refreshed.levelChangedFrom || !refreshed.levelChangedAt) {
            continue
          }
          promotions.push({
            groupId: group.id,
            groupTitle: group.title,
            from: refreshed.levelChangedFrom,
            to: refreshed.environmentLevel,
            population: refreshed.gamePopulation,
            ownerTelegramUserId: group.ownerTelegramUserId,
            at: refreshed.levelChangedAt.toISOString()
          })
        } catch (error) {
          // یک منطقهٔ ناسالم نباید بقیهٔ مناطق را از چرخه بیرون بیندازد.
          logger.warn({ err: error, groupId: group.id }, 'environment sweep skipped a region')
        }
      }

      if (groups.length < pageSize) {
        break
      }
    }

    return promotions
  }

  async linkPlayerToGroup(telegramUserId: bigint, telegramGroupId: bigint) {
    const player = await this.playerRepository.findByTelegramUserId(telegramUserId)
    if (!player) {
      throw new NotFoundError('Player not found')
    }

    const group = await this.groupRepository.findByTelegramGroupId(telegramGroupId)
    if (!group) {
      throw new NotFoundError('Group not registered')
    }

    // نقش رهبری فقط از تلگرام می‌آید (syncLeadershipRoles)؛ اینجا عمداً
    // نقشِ موجود بازنویسی نمی‌شود تا «ادمین گروه» با هر پیام به «عضو» تنزل
    // نیابد. تنها حالت قطعی، مالکیت گروه است.
    const isOwner = group.ownerTelegramUserId === telegramUserId

    return this.playerGroupRepository.upsert({
      playerId: player.id,
      groupId: group.id,
      ...(isOwner ? { role: PlayerGroupRole.OWNER } : {}),
      status: PlayerGroupStatus.ACTIVE
    })
  }

}

export function getLocalRoleTitle(
  environmentLevel: GroupEnvironmentLevel,
  role: PlayerGroupRole
): string | null {
  if (role === PlayerGroupRole.MEMBER) {
    return null
  }

  const titles: Record<GroupEnvironmentLevel, { owner: string; admin: string }> = {
    [GroupEnvironmentLevel.VILLAGE]: { owner: 'دهیار', admin: 'کدخدا' },
    [GroupEnvironmentLevel.CITY]: { owner: 'شهردار', admin: 'معاون شهردار' },
    [GroupEnvironmentLevel.PROVINCE]: { owner: 'فرماندار', admin: 'معاون فرماندار' },
    [GroupEnvironmentLevel.COUNTRY]: { owner: 'وزیر', admin: 'معاون وزیر' }
  }

  const title = titles[environmentLevel]
  return role === PlayerGroupRole.OWNER ? title.owner : title.admin
}

/** برچسب فارسی سطح محیط — تنها منبع نام‌ها. */
export const ENVIRONMENT_LABELS: Record<GroupEnvironmentLevel, string> = {
  [GroupEnvironmentLevel.VILLAGE]: 'روستا',
  [GroupEnvironmentLevel.CITY]: 'شهر',
  [GroupEnvironmentLevel.PROVINCE]: 'استان',
  [GroupEnvironmentLevel.COUNTRY]: 'کشور'
}

export const playerGroupLabels = {
  [PlayerGroupRole.MEMBER]: 'عضو',
  [PlayerGroupRole.ADMIN]: 'مدیر',
  [PlayerGroupRole.OWNER]: 'مالک',
  [PlayerGroupActivity.LOW]: 'کم‌فعال',
  [PlayerGroupActivity.NORMAL]: 'عادی',
  [PlayerGroupActivity.HIGH]: 'پر‌فعال',
  [PlayerGroupStatus.ACTIVE]: 'فعال',
  [PlayerGroupStatus.LEFT]: 'ترک کرده',
  [PlayerGroupStatus.KICKED]: 'اخراج شده',
  [PlayerGroupStatus.BANNED]: 'مسدود',
  [GroupEnvironmentLevel.VILLAGE]: 'روستا',
  [GroupEnvironmentLevel.CITY]: 'شهر',
  [GroupEnvironmentLevel.PROVINCE]: 'استان',
  [GroupEnvironmentLevel.COUNTRY]: 'کشور'
} as const