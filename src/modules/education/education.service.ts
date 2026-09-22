import {
  DegreeLevel,
  EDUCATION_FIELDS,
  canEnrollInDegree,
  degreeLabels,
  fieldAffinitySummary
} from './education-blueprints'
import { PlayerRepository } from '../../database/repositories/player.repository'
import { insufficientFunds } from '../../utils/format'
import { PlayerSkillRepository } from '../../database/repositories/player-skill.repository'
import { SkillRepository } from '../../database/repositories/skill.repository'
import { ConflictError, NotFoundError, ValidationError } from '../../utils/classes/errors'
import { PlayerActivityState } from '@prisma/client'
import { PlayerStateMachine } from '../identity/player-state-machine'
import { lifeStageFor } from '../life/life-core'
import { effectiveAge } from '../lifecycle/game-calendar'
import { gameMinutesSince } from '../../utils/game-time'
import { logger } from '../../utils/logger'

/** سطح مهارتی که فارغ‌التحصیلی اعطا می‌کند (اگر بازیکن بالاتر نداشته باشد). */
export const GRADUATION_SKILL_LEVEL = 2

/**
 * سقفِ تعداد فارغ‌التحصیلیِ خودکار در یک چرخه.
 *
 * هر فارغ‌التحصیلی یک تراکنش (صدور مدرک) و چند Query مهارت است؛ بستهٔ کوچک
 * ضامن آن است که یک انفجارِ پایانِ دوره (مثلاً پس از چند روز خاموشی) سرور را
 * با صدها تراکنش هم‌زمان غافلگیر نکند.
 */
export const EDUCATION_SWEEP_BATCH = 20

/** یک فارغ‌التحصیلیِ خودکار — دادهٔ لازم برای اعلان. */
export interface GraduatedStudent {
  telegramUserId: bigint
  degreeLabel: string
  fieldTitle: string
  gainedExp: number
}

export interface EnrollmentStatus {
  isStudying: boolean
  fieldTitle?: string
  degreeTitle?: string
  progressPercentage: number
  minutesRemaining: number
  canGraduate: boolean
  /** دسته‌های شغلیِ هم‌حوزهٔ رشتهٔ جاری — همان‌جا که مدرک پول بیشتری می‌سازد. */
  affinitySummary?: string
}

export class EducationService {
  constructor(
    private readonly playerRepository: PlayerRepository,
    private readonly playerSkillRepository: PlayerSkillRepository,
    private readonly skillRepository: SkillRepository
  ) {}

  async getPlayerEducationStatus(telegramUserId: bigint): Promise<{
    currentDegree: DegreeLevel
    degreeLabel: string
    currentField: string | null
    enrollment: EnrollmentStatus
  }> {
    const player = await this.playerRepository.findByTelegramUserId(telegramUserId)
    if (!player) {
      throw new NotFoundError('Player not found')
    }

    const currentDegree = (player.currentDegree as DegreeLevel) ?? DegreeLevel.DIPLOMA
    const isStudying = Boolean(player.isEnrolled && player.enrolledFieldKey && player.studyStartedAt)

    let progressPercentage = 0
    let minutesRemaining = 0
    let canGraduate = false
    let fieldTitle: string | undefined
    let degreeTitle: string | undefined
    let affinitySummary: string | undefined

    if (isStudying && player.studyStartedAt && player.enrolledFieldKey) {
      const field = EDUCATION_FIELDS.find((f) => f.key === player.enrolledFieldKey)
      if (field) {
        fieldTitle = field.title
        degreeTitle = degreeLabels[(player.targetDegree as DegreeLevel) ?? DegreeLevel.BACHELOR]
        // واحدهای درسی روی «دقیقهٔ بازی» شمرده می‌شوند (هر دقیقهٔ واقعی ۳۰ دقیقهٔ بازی).
        const elapsedMinutes = gameMinutesSince(player.studyStartedAt)
        progressPercentage = Math.min(100, Math.round((elapsedMinutes / field.gameDurationMinutes) * 100))
        minutesRemaining = Math.max(0, Math.round(field.gameDurationMinutes - elapsedMinutes))
        canGraduate = progressPercentage >= 100
      }
    }

    return {
      currentDegree,
      degreeLabel: degreeLabels[currentDegree] ?? 'دیپلم',
      currentField: player.graduationField,
      enrollment: {
        isStudying,
        fieldTitle,
        degreeTitle,
        progressPercentage,
        minutesRemaining,
        canGraduate,
        // وقتی در حال تحصیل نیست هم گفته می‌شود رشتهٔ فارغ‌التحصیلی‌اش کجا
        // برایش دستمزد بهتری می‌سازد — تصمیمِ رشتهٔ بعدی باید با دیدِ پیامدش
        // گرفته شود.
        affinitySummary:
          affinitySummary ??
          (player.graduationField
            ? fieldAffinitySummary(
                EDUCATION_FIELDS.find((f) => f.title === player.graduationField) ??
                  EDUCATION_FIELDS[0]!
              )
            : undefined)
      }
    }
  }

  async enrollInUniversity(
    telegramUserId: bigint,
    fieldKey: string,
    targetDegree: DegreeLevel
  ) {
    const player = await this.playerRepository.findByTelegramUserId(telegramUserId)
    if (!player) {
      throw new NotFoundError('Player not found')
    }

    PlayerStateMachine.assertCanStartActivity(
      player.status,
      player.activityState,
      PlayerActivityState.STUDYING
    )

    if (player.isEnrolled) {
      throw new ValidationError('Already studying', 'الان داری در یک رشته تحصیل می‌کنی.')
    }

    const currentDegree = (player.currentDegree as DegreeLevel) ?? DegreeLevel.DIPLOMA
    if (!canEnrollInDegree(currentDegree, targetDegree)) {
      throw new ValidationError(
        'Invalid degree prerequisite',
        `پیش‌نیاز تحصیلی رعایت نشده است. با مدرک ${degreeLabels[currentDegree]} نمی‌توانی مستقیم در ${degreeLabels[targetDegree]} ثبت‌نام کنی؛ اول مدرک قبلی را بگیر.`
      )
    }

    const field = EDUCATION_FIELDS.find((f) => f.key === fieldKey)
    if (!field || !field.supportedDegrees.includes(targetDegree)) {
      throw new NotFoundError('Field not supported', 'این مقطع در رشته انتخابی ارائه نمی‌شود.')
    }

    if (Number(player.balance) < field.baseTuitionCost) {
      throw new ValidationError(
        'Insufficient tuition balance',
        insufficientFunds(
          field.baseTuitionCost,
          Number(player.balance),
          'شهریهٔ دانشگاه',
          'می‌توانی مقطع یا رشتهٔ ارزان‌تری انتخاب کنی، یا اول با کار کردن سرمایه‌ات را بسازی.'
        )
      )
    }

    // کسر شهریه و ثبت‌نام به‌صورت اتمیک و شرطی؛ دو درخواست همزمان نمی‌توانند
    // دوبار شهریه بگیرند یا بازیکنی را که در حال تحصیل است دوباره ثبت کنند.
    const enrolled = await this.playerRepository.enrollStudent(telegramUserId, field.baseTuitionCost, {
      enrolledFieldKey: field.key,
      targetDegree,
      reference: `شهریه دانشگاه: ${field.title} (${degreeLabels[targetDegree]})`
    })
    if (enrolled !== 1) {
      throw new ValidationError(
        'Enrollment failed',
        'ثبت‌نام انجام نشد؛ یا موجودی کافی نیست یا هم‌اکنون در حال تحصیلی.'
      )
    }

    // موجودی پس از کسر شهریه برای پنل نتیجه: «الان چقدر مونده؟» نباید
    // بازیکن را به باز کردن پنل بانک وادارد.
    const balanceAfter = Number(player.balance) - field.baseTuitionCost
    return { field, targetDegree, balanceAfter }
  }

  async graduate(telegramUserId: bigint) {
    const player = await this.playerRepository.findByTelegramUserId(telegramUserId)
    if (!player || !player.isEnrolled || !player.studyStartedAt || !player.enrolledFieldKey) {
      throw new ValidationError('Not studying', 'دورهٔ تحصیلی فعالی نداری. در گروه «تحصیل» را بفرست و شرایط ثبت‌نام را ببین.')
    }

    const field = EDUCATION_FIELDS.find((f) => f.key === player.enrolledFieldKey)
    if (!field) {
      throw new NotFoundError('Field not found')
    }

    const elapsedMinutes = gameMinutesSince(player.studyStartedAt)
    if (elapsedMinutes < field.gameDurationMinutes) {
      const remaining = Math.round(field.gameDurationMinutes - elapsedMinutes)
      throw new ValidationError(
        'Curriculum not completed',
        `واحدهای درسی هنوز تمام نشده است. ${remaining.toLocaleString('fa-IR')} دقیقهٔ بازی دیگر باقی مانده است.`
      )
    }

    const newDegree = player.targetDegree as DegreeLevel

    // صدور مدرک اتمیک است: شرط «هنوز در حال تحصیل بودنِ همین رشته» داخل خودِ
    // نوشتار است، پس دو کلیک همزمان نمی‌توانند دوبار تجربهٔ فارغ‌التحصیلی
    // بدهند. مرحلهٔ زندگی هم از سنِ واقعی گرفته می‌شود، نه از ستونِ مانده.
    const issued = await this.playerRepository.completeDegree(telegramUserId, {
      enrolledFieldKey: field.key,
      degree: newDegree,
      graduationField: field.title,
      gainedExp: field.gainedExp,
      lifeStage: lifeStageFor(effectiveAge(player.startedAt, player.age))
    })
    if (issued !== 1) {
      throw new ConflictError(
        'Degree already issued',
        'مدرک این دوره پیش‌تر صادر شده است. برای مقطع بعدی از «تحصیل» اقدام کن.'
      )
    }

    // مهارت‌های رشته اعطا می‌شوند، اما هرگز سطحِ کسب‌شده با کارِ مرتبط را
    // پایین نمی‌آورند (پیش‌تر `assign` سطح را بازنویسی می‌کرد).
    // یک Query برای حلِ همهٔ نام‌ها + اعطای موازی: هر مهارت ردیفِ خودش را
    // دارد، پس ترتیبِ اعطا مهم نیست.
    const skillIds = await this.skillRepository.findIdsByNames(field.gainedSkills)
    await Promise.all(
      field.gainedSkills.map((skillName) => {
        const skillId = skillIds.get(skillName)
        if (!skillId) return Promise.resolve()
        return this.playerSkillRepository.awardLevel(player.id, skillId, GRADUATION_SKILL_LEVEL)
      })
    )

    return {
      degree: newDegree,
      degreeLabel: degreeLabels[newDegree],
      fieldTitle: field.title,
      gainedExp: field.gainedExp
    }
  }

  /**
   * پایانِ خودکارِ دوره — «ربات نباید منتظر باز شدن پنل بماند».
   *
   * پیش از این، مدرک فقط وقتی صادر می‌شد که خودِ بازیکن پنل تحصیل را باز
   * می‌کرد و دکمهٔ فارغ‌التحصیلی را می‌زد. یعنی کسی که واحدهایش تمام شده بود
   * و چند روز سر نمی‌زد، نه مدرکش را داشت، نه مهارت‌های رشته را، نه تجربه‌اش را
   * — و بعد هم باید یادش می‌آمد برگردد و دکمه را بزند.
   *
   * نکتهٔ مهم: مسیر اینجا **هیچ فرمول تازه‌ای ندارد**. عیناً `graduate` صدا
   * زده می‌شود که خودش شرطِ «واحدها تمام شده» و قفلِ شرطیِ صدور مدرک را دارد؛
   * پس اجرای دوبارهٔ چرخه هرگز دو مدرک نمی‌دهد.
   *
   * @returns فارغ‌التحصیلانِ همین چرخه (برای اعلان به بازیکن).
   */
  async graduateDueStudents(limit: number = EDUCATION_SWEEP_BATCH): Promise<GraduatedStudent[]> {
    const candidates = await this.playerRepository.listEnrolledStudents(limit)
    const graduated: GraduatedStudent[] = []

    for (const candidate of candidates) {
      const field = EDUCATION_FIELDS.find((f) => f.key === candidate.enrolledFieldKey)
      if (!field) {
        continue
      }
      const elapsedMinutes = gameMinutesSince(candidate.studyStartedAt)
      if (elapsedMinutes < field.gameDurationMinutes) {
        continue
      }
      try {
        const result = await this.graduate(candidate.telegramUserId)
        graduated.push({
          telegramUserId: candidate.telegramUserId,
          degreeLabel: result.degreeLabel,
          fieldTitle: result.fieldTitle,
          gainedExp: result.gainedExp
        })
      } catch (error) {
        // دادهٔ ناقص یا مسابقه‌ای که دیگری برده — یک دانشجوی بد نباید بقیه را
        // از صف بیرون بیندازد.
        logger.warn(
          { err: error, telegramUserId: candidate.telegramUserId.toString() },
          'autonomous graduation skipped'
        )
      }
    }

    return graduated
  }
}