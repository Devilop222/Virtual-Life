/**
 * وصیت — نوشتن، دیدن، عوض‌کردن و لغوِ آن.
 *
 * ## قواعد ثابت این سرویس
 *  ۱. هر شخصیت در هر لحظه **حداکثر یک** وصیت دارد؛ ثبت، `upsert` روی
 *     `ownerId` یکتاست، پس دو کلیک هم‌زمان دو وصیت نمی‌سازد.
 *  ۲. وارث باید بازیکنی دیگر، زنده و فعال باشد (`validateHeir`). وصیتی که
 *     لحظهٔ مرگ رد شود، پول را بی‌صاحب می‌گذارد؛ پس اعتبارسنجی هم هنگام
 *     ثبت و هم هنگام اجرا انجام می‌شود.
 *  ۳. شخصیت مرده نمی‌تواند وصیت بنویسد یا عوض کند — «آخرین وصیتِ معتبر
 *     پیش از مرگ» مرجع انتقال است و مرگ، وصیت را قفل می‌کند.
 *  ۴. تغییر وارث به وارثِ جدید خبر می‌دهد، ولی تکرارِ همان وارث دوباره
 *     اعلان نمی‌فرستد (ضدتکرار با «قبلی = جدید»).
 *
 * ## رابطه با مرگ
 * پیش از خواندن پنل، یک بررسی Lazy انجام می‌شود: اگر سلامتی بازیکن صفر شده
 * باشد ولی هنوز جایی مرگ را ثبت نکرده باشد، همین‌جا ثبت می‌شود. این‌طور
 * هیچ بازیکنی برای ابد «زندهٔ صفرسلامت» نمی‌ماند.
 */
import { NotificationType, PlayerStatus, Prisma, PrismaClient } from '@prisma/client'
import { ConflictError, NotFoundError, ValidationError } from '../../utils/classes/errors'
import { plainInput } from '../../utils/validation'
import type { NotificationLevel } from '../notification/push'
import { EventService } from '../events/event.service'
import { GameEventType } from '@prisma/client'
import { DeathService } from './death.service'
import { EstateSnapshot, InheritanceService, InheritanceSummary } from './inheritance.service'
import {
  HEIR_REJECTION_LABELS,
  HeirRejection,
  WILL_NOTE_LIMITS,
  displayName,
  validateHeir
} from './will-core'

export interface WillView {
  /** شخصیت مرده است: تغییر وصیت ممکن نیست. */
  isDead: boolean
  hasWill: boolean
  heirName: string | null
  heirUsername: string | null
  heirInvalidReason: string | null
  note: string | null
  updatedAt: Date | null
  /** دارایی‌هایی که به وارث می‌رسد (همان عددی که لحظهٔ مرگ استفاده می‌شود). */
  estate: EstateSnapshot
  /** پروندهٔ میراثی که همین بازیکن وارث آن شده است (اگر باشد). */
  inherited: InheritanceSummary | null
  noteMaxLength: number
}

export interface SetWillResult {
  heirId: string
  heirName: string
  changed: boolean
}

interface NotificationPort {
  notifyPlayerById: (
    playerId: string,
    title: string,
    message: string,
    type?: NotificationType,
    dedupeKey?: string,
    level?: NotificationLevel
  ) => Promise<boolean>
}

export class WillService {
  constructor(
    private readonly db: PrismaClient,
    private readonly eventService: EventService,
    private readonly deathService: DeathService,
    private readonly inheritanceService: InheritanceService,
    private readonly notificationService?: NotificationPort
  ) {}

  private async requirePlayer(telegramUserId: bigint) {
    const player = await this.db.player.findUnique({
      where: { telegramUserId },
      select: { id: true, firstName: true, lastName: true, status: true, health: true }
    })
    if (!player) {
      throw new NotFoundError('Player not found', 'اول با /start ثبت‌نام کن.')
    }
    return player
  }

  /** نمای پنل وصیت — با بررسی Lazy مرگ پیش از هر چیز. */
  async getView(telegramUserId: bigint): Promise<WillView> {
    const player = await this.requirePlayer(telegramUserId)

    // اگر سلامت به صفر رسیده ولی هنوز جایی مرگ ثبت نشده، همین‌جا ثبت می‌شود.
    // مرگ ممکن است وضعیت را عوض کند، پس دوباره خوانده می‌شود.
    const settlement = await this.deathService.checkHealth(player.id).catch(() => null)
    const status = settlement?.newlyDead ? PlayerStatus.DEAD : player.status

    const [will, estate, inherited] = await Promise.all([
      this.db.will.findUnique({
        where: { ownerId: player.id },
        include: {
          heir: {
            select: { id: true, firstName: true, lastName: true, username: true, status: true }
          }
        }
      }),
      this.inheritanceService.estateSnapshot(player.id),
      this.inheritanceService.caseAsHeir(player.id)
    ])

    let heirInvalidReason: string | null = null
    if (will) {
      const rejection = validateHeir(player.id, will.heir)
      heirInvalidReason = rejection ? HEIR_REJECTION_LABELS[rejection] : null
    }

    return {
      isDead: status === PlayerStatus.DEAD,
      hasWill: Boolean(will),
      heirName: will && !heirInvalidReason ? displayName(will.heir) : null,
      heirUsername: will?.heir.username ?? null,
      heirInvalidReason,
      note: will?.note ?? null,
      updatedAt: will?.updatedAt ?? null,
      estate,
      inherited,
      noteMaxLength: WILL_NOTE_LIMITS.maxLength
    }
  }

  /**
   * ثبت/تغییر وارث.
   *
   * `heirPlayerId` از مسیر ورودی resolve شده است (ریپلای، `@username`، یا
   * شناسهٔ عددی) و این‌جا **دوباره** از دیتابیس خوانده و اعتبارسنجی می‌شود؛
   * هیچ شناسه‌ای از `callback_data` بدون بازخوانی پذیرفته نمی‌شود.
   */
  async setHeir(telegramUserId: bigint, heirPlayerId: string): Promise<SetWillResult> {
    const me = await this.requirePlayer(telegramUserId)
    if (me.status === PlayerStatus.DEAD) {
      throw new ConflictError(
        'Deceased',
        'این شخصیت از دنیا رفته است و وصیتش قفل شده. با /start یک شخصیت تازه بساز.'
      )
    }

    const candidate = await this.db.player.findUnique({
      where: { id: heirPlayerId },
      select: { id: true, firstName: true, lastName: true, status: true }
    })
    const rejection: HeirRejection | null = validateHeir(me.id, candidate)
    if (rejection) {
      throw new ValidationError('Invalid heir', HEIR_REJECTION_LABELS[rejection])
    }
    const heir = candidate!

    const previous = await this.db.will.findUnique({
      where: { ownerId: me.id },
      select: { heirId: true }
    })
    const changed = previous?.heirId !== heir.id

    const saved = await this.db.will.upsert({
      where: { ownerId: me.id },
      create: { ownerId: me.id, heirId: heir.id },
      update: { heirId: heir.id }
    })

    await this.eventService
      .recordPlayerEvent({
        playerId: me.id,
        type: GameEventType.WILL_UPDATED,
        title: changed ? 'وصیت به‌روز شد' : 'وصیت ثبت شد',
        detail: `${displayName(heir)} وارث دارایی‌های تو شد.`,
        dedupeKey: `will-set:${saved.id}:${saved.updatedAt.getTime()}`
      })
      .catch(() => undefined)

    if (changed) {
      await this.notificationService
        ?.notifyPlayerById(
          heir.id,
          '📜 وارث شدن',
          `${displayName(me)} تو را وارث دارایی‌هایش کرد. اگر روزی این شخصیت از دنیا برود، پول، ملک و کسب‌وکارش به تو می‌رسد — پس از هر تغییری در دارایی‌ها باخبر می‌شوی.`,
          undefined,
          `will-heir:${me.id}:${heir.id}`,
          'IMPORTANT'
        )
        .catch(() => undefined)
    }

    return { heirId: heir.id, heirName: displayName(heir), changed }
  }

  /** ثبت یادداشتِ وصیت (متن اختیاری برای وارث). */
  async setNote(telegramUserId: bigint, rawNote: string): Promise<{ note: string | null }> {
    const me = await this.requirePlayer(telegramUserId)
    if (me.status === PlayerStatus.DEAD) {
      throw new ConflictError('Deceased', 'این شخصیت از دنیا رفته است و وصیتش قفل شده.')
    }
    const existing = await this.db.will.findUnique({
      where: { ownerId: me.id },
      select: { id: true }
    })
    if (!existing) {
      throw new ConflictError(
        'No will',
        'اول وارثت را انتخاب کن؛ یادداشت بدون وارث معنا ندارد.'
      )
    }

    // یادداشت، متنی است که بازیکن آزادانه می‌نویسد و بی‌هیچ واسطه‌ای در پنل
    // وصیت (که با Markdown فرستاده می‌شود) نمایش داده می‌شود. یک `*` یا `_`
    // در آن، جفتِ قالب‌بندی را باز و بی‌بسته می‌گذارد و تلگرام کلِ پنل را رد
    // می‌کند؛ نتیجه اینکه بازیکن از آن لحظه پنلِ بی‌قالب‌بندی می‌بیند.
    // قراردادِ جاافتادهٔ پروژه پاک‌سازی همین‌جا (مرزِ ورودی) است، نه escape
    // در زمان نمایش — همان‌کاری که در نامِ حیوان و آگهی هم انجام می‌شود.
    const note = plainInput(rawNote ?? '').slice(0, WILL_NOTE_LIMITS.maxLength)
    const saved = await this.db.will.update({
      where: { ownerId: me.id },
      data: { note: note.length > 0 ? note : null }
    })
    return { note: saved.note }
  }

  /** لغو وصیت — وارث برداشته می‌شود و اعلان‌ها هم متوقف می‌شوند. */
  async cancel(telegramUserId: bigint): Promise<{ cancelled: boolean }> {
    const me = await this.requirePlayer(telegramUserId)
    if (me.status === PlayerStatus.DEAD) {
      throw new ConflictError('Deceased', 'این شخصیت از دنیا رفته است و وصیتش قفل شده.')
    }
    const removed = await this.db.will.deleteMany({ where: { ownerId: me.id } })
    if (removed.count === 0) {
      throw new ConflictError('No will', 'وصیتی برای لغو کردن نداری.')
    }
    await this.eventService
      .recordPlayerEvent({
        playerId: me.id,
        type: GameEventType.WILL_CANCELLED,
        title: 'وصیت لغو شد',
        detail: 'دیگر وارثی برای دارایی‌هایت تعیین نشده است.',
        dedupeKey: `will-cancel:${me.id}:${Date.now()}`
      })
      .catch(() => undefined)
    return { cancelled: true }
  }

  /**
   * تبدیل ورودیِ بازیکن (ریپلای/یوزرنیم/شناسه) به شناسهٔ بازیکن.
   * `replyTelegramId` را هندلر از `ctx.message.reply_to_message` می‌دهد.
   */
  async resolveTarget(
    telegramUserId: bigint,
    input:
      | { kind: 'telegram_id'; value: bigint }
      | { kind: 'username'; value: string }
      | { kind: 'reply'; value: string }
      | { kind: 'invalid' }
  ): Promise<{ id: string; name: string }> {
    if (input.kind === 'invalid') {
      throw new ValidationError(
        'Unusable input',
        'این ورودی را نفهمیدم. روی پیام بازیکن موردنظر ریپلای کن، یا @نام‌کاربری‌اش یا شناسهٔ عددی تلگرامش را بفرست.'
      )
    }
    const me = await this.requirePlayer(telegramUserId)

    const candidate =
      input.kind === 'telegram_id'
        ? await this.db.player.findUnique({
            where: { telegramUserId: input.value },
            select: { id: true, firstName: true, lastName: true, status: true }
          })
        : input.kind === 'username'
          ? await this.db.player.findFirst({
              where: { username: { equals: input.value, mode: 'insensitive' } },
              select: { id: true, firstName: true, lastName: true, status: true }
            })
          : await this.db.player.findUnique({
              where: { id: input.value },
              select: { id: true, firstName: true, lastName: true, status: true }
            })

    const rejection = validateHeir(me.id, candidate)
    if (rejection) {
      throw new ValidationError('Invalid heir', HEIR_REJECTION_LABELS[rejection])
    }
    return { id: candidate!.id, name: displayName(candidate!) }
  }
}

/** متن‌های ثابتِ پنل وصیت (یک منبع برای پنل و راهنما). */
export const WILL_PANEL_COPY = {
  intro:
    'وصیت یعنی: اگر سلامتت به صفر برسد و این زندگی تمام شود، پول، ملک، کسب‌وکار، سپرده و انبارت به چه کسی برسد.',
  rules: [
    'وارث باید یک بازیکن زندهٔ دیگر باشد؛ خودت یا حساب مرده/محروم نمی‌شود.',
    'بدهی‌ها اول از دارایی نقدی تسویه می‌شوند، بعد باقی به وارث می‌رسد.',
    'همه‌چیز خودکار و یک‌بار منتقل می‌شود؛ هیچ دارایی‌ای گم نمی‌شود.',
    'تا وقتی زنده‌ای می‌توانی وارث را عوض کنی یا وصیت را لغو کنی.',
    'لحظهٔ مرگ، آخرین وصیتِ ثبت‌شده قفل می‌شود.'
  ]
} as const

export type { EstateSnapshot, InheritanceSummary, Prisma }
