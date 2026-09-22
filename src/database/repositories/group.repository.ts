import { Group, GroupEnvironmentLevel, GroupType, PrismaClient } from '@prisma/client'

/**
 * فیلدهای *تلگرامیِ* گروه.
 *
 * جمعیت و سطح عمداً اینجا نیستند: تنها نویسندهٔ آن‌ها `updateEnvironment`
 * است. دو نویسنده برای یک ستون یعنی مهرِ تغییر قابلِ‌اعتماد نیست و اعلانِ
 * «سطح عوض شد» یا گم می‌شود یا تکراری.
 */
export interface UpsertGroupInput {
  telegramGroupId: bigint
  title: string
  type: GroupType
  /** شمارِ اعضای تلگرام (اطلاعاتی؛ معیارِ سطح نیست). */
  memberCount: number
  /** اعضای تلگرام منهای ربات‌های مدیر (اطلاعاتی). */
  realMemberCount: number
  ownerTelegramUserId?: bigint | null
}

/**
 * نتیجهٔ نوشتنِ جمعیت/سطح — تصمیمِ اعلان روی همین بنا می‌شود.
 *
 * `levelChangedAt` **مهرِ همان تغییرِ واقعی** است، نه «الان». کلیدِ ضدتکرارِ
 * اعلان از همین ساخته می‌شود؛ دو مسیرِ اعلان برای یک تغییر، همین مهر را
 * می‌خوانند و پس یکی می‌شوند، ولی تغییرِ بعدیِ همان منطقه مهرِ تازه می‌گیرد.
 */
export interface EnvironmentWrite {
  /** سطح واقعاً عوض شد؟ */
  levelChanged: boolean
  /** مهرِ همان تغییر؛ اگر سطحی عوض نشده `null`. */
  levelChangedAt: Date | null
  /** ردیف عوض شد (جمعیت یا سطح)؟ */
  changed: boolean
}

export interface GroupPageOptions {
  /** آخرین شناسهٔ صفحهٔ قبل؛ برای ادامه از همان‌جا (بدون `skip` سنگین). */
  afterId?: string | null
  limit?: number
}

export class GroupRepository {
  constructor(private readonly db: PrismaClient) {}

  async findByTelegramGroupId(telegramGroupId: bigint): Promise<Group | null> {
    return this.db.group.findUnique({
      where: { telegramGroupId }
    })
  }

  async findById(id: string): Promise<Group | null> {
    return this.db.group.findUnique({ where: { id } })
  }

  async upsert(input: UpsertGroupInput): Promise<Group> {
    return this.db.group.upsert({
      where: { telegramGroupId: input.telegramGroupId },
      create: {
        telegramGroupId: input.telegramGroupId,
        title: input.title,
        type: input.type,
        memberCount: input.memberCount,
        realMemberCount: input.realMemberCount,
        ownerTelegramUserId: input.ownerTelegramUserId
      },
      update: {
        title: input.title,
        type: input.type,
        memberCount: input.memberCount,
        realMemberCount: input.realMemberCount,
        ownerTelegramUserId: input.ownerTelegramUserId
      }
    })
  }

  /**
   * نوشتنِ جمعیتِ بازی و سطحِ محیط — تنها جایی که `environment_level` عوض می‌شود.
   *
   * ── چرا دو گام و نه یک `updateMany`؟ ────────────────────────────────────
   * «سطح عوض شد» و «مهرِ تغییر» باید از یک نوشتارِ اتمیک بیایند؛ وگرنه دو
   * نویسندهٔ هم‌زمان هر دو خودشان را برنده می‌بینند و دو اعلان می‌سازند. پس
   * شرط روی **خودِ سطح** گذاشته می‌شود (`environmentLevel != newLevel`): در هر
   * رقابت فقط یک `updateMany` عددِ غیرصفر برمی‌گرداند و همان یکی مهر را می‌گیرد.
   * برنده‌نشدن یعنی همان تغییر را کسی دیگر انجام داده — نه اینکه چیزی خراب شده.
   *
   * گام دوم فقط هم‌ترازیِ جمعیت است (سطح دست نمی‌خورد، مهری هم نمی‌گیرد).
   */
  async updateEnvironment(
    id: string,
    gamePopulation: number,
    environmentLevel: GroupEnvironmentLevel
  ): Promise<EnvironmentWrite> {
    const changedAt = new Date()
    const levelWrite = await this.db.group.updateMany({
      where: { id, environmentLevel: { not: environmentLevel } },
      data: { environmentLevel, gamePopulation, levelChangedAt: changedAt }
    })
    if (levelWrite.count > 0) {
      return { levelChanged: true, levelChangedAt: changedAt, changed: true }
    }

    const populationWrite = await this.db.group.updateMany({
      where: { id, gamePopulation: { not: gamePopulation } },
      data: { gamePopulation }
    })
    return { levelChanged: false, levelChangedAt: null, changed: populationWrite.count > 0 }
  }

  async listAll(limit = 100, offset = 0): Promise<Group[]> {
    return this.db.group.findMany({
      take: limit,
      skip: offset,
      orderBy: { createdAt: 'desc' }
    })
  }

  /**
   * صفحهٔ بعدیِ مناطق با کلیدِ **شناسه** (نه `skip`).
   *
   * ریشهٔ یک باگِ خاموش: چرخهٔ بازبینی سطح با `take: 100` و مرتب‌سازی روی
   * `createdAt` می‌خواند. با بیشتر از ۱۰۰ منطقه، قدیمی‌ترین مناطق **هیچ‌وقت**
   * بازبینی نمی‌شدند: نه ارتقا، نه تنزل — یک گرسنگیِ دائمی که هیچ خطایی هم
   * نمی‌داد. صفحه‌بندی روی شناسه (کلیدِ اصلی و یکتا) هم پایدار است و هم نمایه را
   * می‌زند؛ `skip` با دادهٔ در حال تغییر می‌تواند ردیفی را جا بیندازد یا دوبار بدهد.
   */
  async listPageAfter(options: GroupPageOptions = {}): Promise<Group[]> {
    const limit = Math.max(1, Math.floor(options.limit ?? 100))
    const afterId = options.afterId ?? null
    return this.db.group.findMany({
      where: afterId ? { id: { gt: afterId } } : undefined,
      take: limit,
      orderBy: { id: 'asc' }
    })
  }
}