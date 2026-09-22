import { EventScope, GameEventType, PrismaClient } from '@prisma/client'
import { NotFoundError } from '../../utils/classes/errors'
import { gameDays } from '../../utils/game-time'

export interface NewsItem {
  id: string
  type: GameEventType
  title: string
  detail: string | null
  amount: number | null
  priority: number
  createdAt: Date
}

export interface NewsFeed {
  groupTitle: string
  items: NewsItem[]
  page: number
  pageSize: number
  total: number
}

const PAGE_SIZE = 6
/** خبرهای قدیمی‌تر از این بازه در فید نمایش داده نمی‌شوند. */
const FEED_WINDOW_DAYS = 7
/** حداقل فاصلهٔ زمانی بین دو انتشار خودکار در یک گروه. */
const BROADCAST_COOLDOWN_MS = 30 * 60 * 1000
/** فقط خبرهایی با این اولویت یا بالاتر به‌صورت خودکار منتشر می‌شوند. */
const BROADCAST_MIN_PRIORITY = 4

const lastBroadcastAt = new Map<string, number>()
/**
 * آخرین بررسیِ «بی‌خبر» هر چت؛ جدا از Cooldown انتشار.
 * وقتی خبری برای انتشار نیست، مسیر داغ نباید با هر پیام دوباره Query بزند،
 * ولی خبرِ تازه هم نباید تا پایان Cooldown (۳۰ دقیقه) معطل بماند؛ پس
 * بررسیِ مجددِ «خبری هست؟» هر یک دقیقه آزاد است.
 */
const lastEmptyCheckAt = new Map<string, number>()
const EMPTY_RECHECK_MS = 60 * 1000

/**
 * موتور خبر منطقه‌ای.
 * خبرها از رخدادهای واقعی همان گروه ساخته می‌شوند؛ هیچ متن تصادفی تولید نمی‌شود.
 * خبر هر گروه فقط به همان گروه مربوط است (بدون نشت اطلاعات بین گروه‌ها).
 */
export class NewsService {
  constructor(private readonly db: PrismaClient) {}

  /** فید خبری یک گروه با صفحه‌بندی. */
  async getFeed(telegramGroupId: bigint, page = 0): Promise<NewsFeed> {
    const group = await this.db.group.findUnique({
      where: { telegramGroupId },
      select: { id: true, title: true }
    })
    if (!group) {
      throw new NotFoundError(
        'Group not registered',
        'این گروه هنوز به‌عنوان محیط بازی ثبت نشده است. در همین گروه /start را بفرست.'
      )
    }

    // پنجرهٔ خوراک خبری روی تقویم بازی است: ۷ روز بازی = یک هفتـهٔ بازی.
    const since = new Date(Date.now() - gameDays(FEED_WINDOW_DAYS))
    const where = {
      groupId: group.id,
      scope: EventScope.REGION,
      createdAt: { gte: since }
    }

    const [total, rows] = await Promise.all([
      this.db.gameEvent.count({ where }),
      this.db.gameEvent.findMany({
        where,
        orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
        skip: Math.max(0, page) * PAGE_SIZE,
        take: PAGE_SIZE,
        select: {
          id: true,
          type: true,
          title: true,
          detail: true,
          amount: true,
          priority: true,
          createdAt: true
        }
      })
    ])

    return {
      groupTitle: group.title,
      items: rows.map((r) => ({
        id: r.id,
        type: r.type,
        title: r.title,
        detail: r.detail,
        amount: r.amount === null ? null : Number(r.amount),
        priority: r.priority,
        createdAt: r.createdAt
      })),
      page: Math.max(0, page),
      pageSize: PAGE_SIZE,
      total
    }
  }

  /**
   * برداشتن خبرهای مهم منتشرنشدهٔ یک چت گروهی، با کمترین هزینه.
   *
   * دو لایه نگهبانی، با یک فضای کلید واحد برای Cooldown انتشار:
   *  ۱. آینهٔ شناسهٔ چت (`chat:…`) روی Cooldownِ معتبرِ گروه: فراخوانی این
   *     متد در مسیر داغ پیام‌ها پس از هر انتشار، تا پایان Cooldown هیچ
   *     Query نمی‌زند.
   *  ۲. نگهبانِ «بی‌خبر» (یک دقیقه): وقتی خبری نیست، هر پیام Query تازه
   *     نمی‌زند ولی خبرِ تازه هم حداکثر یک دقیقه معطل می‌ماند.
   *
   * Cooldownِ معتبر همیشه روی شناسهٔ داخلی گروه نگه داشته می‌شود؛ پیش‌تر
   * این متد روی شناسهٔ چت و `claimBroadcastableNews` روی شناسهٔ داخلی گروه
   * Cooldown می‌گذاشت و یک گروه می‌توانست از دو مسیر، دو انتشارِ پشتِ
   * سرهم بگیرد.
   */
  async claimForChat(telegramGroupId: bigint): Promise<NewsItem[]> {
    const chatKey = `chat:${telegramGroupId}`
    const last = lastBroadcastAt.get(chatKey) ?? 0
    if (Date.now() - last < BROADCAST_COOLDOWN_MS) {
      return []
    }
    if (Date.now() - (lastEmptyCheckAt.get(chatKey) ?? 0) < EMPTY_RECHECK_MS) {
      return []
    }

    const group = await this.db.group.findUnique({
      where: { telegramGroupId },
      select: { id: true }
    })
    if (!group) {
      lastEmptyCheckAt.set(chatKey, Date.now())
      NewsService.pruneCooldownCache()
      return []
    }

    const items = await this.claimBroadcastableNews(group.id)
    // آینه‌کردن Cooldown معتبر روی کلید چت تا مسیر داغ Query نزند؛ اگر
    // خبری نبود، فقط نگهبانِ کوتاهِ «بی‌خبر» فعال می‌شود.
    const authoritative = lastBroadcastAt.get(group.id)
    if (authoritative !== undefined) {
      lastBroadcastAt.set(chatKey, authoritative)
    } else {
      lastEmptyCheckAt.set(chatKey, Date.now())
    }
    NewsService.pruneCooldownCache()
    return items
  }

  /**
   * برداشتن خبرهای مهم منتشرنشدهٔ یک گروه برای ارسال خودکار.
   * با Cooldown و علامت‌گذاری publishedAt، هرگز Spam یا ارسال دوباره رخ نمی‌دهد.
   */
  async claimBroadcastableNews(groupId: string): Promise<NewsItem[]> {
    const last = lastBroadcastAt.get(groupId) ?? 0
    if (Date.now() - last < BROADCAST_COOLDOWN_MS) {
      return []
    }

    const candidates = await this.db.gameEvent.findMany({
      where: {
        groupId,
        scope: EventScope.REGION,
        publishedAt: null,
        priority: { gte: BROADCAST_MIN_PRIORITY }
      },
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
      take: 3,
      select: {
        id: true,
        type: true,
        title: true,
        detail: true,
        amount: true,
        priority: true,
        createdAt: true
      }
    })

    if (candidates.length === 0) {
      return []
    }

    // علامت‌گذاری اتمیک: فقط رخدادهایی که هنوز منتشر نشده‌اند claim می‌شوند
    const claimed = await this.db.gameEvent.updateMany({
      where: { id: { in: candidates.map((c) => c.id) }, publishedAt: null },
      data: { publishedAt: new Date() }
    })
    if (claimed.count === 0) {
      return []
    }

    lastBroadcastAt.set(groupId, Date.now())

    return candidates.map((r) => ({
      id: r.id,
      type: r.type,
      title: r.title,
      detail: r.detail,
      amount: r.amount === null ? null : Number(r.amount),
      priority: r.priority,
      createdAt: r.createdAt
    }))
  }

  /**
   * آزادسازیِ خبرهای claim‌شده‌ای که **تحویل نشدند**.
   *
   * ── چرا لازم است؟ ────────────────────────────────────────────────────────
   * مسیر انتشار ابتدا خبر را claim می‌کند (`publishedAt` پر می‌شود) و بعد به
   * گروه می‌فرستد. اگر ارسال شکست بخورد (ربات در گروه محدود شده، قطعی شبکه،
   * Restart بین دو مرحله)، آن خبر برای همیشه «منتشرشده» می‌ماند و **گم می‌شود**
   * بدون آنکه کسی بفهمد. برگرداندن نشانهٔ انتشار، مسیر را قابل‌تلاش‌مجدد می‌کند.
   *
   * Cooldown عمداً دست نمی‌خورد: خبر در پنجرهٔ بعدی دوباره برداشته می‌شود و
   * حلقهٔ داغی از تلاش-شکست روی هر پیام گروه ساخته نمی‌شود.
   */
  async releaseClaim(ids: readonly string[]): Promise<number> {
    const safe = ids.filter((id) => typeof id === 'string' && id.length > 0)
    if (safe.length === 0) {
      return 0
    }
    const released = await this.db.gameEvent.updateMany({
      where: { id: { in: [...safe] }, publishedAt: { not: null } },
      data: { publishedAt: null }
    })
    return released.count
  }

  /** پاکسازی حافظهٔ Cooldown (برای جلوگیری از رشد بی‌نهایت در صدها گروه). */
  static pruneCooldownCache(maxEntries = 1000): void {
    if (lastBroadcastAt.size + lastEmptyCheckAt.size <= maxEntries) return
    const cutoff = Date.now() - BROADCAST_COOLDOWN_MS * 4
    for (const [key, ts] of lastBroadcastAt.entries()) {
      if (ts < cutoff) lastBroadcastAt.delete(key)
    }
    const emptyCutoff = Date.now() - EMPTY_RECHECK_MS * 4
    for (const [key, ts] of lastEmptyCheckAt.entries()) {
      if (ts < emptyCutoff) lastEmptyCheckAt.delete(key)
    }
  }
}
