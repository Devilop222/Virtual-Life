import { Api, GrammyError } from 'grammy'
import { MemberInfo, MemberInfoProvider } from '../modules/groups/group.service'
import { computeRealMemberCount, countNonBots } from '../modules/groups/member.calculator'
import { logger } from '../utils/logger'

/**
 * خواندن اطلاعات اعضای گروه از تلگرام.
 *
 * نکتهٔ کلیدی: `getChatAdministrators` فقط وقتی کار می‌کند که ربات *ادمین*
 * گروه باشد. پیش‌تر این دو فراخوانی با `Promise.all` کنار هم بودند و خطای
 * یکی، کل ثبت گروه را می‌شکست؛ نتیجه گروه‌هایی بود که هرگز ثبت نمی‌شدند و
 * «سطح محیط: نامشخص» نشان می‌دادند. حالا هر فراخوانی جدا شکست می‌خورد و
 * ثبت گروه با هرچه به دست آمده ادامه پیدا می‌کند.
 */
export class TelegramMemberInfoProvider implements MemberInfoProvider {
  constructor(private readonly api: Api) {}

  async getMemberInfo(telegramGroupId: bigint): Promise<MemberInfo> {
    const chatId = telegramGroupId.toString()

    const [totalCount, admins] = await Promise.all([
      this.api.getChatMemberCount(chatId).catch((error: unknown) => {
        logger.debug(
          { err: error, groupId: chatId },
          'getChatMemberCount unavailable; group will be registered without a fresh count'
        )
        return null
      }),
      this.api.getChatAdministrators(chatId).catch((error: unknown) => {
        // رایج‌ترین حالت: ربات ادمین گروه نیست. خطا نیست، فقط دادهٔ کمتر.
        if (!(error instanceof GrammyError)) {
          logger.debug({ err: error, groupId: chatId }, 'getChatAdministrators failed')
        }
        return null
      })
    ])

    const adminList = admins ?? []
    const humanAdmins = countNonBots(adminList.map((admin) => admin.user))
    const botAdmins = adminList.length - humanAdmins

    const ownerMember = adminList.find((a) => a.status === 'creator')
    const adminTelegramUserIds = adminList
      .filter((a) => a.status === 'administrator' && !a.user.is_bot)
      .map((a) => BigInt(a.user.id))

    return {
      totalCount: totalCount ?? null,
      realMemberCount: totalCount === null ? null : computeRealMemberCount(totalCount, botAdmins),
      ownerTelegramUserId: ownerMember ? BigInt(ownerMember.user.id) : undefined,
      adminTelegramUserIds
    }
  }
}

export function createTelegramMemberInfoProvider(api: Api): MemberInfoProvider {
  return new TelegramMemberInfoProvider(api)
}
