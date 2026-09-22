/* Economic coherence audit on live PostgreSQL.
 * Requires build first (dist/) and a disposable migrated database named *_ux_test.
 *
 * The other harnesses ask "does this button pay exactly once?". This one asks the
 * question the whole economy is judged by: after a player lives a normal day —
 * gets paid, banks, saves, buys, trades, joins the gym, draws the daily fortune —
 * does the money still add up?
 *
 * It runs a real session through the product's own services (no rows written by
 * hand except the two clock changes a lazy settlement needs), then audits the
 * result with the pure functions in src/modules/economy/money-supply.ts, which
 * exist for exactly this and are otherwise only unit-tested:
 *
 *   · the bank's balance sheet is a closed account (auditBankPool)
 *   · every player's private money reconciles with the ledger to the rial
 *   · the pool counters move exactly as much as the ledger says they should
 *   · no ledger row is ownerless, none has a non-positive amount
 *   · no vault anywhere in the database is negative
 *   · statuses and timestamps agree (settled deposits, repaid loans, sold listings)
 *
 * DATABASE_URL=postgresql://.../legacy_ux_test node scripts/economy-invariants-smoke.cjs
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
const { BANK_POOL_ID, BANK_POOL_SEED } = require('../dist/config/economy')
const { DEPOSIT_PLANS } = require('../dist/modules/banking/deposit.service')
const {
  auditBankPool,
  findSharedEntries,
  isInternalPrivateMove,
  moneyInExistence,
  moneySupply,
  publicSectorFlow,
  reconcilePrivateSector,
  toAmount
} = require('../dist/modules/economy/money-supply')

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) })
const container = buildContainer({
  getMemberInfo: async () => {
    throw new Error('the invariants smoke never touches Telegram')
  }
})

const admin = container.adminService
const banking = container.bankingService
const deposits = container.depositService
const gym = container.gymService
const rewards = container.rewardsService
const fortune = container.fortuneService
const shop = container.shopService
const trade = container.tradeService

/** ادمین اصلیِ ثابت (مطابق پیکربندی) — بودجهٔ بازیکنان از مسیرِ واقعیِ پنل می‌آید. */
const OWNER = 6910416744n
const alice = 9400000801n
const bob = 9400000802n
const carol = 9400000803n
const cast = [alice, bob, carol]

const START_GRANT = 20_000_000
const DAY_MS = 24 * 60 * 60 * 1000

async function playerIdOf(telegramUserId) {
  return (await db.player.findUniqueOrThrow({ where: { telegramUserId } })).id
}

async function makePlayer(telegramUserId, firstName) {
  return db.player.create({
    data: {
      telegramUserId,
      firstName,
      gender: 'MALE',
      biography: 'شخصیت ممیزیِ هم‌خوانیِ اقتصاد',
      balance: 0
    }
  })
}

/** پاک‌سازیِ کاملِ بازیکنانِ این آزمون، تا آشتی از صفرِ مطلق شروع شود. */
async function reset() {
  const rows = await db.player.findMany({
    where: { telegramUserId: { in: cast } },
    select: { id: true }
  })
  const playerIds = rows.map((row) => row.id)
  if (playerIds.length === 0) return

  await db.financialTransaction.deleteMany({
    where: { OR: [{ sourcePlayerId: { in: playerIds } }, { destinationPlayerId: { in: playerIds } }] }
  })
  for (const [delegate, field] of [
    ['marketListing', 'sellerPlayerId'],
    ['playerInventory', 'playerId'],
    ['termDeposit', 'playerId'],
    ['bankAccount', 'playerId'],
    ['gymMembership', 'playerId'],
    ['weeklyChest', 'playerId'],
    ['dailyFortune', 'playerId'],
    ['dailyQuest', 'playerId'],
    ['loan', 'playerId'],
    ['gameEvent', 'playerId'],
    ['notification', 'playerId']
  ]) {
    await db[delegate].deleteMany({ where: { [field]: { in: playerIds } } })
  }
  await db.player.deleteMany({ where: { id: { in: playerIds } } })
}

async function poolSnapshot() {
  const row = await db.bankPool.findUnique({ where: { id: BANK_POOL_ID } })
  if (!row) return null
  return {
    balance: toAmount(row.balance),
    totalDeposited: toAmount(row.totalDeposited),
    totalDisbursed: toAmount(row.totalDisbursed),
    totalRepaid: toAmount(row.totalRepaid),
    totalLoanInterest: toAmount(row.totalLoanInterest),
    totalDepositInterest: toAmount(row.totalDepositInterest)
  }
}

/** هر ردیف دفتر کل که به یکی از بازیکنانِ این آزمون مربوط است. */
async function sessionLedger(playerIds) {
  return db.financialTransaction.findMany({
    where: { OR: [{ sourcePlayerId: { in: playerIds } }, { destinationPlayerId: { in: playerIds } }] }
  })
}

function sumByType(rows, types) {
  return rows
    .filter((row) => types.includes(row.type))
    .reduce((sum, row) => sum + toAmount(row.amount), 0)
}

async function assertNoNegativeVaults() {
  const checks = {
    'player wallets': await db.player.count({ where: { balance: { lt: 0 } } }),
    'bank accounts': await db.bankAccount.count({ where: { balance: { lt: 0 } } }),
    'business treasuries': await db.business.count({ where: { treasury: { lt: 0 } } }),
    'loan balances': await db.loan.count({ where: { remainingAmount: { lt: 0 } } }),
    'unpaid salaries': await db.businessEmployee.count({ where: { unpaidSalary: { lt: 0 } } }),
    'inventories': await db.playerInventory.count({ where: { quantity: { lt: 0 } } }),
    'region projects': await db.regionProject.count({ where: { collectedAmount: { lt: 0 } } }),
    'term deposit principals': await db.termDeposit.count({ where: { principal: { lte: 0 } } }),
    'weekly chests': await db.weeklyChest.count({ where: { amount: { lte: 0 } } }),
    'ledger amounts': await db.financialTransaction.count({ where: { amount: { lte: 0 } } })
  }
  const pool = await poolSnapshot()
  if (pool) {
    for (const [field, value] of Object.entries(pool)) {
      checks[`bank pool ${field}`] = value < 0 ? 1 : 0
    }
  }
  for (const [label, count] of Object.entries(checks)) {
    assert.equal(count, 0, `${label} must never be negative — found ${count}`)
  }
}

async function assertStatusCoherence() {
  const unsettled = await db.termDeposit.count({
    where: {
      OR: [
        { status: { in: ['PAID', 'BROKEN'] }, payout: null },
        { status: { in: ['PAID', 'BROKEN'] }, settledAt: null },
        { status: 'ACTIVE', settledAt: { not: null } }
      ]
    }
  })
  assert.equal(unsettled, 0, 'a settled deposit records its payout and the moment it settled')

  const badLoans = await db.loan.count({
    where: {
      OR: [
        { status: 'PAID', remainingAmount: { not: 0 } },
        { status: 'ACTIVE', remainingAmount: { lte: 0 } }
      ]
    }
  })
  assert.equal(badLoans, 0, 'a repaid loan has no remaining debt and an active one still owes')

  const badListings = await db.marketListing.count({
    where: { status: 'SOLD', soldAt: null }
  })
  assert.equal(badListings, 0, 'a sold listing records when it was sold')

  const futureClocks = await db.bankAccount.count({ where: { lastInterestAt: { gt: new Date() } } })
  assert.equal(futureClocks, 0, 'no interest clock runs ahead of today')

  const unpaidMahr = await db.marriage.count({ where: { mahr: { lte: 0 } } })
  assert.equal(unpaidMahr, 0, 'a marriage always has a mahr above zero')
}

async function main() {
  await reset()
  await admin.bootstrap()

  const poolBefore = (await poolSnapshot()) ?? {
    balance: BANK_POOL_SEED,
    totalDeposited: 0,
    totalDisbursed: 0,
    totalRepaid: 0,
    totalLoanInterest: 0,
    totalDepositInterest: 0
  }

  const [aliceRow, bobRow, carolRow] = [
    await makePlayer(alice, 'آلیس'),
    await makePlayer(bob, 'باب'),
    await makePlayer(carol, 'کارول')
  ]

  // ── a normal day, entirely through the product's own services ─────────────
  for (const who of cast) {
    // بودجه از مسیرِ واقعیِ پنل ادمین می‌آید تا خودش ردیف دفتر کل بگذارد؛
    // موجودیِ دستیِ بی‌ردیف، آشتی را الکی خراب می‌کرد.
    await admin.adjustBalance(OWNER, who, START_GRANT)
  }

  // Alice: bank account, deposit, five days of interest, gym, streak, fortune
  await banking.getOrCreateAccount(alice)
  await banking.deposit(alice, 5_000_000)
  await db.bankAccount.updateMany({
    where: { playerId: aliceRow.id },
    data: { lastInterestAt: new Date(Date.now() - 5 * DAY_MS) }
  })
  const interest = await banking.settleAccountInterest(alice)
  assert.ok(interest.interestAccrued > 0, 'five days of account interest is paid')
  await gym.subscribe(alice)
  await rewards.claimDailyStreak(alice)
  const drawn = await fortune.draw(alice)

  // Bob: buys an item from the city shop, then sells one unit to Alice
  await shop.ensureSeeded()
  const catalog = await shop.getCatalog(undefined, bob)
  const affordable = catalog.find(
    (item) => item.currentPrice > 0 && item.currentPrice < START_GRANT && item.stock > 0
  )
  assert.ok(affordable, `the shop has something Bob can afford (catalog: ${catalog.length} items)`)
  await shop.buyItem(bob, affordable.key)
  const stock = await db.playerInventory.findFirstOrThrow({
    where: { playerId: bobRow.id, quantity: { gt: 0 } }
  })
  const listing = await trade.createListing(bob, stock.id, 1, 40_000)
  await trade.buyListing(alice, listing.listingId)

  // Carol: locks money in a term deposit, then the deposit matures
  const plan = DEPOSIT_PLANS[0]
  await deposits.open(carol, plan.key, 2_000_000)
  await db.termDeposit.updateMany({
    where: { playerId: carolRow.id, status: 'ACTIVE' },
    data: { maturesAt: new Date(Date.now() - 60 * 60 * 1000) }
  })
  const { settled: settledCount, deferred } = await deposits.settleMatured(carolRow.id)
  assert.equal(settledCount, 1, 'the matured deposit settles')
  assert.equal(deferred, 0, 'nothing defers when the pool is funded')

  // ── the audit ─────────────────────────────────────────────────────────────
  const playerIds = [aliceRow.id, bobRow.id, carolRow.id]
  const rows = await sessionLedger(playerIds)
  assert.ok(rows.length >= 10, `the session produced a real ledger (${rows.length} rows)`)

  // 1. the bank's balance sheet is a closed account
  const poolAfter = await poolSnapshot()
  assert.ok(poolAfter, 'the bank pool exists')
  const sheet = auditBankPool(poolAfter, BANK_POOL_SEED)
  assert.ok(
    sheet.ok,
    `the bank balance sheet does not close: expected ${sheet.expected}, found ${sheet.actual} (off by ${sheet.difference})`
  )

  // 2. every player's private money reconciles with the ledger to the rial
  let heldBySession = 0
  for (const id of playerIds) {
    const wallet = Number((await db.player.findUniqueOrThrow({ where: { id } })).balance)
    const account = await db.bankAccount.findUnique({ where: { playerId: id } })
    const check = reconcilePrivateSector(
      id,
      { wallet, bankAccounts: account ? [Number(account.balance)] : [] },
      rows
    )
    assert.ok(
      check.ok,
      `ledger drift for ${id}: holds ${check.balance} but the ledger says ${check.ledgerNet} (off by ${check.difference})`
    )
    heldBySession += check.balance
  }

  // 3. the pool counters moved exactly as much as the ledger says
  const lockedInPool = sumByType(rows, ['DEPOSIT'])
  assert.ok(lockedInPool > 0, 'the term deposit reached the ledger as a DEPOSIT row')
  assert.equal(
    poolAfter.totalDeposited - poolBefore.totalDeposited,
    lockedInPool,
    'the pool deposit counter equals the money players locked during the session'
  )
  assert.equal(
    await db.financialTransaction.count({ where: { type: 'DEPOSIT', reference: { contains: 'افتتاح سپردهٔ' } } }),
    1,
    'opening a term deposit is the only DEPOSIT row — a wallet-to-own-account move is not one'
  )
  assert.equal(
    rows.filter((row) => row.type === 'BANK_DEPOSIT' && isInternalPrivateMove(row)).length,
    1,
    "Alice's wallet-to-account deposit stays inside the private sector"
  )

  const paidOutByBank = sumByType(rows, ['DEPOSIT_PAYOUT', 'DEPOSIT_INTEREST', 'LOAN_DISBURSEMENT'])
  assert.equal(
    poolAfter.totalDisbursed -
      poolBefore.totalDisbursed +
      (poolAfter.totalDepositInterest - poolBefore.totalDepositInterest),
    paidOutByBank,
    'everything the bank paid out during the session is in the ledger, and nothing else left it'
  )

  // 4. whatever the private sector holds is exactly what left the public sector.
  //    every one of these players started at zero, so their holdings can only be
  //    the mints minus the burns of the session.
  const publicFlow = publicSectorFlow(rows)
  assert.equal(
    heldBySession,
    publicFlow.spending - publicFlow.income,
    'private holdings equal the public sector net outflow — no money appeared or vanished'
  )

  // 5. no ownerless ledger rows in the session
  const shared = findSharedEntries(rows)
  assert.deepEqual(
    shared.map((row) => row.detail),
    [],
    'every money movement names who paid and who received'
  )

  // 6. nothing anywhere in the database is negative, and statuses agree
  await assertNoNegativeVaults()
  await assertStatusCoherence()

  // 7. report the shape of the economy for the record
  const accounts = await db.bankAccount.findMany({ select: { balance: true } })
  const businesses = await db.business.findMany({ select: { treasury: true } })
  const activeDeposits = await db.termDeposit.findMany({
    where: { status: 'ACTIVE' },
    select: { principal: true }
  })
  const regions = await db.regionStat.findMany({ select: { taxRevenue: true } })
  const wallets = await db.player.findMany({ select: { balance: true } })
  const supply = moneySupply({
    playerBalances: wallets.map((row) => Number(row.balance)),
    businessTreasuries: businesses.map((row) => Number(row.treasury)),
    bankBalances: accounts.map((row) => Number(row.balance)),
    lockedDeposits: activeDeposits.map((row) => Number(row.principal)),
    regionFunds: regions.map((row) => Number(row.taxRevenue)),
    bankPool: poolAfter.balance
  })
  const flow = publicFlow

  console.log(
    `session ledger: ${rows.length} rows — mint ${flow.mintCount} / burn ${flow.burnCount}, ` +
      `public net ${flow.net}`
  )
  console.log(
    `money supply: wallets ${supply.wallets}, bank accounts ${supply.banks}, ` +
      `locked deposits ${supply.lockedDeposits}, region funds ${supply.regionFunds}, ` +
      `bank pool ${supply.bankPool}`
  )
  console.log(
    `claims plus vaults ${supply.total}; money actually in existence ${moneyInExistence(supply)} ` +
      `(a locked term deposit sits in the pool and must not be counted twice)`
  )
  console.log(
    `daily fortune rolled "${drawn.kind}" for ${drawn.amount}; account interest paid ${interest.interestAccrued}`
  )
  console.log(
    'PASS: economic invariants hold on live PostgreSQL — the bank balance sheet closes, ' +
      'every player reconciles with the ledger to the rial, the pool counters match the ' +
      'ledger, no vault is negative and no status contradicts its timestamps'
  )
  await db.$disconnect()
}

main().catch(async (error) => {
  console.error(error)
  await db.$disconnect()
  process.exit(1)
})
