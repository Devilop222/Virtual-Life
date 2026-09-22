import { InheritanceStatus, PlayerStatus } from '@prisma/client'
import { createFakeDb } from './helpers/fake-db'
import { InheritanceService } from '../src/modules/inheritance/inheritance.service'
import { DeathService, DEATH_CAUSE } from '../src/modules/inheritance/death.service'
import { WillService } from '../src/modules/inheritance/will.service'
import { parseHeirInput, validateHeir } from '../src/modules/inheritance/will-core'
import { renderWillPanel } from '../src/bot/renders'

// ─────────────────────────────────────────────────────────────────────────────
//  دیتای پایه: یک بازیکن با «همهٔ انواع دارایی» و یک وارث
// ─────────────────────────────────────────────────────────────────────────────

const DECEASED = 'p-a'
const HEIR = 'p-b'
const LENDER = 'p-c'

const eventStub = () => ({ recordPlayerEvent: jest.fn().mockResolvedValue(undefined) }) as never
const notifyStub = () => ({ notifyPlayerById: jest.fn().mockResolvedValue(true) }) as never

function seedEstate(overrides: Record<string, unknown[]> = {}) {
  return createFakeDb({
    players: [
      {
        id: DECEASED,
        telegramUserId: 1001n,
        firstName: 'آرش',
        lastName: 'ک.',
        username: 'arash',
        status: PlayerStatus.ACTIVE,
        // زنده و سالم؛ آزمون‌های مرگ خودشان سلامت را صفر می‌کنند
        health: 100,
        balance: 5_000_000,
        // منطقهٔ اقامت: نیمهٔ صندوقِ میراث باید جایی برای رسیدن داشته باشد
        homeGroupId: 'g1'
      },
      {
        id: HEIR,
        telegramUserId: 1002n,
        firstName: 'سارا',
        lastName: 'م.',
        username: 'sara',
        status: PlayerStatus.ACTIVE,
        health: 100,
        balance: 100_000
      },
      {
        id: LENDER,
        telegramUserId: 1003n,
        firstName: 'نیما',
        lastName: 'ر.',
        username: 'nima',
        status: PlayerStatus.ACTIVE,
        balance: 0
      }
    ],
    wills: [{ id: 'w-1', ownerId: DECEASED, heirId: HEIR, note: 'مراقب باغچه باش.' }],
    accounts: [{ id: 'acc-1', playerId: DECEASED, balance: 2_000_000 }],
    loans: [
      {
        id: 'loan-1',
        playerId: DECEASED,
        status: 'ACTIVE',
        principalAmount: 1_000_000,
        totalRepaymentAmount: 1_200_000,
        remainingAmount: 1_000_000,
        dueAt: new Date('2026-01-01T00:00:00Z')
      }
    ],
    playerLoans: [
      {
        id: 'ploan-1',
        lenderId: LENDER,
        borrowerId: DECEASED,
        status: 'ACTIVE',
        principal: 500_000,
        totalRepay: 550_000,
        feeRate: 0.1
      }
    ],
    properties: [{ id: 'prop-1', ownerId: DECEASED, title: 'آپارتمان' }],
    businesses: [{ id: 'biz-1', ownerId: DECEASED, name: 'کافه' }],
    deposits: [{ id: 'dep-1', playerId: DECEASED, status: 'ACTIVE', principal: 300_000 }],
    inventory: [{ id: 'inv-1', playerId: DECEASED, itemId: 'item-1', quantity: 3 }],
    pets: [{ id: 'pet-1', playerId: DECEASED, name: 'پیشی' }],
    ...overrides
  })
}

function services(fake: ReturnType<typeof seedEstate>) {
  const inheritance = new InheritanceService(
    fake.db,
    eventStub() as never,
    fake.poolStub as never,
    notifyStub() as never
  )
  const death = new DeathService(
    fake.db,
    inheritance,
    notifyStub() as never,
    eventStub() as never
  )
  const will = new WillService(
    fake.db,
    eventStub() as never,
    death,
    inheritance,
    notifyStub() as never
  )
  return { inheritance, death, will }
}

const playerById = (fake: ReturnType<typeof seedEstate>, id: string) =>
  fake.state.players.find((p) => p.id === id)!

/** به صفر رساندن سلامت و سپس اجرای مسیر مرگ — همان کاری که بازی می‌کند. */
function die(fake: ReturnType<typeof seedEstate>, id = DECEASED): void {
  playerById(fake, id).health = 0
}

// ─────────────────────────────────────────────────────────────────────────────
//  قواعد هستهٔ وصیت
// ─────────────────────────────────────────────────────────────────────────────

describe('هستهٔ وصیت — اعتبارسنجی وارث و پارس ورودی', () => {
  test('وارث نمی‌تواند خودِ بازیکن باشد', () => {
    expect(
      validateHeir('p-a', { id: 'p-a', firstName: 'آرش', lastName: null, status: PlayerStatus.ACTIVE })
    ).toBe('self')
  })

  test('وارثِ زنده و فعال پذیرفته می‌شود', () => {
    expect(
      validateHeir('p-a', { id: 'p-b', firstName: 'سارا', lastName: null, status: PlayerStatus.ACTIVE })
    ).toBeNull()
  })

  test('حسابِ مرده، محروم و بی‌فعالیت وارث نمی‌شود', () => {
    const base = { id: 'p-x', firstName: 'x', lastName: null }
    expect(validateHeir('p-a', { ...base, status: PlayerStatus.DEAD })).toBe('deceased')
    expect(validateHeir('p-a', { ...base, status: PlayerStatus.BANNED })).toBe('banned')
    expect(validateHeir('p-a', { ...base, status: PlayerStatus.INACTIVE })).toBe('inactive')
    expect(validateHeir('p-a', null)).toBe('not_found')
  })

  test('ورودی بازیکن به سه شکل درست خوانده می‌شود و شکل مبهم رد می‌شود', () => {
    expect(parseHeirInput('123456789')).toEqual({ kind: 'telegram_id', value: 123456789n })
    expect(parseHeirInput('۱۲۳۴۵۶۷۸۹')).toEqual({ kind: 'telegram_id', value: 123456789n })
    expect(parseHeirInput('@Sara_92')).toEqual({ kind: 'username', value: 'sara_92' })
    expect(parseHeirInput('سلام')).toEqual({ kind: 'invalid' })
    expect(parseHeirInput('')).toEqual({ kind: 'invalid' })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
//  سرویس وصیت
// ─────────────────────────────────────────────────────────────────────────────

describe('WillService — نوشتن، عوض‌کردن و لغوِ وصیت', () => {
  test('ثبت وارث با upsert انجام می‌شود و پنل خلاصهٔ واقعی دارایی را می‌دهد', async () => {
    const fake = seedEstate({ wills: [] })
    const { will } = services(fake)

    const result = await will.setHeir(1001n, HEIR)
    expect(result.heirName).toBe('سارا م.')
    expect(result.changed).toBe(true)
    expect(fake.state.wills).toHaveLength(1)

    const view = await will.getView(1001n)
    expect(view.hasWill).toBe(true)
    expect(view.heirName).toBe('سارا م.')
    // همان عددی که لحظهٔ مرگ استفاده می‌شود، نه فرمول دوم
    expect(view.estate.wallet).toBe(5_000_000)
    expect(view.estate.bank).toBe(2_000_000)
    expect(view.estate.properties).toBe(1)
    expect(view.estate.businesses).toBe(1)
  })

  test('تغییر وارث ردیف دوم نمی‌سازد و لغو، وصیت را برمی‌دارد', async () => {
    const fake = seedEstate({ wills: [] })
    const { will } = services(fake)

    await will.setHeir(1001n, HEIR)
    const again = await will.setHeir(1001n, LENDER)
    expect(again.changed).toBe(true)
    expect(fake.state.wills).toHaveLength(1)
    expect(fake.state.wills[0]!.heirId).toBe(LENDER)

    const same = await will.setHeir(1001n, LENDER)
    expect(same.changed).toBe(false)

    await will.cancel(1001n)
    expect(fake.state.wills).toHaveLength(0)
  })

  test('شناسهٔ نامعتبر (خود، مرده، مبهم) هیچ وصیتی ثبت نمی‌کند', async () => {
    const fake = seedEstate({ wills: [] })
    const { will } = services(fake)

    await expect(will.setHeir(1001n, DECEASED)).rejects.toThrow()
    await expect(
      will.resolveTarget(1001n, { kind: 'invalid' })
    ).rejects.toThrow()
    await expect(
      will.resolveTarget(1001n, { kind: 'telegram_id', value: 999999n })
    ).rejects.toThrow()
    expect(fake.state.wills).toHaveLength(0)
  })

  test('وصیتِ نیمه‌کاره‌ای که وارثش مرده است، در پنل هشدار می‌دهد', async () => {
    const fake = seedEstate()
    fake.state.players.find((p) => p.id === HEIR)!.status = PlayerStatus.DEAD
    const { will } = services(fake)

    const view = await will.getView(1001n)
    expect(view.hasWill).toBe(true)
    expect(view.heirInvalidReason).toContain('زنده نیست')
    // پنل باید همان وضعیت نامعتبر را نشان دهد، نه نامِ وارثِ مرده
    expect(renderWillPanel(view)).not.toContain('*سارا م.*')
  })

  test('شخصیتِ مرده نمی‌تواند وصیتش را عوض کند', async () => {
    const fake = seedEstate()
    fake.state.players.find((p) => p.id === DECEASED)!.status = PlayerStatus.DEAD
    const { will } = services(fake)
    await expect(will.setHeir(1001n, LENDER)).rejects.toMatchObject({
      persianMessage: expect.stringContaining('از دنیا رفته')
    })
    expect(fake.state.wills[0]!.heirId).toBe(HEIR)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
//  مرگ
// ─────────────────────────────────────────────────────────────────────────────

describe('DeathService — ثبت یک‌بارهٔ مرگ', () => {
  test('سلامت صفر مرگ را فقط یک‌بار ثبت می‌کند و شیفتِ باز را می‌بندد', async () => {
    const fake = seedEstate({
      sessions: [{ id: 's-1', playerId: DECEASED, status: 'ACTIVE' }]
    })
    const { death, inheritance } = services(fake)
    die(fake)

    const first = await death.checkHealth(DECEASED)
    expect(first?.newlyDead).toBe(true)

    // اجرای دوباره: نه پروندهٔ دوم، نه بازنویسی وضعیت
    const second = await death.checkHealth(DECEASED)
    expect(second).toBeNull()

    await death.registerDeath(DECEASED, DEATH_CAUSE.admin)
    expect(fake.state.cases).toHaveLength(1)
    expect(fake.state.sessions[0]!.status).toBe('CANCELLED')

    // میراث واقعاً اجرا شده و شخصیت صفرِ پول است
    const status = await fake.db.inheritanceCase.findFirst({ where: { deceasedId: DECEASED } })
    expect(status!.status).toBe(InheritanceStatus.COMPLETED)
    expect(playerById(fake, DECEASED).balance).toBe(0)
    void inheritance
  })

  test('وضعیتی که مسیر دیگری DEAD کرده و پرونده ندارد، پذیرش می‌شود', async () => {
    // پنل ادمین می‌تواند وضعیت را مستقیم فوت‌شده کند. اگر ثبت مرگ این حالت را
    // «قبلاً مرده» بشمارد، پروندهٔ میراث هرگز ساخته نمی‌شود و دارایی برای همیشه
    // بلاتکلیف می‌ماند.
    const fake = seedEstate()
    const { death } = services(fake)
    playerById(fake, DECEASED).status = 'DEAD'
    playerById(fake, DECEASED).health = 0

    const result = await death.registerDeath(DECEASED, DEATH_CAUSE.admin)
    expect(result.newlyDead).toBe(true)

    const opened = await fake.db.inheritanceCase.findFirst({ where: { deceasedId: DECEASED } })
    expect(opened!.status).toBe(InheritanceStatus.COMPLETED)
    expect(playerById(fake, HEIR).balance).toBeGreaterThan(0)
  })

  test('بازیکنِ زنده با سلامت مثبت هیچ پرونده‌ای نمی‌سازد', async () => {
    const fake = seedEstate()
    fake.state.players.find((p) => p.id === HEIR)!.health = 50
    const { death } = services(fake)
    expect(await death.checkHealth(HEIR)).toBeNull()
    expect(fake.state.cases).toHaveLength(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
//  اجرای میراث — مسیر کامل
// ─────────────────────────────────────────────────────────────────────────────

describe('InheritanceService — انتقال کامل دارایی و بدهی', () => {
  test('پول، ملک، کسب‌وکار، سپرده، انبار و حیوان به وارث می‌رسد', async () => {
    const fake = seedEstate()
    const { death } = services(fake)
    await death.registerDeath(DECEASED, DEATH_CAUSE.health)

    const heir = playerById(fake, HEIR)
    const lender = playerById(fake, LENDER)

    // بدهی بانکی (۱٬۰۰۰٬۰۰۰) و قرض بازیکنی (۵۵۰٬۰۰۰) از پول نقد تسویه شد.
    // باقی نقد ۵٬۴۵۰٬۰۰۰ تومان بود (۳٬۴۵۰٬۰۰۰ کیف + ۲٬۰۰۰٬۰۰۰ بانک) و
    // *نصفِ* آن به وارث رسید؛ نصفِ دیگر به صندوق منطقه رفت.
    expect(playerById(fake, DECEASED).balance).toBe(0)
    expect(heir.balance).toBe(100_000 + 2_725_000)
    expect(lender.balance).toBe(550_000)
    expect(fake.state.pool[0]!.balance).toBe(1_000_000)
    expect(fake.state.accounts[0]!.balance).toBe(0)

    // طبقه‌بندی بدهی‌ها دقیقاً ثبت شده
    const debtLoan = fake.state.loans[0]!
    expect(debtLoan.status).toBe('PAID')
    expect(debtLoan.remainingAmount).toBe(0)
    expect(fake.state.playerLoans[0]!.status).toBe('PAID')

    // مالکیت‌ها منتقل شده و هیچ ردیفی بی‌مالک نمانده
    expect(fake.state.properties[0]!.ownerId).toBe(HEIR)
    expect(fake.state.businesses[0]!.ownerId).toBe(HEIR)
    expect(fake.state.deposits[0]!.playerId).toBe(HEIR)
    expect(fake.state.inventory[0]!.playerId).toBe(HEIR)
    expect(fake.state.pets[0]!.playerId).toBe(HEIR)

    const settled = fake.state.cases[0]!
    expect(settled.status).toBe(InheritanceStatus.COMPLETED)
    expect(settled.cashTransferred).toBe(2_725_000)
    expect(settled.debtSettled).toBe(1_550_000)
    expect(settled.debtUnpaid).toBe(0)
    expect(settled.propertiesCount).toBe(1)
    expect(settled.businessesCount).toBe(1)
    // سپرده، انبار و حیوان — سه ردیفِ انتقال‌پذیرِ باقی‌مانده.
    expect(settled.holdingsCount).toBe(3)
    expect(settled.completedAt).toBeInstanceOf(Date)
  })

  test('پول ساخته یا سوزانده نمی‌شود: جمع کل قبل و بعد یکی است', async () => {
    const fake = seedEstate()
    // صندوق منطقه هم بخشی از پول بازی است؛ نیمهٔ صندوقِ میراث آنجا می‌نشیند
    // و همین‌جا شمرده می‌شود، وگرنه «نابودیِ بی‌ردیف» به نظر می‌رسید.
    const total = () =>
      fake.state.players.reduce((sum, p) => sum + Number(p.balance ?? 0), 0) +
      fake.state.accounts.reduce((sum, a) => sum + Number(a.balance ?? 0), 0) +
      Number(fake.state.pool[0]!.balance) +
      fake.state.regionStats.reduce((sum, s) => sum + Number(s.taxRevenue ?? 0), 0)

    const before = total()
    const { death } = services(fake)
    await death.registerDeath(DECEASED, DEATH_CAUSE.health)

    // هیچ تومانی نه ساخته و نه گم: ۲٬۷۲۵٬۰۰۰ به وارث و ۲٬۷۲۵٬۰۰۰ به صندوق
    expect(total()).toBe(before)
    expect(fake.state.regionStats.reduce((sum, s) => sum + Number(s.taxRevenue ?? 0), 0)).toBe(
      2_725_000
    )
  })

  test('هر انتقالِ پول ردیف دفتری دارد و جهت‌ها درست‌اند', async () => {
    const fake = seedEstate()
    const { death } = services(fake)
    await death.registerDeath(DECEASED, DEATH_CAUSE.health)

    const rows = fake.state.transactions
    // نیمهٔ وارث: یک ردیف انتقال با مقصدِ وارث
    const inheritance = rows.filter((r) => r.type === 'INHERITANCE_TRANSFER')
    expect(inheritance).toHaveLength(1)
    for (const row of inheritance) {
      expect(row.sourcePlayerId).toBe(DECEASED)
      expect(row.destinationPlayerId).toBe(HEIR)
    }
    expect(inheritance.reduce((sum, r) => sum + Number(r.amount), 0)).toBe(2_725_000)

    // نیمهٔ صندوق: ردیفِ صریحِ بی‌وارث با منبعِ متوفی و همان مبلغ
    const sink = rows.filter((r) => r.type === 'UNCLAIMED_ESTATE')
    expect(sink).toHaveLength(1)
    expect(sink[0]!.sourcePlayerId).toBe(DECEASED)
    expect(sink[0]!.amount).toBe(2_725_000)

    // پرداخت ۱٬۰۰۰٬۰۰۰ تومانی بین اصل و سود تقسیم می‌شود: سهم سود
    // ۲۰۰٬۰۰۰/۱٬۲۰۰٬۰۰۰ است، پس اصل ۸۳۳٬۳۳۳ و سود ۱۶۶٬۶۶۷ می‌شود.
    const bankRepay = rows.find((r) => r.type === 'LOAN_REPAYMENT')!
    expect(bankRepay.sourcePlayerId).toBe(DECEASED)
    expect(bankRepay.amount).toBe(833_333)
    expect(rows.find((r) => r.type === 'LOAN_INTEREST')!.amount).toBe(166_667)
    const p2p = rows.find((r) => r.type === 'P2P_LOAN_REPAY')!
    expect(p2p.destinationPlayerId).toBe(LENDER)
    expect(p2p.amount).toBe(550_000)
  })

  test('اجرای دوباره پروندهٔ بسته، هیچ پولی دوبار منتقل نمی‌کند', async () => {
    const fake = seedEstate()
    const { death, inheritance } = services(fake)
    await death.registerDeath(DECEASED, DEATH_CAUSE.health)

    const heirAfterFirst = playerById(fake, HEIR).balance
    const txAfterFirst = fake.state.transactions.length

    await inheritance.runForDeceased(DECEASED)
    await inheritance.runForDeceased(DECEASED)

    expect(playerById(fake, HEIR).balance).toBe(heirAfterFirst)
    expect(fake.state.transactions).toHaveLength(txAfterFirst)
    expect(fake.state.cases).toHaveLength(1)
  })

  test('دو اجرای هم‌زمان فقط یک‌بار هر مرحله را می‌برند', async () => {
    const fake = seedEstate()
    const { inheritance } = services(fake)
    // پرونده را دستی باز می‌کنیم (بدون مرگ) تا دو اجرای موازی بگیریم
    await fake.db.inheritanceCase.create({
      data: { deceasedId: DECEASED, cause: DEATH_CAUSE.health }
    })
    await fake.db.player.update({
      where: { id: DECEASED },
      data: { status: PlayerStatus.DEAD }
    })

    await Promise.all([
      inheritance.runForDeceased(DECEASED),
      inheritance.runForDeceased(DECEASED)
    ])

    // یک بار انتقال: نه دو برابر پول، نه دو ردیف اضافه
    expect(playerById(fake, HEIR).balance).toBe(100_000 + 2_725_000)
    expect(fake.state.transactions.filter((r) => r.type === 'INHERITANCE_TRANSFER')).toHaveLength(1)
    expect(fake.state.cases[0]!.status).toBe(InheritanceStatus.COMPLETED)
  })

  test('restart وسط کار: پرونده از همان مرحله ادامه می‌یابد', async () => {
    const fake = seedEstate()
    const { inheritance } = services(fake)
    await fake.db.inheritanceCase.create({
      data: {
        deceasedId: DECEASED,
        cause: DEATH_CAUSE.health,
        status: InheritanceStatus.SETTLED_DEBTS,
        heirId: HEIR
      }
    })
    await fake.db.player.update({
      where: { id: DECEASED },
      data: { status: PlayerStatus.DEAD, balance: 4_000_000 }
    })

    await inheritance.runForDeceased(DECEASED)

    // مرحلهٔ بدهی دوباره اجرا نشد (وام دست‌نخورده ماند) ولی پول منتقل شد
    expect(fake.state.loans[0]!.status).toBe('ACTIVE')
    // ۶٬۰۰۰٬۰۰۰ نقد (۴٬۰۰۰٬۰۰۰ کیف + ۲٬۰۰۰٬۰۰۰ بانک) → نیمهٔ وارث ۳٬۰۰۰٬۰۰۰
    expect(playerById(fake, HEIR).balance).toBe(100_000 + 3_000_000)
    expect(fake.state.cases[0]!.status).toBe(InheritanceStatus.COMPLETED)
  })

  test('خطای مرحله، پول را نیمه‌کاره جابه‌جا نمی‌کند و قابل تلاش دوباره است', async () => {
    const fake = seedEstate()
    const { inheritance } = services(fake)
    await fake.db.inheritanceCase.create({
      data: {
        deceasedId: DECEASED,
        cause: DEATH_CAUSE.health,
        status: InheritanceStatus.SETTLED_DEBTS,
        heirId: HEIR
      }
    })
    await fake.db.player.update({
      where: { id: DECEASED },
      data: { status: PlayerStatus.DEAD, balance: 1_000_000 }
    })

    const broken = fake.db.bankAccount as unknown as {
      updateMany: (...args: unknown[]) => Promise<unknown>
    }
    const original = broken.updateMany
    broken.updateMany = async () => {
      throw new Error('db down')
    }

    await inheritance.runForDeceased(DECEASED)

    // نه پولی منتقل شد، نه وضعیت جلو رفت — و خطا ثبت شد
    expect(fake.state.cases[0]!.status).toBe(InheritanceStatus.SETTLED_DEBTS)
    expect(playerById(fake, DECEASED).balance).toBe(1_000_000)
    expect(playerById(fake, HEIR).balance).toBe(100_000)
    expect(fake.state.cases[0]!.lastError).toContain('db down')

    // تلاش دوباره پس از رفع خطا، انتقال را کامل می‌کند
    broken.updateMany = original
    await inheritance.retry(String(fake.state.cases[0]!.id))
    expect(fake.state.cases[0]!.status).toBe(InheritanceStatus.COMPLETED)
    // ۳٬۰۰۰٬۰۰۰ نقد (۱٬۰۰۰٬۰۰۰ کیف + ۲٬۰۰۰٬۰۰۰ بانک) → نیمهٔ وارث ۱٬۵۰۰٬۰۰۰
    expect(playerById(fake, HEIR).balance).toBe(100_000 + 1_500_000)
  })

  test('ترمیمِ خودکار: پروندهٔ نیمه‌کاره در چرخهٔ دوره‌ای تمام می‌شود', async () => {
    const fake = seedEstate()
    const { inheritance } = services(fake)
    await fake.db.inheritanceCase.create({
      data: {
        deceasedId: DECEASED,
        cause: DEATH_CAUSE.health,
        status: InheritanceStatus.SETTLED_DEBTS,
        heirId: HEIR,
        lastError: 'connection reset'
      }
    })
    await fake.db.player.update({
      where: { id: DECEASED },
      data: { status: PlayerStatus.DEAD, balance: 1_000_000 }
    })

    expect(await inheritance.recoverStalled()).toBe(1)
    expect(fake.state.cases[0]!.status).toBe(InheritanceStatus.COMPLETED)
    // ۳٬۰۰۰٬۰۰۰ نقد → نیمهٔ وارث ۱٬۵۰۰٬۰۰۰
    expect(playerById(fake, HEIR).balance).toBe(100_000 + 1_500_000)

    // پروندهٔ بسته دیگر کاندید ترمیم نیست (نه دوباره پول منتقل می‌شود)
    expect(await inheritance.recoverStalled()).toBe(0)
  })

  test('پروندهٔ بدون وارث در چرخهٔ ترمیم دست نمی‌خورد', async () => {
    const fake = seedEstate({ wills: [] })
    const { death, inheritance } = services(fake)
    await death.registerDeath(DECEASED, DEATH_CAUSE.health)
    expect(fake.state.cases[0]!.status).toBe(InheritanceStatus.NO_HEIR)
    expect(await inheritance.recoverStalled()).toBe(0)
    expect(playerById(fake, DECEASED).balance).toBe(5_000_000)
  })

  test('بدون وصیت: دارایی محفوظ می‌ماند و پرونده «بدون وارث» باز می‌ماند', async () => {
    const fake = seedEstate({ wills: [] })
    const { death } = services(fake)
    await death.registerDeath(DECEASED, DEATH_CAUSE.health)

    expect(fake.state.cases[0]!.status).toBe(InheritanceStatus.NO_HEIR)
    expect(playerById(fake, DECEASED).balance).toBe(5_000_000)
    expect(playerById(fake, HEIR).balance).toBe(100_000)
    expect(fake.state.properties[0]!.ownerId).toBe(DECEASED)
    expect(fake.state.transactions).toHaveLength(0)
  })

  test('داراییِ ناکافی: بدهی حذف نمی‌شود و کسری‌اش ثبت می‌ماند', async () => {
    const fake = seedEstate({ accounts: [] })
    playerById(fake, DECEASED).balance = 200_000
    const { death } = services(fake)
    await death.registerDeath(DECEASED, DEATH_CAUSE.health)

    const settled = fake.state.cases[0]!
    // ۲۰۰٬۰۰۰ به بدهی بانکی رفت و بقیه‌اش (۱٬۳۵۰٬۰۰۰) به‌عنوان بدهیِ پوشش‌داده‌نشده ثبت شد
    expect(settled.debtSettled).toBe(200_000)
    expect(settled.debtUnpaid).toBe(1_350_000)
    expect(fake.state.loans[0]!.status).toBe('ACTIVE')
    expect(playerById(fake, HEIR).balance).toBe(100_000)
    // بدهی «پاک» نشده: همان چیزی که ماند، هنوز روی قرارداد است
    expect(fake.state.loans[0]!.remainingAmount).toBe(800_000)
  })

  test('درخواست قرضِ بازِ متوفی رد می‌شود تا پول به حساب مرده نرسد', async () => {
    const fake = seedEstate({
      playerLoans: [
        {
          id: 'ploan-pending',
          lenderId: LENDER,
          borrowerId: DECEASED,
          status: 'PENDING',
          principal: 400_000,
          totalRepay: 440_000,
          feeRate: 0.1
        }
      ]
    })
    const { death } = services(fake)
    await death.registerDeath(DECEASED, DEATH_CAUSE.health)
    expect(fake.state.playerLoans[0]!.status).toBe('REJECTED')
    expect(playerById(fake, LENDER).balance).toBe(0)
  })

  test('حیوانِ خانگی وقتی وارث خودش حیوان دارد منتقل نمی‌شود (قید یکتایی)', async () => {
    const fake = seedEstate({
      pets: [
        { id: 'pet-a', playerId: DECEASED, name: 'پیشی' },
        { id: 'pet-b', playerId: HEIR, name: 'توله' }
      ]
    })
    const { death } = services(fake)
    await death.registerDeath(DECEASED, DEATH_CAUSE.health)

    expect(fake.state.pets.find((p) => p.id === 'pet-b')!.playerId).toBe(HEIR)
    expect(fake.state.pets.find((p) => p.id === 'pet-a')!.playerId).toBe(DECEASED)
    // سپرده و انبار منتقل شده‌اند؛ حیوان نه (وارث خودش حیوان دارد).
    expect(fake.state.cases[0]!.holdingsCount).toBe(2)
  })

  test('طلبی که متوفی از بازیکنان داشت به وارث می‌رسد', async () => {
    const fake = seedEstate({
      playerLoans: [
        {
          id: 'ploan-recv',
          lenderId: DECEASED,
          borrowerId: LENDER,
          status: 'ACTIVE',
          principal: 700_000,
          totalRepay: 770_000,
          feeRate: 0.1
        }
      ]
    })
    const { death } = services(fake)
    await death.registerDeath(DECEASED, DEATH_CAUSE.health)
    expect(fake.state.playerLoans[0]!.lenderId).toBe(HEIR)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
//  اعلان‌ها
// ─────────────────────────────────────────────────────────────────────────────

describe('اعلان‌های میراث', () => {
  test('وارث فقط پس از تکمیلِ واقعی انتقال خبر می‌شود', async () => {
    const fake = seedEstate()
    const notify = notifyStub() as unknown as {
      notifyPlayerById: jest.Mock
      mock: { calls: unknown[][] }
    }
    const inheritance = new InheritanceService(
      fake.db,
      eventStub() as never,
      fake.poolStub as never,
      notify as never
    )
    const death = new DeathService(fake.db, inheritance, notify as never, eventStub() as never)

    await death.registerDeath(DECEASED, DEATH_CAUSE.health)
    const heirNotice = notify.notifyPlayerById.mock.calls.find(
      (call: unknown[]) => call[0] === HEIR && String(call[1]).includes('میراث')
    )
    expect(heirNotice).toBeTruthy()
    // مبلغِ اعلام‌شده همان مبلغی است که واقعاً منتقل شد
    // وارث سهم خودش را می‌بیند، نه کلِ دارایی نقدی
    expect(String(heirNotice![2])).toContain('۲٬۷۲۵٬۰۰۰')
    expect(String(heirNotice![2])).toContain('صندوق منطقه')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
//  پرونده‌هایی که خودکار حل نمی‌شوند
// ─────────────────────────────────────────────────────────────────────────────

describe('ترمیم پرونده‌های گیرکرده', () => {
  const { InheritanceService: Service } = { InheritanceService }

  test('پروندهٔ هرگز پردازش‌نشده هم برداشته می‌شود (سقوط بین ساخت و اجرا)', async () => {
    // ریشهٔ باگ: فیلترِ ترمیم به `lastError` نگاه می‌کرد. پرونده‌ای که در
    // فاصلهٔ ساخت تا اجرا گیر کرده بود، نه خطایی داشت و نه هرگز تلاش شده بود،
    // پس هرگز برداشته نمی‌شد و دارایی متوفی برای همیشه یخ می‌ماند.
    const fake = seedEstate()
    const { inheritance } = services(fake)
    const now = Date.now()
    await fake.db.inheritanceCase.create({
      data: {
        deceasedId: DECEASED,
        cause: DEATH_CAUSE.health,
        status: InheritanceStatus.PENDING,
        heirId: HEIR,
        attempts: 0,
        lastError: null,
        openedAt: new Date(now - Service.NEVER_ATTEMPTED_GRACE_MS - 60_000)
      }
    })
    await fake.db.player.update({
      where: { id: DECEASED },
      data: { status: PlayerStatus.DEAD, balance: 1_000_000 }
    })

    expect(await inheritance.recoverStalled()).toBe(1)
    expect(fake.state.cases[0]!.status).toBe(InheritanceStatus.COMPLETED)
  })

  test('پروندهٔ تازه‌ساخته‌شده دست‌نخورده می‌ماند تا با پردازش زنده رقابت نکند', async () => {
    const fake = seedEstate()
    const { inheritance } = services(fake)
    await fake.db.inheritanceCase.create({
      data: {
        deceasedId: DECEASED,
        cause: DEATH_CAUSE.health,
        status: InheritanceStatus.PENDING,
        heirId: HEIR,
        attempts: 0,
        lastError: null,
        openedAt: new Date()
      }
    })
    expect(await inheritance.recoverStalled()).toBe(0)
  })

  test('پرونده‌ای که سقف تلاش را پر کرده در صف اپراتور می‌آید', async () => {
    const fake = seedEstate()
    const { inheritance } = services(fake)
    await fake.db.inheritanceCase.create({
      data: {
        deceasedId: DECEASED,
        cause: DEATH_CAUSE.health,
        status: InheritanceStatus.TRANSFERRED,
        attempts: Service.MAX_RECOVERY_ATTEMPTS,
        lastError: 'connection reset'
      }
    })

    const stalled = await inheritance.stalledCases()
    expect(stalled).toHaveLength(1)
    expect(stalled[0]!.caseId).toBe(String(fake.state.cases[0]!.id))
    expect(stalled[0]!.attempts).toBe(Service.MAX_RECOVERY_ATTEMPTS)
    // ترمیم خودکار دیگر سراغش نمی‌رود؛ فقط انسان می‌تواند جمعش کند
    expect(await inheritance.recoverStalled()).toBe(0)
  })

  test('پروندهٔ بی‌وارث با نامِ متوفی و وارثِ خالی گزارش می‌شود', async () => {
    const fake = seedEstate({ wills: [] })
    const { death, inheritance } = services(fake)
    await death.registerDeath(DECEASED, DEATH_CAUSE.health)
    expect(fake.state.cases[0]!.status).toBe(InheritanceStatus.NO_HEIR)

    const stalled = await inheritance.stalledCases()
    expect(stalled).toHaveLength(1)
    expect(stalled[0]!.deceasedName).toContain('آرش')
    expect(stalled[0]!.heirName).toBeNull()
    expect(stalled[0]!.status).toBe(InheritanceStatus.NO_HEIR)
  })

  test('پرونده‌ای که خودکار حل می‌شود در صف اپراتور نویز نمی‌سازد', async () => {
    const fake = seedEstate()
    const { inheritance } = services(fake)
    await fake.db.inheritanceCase.create({
      data: {
        deceasedId: DECEASED,
        cause: DEATH_CAUSE.health,
        status: InheritanceStatus.SETTLED_DEBTS,
        heirId: HEIR,
        attempts: 1,
        lastError: 'transient'
      }
    })
    // قرار است در چرخهٔ بعدی خودش تمام شود، پس در صف انسانی نیست
    expect(await inheritance.stalledCases()).toHaveLength(0)
  })

  test('پروندهٔ بسته‌شده هرگز در صف نمی‌آید', async () => {
    const fake = seedEstate()
    const { inheritance } = services(fake)
    await fake.db.inheritanceCase.create({
      data: {
        deceasedId: DECEASED,
        cause: DEATH_CAUSE.health,
        status: InheritanceStatus.COMPLETED,
        attempts: 9,
        lastError: 'x'
      }
    })
    expect(await inheritance.stalledCases()).toHaveLength(0)
  })

  test('پایانِ واقعیِ گیر: وضعیتِ میانی حفظ می‌شود تا ادامهٔ کار ممکن بماند', async () => {
    // `FAILED` هیچ‌جا نوشته نمی‌شود و نباید هم بشود: وضعیتِ میانی می‌گوید
    // کدام مرحله تمام شده، و همین ادامهٔ کار را ممکن می‌کند. پس گیرکردن را
    // شمارِ تلاش نشان می‌دهد، نه یک وضعیتِ پایانی.
    const fake = seedEstate()
    const { inheritance } = services(fake)
    await fake.db.inheritanceCase.create({
      data: {
        deceasedId: DECEASED,
        cause: DEATH_CAUSE.health,
        status: InheritanceStatus.SETTLED_DEBTS,
        heirId: HEIR,
        attempts: Service.MAX_RECOVERY_ATTEMPTS,
        lastError: 'boom'
      }
    })
    await fake.db.player.update({
      where: { id: DECEASED },
      data: { status: PlayerStatus.DEAD, balance: 1_000_000 }
    })

    const stalled = await inheritance.stalledCases()
    expect(stalled).toHaveLength(1)
    expect(stalled[0]!.status).toBe(InheritanceStatus.SETTLED_DEBTS)

    const caseId = String(fake.state.cases[0]!.id)
    await inheritance.retry(caseId)
    expect(fake.state.cases[0]!.status).toBe(InheritanceStatus.COMPLETED)
    const afterFirst = playerById(fake, HEIR).balance
    // انتقال از همان مرحلهٔ میانی ادامه یافت: پول دقیقاً یک‌بار رسید
    expect(afterFirst).toBe(100_000 + 1_500_000)

    await inheritance.retry(caseId)
    expect(playerById(fake, HEIR).balance).toBe(afterFirst)
    expect(await inheritance.stalledCases()).toHaveLength(0)
  })
})
