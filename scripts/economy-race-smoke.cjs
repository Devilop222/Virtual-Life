/* Run only against a disposable migrated database named *_ux_test.
 * Requires build first (dist/). Concurrency harness for the money paths a
 * player reaches with a button: every claim is fired several times in parallel
 * and must pay exactly once, and whatever leaves a vault must arrive in a
 * wallet. This is the class of bug that mocks cannot show — the double-tap.
 *
 *   · gym membership   : paid weeks must equal granted weeks
 *   · matured deposit  : the bank pool may only lose what the player receives
 *   · daily streak     : one reward per day under a burst of clicks
 *   · farm harvest     : one harvest per plot under a burst of clicks
 *   · referral bonus   : claim and payment share one transaction
 *   · bank interest    : the pool only loses what the account receives
 *   · daily fortune    : the stored outcome and the wallet agree, exactly once
 *
 * DATABASE_URL=postgresql://.../legacy_ux_test node scripts/economy-race-smoke.cjs
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
const { GYM_WEEKLY_FEE } = require('../dist/modules/gym/gym.service')
const { BANK_POOL_ID } = require('../dist/config/economy')
const { BankPoolService } = require('../dist/modules/banking/bank-pool.service')

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) })
const bankPool = new BankPoolService()
const container = buildContainer({
  getMemberInfo: async () => {
    throw new Error('economy race smoke never touches Telegram')
  }
})

const gym = container.gymService
const deposits = container.depositService
const rewards = container.rewardsService
const farm = container.farmService
const banking = container.bankingService
const fortune = container.fortuneService
const { ConflictError } = require('../dist/utils/classes/errors')

const gymPlayerId = 9400000501n
const depositorId = 9400000502n
const streakPlayerId = 9400000503n
const farmerId = 9400000504n
const referrerId = 9400000505n
const refereeId = 9400000506n
const saverId = 9400000507n
const luckyId = 9400000508n

const ids = [
  gymPlayerId,
  depositorId,
  streakPlayerId,
  farmerId,
  referrerId,
  refereeId,
  saverId,
  luckyId
]

const MEMBERSHIP_DAYS = 7
const DAY_MS = 24 * 60 * 60 * 1000

async function makePlayer(telegramUserId, firstName, extra = {}) {
  return db.player.upsert({
    where: { telegramUserId },
    create: {
      telegramUserId,
      firstName,
      gender: 'MALE',
      biography: 'شخصیت آزمایشیِ رقابتِ اقتصادی',
      balance: 0,
      ...extra
    },
    update: {
      status: 'ACTIVE',
      activityState: 'IDLE',
      balance: 0,
      lastStreakAt: null,
      streakCount: 0,
      ...extra
    }
  })
}

async function playerIdOf(telegramUserId) {
  return (await db.player.findUniqueOrThrow({ where: { telegramUserId } })).id
}

/** ستون‌های پول `Decimal` هستند؛ عددِ صحیحِ دقیق برمی‌گردانیم. */
async function balanceOf(telegramUserId) {
  const row = await db.player.findUniqueOrThrow({
    where: { telegramUserId },
    select: { balance: true }
  })
  return Number(row.balance)
}

async function poolBalance() {
  const row = await db.bankPool.findUnique({ where: { id: BANK_POOL_ID } })
  return row ? Number(row.balance) : 0
}

/** شمارندهٔ ترازنامهٔ صندوق (مثل `totalDepositInterest`). */
async function poolCounter(field) {
  const row = await db.bankPool.findUnique({ where: { id: BANK_POOL_ID } })
  return row ? Number(row[field]) : 0
}

/**
 * صندوق بانک را از مسیرِ واقعیِ محصول نقد می‌کنیم (`creditDeposit`)، نه با نوشتنِ
 * مستقیمِ `balance`: این‌طور ترازنامهٔ صندوق (رابطهٔ `balance` با شمارنده‌ها)
 * هم‌خوان می‌ماند و ممیزِ `economy-invariants-smoke` می‌تواند همان رابطه را روی
 * دیتابیسِ آزمایشی هم مطالبه کند.
 */
async function fundPool(target) {
  const missing = target - (await poolBalance())
  if (missing <= 0) return
  await db.$transaction(async (tx) => {
    await bankPool.creditDeposit(tx, missing)
  })
}

function winners(results) {
  return results.filter((result) => result.status === 'fulfilled').map((result) => result.value)
}

async function reset() {
  const rows = await db.player.findMany({
    where: { telegramUserId: { in: ids } },
    select: { id: true }
  })
  const playerIds = rows.map((row) => row.id)

  await db.gymMembership.deleteMany({ where: { playerId: { in: playerIds } } })
  await db.termDeposit.deleteMany({ where: { playerId: { in: playerIds } } })
  await db.farmPlot.deleteMany({ where: { playerId: { in: playerIds } } })
  await db.dailyQuest.deleteMany({ where: { playerId: { in: playerIds } } })
  await db.referral.deleteMany({
    where: { OR: [{ referrerPlayerId: { in: playerIds } }, { refereePlayerId: { in: playerIds } }] }
  })
  await db.weeklyChest.deleteMany({ where: { playerId: { in: playerIds } } })
  await db.dailyFortune.deleteMany({ where: { playerId: { in: playerIds } } })
  await db.bankAccount.deleteMany({ where: { playerId: { in: playerIds } } })
  await db.financialTransaction.deleteMany({
    where: { OR: [{ sourcePlayerId: { in: playerIds } }, { destinationPlayerId: { in: playerIds } }] }
  })
  await db.gameEvent.deleteMany({ where: { playerId: { in: playerIds } } })
  await db.notification.deleteMany({ where: { playerId: { in: playerIds } } })
  await db.bankPool.deleteMany({ where: { id: BANK_POOL_ID } })
}

async function main() {
  await reset()
  await makePlayer(gymPlayerId, 'باشگاهی', { balance: 3 * GYM_WEEKLY_FEE })
  await makePlayer(depositorId, 'سپرده‌گذار')
  await makePlayer(streakPlayerId, 'پاداش‌بگیر')
  await makePlayer(farmerId, 'کشاورز')
  await makePlayer(referrerId, 'معرف')
  await makePlayer(refereeId, 'معرفی‌شده')
  await makePlayer(saverId, 'سپرده‌گذارِ بانک')
  await makePlayer(luckyId, 'خوش‌شانس', { balance: 1_000_000 })

  // ── 1. gym membership: paid weeks must equal granted weeks ────────────────
  const gymBefore = await balanceOf(gymPlayerId)
  const startedAt = Date.now()
  const gymResults = await Promise.allSettled([
    gym.subscribe(gymPlayerId),
    gym.subscribe(gymPlayerId),
    gym.subscribe(gymPlayerId)
  ])
  const subscribed = winners(gymResults)
  const gymAfter = await balanceOf(gymPlayerId)
  const gymPid = await playerIdOf(gymPlayerId)

  const chargedWeeks = (gymBefore - gymAfter) / GYM_WEEKLY_FEE
  assert.equal(
    chargedWeeks,
    subscribed.length,
    'every successful subscription is charged exactly one weekly fee'
  )

  const memberships = await db.gymMembership.findMany({
    where: { playerId: gymPid },
    orderBy: { expiresAt: 'desc' }
  })
  const latestExpiry = memberships[0].expiresAt.getTime()
  const grantedDays = (latestExpiry - startedAt) / DAY_MS
  assert.ok(
    Math.abs(grantedDays - subscribed.length * MEMBERSHIP_DAYS) < 0.5,
    `paid for ${subscribed.length} week(s) but the membership only covers ${grantedDays.toFixed(2)} day(s)`
  )

  const feeRows = await db.financialTransaction.findMany({
    where: { sourcePlayerId: gymPid, type: 'GYM_FEE' }
  })
  assert.equal(feeRows.length, subscribed.length, 'one ledger row per paid week')

  // ── 2. matured deposit: the pool may only lose what the player receives ───
  const depositorPid = await playerIdOf(depositorId)
  const principal = 5_000_000
  const deposit = await db.termDeposit.create({
    data: {
      playerId: depositorPid,
      principal,
      rateAnnual: 0.2,
      termDays: 30,
      maturesAt: new Date(Date.now() - 60 * 60 * 1000),
      status: 'ACTIVE'
    }
  })

  // the pool is the real source of deposit money; give it liquidity up front so
  // the race is about settlement, not about an empty vault
  await fundPool(500_000_000)
  const poolBefore = await poolBalance()
  const playerBefore = await balanceOf(depositorId)

  const settleResults = await Promise.allSettled([
    deposits.settleMatured(depositorPid),
    deposits.settleMatured(depositorPid),
    deposits.settleMatured(depositorPid)
  ])
  const settled = winners(settleResults).reduce((sum, r) => sum + r.settled, 0)
  const deferred = winners(settleResults).reduce((sum, r) => sum + r.deferred, 0)
  assert.equal(deferred, 0, `nothing defers when the pool is funded, got ${deferred}`)
  const poolAfter = await poolBalance()
  const playerAfter = await balanceOf(depositorId)
  const settledRow = await db.termDeposit.findUniqueOrThrow({ where: { id: deposit.id } })

  assert.equal(settledRow.status, 'PAID', 'the deposit is closed')
  assert.equal(settled, 1, `the deposit settles once, got ${settled}`)
  const payout = Number(settledRow.payout)
  assert.ok(payout > principal, 'interest is part of the payout')
  assert.equal(playerAfter - playerBefore, payout, 'the player receives the recorded payout')
  assert.equal(
    poolBefore - poolAfter,
    playerAfter - playerBefore,
    'whatever left the bank pool reached the player — nothing is burned'
  )

  // ── 3. daily streak: one reward per day under a burst of clicks ───────────
  const streakBefore = await balanceOf(streakPlayerId)
  const streakResults = await Promise.allSettled([
    rewards.claimDailyStreak(streakPlayerId),
    rewards.claimDailyStreak(streakPlayerId),
    rewards.claimDailyStreak(streakPlayerId),
    rewards.claimDailyStreak(streakPlayerId),
    rewards.claimDailyStreak(streakPlayerId)
  ])
  const claimed = winners(streakResults)
  const streakAfter = await balanceOf(streakPlayerId)
  assert.equal(claimed.length, 1, `one streak reward per day, got ${claimed.length}`)
  assert.equal(streakAfter - streakBefore, claimed[0].reward, 'the wallet moved once')
  assert.equal(
    await db.financialTransaction.count({
      where: { destinationPlayerId: await playerIdOf(streakPlayerId), type: 'REWARD_PAYOUT' }
    }),
    1,
    'one reward row in the ledger'
  )

  // ── 4. farm harvest: one harvest per plot under a burst of clicks ─────────
  const farmerPid = await playerIdOf(farmerId)
  const plot = await db.farmPlot.create({
    data: {
      playerId: farmerPid,
      seedKey: 'wheat',
      seedName: 'گندم',
      cost: 100_000,
      expectedHarvest: 350_000,
      readyAt: new Date(Date.now() - 60 * 1000),
      isHarvested: false
    }
  })
  const farmBefore = await balanceOf(farmerId)
  const harvestResults = await Promise.allSettled([
    farm.harvest(farmerId, plot.id),
    farm.harvest(farmerId, plot.id),
    farm.harvest(farmerId, plot.id),
    farm.harvest(farmerId, plot.id)
  ])
  const harvested = winners(harvestResults)
  const farmAfter = await balanceOf(farmerId)
  assert.equal(harvested.length, 1, `one harvest per plot, got ${harvested.length}`)
  assert.equal(farmAfter - farmBefore, 350_000, 'the harvest is paid once')
  assert.equal(
    (await db.farmPlot.findUniqueOrThrow({ where: { id: plot.id } })).isHarvested,
    true
  )
  assert.equal(
    await db.financialTransaction.count({
      where: { destinationPlayerId: farmerPid, type: 'FARM_HARVEST' }
    }),
    1,
    'one harvest row in the ledger'
  )

  // ── 5. referral residence bonus: claim and payment are one transaction ────
  const referrerPid = await playerIdOf(referrerId)
  const refereePid = await playerIdOf(refereeId)
  await db.referral.create({
    data: {
      referrerPlayerId: referrerPid,
      refereePlayerId: refereePid,
      rewardedAt: new Date(Date.now() - DAY_MS),
      bonusPaidAt: null
    }
  })
  const referrerBefore = await balanceOf(referrerId)
  const bonusResults = await Promise.allSettled([
    rewards.settleReferralResidenceBonus(refereePid),
    rewards.settleReferralResidenceBonus(refereePid),
    rewards.settleReferralResidenceBonus(refereePid)
  ])
  assert.equal(
    bonusResults.filter((result) => result.status === 'rejected').length,
    0,
    'the residence bonus never surfaces an error to the caller'
  )
  const bonusRows = await db.financialTransaction.findMany({
    where: { destinationPlayerId: referrerPid, type: 'REWARD_PAYOUT' }
  })
  assert.equal(bonusRows.length, 1, 'one bonus row for three parallel settlements')
  assert.equal(Number(bonusRows[0].amount), 500_000)
  assert.equal(
    (await balanceOf(referrerId)) - referrerBefore,
    500_000,
    'the referrer is paid exactly once'
  )
  assert.ok(
    (await db.referral.findUniqueOrThrow({ where: { refereePlayerId: refereePid } })).bonusPaidAt,
    'the claim is recorded'
  )

  // ── 6. bank interest: the pool only loses what the account receives ───────
  const saverPid = await playerIdOf(saverId)
  const fiveDaysAgo = new Date(Date.now() - 5 * DAY_MS)
  await db.bankAccount.upsert({
    where: { playerId: saverPid },
    create: {
      playerId: saverPid,
      cardNumber: '6037991100000507',
      balance: 20_000_000,
      lastInterestAt: fiveDaysAgo,
      status: 'ACTIVE'
    },
    update: { balance: 20_000_000, lastInterestAt: fiveDaysAgo, status: 'ACTIVE' }
  })
  const poolBeforeInterest = await poolBalance()
  const interestCounterBefore = await poolCounter('totalDepositInterest')
  const accountBefore = Number(
    (await db.bankAccount.findUniqueOrThrow({ where: { playerId: saverPid } })).balance
  )

  const interestResults = await Promise.allSettled([
    banking.settleAccountInterest(saverId),
    banking.settleAccountInterest(saverId),
    banking.settleAccountInterest(saverId)
  ])
  assert.equal(
    interestResults.filter((result) => result.status === 'rejected').length,
    0,
    `a lost interest race must not surface an error: ${interestResults
      .filter((result) => result.status === 'rejected')
      .map((result) => result.reason && result.reason.message)
      .join(', ')}`
  )
  const reportedInterest = winners(interestResults).reduce(
    (sum, result) => sum + result.interestAccrued,
    0
  )
  const accountRow = await db.bankAccount.findUniqueOrThrow({ where: { playerId: saverPid } })
  const accountAfter = Number(accountRow.balance)
  const poolAfterInterest = await poolBalance()
  const interestRows = await db.financialTransaction.findMany({
    where: { destinationPlayerId: saverPid, type: 'DEPOSIT_INTEREST' }
  })

  assert.ok(reportedInterest > 0, 'five days of interest is really paid')
  assert.equal(interestRows.length, 1, 'one interest ledger row for three parallel settlements')
  assert.equal(
    accountAfter - accountBefore,
    reportedInterest,
    'the account gains exactly what the settlements report'
  )
  assert.equal(
    poolBeforeInterest - poolAfterInterest,
    accountAfter - accountBefore,
    'the bank pool only loses what the account receives — a lost race must roll its debit back'
  )
  assert.equal(
    Math.round((accountRow.lastInterestAt.getTime() - fiveDaysAgo.getTime()) / DAY_MS),
    5,
    'the interest clock advances exactly once, by the days actually settled'
  )
  assert.equal(
    (await poolCounter('totalDepositInterest')) - interestCounterBefore,
    reportedInterest,
    'the pool interest counter only moves for interest that was really paid — ' +
      'the losing races must not inflate it'
  )

  // ── 7. daily fortune: the stored outcome and the wallet agree, once ───────
  const luckyPid = await playerIdOf(luckyId)
  const luckyBefore = await balanceOf(luckyId)

  const fortuneResults = await Promise.allSettled([
    fortune.draw(luckyId),
    fortune.draw(luckyId),
    fortune.draw(luckyId)
  ])
  const drawn = winners(fortuneResults)
  const losers = fortuneResults.filter((result) => result.status === 'rejected')
  assert.equal(drawn.length, 1, `exactly one draw wins the day, got ${drawn.length}`)
  assert.equal(losers.length, 2, 'the other two are turned away')
  assert.ok(
    losers.every((result) => result.reason instanceof ConflictError),
    'the turned-away draws get the ordinary "already drawn" conflict, not a crash'
  )

  const fortuneRows = await db.dailyFortune.findMany({ where: { playerId: luckyPid } })
  assert.equal(fortuneRows.length, 1, 'one fortune row for the day')
  const stored = fortuneRows[0]
  const expectedDelta = stored.kind === 'loss' ? -Number(stored.amount) : Number(stored.amount)
  assert.equal(
    drawn[0].kind,
    stored.kind,
    'the outcome shown to the player is the one that was stored'
  )
  assert.equal(
    (await balanceOf(luckyId)) - luckyBefore,
    expectedDelta,
    'the wallet moved exactly as the stored outcome says — the losing draws rolled back'
  )
  const fortuneLedger = await db.financialTransaction.findMany({
    where: {
      reference: { in: ['شانس روزانه', 'هزینهٔ پیش‌بینی‌نشدهٔ روز'] },
      OR: [{ sourcePlayerId: luckyPid }, { destinationPlayerId: luckyPid }]
    }
  })
  assert.equal(
    fortuneLedger.length,
    expectedDelta === 0 ? 0 : 1,
    'one ledger row when money moved, none when the day had no effect'
  )

  console.log(
    'PASS: economy races on live PostgreSQL — gym weeks paid equal weeks granted, ' +
      'the bank pool only loses what players receive, and the daily streak, farm harvest, ' +
      'referral bonus, bank interest and daily fortune each pay exactly once under a burst ' +
      'of clicks'
  )
}

main()
  .catch((error) => {
    console.error(error.message ?? error)
    process.exitCode = 1
  })
  .finally(async () => {
    await db.$disconnect()
  })
