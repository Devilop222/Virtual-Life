import {
  Player,
  Prisma,
  RegistrationState,
  UserState
} from '@prisma/client'
import { PlayerRepository } from '../../database/repositories/player.repository'
import { UserStateRepository } from '../../database/repositories/user-state.repository'
import { ConflictError, ValidationError } from '../../utils/classes/errors'
import { biographySchema, genderSchema, plainInput } from '../../utils/validation'

export const REGISTRATION_CONTEXT = 'registration'

export interface RegistrationProfile {
  telegramUserId: bigint
  firstName: string
  lastName?: string | null
  username?: string | null
}

export interface RegistrationOutcome {
  started: boolean
  step: RegistrationState
  player?: Player
  /**
   * کد معرفی که کاربر با آن وارد شده است.
   * فقط در لحظهٔ تکمیل ثبت‌نام برگردانده می‌شود تا Handler پاداش را تسویه کند.
   */
  referralCode?: string
}

export class RegistrationService {
  constructor(
    private readonly playerRepository: PlayerRepository,
    private readonly userStateRepository: UserStateRepository
  ) {}

  /**
   * آغاز ثبت‌نام.
   *
   * اگر کاربر از طریق لینک دعوت آمده باشد، کد معرف در State نگه داشته می‌شود
   * تا بعد از ساخته شدن رکورد بازیکن قابل استفاده باشد. کد هرگز اعتبارسنجی
   * نمی‌شود؛ اعتبارسنجی وظیفهٔ سرویس پاداش است.
   */
  async start(profile: RegistrationProfile, referralCode?: string): Promise<RegistrationOutcome> {
    const existing = await this.playerRepository.isRegistered(profile.telegramUserId)
    if (existing) {
      return { started: false, step: RegistrationState.COMPLETED }
    }

    // اجرای دوبارهٔ /start وسط ثبت‌نام نباید انتخاب‌های قبلی (مثل جنسیت) را پاک کند؛
    // دادهٔ موجود حفظ و فقط کد رفرال جدید در صورت وجود جایگزین می‌شود.
    const existingState = await this.userStateRepository.findByTelegramUserId(
      profile.telegramUserId
    )
    const previousData = (existingState?.stateData ?? {}) as Record<string, Prisma.InputJsonValue>

    const state = await this.userStateRepository.upsert(profile.telegramUserId, {
      currentContext: REGISTRATION_CONTEXT,
      stateData: referralCode ? { ...previousData, referralCode } : { ...previousData }
    })

    return {
      started: true,
      step: this.resolveStep(state)
    }
  }

  private resolveStep(state: UserState): RegistrationState {
    if (state.currentContext !== REGISTRATION_CONTEXT) {
      return RegistrationState.COMPLETED
    }

    const gender = this.readStoredGender(state)
    return gender ? RegistrationState.AWAITING_BIOGRAPHY : RegistrationState.AWAITING_GENDER
  }

  private readStoredGender(state: UserState): string | null {
    const stateData = state.stateData as { gender?: unknown }
    return typeof stateData.gender === 'string' ? stateData.gender : null
  }

  /** کد معرفی ذخیره‌شده در جریان ثبت‌نام. */
  private readStoredReferralCode(state: UserState): string | null {
    const stateData = state.stateData as { referralCode?: unknown }
    return typeof stateData.referralCode === 'string' ? stateData.referralCode : null
  }

  /**
   * جریانِ «زندگی تازه» از همان ماشین‌حالتِ ثبت‌نام استفاده می‌کند.
   *
   * چرا؟ چون بازیکن همین حالا جنسیت‌گرفتن و معرفی‌نوشتن را یاد گرفته و
   * دوباره‌ساختنِ همان دو مرحله فقط دو تجربهٔ ناهماهنگ می‌ساخت. تنها
   * تفاوت این است که پایانِ جریان، به‌جای ساختنِ ردیف بازیکنِ تازه، همان
   * ردیفِ موجود را به زندگیِ بعدی می‌برد.
   */
  private readRebirthTarget(state: UserState): string | null {
    const stateData = state.stateData as { rebirthPlayerId?: unknown }
    return typeof stateData.rebirthPlayerId === 'string' ? stateData.rebirthPlayerId : null
  }

  /** جنسیتِ انتخاب‌شدهٔ همین جریان (برای مسیر زندگی تازه لازم است). */
  async storedGender(telegramUserId: bigint): Promise<string | null> {
    const state = await this.userStateRepository.findByTelegramUserId(telegramUserId)
    if (!state || state.currentContext !== REGISTRATION_CONTEXT) {
      return null
    }
    return this.readStoredGender(state)
  }

  /** شناسهٔ بازیکنی که این جریان باید زندگی تازه‌ای برایش بسازد (اگر چنین جریانی باشد). */
  async currentRebirthTarget(telegramUserId: bigint): Promise<string | null> {
    const state = await this.userStateRepository.findByTelegramUserId(telegramUserId)
    if (!state || state.currentContext !== REGISTRATION_CONTEXT) {
      return null
    }
    return this.readRebirthTarget(state)
  }

  /**
   * شروع جریانِ زندگی تازه: فقط مرحلهٔ جنسیت را باز می‌کند و هدف را نگه می‌دارد.
   * ساخته‌شدنِ شخصیت در `RebirthService` و در پایانِ همین جریان انجام می‌شود.
   */
  async beginRebirth(telegramUserId: bigint, playerId: string): Promise<RegistrationState> {
    await this.userStateRepository.upsert(telegramUserId, {
      currentContext: REGISTRATION_CONTEXT,
      stateData: { rebirthPlayerId: playerId } satisfies Prisma.InputJsonObject
    })
    return RegistrationState.AWAITING_GENDER
  }

  async currentStep(telegramUserId: bigint): Promise<RegistrationState | null> {
    const state = await this.userStateRepository.findByTelegramUserId(telegramUserId)
    if (!state || state.currentContext !== REGISTRATION_CONTEXT) {
      return null
    }
    return this.resolveStep(state)
  }

  async selectGender(telegramUserId: bigint, genderRaw: unknown): Promise<RegistrationState> {
    const parsed = genderSchema.safeParse(genderRaw)
    if (!parsed.success) {
      throw new ValidationError('Invalid gender', 'لطفاً از دکمه‌های انتخاب جنسیت استفاده کن.')
    }
    const gender = parsed.data

    const state = await this.userStateRepository.findByTelegramUserId(telegramUserId)
    if (!state || state.currentContext !== REGISTRATION_CONTEXT) {
      throw new ConflictError('Registration not in progress', 'ثبت‌نام فعالی نداری. در چت خصوصی ربات /start را بفرست.')
    }

    const stateData = state.stateData as Record<string, unknown>
    await this.userStateRepository.upsert(telegramUserId, {
      currentContext: REGISTRATION_CONTEXT,
      stateData: { ...stateData, gender }
    })

    return RegistrationState.AWAITING_BIOGRAPHY
  }

  async submitBiography(
    profile: RegistrationProfile,
    biographyRaw: unknown,
    age: number
  ): Promise<RegistrationOutcome> {
    const state = await this.userStateRepository.findByTelegramUserId(profile.telegramUserId)
    if (!state || state.currentContext !== REGISTRATION_CONTEXT) {
      throw new ConflictError('Registration not in progress', 'ثبت‌نام فعالی نداری. در چت خصوصی ربات /start را بفرست.')
    }

    const gender = this.readStoredGender(state)
    if (!gender) {
      throw new ConflictError('Gender not selected', 'ابتدا جنسیت شخصیتت را با دکمه انتخاب کن؛ سپس معرفی کوتاهت را بنویس.')
    }

    const biography = biographySchema.safeParse(biographyRaw)
    if (!biography.success) {
      const reason = biography.error.issues[0]?.code
      if (reason === 'too_big') {
        throw new ValidationError('Biography too long', 'بیوگرافی طولانی است. حداکثر ۶۰۰ کاراکتر مجاز است.')
      }
      throw new ValidationError('Biography too short', 'معرفی شخصیت کوتاه است. یک متن ۳ تا ۶۰۰ نویسه‌ای بفرست.')
    }

    // متن آزاد در پنل‌های مارک‌داون نمایش داده می‌شود؛ نویسه‌های مارک‌داون حذف می‌شوند
    const cleanBiography = plainInput(biography.data)
    if (cleanBiography.length < 3) {
      throw new ValidationError('Biography too short', 'معرفی شخصیت کوتاه است. یک متن ۳ تا ۶۰۰ نویسه‌ای بفرست.')
    }

    const cleanFirstName = plainInput(profile.firstName)

    const player = await this.playerRepository.createUpsert({
      telegramUserId: profile.telegramUserId,
      // نام تلگرام ممکن است فقط نویسه‌های مارک‌داون باشد؛ در آن حالت برچسب عمومی
      firstName: cleanFirstName.length > 0 ? cleanFirstName : 'کاربر',
      lastName: profile.lastName ? plainInput(profile.lastName) || null : null,
      username: profile.username,
      gender: genderSchema.parse(gender),
      biography: cleanBiography,
      age
    })

    // کد معرف قبل از پاک کردن State خوانده می‌شود
    const referralCode = this.readStoredReferralCode(state)
    await this.userStateRepository.clear(profile.telegramUserId)

    return {
      started: false,
      step: RegistrationState.COMPLETED,
      player,
      ...(referralCode ? { referralCode } : {})
    }
  }

  async cancel(telegramUserId: bigint): Promise<void> {
    await this.userStateRepository.clear(telegramUserId)
  }
}