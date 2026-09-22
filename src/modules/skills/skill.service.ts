import { PlayerActivityState, PrismaClient, TransactionType } from '@prisma/client'
import { SkillRepository } from '../../database/repositories/skill.repository'
import { PlayerSkillRepository } from '../../database/repositories/player-skill.repository'
import { PlayerRepository } from '../../database/repositories/player.repository'
import { ConflictError, NotFoundError, ValidationError } from '../../utils/classes/errors'
import { gameDayStart } from '../../utils/game-time'
import {
  applyTrainingPoints,
  canTrainToday,
  isMaxLevel,
  pointsToNextLevel,
  TRAINING_FATIGUE,
  trainingSessionCost
} from './skill-training'
import { BUSINESS_BLUEPRINTS, PART_TIME_JOBS } from '../occupation/work-blueprints'

export class SkillService {
  constructor(
    private readonly skillRepository: SkillRepository,
    private readonly playerSkillRepository: PlayerSkillRepository,
    private readonly playerRepository: PlayerRepository,
    private readonly db?: PrismaClient
  ) {}

  async listPlayerSkills(telegramUserId: bigint) {
    const player = await this.playerRepository.findByTelegramUserId(telegramUserId)
    if (!player) {
      throw new NotFoundError('Player not found')
    }

    return this.playerSkillRepository.listByPlayerId(player.id)
  }


  /**
   * تمرینِ فعال یک مهارت: پول + خستگی در برابر امتیاز تمرین.
   *
   * • هزینه با سطح فعلی و تعداد جلسه‌های امروز زیاد می‌شود (`trainingSessionCost`).
   * • روزانه حداکثر چند جلسه (شمارش از روی دفتر کلِ همان روز — منبع واقعی).
   * • خستگیِ تمرین با خستگیِ کار جمع می‌شود؛ بازیکن باید بین «الان کار کنم»
   *   و «الان تمرین کنم» تصمیم بگیرد.
   * • کل عملیات اتمیک است: گارد موجودی، نوشت امتیاز/سطح و دفتر کل در یک تراکنش.
   */
  async trainSkill(telegramUserId: bigint, skillId: string): Promise<{
    skillName: string
    cost: number
    level: number
    points: number
    leveledUp: boolean
    pointsToNext: number | null
  }> {
    if (!this.db) {
      throw new ConflictError('Training unavailable', 'تمرین مهارت در دسترس نیست.')
    }

    const player = await this.playerRepository.findByTelegramUserId(telegramUserId)
    if (!player) {
      throw new NotFoundError('Player not found')
    }
    if (player.status === 'DEAD' || player.status === 'BANNED') {
      throw new ConflictError('Player inactive', 'شخصیت فعال امکان تمرین ندارد.')
    }
    if (player.activityState === PlayerActivityState.WORKING) {
      throw new ConflictError('Busy working', 'حین شیفت کاری نمی‌توانی تمرین کنی؛ اول شیفت را تمام کن.')
    }

    const skill = await this.skillRepository.findById(skillId)
    if (!skill) {
      throw new NotFoundError('Skill not found', 'مهارت موردنظر یافت نشد. فهرست مهارت‌ها را به‌روزرسانی کن.')
    }

    const existing = await this.db.playerSkill.findUnique({
      where: { playerId_skillId: { playerId: player.id, skillId } }
    })
    const currentLevel = existing?.level ?? 1
    const currentPoints = existing?.points ?? 0

    if (isMaxLevel(currentLevel)) {
      throw new ConflictError('Max level', 'این مهارت به سقف رسیده است؛ تمرین بیشتر اثری ندارد.')
    }
    if (player.fatigue + TRAINING_FATIGUE > 100) {
      throw new ValidationError(
        'Too tired to train',
        'برای تمرین انرژی لازم است؛ اول استراحت کن تا خستگی‌ات کم شود.'
      )
    }

    // جلسه‌های «امروز» از دفتر کل واقعی شمرده می‌شوند — با مرزِ روز *بازی*.
    const dayStart = gameDayStart()
    const sessionsToday = await this.db.financialTransaction.count({
      where: {
        sourcePlayerId: player.id,
        type: TransactionType.SKILL_TRAINING,
        createdAt: { gte: dayStart }
      }
    })
    if (!canTrainToday(sessionsToday)) {
      throw new ConflictError(
        'Daily training limit',
        'برای امروز به اندازه کافی تمرین کردی؛ فردا دوباره. تمرین زیاد بازده ندارد.'
      )
    }

    const cost = trainingSessionCost(currentLevel, sessionsToday)

    const result = await this.db.$transaction(async (tx) => {
      const debited = await tx.player.updateMany({
        where: { id: player.id, balance: { gte: cost } },
        data: { balance: { decrement: cost } }
      })
      if (debited.count !== 1) {
        throw new ValidationError(
          'Insufficient balance for training',
          `هزینهٔ این جلسه تمرین ${cost.toLocaleString('fa-IR')} تومان است و موجودی‌ات کافی نیست.`
        )
      }

      const next = applyTrainingPoints(currentLevel, currentPoints)
      await tx.playerSkill.upsert({
        where: { playerId_skillId: { playerId: player.id, skillId } },
        create: { playerId: player.id, skillId, level: next.level, points: next.points },
        update: { level: next.level, points: next.points }
      })

      await tx.player.update({
        where: { id: player.id },
        data: { fatigue: Math.min(100, player.fatigue + TRAINING_FATIGUE) }
      })

      await tx.financialTransaction.create({
        data: {
          amount: cost,
          type: TransactionType.SKILL_TRAINING,
          sourcePlayerId: player.id,
          reference: `تمرین مهارت: ${skill.name}`
        }
      })

      return next
    })

    return {
      skillName: skill.name,
      cost,
      level: result.level,
      points: result.points,
      leveledUp: result.leveledUp,
      pointsToNext: isMaxLevel(result.level) ? null : pointsToNextLevel(result.points)
    }
  }

  /**
   * نمای تمرین مهارت‌ها: وضعیت فعلی + هزینهٔ جلسهٔ بعدی + اینکه این مهارت
   * واقعاً کجا مصرف می‌شود (کدام کارها و کدام مدل‌های کسب‌وکار).
   * «مصرف» از کاتالوگ‌های واقعی شغل و کسب‌وکار خوانده می‌شود، نه متن ساختگی.
   */
  async getTrainingOverview(telegramUserId: bigint): Promise<{
    sessionsToday: number
    canTrainMore: boolean
    skills: Array<{
      id: string
      name: string
      description: string | null
      level: number
      points: number
      pointsToNext: number | null
      maxed: boolean
      nextSessionCost: number
      usedInJobs: string[]
      usedInBusinesses: string[]
    }>
  }> {
    if (!this.db) {
      throw new ConflictError('Training unavailable', 'تمرین مهارت در دسترس نیست.')
    }

    const player = await this.playerRepository.findByTelegramUserId(telegramUserId)
    if (!player) {
      throw new NotFoundError('Player not found')
    }

    const dayStart = gameDayStart()
    const [catalog, playerSkills, sessionsToday] = await Promise.all([
      this.skillRepository.list(),
      this.playerSkillRepository.listByPlayerId(player.id),
      this.db.financialTransaction.count({
        where: {
          sourcePlayerId: player.id,
          type: TransactionType.SKILL_TRAINING,
          createdAt: { gte: dayStart }
        }
      })
    ])
    const bySkillId = new Map(playerSkills.map((ps) => [ps.skillId, ps]))

    return {
      sessionsToday,
      canTrainMore: canTrainToday(sessionsToday),
      skills: catalog.map((skill) => {
        const mine = bySkillId.get(skill.id)
        const level = mine?.level ?? 1
        const points = mine?.points ?? 0
        const maxed = isMaxLevel(level)
        return {
          id: skill.id,
          name: skill.name,
          description: skill.description,
          level,
          points,
          pointsToNext: maxed ? null : pointsToNextLevel(points),
          maxed,
          nextSessionCost: trainingSessionCost(level, sessionsToday),
          usedInJobs: PART_TIME_JOBS.filter((job) => job.requiredSkills.includes(skill.name))
            .map((job) => job.name)
            .slice(0, 3),
          usedInBusinesses: BUSINESS_BLUEPRINTS.filter((b) =>
            b.requiredSkills.includes(skill.name)
          )
            .map((b) => b.title)
            .slice(0, 3)
        }
      })
    }
  }
}

export const skillCategories = {
  technical: 'فنی',
  business: 'تجاری',
  communication: 'ارتباطی',
  education: 'آموزشی',
  management: 'مدیریتی'
} as const
