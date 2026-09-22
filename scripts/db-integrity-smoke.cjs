'use strict'
/**
 * یکپارچگیِ داده — معیار ۲۷.
 *
 * سناریوهای واقعی اجرا می‌شوند (استخدام، اخراج، استعفا، خرید، وام، انتقال) و
 * بعد این پرسیده می‌شود که آیا دادهٔ مانده در دیتابیس با خودش سازگار است:
 *
 *   • شمارندهٔ denormalize (`business.activeEmployees`) با شمارِ واقعی
 *   • جای آگهی (`jobPosting.hiredCount`) بعد از رفتنِ کارمند آزاد می‌شود؟
 *   • یک بازیکن همزمان دو شغل یا دو ازدواج فعال نداشته باشد
 *   • دفترِ مالی یتیم یا بی‌مقدار نداشته باشد
 *   • وضعیت‌های کهنه (آگهیِ پُر ولی باز، سپردهٔ تسویه‌شدهٔ بی‌پرداخت)
 *
 *   DATABASE_URL=postgresql://.../legacy_ux_test BOT_TOKEN=dummy \
 *     node scripts/db-integrity-smoke.cjs
 */
const assert = require('node:assert/strict')

const url = process.env.DATABASE_URL
if (!url || !new URL(url).pathname.endsWith('_ux_test')) {
  throw new Error('Use a disposable *_ux_test database')
}
process.env.NODE_ENV = 'test'
process.env.BOT_TOKEN ||= '123456:DBINT'

const { PrismaClient } = require('@prisma/client')
const { PrismaPg } = require('@prisma/adapter-pg')
const { createJourney } = require('./journey-harness.cjs')

const BOSS = 937_000_001
const WORKER_A = 937_000_002
const WORKER_B = 937_000_003
const ADMIN = 937_000_004
const GROUP = -937_100_001

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

  for (const uid of [BOSS, WORKER_A, WORKER_B, ADMIN]) {
    await j.command(uid, '/start')
    await j.press(uid, 'reg:gender:MALE')
    await j.text(uid, `بازیکن ${uid % 1000} که دنبال ساختن آینده است.`)
  }
  await j.command(ADMIN, '/start', GROUP)
  await db.player.updateMany({
    where: { telegramUserId: { in: [BigInt(BOSS), BigInt(WORKER_A), BigInt(WORKER_B)] } },
    data: { balance: 500_000_000, experience: 1000 }
  })

  const boss = await db.player.findUniqueOrThrow({ where: { telegramUserId: BigInt(BOSS) } })
  const workerA = await db.player.findUniqueOrThrow({
    where: { telegramUserId: BigInt(WORKER_A) }
  })
  const workerB = await db.player.findUniqueOrThrow({
    where: { telegramUserId: BigInt(WORKER_B) }
  })

  const blueprint = j.container.businessService.getBlueprints()[0]
  // createBusiness حالا خودِ ردیفِ کسب‌وکار را زیر `business` برمی‌گرداند
  // (به‌همراه موجودی پس از تأسیس برای پنلِ نتیجه).
  const { business: biz } = await j.container.businessService.createBusiness(
    BigInt(BOSS),
    blueprint.modelType,
    'کارگاهِ یکپارچگی'
  )
  // ظرفیتِ ۲ تا هر دو صندلی آزمون شوند
  const posting = await j.container.businessService.postJob(BigInt(BOSS), biz.id, {
    title: 'کارگر ساده',
    salaryPerMinute: 800,
    capacity: 2,
    minExperience: 0,
    minAge: null,
    maxAge: null,
    requiredDegree: null,
    requiredSkill: null
  })

  const applyOf = async (workerTg) => {
    await j.container.businessService.applyForJob(workerTg, posting.id)
    const application = await db.jobApplication.findFirstOrThrow({
      where: { jobPostingId: posting.id, status: 'PENDING' },
      orderBy: { createdAt: 'desc' }
    })
    return application
  }

  // هر دو کارمند استخدام می‌شوند
  await j.container.businessService.hireEmployee(
    BigInt(BOSS),
    (await applyOf(BigInt(WORKER_A))).id
  )
  await j.container.businessService.hireEmployee(
    BigInt(BOSS),
    (await applyOf(BigInt(WORKER_B))).id
  )

  // ── ۱. شمارندهٔ denormalize با واقعیت یکی است ──
  await check('the employee counter matches the real number of active employees', async () => {
    const business = await db.business.findUniqueOrThrow({ where: { id: biz.id } })
    const real = await db.businessEmployee.count({ where: { businessId: biz.id, isActive: true } })
    assert.equal(
      business.activeEmployees,
      real,
      `counter says ${business.activeEmployees} but ${real} rows are active`
    )
    assert.equal(real, 2, 'both hires landed')
  })

  // ── ۲. بعد از اخراج، شمارنده باید برگردد ──
  await j.container.businessService.fireEmployee(BigInt(BOSS), biz.id, workerA.id)
  await check('the employee counter drops back after a firing', async () => {
    const business = await db.business.findUniqueOrThrow({ where: { id: biz.id } })
    const real = await db.businessEmployee.count({ where: { businessId: biz.id, isActive: true } })
    assert.equal(
      business.activeEmployees,
      real,
      `counter says ${business.activeEmployees} but ${real} rows are active`
    )
    assert.equal(real, 1, 'one employee left')
  })

  // ── ۳. بعد از استعفا هم همین‌طور ──
  const remaining = await db.businessEmployee.findFirstOrThrow({
    where: { businessId: biz.id, isActive: true }
  })
  await j.container.businessService.resign(BigInt(WORKER_B), remaining.id)
  await check('the employee counter drops back after a resignation', async () => {
    const business = await db.business.findUniqueOrThrow({ where: { id: biz.id } })
    const real = await db.businessEmployee.count({ where: { businessId: biz.id, isActive: true } })
    assert.equal(business.activeEmployees, real, 'counter drifted from the rows')
    assert.equal(real, 0, 'nobody is employed any more')
  })

  // ── ۴. صندلیِ آگهی بعد از رفتنِ کارمند آزاد می‌شود؟ ──
  await check('a posting frees its seat when the employee leaves', async () => {
    const fresh = await db.jobPosting.findUniqueOrThrow({ where: { id: posting.id } })
    const seated = await db.businessEmployee.count({
      where: { businessId: biz.id, isActive: true }
    })
    assert.equal(
      fresh.hiredCount,
      seated,
      `the posting still claims ${fresh.hiredCount} seats taken while ${seated} people actually work there`
    )
  })

  // ── ۵. کارفرما بتواند دوباره همان آگهی را پر کند ──
  await check('the employer can refill the seat through the same posting', async () => {
    const application = await applyOf(BigInt(WORKER_A))
    await j.container.businessService.hireEmployee(BigInt(BOSS), application.id)
    const seated = await db.businessEmployee.count({
      where: { businessId: biz.id, isActive: true }
    })
    assert.equal(seated, 1, 'the seat was refillable')
  })

  // ── ۵ب. آگهی‌ای که خودِ کارفرما بسته، با خالی‌شدنِ صندلی باز نمی‌شود ──
  await check('a posting the owner closed by hand stays closed', async () => {
    // کارمندِ فعلی از همان آگهی است؛ اول آگهی را دستی می‌بندیم
    await j.container.businessService.closePosting(BigInt(BOSS), biz.id, posting.id)
    const closedNow = await db.jobPosting.findUniqueOrThrow({ where: { id: posting.id } })
    assert.equal(closedNow.status, 'CLOSED', 'closed on request')
    assert.equal(closedNow.closedByOwner, true, 'the manual close is remembered')

    const seated = await db.businessEmployee.findFirstOrThrow({
      where: { businessId: biz.id, isActive: true }
    })
    await j.container.businessService.resign(BigInt(WORKER_A), seated.id)

    const after = await db.jobPosting.findUniqueOrThrow({ where: { id: posting.id } })
    assert.equal(
      after.status,
      'CLOSED',
      'a manually closed posting must not silently reopen when a seat frees'
    )
  })

  // ── ۶. هیچ بازیکنی همزمان دو شغل فعال ندارد ──
  await check('no player holds two active employments at once', async () => {
    const doubles = await db.$queryRawUnsafe(`
      SELECT player_id, COUNT(*) AS n
      FROM business_employees
      WHERE is_active = true
      GROUP BY player_id
      HAVING COUNT(*) > 1
    `)
    assert.deepEqual(doubles, [], JSON.stringify(doubles))
  })

  // ── ۷. آگهیِ پُر، باز نمی‌ماند ──
  await check('no posting stays open past its capacity', async () => {
    // مقایسهٔ ستون‌به‌ستون در SQL، چون Prisma دو ستونِ همان ردیف را
    // در `where` با هم مقایسه نمی‌کند
    const stale = await db.$queryRawUnsafe(`
      SELECT COUNT(*)::int AS n
      FROM job_postings
      WHERE status = 'OPEN' AND hired_count >= capacity
    `)
    assert.equal(stale[0].n, 0, `${stale[0].n} open postings claim to be full`)
  })

  // ── ۸. دفترِ مالی یتیم یا بی‌مقدار ندارد ──
  await check('the financial ledger has no orphan or empty rows', async () => {
    const orphans = await db.$queryRawUnsafe(`
      SELECT COUNT(*)::int AS n
      FROM financial_transactions t
      LEFT JOIN players p ON p.id = t.source_player_id
      WHERE t.source_player_id IS NOT NULL AND p.id IS NULL
    `)
    assert.equal(orphans[0].n, 0, `${orphans[0].n} ledger rows point at a missing player`)
    // `amount` یک Decimalِ ناشدنی (non-nullable) است؛ فقط کرانِ پایین معنا دارد
    const empties = await db.financialTransaction.count({ where: { amount: { lte: 0 } } })
    assert.equal(empties, 0, `${empties} ledger rows have no positive amount`)
  })

  // ── ۹. هر استخدامِ فعال به کسب‌وکارِ فعال وصل است ──
  await check('every active employment belongs to an active business', async () => {
    const stray = await db.businessEmployee.count({
      where: { isActive: true, business: { status: { not: 'ACTIVE' } } }
    })
    assert.equal(stray, 0, `${stray} active employees sit on a business that is not active`)
  })

  // ── ۱۰. وضعیت‌های کهنهٔ سپرده و وام ──
  await check('no stale deposit or loan state', async () => {
    const deposits = await db.termDeposit.count({
      where: {
        OR: [
          { status: { in: ['PAID', 'BROKEN'] }, payout: null },
          { status: { in: ['PAID', 'BROKEN'] }, settledAt: null },
          { status: 'ACTIVE', settledAt: { not: null } }
        ]
      }
    })
    assert.equal(deposits, 0, `${deposits} deposits have an inconsistent settlement state`)
    const loans = await db.loan.count({
      where: {
        OR: [
          { status: 'PAID', remainingAmount: { not: 0 } },
          { status: 'ACTIVE', remainingAmount: { lte: 0 } }
        ]
      }
    })
    assert.equal(loans, 0, `${loans} loans have an inconsistent remaining amount`)
  })

  // ── ۱۱. هیچ موجودیِ منفی ──
  await check('no vault is negative', async () => {
    const vaults = {
      wallets: await db.player.count({ where: { balance: { lt: 0 } } }),
      treasuries: await db.business.count({ where: { treasury: { lt: 0 } } }),
      banks: await db.bankAccount.count({ where: { balance: { lt: 0 } } }),
      unpaid: await db.businessEmployee.count({ where: { unpaidSalary: { lt: 0 } } })
    }
    for (const [label, count] of Object.entries(vaults)) {
      assert.equal(count, 0, `${label} must never be negative — found ${count}`)
    }
    assert.ok(boss.id && workerA.id && workerB.id, 'players resolved')
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
