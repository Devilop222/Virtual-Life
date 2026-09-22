'use strict'
/**
 * سفرِ انتقال پول بین بازیکنان — روی PostgreSQL زنده و کل خط لولهٔ ربات.
 *
 * آنچه سنجیده می‌شود:
 *  • ریپلای + مبلغ → صفحهٔ تأیید (نه اجرای فوری)
 *  • تأیید → پول دقیقاً جابه‌جا می‌شود، ردیف دفتر کل نوشته می‌شود
 *  • هر دو طرف اعلان می‌گیرند؛ گیرنده پیام خصوصی هم می‌گیرد
 *  • دوبارزدن روی «تأیید» پول را دو برابر نمی‌کند
 *  • انصراف واقعاً لغو می‌کند
 *  • موجودی ناکافی / مبلغ نامعتبر / انتقال به خود → پیام روشن، بدون پول
 *  • هیچ پولی خلق یا نابود نمی‌شود (جمع کیف پول‌ها ثابت می‌ماند)
 *
 *   DATABASE_URL=postgresql://.../legacy_ux_test BOT_TOKEN=dummy \
 *     node scripts/money-flow-smoke.cjs
 */
const assert = require('node:assert/strict')

const url = process.env.DATABASE_URL
if (!url || !new URL(url).pathname.endsWith('_ux_test')) {
  throw new Error('Use a disposable *_ux_test database')
}
process.env.NODE_ENV = 'test'
process.env.BOT_TOKEN ||= '123456:MONEYFLOW'

const { PrismaClient } = require('@prisma/client')
const { PrismaPg } = require('@prisma/adapter-pg')
const { createJourney } = require('./journey-harness.cjs')
const { clearPushSender, registerPushSender } = require('../dist/modules/notification/push')

const SENDER = 934_000_001
const RECEIVER = 934_000_002
const ADMIN = 934_000_003
const GROUP = -934_100_001

const results = []
async function check(name, fn) {
  try {
    await fn()
    results.push({ name, ok: true })
  } catch (error) {
    results.push({ name, ok: false, error: error.message })
  }
}

async function main() {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) })
  const j = await createJourney({ db, adminUserIds: [ADMIN] })

  // پیام‌های خصوصیِ push‌شده را ضبط کن تا «به گیرنده خبر رسید» واقعاً سنجیده شود
  const pushed = []
  registerPushSender(async (telegramUserId, text) => {
    pushed.push({ telegramUserId: telegramUserId.toString(), text })
  })

  await db.$executeRawUnsafe('TRUNCATE TABLE players CASCADE')
  await db.$executeRawUnsafe('TRUNCATE TABLE groups CASCADE')
  await db.$executeRawUnsafe('TRUNCATE TABLE user_states')

  for (const uid of [SENDER, RECEIVER, ADMIN]) {
    await j.command(uid, '/start')
    await j.press(uid, 'reg:gender:MALE')
    await j.text(uid, `بازیکن ${uid % 1000} که دنبال ساختن آینده است.`)
  }
  await j.command(ADMIN, '/start', GROUP)

  const sender = await db.player.findUniqueOrThrow({
    where: { telegramUserId: BigInt(SENDER) }
  })
  const receiver = await db.player.findUniqueOrThrow({
    where: { telegramUserId: BigInt(RECEIVER) }
  })
  await db.player.update({ where: { id: sender.id }, data: { balance: 5_000_000 } })
  await db.player.update({ where: { id: receiver.id }, data: { balance: 100_000 } })

  const walletSum = async () =>
    Number((await db.player.aggregate({ _sum: { balance: true } }))._sum.balance ?? 0)
  const totalBefore = await walletSum()

  // گیرنده یک پیام در گروه می‌فرستد تا فرستنده بتواند رویش ریپلای کند
  await j.text(RECEIVER, 'سلام، کسی کارت داره؟', GROUP)
  const receiverMessageId = [...j.messages]
    .reverse()
    .find((m) => m.owner?.id === RECEIVER && m.method === 'incoming').id

  // ── ۱. ریپلای + مبلغ → صفحهٔ تأیید، هنوز پولی جابه‌جا نشده ──
  await j.replyText(SENDER, receiverMessageId, 'انتقال ۵۰۰۰۰۰', GROUP)
  await check('reply with an amount opens a confirmation page', async () => {
    const confirmPanel = j.panel(GROUP, /تأیید انتقال پول/)
    assert.ok(confirmPanel, `confirmation panel shown; last text: ${j.lastText().slice(0, 200)}`)
    assert.ok(confirmPanel.text.includes('۵۰۰٬۰۰۰'), 'the amount is shown to the player')
    assert.ok(confirmPanel.text.includes('کیف پول'), 'the funding source is stated')
    assert.ok(
      confirmPanel.buttons.some((b) => b.data.startsWith('transfer:confirm:')),
      'a confirm button exists'
    )
    assert.ok(
      confirmPanel.buttons.some((b) => b.data === 'transfer:cancel'),
      'a cancel button exists'
    )
  })
  await check('nothing moved before confirmation', async () => {
    assert.equal(await walletSum(), totalBefore)
  })

  // ── ۲. تأیید → پول جابه‌جا می‌شود ──
  const confirmPanel = j.panel(GROUP, /تأیید انتقال پول/)
  const confirmButton = confirmPanel.buttons.find((b) => b.data.startsWith('transfer:confirm:'))
  await j.press(SENDER, confirmButton.data, GROUP)

  await check('confirmation moves exactly the requested amount', async () => {
    const [s, r] = await Promise.all([
      db.player.findUniqueOrThrow({ where: { id: sender.id }, select: { balance: true } }),
      db.player.findUniqueOrThrow({ where: { id: receiver.id }, select: { balance: true } })
    ])
    assert.equal(Number(s.balance), 4_500_000)
    assert.equal(Number(r.balance), 600_000)
  })
  await check('a ledger row with both parties is written', async () => {
    const row = await db.financialTransaction.findFirst({
      where: { sourcePlayerId: sender.id, destinationPlayerId: receiver.id }
    })
    assert.ok(row, 'financial transaction recorded')
    assert.equal(Number(row.amount), 500_000)
    assert.equal(row.type, 'TRANSFER')
  })
  await check('no money was created or destroyed', async () => {
    assert.equal(await walletSum(), totalBefore)
  })
  await check('both players get a notification; the receiver gets a private push', async () => {
    const notes = await db.notification.findMany({
      where: { playerId: { in: [sender.id, receiver.id] } },
      orderBy: { createdAt: 'asc' }
    })
    const toReceiver = notes.filter((n) => n.playerId === receiver.id)
    const toSender = notes.filter((n) => n.playerId === sender.id)
    assert.ok(toReceiver.length >= 1, 'receiver has a notification')
    assert.ok(toSender.length >= 1, 'sender has a notification')
    assert.ok(toReceiver[0].message.includes('۵۰۰٬۰۰۰'), 'receiver notification states the amount')
    assert.ok(
      pushed.some((p) => p.telegramUserId === String(RECEIVER) && p.text.includes('۵۰۰٬۰۰۰')),
      `receiver got a private push; got: ${JSON.stringify(pushed)}`
    )
  })
  await check('the sender sees the result on the same panel', async () => {
    const done = j.panel(GROUP, /انتقال انجام شد/)
    assert.ok(done, `result panel rendered; alert: "${j.lastAlert()}"`)
  })

  // ── ۳. دوبارزدن روی همان «تأیید» ──
  await check('clicking the old confirm button again does not repeat the transfer', async () => {
    const before = await walletSum()
    // پنل ویرایش شده و آن دکمه دیگر روی صفحه نیست؛ ولی کلیکِ کهنه‌ای که در
    // صف تلگرام مانده هنوز به سرور می‌رسد. همان پیام، همان دادهٔ قدیمی.
    await j.press(SENDER, confirmButton.data, GROUP, { onMessageId: confirmPanel.id })
    assert.equal(await walletSum(), before, 'wallets unchanged')
    assert.match(j.lastAlert(), /پیش‌تر استفاده شده|منقضی/)
  })

  await check('two simultaneous confirms: only one wins', async () => {
    await j.replyText(SENDER, receiverMessageId, 'انتقال 100000', GROUP)
    const racePanel = j.panel(GROUP, /تأیید انتقال پول/)
    const token = racePanel.buttons.find((b) => b.data.startsWith('transfer:confirm:')).data
      .split(':')[2]
    const before = await walletSum()
    const wins = await Promise.all([
      j.container.userStateRepository.consumeScopedConfirmation(
        BigInt(SENDER),
        GROUP,
        'act',
        token
      ),
      j.container.userStateRepository.consumeScopedConfirmation(
        BigInt(SENDER),
        GROUP,
        'act',
        token
      )
    ])
    assert.equal(
      wins.filter((w) => w !== null).length,
      1,
      'exactly one claim may succeed'
    )
    assert.equal(await walletSum(), before)
    await j.press(SENDER, 'transfer:cancel', GROUP)
  })

  // ── ۴. انصراف واقعاً لغو می‌کند ──
  await j.replyText(SENDER, receiverMessageId, 'انتقال 200000', GROUP)
  const cancelPanel = j.panel(GROUP, /تأیید انتقال پول/)
  const secondConfirm = cancelPanel.buttons.find((b) =>
    b.data.startsWith('transfer:confirm:')
  )
  await check('cancel really cancels', async () => {
    await j.press(SENDER, 'transfer:cancel', GROUP)
    assert.equal(await walletSum(), totalBefore)
    const st = await db.userState.findUnique({ where: { telegramUserId: BigInt(SENDER) } })
    assert.ok(!st || !st.currentContext, 'pending confirmation cleared')
    assert.ok(j.panel(GROUP, /انتقال لغو شد/), 'cancellation is told to the player')
    // و تأییدِ قدیمی بعد از لغو هیچ اثری ندارد
    await j.press(SENDER, secondConfirm.data, GROUP, { onMessageId: cancelPanel.id })
    assert.equal(await walletSum(), totalBefore)
    assert.match(j.lastAlert(), /پیش‌تر استفاده شده|منقضی/)
  })

  // ── ۵. ورودی‌های نامعتبر ──
  await check('insufficient balance is explained, and nothing moves', async () => {
    await j.replyText(SENDER, receiverMessageId, 'انتقال 999000000', GROUP)
    const fail = j.panel(GROUP, /انتقال انجام نشد/)
    assert.ok(fail, `failure panel shown; last: ${j.lastText().slice(0, 200)}`)
    assert.equal(await walletSum(), totalBefore)
  })

  await check('a too-small amount is explained', async () => {
    await j.replyText(SENDER, receiverMessageId, 'انتقال 500', GROUP)
    const fail = j.panel(GROUP, /انتقال انجام نشد/)
    assert.ok(fail, 'rejection panel shown')
    assert.match(fail.text, /کمترین مبلغ/)
  })

  await check('a missing amount teaches the right format', async () => {
    await j.replyText(SENDER, receiverMessageId, 'انتقال', GROUP)
    const fail = j.panel(GROUP, /انتقال انجام نشد/)
    assert.ok(fail, 'guidance panel shown')
    assert.match(fail.text, /مثال/)
  })

  await check('transferring to yourself is refused', async () => {
    const ownMessage = [...j.messages]
      .reverse()
      .find((m) => m.owner?.id === SENDER && m.method === 'incoming').id
    await j.replyText(SENDER, ownMessage, 'انتقال 100000', GROUP)
    const fail = j.panel(GROUP, /انتقال انجام نشد/)
    assert.ok(fail, 'self-transfer refused')
    assert.equal(await walletSum(), totalBefore)
  })

  // ── ۶. کشف‌پذیری از پنل بانک ──
  await check('the bank panel explains how to transfer', async () => {
    await j.text(SENDER, 'بانک', GROUP)
    await j.press(SENDER, 'transfer:help', GROUP)
    const help = j.panel(GROUP, /انتقال پول به بازیکن/)
    assert.ok(help, `transfer help rendered; alert: "${j.lastAlert()}"`)
    assert.match(help.text, /ریپلای/)
  })

  clearPushSender()
  await db.$disconnect()

  const failed = results.filter((r) => !r.ok)
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n        ${r.error}`}`)
  }
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  if (failed.length) process.exit(1)
}

main().catch((e) => {
  console.error('FATAL:', e.message || e)
  process.exit(1)
})
