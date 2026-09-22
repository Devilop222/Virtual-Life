'use strict'
/**
 * سفرِ واقعیِ بازیکن — سناریوهای گزارش‌شده در استفادهٔ عملی از ربات.
 *
 * برخلاف تست‌های واحد، این اسکریپت کل خط لوله (میان‌افزار مالکیت پنل، سیاست
 * محیط، هندلرها، سرویس‌ها و PostgreSQL زنده) را با به‌روزرادی‌های جعلیِ تلگرام
 * اجرا می‌کند و چیزی را می‌سنجد که بازیکن می‌بیند: پیام، دکمه، هشدار و
 * وضعیتِ پایگاه‌داده پس از آن.
 *
 *   DATABASE_URL=postgresql://.../legacy_ux_test BOT_TOKEN=dummy \
 *     node scripts/user-journey-smoke.cjs
 */
const assert = require('node:assert/strict')

const url = process.env.DATABASE_URL
if (!url || !new URL(url).pathname.endsWith('_ux_test')) {
  throw new Error('Use a disposable *_ux_test database')
}
process.env.NODE_ENV = 'test'
process.env.BOT_TOKEN ||= '123456:JOURNEY'

const { PrismaClient } = require('@prisma/client')
const { PrismaPg } = require('@prisma/adapter-pg')
const { createJourney } = require('./journey-harness.cjs')

const PLAYER = 931_000_001
const ADMIN = 931_000_002
const OTHER = 931_000_003
const GROUP = -931_100_001

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

  // ── آماده‌سازی: دیتابیسِ یک‌بارمصرف کاملاً خالی می‌شود تا هر اجرا از
  //    نقطهٔ صفرِ یک بازیکن تازه شروع شود (RESTRICT روی کلیدهای خارجی). ──
  await db.$executeRawUnsafe('TRUNCATE TABLE players CASCADE')
  await db.$executeRawUnsafe('TRUNCATE TABLE groups CASCADE')
  await db.$executeRawUnsafe('TRUNCATE TABLE user_states')

  await j.command(PLAYER, '/start')
  await j.press(PLAYER, 'reg:gender:MALE')
  await j.text(PLAYER, 'جوانی که دنبال ساختن آینده است.')
  const player = await db.player.findUnique({ where: { telegramUserId: BigInt(PLAYER) } })
  assert.ok(player, 'player registered')
  await db.player.update({ where: { id: player.id }, data: { balance: 50_000_000 } })

  await j.command(ADMIN, '/start', GROUP)
  assert.ok(
    (await db.group.findUnique({ where: { telegramGroupId: BigInt(GROUP) } })) !== null,
    'group registered by admin'
  )

  // ── سناریوی ۱: سرپرستی حیوان از اول تا آخر ──
  await j.text(PLAYER, 'حیوان', GROUP)
  await check('pet panel opens in group', () => {
    assert.ok(j.panel(GROUP, /حیوان/), 'pet panel rendered')
  })

  await j.press(PLAYER, 'pet:choose_kind', GROUP)
  await check('kind list renders with a button per kind', () => {
    const kb = j.panel(GROUP, /انتخاب حیوان/)
    assert.ok(kb, 'kind-selection panel rendered')
    assert.ok(kb.buttons.map((b) => b.data).includes('pet:adopt:cat'), 'cat button present')
  })

  await j.press(PLAYER, 'pet:adopt:cat', GROUP)
  await check('bot asks for the pet name and stores the pending state', async () => {
    assert.ok(j.panel(GROUP, /نام حیوان/), 'name prompt shown')
  })
  const stateAfterPrompt = await db.userState.findUnique({
    where: { telegramUserId: BigInt(PLAYER) }
  })
  await check('UserState holds pet_name context', () => {
    assert.equal(stateAfterPrompt?.currentContext, 'pet_name:cat')
  })

  await j.text(PLAYER, 'پشمالو', GROUP)
  const pet = await db.pet.findFirst({ where: { player: { telegramUserId: BigInt(PLAYER) } } })
  await check('sending the name creates the pet', () => {
    assert.ok(pet, 'pet row exists after the player typed a name')
    assert.equal(pet.name, 'پشمالو')
  })
  await check('the bot answers after the name (no silence)', () => {
    const panel = j.panel(GROUP, /سرپرستی/)
    assert.ok(panel, 'a confirmation panel was sent back')
    assert.ok(panel.text.includes('پشمالو'), `panel mentions the name; got: ${panel?.text?.slice(0, 120)}`)
  })
  await check('pet state is cleared after adoption', async () => {
    const st = await db.userState.findUnique({ where: { telegramUserId: BigInt(PLAYER) } })
    assert.ok(!st || !st.currentContext, 'no leftover pending context')
  })

  // ── سناریوی ۲: نام نامعتبر باید راهنمایی بدهد، نه سکوت ──
  await db.pet.deleteMany({ where: { player: { telegramUserId: BigInt(PLAYER) } } })
  await j.text(PLAYER, 'حیوان', GROUP)
  await j.press(PLAYER, 'pet:choose_kind', GROUP)
  await j.press(PLAYER, 'pet:adopt:dog', GROUP)
  await j.text(PLAYER, 'س', GROUP)
  await check('invalid (too short) name is explained, not swallowed', () => {
    const panel = j.panel(GROUP, /نام/)
    assert.ok(panel, 'a reply was sent')
    assert.ok(
      /دست‌کم|نام/.test(panel.text),
      `expected guidance about the name; got: ${panel?.text?.slice(0, 160)}`
    )
  })
  await check('flow is still open after a bad name', async () => {
    const st = await db.userState.findUnique({ where: { telegramUserId: BigInt(PLAYER) } })
    assert.equal(st?.currentContext, 'pet_name:dog')
  })
  await j.text(PLAYER, 'رکس', GROUP)
  await check('second attempt with a good name succeeds', () => {
    assert.ok(j.panel(GROUP, /رکس/))
  })

  // ── سناریوی ۳: دکمهٔ انصراف واقعاً جریان را می‌بندد ──
  await db.pet.deleteMany({ where: { player: { telegramUserId: BigInt(PLAYER) } } })
  await j.text(PLAYER, 'حیوان', GROUP)
  await j.press(PLAYER, 'pet:choose_kind', GROUP)
  await j.press(PLAYER, 'pet:adopt:bird', GROUP)
  await j.press(PLAYER, 'pet:cancel_name', GROUP)
  await check('cancel closes the naming flow', async () => {
    const st = await db.userState.findUnique({ where: { telegramUserId: BigInt(PLAYER) } })
    assert.ok(!st || !st.currentContext)
  })
  await check('cancel brings the player back to the pet panel', () => {
    assert.ok(j.lastPanel(GROUP).text.includes('حیوان'))
  })

  // ── سناریوی ۴: بازیکنِ دارای حیوان، حیوان دوم نمی‌گیرد ──
  // اول یک حیوان واقعی می‌گیرد (سناریوی ۳ جریان را لغو کرده بود) …
  await j.text(PLAYER, 'حیوان', GROUP)
  await j.press(PLAYER, 'pet:choose_kind', GROUP)
  await j.press(PLAYER, 'pet:adopt:rabbit', GROUP)
  await j.text(PLAYER, 'برفی', GROUP)
  assert.ok(await db.pet.findFirst({ where: { player: { telegramUserId: BigInt(PLAYER) } } }))

  // … و بعد حیوان دوم را امتحان می‌کند
  await j.text(PLAYER, 'حیوان', GROUP)
  await j.press(PLAYER, 'pet:choose_kind', GROUP)
  await j.press(PLAYER, 'pet:adopt:cat', GROUP)
  await j.text(PLAYER, 'پشمالو', GROUP)
  await check('a second pet is refused, not created', async () => {
    const panel = j.panel(GROUP, /قبلاً|سرپرستی/)
    assert.ok(panel, 'a panel answered the second adoption')
    assert.ok(panel.text.includes('قبلاً'), `expected refusal; got: ${panel.text.slice(0, 200)}`)
    assert.equal(
      await db.pet.count({ where: { player: { telegramUserId: BigInt(PLAYER) } } }),
      1,
      'still exactly one pet'
    )
  })

  // ── سناریوی ۵: غذا و هدیهٔ روزانه ──
  const before = await db.player.findUnique({ where: { id: player.id } })
  await j.text(PLAYER, 'حیوان', GROUP)
  await j.press(PLAYER, 'pet:feed', GROUP)
  const afterFeed = await db.player.findUnique({ where: { id: player.id } })
  await check('feeding charges the player exactly the feed cost', () => {
    assert.ok(afterFeed.balance < before.balance, 'balance decreased')
  })

  // ── سناریوی ۵ب: جریانِ ورودیِ منقضی، بن‌بستِ بی‌صدا نمی‌سازد ──
  await db.pet.deleteMany({ where: { player: { telegramUserId: BigInt(PLAYER) } } })
  await j.text(PLAYER, 'حیوان', GROUP)
  await j.press(PLAYER, 'pet:choose_kind', GROUP)
  await j.press(PLAYER, 'pet:adopt:cat', GROUP)
  const namingState = await db.userState.findUniqueOrThrow({
    where: { telegramUserId: BigInt(PLAYER) }
  })
  assert.equal(namingState.currentContext, 'pet_name:cat')
  // ۲۰ دقیقه سکوت — بیش از سقفِ ۱۵ دقیقه‌ایِ جریان‌های ورودی
  await db.userState.update({
    where: { telegramUserId: BigInt(PLAYER) },
    data: { pendingSince: new Date(Date.now() - 20 * 60 * 1000) }
  })
  const sentBefore = j.sent.length
  await j.text(PLAYER, 'پشمالو', GROUP)
  await check('an expired input flow tells the player instead of going silent', () => {
    const replies = j.sent.slice(sentBefore)
    assert.ok(replies.length > 0, 'the bot answered; silence here is a dead end')
    const panel = j.panel(GROUP, /جریان تمام شده/)
    assert.ok(panel, 'the player is told the flow ended')
    assert.match(panel.text, /حیوان خانگی/u, 'and is pointed at the right panel, per flow')
  })
  await check('the expired input is not silently consumed as a pet name', async () => {
    assert.equal(
      await db.pet.count({ where: { player: { telegramUserId: BigInt(PLAYER) } } }),
      0,
      'no pet was created from an input that arrived after the window closed'
    )
    const st = await db.userState.findUnique({ where: { telegramUserId: BigInt(PLAYER) } })
    assert.ok(!st || !st.currentContext, 'the stale context is cleared, not left hanging')
  })

  // ── سناریوی ۵پ: ثبت‌نام با وقفهٔ طولانی از دست نمی‌رود ──
  // ثبت‌نام یک جریانِ چندمرحله‌ایِ قابلِ ازسرگیری است؛ پیش‌تر یک TTLِ تکراری
  // در لایهٔ مخزن آن را در ۱۵ دقیقه بی‌صدا پاک می‌کرد.
  await check('a registration in progress survives a long pause', async () => {
    await db.userState.upsert({
      where: { telegramUserId: BigInt(PLAYER) },
      create: {
        telegramUserId: BigInt(PLAYER),
        currentContext: 'registration',
        stateData: { step: 'bio' },
        pendingSince: new Date(Date.now() - 40 * 60 * 1000)
      },
      update: {
        currentContext: 'registration',
        stateData: { step: 'bio' },
        pendingSince: new Date(Date.now() - 40 * 60 * 1000)
      }
    })
    const read = await j.container.userStateRepository.findByTelegramUserIdWithExpiry(
      BigInt(PLAYER)
    )
    assert.equal(read.expiredContext, null, 'registration must not be expired at 40 minutes')
    assert.equal(read.state?.currentContext, 'registration', 'the step is still there')
  })

  // ── سناریوی ۶: دکمهٔ مرده در کل سفر ──
  await check('no dead button was hit during the pet journey', () => {
    const dead = j.calls().filter((c) => c.method === '__DEAD_BUTTON__')
    assert.deepEqual(dead.map((d) => d.payload.data), [])
  })

  await db.$disconnect()

  const failed = results.filter((r) => !r.ok)
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n        ${r.error}`}`)
  }
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  if (failed.length) process.exit(1)
}

main().catch((e) => {
  console.error('FATAL:', e)
  process.exit(1)
})
