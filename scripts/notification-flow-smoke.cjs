'use strict'
/**
 * سفرِ اعلان‌ها — «اتفاق مهم به بازیکن خبر داده می‌شود؟»
 *
 * سیاست سطح‌ها در `src/modules/notification/push.ts` است:
 *   CRITICAL / IMPORTANT → تختهٔ اعلان + پیام خصوصی
 *   INFORMATIONAL        → فقط تختهٔ اعلان
 *   INTERNAL             → هیچ‌کدام
 *
 * این اسکریپت همان سیاست را روی رخدادِ واقعی می‌آزماید، نه با ماک:
 * ازدواج، هدیهٔ همسر (پولِ رسیدنی)، درخواست قرض، گزارش هفتگی،
 * نتیجهٔ درخواستِ کار (پذیرش/رد/اخراج) و برد در حراجی.
 *
 *   DATABASE_URL=postgresql://.../legacy_ux_test BOT_TOKEN=dummy \
 *     node scripts/notification-flow-smoke.cjs
 */
const assert = require('node:assert/strict')

const url = process.env.DATABASE_URL
if (!url || !new URL(url).pathname.endsWith('_ux_test')) {
  throw new Error('Use a disposable *_ux_test database')
}
process.env.NODE_ENV = 'test'
process.env.BOT_TOKEN ||= '123456:NOTIFY'

const { PrismaClient } = require('@prisma/client')
const { PrismaPg } = require('@prisma/adapter-pg')
const { createJourney } = require('./journey-harness.cjs')
const { weekIndex } = require('../dist/utils/game-time')
const {
  registerPushSender,
  clearPushSender
} = require('../dist/modules/notification/push')

const HUSBAND = 936_000_001
const WIFE = 936_000_002
const LENDER = 936_000_003
const ADMIN = 936_000_004
const GROUP = -936_100_001

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

  const pushed = []
  registerPushSender(async (telegramUserId, text) => {
    pushed.push({ to: telegramUserId.toString(), text })
  })
  const pushesTo = (uid) => pushed.filter((p) => p.to === String(uid))
  const resetPushes = () => pushed.splice(0, pushed.length)

  await db.$executeRawUnsafe('TRUNCATE TABLE players CASCADE')
  await db.$executeRawUnsafe('TRUNCATE TABLE groups CASCADE')
  await db.$executeRawUnsafe('TRUNCATE TABLE user_states')

  // ازدواج نیاز به دو جنسیت متفاوت دارد — مثل بازی واقعی
  for (const [uid, gender] of [
    [HUSBAND, 'MALE'],
    [WIFE, 'FEMALE'],
    [LENDER, 'MALE'],
    [ADMIN, 'MALE']
  ]) {
    await j.command(uid, '/start')
    await j.press(uid, `reg:gender:${gender}`)
    await j.text(uid, `بازیکن ${uid % 1000} که دنبال ساختن آینده است.`)
  }
  await j.command(ADMIN, '/start', GROUP)
  await db.player.updateMany({
    where: { telegramUserId: { in: [BigInt(HUSBAND), BigInt(WIFE), BigInt(LENDER)] } },
    data: { balance: 50_000_000 }
  })

  const husband = await db.player.findUniqueOrThrow({ where: { telegramUserId: BigInt(HUSBAND) } })
  const wife = await db.player.findUniqueOrThrow({ where: { telegramUserId: BigInt(WIFE) } })

  // ── ۱. پیشنهاد ازدواج → برای طرف مقابل CRITICAL است ──
  resetPushes()
  await j.container.marriageService.propose(BigInt(HUSBAND), BigInt(WIFE), 10_000_000)
  const proposal = await db.marriageProposal.findFirstOrThrow({
    where: { proposerId: husband.id, targetId: wife.id },
    orderBy: { createdAt: 'desc' }
  })
  await check('a marriage proposal reaches the target privately', () => {
    const mine = pushesTo(WIFE)
    assert.ok(mine.length >= 1, `target got a private push; got ${JSON.stringify(pushed)}`)
    assert.match(mine[0].text, /پیشنهاد ازدواج/)
    assert.match(mine[0].text, /۱۰٬۰۰۰٬۰۰۰/, 'the offered mahr is stated')
  })

  // ── ۲. ثبت عقد → هر دو خبر می‌گیرند ──
  resetPushes()
  // وقتی خواستگار مهریه را از قبل تعیین کرده، پذیرشِ زن عقد را ثبت می‌کند؛
  // «تأیید مرد» فقط برای حالتی است که زن مهریه را تعیین کرده باشد.
  await j.container.marriageService.acceptProposal(BigInt(WIFE), proposal.id)
  const married = await db.marriage.count({ where: { playerAId: husband.id } })
  if (married === 0) {
    await j.container.marriageService.confirmProposal(BigInt(HUSBAND), proposal.id)
  }
  await check('both spouses are told when the marriage is registered', () => {
    assert.ok(pushesTo(WIFE).length >= 1, 'wife notified')
    assert.ok(pushesTo(HUSBAND).length >= 1, 'husband notified')
    assert.ok(
      [...pushesTo(WIFE), ...pushesTo(HUSBAND)].some((p) => /عقد ثبت شد/.test(p.text)),
      'the message says the marriage was registered'
    )
  })

  // ── ۳. هدیهٔ همسر = پولِ رسیدنی → CRITICAL ──
  await j.text(HUSBAND, 'خانواده', GROUP)
  const familyPanel = j.panel(GROUP, /خانواده/)
  assert.ok(familyPanel, 'family panel opened')
  const giftButton = familyPanel.buttons.find((b) => b.data === 'fam:gift')
  assert.ok(giftButton, `gift button present; got ${JSON.stringify(familyPanel.buttons)}`)
  await j.press(HUSBAND, 'fam:gift', GROUP)
  resetPushes()
  await j.text(HUSBAND, '2500000', GROUP)

  await check('a gift from the spouse pushes to the receiver with the amount', () => {
    const mine = pushesTo(WIFE)
    assert.ok(mine.length >= 1, `wife got a private push; got ${JSON.stringify(pushed)}`)
    assert.match(mine[0].text, /۲٬۵۰۰٬۰۰۰/)
    assert.match(mine[0].text, /هدیه/)
  })
  await check('the gift really moved money', async () => {
    const after = await db.player.findUniqueOrThrow({ where: { id: wife.id }, select: { balance: true } })
    assert.ok(Number(after.balance) > 50_000_000, `wife balance grew; got ${after.balance}`)
  })

  // ── ۴. درخواست قرض → وام‌دهنده باید بداند چه کسی خواسته ──
  await j.text(LENDER, 'سلام، من وام‌دهنده‌ام', GROUP)
  const lenderMessageId = [...j.messages]
    .reverse()
    .find((m) => m.owner?.id === LENDER && m.method === 'incoming').id

  const borrowerUid = HUSBAND
  await j.text(borrowerUid, 'قرض', GROUP)
  const loanPanel = j.panel(GROUP, /قرض/)
  const startRequest = loanPanel.buttons.find((b) => b.data === 'loan:start_request')
  assert.ok(startRequest, `loan request button present; got ${JSON.stringify(loanPanel.buttons)}`)
  await j.press(borrowerUid, 'loan:start_request', GROUP)
  resetPushes()
  await j.replyText(borrowerUid, lenderMessageId, '3000000', GROUP)

  await check('a loan request names the borrower in the lender notification', () => {
    const mine = pushesTo(LENDER)
    assert.ok(mine.length >= 1, `lender got a private push; got ${JSON.stringify(pushed)}`)
    assert.doesNotMatch(mine[0].text, /یک بازیکن/, 'no anonymous placeholder')
    assert.match(mine[0].text, /درخواست قرض/)
    assert.match(mine[0].text, /۳٬۰۰۰٬۰۰۰/)
  })

  // ── ۵. گزارش هفتگی = INFORMATIONAL → فقط تخته، بدون مزاحمت ──
  resetPushes()
  const report = await j.container.reportService.getReport(BigInt(WIFE))
  const boardWritten = await j.container.reportService.sendToNotifications(BigInt(WIFE), report)
  await check('an informational event stays in the board and does not push', () => {
    assert.equal(pushesTo(WIFE).length, 0, `no private push for informational; got ${JSON.stringify(pushed)}`)
    assert.ok(boardWritten !== undefined, 'the board write ran')
  })
  await check('the informational event is still readable in the board', async () => {
    const rows = await db.notification.findMany({
      where: { playerId: wife.id, title: { contains: 'گزارش هفتگی' } }
    })
    assert.ok(rows.length >= 1, 'weekly report row exists in the board')
  })

  // ── ۶. سطح INTERNAL هیچ ردیفی نمی‌سازد ──
  const beforeCount = await db.notification.count({ where: { playerId: wife.id } })
  await j.container.notificationService.notifyPlayerById(
    wife.id,
    'داخلی',
    'این نباید دیده شود',
    undefined,
    undefined,
    'INTERNAL'
  )
  await check('an INTERNAL event is never stored', async () => {
    assert.equal(await db.notification.count({ where: { playerId: wife.id } }), beforeCount)
  })

  // ── ۷. dedupeKey جلوی اعلانِ تکراری را می‌گیرد ──
  const dupBefore = pushesTo(WIFE).length
  const first = await j.container.notificationService.notifyPlayerById(
    wife.id,
    '🎉 رخداد',
    'یک بار',
    undefined,
    `dedupe-probe:${wife.id}`,
    'CRITICAL'
  )
  const second = await j.container.notificationService.notifyPlayerById(
    wife.id,
    '🎉 رخداد',
    'یک بار',
    undefined,
    `dedupe-probe:${wife.id}`,
    'CRITICAL'
  )
  await check('the same event does not notify twice', () => {
    assert.equal(first, true, 'first write happened')
    assert.equal(second, false, 'duplicate refused by the unique key')
    assert.equal(pushesTo(WIFE).length, dupBefore + 1, 'pushed exactly once')
  })

  // ── ۹. نتیجهٔ درخواستِ کار: پذیرش و رد هر دو به متقاضی خبر می‌دهند ──
  await db.player.update({
    where: { id: husband.id },
    data: { balance: 500_000_000, experience: 1000 }
  })
  const blueprint = j.container.businessService.getBlueprints()[0]
  const { business: employerBiz } = await j.container.businessService.createBusiness(
    BigInt(HUSBAND),
    blueprint.modelType,
    'کارگاهِ آزمون'
  )
  const posting = await j.container.businessService.postJob(BigInt(HUSBAND), employerBiz.id, {
    title: 'نگهبان شب',
    salaryPerMinute: 900,
    capacity: 1,
    minExperience: 0,
    minAge: null,
    maxAge: null,
    requiredDegree: null,
    requiredSkill: null
  })
  await j.container.businessService.applyForJob(BigInt(LENDER), posting.id)
  const application = await db.jobApplication.findFirstOrThrow({
    where: { playerId: (await db.player.findUniqueOrThrow({
      where: { telegramUserId: BigInt(LENDER) }
    })).id },
    orderBy: { createdAt: 'desc' }
  })

  resetPushes()
  await j.container.businessService.hireEmployee(BigInt(HUSBAND), application.id)
  await new Promise((r) => setTimeout(r, 150))
  await check('an applicant is told when the employer hires them', () => {
    const mine = pushesTo(LENDER)
    assert.equal(mine.length, 1, `exactly one push; got ${JSON.stringify(mine)}`)
    assert.match(mine[0].text, /پذیرفته شد/u)
    assert.match(mine[0].text, /کارگاهِ آزمون/u, 'names the employer')
    assert.match(mine[0].text, /نگهبان شب/u, 'names the role')
    assert.match(mine[0].text, /۹۰۰/u, 'states the wage')
  })

  // ── ۱۰. ردِ درخواست هم بی‌خبر نمی‌ماند ──
  const posting2 = await j.container.businessService.postJob(BigInt(HUSBAND), employerBiz.id, {
    title: 'راننده',
    salaryPerMinute: 700,
    capacity: 1,
    minExperience: 0,
    minAge: null,
    maxAge: null,
    requiredDegree: null,
    requiredSkill: null
  })
  await db.businessEmployee.updateMany({
    where: { businessId: employerBiz.id },
    data: { isActive: false }
  })
  await j.container.businessService.applyForJob(BigInt(LENDER), posting2.id)
  const application2 = await db.jobApplication.findFirstOrThrow({
    where: { jobPostingId: posting2.id },
    orderBy: { createdAt: 'desc' }
  })
  resetPushes()
  await j.container.businessService.rejectApplication(BigInt(HUSBAND), application2.id)
  await new Promise((r) => setTimeout(r, 150))
  await check('an applicant is told when the employer rejects them', () => {
    const mine = pushesTo(LENDER)
    assert.equal(mine.length, 1, `exactly one push; got ${JSON.stringify(mine)}`)
    assert.match(mine[0].text, /رد شد/u)
    assert.match(mine[0].text, /راننده/u, 'names the role that was refused')
  })

  // ── ۱۱. اخراج‌شده می‌فهمد همکاری تمام شده و چه‌قدر گرفته ──
  await db.businessEmployee.updateMany({
    where: { businessId: employerBiz.id },
    data: { isActive: true }
  })
  resetPushes()
  await j.container.businessService.fireEmployee(BigInt(HUSBAND), employerBiz.id, application.playerId)
  await new Promise((r) => setTimeout(r, 150))
  await check('a fired employee is told, with the settlement outcome', () => {
    const mine = pushesTo(LENDER)
    assert.equal(mine.length, 1, `exactly one push; got ${JSON.stringify(mine)}`)
    assert.match(mine[0].text, /همکاری پایان یافت/u)
    assert.match(mine[0].text, /کارگاهِ آزمون/u, 'names the employer')
    assert.match(mine[0].text, /تسویه|بدهی/u, 'says what happened to the wages')
  })

  // ── ۱۲. برندهٔ حراجی خبر می‌شود (تحویل Lazy است) ──
  const lender = await db.player.findUniqueOrThrow({
    where: { telegramUserId: BigInt(LENDER) }
  })
  // weekKey یک Int است؛ هفته‌ای در گذشته می‌گذاریم تا closeDue آن را سررسید ببیند
  const week = weekIndex() - 1
  await db.auction.create({
    data: {
      groupId: (await db.group.findFirstOrThrow()).id,
      itemKey: 'probe-item',
      itemName: 'جامِ آزمون',
      weekKey: week,
      startingBid: 100_000,
      currentBid: 2_500_000,
      highestBidderId: lender.id
    }
  })
  resetPushes()
  await j.container.auctionService.closeDue((await db.group.findFirstOrThrow()).id)
  await new Promise((r) => setTimeout(r, 150))
  await check('an auction winner is told they won and received the item', () => {
    const mine = pushesTo(LENDER)
    assert.equal(mine.length, 1, `exactly one push; got ${JSON.stringify(mine)}`)
    assert.match(mine[0].text, /برندهٔ حراجی شدی/u)
    assert.match(mine[0].text, /جامِ آزمون/u, 'names the item')
    assert.match(mine[0].text, /۲٬۵۰۰٬۰۰۰/u, 'states the winning bid')
  })

  clearPushSender()
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
