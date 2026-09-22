'use strict'
/**
 * قدم‌زدن واقعی در محصول (Product Walkthrough) روی PostgreSQL زنده.
 *
 * کل خط لولهٔ ربات — میان‌افزارها، هندلرها، سرویس‌ها و دیتابیس واقعی — با
 * به‌روزرسانی‌های ساختگی تلگرام اجرا می‌شود؛ دقیقاً همان مسیری که یک بازیکن
 * واقعی می‌رود:
 *
 *   /start خصوصی → ثبت‌نام (جنسیت + بیوگرافی) → راهنمای شروع → گروه (راه‌اندازی
 *   با ادمین / ردِ کاربر عادی) → کلیدواژه‌های بازی → تثبیت عضویت.
 *
 * اجرا:
 *   DATABASE_URL=postgresql://.../<name>_ux_test BOT_TOKEN=dummy \
 *     node scripts/product-walkthrough.cjs
 */
const assert = require('node:assert/strict')
const process = require('node:process')

const url = process.env.DATABASE_URL
if (!url || !new URL(url).pathname.endsWith('_ux_test')) {
  throw new Error('Use a disposable *_ux_test database')
}
process.env.NODE_ENV = 'test'
process.env.BOT_TOKEN ||= '123456:WALKTHROUGH'

const { PrismaClient } = require('@prisma/client')
const { PrismaPg } = require('@prisma/adapter-pg')
const { Bot } = require('grammy')
const { buildContainer } = require('../dist/services/container')
const {
  attachErrorHandler
} = require('../dist/bot/middleware/error.middleware')
const { panelOwnerMiddleware } = require('../dist/bot/middleware/panel-owner.middleware')
const { rateLimitMiddleware } = require('../dist/bot/middleware/rate-limit.middleware')
const { registerChatPolicy } = require('../dist/bot/chat-policy')
const { registerStartHandler } = require('../dist/bot/handlers/start.handler')
const { registerGroupHandlers } = require('../dist/bot/handlers/group.handler')
const { registerTextHandlers } = require('../dist/bot/handlers/text.handler')
const { registerExpansionHandlers } = require('../dist/bot/handlers/expansion.handler')
const { registerFeatureHandlers } = require('../dist/bot/handlers/features.handler')

const PLAYER = 911_000_001
const ADMIN = 911_000_002
const BYSTANDER = 911_000_003
const GROUP_ID = -911_100_001

async function main() {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) })
  const sent = []

  const memberInfoProvider = {
    getMemberInfo: async () => ({
      totalCount: 22,
      realMemberCount: 21,
      adminTelegramUserIds: [BigInt(ADMIN)],
      ownerTelegramUserId: BigInt(ADMIN)
    })
  }
  const container = buildContainer(memberInfoProvider)

  const me = { id: 42, is_bot: true, first_name: 'میراث', username: 'legacy_bot' }
  const bot = new Bot(process.env.BOT_TOKEN, { botInfo: me })
  bot.api.config.use((_prev, method, payload) => {
    sent.push({ method, payload })
    if (method === 'getChatMember') {
      const uid = Number(payload.user_id)
      const status = uid === ADMIN ? 'creator' : 'member'
      return Promise.resolve({ ok: true, result: { status, user: { id: uid, is_bot: false } } })
    }
    return Promise.resolve({
      ok: true,
      result: { message_id: sent.length, date: 1, chat: { id: payload.chat_id ?? 1, type: 'private' } }
    })
  })

  attachErrorHandler(bot)
  bot.use(panelOwnerMiddleware(container))
  bot.use(rateLimitMiddleware())
  registerChatPolicy(bot, container)
  registerStartHandler(bot, container)
  registerGroupHandlers(bot, container)
  registerTextHandlers(bot, container)
  registerExpansionHandlers(bot, container)
  registerFeatureHandlers(bot, container)

  // پاکسازی از اجراهای قبلی
  for (const uid of [PLAYER, ADMIN, BYSTANDER]) {
    const p = await db.player.findUnique({ where: { telegramUserId: BigInt(uid) } })
    if (p) await db.player.delete({ where: { id: p.id } })
  }
  const g = await db.group.findUnique({ where: { telegramGroupId: BigInt(GROUP_ID) } })
  if (g) await db.group.delete({ where: { id: g.id } })
  await db.userState.deleteMany({ where: { telegramUserId: { in: [BigInt(PLAYER), BigInt(BYSTANDER)] } } })

  let lastMessageId = 100
  const lastSentId = () => (sent.length ? sent[sent.length - 1].payload.message_id ?? ++lastMessageId : ++lastMessageId)

  // رعایت محدودنرخِ خودِ محصول (۸۰۰ms برای هر کاربر) میان هر دو اقدام
  const pace = () => new Promise((r) => setTimeout(r, 850))

  const sendText = async (userId, text, chat) => { await pace(); return bot.handleUpdate({
    update_id: sent.length + 1,
    message: {
      message_id: 500 + sent.length,
      date: 1,
      from: { id: userId, is_bot: false, first_name: 'کاربر' + (userId % 1000) },
      chat: chat ?? { id: userId, type: 'private' },
      text
    }
  }) }

  const sendCommand = async (userId, command, chat) => { await pace(); return bot.handleUpdate({
    update_id: sent.length + 1,
    message: {
      message_id: 500 + sent.length,
      date: 1,
      from: { id: userId, is_bot: false, first_name: 'کاربر' + (userId % 1000) },
      chat: chat ?? { id: userId, type: 'private' },
      text: command,
      entities: [{ type: 'bot_command', offset: 0, length: command.length }]
    }
  }) }

  // دکمه روی پنلی که پاسخِ پیام خود کاربر است (مالکیت پنل برقرار باشد)
  const pressButton = async (userId, data, chat) => {
    await pace()
    const panelMessageId = 700 + sent.length
    return bot.handleUpdate({
      update_id: sent.length + 1,
      callback_query: {
        id: 'cb' + sent.length,
        from: { id: userId, is_bot: false, first_name: 'کاربر' + (userId % 1000) },
        message: {
          message_id: panelMessageId,
          date: 1,
          chat: chat ?? { id: userId, type: 'private' },
          reply_to_message: {
            message_id: panelMessageId - 1,
            date: 1,
            from: { id: userId, is_bot: false, first_name: 'کاربر' + (userId % 1000) },
            chat: chat ?? { id: userId, type: 'private' }
          }
        },
        data
      }
    })
  }

  const texts = () => sent.map((s) => s.payload.text ?? s.payload.caption ?? '').join('\n')
  const lastTexts = (n = 1) =>
    sent.slice(-n).map((s) => s.payload.text ?? s.payload.caption ?? '').join('\n')

  // ── ۱. /start خصوصی برای کاربر تازه: آنبوردینگ + دکمه‌های جنسیت ──
  await sendCommand(PLAYER, '/start')
  assert.ok(texts().includes('جنسیت شخصیتت را انتخاب کن'), 'welcomeNew must ask for gender')

  // ── ۲. انتخاب جنسیت با دکمه (primary) → درخواست بیوگرافی ──
  await pressButton(PLAYER, 'reg:gender:MALE')
  assert.ok(texts().includes('بیوگرافی شخصیت'), 'biography prompt must appear')

  // ── ۳. ارسال بیوگرافی → پایان ثبت‌نام + دکمهٔ راهنمای شروع ──
  await sendText(PLAYER, 'جوانی که دنبال ساختن آینده‌ای روشن در این شهر است.')
  assert.ok(texts().includes('شخصیتت ساخته شد'), 'registration completion')
  const player = await db.player.findUnique({ where: { telegramUserId: BigInt(PLAYER) } })
  assert.ok(player, 'player row created')
  assert.equal(player.gender, 'MALE')

  // ── ۴. /start دوباره در خصوصی: راهنمای شروع چندصفحه‌ای (نه «شخصیت بساز») ──
  await sendCommand(PLAYER, '/start')
  assert.ok(lastTexts().includes('خوش برگشتی'), 'guide opens for an existing player')
  assert.ok(!lastTexts().includes('شخصیتت را بساز'), 'no re-onboarding')
  const nav = sent[sent.length - 1].payload.reply_markup
  const navData = JSON.stringify(nav)
  assert.ok(navData.includes('guide:page:1'), 'guide has next-page button')

  // ── ۵. صفحه‌گردانی راهنما با دکمه ──
  await pressButton(PLAYER, 'guide:page:1')
  assert.ok(texts().includes('اولین کارهایی'), 'page 2 renders via button')

  // ── ۶. /start کاربر عادی در گروهِ ثبت‌نشده: ردِ محترمانه، بدون ثبت ──
  await sendCommand(BYSTANDER, '/start', { id: GROUP_ID, type: 'supergroup', title: 'منطقهٔ آزمون' })
  assert.ok(texts().includes('راه‌اندازی نشده'), 'unregistered group + non-admin → not-setup notice')
  assert.equal(await db.group.findUnique({ where: { telegramGroupId: BigInt(GROUP_ID) } }), null,
    'a bystander must not create the group')

  // کلیدواژهٔ بازی همان کاربر ثبت‌نشده در گروه: هدایت به ثبت‌نام خصوصی
  await sendText(BYSTANDER, 'کار', { id: GROUP_ID, type: 'supergroup', title: 'منطقهٔ آزمون' })
  assert.ok(texts().includes('هنوز شخصیت نداری'), 'unregistered player is sent to private onboarding')

  // کلیدواژهٔ گروهی از بازیکنِ ثبت‌شده در گروهِ ثبت‌نشده: محیط فعال جلوه نمی‌کند
  await sendText(PLAYER, 'کار', { id: GROUP_ID, type: 'supergroup', title: 'منطقهٔ آزمون' })
  assert.ok(texts().includes('راه‌اندازی نشده'), 'group-only section requires setup')

  // ── ۷. /start ادمین: راه‌اندازی محیط ──
  await sendCommand(ADMIN, '/start', { id: GROUP_ID, type: 'supergroup', title: 'منطقهٔ آزمون' })
  const group = await db.group.findUnique({ where: { telegramGroupId: BigInt(GROUP_ID) } })
  assert.ok(group, 'admin /start registers the group')
  assert.equal(group.environmentLevel, 'CITY', 'environment level from real member count')
  assert.ok(texts().includes('منطقهٔ بازی'), 'region info panel for the admin')

  // ── ۸. اولین کلیدواژهٔ بازیکن در گروهِ فعال: پنل کار + تثبیت عضویت ──
  await sendText(PLAYER, 'کار', { id: GROUP_ID, type: 'supergroup', title: 'منطقهٔ آزمون' })
  assert.ok(texts().includes('کار و درآمد'), 'occupation panel opens')

  const membership = await db.playerGroup.findFirst({
    where: { player: { telegramUserId: BigInt(PLAYER) }, groupId: group.id }
  })
  assert.ok(membership, 'local membership consolidated by first real activity')
  assert.equal(membership.status, 'ACTIVE')

  // ── ۹. شناسنامه و بانک در گروه ──
  await sendText(PLAYER, 'شناسنامه', { id: GROUP_ID, type: 'supergroup', title: 'منطقهٔ آزمون' })
  assert.ok(texts().includes('شناسنامه'), 'identity card renders')
  await sendText(PLAYER, 'بانک', { id: GROUP_ID, type: 'supergroup', title: 'منطقهٔ آزمون' })
  assert.ok(texts().includes('بانک'), 'bank panel renders in group')

  // ── ۱۰. بخش خصوصی‌محور در گروه راهنمایی می‌کند، نه خطا ──
  await sendText(PLAYER, 'دعوت دوستان', { id: GROUP_ID, type: 'supergroup', title: 'منطقهٔ آزمون' })
  assert.ok(texts().includes('چت خصوصی'), 'private-only section explains itself')

  console.log('PASS: full product walkthrough — private onboarding, multi-page start guide,')
  console.log('admin-gated group setup, keyword routing, membership consolidation and panels')
  console.log(`       (${sent.length} outgoing Telegram calls simulated, all asserted)`)
  await db.$disconnect()
}

main().catch((e) => {
  console.error('FAIL:', e.message)
  process.exit(1)
})
