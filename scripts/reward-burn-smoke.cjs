/* Fault-injection harness for the "claim and pay" rewards.
 * Requires build first (dist/) and a disposable migrated database named *_ux_test.
 *
 * The race harness (economy-race-smoke.cjs) proves that a burst of clicks pays
 * exactly once. This one asks the other question: what happens when the *payment*
 * dies half-way? If the claim marker is written outside the paying transaction,
 * the claim survives the failure and the reward is burned for good — the player
 * is told "you already claimed it" and never sees the money. Mocks cannot show
 * this either, so the failure is injected at the database level: a CHECK
 * constraint that makes every ledger insert fail, which kills any payment.
 *
 * For each path the contract is the same:
 *   1. the failed attempt leaves no claim behind and moves no money;
 *   2. once the database is healthy again, the retry pays exactly once.
 *
 *   · weekly chest   : 21 claimed cards, then the payout dies
 *   · bank interest  : five days of interest, then the payout dies
 *   · daily fortune  : a paying outcome, then the payout dies
 *
 * DATABASE_URL=postgresql://.../legacy_ux_test node scripts/reward-burn-smoke.cjs
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
const { dayIndex, weekIndex, stableHash } = require('../dist/utils/game-time')
const { QUEST_REWARDS } = require('../dist/modules/quests/daily-quest.service')
const { BANK_POOL_ID } = require('../dist/config/economy')
const { BankPoolService } = require('../dist/modules/banking/bank-pool.service')
const { ConflictError } = require('../dist/utils/classes/errors')

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) })
const bankPool = new BankPoolService()
const container = buildContainer({
  getMemberInfo: async () => {
    throw new Error('the reward burn smoke never touches Telegram')
  }
})

const quests = container.dailyQuestService
const banking = container.bankingService
const fortune = container.fortuneService

const chestPlayerId = 9400000701n
const saverPlayerId = 9400000702n
const fortuneBaseId = 9400000703n

const DAY_MS = 24 * 60 * 60 * 1000
const QUEST_KEYS = ['work_shift', 'shop_purchase', 'bank_deposit']

// ── the injected failure ─────────────────────────────────────────────────────
/** از این لحظه هر ردیفِ دفتر کل رد می‌شود، یعنی هر پرداختی می‌میرد. */
async function breakPayments() {
  await db.$executeRawUnsafe(
    'ALTER TABLE financial_transactions DROP CONSTRAINT IF EXISTS reward_burn_smoke_fail'
  )
  await db.$executeRawUnsafe(
    // NOT VALID: ردیف‌های موجود بررسی نمی‌شوند؛ فقط نوشتارِ تازه رد می‌شود
    'ALTER TABLE financial_transactions ADD CONSTRAINT reward_burn_smoke_fail CHECK (amount < 0) NOT VALID'
  )
}

async function healPayments() {
  await db.$executeRawUnsafe(
    'ALTER TABLE financial_transactions DROP CONSTRAINT IF EXISTS reward_burn_smoke_fail'
  )
}

// ── helpers ──────────────────────────────────────────────────────────────────
async function makePlayer(telegramUserId, firstName, extra = {}) {
  return db.player.upsert({
    where: { telegramUserId },
    create: {
      telegramUserId,
      firstName,
      gender: 'MALE',
      biography: 'شخصیت آزمایشِ سوختنِ پاداش',
      balance: 0,
      ...extra
    },
    update: { status: 'ACTIVE', balance: 0, ...extra }
  })
}

async function balanceOf(telegramUserId) {
  const row = await db.player.findUniqueOrThrow({
    where: { telegramUserId },
    select: { balance: true }
  })
  return Number(row.balance)
}

async function poolRow() {
  return db.bankPool.findUnique({ where: { id: BANK_POOL_ID } })
}

async function poolBalance() {
  const row = await poolRow()
  return row ? Number(row.balance) : 0
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

async function ledgerCount(playerId, references) {
  return db.financialTransaction.count({
    where: {
      reference: { in: references },
      OR: [{ sourcePlayerId: playerId }, { destinationPlayerId: playerId }]
    }
  })
}

async function reset() {
  const rows = await db.player.findMany({
    where: {
      OR: [
        { telegramUserId: chestPlayerId },
        { telegramUserId: saverPlayerId },
        { telegramUserId: { gte: fortuneBaseId, lt: fortuneBaseId + 60n } }
      ]
    },
    select: { id: true }
  })
  const playerIds = rows.map((row) => row.id)

  await healPayments()
  await db.dailyQuest.deleteMany({ where: { playerId: { in: playerIds } } })
  await db.weeklyChest.deleteMany({ where: { playerId: { in: playerIds } } })
  await db.dailyFortune.deleteMany({ where: { playerId: { in: playerIds } } })
  await db.bankAccount.deleteMany({ where: { playerId: { in: playerIds } } })
  await db.financialTransaction.deleteMany({
    where: { OR: [{ sourcePlayerId: { in: playerIds } }, { destinationPlayerId: { in: playerIds } }] }
  })
  await db.gameEvent.deleteMany({ where: { playerId: { in: playerIds } } })
  await db.notification.deleteMany({ where: { playerId: { in: playerIds } } })
  await db.player.deleteMany({ where: { id: { in: playerIds } } })
}

async function main() {
  await reset()

  // ── 1. weekly chest: a dead payout must not burn the perfect week ─────────
  const chestPlayer = await makePlayer(chestPlayerId, 'کارت‌باز')
  const week = weekIndex()
  for (let day = week * 7; day < week * 7 + 7; day += 1) {
    for (const questKey of QUEST_KEYS) {
      await db.dailyQuest.create({
        data: {
          playerId: chestPlayer.id,
          dayIndex: day,
          questKey,
          progress: 1,
          target: 1,
          claimedAt: new Date()
        }
      })
    }
  }
  assert.equal(
    await db.dailyQuest.count({ where: { playerId: chestPlayer.id, claimedAt: { not: null } } }),
    QUEST_REWARDS.cardsPerWeek,
    'the week is perfect, so the chest is claimable'
  )

  await breakPayments()
  await assert.rejects(
    () => quests.claimWeeklyChest(chestPlayerId),
    'a dead ledger insert must surface as a failure, not as a silent success'
  )
  await healPayments()

  assert.equal(
    await db.weeklyChest.count({ where: { playerId: chestPlayer.id } }),
    0,
    'the failed attempt left no claim behind'
  )
  assert.equal(await balanceOf(chestPlayerId), 0, 'the failed attempt paid nothing')

  const chest = await quests.claimWeeklyChest(chestPlayerId)
  assert.equal(chest.amount, QUEST_REWARDS.chest)
  assert.equal(
    await balanceOf(chestPlayerId),
    QUEST_REWARDS.chest,
    'the retry pays the chest exactly once'
  )
  assert.equal(
    await ledgerCount(chestPlayer.id, ['صندوق هفتهٔ بی‌نقص کارت‌های روزانه']),
    1,
    'one ledger row for the retried chest'
  )
  await assert.rejects(
    () => quests.claimWeeklyChest(chestPlayerId),
    (error) => error instanceof ConflictError,
    'and only now is the week really claimed'
  )
  assert.equal(await balanceOf(chestPlayerId), QUEST_REWARDS.chest, 'a second claim pays nothing')

  // ── 2. bank interest: a dead payout must not move the interest clock ──────
  const saver = await makePlayer(saverPlayerId, 'سپرده‌گذار')
  const fiveDaysAgo = new Date(Date.now() - 5 * DAY_MS)
  await db.bankAccount.create({
    data: {
      playerId: saver.id,
      cardNumber: '6037991100000702',
      balance: 20_000_000,
      lastInterestAt: fiveDaysAgo,
      status: 'ACTIVE'
    }
  })
  await fundPool(500_000_000)
  const poolBefore = Number((await poolRow()).balance)
  const interestCounterBefore = Number((await poolRow()).totalDepositInterest)

  await breakPayments()
  await assert.rejects(
    () => banking.settleAccountInterest(saverPlayerId),
    'a dead ledger insert must surface as a failure'
  )
  await healPayments()

  const accountAfterFailure = await db.bankAccount.findUniqueOrThrow({
    where: { playerId: saver.id }
  })
  assert.equal(
    Number(accountAfterFailure.balance),
    20_000_000,
    'the failed settlement credited no interest'
  )
  assert.equal(
    accountAfterFailure.lastInterestAt.getTime(),
    fiveDaysAgo.getTime(),
    'the failed settlement did not move the interest clock — those five days are still owed'
  )
  assert.equal(
    Number((await poolRow()).balance),
    poolBefore,
    'the failed settlement took nothing from the bank pool'
  )
  assert.equal(
    Number((await poolRow()).totalDepositInterest),
    interestCounterBefore,
    'the failed settlement did not inflate the pool interest counter'
  )

  const interest = await banking.settleAccountInterest(saverPlayerId)
  assert.ok(interest.interestAccrued > 0, 'the retry really pays the five days')
  const accountAfterRetry = await db.bankAccount.findUniqueOrThrow({ where: { playerId: saver.id } })
  assert.equal(
    Number(accountAfterRetry.balance) - 20_000_000,
    interest.interestAccrued,
    'the account gains exactly the reported interest'
  )
  assert.equal(
    poolBefore - Number((await poolRow()).balance),
    interest.interestAccrued,
    'the pool loses exactly what the account gains'
  )

  // ── 3. daily fortune: a dead payout must not burn today's draw ────────────
  // نتیجهٔ شانس به شناسهٔ داخلی بازیکن گره خورده است؛ بازیکنی پیدا می‌کنیم که
  // نتیجهٔ امروزش پول داشته باشد تا مسیر پرداخت واقعاً اجرا شود.
  let lucky = null
  for (let attempt = 0; attempt < 60 && !lucky; attempt += 1) {
    const telegramUserId = fortuneBaseId + BigInt(attempt)
    const player = await makePlayer(telegramUserId, 'خوش‌شانس', { balance: 1_000_000 })
    const roll = stableHash(`fortune:${player.id}:${dayIndex()}`) % 100
    const kind = roll < 55 ? 'neutral' : roll < 80 ? 'gain' : roll < 95 ? 'loss' : 'jackpot'
    if (kind === 'gain' || kind === 'jackpot') {
      lucky = { telegramUserId, player, kind }
    } else {
      await db.player.delete({ where: { id: player.id } })
    }
  }
  assert.ok(lucky, 'a player with a paying fortune outcome exists')

  const luckyBefore = await balanceOf(lucky.telegramUserId)
  await breakPayments()
  await assert.rejects(
    () => fortune.draw(lucky.telegramUserId),
    'a dead ledger insert must surface as a failure'
  )
  await healPayments()

  assert.equal(
    await db.dailyFortune.count({ where: { playerId: lucky.player.id } }),
    0,
    'the failed draw left no claim behind'
  )
  assert.equal(await balanceOf(lucky.telegramUserId), luckyBefore, 'the failed draw paid nothing')

  const drawn = await fortune.draw(lucky.telegramUserId)
  assert.equal(drawn.kind, lucky.kind)
  assert.equal(
    (await balanceOf(lucky.telegramUserId)) - luckyBefore,
    drawn.amount,
    'the retry pays today\'s fortune exactly once'
  )
  assert.equal(
    await db.dailyFortune.count({ where: { playerId: lucky.player.id } }),
    1,
    'one fortune row for the day'
  )
  assert.equal(
    await ledgerCount(lucky.player.id, ['شانس روزانه', 'هزینهٔ پیش‌بینی‌نشدهٔ روز']),
    1,
    'one ledger row for the retried draw'
  )

  await healPayments()
  console.log(
    'PASS: reward burn smoke on live PostgreSQL — when the payment dies, the weekly chest, ' +
      'bank interest and daily fortune leave no claim behind, move no money, and pay exactly ' +
      'once on the retry'
  )
  await db.$disconnect()
}

main().catch(async (error) => {
  await healPayments().catch(() => undefined)
  console.error(error)
  await db.$disconnect()
  process.exit(1)
})
