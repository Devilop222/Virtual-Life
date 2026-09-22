/* Run only against a disposable migrated database named *_ux_test.
 * Requires build first. Tests the real Prisma client/pg adapter and SQL contract.
 * DATABASE_URL=postgresql://.../legacy_ux_test node scripts/admin-ux-smoke.cjs
 */
const assert = require('node:assert/strict')
const url = process.env.DATABASE_URL
if (!url || !new URL(url).pathname.endsWith('_ux_test')) throw new Error('Use a disposable *_ux_test database')
process.env.BOT_TOKEN ||= '123456:SMOKE_TEST'
process.env.NODE_ENV = 'test'
const { PrismaClient } = require('@prisma/client')
const { PrismaPg } = require('@prisma/adapter-pg')
const { AdminService } = require('../dist/modules/admin/admin.service')
const { UserStateRepository } = require('../dist/database/repositories/user-state.repository')
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) })
const admin = new AdminService(db)
const state = new UserStateRepository(db)
const owner = 6910416744n, secondary = 8369939024n, target = 9000000042n
async function main() {
  await admin.bootstrap()
  await db.botAdmin.update({ where: { telegramUserId: secondary }, data: { isActive: true } })
  const player = await db.player.upsert({ where: { telegramUserId: target }, create: { telegramUserId: target, firstName: 'آزمون', gender: 'MALE', biography: 'شخصیت آزمایشی', balance: 10000 }, update: { balance: 10000 } })
  const beforeLogs = await db.adminLog.count()
  const token = await state.issueConfirmation(secondary, -100, { action: 'balance_add', target: target.toString(), value: 500 })
  const claims = await Promise.all(Array.from({ length: 10 }, () => state.consumeConfirmation(secondary, -100, token)))
  assert.equal(claims.filter(Boolean).length, 1)
  await admin.adjustBalance(secondary, target, 500)
  assert.equal(Number((await db.player.findUniqueOrThrow({ where: { id: player.id } })).balance), 10500)
  assert.equal(await db.adminLog.count(), beforeLogs + 1)
  const tx = await db.financialTransaction.findFirst({ where: { destinationPlayerId: player.id }, orderBy: { createdAt: 'desc' } })
  assert.equal(Number(tx.amount), 500)
  await assert.rejects(() => admin.removeAdmin(secondary, owner))
  await assert.rejects(() => admin.addAdmin(secondary, { telegramUserId: target }))
  await assert.rejects(() => admin.removeAdmin(owner, owner))
  await admin.addAdmin(owner, { telegramUserId: target, firstName: 'آزمون' })
  await admin.removeAdmin(owner, target)
  assert.equal(await admin.isAdmin(target), false)
  assert.equal(await db.player.count({ where: { id: player.id } }), 1)
  const view = await admin.getPlayerLifeView(owner, target)
  assert.equal(view.jobs.length, 0)
  assert.equal(view.businesses.length, 0)
  assert.equal(view.marriages.length, 0)
  await db.botAdmin.update({ where: { telegramUserId: secondary }, data: { isActive: false } })
  await assert.rejects(() => admin.adjustBalance(secondary, target, 500))
  assert.equal(Number((await db.player.findUniqueOrThrow({ where: { id: player.id } })).balance), 10500)
  await db.botAdmin.update({ where: { telegramUserId: secondary }, data: { isActive: true } })
  console.log('PASS: PostgreSQL/Prisma: 10 concurrent claims → 1 winner; atomic balance + ledger + audit; main/secondary permissions; privilege-only removal; life-view queries; revoked access')
}
main().finally(() => db.$disconnect()).catch(error => { console.error(error); process.exitCode = 1 })
