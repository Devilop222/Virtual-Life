import { ProfilePrivacy } from '@prisma/client'
import { IdentityPrivacyService } from '../src/modules/identity/identity-privacy.service'
import { PlayerRepository } from '../src/database/repositories/player.repository'
import { PlayerService } from '../src/modules/identity/player.service'

describe('IdentityPrivacyService', () => {
  let playerRepository: { findByTelegramUserId: jest.Mock; update: jest.Mock }
  let playerService: { getProfile: jest.Mock }
  let service: IdentityPrivacyService

  beforeEach(() => {
    playerRepository = {
      findByTelegramUserId: jest.fn(),
      update: jest.fn()
    }
    playerService = {
      getProfile: jest.fn()
    }
    service = new IdentityPrivacyService(
      playerRepository as unknown as PlayerRepository,
      playerService as unknown as PlayerService
    )
  })

  test('toggles privacy from PUBLIC to PRIVATE', async () => {
    playerRepository.findByTelegramUserId.mockResolvedValue({ privacy: ProfilePrivacy.PUBLIC })
    playerRepository.update.mockResolvedValue({})

    const newPrivacy = await service.togglePrivacy(42n)

    expect(newPrivacy).toBe(ProfilePrivacy.PRIVATE)
    expect(playerRepository.update).toHaveBeenCalledWith(42n, { privacy: ProfilePrivacy.PRIVATE })
  })

  test('allows owner to view their own profile even if private', async () => {
    playerRepository.findByTelegramUserId.mockResolvedValue({ privacy: ProfilePrivacy.PRIVATE })
    playerService.getProfile.mockResolvedValue({ firstName: 'Ali' })

    const result = await service.getProfileForViewer(42n, 42n)

    expect(result.isOwner).toBe(true)
    expect(result.isPrivate).toBe(false)
    expect(result.profile).toBeDefined()
  })

  test('blocks other users from viewing private profile', async () => {
    playerRepository.findByTelegramUserId.mockResolvedValue({ privacy: ProfilePrivacy.PRIVATE })

    const result = await service.getProfileForViewer(100n, 42n)

    expect(result.isOwner).toBe(false)
    expect(result.isPrivate).toBe(true)
    expect(result.profile).toBeUndefined()
  })
})