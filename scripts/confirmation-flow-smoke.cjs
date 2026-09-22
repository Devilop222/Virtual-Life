'use strict'
/**
 * سفرِ تأیید دومرحله‌ای — عملیات حساس پشتِ صفحهٔ تأیید.
 *
 *   • انتخاب رشته: تأیید → ثبت‌نام؛ انصراف → هیچ ثبت‌نامی
 *   • خرید ملک: انصراف → ملکی خریداری نمی‌شود و پولی کسر نمی‌شود
 *   • تأسیس کسب‌وکار: دوبارزدن روی «تأیید» شرکت دوم نمی‌سازد
 *   • تأییدِ کهنه/مصرف‌شده → پیام روشن، بدون اثر
 *   • افتتاح شعبه: تأیید → یک شعبه و کسر هزینه؛ انصراف → هیچ
 *
 *   DATABASE_URL=postgresql://.../legacy_ux_test BOT_TOKEN=dummy \
 *     node scripts/confirmation-flow-smoke.cjs
 */
const assert = require('node:assert/strict')

const url = process.env.DATABASE_URL
if (!url || !new URL(url).pathname.endsWith('_ux_test')) {
  throw new Error('Use a disposable *_ux_test database')
}
process.env.NODE_ENV = 'test'
process.env.BOT_TOKEN ||= '123456:CONFIRM'

const { PrismaClient } = require('@prisma/client')
const { PrismaPg } = require('@prisma/adapter-pg')
const { createJourney } = require('./journey-harness.cjs')
const { historyEventLabels } = require('../dist/modules/events/event.service')

const PLAYER = 935_000_001
const ADMIN = 935_000_002
const GROUP = -935_100_001
const WORKER = 935_000_003

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
  // هارنس خودش لایهٔ تأیید را مثل bot.ts ثبت می‌کند
  const j = await createJourney({ db, adminUserIds: [ADMIN] })

  await db.$executeRawUnsafe('TRUNCATE TABLE players CASCADE')
  await db.$executeRawUnsafe('TRUNCATE TABLE groups CASCADE')
  await db.$executeRawUnsafe('TRUNCATE TABLE user_states')

  for (const uid of [PLAYER, ADMIN, WORKER]) {
    await j.command(uid, '/start')
    await j.press(uid, 'reg:gender:MALE')
    await j.text(uid, 'بازیکنی که دنبال ساختن آینده است.')
  }
  await j.command(ADMIN, '/start', GROUP)
  const player = await db.player.findUniqueOrThrow({
    where: { telegramUserId: BigInt(PLAYER) }
  })
  await db.player.update({
    where: { id: player.id },
    data: { balance: 500_000_000, experience: 1000 }
  })

  const confirmData = (pattern) => {
    const p = j.panel(GROUP, pattern)
    assert.ok(p, `confirmation panel matching ${pattern} not found; last: ${j.lastText().slice(0, 160)}`)
    const go = p.buttons.find((b) => b.data.startsWith('act:go:'))
    const no = p.buttons.find((b) => b.data.startsWith('act:no:'))
    assert.ok(go, 'a confirm button exists')
    assert.ok(no, 'a cancel button exists')
    return { panel: p, go: go.data, no: no.data }
  }

  // ── ۱. انتخاب رشته: اول تأیید، بعد ثبت‌نام ──
  await j.text(PLAYER, 'تحصیل', GROUP)
  await j.press(PLAYER, 'edu:choose_field', GROUP)
  const fieldPanel = j.panel(GROUP, /رشته|مهندسی|مدیریت/)
  const fieldButton = fieldPanel.buttons.find((b) => b.data.startsWith('edu:enroll:'))
  assert.ok(fieldButton, `a field button exists; got ${JSON.stringify(fieldPanel.buttons)}`)

  await j.press(PLAYER, fieldButton.data, GROUP)
  await check('choosing a field shows a confirmation page, not an instant enrolment', async () => {
    const { go } = confirmData(/تأیید انتخاب رشته/)
    const before = await db.player.findUniqueOrThrow({ where: { id: player.id } })
    assert.equal(before.isEnrolled, false, 'not enrolled before confirmation')
    // و صفحه واقعاً پیامد را توضیح می‌دهد
    const page = j.panel(GROUP, /تأیید انتخاب رشته/)
    assert.match(page.text, /هزینه|مسیر/)
    await j.press(PLAYER, go, GROUP)
    const after = await db.player.findUniqueOrThrow({ where: { id: player.id } })
    assert.equal(after.isEnrolled, true, 'enrolment happened only after confirmation')
    assert.ok(after.enrolledFieldKey, 'the chosen field is stored')
  })

  // ── ۲. خرید ملک: انصراف واقعاً لغو می‌کند ──
  await j.text(PLAYER, 'خانه', GROUP)
  await j.press(PLAYER, 'house:buy_catalog', GROUP)
  const catalog = j.panel(GROUP, /ملک|خانه/)
  const buyButton = catalog.buttons.find((b) => b.data.startsWith('house:buy:'))
  assert.ok(buyButton, `a buy button exists; got ${JSON.stringify(catalog.buttons)}`)

  await j.press(PLAYER, buyButton.data, GROUP)
  await check('cancelling a property purchase buys nothing', async () => {
    const { no, panel: page } = confirmData(/تأیید خرید ملک/)
    assert.match(page.text, /قیمت/)
    const walletBefore = Number(
      (await db.player.findUniqueOrThrow({ where: { id: player.id } })).balance
    )
    await j.press(PLAYER, no, GROUP)
    assert.equal(await db.property.count({ where: { ownerId: player.id } }), 0, 'no property')
    const walletAfter = Number(
      (await db.player.findUniqueOrThrow({ where: { id: player.id } })).balance
    )
    assert.equal(walletAfter, walletBefore, 'no money spent')
    assert.ok(j.panel(GROUP, /لغو شد/), 'the player is told it was cancelled')
  })

  // ── ۳. تأسیس کسب‌وکار: دوبارزدن شرکت دوم نمی‌سازد ──
  await j.text(PLAYER, 'کار', GROUP)
  await j.press(PLAYER, 'work:menu:full_time', GROUP)
  await j.press(PLAYER, 'work:ft:new_biz', GROUP)
  const blueprints = j.panel(GROUP, /کسب‌وکار/)
  const createButton = blueprints.buttons.find((b) => b.data.startsWith('biz:create:'))
  assert.ok(createButton, 'a create button exists')

  await j.press(PLAYER, createButton.data, GROUP)
  await check('confirming once creates exactly one business, twice does not create two', async () => {
    const { go, panel: page } = confirmData(/تأیید تأسیس کسب‌وکار/)
    assert.match(page.text, /هزینهٔ راه‌اندازی/)
    const confirmMessageId = page.id
    await j.press(PLAYER, go, GROUP)
    assert.equal(await db.business.count({ where: { ownerId: player.id } }), 1)

    // کلیک کهنهٔ همان توکن
    await j.press(PLAYER, go, GROUP, { onMessageId: confirmMessageId })
    assert.equal(
      await db.business.count({ where: { ownerId: player.id } }),
      1,
      'a replayed confirm must not create a second business'
    )
    assert.match(j.lastAlert(), /پیش‌تر استفاده شده|منقضی/)
  })

  // ── ۴. تأییدِ لغوشده بعداً هیچ اثری ندارد ──
  await check('a cancelled confirmation cannot be replayed later', async () => {
    await j.text(PLAYER, 'کار', GROUP)
    await j.press(PLAYER, 'work:menu:full_time', GROUP)
    await j.press(PLAYER, 'work:ft:new_biz', GROUP)
    const list = j.panel(GROUP, /کسب‌وکار/)
    const create = list.buttons.find((b) => b.data.startsWith('biz:create:'))
    assert.ok(create, 'create button available again')
    await j.press(PLAYER, create.data, GROUP)
    const { go, no, panel: page } = confirmData(/تأیید تأسیس کسب‌وکار/)
    await j.press(PLAYER, no, GROUP)
    const countBefore = await db.business.count({ where: { ownerId: player.id } })
    await j.press(PLAYER, go, GROUP, { onMessageId: page.id })
    assert.equal(await db.business.count({ where: { ownerId: player.id } }), countBefore)
  })

  // ── ۵. افتتاح شعبه: پول نقد کسر می‌کند، پس تأیید می‌خواهد ──
  await check('opening a branch asks for confirmation, spends once, and lands in the player history', async () => {
    await j.text(PLAYER, 'شعبه', GROUP)
    await j.press(PLAYER, 'br:main', GROUP)
    const branchPanel = j.panel(GROUP, /شعبه/)
    const openButton = branchPanel.buttons.find((b) => b.data.startsWith('br:open:'))
    assert.ok(openButton, `a region button exists; got ${JSON.stringify(branchPanel.buttons)}`)

    await j.press(PLAYER, openButton.data, GROUP)
    const { go, no, panel: page } = confirmData(/تأیید افتتاح شعبه/)
    assert.match(page.text, /هزینهٔ تأسیس/, 'the page states the price')
    assert.match(page.text, /درآمد روزانه/, 'the page states what you get')

    // انصراف: نه شعبه‌ای ساخته می‌شود نه پولی می‌رود
    const walletBefore = Number(
      (await db.player.findUniqueOrThrow({ where: { id: player.id } })).balance
    )
    await j.press(PLAYER, no, GROUP)
    assert.equal(await db.businessBranch.count({ where: { business: { ownerId: player.id } } }), 0)
    assert.equal(
      Number((await db.player.findUniqueOrThrow({ where: { id: player.id } })).balance),
      walletBefore,
      'cancelling spends nothing'
    )

    // تأیید: دقیقاً یک شعبه، پول کسر می‌شود، در تاریخچهٔ بازیکن هم می‌نشیند.
    // پنل شعبه باید دوباره باز شود: صفحهٔ تأییدِ لغوشده جایش را گرفته بود.
    await j.text(PLAYER, 'شعبه', GROUP)
    const reopened = j.panel(GROUP, /شعبه/)
    const reopenButton = reopened.buttons.find((b) => b.data.startsWith('br:open:'))
    assert.ok(
      reopenButton,
      `the branch panel is reachable again after a cancel; got ${JSON.stringify(reopened.buttons)}`
    )
    await j.press(PLAYER, reopenButton.data, GROUP)
    const second = confirmData(/تأیید افتتاح شعبه/)
    await j.press(PLAYER, second.go, GROUP)
    assert.equal(await db.businessBranch.count({ where: { business: { ownerId: player.id } } }), 1)
    assert.ok(
      Number((await db.player.findUniqueOrThrow({ where: { id: player.id } })).balance) < walletBefore,
      'the setup cost was really debited'
    )
    assert.equal(
      await db.gameEvent.count({ where: { playerId: player.id, type: 'BRANCH_OPENED' } }),
      1,
      'the player history records the branch'
    )

    // کلیک کهنه: شعبهٔ دوم ساخته نمی‌شود
    await j.press(PLAYER, second.go, GROUP, { onMessageId: second.panel.id })
    assert.equal(
      await db.businessBranch.count({ where: { business: { ownerId: player.id } } }),
      1,
      'a replayed confirm must not open a second branch'
    )
  })

  // ── ۶. استخدام: تعهدِ حقوقِ جاری می‌سازد، پس تأیید می‌خواهد ──
  const business = await db.business.findFirstOrThrow({ where: { ownerId: player.id } })
  const posting = await j.container.businessService.postJob(BigInt(PLAYER), business.id, {
    title: 'نگهبان شب',
    salaryPerMinute: 900,
    capacity: 1,
    minExperience: 0,
    minAge: null,
    maxAge: null,
    requiredDegree: null,
    requiredSkill: null
  })
  // درخواست از راهِ خودِ دکمه، نه سرویس: تا برچسبِ تاریخچه هم آزموده شود
  await j.text(WORKER, 'کار', GROUP)
  await j.press(WORKER, 'work:menu:full_time', GROUP)
  await j.press(WORKER, 'work:ft:find_jobs', GROUP)
  const listing = j.panel(GROUP, /آگهی|فرصت|شغل/)
  const openButton =
    listing.buttons.find((b) => b.data === `job:open:${posting.id}`) ??
    listing.buttons.find((b) => b.data.startsWith('job:open:'))
  assert.ok(openButton, `the posting is listed; got ${JSON.stringify(listing.buttons)}`)
  await j.press(WORKER, openButton.data, GROUP)
  const detail = j.panel(GROUP, /نگهبان شب|درخواست/)
  const applyButton = detail.buttons.find((b) => b.data.startsWith('job:apply:'))
  assert.ok(applyButton, `an apply button exists; got ${JSON.stringify(detail.buttons)}`)
  await j.press(WORKER, applyButton.data, GROUP)

  await check('sending an application is recorded as a request, not as starting the job', async () => {
    const workerPlayer = await db.player.findUniqueOrThrow({
      where: { telegramUserId: BigInt(WORKER) }
    })
    const events = await db.gameEvent.findMany({
      where: { playerId: workerPlayer.id, type: 'JOB_APPLIED' },
      select: { title: true }
    })
    assert.equal(events.length, 1, 'exactly one application event')
    assert.match(events[0].title, /درخواست استخدام/)
    assert.equal(
      await db.gameEvent.count({ where: { playerId: workerPlayer.id, type: 'JOB_STARTED' } }),
      0,
      'applying must not be labelled as starting a job'
    )
    assert.equal(historyEventLabels.JOB_APPLIED, 'درخواست کار')
  })

  await check('hiring an applicant asks for confirmation and only then employs them', async () => {
    await j.text(PLAYER, 'کار', GROUP)
    await j.press(PLAYER, 'work:menu:my_biz', GROUP)
    await j.press(PLAYER, `biz:apps:${business.id}`, GROUP)
    const apps = j.panel(GROUP, /درخواست|متقاضی|نگهبان/)
    const hireButton = apps.buttons.find((b) => b.data.startsWith('job:hire:'))
    assert.ok(hireButton, `a hire button exists; got ${JSON.stringify(apps.buttons)}`)

    await j.press(PLAYER, hireButton.data, GROUP)
    const { go, no, panel: page } = confirmData(/تأیید استخدام/)
    assert.match(page.text, /نگهبان شب/, 'the page names the role')
    assert.match(page.text, /حقوق/, 'the page states the wage obligation')

    await j.press(PLAYER, no, GROUP)
    assert.equal(
      await db.businessEmployee.count({ where: { businessId: business.id, isActive: true } }),
      0,
      'cancelling hires nobody'
    )

    await j.text(PLAYER, 'کار', GROUP)
    await j.press(PLAYER, 'work:menu:my_biz', GROUP)
    await j.press(PLAYER, `biz:apps:${business.id}`, GROUP)
    const again = j.panel(GROUP, /درخواست|متقاضی|نگهبان/)
    const retry = again.buttons.find((b) => b.data.startsWith('job:hire:'))
    assert.ok(retry, 'the application is still pending after a cancel')
    await j.press(PLAYER, retry.data, GROUP)
    const second = confirmData(/تأیید استخدام/)
    await j.press(PLAYER, second.go, GROUP)
    assert.equal(
      await db.businessEmployee.count({ where: { businessId: business.id, isActive: true } }),
      1,
      'confirming really employs the applicant'
    )
    await j.press(PLAYER, second.go, GROUP, { onMessageId: second.panel.id })
    assert.equal(
      await db.businessEmployee.count({ where: { businessId: business.id, isActive: true } }),
      1,
      'a replayed confirm does not hire twice'
    )
  })

  // ── ۷. اخراج: تسویهٔ پول و پایانِ همکاری — برگشت‌ناپذیر ──
  await check('firing an employee asks for confirmation and only then settles and removes them', async () => {
    const workerPlayer = await db.player.findUniqueOrThrow({
      where: { telegramUserId: BigInt(WORKER) }
    })
    await j.text(PLAYER, 'کار', GROUP)
    await j.press(PLAYER, 'work:menu:my_biz', GROUP)
    await j.press(PLAYER, `biz:emps:${business.id}`, GROUP)
    const emps = j.panel(GROUP, /کارمند|تیم|نگهبان/)
    const fireButton = emps.buttons.find((b) => b.data.startsWith('job:fire:'))
    assert.ok(fireButton, `a fire button exists; got ${JSON.stringify(emps.buttons)}`)

    await j.press(PLAYER, fireButton.data, GROUP)
    const { go, no, panel: page } = confirmData(/تأیید اخراج کارمند/)
    assert.match(page.text, /حقوق معوق/, 'the page states what will be settled')
    assert.match(page.text, /برگشت‌پذیر نیست/, 'the page states it is irreversible')

    await j.press(PLAYER, no, GROUP)
    assert.equal(
      await db.businessEmployee.count({ where: { businessId: business.id, isActive: true } }),
      1,
      'cancelling keeps the employee on the team'
    )

    await j.text(PLAYER, 'کار', GROUP)
    await j.press(PLAYER, 'work:menu:my_biz', GROUP)
    await j.press(PLAYER, `biz:emps:${business.id}`, GROUP)
    const again = j.panel(GROUP, /کارمند|تیم|نگهبان/)
    const retry = again.buttons.find((b) => b.data.startsWith('job:fire:'))
    assert.ok(retry, 'the employee is still listed after a cancel')
    await j.press(PLAYER, retry.data, GROUP)
    const second = confirmData(/تأیید اخراج کارمند/)
    await j.press(PLAYER, second.go, GROUP)
    assert.equal(
      await db.businessEmployee.count({ where: { businessId: business.id, isActive: true } }),
      0,
      'confirming really ends the employment'
    )
    assert.ok(workerPlayer.id, 'worker resolved')
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
  console.error('FATAL:', e.message || e)
  process.exit(1)
})
