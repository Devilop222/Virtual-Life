import { randomUUID } from 'node:crypto'
import { Prisma, PrismaClient, UserState } from '@prisma/client'

/** عمر تأییدهای حساس؛ با `ttlForContext` هم‌خوان است. */
const CONFIRMATION_TTL_MS = 5 * 60 * 1000

/** عمرِ جریان‌های ورودیِ متنی (نام حیوان، مبلغ، قیمت، مهریه و…). */
export const PENDING_INPUT_TTL_MS = 15 * 60 * 1000

/**
 * ثبت‌نام استثناست: یک جریانِ چندمرحله‌ایِ قابلِ ازسرگیری است و بازیکن
 * ممکن است وسطش برود و برگردد. با TTL معمولی، وضعیتِ ثبت‌نام بی‌صدا
 * پاک می‌شد و بازیکن از وسطِ جریان بیرون می‌افتاد.
 */
const REGISTRATION_TTL_MS = 24 * 60 * 60 * 1000

/** دامنه‌های تأیید: `adm` برای پنل مدیریت، `act` برای عملیات بازیکن. */
export type ConfirmationScope = 'adm' | 'act'

const CONFIRMATION_CONTEXT_PREFIXES: readonly string[] = ['adm:confirm:', 'act:confirm:']

export class UserStateRepository {
  constructor(private readonly db: PrismaClient) {}

  async findByTelegramUserId(telegramUserId: bigint): Promise<UserState | null> {
    const state = await this.db.userState.findUnique({
      where: { telegramUserId }
    })
    if (!state || !state.currentContext || !state.pendingSince) return state
    const ttlMs = this.ttlForContext(state.currentContext)
    if (Date.now() - state.pendingSince.getTime() > ttlMs) {
      await this.db.userState.deleteMany({
        where: {
          id: state.id,
          telegramUserId,
          currentContext: state.currentContext,
          pendingSince: state.pendingSince
        }
      })
      return null
    }
    return state
  }

  async upsert(
    telegramUserId: bigint,
    data: {
      currentContext?: string | null
      stateData?: Prisma.InputJsonValue
    }
  ): Promise<UserState> {
    return this.db.userState.upsert({
      where: { telegramUserId },
      create: {
        telegramUserId,
        currentContext: data.currentContext,
        stateData: data.stateData ?? {},
        pendingSince: data.currentContext ? new Date() : null
      },
      update: {
        currentContext: data.currentContext,
        stateData: data.stateData ?? {},
        pendingSince: data.currentContext ? new Date() : null
      }
    })
  }

  /**
   * بازگرداندن وضعیت معتبر یا پاک‌سازی خودکارِ وضعیت منقضی.
   *
   * هر جریان متنی سقف زمانی دارد (اغلب ۱۵ دقیقه)؛ اگر بازیکن وسط جریان
   * رها کند و ساعتی بعد چیزی بفرستد، پیام دیگر باید به‌عنوان دستور عادی
   * تفسیر شود نه ادامهٔ جریانِ مُرده. این تابع همان لحظهٔ خواندن، انقضاء
   * را اعمال می‌کند تا handlerها هرگز با contextِ کهنه کار نکنند.
   */
  async findValidByTelegramUserId(
    telegramUserId: bigint,
    now: Date = new Date()
  ): Promise<UserState | null> {
    // سازگار با تست‌ها: now تزریقی برای شبیه‌سازی انقضاء در حافظه
    const state = await this.db.userState.findUnique({
      where: { telegramUserId }
    })
    if (!state || !state.currentContext || !state.pendingSince) return state
    const ttlMs = this.ttlForContext(state.currentContext)
    if (now.getTime() - state.pendingSince.getTime() > ttlMs) {
      await this.db.userState.deleteMany({
        where: {
          id: state.id,
          telegramUserId,
          currentContext: state.currentContext,
          pendingSince: state.pendingSince
        }
      })
      return null
    }
    return state
  }

  private ttlForContext(context: string): number {
    // تنها مرجعِ TTL. پیش‌تر یک کپیِ ۱۵ دقیقه‌ای هم در text.handler بود که
    // ثبت‌نام را مستثنا می‌کرد، ولی این تابع همان وضعیت را در ۱۵ دقیقه پاک
    // می‌کرد و استثنا عملاً بی‌اثر بود.
    if (context === 'registration') {
      return REGISTRATION_TTL_MS
    }
    // تأییدهای حساس (ادمین و عملیات مالی بازیکن) عمر کوتاهی دارند: پنلِ
    // تأییدی که یک ساعت روی صفحه مانده نباید ناگهان یک تراکنش اجرا کند.
    return CONFIRMATION_CONTEXT_PREFIXES.some((prefix) => context.startsWith(prefix))
      ? CONFIRMATION_TTL_MS
      : PENDING_INPUT_TTL_MS
  }

  /**
   * مثلِ `findByTelegramUserId`، با این تفاوت که انقضاء را **گزارش** می‌کند
   * نه اینکه بی‌صدا دور بیندازد.
   *
   * چرا لازم است: بازیکن وسطِ جریان ورودی رها می‌کند، ساعتی بعد همان ورودی
   * را می‌فرستد، وضعیت منقضی شده و متن به روترِ کلیدواژه می‌افتد؛ اگر آن
   * ورودی هیچ کلیدواژه‌ای نباشد ربات ساکت می‌ماند و بازیکن هرگز نمی‌فهمد
   * جریانِ قبلی تمام شده. با دانستنِ «منقضی شده» می‌شود به او گفت.
   */
  async findByTelegramUserIdWithExpiry(
    telegramUserId: bigint,
    now: Date = new Date()
  ): Promise<{ state: UserState | null; expiredContext: string | null }> {
    const state = await this.db.userState.findUnique({ where: { telegramUserId } })
    if (!state || !state.currentContext || !state.pendingSince) {
      return { state, expiredContext: null }
    }
    const ttlMs = this.ttlForContext(state.currentContext)
    if (now.getTime() - state.pendingSince.getTime() > ttlMs) {
      await this.db.userState.deleteMany({
        where: {
          id: state.id,
          telegramUserId,
          currentContext: state.currentContext,
          pendingSince: state.pendingSince
        }
      })
      return { state: null, expiredContext: state.currentContext }
    }
    return { state, expiredContext: null }
  }

  /** A durable, actor/chat-bound, single-use confirmation; no process-local state. */
  async issueConfirmation(
    telegramUserId: bigint,
    chatId: number,
    payload: Prisma.InputJsonObject
  ): Promise<string> {
    return this.issueScopedConfirmation(telegramUserId, chatId, 'adm', payload)
  }

  async consumeConfirmation(
    telegramUserId: bigint,
    chatId: number,
    token: string
  ): Promise<Prisma.JsonObject | null> {
    return this.consumeScopedConfirmation(telegramUserId, chatId, 'adm', token)
  }

  /**
   * تأییدِ تک‌مصرفِ بازیکن برای یک عملیات حساس (مثل انتقال پول).
   *
   * همان ضمانت‌های نسخهٔ ادمین، با دامنهٔ (`scope`) جدا تا یک توکنِ بازیکن
   * هرگز در مسیر ادمین مصرف نشود و برعکس. `chatId` هم بسته می‌شود: پنلِ
   * تأییدی که در گروه باز شده نباید از چت خصوصی اجرا شود.
   */
  async issueScopedConfirmation(
    telegramUserId: bigint,
    chatId: number,
    scope: ConfirmationScope,
    payload: Prisma.InputJsonObject
  ): Promise<string> {
    const token = randomUUID()
    await this.upsert(telegramUserId, {
      currentContext: `${scope}:confirm:${token}`,
      stateData: { chatId, payload }
    })
    return token
  }

  /**
   * مصرفِ اتمیکِ تأیید. `deleteMany` شرطی یعنی دو کلیکِ همزمان هر دو state
   * را می‌خوانند ولی فقط یکی ردیف را می‌بَرد؛ دومی `null` می‌گیرد و عملیات
   * دوباره اجرا نمی‌شود.
   */
  async consumeScopedConfirmation(
    telegramUserId: bigint,
    chatId: number,
    scope: ConfirmationScope,
    token: string
  ): Promise<Prisma.JsonObject | null> {
    const context = `${scope}:confirm:${token}`
    const state = await this.db.userState.findUnique({ where: { telegramUserId } })
    if (
      !state ||
      state.currentContext !== context ||
      !state.pendingSince ||
      Date.now() - state.pendingSince.getTime() > CONFIRMATION_TTL_MS
    )
      return null
    const data = state.stateData as Prisma.JsonObject
    if (
      data.chatId !== chatId ||
      !data.payload ||
      typeof data.payload !== 'object' ||
      Array.isArray(data.payload)
    )
      return null
    // Compare-and-delete: concurrent clicks cannot both win. A failed operation must
    // be previewed again; we never automatically repeat a financial mutation.
    const claimed = await this.db.userState.deleteMany({
      where: {
        id: state.id,
        telegramUserId,
        currentContext: context,
        pendingSince: state.pendingSince
      }
    })
    return claimed.count === 1 ? (data.payload as Prisma.JsonObject) : null
  }

  /**
   * ادعای اتمیکِ تک‌نوبتیِ یک جریان متنی.
   *
   * دقیقاً مثل `consumeConfirmation` اما برای جریان‌هایی که `stateData` باید
   * *پیش* از ادعا خوانده شده باشد (مثلاً دکمهٔ «ذخیرهٔ آگهی» که پیش از ثبت،
   * پیش‌نویس را از state می‌خواند). دو کلیکِ همزمان هر دو state را می‌خوانند،
   * ولی فقط یکی `deleteMany` را یک ردیف می‌بیند؛ دومی `false` برمی‌گرداند و
   * نباید عملیات تکراری (ثبت دوبارهٔ آگهی و ...) انجام دهد.
   *
   * @returns `true` فقط برای درخواستی که state را برد.
   */
  async claimContext(telegramUserId: bigint, context: string): Promise<boolean> {
    const state = await this.db.userState.findUnique({ where: { telegramUserId } })
    if (!state || state.currentContext !== context || !state.pendingSince) {
      return false
    }
    const claimed = await this.db.userState.deleteMany({
      where: {
        id: state.id,
        telegramUserId,
        currentContext: context,
        pendingSince: state.pendingSince
      }
    })
    return claimed.count === 1
  }

  async clear(telegramUserId: bigint): Promise<void> {
    await this.db.userState
      .deleteMany({
        where: { telegramUserId }
      })
      .catch((error: unknown) => {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
          return
        }
        throw error
      })
  }
}
