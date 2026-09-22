import { Player, RegistrationState, UserState } from '@prisma/client'
import { RegistrationService } from '../src/modules/registration/registration.service'
import { PlayerRepository } from '../src/database/repositories/player.repository'
import { UserStateRepository } from '../src/database/repositories/user-state.repository'
import { ConflictError, ValidationError } from '../src/utils/classes/errors'

describe('RegistrationService', () => {
  const profile = {
    telegramUserId: 42n,
    firstName: 'علی',
    lastName: null,
    username: null
  }

  const playerMock = {
    id: 'player-1',
    telegramUserId: 42n,
    firstName: 'علی',
    lastName: null,
    username: null,
    gender: 'MALE',
    biography: 'یک شخصیت',
    age: 18
  } as unknown as Player

  function makeState(gender?: string): UserState {
    return {
      id: 'state-1',
      telegramUserId: 42n,
      currentContext: 'registration',
      stateData: gender ? { gender } : {},
      pendingSince: new Date(),
      updatedAt: new Date()
    } as unknown as UserState
  }

  let playerRepository: jest.Mocked<Pick<PlayerRepository, 'isRegistered' | 'createUpsert'>>
  let userStateRepository: jest.Mocked<
    Pick<UserStateRepository, 'findByTelegramUserId' | 'upsert' | 'clear'>
  >
  let service: RegistrationService

  beforeEach(() => {
    playerRepository = {
      isRegistered: jest.fn(),
      createUpsert: jest.fn()
    }
    userStateRepository = {
      findByTelegramUserId: jest.fn(),
      upsert: jest.fn(),
      clear: jest.fn()
    }
    service = new RegistrationService(
      playerRepository as unknown as PlayerRepository,
      userStateRepository as unknown as UserStateRepository
    )
  })

  describe('start', () => {
    test('does not start registration for an existing player', async () => {
      playerRepository.isRegistered.mockResolvedValue(true)

      const outcome = await service.start(profile)

      expect(outcome.started).toBe(false)
      expect(outcome.step).toBe(RegistrationState.COMPLETED)
      expect(userStateRepository.upsert).not.toHaveBeenCalled()
    })

    test('starts registration for a new player', async () => {
      playerRepository.isRegistered.mockResolvedValue(false)
      userStateRepository.upsert.mockResolvedValue(makeState())

      const outcome = await service.start(profile)

      expect(outcome.started).toBe(true)
      expect(outcome.step).toBe(RegistrationState.AWAITING_GENDER)
    })

    test('re-running /start mid-registration keeps previously chosen gender', async () => {
      playerRepository.isRegistered.mockResolvedValue(false)
      // کاربر قبلاً جنسیت را انتخاب کرده است
      userStateRepository.findByTelegramUserId.mockResolvedValue(makeState('MALE'))
      userStateRepository.upsert.mockResolvedValue(makeState('MALE'))

      const outcome = await service.start(profile)

      expect(outcome.started).toBe(true)
      // stateData نباید خالی شود؛ جنسیت انتخاب‌شده حفظ می‌شود
      const upsertArgs = userStateRepository.upsert.mock.calls[0]?.[1]
      expect(upsertArgs?.stateData).toEqual({ gender: 'MALE' })
      expect(outcome.step).not.toBe(RegistrationState.AWAITING_GENDER)
    })

    test('re-running /start with a fresh referral code replaces only the referral', async () => {
      playerRepository.isRegistered.mockResolvedValue(false)
      userStateRepository.findByTelegramUserId.mockResolvedValue(makeState('MALE'))
      userStateRepository.upsert.mockResolvedValue(makeState('MALE'))

      await service.start(profile, 'REF-NEW')

      const upsertArgs = userStateRepository.upsert.mock.calls[0]?.[1]
      expect(upsertArgs?.stateData).toEqual({ gender: 'MALE', referralCode: 'REF-NEW' })
    })
  })

  describe('selectGender', () => {
    test('moves to biography step after gender selection', async () => {
      userStateRepository.findByTelegramUserId.mockResolvedValue(makeState())
      userStateRepository.upsert.mockResolvedValue(makeState('MALE'))

      const step = await service.selectGender(42n, 'MALE')

      expect(step).toBe(RegistrationState.AWAITING_BIOGRAPHY)
      expect(userStateRepository.upsert).toHaveBeenCalledWith(
        42n,
        expect.objectContaining({
          stateData: expect.objectContaining({ gender: 'MALE' })
        })
      )
    })

    test('rejects invalid gender', async () => {
      await expect(service.selectGender(42n, 'OTHER')).rejects.toThrow(ValidationError)
    })

    test('rejects when registration is not in progress', async () => {
      userStateRepository.findByTelegramUserId.mockResolvedValue(null)

      await expect(service.selectGender(42n, 'MALE')).rejects.toThrow()
    })
  })

  describe('submitBiography', () => {
    test('creates player and completes registration', async () => {
      userStateRepository.findByTelegramUserId.mockResolvedValue(makeState('MALE'))
      playerRepository.createUpsert.mockResolvedValue(playerMock)

      const outcome = await service.submitBiography(profile, 'من یک خلبان هستم.', 18)

      expect(outcome.step).toBe(RegistrationState.COMPLETED)
      expect(outcome.player).toBe(playerMock)
      expect(playerRepository.createUpsert).toHaveBeenCalledWith(
        expect.objectContaining({ gender: 'MALE', age: 18 })
      )
      expect(userStateRepository.clear).toHaveBeenCalledWith(42n)
    })

    test('rejects too-short biography', async () => {
      userStateRepository.findByTelegramUserId.mockResolvedValue(makeState('MALE'))

      await expect(service.submitBiography(profile, 'ab', 18)).rejects.toThrow(ValidationError)
    })

    test('rejects too-long biography', async () => {
      userStateRepository.findByTelegramUserId.mockResolvedValue(makeState('MALE'))
      const longBio = 'ب'.repeat(601)

      await expect(service.submitBiography(profile, longBio, 18)).rejects.toThrow(ValidationError)
    })

    test('rejects if gender was not selected', async () => {
      userStateRepository.findByTelegramUserId.mockResolvedValue(makeState())

      await expect(service.submitBiography(profile, 'یک بیوگرافی خوب', 18)).rejects.toThrow(
        ConflictError
      )
    })
  })

  describe('cancel', () => {
    test('clears the pending state', async () => {
      userStateRepository.clear.mockResolvedValue()

      await service.cancel(42n)

      expect(userStateRepository.clear).toHaveBeenCalledWith(42n)
    })
  })
})