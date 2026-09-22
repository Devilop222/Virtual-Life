'use strict'
/**
 * هارنس «سفر کاربر» — ربات کامل را با به‌روزرسانی‌های جعلی تلگرام اجرا می‌کند.
 *
 * تفاوت این هارنس با شبیه‌سازی‌های ساده: **هویتِ پیام‌ها واقعی است**.
 * هر پیامی که ربات می‌فرستد شناسه، چت و `reply_to_message` واقعی می‌گیرد و
 * `editMessageText` همان شناسه را نگه می‌دارد. دکمه‌ای که با `press` زده می‌شود
 * روی «آخرین پیام واقعی ربات در همان چت» می‌نشیند؛ بنابراین
 * `panelOwnerMiddleware` دقیقاً همان‌طور قضاوت می‌کند که در تلگرام قضاوت
 * می‌کند — اگر پنلی بدون ریپلای به پیامِ بازیکن رفته باشد، اینجا هم
 * «این پنل متعلق به تو نیست» می‌دهد (و این همان چیزی است که می‌خواهیم ببینیم).
 *
 * مصرف:
 *   const j = await createJourney({ db })
 *   await j.text(U1, 'حیوان', j.GROUP)
 *   await j.press(U1, 'pet:choose_kind', j.GROUP)
 */
const { Bot } = require('grammy')
const { buildContainer } = require('../dist/services/container')
const { attachErrorHandler } = require('../dist/bot/middleware/error.middleware')
const { panelOwnerMiddleware } = require('../dist/bot/middleware/panel-owner.middleware')

const { rateLimitMiddleware } = require('../dist/bot/middleware/rate-limit.middleware')
const { registerChatPolicy } = require('../dist/bot/chat-policy')
const { registerStartHandler } = require('../dist/bot/handlers/start.handler')
const { registerGroupHandlers } = require('../dist/bot/handlers/group.handler')
const { registerTextHandlers } = require('../dist/bot/handlers/text.handler')
const { registerExpansionHandlers } = require('../dist/bot/handlers/expansion.handler')
const { registerFeatureHandlers } = require('../dist/bot/handlers/features.handler')
const { registerAdminHandlers } = require('../dist/bot/handlers/admin.handler')
const {
  registerConfirmationHandlers
} = require('../dist/bot/confirm-action')
const { registerConfirmableActions } = require('../dist/bot/confirmations')

const RATE_LIMIT_PAUSE_MS = 820

/** ساخت یک کاربر تلگرامی جعلی. */
function tgUser(id, extra = {}) {
  return { id, is_bot: false, first_name: `کاربر${id % 1000}`, ...extra }
}

async function createJourney({ db, adminUserIds = [], memberCount = 24, extra }) {
  const sent = []
  /** هر پیامِ خروجی: { id, chat, text, replyTo, keyboard, method } */
  const messages = []
  let nextMessageId = 1000
  let updateId = 1

  const me = { id: 42, is_bot: true, first_name: 'میراث', username: 'legacy_bot' }
  const bot = new Bot(process.env.BOT_TOKEN, { botInfo: me })

  bot.api.config.use((_prev, method, payload) => {
    sent.push({ method, payload })

    if (method === 'getChatMember') {
      const uid = Number(payload.user_id)
      const status = adminUserIds.includes(uid) ? 'creator' : 'member'
      return Promise.resolve({ ok: true, result: { status, user: tgUser(uid) } })
    }

    if (method === 'sendMessage') {
      const chatId = payload.chat_id
      const id = nextMessageId++
      const replyToId = payload.reply_parameters?.message_id ?? null
      const owner = replyToId ? messages.find((m) => m.id === replyToId)?.owner ?? null : null
      const record = {
        id,
        chatId,
        text: payload.text ?? '',
        keyboard: payload.reply_markup ?? null,
        method,
        owner,
        replyTo: replyToId
      }
      messages.push(record)
      return Promise.resolve({
        ok: true,
        result: { message_id: id, date: 1, chat: { id: chatId, type: chatId < 0 ? 'supergroup' : 'private' } }
      })
    }

    if (method === 'editMessageText' || method === 'editMessageReplyMarkup') {
      const record = messages.find((m) => m.id === payload.message_id)
      if (record) {
        if (payload.text !== undefined) record.text = payload.text
        if (payload.reply_markup !== undefined) record.keyboard = payload.reply_markup
        record.method = method
      }
      return Promise.resolve({
        ok: true,
        result: {
          message_id: payload.message_id,
          date: 1,
          chat: { id: payload.chat_id, type: payload.chat_id < 0 ? 'supergroup' : 'private' }
        }
      })
    }

    if (method === 'deleteMessage') {
      const record = messages.find((m) => m.id === payload.message_id)
      if (record) record.deleted = true
      return Promise.resolve({ ok: true, result: true })
    }

    return Promise.resolve({ ok: true, result: true })
  })

  const container = buildContainer({
    getMemberInfo: async () => ({
      totalCount: memberCount,
      realMemberCount: memberCount - 1,
      adminTelegramUserIds: adminUserIds.map(BigInt),
      ownerTelegramUserId: adminUserIds[0] ? BigInt(adminUserIds[0]) : null
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
  registerAdminHandlers(bot, container)
  // لایهٔ تأیید دومرحله‌ای، دقیقاً مثل `bot.ts` — وگرنه سفرِ کاربر بخشی از
  // رباتِ واقعی را نمی‌آزماید.
  registerConfirmableActions()
  registerConfirmationHandlers(bot, container)
  // هندلرهای افزوده پیش از نگهبانِ «دکمهٔ مرده» ثبت می‌شوند، چون grammy
  // میان‌افزارها را به ترتیب ثبت اجرا می‌کند.
  if (extra) extra(bot, container)
  bot.on('callback_query:data', async (ctx) => {
    sent.push({ method: '__DEAD_BUTTON__', payload: { data: ctx.callbackQuery.data } })
    await ctx.answerCallbackQuery('این دکمه دیگر قابل استفاده نیست.', true)
  })

  const pace = () => new Promise((r) => setTimeout(r, RATE_LIMIT_PAUSE_MS))
  const chatOf = (id) => (id < 0 ? { id, type: 'supergroup', title: 'منطقهٔ آزمون' } : { id, type: 'private' })

  /** پیام متنی از طرف بازیکن؛ شناسهٔ پیامش ثبت می‌شود تا ریپلای‌ها واقعی باشند. */
  async function text(userId, body, chatId = userId, extra = {}) {
    await pace()
    const chat = chatOf(chatId)
    const messageId = nextMessageId++
    const record = { id: messageId, chatId, text: body, owner: tgUser(userId), method: 'incoming' }
    messages.push(record)
    await bot.handleUpdate({
      update_id: updateId++,
      message: {
        message_id: messageId,
        date: 1,
        from: tgUser(userId),
        chat,
        text: body,
        ...extra
      }
    })
    return record
  }

  /** دستور (با entity) از طرف بازیکن. */
  async function command(userId, cmd, chatId = userId) {
    return text(userId, cmd, chatId, {
      entities: [{ type: 'bot_command', offset: 0, length: cmd.length }]
    })
  }

  /**
   * ریپلای بازیکن روی یکی از پیام‌های ربات (برای جریان‌های reply-based مثل
   * انتقال پول و خواستگاری).
   */
  async function replyText(userId, targetMessageId, body, chatId = userId) {
    await pace()
    const chat = chatOf(chatId)
    const messageId = nextMessageId++
    messages.push({ id: messageId, chatId, text: body, owner: tgUser(userId), method: 'incoming' })
    await bot.handleUpdate({
      update_id: updateId++,
      message: {
        message_id: messageId,
        date: 1,
        from: tgUser(userId),
        chat,
        text: body,
        reply_to_message: {
          message_id: targetMessageId,
          date: 1,
          from: messages.find((m) => m.id === targetMessageId)?.owner ?? tgUser(userId + 1),
          chat
        }
      }
    })
    return messageId
  }

  /**
   * زدن دکمه — دقیقاً همان کاری که بازیکن واقعی می‌کند: روی همان پیامی که
   * آن دکمه را دارد. اگر ربات بعد از پنل، پیام دیگری (مثلاً خبر) در گروه
   * بفرستد، بازیکن همچنان دکمهٔ پنل خودش را می‌زند؛ پس جست‌وجو از آخرین
   * پیامِ دارایِ آن دکمه شروع می‌شود، نه از آخرین پیامِ گروه.
   *
   * اگر هیچ پیامِ زنده‌ای آن دکمه را نداشته باشد، این یک یافتهٔ واقعی است
   * («دکمه‌ای که کاربر می‌بیند وجود ندارد») و استثنا پرتاب می‌شود.
   */
  async function press(userId, data, chatId = userId, { onMessageId, allowMissing = false } = {}) {
    await pace()
    const chat = chatOf(chatId)
    const carries = (rec) => {
      const kb = rec.keyboard
      if (!kb || !Array.isArray(kb.inline_keyboard)) return false
      return kb.inline_keyboard
        .flat()
        .some((b) => 'callback_data' in b && b.callback_data === data)
    }
    const record =
      onMessageId !== undefined
        ? messages.find((m) => m.id === onMessageId)
        : [...messages]
            .reverse()
            .find((m) => m.chatId === chatId && !m.deleted && m.method !== 'incoming' && carries(m))
    if (!record) {
      if (allowMissing) return null
      throw new Error(`no live panel in chat ${chatId} carries the button "${data}"`)
    }
    const message = {
      message_id: record.id,
      date: 1,
      chat,
      from: { id: 42, is_bot: true, first_name: 'میراث' }
    }
    if (record.replyTo) {
      message.reply_to_message = {
        message_id: record.replyTo,
        date: 1,
        from: record.owner ?? tgUser(userId),
        chat
      }
    }
    await bot.handleUpdate({
      update_id: updateId++,
      callback_query: { id: `cb${updateId}`, from: tgUser(userId), message, chat_instance: 'x', data }
    })
    return record
  }

  /** آخرین پنلِ زندهٔ ربات در یک چت که متنش با الگو می‌خواند. */
  function panelMatching(chatId, pattern) {
    const re = pattern instanceof RegExp ? pattern : new RegExp(String(pattern))
    return (
      [...messages]
        .reverse()
        .find((m) => m.chatId === chatId && !m.deleted && m.method !== 'incoming' && re.test(m.text)) ??
      null
    )
  }

  const calls = () => sent
  const textsOf = () => sent.map((s) => s.payload?.text ?? '').join('\n')
  const lastText = (n = 1) => sent.slice(-n).map((s) => s.payload?.text ?? '').join('\n')
  const lastKeyboard = () => {
    for (let i = sent.length - 1; i >= 0; i--) {
      const p = sent[i].payload
      if (p && p.reply_markup) return p.reply_markup
    }
    return null
  }
  /** همهٔ callback_dataهای آخرین کیبورد ارسال‌شده. */
  const lastButtons = () => {
    const kb = lastKeyboard()
    if (!kb) return []
    return kb.inline_keyboard
      .flat()
      .filter((b) => 'callback_data' in b)
      .map((b) => ({ text: b.text, data: b.callback_data }))
  }
  /** آخرین پاسخِ CallbackQuery (متنِ هشدار یا toast). */
  const lastAlert = () => {
    for (let i = sent.length - 1; i >= 0; i--) {
      if (sent[i].method === 'answerCallbackQuery') return sent[i].payload?.text ?? ''
    }
    return ''
  }
  /** آخرین پیامِ زندهٔ ربات در یک چت (متن + دکمه‌ها). */
  function describe(rec) {
    if (!rec) return null
    const kb = rec.keyboard
    return {
      text: rec.text,
      id: rec.id,
      owner: rec.owner?.id ?? null,
      buttons: kb
        ? kb.inline_keyboard.flat().filter((b) => 'callback_data' in b).map((b) => ({ text: b.text, data: b.callback_data }))
        : []
    }
  }
  const lastPanel = (chatId) =>
    describe(
      [...messages]
        .reverse()
        .find((m) => m.chatId === chatId && !m.deleted && m.method !== 'incoming')
    )
  const panel = (chatId, pattern) => describe(panelMatching(chatId, pattern))

  return {
    db,
    container,
    bot,
    text,
    command,
    replyText,
    press,
    calls,
    textsOf,
    lastText,
    lastKeyboard,
    lastButtons,
    lastAlert,
    lastPanel,
    panel,
    messages,
    sent
  }
}

module.exports = { createJourney, tgUser, RATE_LIMIT_PAUSE_MS }
