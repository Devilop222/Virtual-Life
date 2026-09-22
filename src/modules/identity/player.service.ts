import { Gender, MaritalStatus, SocialLevel } from '@prisma/client'
import { PlayerRepository } from '../../database/repositories/player.repository'
import { NotFoundError } from '../../utils/classes/errors'
import { config } from '../../config/env'
import { DegreeLevel, degreeLabels } from '../education/education-blueprints'
import { LifeStage, lifeStageLabels, lifeCycleService } from '../lifecycle/lifecycle.service'
import { effectiveAge, daysToNextBirthday } from '../lifecycle/game-calendar'
import { BASE_MAX_HEALTH, GYM_MAX_HEALTH } from '../health/max-health'
import { PART_TIME_JOBS } from '../occupation/work-blueprints'
import {
  educationRankOf,
  lifeStageFor,
  productivityOf,
  type ProductivityView
} from '../life/life-core'

export interface PlayerIdentityView {
  telegramUserId: bigint
  firstName: string
  lastName: string | null
  username: string | null
  gender: Gender
  age: number
  /** روزهای باقی‌مانده تا سال جدید بازی (هر هفته یک سال). */
  birthdayInDays: number
  lifeStageLabel: string
  biography: string
  maritalStatus: MaritalStatus
  socialLevel: SocialLevel
  health: number
  /** سقف واقعی سلامت — عضو باشگاه ۱۲۰ است. */
  maxHealth: number
  healthLabel: string
  fatigue: number
  experience: number
  balance: { toString: () => string }
  educationDegree: string
  educationField: string | null
  /** رتبهٔ عددی مدرک (۱=دیپلم … ۵=دکتری) — برای بهره‌وری و قفل شغل‌ها */
  educationRank: number
  occupation: { name: string; category: string; level: number; baseSalary: { toString: () => string }; workplace: string } | null
  /** شغل واقعی بازیکن: نوبت کاری، استخدام یا کسب‌وکار خودش. */
  jobTitle: string | null
  /** آیا همین حالا مشغول کار است؟ */
  isWorkingNow: boolean
  homeGroup: { title: string; environmentLevel: string } | null
  skills: { level: number; skill: { name: string } }[]
  groupCount: number
  /**
   * بهره‌وری لحظه‌ای (۰-۱۰۰) — وابسته به سلامت، خستگی، سابقه، مدرک، رشته،
   * مهارت و سن. این عدد از همان ضریبی ساخته می‌شود که در دستمزدِ واقعی ضرب
   * می‌شود (`modules/life/life-core`)، پس نمایش و واقعیت یکی است.
   */
  productivityScore: number
  productivityLabel: string
  /** ضریب واقعیِ پشت عدد بهره‌وری. */
  productivityMultiplier: number
  /** مرحلهٔ زندگیِ محاسبه‌شده از سن مؤثر (نه ستونِ بی‌اثر دیتابیس). */
  lifeStage: LifeStage
}

export class PlayerService {
  constructor(private readonly playerRepository: PlayerRepository) {}

  async getProfile(telegramUserId: bigint): Promise<PlayerIdentityView> {
    const player = await this.playerRepository.findByTelegramUserIdWithRelations(telegramUserId)
    if (!player) {
      throw new NotFoundError('Player not found')
    }

    // سن بازی با تقویم بازی محاسبه می‌شود: هر هفتهٔ واقعی یک سال
    const age = effectiveAge(player.startedAt, player.age)
    // مرحلهٔ زندگی همیشه از سنِ مؤثر گرفته می‌شود. ستون `lifeStage` در
    // دیتابیس مقدار پیش‌فرض «جوانی» دارد و هیچ مسیری آن را به‌روز نمی‌کرد؛
    // پس شناسنامه تا ابد «جوانی» می‌گفت حتی برای شخصیت ۸۰ ساله.
    const currentStage = lifeStageFor(age)
    this.syncLifeStage(player.id, player.lifeStage as LifeStage | null, currentStage)

    const degree = (player.currentDegree as DegreeLevel) ?? DegreeLevel.DIPLOMA
    const eduRank = educationRankOf(degree as unknown as string)
    const job = resolveJob(player)
    const maxHealth =
      Array.isArray(player.gymMemberships) && player.gymMemberships.length > 0
        ? GYM_MAX_HEALTH
        : BASE_MAX_HEALTH

    // بهره‌وری در «همان حوزهٔ کاری» بازیکن سنجیده می‌شود: مهارت‌های مرتبط با
    // آخرین شغلش و هم‌حوزه بودن رشتهٔ تحصیلی با همان دسته. هر دو از دادهٔ
    // همین کوئری خوانده می‌شوند، پس کوئری اضافه‌ای در کار نیست.
    const lastJobKey = player.workSessions[0]?.jobKey ?? null
    const lastJobCategory =
      PART_TIME_JOBS.find((j) => j.key === lastJobKey)?.category ?? null
    const productivity = productivityOf({
      health: player.health,
      maxHealth,
      fatigue: player.fatigue,
      experience: player.experience,
      educationRank: eduRank,
      graduationField: player.graduationField,
      jobCategory: lastJobCategory,
      skillLevelAverage: averageSkillLevel(player.skills, requiredSkillsOf(lastJobKey)),
      age,
    })

    return {
      telegramUserId: player.telegramUserId,
      firstName: player.firstName,
      lastName: player.lastName,
      username: player.username,
      gender: player.gender,
      age,
      birthdayInDays: daysToNextBirthday(player.startedAt),
      lifeStage: currentStage,
      lifeStageLabel: lifeStageLabels[currentStage] ?? 'جوانی',
      biography: player.biography,
      maritalStatus: player.maritalStatus,
      socialLevel: player.socialLevel,
      health: player.health,
      // سقف واقعی از منبع واحد (باشگاه فعال = ۱۲۰)؛ خواندن defensive تا
      // داده‌های قدیمی/مک‌شده بدون این رابطه هم پنل را نشکنند
      maxHealth,
      healthLabel: lifeCycleService.formatHumanHealth(player.health),
      fatigue: player.fatigue,
      experience: player.experience,
      balance: player.balance,
      educationDegree: degreeLabels[degree] ?? 'دیپلم',
      educationField: player.graduationField,
      educationRank: eduRank,
      occupation: player.occupation
        ? {
            name: player.occupation.name,
            category: player.occupation.category,
            level: player.occupation.level,
            baseSalary: player.occupation.baseSalary,
            workplace: player.occupation.workplace
          }
        : null,
      jobTitle: job.title,
      isWorkingNow: job.isActive,
      homeGroup: player.homeGroup
        ? {
            title: player.homeGroup.title,
            environmentLevel: player.homeGroup.environmentLevel
          }
        : null,
      skills: player.skills.map((ps) => ({
        level: ps.level,
        skill: { name: ps.skill.name }
      })),
      groupCount: player.groupMemberships.length,
      productivityScore: productivity.score,
      productivityLabel: productivity.label,
      productivityMultiplier: Math.round(productivity.multiplier * 100) / 100,
    }
  }

  /**
   * همگام‌سازی تنبلِ ستون `lifeStage` با سنِ واقعی.
   *
   * هر بازیکن در کل عمرش حداکثر پنج بار مرحله عوض می‌کند، پس این نوشتار
   * عملاً یک‌بار در چند هفته اتفاق می‌افتد و هیچ هزینه‌ای روی مسیر خواندن
   * ندارد. خطایش بی‌صدا نادیده گرفته می‌شود چون منبع حقیقت، سن است نه این ستون.
   */
  private syncLifeStage(
    playerId: string,
    stored: LifeStage | null,
    current: LifeStage
  ): void {
    if (stored === current) {
      return
    }
    try {
      // همگام‌سازیِ ستون هرگز نباید مسیر خواندنِ شناسنامه را بشکند؛
      // منبع حقیقتِ مرحلهٔ زندگی، سنِ مؤثر است نه این ستون.
      void this.playerRepository.syncLifeStage(playerId, current, stored)?.catch(() => undefined)
    } catch {
      // بی‌صدا — این یک بهینه‌سازیِ هم‌راستاسازی است، نه بخشی از پاسخ
    }
  }

  async isRegistered(telegramUserId: bigint): Promise<boolean> {
    return this.playerRepository.isRegistered(telegramUserId)
  }
}

export const genderLabels: Record<Gender, string> = {
  [Gender.MALE]: 'مرد',
  [Gender.FEMALE]: 'زن'
}

export const maritalStatusLabels: Record<MaritalStatus, string> = {
  [MaritalStatus.SINGLE]: 'مجرد',
  [MaritalStatus.MARRIED]: 'متاهل',
  [MaritalStatus.DIVORCED]: 'مطلقه',
  [MaritalStatus.WIDOWED]: 'همسر فوت شده'
}

export const socialLevelLabels: Record<SocialLevel, string> = {
  [SocialLevel.LOW]: 'پایین',
  [SocialLevel.MIDDLE]: 'متوسط',
  [SocialLevel.HIGH]: 'بالا',
  [SocialLevel.ELITE]: 'ویژه'
}

export function getStartingAge(): number {
  return Math.max(0, config.GAME_START_AGE)
}

/**
 * بهره‌وری لحظه‌ای — عددی ۱۰-۱۰۰ که همهٔ عامل‌های پیشرفت را خلاصه می‌کند.
 *
 * این تابع دیگر منحنیِ خودش را ندارد: مستقیماً از `modules/life/life-core`
 * می‌خواند، همان‌جایی که ضریبِ واقعیِ دستمزد هم ساخته می‌شود. پیش‌تر دو نسخه
 * از این منحنی وجود داشت (یکی برای پول، یکی برای نمایش) و عامل‌های سابقه،
 * مدرک و سن فقط در نسخهٔ نمایشی بودند؛ یعنی عددِ روی پنل دروغ می‌گفت.
 *
 * @deprecated برای مصرف‌کننده‌های بیرونیِ قدیمی نگه داشته شده؛ کد تازه
 * `productivityOf` را از `modules/life/life-core` صدا بزند.
 */
export function computeProductivity(input: {
  health: number
  maxHealth: number
  fatigue: number
  experience: number
  educationRank: number
  lifeStage: LifeStage
  skillLevelAverage?: number | null
  graduationField?: string | null
  jobCategory?: string | null
  age?: number
}): ProductivityView {
  return productivityOf({
    health: input.health,
    maxHealth: input.maxHealth,
    fatigue: input.fatigue,
    experience: input.experience,
    educationRank: input.educationRank,
    graduationField: input.graduationField ?? null,
    jobCategory: input.jobCategory ?? null,
    skillLevelAverage: input.skillLevelAverage,
    // اگر سن داده نشد، از مرحلهٔ زندگیِ داده‌شده سنِ میانیِ همان مرحله گرفته
    // می‌شود تا مصرف‌کنندهٔ قدیمی همان رفتار منطقی را ببیند.
    age: input.age ?? midAgeOfStage(input.lifeStage)
  })
}

/** سنِ میانیِ هر مرحله — فقط برای سازگاریِ مصرف‌کننده‌های قدیمی. */
function midAgeOfStage(stage: LifeStage): number {
  switch (stage) {
    case LifeStage.CHILDHOOD:
      return 9
    case LifeStage.ADOLESCENCE:
      return 16
    case LifeStage.YOUTH:
      return 26
    case LifeStage.ADULTHOOD:
      return 42
    case LifeStage.MIDDLE_AGE:
      return 57
    case LifeStage.SENIORITY:
      return 70
    default:
      return 26
  }
}

/**
 * میانگین سطح مهارت‌های مرتبط با یک شغل از دادهٔ ازپیش‌بارگذاری‌شده.
 *
 * مهارتِ ثبت‌نشده سطح ۱ حساب می‌شود (نه صفر) تا بی‌مهارتی جریمه نسازد؛
 * دقیقاً همان قاعده‌ای که ریپازیتوری مهارت در مسیر کار اعمال می‌کند.
 */
export function averageSkillLevel(
  skills: Array<{ level: number; skill: { name: string } }>,
  requiredSkills: string[] | undefined
): number | undefined {
  if (!requiredSkills || requiredSkills.length === 0) {
    return undefined
  }
  const total = requiredSkills.reduce((sum, name) => {
    const owned = skills.find((s) => s.skill.name === name)
    return sum + (owned?.level ?? 1)
  }, 0)
  return total / requiredSkills.length
}

function requiredSkillsOf(jobKey: string | null): string[] | undefined {
  if (!jobKey) return undefined
  return PART_TIME_JOBS.find((j) => j.key === jobKey)?.requiredSkills
}

/**
 * تعیین شغل نمایشی بازیکن با اولویت واقعی‌بودن:
 * نوبت کاری فعال ← استخدام فعال ← کسب‌وکار خودش ← آخرین سابقهٔ کاری.
 */
function resolveJob(player: {
  workSessions: Array<{ jobTitle: string; status: string }>
  employments: Array<{ title: string; business: { name: string } }>
  ownedBusinesses: Array<{ name: string }>
}): { title: string | null; isActive: boolean } {
  const active = player.workSessions.find((s) => s.status === 'ACTIVE')
  if (active) {
    return { title: active.jobTitle, isActive: true }
  }

  const employment = player.employments[0]
  if (employment) {
    return { title: `${employment.title} · ${employment.business.name}`, isActive: false }
  }

  const business = player.ownedBusinesses[0]
  if (business) {
    return { title: `کارفرمای ${business.name}`, isActive: false }
  }

  const last = player.workSessions[0]
  return last ? { title: last.jobTitle, isActive: false } : { title: null, isActive: false }
}