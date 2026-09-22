'use strict'
/**
 * ممیزی مالکیت و مجوز — سفر واقعی «کسب‌وکار ← استخدام».
 *
 * پرسش‌هایی که این اسکریپت جواب می‌دهد:
 *  • مالکِ پنل آیا می‌تواند هر دکمهٔ پنلِ خودش را تا آخر بزند؟
 *  • بازیکنِ دیگر آیا واقعاً مسدود است؟
 *  • جریانِ چندمرحله‌ایِ آگهی استخدام از عنوان تا ذخیره کامل می‌شود؟
 *
 *   DATABASE_URL=postgresql://.../legacy_ux_test BOT_TOKEN=dummy \
 *     node scripts/ownership-journey-smoke.cjs
 */
const assert = require('node:assert/strict')

const url = process.env.DATABASE_URL
if (!url || !new URL(url).pathname.endsWith('_ux_test')) {
  throw new Error('Use a disposable *_ux_test database')
}
process.env.NODE_ENV = 'test'
process.env.BOT_TOKEN ||= '123456:OWNERSHIP'

const { PrismaClient } = require('@prisma/client')
const { PrismaPg } = require('@prisma/adapter-pg')
const { createJourney } = require('./journey-harness.cjs')

const OWNER = 932_000_001
const ADMIN = 932_000_002
const INTRUDER = 932_000_003
const GROUP = -932_100_001

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

  await db.$executeRawUnsafe('TRUNCATE TABLE players CASCADE')
  await db.$executeRawUnsafe('TRUNCATE TABLE groups CASCADE')
  await db.$executeRawUnsafe('TRUNCATE TABLE user_states')

  // ── سه بازیکن: مالک، ادمین گروه، و یک غریبه ──
  for (const uid of [OWNER, ADMIN, INTRUDER]) {
    await j.command(uid, '/start')
    await j.press(uid, 'reg:gender:MALE')
    await j.text(uid, `بازیکن شمارهٔ ${uid % 1000} که دنبال ساختن آینده است.`)
  }
  await db.player.updateMany({
    where: { telegramUserId: { in: [BigInt(OWNER), BigInt(INTRUDER)] } },
    data: { balance: 200_000_000, experience: 600 }
  })
  await j.command(ADMIN, '/start', GROUP)

  // ── مالک کسب‌وکار تأسیس می‌کند ──
  await j.text(OWNER, 'کار', GROUP)
  await j.press(OWNER, 'work:menu:full_time', GROUP)
  await j.press(OWNER, 'work:ft:new_biz', GROUP)
  const blueprints = j.panel(GROUP, /کسب‌وکار/)
  assert.ok(blueprints, 'business blueprint list rendered')
  const createButton = blueprints.buttons.find((b) => b.data.startsWith('biz:create:'))
  assert.ok(createButton, `a create button exists (got: ${JSON.stringify(blueprints.buttons)})`)
  await j.press(OWNER, createButton.data, GROUP)
  // تأسیس کسب‌وکار پشتِ تأیید دومرحله‌ای است؛ همان کاری که بازیکن می‌کند
  const createConfirm = j.panel(GROUP, /تأیید تأسیس کسب‌وکار/)
  assert.ok(createConfirm, `business confirmation shown; last: ${j.lastText().slice(0, 200)}`)
  await j.press(
    OWNER,
    createConfirm.buttons.find((b) => b.data.startsWith('act:go:')).data,
    GROUP
  )

  const business = await db.business.findFirst({
    where: { owner: { telegramUserId: BigInt(OWNER) } }
  })
  assert.ok(business, 'business created for the owner')

  // ── پنل مدیریت کسب‌وکار (متعلق به خودِ مالک) ──
  await j.text(OWNER, 'کسب‌وکار', GROUP)
  const bizPanel = j.panel(GROUP, /کسب‌وکار/)
  assert.ok(bizPanel, 'business panel rendered')
  await check('owner reaches the staff panel of their own business', async () => {
    await j.press(OWNER, `biz:apps:${business.id}`, GROUP)
    assert.doesNotMatch(j.lastAlert(), /متعلق به تو نیست/, j.lastAlert())
    assert.ok(j.panel(GROUP, /درخواست/), 'staff panel rendered')
  })

  // ── «آگهی استخدام»: پیش‌نیازها و شرایط ──
  await j.text(OWNER, 'کسب‌وکار', GROUP)
  await check('owner opens the hiring wizard from their own panel', async () => {
    await j.press(OWNER, `biz:postjob:${business.id}`, GROUP)
    assert.doesNotMatch(j.lastAlert(), /متعلق به تو نیست/, j.lastAlert())
    assert.ok(j.panel(GROUP, /عنوان شغل/), `hiring wizard opened; alert: "${j.lastAlert()}"`)
  })

  await check('owner types the job title and reaches the requirement wizard', async () => {
    await j.text(OWNER, 'فروشنده ارشد', GROUP)
    const wizard = j.panel(GROUP, /سازندهٔ آگهی/)
    assert.ok(wizard, `wizard panel rendered; last text: ${j.lastText().slice(0, 200)}`)
    assert.ok(
      wizard.buttons.map((b) => b.data).includes('biz:jf:save'),
      `wizard carries the save button; got ${JSON.stringify(wizard.buttons)}`
    )
    // ظرفیتِ نمایشی باید ظرفیتِ واقعیِ همان کسب‌وکار باشد، نه یک عدد ثابت
    assert.ok(
      wizard.text.includes(`${business.employeeCapacity.toLocaleString('fa-IR')}`),
      `wizard shows the real capacity (${business.employeeCapacity}); got:\n${wizard.text}`
    )
  })

  await check('adjusting requirements works for the owner', async () => {
    await j.press(OWNER, 'biz:jf:sal:50', GROUP)
    assert.doesNotMatch(j.lastAlert(), /متعلق به تو نیست/, j.lastAlert())
    const wizard = j.panel(GROUP, /سازندهٔ آگهی/)
    assert.ok(wizard, `wizard still renders; alert: "${j.lastAlert()}"`)
    assert.ok(wizard.text.includes('۴۵۰'), `salary moved to 450; got:\n${wizard.text}`)
  })

  await check('saving publishes the job posting', async () => {
    await j.press(OWNER, 'biz:jf:save', GROUP)
    const posting = await db.jobPosting.findFirst({ where: { businessId: business.id } })
    assert.ok(posting, 'job posting row created')
    assert.equal(posting.title, 'فروشنده ارشد')
    assert.equal(Number(posting.salaryPerMinute), 450)
  })

  // ── غریبه: هیچ دکمه‌ای از پنل مالک را نمی‌تواند بزند ──
  await check('an intruder is refused on the owner panel', async () => {
    const managePanel = j.messages
      .filter((m) => m.chatId === GROUP && !m.deleted && m.method !== 'incoming')
      .reverse()
      .find((m) => JSON.stringify(m.keyboard ?? '').includes(`biz:manage:${business.id}`))
    assert.ok(managePanel, 'the owner panel is still on screen')
    await j.press(INTRUDER, `biz:manage:${business.id}`, GROUP, { onMessageId: managePanel.id })
    assert.match(j.lastAlert(), /متعلق به تو نیست|not yours|پنل/)
  })

  // ── سرویس هم سمت سرور مجوز را می‌سنجد (نه فقط UI) ──
  await check('the service layer refuses a non-owner even with a valid id', async () => {
    await assert.rejects(
      () => j.container.businessService.postJob(BigInt(INTRUDER), business.id, {
        title: 'نفوذی',
        salaryPerMinute: 400,
        capacity: 1,
        minExperience: 0,
        minAge: null,
        maxAge: null,
        requiredDegree: 'DIPLOMA',
        requiredSkill: null
      }),
      (error) => /متعلق به تو نیست/.test(error.persianMessage)
    )
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
