#!/usr/bin/env node
/**
 * راستی‌آزمایی بستهٔ آفلاینِ منتشرشده.
 *
 * چرا لازم است؟ نصب روی سرور (`offline-deps/install.sh`) فقط دو بسته را باز
 * می‌کند و هرگز `prisma generate` نمی‌زند؛ یعنی کلاینتِ Prisma و کدِ کامپایل‌شده
 * باید از قبل داخل همان بسته‌ها درست باشند. این اسکریپت دقیقاً همان چیزی را که
 * روی سرور باز می‌شود، در یک پوشهٔ موقت باز می‌کند و با آن، روی PostgreSQL زنده،
 * جریان واقعی «اخطار → مسدودسازی → حذف حساب» را اجرا می‌کند.
 *
 * اجرا:
 *   DATABASE_URL=postgresql://user@127.0.0.1:5433/<name>_ux_test \
 *     node scripts/offline-bundle-verify.cjs
 *
 * فقط روی دیتابیسِ آزمایشی (پسوند `_ux_test`) اجرا می‌شود؛ داده می‌سازد و پاک می‌کند.
 */
'use strict'

const { execFileSync, spawnSync } = require('node:child_process')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const databaseUrl = process.env.DATABASE_URL ?? ''

if (!/_ux_test\/?$/.test(databaseUrl)) {
  console.error(
    'این اسکریپت فقط روی دیتابیس آزمایشی اجرا می‌شود؛ DATABASE_URL باید به _ux_test ختم شود.'
  )
  process.exit(1)
}

for (const artifact of ['offline-deps/node_modules-linux.tar.gz', 'offline-deps/dist.tar.gz']) {
  assert.ok(fs.existsSync(path.join(root, artifact)), `missing artifact: ${artifact}`)
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-offline-'))
process.on('exit', () => fs.rmSync(work, { recursive: true, force: true }))

console.log(`==> extracting the shipped bundle into ${work}`)
execFileSync('tar', ['xzf', path.join(root, 'offline-deps/node_modules-linux.tar.gz'), '-C', work])
execFileSync('tar', ['xzf', path.join(root, 'offline-deps/dist.tar.gz'), '-C', work])
fs.cpSync(path.join(root, 'prisma'), path.join(work, 'prisma'), { recursive: true })
fs.copyFileSync(path.join(root, 'package.json'), path.join(work, 'package.json'))

// ۱) معماری آفلاین: هیچ موتور بومیِ Prisma در بسته نیست (فقط WASM)
const native = execFileSync('find', [path.join(work, 'node_modules'), '-name', '*.so.node'], {
  encoding: 'utf8'
}).trim()
assert.equal(native, '', `native engine leaked into the offline bundle:\n${native}`)

// ۲) اسکیمای مهاجرت‌ها همراه بسته هست (سرور بدون اینترنت مهاجرت می‌زند)
assert.ok(
  fs.existsSync(path.join(work, 'prisma/migrations')),
  'migrations are missing from the bundle copy'
)

// ۳) اجرای واقعی با کلاینت و کدِ خودِ بسته
const child = path.join(work, 'bundle-check.cjs')
fs.writeFileSync(child, childSource())
const run = spawnSync(process.execPath, [child], {
  cwd: work,
  encoding: 'utf8',
  env: {
    ...process.env,
    DATABASE_URL: databaseUrl,
    // هندلرِ کامپایل‌شده هنگام import پیکربندی محیط را می‌خواند؛ این توکن
    // ساختی است و هیچ تماسی با تلگرام گرفته نمی‌شود (فقط کیبورد ساخته می‌شود).
    BOT_TOKEN: process.env.BOT_TOKEN ?? '123456:offline-bundle-check',
    NODE_PATH: path.join(work, 'node_modules')
  }
})
process.stdout.write(run.stdout ?? '')
process.stderr.write(run.stderr ?? '')
assert.equal(run.status, 0, 'the shipped bundle failed the live moderation + erasure run')

console.log(
  'PASS: the offline bundle (node_modules + dist + migrations) runs the real moderation and erasure flow on live PostgreSQL'
)

/** کدِ فرزند: با وابستگی‌های خودِ بسته اجرا می‌شود، نه node_modules مخزن. */
function childSource() {
  return `'use strict'
const assert = require('node:assert/strict')
const { PrismaClient, BotAdminRole, PlayerStatus } = require('@prisma/client')
const { PrismaPg } = require('@prisma/adapter-pg')
require('grammy')

const { AdminService, WARNING_BAN_THRESHOLD } = require('./dist/modules/admin/admin.service')
const { buildAdminModerationKeyboard } = require('./dist/bot/handlers/admin.handler')

const ADMIN = 8369939024n
const TARGET = 555000111n

async function main() {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) })

  // کلاینتِ داخل بسته باید مدل تازهٔ اخطار را بشناسد
  assert.ok(db.playerWarning, 'the bundled Prisma client does not know PlayerWarning')

  await db.botAdmin.upsert({
    where: { telegramUserId: ADMIN },
    update: { isActive: true },
    create: { telegramUserId: ADMIN, role: BotAdminRole.ADMIN, isActive: true, firstName: 'ادمین دوم' }
  })
  await db.player.deleteMany({ where: { telegramUserId: TARGET } })
  const player = await db.player.create({
    data: {
      telegramUserId: TARGET,
      firstName: 'آزمون بسته',
      gender: 'MALE',
      biography: 'شخصیت آزمایشی راستی‌آزمایی بستهٔ آفلاین',
      balance: 120000,
      status: PlayerStatus.ACTIVE
    }
  })

  const service = new AdminService(db)
  let last
  for (const reason of ['تخلف نخست در گروه', 'تخلف دوم در گروه', 'تخلف سوم در گروه']) {
    last = await service.issueWarning(ADMIN, TARGET, reason)
  }
  assert.equal(last.activeCount, WARNING_BAN_THRESHOLD)
  assert.equal(last.banned, true)
  const banned = await db.player.findUniqueOrThrow({ where: { id: player.id } })
  assert.equal(banned.status, PlayerStatus.BANNED)
  assert.equal(await db.playerWarning.count({ where: { playerId: player.id } }), WARNING_BAN_THRESHOLD)

  const view = await service.getModerationView(ADMIN, TARGET)
  assert.equal(view.remainingUntilBan, 0)

  // کیبوردِ کامپایل‌شده هم باید داخل سقف تلگرام بماند
  for (const button of buildAdminModerationKeyboard(TARGET, view.warnings).inline_keyboard.flat()) {
    if (button.callback_data) assert.ok(Buffer.byteLength(button.callback_data) <= 64)
  }

  const preview = await service.getDeletionPreview(ADMIN, TARGET)
  assert.deepEqual(preview.blockers, [])
  assert.equal(preview.removedFunds, 120000)

  const result = await service.deletePlayer(ADMIN, TARGET)
  assert.equal(result.firstName, 'آزمون بسته')
  assert.equal(await db.player.count({ where: { id: player.id } }), 0)
  assert.equal(await db.playerWarning.count({ where: { playerId: player.id } }), 0)
  assert.equal(await db.notification.count({ where: { playerId: player.id } }), 0)
  // سندِ تسویه می‌ماند، ولی اشاره‌اش به بازیکنِ حذف‌شده تهی شده است
  assert.equal(await db.financialTransaction.count({ where: { sourcePlayerId: player.id } }), 0)
  const closure = await db.financialTransaction.count({
    where: { reference: { contains: 'تسویهٔ نهایی پیش از حذف' } }
  })
  assert.ok(closure >= 1, 'the closure ledger row must survive the erasure')

  console.log('bundle child checks OK')
  await db.$disconnect()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
`
}
