import { ProfilePrivacy } from '@prisma/client'
import { PlayerRepository } from '../../database/repositories/player.repository'
import { PlayerIdentityView, PlayerService } from '../identity/player.service'
import { NotFoundError } from '../../utils/classes/errors'

export interface ProfileInspectionResult {
  isOwner: boolean
  isPrivate: boolean
  profile?: PlayerIdentityView
}

export class IdentityPrivacyService {
  constructor(
    private readonly playerRepository: PlayerRepository,
    private readonly playerService: PlayerService
  ) {}

  async togglePrivacy(telegramUserId: bigint): Promise<ProfilePrivacy> {
    const player = await this.playerRepository.findByTelegramUserId(telegramUserId)
    if (!player) {
      throw new NotFoundError('Player not found')
    }

    const newPrivacy =
      player.privacy === ProfilePrivacy.PUBLIC ? ProfilePrivacy.PRIVATE : ProfilePrivacy.PUBLIC

    await this.playerRepository.update(telegramUserId, { privacy: newPrivacy })
    return newPrivacy
  }

  async getProfileForViewer(
    viewerTelegramId: bigint,
    targetTelegramId: bigint
  ): Promise<ProfileInspectionResult> {
    const isOwner = viewerTelegramId === targetTelegramId
    const targetPlayer = await this.playerRepository.findByTelegramUserId(targetTelegramId)
    if (!targetPlayer) {
      throw new NotFoundError('Player not found')
    }

    if (!isOwner && targetPlayer.privacy === ProfilePrivacy.PRIVATE) {
      return { isOwner: false, isPrivate: true }
    }

    const profile = await this.playerService.getProfile(targetTelegramId)
    return { isOwner, isPrivate: false, profile }
  }
}