import {
  DegreeLevel,
  Gender,
  LifeStage,
  PlayerActivityState,
  Prisma,
  PrismaClient,
  Player,
  PlayerStatus,
  TransactionType
} from '@prisma/client'
import { STARTING_BALANCE } from '../../config/economy'

export interface CreatePlayerInput {
  telegramUserId: bigint
  firstName: string
  lastName?: string | null
  username?: string | null
  gender: Gender
  biography: string
  age: number
}

/** یک دانشجوی درحال‌تحصیل، برای سنجش خودکار پایان دوره. */
export interface EnrolledStudentRow {
  telegramUserId: bigint
  enrolledFieldKey: string
  studyStartedAt: Date
}

const playerInclude = {
  occupation: true,
  homeGroup: true,
  skills: {
    include: { skill: true }
  },
  groupMemberships: true,
  relationships: true,
  // آخرین نوبت کاری منبع واقعی «شغل فعلی» است؛ occupationId هرگز نوشته نمی‌شود
  workSessions: {
    orderBy: [{ startedAt: 'desc' as const }],
    take: 1,
    // jobKey برای محاسبهٔ بهره‌وریِ واقعی در همان حوزهٔ کاری است؛ بدون
    // کوئری اضافه، از همان SELECT موجود خوانده می‌شود.
    select: { jobKey: true, jobTitle: true, status: true }
  },
  employments: {
    where: { isActive: true },
    take: 1,
    select: { title: true, business: { select: { name: true } } }
  },
  ownedBusinesses: {
    where: { status: 'ACTIVE' as const },
    take: 1,
    select: { name: true }
  },
  // عضویت فعال باشگاه — سقف سلامت واقعی (۱۲۰) در شناسنامه/وضعیت
  gymMemberships: {
    where: { expiresAt: { gt: new Date() } },
    take: 1,
    select: { id: true }
  }
} satisfies Prisma.PlayerInclude

export class PlayerRepository {
  constructor(private readonly db: PrismaClient) {}

  async findByTelegramUserId(telegramUserId: bigint): Promise<Player | null> {
    return this.db.player.findUnique({
      where: { telegramUserId }
    })
  }

  /**
   * نگاشت شناسهٔ تلگرام → شناسهٔ بازیکن در یک Query.
   * جایگزین حلقهٔ N+1 برای همگام‌سازی نقش‌های محلی گروه.
   */
  async findIdsByTelegramUserIds(telegramUserIds: bigint[]): Promise<Map<bigint, string>> {
    if (telegramUserIds.length === 0) {
      return new Map()
    }
    const rows = await this.db.player.findMany({
      where: { telegramUserId: { in: telegramUserIds } },
      select: { id: true, telegramUserId: true }
    })
    return new Map(rows.map((row) => [row.telegramUserId, row.id]))
  }

  async findByTelegramUserIdWithRelations(telegramUserId: bigint) {
    return this.db.player.findUnique({
      where: { telegramUserId },
      include: playerInclude
    })
  }

  async findById(id: string): Promise<Player | null> {
    return this.db.player.findUnique({ where: { id } })
  }

  async create(
    input: CreatePlayerInput,
    tx: Prisma.TransactionClient = this.db
  ): Promise<Player> {
    return tx.player.create({
      data: {
        telegramUserId: input.telegramUserId,
        firstName: input.firstName,
        lastName: input.lastName,
        username: input.username,
        gender: input.gender,
        biography: input.biography,
        age: input.age,
        balance: STARTING_BALANCE
      }
    })
  }

  async createUpsert(input: CreatePlayerInput): Promise<Player> {
    return this.db.$transaction(async (tx) => {
      const player = await tx.player.upsert({
        where: { telegramUserId: input.telegramUserId },
        create: {
          telegramUserId: input.telegramUserId,
          firstName: input.firstName,
          lastName: input.lastName,
          username: input.username,
          gender: input.gender,
          biography: input.biography,
          age: input.age,
          balance: STARTING_BALANCE
        },
        update: {}
      })

      // سرمایهٔ اولیه هم یک جریان مالی است: بدون این ردیف، «آشتی‌دادن دفتر کل
      // با موجودی» از همان روز اول برای هر بازیکن ۴۰۰٬۰۰۰ تومان اختلاف
      // نشان می‌داد. شناسهٔ ثابت + skipDuplicates ⇒ این ردیف هرگز دوبار
      // ساخته نمی‌شود (حتی اگر ثبت‌نام همزمان دو بار اجرا شود).
      await tx.financialTransaction.createMany({
        data: [
          {
            id: `initial-capital:${player.id}`,
            amount: STARTING_BALANCE,
            type: TransactionType.REWARD_PAYOUT,
            destinationPlayerId: player.id,
            reference: 'سرمایهٔ اولیهٔ زندگی'
          }
        ],
        skipDuplicates: true
      })

      return player
    })
  }

  async isRegistered(telegramUserId: bigint): Promise<boolean> {
    return this.db.player
      .findUnique({
        where: { telegramUserId },
        select: { id: true }
      })
      .then((player) => player !== null)
  }

  async countPlayers(): Promise<number> {
    return this.db.player.count()
  }

  async listTop(
    metric: 'balance' | 'experience' | 'health' | 'age',
    telegramUserIds: bigint[] | null,
    skip: number,
    take: number
  ) {
    const orderBy = (metric === 'balance' ? { balance: 'desc' } : { [metric]: 'desc' }) as never
    return this.db.player.findMany({
      where: {
        // تابلوی زنده — فارغ‌التحصیلانِ قبرستان رتبه نمی‌گیرند
        status: { notIn: [PlayerStatus.DEAD, PlayerStatus.BANNED] },
        ...(telegramUserIds ? { telegramUserId: { in: telegramUserIds } } : {})
      },
      orderBy,
      skip,
      take,
      select: {
        telegramUserId: true,
        firstName: true,
        lastName: true,
        username: true,
        age: true,
        balance: true,
        health: true,
        fatigue: true,
        experience: true,
        occupation: { select: { name: true } }
      }
    })
  }

  async update(
    telegramUserId: bigint,
    data: Prisma.PlayerUpdateInput
  ): Promise<Player> {
    return this.db.player.update({
      where: { telegramUserId },
      data
    })
  }

  /**
   * صدور مدرک به‌صورت اتمیک.
   *
   * کل تغییرِ وضعیت (مدرک، رشته، پایان تحصیل، تجربه و بازگشت به حالت آزاد)
   * در یک `updateMany` شرطی انجام می‌شود. شرط‌ها:
   *   • `isEnrolled: true` — یعنی هنوز مدرکی برای همین دوره صادر نشده
   *   • `enrolledFieldKey` همان رشته‌ای باشد که بررسی شده
   *
   * پیش‌تر صدور مدرک read-then-write بود؛ دو کلیک همزمان روی «دریافت مدرک»
   * هر دو از بررسیِ زمان رد می‌شدند و تجربهٔ فارغ‌التحصیلی دوبار واریز می‌شد.
   *
   * @returns تعداد ردیف‌های به‌روزشده (۱ = مدرک صادر شد، ۰ = رقابت را باخته)
   */
  async completeDegree(
    telegramUserId: bigint,
    input: {
      enrolledFieldKey: string
      degree: DegreeLevel
      graduationField: string
      gainedExp: number
      lifeStage: LifeStage
    }
  ): Promise<number> {
    const result = await this.db.player.updateMany({
      where: {
        telegramUserId,
        isEnrolled: true,
        enrolledFieldKey: input.enrolledFieldKey
      },
      data: {
        currentDegree: input.degree,
        graduationField: input.graduationField,
        activityState: PlayerActivityState.IDLE,
        isEnrolled: false,
        enrolledFieldKey: null,
        targetDegree: null,
        studyStartedAt: null,
        // مرحلهٔ زندگی هم در همان نوشتار تازه می‌شود تا ستون و سن هم‌راز بمانند
        lifeStage: input.lifeStage,
        experience: { increment: input.gainedExp }
      }
    })
    return result.count
  }

  /**
   * همگام‌سازی ستون `life_stage` با سنِ واقعیِ بازیکن.
   *
   * نوشتار شرطی است (`lifeStage: stored`) تا دو مسیر همزمان یکدیگر را پاک
   * نکنند و نوشتارِ بی‌اثر هم ثبت نشود. منبع حقیقتِ مرحلهٔ زندگی، سن مؤثر
   * است؛ این ستون فقط برای خواننده‌های مستقیم دیتابیس هم‌راز نگه داشته می‌شود.
   *
   * @returns تعداد ردیف‌های به‌روزشده (۰ = مرحله درست بود یا همزمان عوض شد)
   */
  async syncLifeStage(
    playerId: string,
    stage: LifeStage,
    stored: LifeStage | null = null
  ): Promise<number> {
    const result = await this.db.player.updateMany({
      where: stored === null ? { id: playerId } : { id: playerId, lifeStage: stored },
      data: { lifeStage: stage }
    })
    return result.count
  }

  /**
   * ثبت‌نام اتمیک در دانشگاه.
   * کسر شهریه و فعال‌سازی وضعیت تحصیل با شرط‌های `موجودی کافی` و
   * `در حال تحصیل نبودن` در یک `updateMany` انجام می‌شود تا دو درخواست
   * همزمان نتوانند دوبار شهریه بگیرند یا وضعیت را خراب کنند.
   *
   * @returns تعداد ردیف‌های به‌روزشده (۱ = موفق، ۰ = موجودی ناکافی یا ثبت‌نام همزمان)
   */
  async enrollStudent(
    telegramUserId: bigint,
    tuitionCost: number,
    data: {
      enrolledFieldKey: string
      targetDegree: DegreeLevel
      /** توضیح ردیف دفتر کل؛ پیش‌فرض «شهریهٔ تحصیل». */
      reference?: string
    }
  ): Promise<number> {
    return this.db.$transaction(async (tx) => {
      const player = await tx.player.findUnique({
        where: { telegramUserId },
        select: { id: true }
      })
      if (!player) {
        return 0
      }

      const result = await tx.player.updateMany({
        where: {
          id: player.id,
          isEnrolled: false,
          balance: { gte: tuitionCost }
        },
        data: {
          balance: { decrement: tuitionCost },
          activityState: PlayerActivityState.STUDYING,
          isEnrolled: true,
          enrolledFieldKey: data.enrolledFieldKey,
          targetDegree: data.targetDegree,
          studyStartedAt: new Date()
        }
      })
      if (result.count !== 1) {
        return 0
      }

      // کسر شهریه و ردیف دفتر کل در یک تراکنش: هیچ‌وقت پولی کم نمی‌شود که
      // در دفتر کل ثبت نشده باشد (و برعکس).
      await tx.financialTransaction.create({
        data: {
          amount: tuitionCost,
          type: TransactionType.EDUCATION_TUITION,
          sourcePlayerId: player.id,
          reference: data.reference ?? 'شهریهٔ تحصیل'
        }
      })

      return 1
    })
  }

  /**
   * دانشجویانی که ممکن است واحدهایشان تمام شده باشد — منبعِ چرخهٔ خودکار.
   *
   * چرا تصمیم اینجا گرفته نمی‌شود؟ چون طول هر دوره به رشته بستگی دارد و در
   * Blueprint رشته زندگی می‌کند، نه در دیتابیس. این کوئری فقط دانشجوها را
   * (که تعدادشان کوچک است) به ترتیب قدیمی‌ترین شروع برمی‌گرداند تا سرویس با
   * یک بستهٔ بسته، سررسیدها را بسنجد.
   */
  async listEnrolledStudents(limit: number): Promise<EnrolledStudentRow[]> {
    const take = Math.max(1, Math.min(200, Math.floor(limit)))
    return this.db.player.findMany({
      where: {
        status: PlayerStatus.ACTIVE,
        isEnrolled: true,
        studyStartedAt: { not: null },
        enrolledFieldKey: { not: null }
      },
      orderBy: { studyStartedAt: 'asc' },
      take,
      select: { telegramUserId: true, enrolledFieldKey: true, studyStartedAt: true }
    }) as Promise<EnrolledStudentRow[]>
  }
}