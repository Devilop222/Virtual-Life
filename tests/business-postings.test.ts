import { PrismaClient } from '@prisma/client'
import {
  BusinessService,
  POST_SALARY_MAX,
  POST_SALARY_MIN
} from '../src/modules/occupation/business.service'
import { BusinessRepository } from '../src/database/repositories/business.repository'
import { PlayerRepository } from '../src/database/repositories/player.repository'
import { PayrollService } from '../src/modules/occupation/payroll.service'
import { ConflictError, ValidationError } from '../src/utils/classes/errors'

const OWNER = { id: 'own1', telegramUserId: 1n, age: 30, experience: 100, currentDegree: 'BACHELOR', status: 'ACTIVE' }
const BUSINESS = { id: 'b1', ownerId: 'own1', name: 'شرکت', status: 'ACTIVE', employeeCapacity: 5, treasury: 0, level: 1 }

function makeService(repoOverrides: Record<string, jest.Mock> = {}) {
  const businessRepository = {
    findById: jest.fn().mockResolvedValue(BUSINESS),
    createJobPosting: jest.fn().mockResolvedValue({ id: 'jp1' }),
    getJobPosting: jest.fn(),
    applyForJob: jest.fn().mockResolvedValue({ id: 'app1' }),
    findApplicationWithBusiness: jest.fn(),
    findPlayerProfile: jest.fn(),
    rejectApplication: jest.fn().mockResolvedValue({ count: 1 }),
    hireEmployee: jest.fn(),
    ...repoOverrides
  }
  const playerRepository = {
    findByTelegramUserId: jest.fn().mockResolvedValue(OWNER)
  }
  const payrollService = { settle: jest.fn(), previewSettlement: jest.fn() }
  const service = new BusinessService(
    businessRepository as unknown as BusinessRepository,
    playerRepository as unknown as PlayerRepository,
    payrollService as unknown as PayrollService
  )
  return { service, businessRepository, playerRepository }
}

const validInput = {
  title: 'برنامه‌نویس ارشد',
  salaryPerMinute: 2_000,
  capacity: 3,
  minExperience: 10,
  minAge: null,
  maxAge: null,
  requiredDegree: null,
  requiredSkill: null
}

describe('BusinessService — posting validation happens on the server', () => {
  test('salary bands: below 100 and above 3000 per minute are refused', async () => {
    const { service, businessRepository } = makeService()
    await expect(service.postJob(1n, 'b1', { ...validInput, salaryPerMinute: POST_SALARY_MIN - 1 })).rejects.toThrow(ValidationError)
    await expect(service.postJob(1n, 'b1', { ...validInput, salaryPerMinute: POST_SALARY_MAX + 1 })).rejects.toThrow(ValidationError)
    await expect(service.postJob(1n, 'b1', { ...validInput, salaryPerMinute: 1500.5 })).rejects.toThrow(ValidationError)
    expect(businessRepository.createJobPosting).not.toHaveBeenCalled()
  })

  test('capacity may never exceed the business capacity itself', async () => {
    const { service } = makeService()
    await expect(service.postJob(1n, 'b1', { ...validInput, capacity: BUSINESS.employeeCapacity + 1 })).rejects.toThrow(ValidationError)
  })

  test('non-sensical age bands are refused; free bounds stay null', async () => {
    const { service, businessRepository } = makeService()
    await expect(service.postJob(1n, 'b1', { ...validInput, minAge: 50, maxAge: 30 })).rejects.toThrow(ValidationError)
    await expect(service.postJob(1n, 'b1', { ...validInput, minAge: 12 })).rejects.toThrow(ValidationError)
    await service.postJob(1n, 'b1', validInput)
    const created = businessRepository.createJobPosting.mock.calls[0]![0]
    expect(created.minAge).toBeNull()
    expect(created.maxAge).toBeNull()
    expect(created.requiredDegree).toBe('DIPLOMA')
    expect(created.requiredSkill).toBeNull()
  })

  test('an overlong free-text skill name is refused', async () => {
    const { service } = makeService()
    await expect(service.postJob(1n, 'b1', { ...validInput, requiredSkill: 'x'.repeat(31) })).rejects.toThrow(ValidationError)
  })

  test('non-owners cannot post on someone else’s business', async () => {
    const { service, businessRepository } = makeService({
      findById: jest.fn().mockResolvedValue({ ...BUSINESS, ownerId: 'other' })
    })
    await expect(service.postJob(1n, 'b1', validInput)).rejects.toThrow(ConflictError)
    expect(businessRepository.createJobPosting).not.toHaveBeenCalled()
  })
})

describe('BusinessService — applicant eligibility is enforced at apply time', () => {
  const posting = (overrides: Record<string, unknown> = {}) => ({
    id: 'jp1',
    status: 'OPEN',
    capacity: 3,
    hiredCount: 0,
    minExperience: 20,
    minAge: 22,
    maxAge: 45,
    requiredDegree: 'BACHELOR',
    business: { status: 'ACTIVE' },
    ...overrides
  })

  test('closed posting, full posting and dead players never create applications', async () => {
    const closed = makeService({ getJobPosting: jest.fn().mockResolvedValue(posting({ status: 'CLOSED' })) })
    await expect(closed.service.applyForJob(2n, 'jp1')).rejects.toThrow(ConflictError)

    const full = makeService({ getJobPosting: jest.fn().mockResolvedValue(posting({ hiredCount: 3 })) })
    await expect(full.service.applyForJob(2n, 'jp1')).rejects.toThrow(ConflictError)

    const dead = makeService({ getJobPosting: jest.fn().mockResolvedValue(posting()) })
    dead.playerRepository.findByTelegramUserId.mockResolvedValue({ ...OWNER, status: 'DEAD' })
    await expect(dead.service.applyForJob(2n, 'jp1')).rejects.toThrow(ConflictError)
    expect(dead.businessRepository.applyForJob).not.toHaveBeenCalled()
  })

  test('an eligible application passes through with the player id', async () => {
    const { service, businessRepository } = makeService({ getJobPosting: jest.fn().mockResolvedValue(posting()) })
    businessRepository.applyForJob.mockResolvedValue({ id: 'app1' })
    await expect(service.applyForJob(1n, 'jp1')).resolves.toEqual({ id: 'app1' })
    expect(businessRepository.applyForJob).toHaveBeenCalledWith('jp1', 'own1')
  })

  test('ineligible applicant is refused and every shortfall is named', async () => {
    const businessRepository = {
      getJobPosting: jest.fn().mockResolvedValue(posting()),
      applyForJob: jest.fn()
    }
    const young = { ...OWNER, age: 19, experience: 5, currentDegree: null }
    const svc = new BusinessService(
      businessRepository as unknown as BusinessRepository,
      { findByTelegramUserId: jest.fn().mockResolvedValue(young) } as unknown as PlayerRepository,
      { settle: jest.fn() } as unknown as PayrollService
    )
    const err = await svc.applyForJob(3n, 'jp1').then(() => null, (e: Error & { persianMessage?: string }) => e)
    expect(err).toBeInstanceOf(ValidationError)
    // پیام فنی کوتاه است؛ جزئیات به بازیکن با persianMessage نشان داده می‌شود
    expect(err?.persianMessage).toMatch(/حداقل سن.*حداقل مدرک.*حداقل سابقه/su)
    expect(businessRepository.applyForJob).not.toHaveBeenCalled()
  })

  test('age is judged by the game calendar (weekly aging), not the raw signup age', async () => {
    const businessRepository = {
      getJobPosting: jest.fn().mockResolvedValue(posting()),
      applyForJob: jest.fn().mockResolvedValue({ id: 'app1' })
    }
    // یک سال بازی = ۱۲ روز واقعی (ساعت مرکزی بازی)
    const gameYear = 12 * 24 * 60 * 60 * 1000
    // ثبت‌نام در ۲۰ سالگی، ۸ سال بازی → سن بازی ۲۸: در باند ۲۲ تا ۴۵ می‌گنجد
    const grown = { ...OWNER, age: 20, startedAt: new Date(Date.now() - 8 * gameYear) }
    const svc = new BusinessService(
      businessRepository as unknown as BusinessRepository,
      { findByTelegramUserId: jest.fn().mockResolvedValue(grown) } as unknown as PlayerRepository,
      { settle: jest.fn() } as unknown as PayrollService
    )
    await expect(svc.applyForJob(3n, 'jp1')).resolves.toEqual({ id: 'app1' })

    // ثبت‌نام در ۳۰ سالگی، ۲۰ سال بازی → سن بازی ۵۰: از سقف ۴۵ بیرون است
    const tooOld = { ...OWNER, age: 30, startedAt: new Date(Date.now() - 20 * gameYear) }
    const oldSvc = new BusinessService(
      businessRepository as unknown as BusinessRepository,
      { findByTelegramUserId: jest.fn().mockResolvedValue(tooOld) } as unknown as PlayerRepository,
      { settle: jest.fn() } as unknown as PayrollService
    )
    const oldErr = await oldSvc.applyForJob(4n, 'jp1').then(() => null, (e: Error & { persianMessage?: string }) => e)
    expect(oldErr).toBeInstanceOf(ValidationError)
    expect(oldErr?.persianMessage).toMatch(/سقف سن/su)
  })
})

describe('BusinessService — hire re-validates at accept time', () => {
  function appFixture(overrides: Record<string, unknown> = {}) {
    return {
      id: 'app1',
      playerId: 'p9',
      status: 'PENDING',
      jobPosting: {
        businessId: 'b1',
        business: { ownerId: 'own1', status: 'ACTIVE' },
        minExperience: 20,
        minAge: 22,
        maxAge: 45,
        requiredDegree: 'BACHELOR',
        ...overrides
      }
    }
  }

  test('the owner hires; anyone else gets access-denied', async () => {
    const { service } = makeService({
      findApplicationWithBusiness: jest.fn().mockResolvedValue(appFixture()),
      findPlayerProfile: jest.fn().mockResolvedValue({ age: 30, experience: 100, currentDegree: 'BACHELOR' }),
      hireEmployee: jest.fn().mockResolvedValue({ id: 'e1' })
    })
    await expect(service.hireEmployee(1n, 'app1')).resolves.toEqual({ id: 'e1' })

    const s2 = new BusinessService(
      {
        findApplicationWithBusiness: jest.fn().mockResolvedValue(appFixture()),
        hireEmployee: jest.fn().mockResolvedValue({ id: 'e1' })
      } as unknown as BusinessRepository,
      { findByTelegramUserId: jest.fn().mockResolvedValue({ id: 'intruder' }) } as unknown as PlayerRepository,
      { settle: jest.fn() } as unknown as PayrollService
    )
    await expect(s2.hireEmployee(99n, 'app1')).rejects.toThrow(ConflictError)
  })

  test('an application that already expired (not PENDING) is refused', async () => {
    const { service, businessRepository } = makeService({
      findApplicationWithBusiness: jest.fn().mockResolvedValue({ ...appFixture(), status: 'ACCEPTED' }),
      findPlayerProfile: jest.fn().mockResolvedValue({ age: 30, experience: 100, currentDegree: 'BACHELOR' }),
      hireEmployee: jest.fn()
    })
    await expect(service.hireEmployee(1n, 'app1')).rejects.toThrow(ConflictError)
    expect(businessRepository.hireEmployee).not.toHaveBeenCalled()
  })

  test('eligibility drift since apply auto-rejects the stale application', async () => {
    const { service, businessRepository } = makeService({
      findApplicationWithBusiness: jest.fn().mockResolvedValue(appFixture()),
      findPlayerProfile: jest.fn().mockResolvedValue({ age: 50, experience: 25, currentDegree: 'BACHELOR' }),
      hireEmployee: jest.fn()
    })
    // ۵۰ ساله از سقف ۴۵ رد شده است ⇒ پذیرش نباید بشود، درخواست باید رد شود
    const err = await service.hireEmployee(1n, 'app1').then(() => null, (e: Error & { persianMessage?: string }) => e)
    expect(err).toBeInstanceOf(ValidationError)
    expect(err?.persianMessage).toMatch(/دیگر شرایط آگهی را ندارد/u)
    expect(businessRepository.rejectApplication).toHaveBeenCalled()
    expect(businessRepository.hireEmployee).not.toHaveBeenCalled()
  })
})

describe('BusinessRepository — capacity locks inside the hire transaction', () => {
  function makeRepo(tx: Record<string, unknown>) {
    const db = {
      $transaction: jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx))
    }
    return new BusinessRepository(db as unknown as PrismaClient)
  }

  const appRow = {
    id: 'app1',
    playerId: 'p9',
    status: 'PENDING',
    jobPosting: {
      id: 'jp1',
      title: 'برنامه‌نویس',
      salaryPerMinute: 1_000,
      capacity: 2,
      hiredCount: 0,
      status: 'OPEN',
      business: { id: 'b1', ownerId: 'own1', name: 'شرکت', status: 'ACTIVE', employeeCapacity: 5 }
    }
  }

  test('double hire on the last seat: the loser is rejected, not double-paid', async () => {
    const tx = {
      jobApplication: {
        findUnique: jest.fn().mockResolvedValue(appRow),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      },
      businessEmployee: { count: jest.fn().mockResolvedValue(0), upsert: jest.fn().mockResolvedValue({ id: 'e1' }) },
      jobPosting: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }), // صندلی را رقیب گرفته
        update: jest.fn().mockResolvedValue({})
      },
      business: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) }
    }
    const repo = makeRepo(tx)
    await expect(repo.hireEmployee('app1', 'own1')).rejects.toThrow(/Posting full/u)
    expect(tx.jobApplication.update).toHaveBeenCalledWith({
      where: { id: 'app1' },
      data: { status: 'REJECTED' }
    })
    expect(tx.businessEmployee.upsert).not.toHaveBeenCalled()
  })

  test('filling the last seat closes the posting and blocks other candidates', async () => {
    const tx = {
      jobApplication: {
        findUnique: jest.fn().mockResolvedValue({ ...appRow, jobPosting: { ...appRow.jobPosting, hiredCount: 1 } }),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      },
      businessEmployee: { count: jest.fn().mockResolvedValue(0), upsert: jest.fn().mockResolvedValue({ id: 'e1' }) },
      jobPosting: { updateMany: jest.fn().mockResolvedValue({ count: 1 }), update: jest.fn().mockResolvedValue({}) },
      business: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) }
    }
    const repo = makeRepo(tx)
    await expect(repo.hireEmployee('app1', 'own1')).resolves.toEqual({ id: 'e1' })
    // بستن آگهی شرطی است: hiredCountِ تازه + وضعیت OPEN — نه مقدار کهنه
    expect(tx.jobPosting.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'jp1',
          status: 'OPEN',
          hiredCount: { gte: 2 }
        }),
        data: { status: 'CLOSED' }
      })
    )
    // درخواست‌های بازِ دیگران برای همین آگهی باید بی‌اثر بمانند یا رد شوند —
    // حداقل درخواست‌های بازِ خودِ استخدام‌شده رد می‌شود:
    expect(tx.jobApplication.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'REJECTED' } })
    )
  })

  test('a full business refuses one more employee even if a seat was taken', async () => {
    const tx = {
      jobApplication: {
        findUnique: jest.fn().mockResolvedValue(appRow),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 0 })
      },
      businessEmployee: { count: jest.fn().mockResolvedValue(0), upsert: jest.fn() },
      jobPosting: { updateMany: jest.fn().mockResolvedValue({ count: 1 }), update: jest.fn() },
      business: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) } // کارمند فعال = ظرفیت
    }
    const repo = makeRepo(tx)
    await expect(repo.hireEmployee('app1', 'own1')).rejects.toThrow(/Business capacity full/u)
  })

  test('an already-employed applicant is never poached', async () => {
    const tx = {
      jobApplication: { findUnique: jest.fn().mockResolvedValue(appRow), update: jest.fn(), updateMany: jest.fn() },
      businessEmployee: { count: jest.fn().mockResolvedValue(1) },
      jobPosting: { updateMany: jest.fn(), update: jest.fn() },
      business: { updateMany: jest.fn() }
    }
    const repo = makeRepo(tx)
    await expect(repo.hireEmployee('app1', 'own1')).rejects.toThrow(/Already employed/u)
    expect(tx.jobPosting.updateMany).not.toHaveBeenCalled()
  })
})

describe('BusinessRepository — posting cap and duplicate applications', () => {
  test('a seventh open posting is refused by the repository', async () => {
    const tx = {
      jobPosting: { count: jest.fn().mockResolvedValue(6), create: jest.fn() }
    }
    const db = { $transaction: jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx)) }
    const repo = new BusinessRepository(db as unknown as PrismaClient)
    await expect(
      repo.createJobPosting({
        businessId: 'b1',
        title: 'مدیر',
        salaryPerMinute: 500,
        contractMinutesPerMonth: 14_400,
        capacity: 1,
        minExperience: 0,
        minAge: null,
        maxAge: null,
        requiredDegree: 'DIPLOMA',
        requiredSkill: null,
        requiredField: null
      })
    ).rejects.toThrow(ConflictError)
    expect(tx.jobPosting.create).not.toHaveBeenCalled()
  })
})
