import { RegistrationService } from '../src/modules/registration/registration.service'
import { PlayerRepository } from '../src/database/repositories/player.repository'
import { UserStateRepository } from '../src/database/repositories/user-state.repository'
import { RewardsService } from '../src/modules/rewards/rewards.service'
import { ActivityService } from '../src/modules/activity/activity.service'
import { ResidenceService } from '../src/modules/residence/residence.service'
import { Player, PrismaClient, UserState } from '@prisma/client'

function makeState(data: Record<string, unknown> = {}): UserState {
  return {
    id: 'state-1',
    telegramUserId: 42n,
    currentContext: 'registration',
    stateData: data,
    pendingSince: new Date(),
    updatedAt: new Date()
  } as unknown as UserState
}

const PLAYER = { id: 'referee-1', telegramUserId: 42n } as unknown as Player

describe('RegistrationService — referral code carried through signup', () => {
  const profile = { telegramUserId: 42n, firstName: 'علی', lastName: null, username: null }

  function build() {
    const playerRepository = {
      isRegistered: jest.fn().mockResolvedValue(false),
      createUpsert: jest.fn().mockResolvedValue(PLAYER)
    }
    const userStateRepository = {
      findByTelegramUserId: jest.fn(),
      upsert: jest.fn().mockResolvedValue(makeState()),
      clear: jest.fn().mockResolvedValue(undefined)
    }
    const service = new RegistrationService(
      playerRepository as unknown as PlayerRepository,
      userStateRepository as unknown as UserStateRepository
    )
    return { service, playerRepository, userStateRepository }
  }

  test('the referral code from the deep link is persisted in the state', async () => {
    const { service, userStateRepository } = build()

    await service.start(profile, 'ABC23456')

    expect(userStateRepository.upsert).toHaveBeenCalledWith(
      42n,
      expect.objectContaining({ stateData: { referralCode: 'ABC23456' } })
    )
  })

  test('starting without a deep link stores an empty state', async () => {
    const { service, userStateRepository } = build()

    await service.start(profile)

    expect(userStateRepository.upsert).toHaveBeenCalledWith(
      42n,
      expect.objectContaining({ stateData: {} })
    )
  })

  test('completing registration returns the stored referral code', async () => {
    const { service, userStateRepository } = build()
    userStateRepository.findByTelegramUserId.mockResolvedValue(
      makeState({ gender: 'MALE', referralCode: 'ABC23456' })
    )

    const outcome = await service.submitBiography(profile, 'یک زندگی تازه', 18)

    expect(outcome.referralCode).toBe('ABC23456')
    expect(outcome.player).toBe(PLAYER)
  })

  test('a signup without referral reports no code', async () => {
    const { service, userStateRepository } = build()
    userStateRepository.findByTelegramUserId.mockResolvedValue(makeState({ gender: 'MALE' }))

    const outcome = await service.submitBiography(profile, 'یک زندگی تازه', 18)

    expect(outcome.referralCode).toBeUndefined()
  })
})

describe('RewardsService — referral linking', () => {
  function makeDb(referrer: Record<string, unknown> | null) {
    return {
      player: {
        findFirst: jest.fn().mockResolvedValue(referrer),
        findUnique: jest.fn().mockResolvedValue({ id: 'referee-1' }),
        update: jest.fn().mockResolvedValue({})
      },
      referral: {
        create: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn().mockResolvedValue(null),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        count: jest.fn().mockResolvedValue(0)
      },
      financialTransaction: { create: jest.fn() },
      $transaction: jest.fn()
    }
  }

  function service(db: ReturnType<typeof makeDb>) {
    return new RewardsService(
      db as unknown as PrismaClient,
      {
        recordPlayerEvent: jest.fn().mockResolvedValue(undefined)
      } as never
    )
  }

  test('an unknown code is ignored silently', async () => {
    const db = makeDb(null)

    await expect(service(db).linkReferral('referee-1', 'NOPE')).resolves.toBe(false)
    expect(db.referral.create).not.toHaveBeenCalled()
  })

  test('self-referral is rejected', async () => {
    const db = makeDb({ id: 'referee-1' })

    await expect(service(db).linkReferral('referee-1', 'SELF1234')).resolves.toBe(false)
    expect(db.referral.create).not.toHaveBeenCalled()
  })

  test('a valid code links referrer and referee', async () => {
    const db = makeDb({ id: 'referrer-1' })

    await expect(service(db).linkReferral('referee-1', 'abc23456')).resolves.toBe(true)
    expect(db.player.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { referralCode: 'ABC23456' } })
    )
  })

  test('being referred twice is rejected by the unique constraint', async () => {
    const db = makeDb({ id: 'referrer-1' })
    db.referral.create.mockRejectedValue(new Error('unique violation'))

    await expect(service(db).linkReferral('referee-1', 'ABC23456')).resolves.toBe(false)
  })

  test('signup rewards are paid exactly once', async () => {
    const db = makeDb({ id: 'referrer-1' })
    db.referral.findUnique.mockResolvedValue({
      id: 'r1',
      referrerPlayerId: 'referrer-1',
      refereePlayerId: 'referee-1',
      rewardedAt: null
    })
    const tx = {
      referral: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      player: { update: jest.fn().mockResolvedValue({}) },
      financialTransaction: { create: jest.fn() }
    }
    db.$transaction.mockImplementation(async (fn: (t: unknown) => Promise<unknown>) => fn(tx))

    const result = await service(db).settleReferralSignup(42n)

    expect(result.referrerRewarded).toBe(true)
    expect(tx.player.update).toHaveBeenCalledTimes(2)
    expect(tx.financialTransaction.create).toHaveBeenCalledTimes(2)
  })

  test('an already rewarded referral is not paid again', async () => {
    const db = makeDb({ id: 'referrer-1' })
    db.referral.findUnique.mockResolvedValue({
      id: 'r1',
      referrerPlayerId: 'referrer-1',
      refereePlayerId: 'referee-1',
      rewardedAt: new Date()
    })

    const result = await service(db).settleReferralSignup(42n)

    expect(result.referrerRewarded).toBe(false)
    expect(db.$transaction).not.toHaveBeenCalled()
  })

  test('the residence bonus requires the signup reward first', async () => {
    const db = makeDb({ id: 'referrer-1' })
    db.referral.findUnique.mockResolvedValue({
      id: 'r1',
      referrerPlayerId: 'referrer-1',
      refereePlayerId: 'referee-1',
      rewardedAt: null,
      bonusPaidAt: null
    })

    await service(db).settleReferralResidenceBonus('referee-1')

    expect(db.$transaction).not.toHaveBeenCalled()
    expect(db.referral.updateMany).not.toHaveBeenCalled()
  })

  test('the residence bonus is paid once and locked', async () => {
    const db = makeDb({ id: 'referrer-1' })
    db.referral.findUnique.mockResolvedValue({
      id: 'r1',
      referrerPlayerId: 'referrer-1',
      refereePlayerId: 'referee-1',
      rewardedAt: new Date(),
      bonusPaidAt: null
    })
    const tx = {
      // ادعا هم داخلِ همان تراکنشی است که پول می‌دهد؛ وگرنه شکستِ پرداخت
      // پاداش را برای همیشه «پرداخت‌شده» علامت می‌زند و پول هرگز نمی‌رسد.
      referral: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      player: { update: jest.fn().mockResolvedValue({}) },
      financialTransaction: { create: jest.fn() }
    }
    db.$transaction.mockImplementation(async (fn: (t: unknown) => Promise<unknown>) => fn(tx))

    await service(db).settleReferralResidenceBonus('referee-1')

    expect(db.$transaction).toHaveBeenCalledTimes(1)
    expect(tx.referral.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ bonusPaidAt: null })
      })
    )
    expect(tx.player.update).toHaveBeenCalledTimes(1)
    expect(tx.financialTransaction.create).toHaveBeenCalledTimes(1)
  })

  test('a lost race on the bonus lock pays nothing', async () => {
    const db = makeDb({ id: 'referrer-1' })
    db.referral.findUnique.mockResolvedValue({
      id: 'r1',
      referrerPlayerId: 'referrer-1',
      refereePlayerId: 'referee-1',
      rewardedAt: new Date(),
      bonusPaidAt: null
    })
    const tx = {
      referral: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      player: { update: jest.fn().mockResolvedValue({}) },
      financialTransaction: { create: jest.fn() }
    }
    db.$transaction.mockImplementation(async (fn: (t: unknown) => Promise<unknown>) => fn(tx))

    await service(db).settleReferralResidenceBonus('referee-1')

    // قفلِ شرطی صفر ردیف گرفت: نه پولی رفت و نه ردیفی در دفتر کل ثبت شد
    expect(tx.player.update).not.toHaveBeenCalled()
    expect(tx.financialTransaction.create).not.toHaveBeenCalled()
  })

  test('referral stats always expose a usable code', async () => {
    const db = makeDb(null)
    db.player.findUnique.mockResolvedValue({ id: 'p1', referralCode: null })
    db.referral.count.mockResolvedValueOnce(2).mockResolvedValueOnce(1)

    const stats = await service(db).getReferralStats(42n)

    expect(stats.code).toMatch(/^[A-Z0-9]{8}$/)
    expect(stats.invitedCount).toBe(2)
    expect(stats.pendingCount).toBe(1)
  })
})

describe('ActivityService — residence triggers the referral bonus', () => {
  function build(homeGroupId: string | null) {
    const db = {
      player: {
        findUnique: jest.fn().mockResolvedValue({ id: 'p1', homeGroupId, status: 'ACTIVE' }),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      },
      group: {
        findUnique: jest.fn().mockResolvedValue({ id: 'g1', title: 'شهر الف', status: 'ACTIVE' })
      },
      playerGroup: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({})
      },
      migration: { create: jest.fn().mockResolvedValue({}) }
    }
    const residence = new ResidenceService(
      db as unknown as PrismaClient,
      {
        recordPlayerEvent: jest.fn().mockResolvedValue(undefined)
      } as never
    )
    const rewards = { settleReferralResidenceBonus: jest.fn().mockResolvedValue(undefined) }
    const service = new ActivityService(db as unknown as PrismaClient, residence, rewards as never)
    return { service, rewards }
  }

  test('establishing a residence settles the referral bonus', async () => {
    const { service, rewards } = build(null)

    const result = await service.registerActivity(1n, -100n, 'identity')

    expect(result.residenceEstablished).toBe(true)
    expect(rewards.settleReferralResidenceBonus).toHaveBeenCalledWith('p1')
  })

  test('an existing residence does not settle the bonus again', async () => {
    const { service, rewards } = build('g-old')

    await service.registerActivity(1n, -100n, 'identity')

    expect(rewards.settleReferralResidenceBonus).not.toHaveBeenCalled()
  })

  test('a failing bonus never breaks the residence flow', async () => {
    const { service, rewards } = build(null)
    rewards.settleReferralResidenceBonus.mockRejectedValue(new Error('db down'))

    const result = await service.registerActivity(1n, -100n, 'identity')

    expect(result.residenceEstablished).toBe(true)
  })
})
