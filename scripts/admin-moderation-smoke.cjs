/* Run only against a disposable migrated database named *_ux_test.
 * Requires build first. Verifies the real moderation + account-erasure contract:
 * warning threshold, auto-ban atomicity under concurrency, revoke, outreach,
 * deletion blockers and referential integrity after erasure.
 * DATABASE_URL=postgresql://.../legacy_ux_test node scripts/admin-moderation-smoke.cjs
 */
const assert = require('node:assert/strict')
const url = process.env.DATABASE_URL
if (!url || !new URL(url).pathname.endsWith('_ux_test')) throw new Error('Use a disposable *_ux_test database')
process.env.BOT_TOKEN ||= '123456:SMOKE_TEST'
process.env.NODE_ENV = 'test'
const { PrismaClient } = require('@prisma/client')
const { PrismaPg } = require('@prisma/adapter-pg')
const { AdminService, WARNING_BAN_THRESHOLD } = require('../dist/modules/admin/admin.service')
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) })
const admin = new AdminService(db)

const owner = 6910416744n
const secondary = 8369939024n
const targetId = 9000000143n
const spouseId = 9000000144n
const ownerIdOfBusiness = 9000000145n
const employeeId = 9000000146n

async function makePlayer(telegramUserId, firstName, gender, extra = {}) {
  return db.player.upsert({
    where: { telegramUserId },
    create: {
      telegramUserId,
      firstName,
      gender,
      biography: 'شخصیت آزمایشی moderation',
      balance: 0,
      ...extra
    },
    update: { status: 'ACTIVE', activityState: 'IDLE', maritalStatus: 'SINGLE', balance: 0, ...extra }
  })
}

/** No row anywhere may still point at the erased player. */
async function assertNoOrphans(playerId) {
  const fks = await db.$queryRaw`
    SELECT con.conrelid::regclass::text AS child,
           (SELECT att.attname::text FROM pg_attribute att
             WHERE att.attrelid = con.conrelid AND att.attnum = ANY (con.conkey) LIMIT 1) AS column_name,
           con.confdeltype::text AS on_delete
    FROM pg_constraint con
    WHERE con.contype = 'f' AND con.confrelid = 'players'::regclass`
  assert.ok(fks.length >= 40, `expected the full FK inventory, saw ${fks.length}`)
  for (const fk of fks) {
    const rows = await db.$queryRawUnsafe(
      `SELECT count(*)::int AS n FROM ${fk.child} WHERE "${fk.column_name}" = $1`,
      playerId
    )
    assert.equal(rows[0].n, 0, `${fk.child}.${fk.column_name} still references the erased player`)
  }
}

async function main() {
  await admin.bootstrap()
  await db.botAdmin.update({ where: { telegramUserId: secondary }, data: { isActive: true } })

  const target = await makePlayer(targetId, 'آزمون', 'MALE', { balance: 250_000 })
  const spouse = await makePlayer(spouseId, 'همسر', 'FEMALE', { maritalStatus: 'MARRIED' })
  await db.player.update({ where: { id: target.id }, data: { maritalStatus: 'MARRIED' } })
  await db.playerWarning.deleteMany({ where: { playerId: target.id } })
  await db.notification.deleteMany({ where: { playerId: target.id } })

  // ── 1. threshold: two warnings do not ban, the third does (atomically)
  await db.marriage.deleteMany({ where: { OR: [{ playerAId: target.id }, { playerBId: target.id }] } })
  const first = await admin.issueWarning(secondary, targetId, 'رفتار نامناسب در گروه')
  assert.equal(first.activeCount, 1)
  assert.equal(first.banned, false)
  const second = await admin.issueWarning(secondary, targetId, 'تبلیغ ربات دیگر')
  assert.equal(second.activeCount, 2)
  assert.equal(second.remainingUntilBan, WARNING_BAN_THRESHOLD - 2)

  // every warning must reach the player's own inbox, with the admin's reason
  const warningNotices = await db.notification.findMany({
    where: { playerId: target.id, title: '⚠️ اخطار مدیریت' },
    orderBy: { createdAt: 'asc' }
  })
  assert.equal(warningNotices.length, 2)
  assert.ok(warningNotices[0].message.includes('رفتار نامناسب در گروه'))
  assert.ok(warningNotices[1].message.includes('تبلیغ ربات دیگر'))
  assert.ok(warningNotices[1].message.includes('۱ اخطار دیگر'))

  // an active work session must be closed by the auto-ban
  await db.jobCapacity.upsert({
    where: { jobKey: 'smoke_bakery' },
    create: { jobKey: 'smoke_bakery', capacity: 5, occupied: 1 },
    update: { capacity: 5, occupied: 1 }
  })
  await db.workSession.deleteMany({ where: { playerId: target.id } })
  await db.workSession.create({
    data: { playerId: target.id, jobKey: 'smoke_bakery', jobTitle: 'نانوایی', payPerMinute: 100 }
  })

  const third = await admin.issueWarning(secondary, targetId, 'توهین به بازیکنان')
  assert.equal(third.activeCount, WARNING_BAN_THRESHOLD)
  assert.equal(third.banned, true)
  const banned = await db.player.findUniqueOrThrow({ where: { id: target.id } })
  assert.equal(banned.status, 'BANNED')
  assert.equal(banned.activityState, 'IDLE')
  const capacity = await db.jobCapacity.findUniqueOrThrow({ where: { jobKey: 'smoke_bakery' } })
  assert.equal(capacity.occupied, 0)
  const session = await db.workSession.findFirst({ where: { playerId: target.id } })
  assert.equal(session.status, 'CANCELLED')
  const banNotifications = await db.notification.count({
    where: { playerId: target.id, title: { contains: 'مسدود' } }
  })
  assert.equal(banNotifications, 1)

  // ── 2. concurrency: two warnings at once must never both skip the ban
  await db.playerWarning.deleteMany({ where: { playerId: target.id } })
  await db.player.update({ where: { id: target.id }, data: { status: 'ACTIVE' } })
  const autoBanLogsBefore = await db.adminLog.count({
    where: { targetUserId: targetId, action: 'warning_issue_auto_ban' }
  })
  await admin.issueWarning(secondary, targetId, 'اخطار اول')
  await admin.issueWarning(secondary, targetId, 'اخطار دوم')
  const raced = await Promise.all([
    admin.issueWarning(secondary, targetId, 'اخطار سوم الف'),
    admin.issueWarning(secondary, targetId, 'اخطار سوم ب')
  ])
  assert.equal(raced.filter((r) => r.banned).length, 1, 'exactly one concurrent warning may ban')
  assert.equal(raced.map((r) => r.activeCount).sort().join(','), '3,4')
  const autoBanLogs = await db.adminLog.count({
    where: { targetUserId: targetId, action: 'warning_issue_auto_ban' }
  })
  assert.equal(autoBanLogs - autoBanLogsBefore, 1, 'one concurrent pair must produce exactly one auto-ban')

  // ── 3. revoke lowers the count but never silently unbans
  const view = await admin.getModerationView(secondary, targetId)
  assert.equal(view.activeCount, 4)
  const revoked = await admin.revokeWarning(secondary, targetId, view.warnings[0].id)
  assert.equal(revoked.activeCount, 3)
  assert.equal(revoked.stillBanned, true)
  await assert.rejects(() => admin.revokeWarning(secondary, targetId, view.warnings[0].id))

  // ── 4. banning an active bot admin is refused (privilege first, account second)
  await db.botAdmin.upsert({
    where: { telegramUserId: employeeId },
    create: { telegramUserId: employeeId, role: 'ADMIN', isActive: true, firstName: 'ادمین تست' },
    update: { isActive: true }
  })
  await makePlayer(employeeId, 'ادمین تست', 'MALE')
  await assert.rejects(() => admin.setAccountStatus(secondary, employeeId, 'BANNED'))
  await assert.rejects(() => admin.issueWarning(secondary, employeeId, 'تلاش برای اخطار به ادمین'))
  await assert.rejects(() => admin.deletePlayer(secondary, employeeId))
  await db.botAdmin.update({ where: { telegramUserId: employeeId }, data: { isActive: false } })

  // ── 5. outreach is durable even when the private message cannot be sent
  const outreach = await admin.sendPlayerMessage(owner, targetId, 'لطفاً قوانین گروه را رعایت کن.')
  assert.ok(outreach.notificationId)
  const notification = await db.notification.findUniqueOrThrow({ where: { id: outreach.notificationId } })
  assert.equal(notification.playerId, target.id)
  await assert.rejects(() => admin.sendPlayerMessage(owner, targetId, 'ک'))

  // ── 6. deletion blockers keep other players' rights intact
  const boss = await makePlayer(ownerIdOfBusiness, 'کارفرما', 'MALE')
  const employee = await makePlayer(employeeId, 'کارمند', 'MALE')
  await db.businessEmployee.deleteMany({ where: { playerId: { in: [boss.id, employee.id] } } })
  await db.business.deleteMany({ where: { ownerId: boss.id } })
  const business = await db.business.create({
    data: { ownerId: boss.id, name: 'کارگاه آزمایش', category: 'SERVICE', modelType: 'workshop' }
  })
  await db.businessEmployee.create({
    data: { businessId: business.id, playerId: employee.id, title: 'کارگر', salaryPerMinute: 50 }
  })
  const blockedPreview = await admin.getDeletionPreview(secondary, boss.id === boss.id ? ownerIdOfBusiness : boss.id)
  assert.ok(blockedPreview.blockers.some((b) => b.title.includes('کسب‌وکار')))
  await assert.rejects(() => admin.deletePlayer(secondary, ownerIdOfBusiness))

  // ── 7. erasure: everything personal goes, ledger and history stay
  await db.marriage.create({ data: { playerAId: target.id, playerBId: spouse.id, mahr: 100_000 } })
  await db.relationship.upsert({
    where: { playerId_relatedPlayerId_type: { playerId: target.id, relatedPlayerId: spouse.id, type: 'SPOUSE' } },
    create: { playerId: target.id, relatedPlayerId: spouse.id, type: 'SPOUSE', status: 'ACTIVE' },
    update: { status: 'ACTIVE' }
  })
  await db.bankAccount.upsert({
    where: { cardNumber: `smoke-${target.id}` },
    create: { playerId: target.id, cardNumber: `smoke-${target.id}`, balance: 40_000 },
    update: { balance: 40_000 }
  })
  const skill = await db.skill.upsert({
    where: { name: 'مهارت آزمایش' },
    create: { name: 'مهارت آزمایش' },
    update: {}
  })
  await db.playerSkill.upsert({
    where: { playerId_skillId: { playerId: target.id, skillId: skill.id } },
    create: { playerId: target.id, skillId: skill.id, level: 3 },
    update: { level: 3 }
  })
  const ledger = await db.financialTransaction.create({
    data: { amount: 12_345, type: 'TRANSFER', sourcePlayerId: target.id, reference: 'سند آزمایش' }
  })
  const event = await db.gameEvent.create({
    data: { scope: 'PLAYER', type: 'PET_ADOPTED', playerId: target.id, title: 'رخداد آزمایش' }
  })
  await db.userState.upsert({
    where: { telegramUserId: targetId },
    create: { telegramUserId: targetId, currentContext: 'family_mahr' },
    update: { currentContext: 'family_mahr' }
  })

  const preview = await admin.getDeletionPreview(owner, targetId)
  assert.equal(preview.blockers.length, 0, JSON.stringify(preview.blockers))
  assert.equal(preview.removedFunds, 290_000)
  assert.ok(preview.settlements.some((line) => line.includes('ازدواج')))

  const result = await admin.deletePlayer(owner, targetId)
  assert.equal(result.removedFunds, 290_000)
  assert.equal(await db.player.count({ where: { id: target.id } }), 0)
  await assertNoOrphans(target.id)

  // the spouse is settled, not left married to a ghost
  const widowed = await db.player.findUniqueOrThrow({ where: { id: spouse.id } })
  assert.equal(widowed.maritalStatus, 'DIVORCED')
  // the marriage row itself goes with the erased player; the spouse keeps the record
  assert.equal(await db.marriage.count({ where: { OR: [{ playerAId: target.id }, { playerBId: target.id }] } }), 0)
  const spouseNotice = await db.notification.findFirst({
    where: { playerId: spouse.id, dedupeKey: { startsWith: 'admin-erase-marriage' } }
  })
  assert.ok(spouseNotice, 'the spouse must be told the marriage ended')
  const spouseHistory = await db.gameEvent.count({ where: { playerId: spouse.id, type: 'DIVORCE_REGISTERED' } })
  assert.equal(spouseHistory, 1)

  // ledger and regional history survive with a nulled reference
  const keptLedger = await db.financialTransaction.findUniqueOrThrow({ where: { id: ledger.id } })
  assert.equal(keptLedger.sourcePlayerId, null)
  assert.equal(Number(keptLedger.amount), 12_345)
  const keptEvent = await db.gameEvent.findUniqueOrThrow({ where: { id: event.id } })
  assert.equal(keptEvent.playerId, null)
  const closureRow = await db.financialTransaction.findFirst({
    where: { type: 'WITHDRAWAL', reference: { contains: 'حذف حساب' } },
    orderBy: { createdAt: 'desc' }
  })
  assert.equal(Number(closureRow.amount), 290_000)

  // erasing twice is a NotFoundError, never a crash
  await assert.rejects(() => admin.deletePlayer(owner, targetId))

  // the secondary admin keeps full moderation power but no admin management
  await assert.rejects(() => admin.addAdmin(secondary, { telegramUserId: spouseId }))
  await assert.rejects(() => admin.removeAdmin(secondary, owner))

  console.log('PASS: moderation + erasure on live PostgreSQL — threshold, atomic auto-ban under concurrency, revoke, admin-target guard, durable outreach, deletion blockers, full referential integrity, preserved ledger/history, settled spouse')
}

main()
  .finally(() => db.$disconnect())
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
