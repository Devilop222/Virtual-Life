'use strict'
/**
 * مالکیت در لایهٔ سرویس — معیار ۵ و ۲۴.
 *
 * پنل‌ها در میان‌افزار رد می‌شوند، اما مرزِ واقعیِ امنیت لایهٔ سرویس است:
 * اگر کسی `callback_data` را دستکاری کند یا رباتِ دیگری همان API را صدا بزند،
 * تنها چیزی که جلوی دسترسی به داراییِ دیگری را می‌گیرد همین‌جاست.
 *
 * روش: OWNER در هر دامنه داراییِ واقعی می‌سازد؛ INTRUDER با **شناسهٔ درستِ
 * همان دارایی** تلاش می‌کند و باید رد شود. بعد OWNER همان کار را می‌کند و باید
 * موفق شود — تا «همیشه رد می‌کند» با «درست کار می‌کند» اشتباه گرفته نشود.
 *
 *   DATABASE_URL=postgresql://.../legacy_ux_test BOT_TOKEN=dummy \
 *     node scripts/service-ownership-smoke.cjs
 */
const assert = require('node:assert/strict')

const url = process.env.DATABASE_URL
if (!url || !new URL(url).pathname.endsWith('_ux_test')) {
  throw new Error('Use a disposable *_ux_test database')
}
process.env.NODE_ENV = 'test'
process.env.BOT_TOKEN ||= '123456:OWNER'

const { PrismaClient } = require('@prisma/client')
const { PrismaPg } = require('@prisma/adapter-pg')
const { createJourney } = require('./journey-harness.cjs')

const OWNER = 938_000_001
const INTRUDER = 938_000_002
const ADMIN = 938_000_003
const GROUP = -938_100_001

const results = []
async function check(name, fn) {
  try {
    await fn()
    results.push({ name, ok: true })
  } catch (error) {
    results.push({ name, ok: false, error: error.message })
  }
}

/**
 * فراخوانی باید رد شود.
 *
 * `reason` اهمیت دارد: اگر رد به خاطرِ «دامنهٔ نامعتبر» یا «موجودیِ ناکافی»
 * باشد و نه مالکیت، آزمون سبز می‌شود در حالی که حفرهٔ مالکیت سرِ جایش است.
 * پس الگوی پیامِ مالکیت صریحاً خواسته می‌شود.
 */
const OWNERSHIP_RE = /متعلق به تو نیست|مالِ تو نیست|دسترسی نداری|یافت نشد|نداری|مربوط به تو نیست/u

async function expectRefused(label, fn, pattern = OWNERSHIP_RE) {
  let outcome = null
  try {
    outcome = await fn()
  } catch (error) {
    const persian = String(error.persianMessage ?? error.message ?? '')
    assert.ok(persian.length > 0, `${label}: refused but with no player-facing message`)
    // پیامِ فنی به بازیکن نرسد
    assert.doesNotMatch(
      persian,
      /Prisma|SQL|Repository|Handler|Service|Callback|Exception|Internal Error|undefined/i,
      `${label}: leaked a technical message — ${persian}`
    )
    assert.match(
      persian,
      pattern,
      `${label}: refused, but for the wrong reason — «${persian}». ` +
        'A validation error must not be what stops an intruder.'
    )
    return
  }
  throw new Error(`${label}: expected refusal but it succeeded — ${JSON.stringify(outcome)}`)
}

async function main() {
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) })
  const j = await createJourney({ db, adminUserIds: [ADMIN] })

  await db.$executeRawUnsafe('TRUNCATE TABLE players CASCADE')
  await db.$executeRawUnsafe('TRUNCATE TABLE groups CASCADE')
  await db.$executeRawUnsafe('TRUNCATE TABLE user_states')

  for (const uid of [OWNER, INTRUDER, ADMIN]) {
    await j.command(uid, '/start')
    await j.press(uid, 'reg:gender:MALE')
    await j.text(uid, `بازیکن ${uid % 1000} که دنبال ساختن آینده است.`)
  }
  await j.command(ADMIN, '/start', GROUP)
  await db.player.updateMany({
    where: { telegramUserId: { in: [BigInt(OWNER), BigInt(INTRUDER)] } },
    data: { balance: 900_000_000, experience: 1000 }
  })

  const owner = await db.player.findUniqueOrThrow({
    where: { telegramUserId: BigInt(OWNER) }
  })
  const c = j.container

  // ── ساختنِ دارایی‌های OWNER در هر دامنه ──────────────────────────────
  await c.housingService.buyPropertyByBlueprint(BigInt(OWNER), 'ROOM')
  const property = await db.property.findFirstOrThrow({ where: { ownerId: owner.id } })

  await c.farmService.plant(BigInt(OWNER), 'wheat')
  const plot = await db.farmPlot.findFirstOrThrow({ where: { playerId: owner.id } })

  await c.depositService.open(BigInt(OWNER), 'w1', 5_000_000)
  const deposit = await db.termDeposit.findFirstOrThrow({ where: { playerId: owner.id } })

  const blueprint = c.businessService.getBlueprints()[0]
  const { business: biz } = await c.businessService.createBusiness(
    BigInt(OWNER),
    blueprint.modelType,
    'کارگاهِ مالکیت'
  )
  await c.branchService.openBranch(BigInt(OWNER), biz.id, (await db.group.findFirstOrThrow()).id)
  const branch = await db.businessBranch.findFirstOrThrow({
    where: { businessId: biz.id }
  })

  await c.shopService.buyItem(BigInt(OWNER), 'meal')
  const inventory = await db.playerInventory.findFirstOrThrow({
    where: { playerId: owner.id, quantity: { gt: 0 } }
  })
  const listing = await c.tradeService.createListing(
    BigInt(OWNER),
    inventory.id,
    1,
    500_000
  )

  // ── ۱. ملک ───────────────────────────────────────────────────────────
  await check('nobody can furnish another player property', async () => {
    await expectRefused('furnishProperty', () =>
      c.housingService.furnishProperty(BigInt(INTRUDER), property.id)
    )
    const before = await db.property.findUniqueOrThrow({ where: { id: property.id } })
    await c.housingService.furnishProperty(BigInt(OWNER), property.id)
    const after = await db.property.findUniqueOrThrow({ where: { id: property.id } })
    assert.notEqual(
      String(after.isFurnished),
      String(before.isFurnished),
      'the owner really can furnish it'
    )
  })

  // ── ۲. اجاره ─────────────────────────────────────────────────────────
  await check('nobody can set the rent on another player property', async () => {
    await expectRefused('setRent', () =>
      c.rentalService.setRent(BigInt(INTRUDER), property.id, 900_000)
    )
    await expectRefused('setListed', () =>
      c.rentalService.setListed(BigInt(INTRUDER), property.id, true)
    )
    // بازهٔ مجاز از قیمتِ خریدِ همان ملک مشتق می‌شود؛ مالک باید با مبلغی
    // درونِ بازه موفق شود، وگرنه «رد شدن» معنایی ندارد
    const current = await db.property.findUniqueOrThrow({ where: { id: property.id } })
    const wanted = Number(current.rentalPriceMonthly)
    const set = await c.rentalService.setRent(BigInt(OWNER), property.id, wanted)
    assert.equal(set.monthlyRent, wanted, 'the owner really can set it')
  })

  // ── ۳. مزرعه ─────────────────────────────────────────────────────────
  await check('nobody can harvest another player plot', async () => {
    await expectRefused('harvest', () => c.farmService.harvest(BigInt(INTRUDER), plot.id))
  })

  // ── ۴. سپردهٔ بانکی ──────────────────────────────────────────────────
  await check('nobody can break another player term deposit', async () => {
    const intruderWallet = Number(
      (await db.player.findUniqueOrThrow({
        where: { telegramUserId: BigInt(INTRUDER) }
      })).balance
    )
    await expectRefused('breakEarly', () =>
      c.depositService.breakEarly(BigInt(INTRUDER), deposit.id)
    )
    const stillThere = await db.termDeposit.findUniqueOrThrow({ where: { id: deposit.id } })
    assert.equal(stillThere.status, 'ACTIVE', 'the deposit is untouched')
    assert.equal(
      Number(
        (await db.player.findUniqueOrThrow({
          where: { telegramUserId: BigInt(INTRUDER) }
        })).balance
      ),
      intruderWallet,
      'no money moved to the intruder'
    )
  })

  // ── ۵. شعبهٔ کسب‌وکار ────────────────────────────────────────────────
  await check('nobody can collect income from another player branch', async () => {
    await expectRefused('collectIncome', () =>
      c.branchService.collectIncome(BigInt(INTRUDER), branch.id)
    )
  })

  // ── ۶. آگهیِ بازار ───────────────────────────────────────────────────
  await check('nobody can cancel another player market listing', async () => {
    // اینجا «فعال نیست» پاسخِ درست است: سرویس عمداً وجودِ آگهیِ دیگری را
    // فاش نمی‌کند، ولی شرطِ مالکیت (`sellerPlayerId`) همان‌جا بررسی می‌شود.
    await expectRefused(
      'cancelListing',
      () => c.tradeService.cancelListing(BigInt(INTRUDER), listing.listingId),
      /فعال نیست|متعلق به تو نیست/u
    )
    const stillOpen = await db.marketListing.findUniqueOrThrow({
      where: { id: listing.listingId }
    })
    assert.equal(stillOpen.status, 'ACTIVE', 'the listing is still up')
  })

  // ── ۷. کسب‌وکار ──────────────────────────────────────────────────────
  await check('nobody can act on another player business', async () => {
    await expectRefused('upgradeBusiness', () =>
      c.businessService.upgradeBusiness(BigInt(INTRUDER), biz.id)
    )
    await expectRefused('requireOwnedActiveBusiness via listEmployees', () =>
      c.businessService.listEmployees(BigInt(INTRUDER), biz.id)
    )
    // منطقهٔ دوم واقعاً ساخته می‌شود تا دلیلِ رد، مالکیت باشد نه «شعبهٔ تکراری»
    const secondRegion = await db.group.create({
      data: {
        telegramGroupId: BigInt(GROUP - 1),
        title: 'منطقهٔ دومِ آزمون',
        status: 'ACTIVE'
      }
    })
    await expectRefused('openBranch on someone else business', () =>
      c.branchService.openBranch(BigInt(INTRUDER), biz.id, secondRegion.id)
    )
  })

  // ── ۸. شناسهٔ ساختگی هم همان رفتار را دارد ──────────────────────────
  await check('a fabricated id is refused the same way, without a crash', async () => {
    const fake = '00000000-0000-4000-8000-000000000000'
    await expectRefused('furnishProperty(fake)', () =>
      c.housingService.furnishProperty(BigInt(INTRUDER), fake)
    )
    await expectRefused('harvest(fake)', () => c.farmService.harvest(BigInt(INTRUDER), fake))
    await expectRefused('breakEarly(fake)', () =>
      c.depositService.breakEarly(BigInt(INTRUDER), fake)
    )
    await expectRefused('collectIncome(fake)', () =>
      c.branchService.collectIncome(BigInt(INTRUDER), fake)
    )
    await expectRefused(
      'cancelListing(fake)',
      () => c.tradeService.cancelListing(BigInt(INTRUDER), fake),
      /فعال نیست|متعلق به تو نیست|یافت نشد/u
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
