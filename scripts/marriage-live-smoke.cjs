/* Run only against a disposable migrated database named *_ux_test.
 * Requires build first (dist/). Verifies the real marriage + mahr contract on
 * live PostgreSQL, through the fully wired container (services, events,
 * notifications) — the parts mocks cannot prove:
 *   · mahr law against the actual numeric(65,30) column (no artificial cap)
 *   · explicit acceptance before the marriage is registered
 *   · money conservation, single ledger row, single marriage row
 *   · no double registration / double payment under concurrency and replay
 *   · withdrawal losing (or winning) against acceptance, never both
 *   · insufficient balance rolls the whole transaction back
 *   · couple bonus paid once per day, atomic under concurrency
 *   · divorce settles once, concurrently safe, and sinks the fee
 * DATABASE_URL=postgresql://.../legacy_ux_test node scripts/marriage-live-smoke.cjs
 */
const assert = require('node:assert/strict')
const url = process.env.DATABASE_URL
if (!url || !new URL(url).pathname.endsWith('_ux_test')) throw new Error('Use a disposable *_ux_test database')
process.env.BOT_TOKEN ||= '123456:SMOKE_TEST'
process.env.NODE_ENV = 'test'

const { PrismaClient } = require('@prisma/client')
const { PrismaPg } = require('@prisma/adapter-pg')
const { buildContainer } = require('../dist/services/container')
const { MAHR_RULES, normalizeMahrOffer } = require('../dist/modules/family/mahr')
const { DIVORCE_COST } = require('../dist/modules/family/marriage.service')

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) })
// the container wires the real MarriageService + EventService + NotificationService
const container = buildContainer({
  getMemberInfo: async () => {
    throw new Error('marriage smoke never touches Telegram')
  }
})
const marriage = container.marriageService

const COUPLE_DAILY_BONUS = 50_000

const groomId = 9100000201n
const brideId = 9100000202n
const poorGroomId = 9100000203n
const otherBrideId = 9100000204n
const raceGroomId = 9100000205n
const raceBrideId = 9100000206n
const withdrawGroomId = 9100000207n
const withdrawBrideId = 9100000208n

const ids = [
  groomId,
  brideId,
  poorGroomId,
  otherBrideId,
  raceGroomId,
  raceBrideId,
  withdrawGroomId,
  withdrawBrideId
]

async function makePlayer(telegramUserId, firstName, gender, extra = {}) {
  return db.player.upsert({
    where: { telegramUserId },
    create: {
      telegramUserId,
      firstName,
      gender,
      biography: 'شخصیت آزمایشی ازدواج',
      balance: 0,
      ...extra
    },
    update: {
      status: 'ACTIVE',
      activityState: 'IDLE',
      maritalStatus: 'SINGLE',
      balance: 0,
      lastActivityAt: new Date(),
      ...extra
    }
  })
}

async function reset() {
  const players = await db.player.findMany({
    where: { telegramUserId: { in: ids } },
    select: { id: true }
  })
  const playerIds = players.map((p) => p.id)
  await db.marriage.deleteMany({
    where: { OR: [{ playerAId: { in: playerIds } }, { playerBId: { in: playerIds } }] }
  })
  await db.marriageProposal.deleteMany({
    where: { OR: [{ proposerId: { in: playerIds } }, { targetId: { in: playerIds } }] }
  })
  await db.relationship.deleteMany({
    where: { OR: [{ playerId: { in: playerIds } }, { relatedPlayerId: { in: playerIds } }] }
  })
  await db.financialTransaction.deleteMany({
    where: {
      OR: [{ sourcePlayerId: { in: playerIds } }, { destinationPlayerId: { in: playerIds } }]
    }
  })
  await db.gameEvent.deleteMany({ where: { playerId: { in: playerIds } } })
  await db.notification.deleteMany({ where: { playerId: { in: playerIds } } })
}

/** ستون‌های پول در این اسکیما `Decimal` هستند؛ اینجا به عددِ صحیحِ دقیق خوانده می‌شوند. */
async function balanceOf(telegramUserId) {
  const row = await db.player.findUniqueOrThrow({
    where: { telegramUserId },
    select: { balance: true, maritalStatus: true, status: true }
  })
  return { ...row, balance: Number(row.balance) }
}

async function totalSupply() {
  const sum = await db.player.aggregate({ _sum: { balance: true } })
  return Number(sum._sum.balance ?? 0)
}

async function openProposal(proposer, target, mahr) {
  await marriage.propose(proposer, target, mahr)
  const row = await db.marriageProposal.findFirstOrThrow({
    where: { proposerId: (await db.player.findUniqueOrThrow({ where: { telegramUserId: proposer } })).id },
    orderBy: { createdAt: 'desc' }
  })
  return row
}

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

async function main() {
  await reset()
  await makePlayer(groomId, 'خواستگار', 'MALE', { balance: 2_000_000_000_000 })
  await makePlayer(brideId, 'همسر', 'FEMALE', { balance: 0 })
  await makePlayer(poorGroomId, 'بی‌پول', 'MALE', { balance: 10 })
  await makePlayer(otherBrideId, 'دیگر', 'FEMALE', { balance: 0 })
  await makePlayer(raceGroomId, 'رقابتی', 'MALE', { balance: 9_000_000 })
  await makePlayer(raceBrideId, 'رقابتی‌همسر', 'FEMALE', { balance: 0 })
  await makePlayer(withdrawGroomId, 'پس‌گیرنده', 'MALE', { balance: 9_000_000 })
  await makePlayer(withdrawBrideId, 'پس‌گیرنده‌همسر', 'FEMALE', { balance: 0 })

  // ── 0. the mahr column really is the wide decimal the law assumes
  const column = await db.$queryRaw`
    SELECT numeric_precision::int AS precision, numeric_scale::int AS scale
    FROM information_schema.columns
    WHERE table_name = 'marriage_proposals' AND column_name = 'mahr'`
  assert.equal(column[0].precision, 65)
  assert.equal(column[0].scale, 30)

  // ── 1. mahr law: bride sets it, no artificial cap, only the overflow guard
  const proposal = await openProposal(groomId, brideId, null)
  assert.equal(Number(proposal.mahr), MAHR_RULES.unset, 'a male proposal starts with mahr unset')
  assert.equal(proposal.status, 'PENDING')

  // One law, two entry points: the bride's mahr and the groom's offer both end
  // in validateMahrAmount, so the same bad values must be refused on both sides.
  // `0` is the one legitimate difference: on the groom's side it means "unset,
  // the lady will choose", which is exactly what normalizeMahrOffer documents.
  const badMahrs = [
    { value: -5, code: 'Mahr out of range' },
    { value: 1.5, code: 'Invalid mahr' },
    { value: MAHR_RULES.max + 1, code: 'Mahr out of range' }
  ]
  for (const bad of badMahrs) {
    await rejectedWith(
      () => marriage.setMahr(brideId, proposal.id, bad.value),
      bad.code,
      `bride's mahr ${bad.value} must be refused`
    )
    await rejectedWith(
      () => marriage.propose(withdrawGroomId, withdrawBrideId, bad.value),
      bad.code,
      `groom's offer ${bad.value} must be refused`
    )
  }
  await rejectedWith(
    () => marriage.setMahr(brideId, proposal.id, 0),
    'Mahr out of range',
    'the bride cannot leave her own mahr unset'
  )
  assert.equal(normalizeMahrOffer(0), MAHR_RULES.unset, '0 on the offer side means unset')
  assert.equal(normalizeMahrOffer(null), MAHR_RULES.unset)
  assert.ok(
    MAHR_RULES.max > 500_000,
    'no artificial cap: the ceiling is the overflow guard, not a game rule'
  )

  await marriage.setMahr(brideId, proposal.id, MAHR_RULES.min)
  assert.equal(Number((await db.marriageProposal.findUniqueOrThrow({ where: { id: proposal.id } })).mahr), 1)

  await marriage.setMahr(brideId, proposal.id, 500_001)
  assert.equal(
    Number((await db.marriageProposal.findUniqueOrThrow({ where: { id: proposal.id } })).mahr),
    500_001,
    'there is no artificial 500,000 cap'
  )

  await marriage.setMahr(brideId, proposal.id, MAHR_RULES.max)
  const atCeiling = await db.marriageProposal.findUniqueOrThrow({ where: { id: proposal.id } })
  assert.equal(Number(atCeiling.mahr), MAHR_RULES.max)
  assert.equal(String(atCeiling.mahr), '1000000000000', 'stored exactly in the decimal column')
  assert.equal(atCeiling.status, 'MAHR_SET')

  // the bride cannot finalize her own mahr; the groom must accept it explicitly
  await rejectedWith(
    () => marriage.acceptProposal(brideId, proposal.id),
    'Cannot accept',
    'bride cannot accept once she set the mahr'
  )
  assert.equal(await db.marriage.count({ where: { playerAId: proposal.proposerId } }), 0)

  // ── 2. explicit confirmation registers the marriage and moves the money once
  const mahr = MAHR_RULES.max
  const supplyBefore = await totalSupply()
  const groomBefore = await balanceOf(groomId)
  const brideBefore = await balanceOf(brideId)

  await marriage.confirmProposal(groomId, proposal.id)

  const groomAfter = await balanceOf(groomId)
  const brideAfter = await balanceOf(brideId)
  assert.equal(groomAfter.balance, groomBefore.balance - mahr)
  assert.equal(brideAfter.balance, brideBefore.balance + mahr)
  assert.equal(await totalSupply(), supplyBefore, 'mahr is a transfer, never new money')
  assert.equal(groomAfter.maritalStatus, 'MARRIED')
  assert.equal(brideAfter.maritalStatus, 'MARRIED')

  const marriages = await db.marriage.findMany({
    where: { playerAId: proposal.proposerId, playerBId: proposal.targetId }
  })
  assert.equal(marriages.length, 1)
  assert.equal(marriages[0].isActive, true)
  assert.equal(Number(marriages[0].mahr), mahr)
  assert.equal(
    await db.marriageProposal.count({ where: { id: proposal.id, status: 'ACCEPTED' } }),
    1
  )

  const mahrRows = await db.financialTransaction.findMany({
    where: { sourcePlayerId: proposal.proposerId, type: 'MAHR_PAYMENT' }
  })
  assert.equal(mahrRows.length, 1)
  assert.equal(Number(mahrRows[0].amount), mahr)
  assert.equal(mahrRows[0].destinationPlayerId, proposal.targetId)

  // both sides of the family network, plus one history row and one notice each
  assert.equal(
    await db.relationship.count({
      where: {
        type: 'SPOUSE',
        status: 'ACTIVE',
        OR: [
          { playerId: proposal.proposerId, relatedPlayerId: proposal.targetId },
          { playerId: proposal.targetId, relatedPlayerId: proposal.proposerId }
        ]
      }
    }),
    2
  )
  assert.equal(
    await db.gameEvent.count({ where: { playerId: proposal.proposerId, type: 'MARRIAGE_REGISTERED' } }),
    1
  )
  assert.equal(
    await db.gameEvent.count({ where: { playerId: proposal.targetId, type: 'MARRIAGE_REGISTERED' } }),
    1
  )
  assert.equal(await db.notification.count({ where: { playerId: proposal.targetId } }), 2)

  // ── 3. replaying the confirmation changes nothing
  await rejectedWith(
    () => marriage.confirmProposal(groomId, proposal.id),
    'Wrong stage',
    'replayed confirmation'
  )
  await rejectedWith(
    () => marriage.acceptProposal(brideId, proposal.id),
    'Cannot accept',
    'replayed acceptance'
  )
  assert.equal(
    await db.marriage.count({ where: { playerAId: proposal.proposerId, playerBId: proposal.targetId } }),
    1
  )
  assert.equal(
    await db.financialTransaction.count({ where: { sourcePlayerId: proposal.proposerId, type: 'MAHR_PAYMENT' } }),
    1
  )
  assert.equal((await balanceOf(groomId)).balance, groomAfter.balance)

  // ── 4. a married player is locked out of a second marriage, both sides
  await rejectedWith(
    () => marriage.propose(groomId, otherBrideId, 1000),
    'Proposer married',
    'married man proposing again'
  )
  await rejectedWith(
    () => marriage.propose(poorGroomId, brideId, 1000),
    'Target married',
    'proposing to a married woman'
  )

  // ── 5. concurrency: three answers at once register exactly one marriage
  const raceProposal = await openProposal(raceGroomId, raceBrideId, 1_000_000)
  const raceSupply = await totalSupply()
  const raceGroomBefore = await balanceOf(raceGroomId)
  const raceBrideBefore = await balanceOf(raceBrideId)
  const outcomes = await Promise.allSettled([
    marriage.acceptProposal(raceBrideId, raceProposal.id),
    marriage.confirmProposal(raceGroomId, raceProposal.id),
    marriage.acceptProposal(raceBrideId, raceProposal.id)
  ])
  assert.equal(outcomes.filter((o) => o.status === 'fulfilled').length, 1)
  assert.equal(
    await db.marriage.count({ where: { playerAId: raceProposal.proposerId, playerBId: raceProposal.targetId } }),
    1
  )
  assert.equal(
    await db.financialTransaction.count({
      where: { sourcePlayerId: raceProposal.proposerId, type: 'MAHR_PAYMENT' }
    }),
    1
  )
  assert.equal((await balanceOf(raceGroomId)).balance, raceGroomBefore.balance - 1_000_000)
  assert.equal((await balanceOf(raceBrideId)).balance, raceBrideBefore.balance + 1_000_000)
  assert.equal(await totalSupply(), raceSupply)

  // ── 6. withdrawal racing an acceptance never leaves both effects behind
  const withdrawProposalRow = await openProposal(withdrawGroomId, withdrawBrideId, 2_000_000)
  const withdrawOutcomes = await Promise.allSettled([
    marriage.withdrawProposal(withdrawGroomId, withdrawProposalRow.id),
    marriage.acceptProposal(withdrawBrideId, withdrawProposalRow.id)
  ])
  const finalProposal = await db.marriageProposal.findUniqueOrThrow({
    where: { id: withdrawProposalRow.id }
  })
  const withdrawMarriages = await db.marriage.count({
    where: { playerAId: withdrawProposalRow.proposerId, playerBId: withdrawProposalRow.targetId }
  })
  if (finalProposal.status === 'ACCEPTED') {
    assert.equal(withdrawMarriages, 1, 'an accepted proposal must have its marriage')
    assert.equal(
      await db.financialTransaction.count({
        where: { sourcePlayerId: withdrawProposalRow.proposerId, type: 'MAHR_PAYMENT' }
      }),
      1
    )
  } else {
    assert.ok(
      ['CANCELLED', 'DECLINED'].includes(finalProposal.status),
      `unexpected status ${finalProposal.status}`
    )
    assert.equal(withdrawMarriages, 0, 'a withdrawn proposal must not be married')
    assert.equal((await balanceOf(withdrawGroomId)).balance, 9_000_000)
  }
  assert.equal(withdrawOutcomes.filter((o) => o.status === 'fulfilled').length, 1)

  // ── 7. insufficient balance rolls the whole transaction back
  const poorProposal = await openProposal(poorGroomId, otherBrideId, null)
  await marriage.setMahr(otherBrideId, poorProposal.id, 1_000_000_000)
  const poorSupply = await totalSupply()
  await rejectedWith(
    () => marriage.confirmProposal(poorGroomId, poorProposal.id),
    'Proposer cannot afford',
    'groom cannot afford the mahr'
  )
  const poorRow = await db.marriageProposal.findUniqueOrThrow({ where: { id: poorProposal.id } })
  // finalize first flips the proposal to ACCEPTED; the failed payment must undo it
  assert.equal(poorRow.status, 'MAHR_SET', 'the proposal stays open, not half-accepted')
  assert.equal(
    await db.marriage.count({ where: { playerAId: poorProposal.proposerId } }),
    0
  )
  assert.equal((await balanceOf(poorGroomId)).balance, 10)
  assert.equal((await balanceOf(otherBrideId)).balance, 0)
  assert.equal((await balanceOf(poorGroomId)).maritalStatus, 'SINGLE')
  assert.equal(await totalSupply(), poorSupply)

  // ── 8. the couple bonus is paid once per day and is atomic under concurrency
  await db.player.updateMany({
    where: { telegramUserId: { in: [groomId, brideId] } },
    data: { lastActivityAt: new Date() }
  })
  const bonusSupply = await totalSupply()
  const groomBeforeBonus = await balanceOf(groomId)
  const first = await marriage.claimCoupleBonus(groomId)
  assert.equal(first.amount, COUPLE_DAILY_BONUS)
  assert.equal((await balanceOf(groomId)).balance, groomBeforeBonus.balance + COUPLE_DAILY_BONUS)
  await rejectedWith(
    () => marriage.claimCoupleBonus(groomId),
    'Bonus claimed',
    'second claim the same day'
  )
  await rejectedWith(
    () => marriage.claimCoupleBonus(brideId),
    'Bonus claimed',
    'spouse claim the same day'
  )
  assert.equal(
    await db.financialTransaction.count({
      where: { destinationPlayerId: proposal.proposerId, type: 'REWARD_PAYOUT' }
    }),
    1
  )

  // same-day guard under concurrency: reset the day index, fire five claims
  await db.marriage.updateMany({
    where: { id: marriages[0].id },
    data: { lastBonusDayIndex: null }
  })
  const concurrentClaims = await Promise.allSettled([
    marriage.claimCoupleBonus(groomId),
    marriage.claimCoupleBonus(groomId),
    marriage.claimCoupleBonus(groomId),
    marriage.claimCoupleBonus(groomId),
    marriage.claimCoupleBonus(groomId)
  ])
  assert.equal(concurrentClaims.filter((o) => o.status === 'fulfilled').length, 1)
  assert.equal(
    (await balanceOf(groomId)).balance,
    groomBeforeBonus.balance + 2 * COUPLE_DAILY_BONUS
  )
  assert.equal(await totalSupply(), bonusSupply + 2 * COUPLE_DAILY_BONUS)
  assert.equal(
    await db.financialTransaction.count({
      where: { destinationPlayerId: proposal.proposerId, type: 'REWARD_PAYOUT' }
    }),
    2
  )

  // ── 9. divorce settles once, sinks the fee, and both sides end up divorced
  const divorceSupply = await totalSupply()
  const groomBeforeDivorce = await balanceOf(groomId)
  const divorce = await marriage.divorce(groomId)
  assert.equal(divorce.paidFee, DIVORCE_COST)
  assert.equal((await balanceOf(groomId)).balance, groomBeforeDivorce.balance - DIVORCE_COST)
  assert.equal(await totalSupply(), divorceSupply - DIVORCE_COST, 'the fee leaves circulation')
  assert.equal((await balanceOf(groomId)).maritalStatus, 'DIVORCED')
  assert.equal((await balanceOf(brideId)).maritalStatus, 'DIVORCED')
  assert.equal(await db.marriage.count({ where: { id: marriages[0].id, isActive: true } }), 0)
  assert.equal(
    await db.financialTransaction.count({
      where: { sourcePlayerId: proposal.proposerId, type: 'DIVORCE_SETTLEMENT' }
    }),
    1
  )
  // the mahr stays with the bride
  assert.equal((await balanceOf(brideId)).balance, brideBefore.balance + mahr)

  await rejectedWith(() => marriage.divorce(groomId), 'Not married', 'second divorce')
  await rejectedWith(() => marriage.divorce(brideId), 'Not married', 'divorce after settlement')
  assert.equal(
    await db.financialTransaction.count({
      where: { sourcePlayerId: proposal.proposerId, type: 'DIVORCE_SETTLEMENT' }
    }),
    1
  )
  assert.equal((await balanceOf(groomId)).balance, groomBeforeDivorce.balance - DIVORCE_COST)

  // ── 10. concurrent divorce charges the fee only once
  const raceDivorce = await db.marriage.findFirstOrThrow({
    where: { playerAId: raceProposal.proposerId, isActive: true }
  })
  const raceGroomBeforeDivorce = await balanceOf(raceGroomId)
  const raceSupplyBeforeDivorce = await totalSupply()
  const divorceOutcomes = await Promise.allSettled([
    marriage.divorce(raceGroomId),
    marriage.divorce(raceBrideId),
    marriage.divorce(raceGroomId)
  ])
  assert.equal(divorceOutcomes.filter((o) => o.status === 'fulfilled').length, 1)
  assert.equal(
    await db.financialTransaction.count({
      where: { sourcePlayerId: raceProposal.proposerId, type: 'DIVORCE_SETTLEMENT' }
    }),
    1
  )
  assert.equal(
    (await balanceOf(raceGroomId)).balance,
    raceGroomBeforeDivorce.balance - DIVORCE_COST
  )
  assert.equal(await totalSupply(), raceSupplyBeforeDivorce - DIVORCE_COST)
  assert.equal(await db.marriage.count({ where: { id: raceDivorce.id, isActive: true } }), 0)

  console.log(
    'PASS: marriage + mahr on live PostgreSQL — decimal(65,30) law with no artificial cap, explicit acceptance, exact money movement, no double registration/payment under concurrency or replay, withdrawal race invariant, balance rollback, once-per-day atomic couple bonus, single-settlement divorce'
  )
}

main()
  .finally(() => db.$disconnect())
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
