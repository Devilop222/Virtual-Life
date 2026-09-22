import {
  DegreeLevel,
  canEnrollInDegree,
  degreeLabels,
  EDUCATION_FIELDS,
  nextEnrollableDegree
} from '../src/modules/education/education-blueprints'
import { EducationService } from '../src/modules/education/education.service'
import { buildEducationFieldsKeyboard } from '../src/bot/keyboards/main.keyboard'
import { PlayerRepository } from '../src/database/repositories/player.repository'
import { PlayerSkillRepository } from '../src/database/repositories/player-skill.repository'
import { SkillRepository } from '../src/database/repositories/skill.repository'
import { ValidationError } from '../src/utils/classes/errors'
import { PlayerActivityState, PlayerStatus } from '@prisma/client'

describe('Education System', () => {
  describe('Prerequisite Checks (Iranian Higher Ed Structure)', () => {
    test('allows Diploma to enroll in Bachelor directly or Associate', () => {
      expect(canEnrollInDegree(DegreeLevel.DIPLOMA, DegreeLevel.BACHELOR)).toBe(true)
      expect(canEnrollInDegree(DegreeLevel.DIPLOMA, DegreeLevel.ASSOCIATE)).toBe(true)
    })

    test('prevents skipping Bachelor directly to Doctorate from Diploma', () => {
      expect(canEnrollInDegree(DegreeLevel.DIPLOMA, DegreeLevel.DOCTORATE)).toBe(false)
    })

    test('allows sequential progression: Bachelor -> Master -> Doctorate', () => {
      expect(canEnrollInDegree(DegreeLevel.BACHELOR, DegreeLevel.MASTER)).toBe(true)
      expect(canEnrollInDegree(DegreeLevel.MASTER, DegreeLevel.DOCTORATE)).toBe(true)
    })
  })

  describe('EducationService', () => {
    let playerRepo: { findByTelegramUserId: jest.Mock; update: jest.Mock; enrollStudent: jest.Mock }
    let playerSkillRepo: { assign: jest.Mock }
    let skillRepo: { findByName: jest.Mock }
    let service: EducationService

    beforeEach(() => {
      playerRepo = {
        findByTelegramUserId: jest.fn(),
        update: jest.fn(),
        enrollStudent: jest.fn().mockResolvedValue(1)
      }
      playerSkillRepo = { assign: jest.fn() }
      skillRepo = { findByName: jest.fn() }
      service = new EducationService(
        playerRepo as unknown as PlayerRepository,
        playerSkillRepo as unknown as PlayerSkillRepository,
        skillRepo as unknown as SkillRepository
      )
    })

    test('rejects enrollment if player has insufficient tuition balance', async () => {
      playerRepo.findByTelegramUserId.mockResolvedValue({
        id: 'p1',
        balance: 100_000,
        currentDegree: DegreeLevel.DIPLOMA,
        isEnrolled: false,
        status: PlayerStatus.ACTIVE,
        activityState: PlayerActivityState.IDLE
      })

      await expect(
        service.enrollInUniversity(42n, 'software_engineering', DegreeLevel.BACHELOR)
      ).rejects.toThrow(ValidationError)
      expect(playerRepo.enrollStudent).not.toHaveBeenCalled()
    })

    test('successfully enrolls player when tuition and prerequisites are met', async () => {
      playerRepo.findByTelegramUserId.mockResolvedValue({
        id: 'p1',
        balance: 10_000_000,
        currentDegree: DegreeLevel.DIPLOMA,
        isEnrolled: false,
        status: PlayerStatus.ACTIVE,
        activityState: PlayerActivityState.IDLE
      })

      const result = await service.enrollInUniversity(42n, 'software_engineering', DegreeLevel.BACHELOR)
      expect(result.field.title).toContain('مهندسی کامپیوتر')
      // کسر شهریه و ثبت‌نام اتمیک با شرط «در حال تحصیل نبودن» و «موجودی کافی»
      expect(playerRepo.enrollStudent).toHaveBeenCalledWith(
        42n,
        expect.any(Number),
        expect.objectContaining({ enrolledFieldKey: 'software_engineering' })
      )
      // کسر شهریه و ردیف دفتر کل، هر دو داخل همان تراکنش مخزن انجام می‌شود
      expect(playerRepo.enrollStudent).toHaveBeenCalledWith(
        42n,
        expect.any(Number),
        expect.objectContaining({ reference: expect.any(String) })
      )
    })

    test('rejects enrollment when the atomic conditional update matches nothing', async () => {
      playerRepo.findByTelegramUserId.mockResolvedValue({
        id: 'p1',
        balance: 10_000_000,
        currentDegree: DegreeLevel.DIPLOMA,
        isEnrolled: false,
        status: PlayerStatus.ACTIVE,
        activityState: PlayerActivityState.IDLE
      })
      // موجودی بین بررسی اولیه و به‌روزرسانی شرطی خالی شده است
      playerRepo.enrollStudent.mockResolvedValue(0)

      await expect(
        service.enrollInUniversity(42n, 'software_engineering', DegreeLevel.BACHELOR)
      ).rejects.toThrow(ValidationError)
      expect(playerRepo.enrollStudent).toHaveBeenCalledTimes(1)
    })

    test('allows Bachelor -> Master once the ladder is reachable from the UI', async () => {
      playerRepo.findByTelegramUserId.mockResolvedValue({
        id: 'p1',
        balance: 10_000_000,
        currentDegree: DegreeLevel.BACHELOR,
        isEnrolled: false,
        status: PlayerStatus.ACTIVE,
        activityState: PlayerActivityState.IDLE
      })

      const result = await service.enrollInUniversity(42n, 'business_management', DegreeLevel.MASTER)
      expect(result.field.title).toContain('مدیریت بازرگانی')
    })
  })
})

describe('Degree ladder: nextEnrollableDegree (no dead-end after Bachelor)', () => {
  const fieldOf = (key: string) => {
    const field = EDUCATION_FIELDS.find((f) => f.key === key)
    if (!field) throw new Error(`field ${key} missing`)
    return field
  }

  test('diploma: smallest supported next degree per field', () => {
    // رشته‌ای که کاردانی هم دارد، قدم اول کاردانی را نشان می‌دهد
    expect(nextEnrollableDegree(DegreeLevel.DIPLOMA, fieldOf('software_engineering'))).toBe(
      DegreeLevel.ASSOCIATE
    )
    // رشته‌ای که کاردانی ندارد، مستقیم کارشناسی (قاعدهٔ مستقیم از دیپلم)
    expect(nextEnrollableDegree(DegreeLevel.DIPLOMA, fieldOf('medicine'))).toBe(DegreeLevel.BACHELOR)
    expect(nextEnrollableDegree(DegreeLevel.DIPLOMA, fieldOf('law'))).toBe(DegreeLevel.BACHELOR)
  })

  test('sequential upgrades: Associate -> Bachelor -> Master -> Doctorate', () => {
    expect(nextEnrollableDegree(DegreeLevel.ASSOCIATE, fieldOf('software_engineering'))).toBe(
      DegreeLevel.BACHELOR
    )
    expect(nextEnrollableDegree(DegreeLevel.BACHELOR, fieldOf('software_engineering'))).toBe(
      DegreeLevel.MASTER
    )
    expect(nextEnrollableDegree(DegreeLevel.MASTER, fieldOf('software_engineering'))).toBe(
      DegreeLevel.DOCTORATE
    )
  })

  test('a field that stops early yields no button, not a failing one', () => {
    // حسابداری دکتری ارائه نمی‌دهد
    expect(nextEnrollableDegree(DegreeLevel.MASTER, fieldOf('accounting'))).toBeNull()
    // نردبان فقط قدم‌به‌قدم است: پزشکی «ارشد» ندارد، پس برای دارندهٔ
    // کارشناسی در این رشته دکمه‌ای ساخته نمی‌شود (نه دکمه‌ای که رد شود)
    expect(nextEnrollableDegree(DegreeLevel.BACHELOR, fieldOf('medicine'))).toBeNull()
    expect(nextEnrollableDegree(DegreeLevel.MASTER, fieldOf('medicine'))).toBe(
      DegreeLevel.DOCTORATE
    )
  })

  test('the ladder is always continuable until Doctorate', () => {
    for (const current of [
      DegreeLevel.DIPLOMA,
      DegreeLevel.ASSOCIATE,
      DegreeLevel.BACHELOR,
      DegreeLevel.MASTER
    ]) {
      const anyFieldHasNext = EDUCATION_FIELDS.some((field) => {
        const next = nextEnrollableDegree(current, field)
        return next !== null && canEnrollInDegree(current, next) && field.supportedDegrees.includes(next)
      })
      expect(anyFieldHasNext).toBe(true)
    }
    // در دکتری هیچ رشته‌ای مقطع بالاتری ندارد
    for (const field of EDUCATION_FIELDS) {
      expect(nextEnrollableDegree(DegreeLevel.DOCTORATE, field)).toBeNull()
    }
  })

  test('keyboard buttons carry the per-field degree and a readable label', () => {
    const keyboard = buildEducationFieldsKeyboard([
      {
        key: 'law',
        degree: DegreeLevel.MASTER,
        title: 'حقوق و قضا',
        baseTuitionCost: 1_600_000
      }
    ])
    const buttons = keyboard.inline_keyboard.flat()
    const enrollButton = buttons.find(
      (b) => 'callback_data' in b && b.callback_data === 'edu:enroll:law:MASTER'
    )
    expect(enrollButton).toBeDefined()
    expect((enrollButton as { text: string }).text).toContain(degreeLabels[DegreeLevel.MASTER])
  })
})