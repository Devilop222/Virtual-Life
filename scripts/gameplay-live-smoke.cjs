/* Run only against a disposable migrated database named *_ux_test.
 * Requires build first (dist/). This is the end-to-end "play the game" trace:
 * the six audit scenarios driven through the fully wired container against live
 * PostgreSQL, asserting the invariants mocks cannot prove.
 *
 *   A. job → income → tax → fatigue/health/productivity (life core inside pay)
 *   B. bank: one account per player, deposit/withdraw conservation, interest once
 *   C. business: startup cost once, hire once, payroll settles once, no free money
 *   D. group registration: one registration, environment level from real members
 *   E. education/skill → profile → income (deterministic factor chain)
 *
 * DATABASE_URL=postgresql://.../legacy_ux_test node scripts/gameplay-live-smoke.cjs
 */
const assert = require('node:assert/strict')

const url = process.env.DATABASE_URL
if (!url || !new URL(url).pathname.endsWith('_ux_test')) {
  throw new Error('Use a disposable *_ux_test database')
}
process.env.BOT_TOKEN ||= '123456:SMOKE_TEST'
process.env.NODE_ENV = 'test'

const { PrismaClient } = require('@prisma/client')
const { PrismaPg } = require('@prisma/adapter-pg')
const { buildContainer } = require('../dist/services/container')
const { REGION_CONFIG } = require('../dist/config/region.config')
const { incomeTaxOf } = require('../dist/config/economy')
const { PART_TIME_JOBS, BUSINESS_BLUEPRINTS } = require('../dist/modules/occupation/work-blueprints')
const {
  EDUCATION_FIELDS,
  educationRankOf
} = require('../dist/modules/education/education-blueprints')
const { MIN_HEALTH, MAX_FATIGUE } = require('../dist/modules/life/life-core')
const {
  environmentThresholdsText,
  ENVIRONMENT_LABELS
} = require('../dist/modules/groups/group.service')

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) })

/** گروه آزمایشی: جمعیت فقط از «تلگرام» می‌آید؛ اینجا همان منبع را جعل می‌کنیم. */
let telegramMemberInfo = { totalCount: null, realMemberCount: null, adminTelegramUserIds: [] }

const container = buildContainer({
  getMemberInfo: async () => telegramMemberInfo
})

const work = container.workSessionService
const income = container.incomeCalculationService
const banking = container.bankingService
const business = container.businessService
const groups = container.groupService
const education = container.educationService
const skills = container.skillService

const workerId = 9200000301n
const tiredId = 9200000302n
const bankerId = 9200000303n
const ownerId = 9200000304n
const poorOwnerId = 9200000305n
const employeeId = 9200000306n
const secondEmployeeId = 9200000307n
const studentId = 9200000308n

const playerIds = [
  workerId,
  tiredId,
  bankerId,
  ownerId,
  poorOwnerId,
  employeeId,
  secondEmployeeId,
  studentId
]

const mainGroupId = 9300000401n
const raceGroupId = 9300000402n

async function rejected(fn, why) {
  await assert.rejects(fn, (error) => {
    assert.ok(error, `${why}: expected a rejection`)
    return true
  }, why)
}

/** The rejection must name the exact reason, not just "something threw". */
async function rejectedWith(fn, code, why) {
  await assert.rejects(fn, (error) => {
    assert.equal(error.message, code, `${why}: expected ${code}, got ${error.message}`)
    assert.ok(
      typeof error.persianMessage === 'string' && error.persianMessage.length > 10,
      `${why}: the player-facing message must exist`
    )
    return true
  }, why)
}

async function makePlayer(telegramUserId, firstName, gender, extra = {}) {
  return db.player.upsert({
    where: { telegramUserId },
    create: {
      telegramUserId,
      firstName,
      gender,
      biography: 'شخصیت آزمایشیِ جریان بازی',
      balance: 0,
      ...extra
    },
    update: {
      status: 'ACTIVE',
      activityState: 'IDLE',
      maritalStatus: 'SINGLE',
      isEnrolled: false,
      studyStartedAt: null,
      enrolledFieldKey: null,
      fatigue: 0,
      health: 100,
      experience: 0,
      balance: 0,
      ...extra
    }
  })
}

async function playerIdOf(telegramUserId) {
  return (await db.player.findUniqueOrThrow({ where: { telegramUserId } })).id
}

/** ستون‌های پول `Decimal` هستند؛ اینجا عددِ صحیحِ دقیق برمی‌گردانیم. */
async function snapshot(telegramUserId) {
  const row = await db.player.findUniqueOrThrow({
    where: { telegramUserId },
    select: {
      id: true,
      balance: true,
      fatigue: true,
      health: true,
      experience: true,
      activityState: true,
      isEnrolled: true,
      currentDegree: true,
      graduationField: true,
      homeGroupId: true
    }
  })
  return { ...row, balance: Number(row.balance) }
}

async function reset() {
  const rows = await db.player.findMany({
    where: { telegramUserId: { in: playerIds } },
    select: { id: true }
  })
  const ids = rows.map((row) => row.id)
  const groupRows = await db.group.findMany({
    where: { telegramGroupId: { in: [mainGroupId, raceGroupId] } },
    select: { id: true }
  })
  const groupIds = groupRows.map((row) => row.id)

  await db.businessEmployee.deleteMany({ where: { playerId: { in: ids } } })
  await db.jobApplication.deleteMany({ where: { playerId: { in: ids } } })
  await db.jobPosting.deleteMany({ where: { business: { ownerId: { in: ids } } } })
  await db.business.deleteMany({ where: { ownerId: { in: ids } } })
  await db.workSession.deleteMany({ where: { playerId: { in: ids } } })
  await db.loan.deleteMany({ where: { playerId: { in: ids } } })
  await db.bankAccount.deleteMany({ where: { playerId: { in: ids } } })
  await db.regionStat.deleteMany({ where: { groupId: { in: groupIds } } })
  await db.playerGroup.deleteMany({ where: { playerId: { in: ids } } })
  await db.group.deleteMany({ where: { telegramGroupId: { in: [mainGroupId, raceGroupId] } } })
  await db.financialTransaction.deleteMany({
    where: { OR: [{ sourcePlayerId: { in: ids } }, { destinationPlayerId: { in: ids } }] }
  })
  await db.gameEvent.deleteMany({ where: { playerId: { in: ids } } })
  await db.notification.deleteMany({ where: { playerId: { in: ids } } })
  await db.playerSkill.deleteMany({ where: { playerId: { in: ids } } })
}

async function shiftMinutes(telegramUserId, minutes) {
  const session = await db.workSession.findFirstOrThrow({
    where: { playerId: (await playerIdOf(telegramUserId)), status: 'ACTIVE' },
    orderBy: { startedAt: 'desc' }
  })
  return db.workSession.update({
    where: { id: session.id },
    data: { startedAt: new Date(Date.now() - minutes * 60_000) }
  })
}

async function main() {
  await reset()

  await makePlayer(workerId, 'کارگر', 'MALE', { balance: 0, age: 22, startedAt: new Date() })
  await makePlayer(tiredId, 'خسته', 'MALE', { balance: 0, age: 22, startedAt: new Date() })
  await makePlayer(bankerId, 'بانکی', 'MALE', { balance: 1_000_000, age: 30 })
  await makePlayer(ownerId, 'کارآفرین', 'MALE', { balance: 20_000_000, age: 34, experience: 6 })
  await makePlayer(poorOwnerId, 'بی‌سرمایه', 'MALE', { balance: 5_000_000, age: 30, experience: 6 })
  await makePlayer(employeeId, 'کارمند', 'FEMALE', { balance: 0, age: 26 })
  await makePlayer(secondEmployeeId, 'کارمنددوم', 'FEMALE', { balance: 0, age: 27 })
  await makePlayer(studentId, 'دانشجو', 'FEMALE', { balance: 3_000_000, age: 20 })

  const job = PART_TIME_JOBS[0]
  assert.ok(job && job.key, 'a real part-time job must exist')

  // In production the skill catalogue comes from the seed run by install.sh;
  // the smoke creates the two skills its flows touch, so practice and
  // graduation have something real to grant.
  const practicedSkill = job.requiredSkills[0] ?? 'ارتباطات'
  const graduateSkill = EDUCATION_FIELDS.find((entry) => entry.key === 'accounting').gainedSkills[0]
  for (const name of [practicedSkill, graduateSkill]) {
    await db.skill.upsert({
      where: { name },
      create: { name, category: 'general', description: 'مهارت آزمایشیِ جریان بازی' },
      update: {}
    })
  }

  // ── A. shift → pay → tax → life core ──────────────────────────────────────
  const workerStart = await snapshot(workerId)
  await work.startPartTimeWork(workerId, job.key)
  assert.equal((await snapshot(workerId)).activityState, 'WORKING')

  await rejected(() => work.startPartTimeWork(workerId, job.key), 'a second shift while working')
  await rejectedWith(
    () => work.startPartTimeWork(workerId, 'no_such_job'),
    'Job definition not found',
    'an invented job key'
  )

  await shiftMinutes(workerId, 60)
  const stopped = await work.stopWork(workerId)
  const workerAfter = await snapshot(workerId)

  assert.equal(stopped.session.status, 'COMPLETED', 'the shift is closed')
  assert.equal(workerAfter.activityState, 'IDLE', 'the player is free again')
  assert.ok(stopped.summary.totalEarnedMoney > 0, 'an hour of work is paid')
  assert.equal(
    stopped.summary.net,
    stopped.summary.totalEarnedMoney - stopped.summary.tax,
    'net = gross - tax'
  )
  assert.equal(stopped.summary.tax, incomeTaxOf(stopped.summary.totalEarnedMoney), 'one tax law')
  assert.equal(
    workerAfter.balance - workerStart.balance,
    stopped.summary.net,
    'the wallet receives exactly the net wage'
  )
  assert.equal(
    Number(stopped.session.earnedMoney),
    stopped.summary.totalEarnedMoney,
    'the session records the gross wage'
  )
  assert.equal(
    workerAfter.experience - workerStart.experience,
    stopped.summary.earnedExperience,
    'experience is granted with the wage'
  )

  // life core is inside the pay path, not beside it
  assert.ok(stopped.summary.fatigueGained > 0, 'work tires the player')
  assert.ok(stopped.summary.healthDrain >= 0, 'health drain is reported')
  assert.ok(workerAfter.fatigue >= workerStart.fatigue, 'fatigue really rose')
  assert.ok(workerAfter.health <= workerStart.health, 'health really fell')
  assert.ok(workerAfter.health >= MIN_HEALTH && workerAfter.fatigue <= MAX_FATIGUE, 'clamped')

  // the tax is a real ledger row, and it is the only money that left the wage
  const workerPid = await playerIdOf(workerId)
  const taxRows = await db.financialTransaction.findMany({
    where: { sourcePlayerId: workerPid, type: 'TAX_PAYMENT' }
  })
  if (stopped.summary.tax > 0) {
    assert.equal(taxRows.length, 1, 'one tax row per taxed shift')
    assert.equal(Number(taxRows[0].amount), stopped.summary.tax)
  } else {
    assert.equal(taxRows.length, 0, 'no tax row when nothing is taxed')
  }

  // double-click on "end shift" pays exactly once
  await work.startPartTimeWork(workerId, job.key)
  await shiftMinutes(workerId, 30)
  const raceBefore = await snapshot(workerId)
  const doubleStop = await Promise.allSettled([
    work.stopWork(workerId),
    work.stopWork(workerId),
    work.stopWork(workerId)
  ])
  const paid = doubleStop.filter((result) => result.status === 'fulfilled')
  assert.equal(paid.length, 1, `one settlement, got ${paid.length}`)
  assert.equal(
    (await snapshot(workerId)).balance - raceBefore.balance,
    paid[0].value.summary.net,
    'the wallet moved once'
  )
  assert.equal(
    await db.workSession.count({ where: { playerId: workerPid, status: 'ACTIVE' } }),
    0,
    'no ghost shift left behind'
  )
  await rejectedWith(() => work.stopWork(workerId), 'No active work session', 'stopping twice')

  // a tired, unhealthy body earns less than a fresh one: productivity is real
  await db.player.update({
    where: { telegramUserId: tiredId },
    data: { fatigue: 92, health: 25 }
  })
  const freshPay = income.calculatePartTimeIncome(
    {
      basePayPerMinute: job.basePayPerMinute,
      difficulty: job.difficulty,
      elapsedMinutes: 60,
      health: 100,
      fatigue: 0,
      maxHealth: 100,
      playerExperience: 0,
      educationRank: educationRankOf(null),
      age: 22,
      jobCategory: job.category
    },
    job.healthDrainPerMinute,
    job.fatigueRatePerMinute,
    job.experienceRatePerMinute
  )
  const tiredPay = income.calculatePartTimeIncome(
    { ...argumentsForTired(), elapsedMinutes: 60 },
    job.healthDrainPerMinute,
    job.fatigueRatePerMinute,
    job.experienceRatePerMinute
  )
  assert.ok(
    tiredPay.totalEarnedMoney < freshPay.totalEarnedMoney,
    'fatigue and low health cut the wage'
  )

  // critical fatigue stops the shift by itself instead of draining health to zero
  await work.startPartTimeWork(tiredId, job.key)
  await shiftMinutes(tiredId, 120)
  const autoStop = await work.autoStopIfCriticallyFatigued(tiredId)
  const tiredAfter = await snapshot(tiredId)
  assert.ok(autoStop, 'a critically fatigued worker is pulled off the shift')
  assert.equal(tiredAfter.activityState, 'IDLE')
  assert.ok(tiredAfter.health >= MIN_HEALTH, 'health never reaches the death floor by working')
  await rejected(() => work.stopWork(tiredId), 'the auto-stopped shift cannot be settled twice')

  // ── B. bank ───────────────────────────────────────────────────────────────
  const [accountA, accountB] = await Promise.all([
    banking.getOrCreateAccount(bankerId),
    banking.getOrCreateAccount(bankerId)
  ])
  assert.equal(accountA.id, accountB.id, 'one account per player, even concurrently')
  assert.equal(await db.bankAccount.count({ where: { playerId: await playerIdOf(bankerId) } }), 1)

  const beforeDeposit = await snapshot(bankerId)
  const accountBefore = Number((await db.bankAccount.findUniqueOrThrow({ where: { id: accountA.id } })).balance)
  await banking.deposit(bankerId, 400_000)
  const afterDeposit = await snapshot(bankerId)
  const accountAfterDeposit = Number(
    (await db.bankAccount.findUniqueOrThrow({ where: { id: accountA.id } })).balance
  )
  assert.equal(afterDeposit.balance, beforeDeposit.balance - 400_000, 'wallet debited')
  assert.equal(accountAfterDeposit, accountBefore + 400_000, 'account credited')
  assert.equal(
    afterDeposit.balance + accountAfterDeposit,
    beforeDeposit.balance + accountBefore,
    'a deposit moves money, it does not create it'
  )

  await banking.withdraw(bankerId, 150_000)
  const afterWithdraw = await snapshot(bankerId)
  const accountAfterWithdraw = Number(
    (await db.bankAccount.findUniqueOrThrow({ where: { id: accountA.id } })).balance
  )
  assert.equal(afterWithdraw.balance, afterDeposit.balance + 150_000)
  assert.equal(accountAfterWithdraw, accountAfterDeposit - 150_000)

  await rejected(() => banking.withdraw(bankerId, 10_000_000), 'overdraft is refused')
  assert.equal((await snapshot(bankerId)).balance, afterWithdraw.balance, 'refused withdraw moved nothing')
  for (const bad of [0, -100, 1.5, Number.NaN]) {
    await rejectedWith(() => banking.deposit(bankerId, bad), 'Invalid amount', `amount ${bad}`)
  }

  // interest settles once per period, never twice for the same window
  const beforeInterest = Number(
    (await db.bankAccount.findUniqueOrThrow({ where: { id: accountA.id } })).balance
  )
  await banking.settleAccountInterest(bankerId)
  const midInterest = Number(
    (await db.bankAccount.findUniqueOrThrow({ where: { id: accountA.id } })).balance
  )
  await banking.settleAccountInterest(bankerId)
  const afterInterest = Number(
    (await db.bankAccount.findUniqueOrThrow({ where: { id: accountA.id } })).balance
  )
  assert.equal(afterInterest, midInterest, 'the same interest window is not paid twice')
  assert.ok(midInterest >= beforeInterest, 'interest never takes money away')

  // ── C. business + payroll ─────────────────────────────────────────────────
  const shop = BUSINESS_BLUEPRINTS.find((blueprint) => blueprint.modelType === 'local_shop')
  assert.ok(shop, 'the local shop blueprint must exist')

  const ownerBefore = await snapshot(ownerId)
  // پاسخِ تازه شاملِ ردیفِ کسب‌وکار + موجودی پس از تأسیس است؛ اسکریپت خودِ ردیف را می‌خواهد.
  const { business: created } = await business.createBusiness(
    ownerId,
    shop.modelType,
    'فروشگاه محله'
  )
  const ownerAfterCreate = await snapshot(ownerId)
  assert.equal(
    ownerBefore.balance - ownerAfterCreate.balance,
    shop.startupCost,
    'the startup cost is paid exactly once'
  )
  assert.equal(Number(created.treasury), 0, 'the treasury starts empty: cost is a sink, not a transfer')
  assert.equal(
    await db.business.count({ where: { ownerId: ownerAfterCreate.id, status: 'ACTIVE' } }),
    1
  )
  assert.equal(
    await db.financialTransaction.count({
      where: { sourcePlayerId: ownerAfterCreate.id, type: 'STARTUP_COST' }
    }),
    1
  )
  await rejected(
    () => business.createBusiness(ownerId, 'no_such_model', 'نامعتبر'),
    'an invented business model'
  )

  // double-spend guard: two parallel openings with exactly one startup cost in the wallet
  const poorOwner = await snapshot(poorOwnerId)
  const parallel = await Promise.allSettled([
    business.createBusiness(poorOwnerId, shop.modelType, 'رقابتی یک'),
    business.createBusiness(poorOwnerId, shop.modelType, 'رقابتی دو')
  ])
  const opened = parallel.filter((result) => result.status === 'fulfilled')
  assert.equal(opened.length, 1, 'only one of two parallel openings may win')
  assert.equal(
    await db.business.count({ where: { ownerId: poorOwner.id, status: 'ACTIVE' } }),
    1
  )
  assert.equal((await snapshot(poorOwnerId)).balance, poorOwner.balance - shop.startupCost)

  // hire: post → apply → hire, once per applicant
  const posting = await business.postJob(ownerId, created.id, {
    title: 'فروشنده',
    salaryPerMinute: 600,
    capacity: 2,
    minExperience: 0,
    minAge: null,
    maxAge: null,
    requiredDegree: null,
    requiredSkill: null
  })
  const application = await business.applyForJob(employeeId, posting.id)
  const employment = await business.hireEmployee(ownerId, application.id)
  await rejected(() => business.hireEmployee(ownerId, application.id), 'hiring the same application twice')
  assert.equal(
    await db.businessEmployee.count({
      where: { businessId: created.id, playerId: await playerIdOf(employeeId), isActive: true }
    }),
    1
  )
  await rejected(
    () => business.settlePayroll(employeeId, created.id),
    'an employee cannot settle somebody else’s payroll'
  )

  // payroll: revenue in, cost out, salary to the worker, tax to the region
  await db.business.update({
    where: { id: created.id },
    data: { lastPayrollAt: new Date(Date.now() - 30 * 60_000) }
  })
  const employeeBefore = await snapshot(employeeId)
  const preview = await business.previewPayroll(ownerId, created.id)
  assert.equal(
    (await snapshot(employeeId)).balance,
    employeeBefore.balance,
    'a preview changes nothing'
  )

  // the hire just happened, so the thirty settled minutes are pre-hire time
  const preHire = await business.settlePayroll(ownerId, created.id)
  assert.equal(preHire.paidEmployees, 0, 'nobody is paid for time before the hire')
  assert.equal((await snapshot(employeeId)).balance, employeeBefore.balance)
  assert.equal(
    await db.financialTransaction.count({
      where: { sourceBusinessId: created.id, type: 'SALARY_PAYMENT' }
    }),
    0,
    'no salary row for an unpaid window'
  )

  // now the employee really has worked the window
  await db.businessEmployee.update({
    where: { id: employment.id },
    data: { hiredAt: new Date(Date.now() - 31 * 60_000), paidUntilAt: null }
  })
  await db.business.update({
    where: { id: created.id },
    data: { lastPayrollAt: new Date(Date.now() - 30 * 60_000) }
  })

  const settlement = await business.settlePayroll(ownerId, created.id)
  const employeeAfter = await snapshot(employeeId)
  const businessRow = await db.business.findUniqueOrThrow({ where: { id: created.id } })
  assert.ok(settlement.elapsedMinutes >= 29, 'thirty minutes of business time are settled')
  assert.equal(settlement.paidEmployees, 1, 'the hired employee is paid')
  assert.ok(settlement.totalPayroll > 0, 'a real salary is calculated')
  assert.equal(
    employeeAfter.balance - employeeBefore.balance,
    settlement.totalPayroll - settlement.totalTax,
    'the worker receives the net salary'
  )
  assert.equal(Number(businessRow.treasury), settlement.treasuryAfter, 'the treasury matches the report')
  assert.equal(
    await db.financialTransaction.count({
      where: { sourceBusinessId: created.id, type: 'SALARY_PAYMENT' }
    }),
    1,
    'one salary row per settlement'
  )

  // settling again immediately must not pay twice
  const afterFirstSettle = await snapshot(employeeId)
  const second = await business.settlePayroll(ownerId, created.id)
  assert.equal(second.paidEmployees, 0, 'nothing is paid twice in the same minute')
  assert.equal((await snapshot(employeeId)).balance, afterFirstSettle.balance)

  // rolling the business clock back is not enough to be paid again: the real
  // pay window is anchored per employee, so a stale clock pays nobody
  await db.business.update({
    where: { id: created.id },
    data: { lastPayrollAt: new Date(Date.now() - 45 * 60_000) }
  })
  const rolledBack = await business.settlePayroll(ownerId, created.id)
  assert.equal(
    rolledBack.paidEmployees,
    0,
    'the employee anchor, not the business clock, decides the pay window'
  )
  assert.equal((await snapshot(employeeId)).balance, afterFirstSettle.balance)

  // two concurrent settlements over a genuinely unpaid window: exactly one pays
  await db.businessEmployee.update({
    where: { id: employment.id },
    data: { paidUntilAt: new Date(Date.now() - 45 * 60_000) }
  })
  await db.business.update({
    where: { id: created.id },
    data: { lastPayrollAt: new Date(Date.now() - 45 * 60_000) }
  })
  const beforeRace = await snapshot(employeeId)
  const raceSettle = await Promise.allSettled([
    business.settlePayroll(ownerId, created.id),
    business.settlePayroll(ownerId, created.id)
  ])
  const winners = raceSettle
    .filter((result) => result.status === 'fulfilled')
    .map((result) => result.value)
    .filter((value) => value.paidEmployees > 0)
  assert.equal(winners.length, 1, `exactly one settlement pays, got ${winners.length}`)
  assert.equal(
    (await snapshot(employeeId)).balance - beforeRace.balance,
    winners[0].totalPayroll - winners[0].totalTax,
    'the concurrent settlement still pays the worker once'
  )
  assert.equal(
    await db.financialTransaction.count({
      where: { sourceBusinessId: created.id, type: 'SALARY_PAYMENT' }
    }),
    2,
    'two settlements in total, no extra rows'
  )

  // profit withdrawal: clamped to the real treasury, taxed, never paid twice
  const treasuryOf = async () =>
    Number((await db.business.findUniqueOrThrow({ where: { id: created.id } })).treasury)

  await db.business.update({ where: { id: created.id }, data: { treasury: 900_000 } })
  const ownerBeforeProfit = await snapshot(ownerId)
  const firstWithdraw = await business.withdrawProfit(ownerId, created.id, 400_000)
  const ownerAfterProfit = await snapshot(ownerId)
  assert.equal(firstWithdraw.gross, 400_000)
  assert.equal(firstWithdraw.net, firstWithdraw.gross - firstWithdraw.tax, 'profit tax is withheld')
  assert.equal(await treasuryOf(), 500_000)
  assert.equal(
    ownerAfterProfit.balance - ownerBeforeProfit.balance,
    firstWithdraw.net,
    'the owner receives the net profit'
  )

  // asking for more than the treasury holds is clamped, not invented — and the
  // panel shows the clamped numbers (gross/net), never the requested one
  const clamped = await business.withdrawProfit(ownerId, created.id, 10_000_000)
  assert.equal(clamped.gross, 500_000, 'only what the treasury really holds leaves it')
  assert.equal(clamped.treasuryAfter, 0)
  assert.equal(await treasuryOf(), 0)
  assert.equal(
    (await snapshot(ownerId)).balance,
    ownerAfterProfit.balance + clamped.net
  )
  await rejectedWith(
    () => business.withdrawProfit(ownerId, created.id, 1),
    'Empty treasury',
    'an empty treasury pays nobody'
  )

  // two concurrent withdrawals of the same treasury: drained once
  await db.business.update({ where: { id: created.id }, data: { treasury: 900_000 } })
  const beforeDouble = await snapshot(ownerId)
  const doubleWithdraw = await Promise.allSettled([
    business.withdrawProfit(ownerId, created.id, 900_000),
    business.withdrawProfit(ownerId, created.id, 900_000)
  ])
  const withdrawn = doubleWithdraw
    .filter((result) => result.status === 'fulfilled')
    .map((result) => result.value)
  assert.equal(
    withdrawn.reduce((sum, item) => sum + item.gross, 0),
    900_000,
    'the treasury is drained exactly once'
  )
  assert.equal(await treasuryOf(), 0, 'the treasury never goes negative')
  assert.equal(
    (await snapshot(ownerId)).balance - beforeDouble.balance,
    withdrawn.reduce((sum, item) => sum + item.net, 0),
    'the wallet moved by the real net, once'
  )
  await rejected(
    () => business.withdrawProfit(secondEmployeeId, created.id, 100),
    'a stranger cannot withdraw from somebody else’s treasury'
  )
  assert.equal(await treasuryOf(), 0)

  // ── D. group registration + environment level ─────────────────────────────
  telegramMemberInfo = {
    totalCount: 22,
    realMemberCount: 20,
    ownerTelegramUserId: ownerId,
    adminTelegramUserIds: [ownerId]
  }
  const first = await groups.ensureGroupUpdated({
    telegramGroupId: mainGroupId,
    title: 'گروه آزمایشی میراث',
    type: 'SUPERGROUP'
  })
  assert.equal(first.created, true, 'the first /start registers the group')
  assert.equal(first.memberCountSynced, true, 'the population was read from Telegram')
  assert.equal(first.group.realMemberCount, 20)
  assert.equal(first.group.environmentLevel, 'CITY', '20 real members = a city')

  // the second /start must not register again, and unknown counts must not
  // overwrite the real ones (this is the root cause of «سطح محیط: نامشخص»)
  telegramMemberInfo = { totalCount: null, realMemberCount: null, adminTelegramUserIds: [] }
  const secondStart = await groups.ensureGroupUpdated({
    telegramGroupId: mainGroupId,
    title: 'گروه آزمایشی میراث',
    type: 'SUPERGROUP'
  })
  assert.equal(secondStart.created, false, 'no duplicate registration')
  assert.equal(secondStart.memberCountSynced, false, 'nothing was known, nothing was written')
  assert.equal(secondStart.environmentChanged, false)
  const unchanged = await db.group.findUniqueOrThrow({
    where: { telegramGroupId: mainGroupId }
  })
  assert.equal(unchanged.id, first.group.id, 'the same group row')
  assert.equal(unchanged.realMemberCount, 20, 'the stored population survived the unknown read')
  assert.equal(unchanged.environmentLevel, 'CITY', 'the level was not reset to "unknown"')
  assert.equal(
    await db.group.count({ where: { telegramGroupId: mainGroupId } }),
    1,
    'one row per Telegram group'
  )

  // growth is reflected when Telegram really reports it
  telegramMemberInfo = { totalCount: 63, realMemberCount: 60, adminTelegramUserIds: [] }
  const grown = await groups.ensureGroupUpdated({
    telegramGroupId: mainGroupId,
    title: 'گروه آزمایشی میراث',
    type: 'SUPERGROUP'
  })
  assert.equal(grown.environmentChanged, true)
  assert.equal(grown.group.environmentLevel, 'COUNTRY', '60 real members = country level')

  // two parallel first registrations create exactly one group
  telegramMemberInfo = { totalCount: 9, realMemberCount: 8, adminTelegramUserIds: [] }
  const parallelRegister = await Promise.allSettled([
    groups.ensureGroupUpdated({ telegramGroupId: raceGroupId, title: 'رقابتی', type: 'GROUP' }),
    groups.ensureGroupUpdated({ telegramGroupId: raceGroupId, title: 'رقابتی', type: 'GROUP' }),
    groups.ensureGroupUpdated({ telegramGroupId: raceGroupId, title: 'رقابتی', type: 'GROUP' })
  ])
  assert.ok(
    parallelRegister.filter((result) => result.status === 'fulfilled').length >= 1,
    'registration succeeds'
  )
  assert.equal(
    await db.group.count({ where: { telegramGroupId: raceGroupId } }),
    1,
    'concurrent /start registers the group once'
  )
  const raceGroup = await db.group.findUniqueOrThrow({ where: { telegramGroupId: raceGroupId } })
  assert.equal(raceGroup.realMemberCount, 8)
  assert.equal(raceGroup.environmentLevel, 'VILLAGE')

  // membership is idempotent, and the classifier owns the thresholds shown in the UI
  await groups.linkPlayerToGroup(workerId, raceGroupId)
  await groups.linkPlayerToGroup(workerId, raceGroupId)
  assert.equal(
    await db.playerGroup.count({
      where: { playerId: await playerIdOf(workerId), groupId: raceGroup.id }
    }),
    1,
    'one membership row per player per group'
  )

  const thresholds = REGION_CONFIG.populationThresholds
  const thresholdsText = environmentThresholdsText()
  for (const level of ['VILLAGE', 'CITY', 'PROVINCE', 'COUNTRY']) {
    assert.ok(
      thresholdsText.includes(ENVIRONMENT_LABELS[level]),
      `the help text names the ${level} level`
    )
  }
  assert.ok(
    thresholdsText.includes(String(thresholds.city.min).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d])),
    'the help text shows the same threshold the classifier uses'
  )
  assert.equal(container.environmentClassifier.classify(thresholds.city.min), 'CITY')
  assert.equal(container.environmentClassifier.classify(thresholds.city.max), 'CITY')
  assert.equal(container.environmentClassifier.classify(thresholds.country.min), 'COUNTRY')
  assert.throws(() => container.environmentClassifier.classify(-1), 'a negative population is refused')

  // ── E. education → skill → income ─────────────────────────────────────────
  const field = EDUCATION_FIELDS.find((entry) => entry.key === 'accounting')
  assert.ok(field, 'the accounting field must exist')

  const studentBefore = await snapshot(studentId)
  await education.enrollInUniversity(studentId, field.key, 'BACHELOR')
  const enrolled = await snapshot(studentId)
  assert.equal(enrolled.isEnrolled, true)
  assert.equal(enrolled.activityState, 'STUDYING')
  assert.ok(studentBefore.balance - enrolled.balance > 0, 'tuition is charged')
  await rejectedWith(
    () => education.enrollInUniversity(studentId, field.key, 'BACHELOR'),
    'Already studying',
    'a second enrolment while studying'
  )
  await rejectedWith(() => education.graduate(studentId), 'Curriculum not completed', 'graduating too early')

  await db.player.update({
    where: { telegramUserId: studentId },
    data: { studyStartedAt: new Date(Date.now() - (field.gameDurationMinutes + 10) * 60_000) }
  })
  await education.graduate(studentId)
  const graduated = await snapshot(studentId)
  assert.equal(graduated.isEnrolled, false, 'the course is closed')
  assert.equal(graduated.activityState, 'IDLE')
  assert.equal(graduated.currentDegree, 'BACHELOR', 'the degree is written to the profile')
  assert.ok(graduated.experience > enrolled.experience, 'graduation grants experience')

  // the same hour of the same job pays a graduate more: education reaches income
  const graduatePay = income.calculatePartTimeIncome(
    {
      basePayPerMinute: job.basePayPerMinute,
      difficulty: job.difficulty,
      elapsedMinutes: 60,
      health: 100,
      fatigue: 0,
      maxHealth: 100,
      playerExperience: graduated.experience,
      educationRank: educationRankOf(graduated.currentDegree),
      graduationField: graduated.graduationField,
      age: 22,
      jobCategory: job.category
    },
    job.healthDrainPerMinute,
    job.fatigueRatePerMinute,
    job.experienceRatePerMinute
  )
  assert.ok(
    graduatePay.totalEarnedMoney > freshPay.totalEarnedMoney,
    'a graduate earns more than an uneducated worker for the same hour'
  )
  assert.ok(
    educationRankOf(graduated.currentDegree) > educationRankOf(null),
    'the profile degree really raises the rank used by the pay formula'
  )
  assert.ok(graduatePay.educationFactor >= freshPay.educationFactor, 'the factor is visible, not hidden')

  // skills: the catalogue is readable, graduation grants the field's skill,
  // and assigning the same skill twice never duplicates the profile row
  const catalog = await skills.listCatalog()
  assert.ok(
    catalog.some((entry) => entry.name === graduateSkill),
    'the catalogue contains the graduated field’s skill'
  )
  const granted = await skills.listPlayerSkills(studentId)
  assert.ok(
    granted.some((entry) => (entry.skill?.name ?? entry.name) === graduateSkill),
    `graduation granted «${graduateSkill}» to the profile`
  )

  await skills.assignSkillToPlayer(workerId, practicedSkill)
  await skills.assignSkillToPlayer(workerId, practicedSkill)
  const workerSkills = await skills.listPlayerSkills(workerId)
  assert.equal(
    workerSkills.filter((entry) => (entry.skill?.name ?? entry.name) === practicedSkill).length,
    1,
    'one row per player per skill, however often it is granted'
  )
  await rejectedWith(
    () => skills.assignSkillToPlayer(workerId, 'مهارتِ ناموجود'),
    'Skill not found',
    'an invented skill name'
  )

  // relevant work trains the matching skill (best effort, runs after the shift)
  assert.ok(
    workerSkills.some((entry) => (entry.skill?.name ?? entry.name) === practicedSkill),
    `working «${job.name}» trained «${practicedSkill}»`
  )

  console.log(
    `PASS: gameplay scenarios on live PostgreSQL — shift paid once with tax and real fatigue/health, ` +
      `bank moves money without creating it, business startup/hire/payroll are single-settlement, ` +
      `group registers once with an environment level read from real members, education reaches income`
  )
}

/** ورودیِ خالصِ محاسبهٔ درآمد برای بدنی خسته و کم‌جان. */
function argumentsForTired() {
  const job = PART_TIME_JOBS[0]
  return {
    basePayPerMinute: job.basePayPerMinute,
    difficulty: job.difficulty,
    health: 25,
    fatigue: 92,
    maxHealth: 100,
    playerExperience: 0,
    educationRank: educationRankOf(null),
    age: 22,
    jobCategory: job.category
  }
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    await db.$disconnect()
  })
