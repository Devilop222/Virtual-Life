/**
 * قفلِ شخصیتِ فوت‌شده و دریچهٔ نجاتِ سلامت.
 *
 * چرا این آزمون‌ها لازم‌اند؟ دو حفرهٔ واقعی که در بازبینی پیدا شدند:
 *
 *  ۱. جریان‌های «ورودی آزاد» (نام حیوان، قیمت اجاره، پیشنهاد حراجی، مبلغ
 *     سپرده، سود کسب‌وکار و…) در `UserState.currentContext` می‌نشینند، نه در
 *     پیشوندِ callback؛ پس میان‌افزارِ سراسری — که مرگ را می‌گیرد — آن‌ها را
 *     نمی‌دید. بازیکنی که پیش از مرگ یکی از این جریان‌ها را باز کرده بود،
 *     می‌توانست بعد از مرگ با یک پیام ساده آن را تمام کند.
 *
 *  ۲. درمانگاه «همه یا هیچ» بود؛ بازیکنِ کم‌پول (و بی‌خانه، که حتی نمی‌تواند
 *     استراحت کند) هیچ راهی برای برگرداندن سلامت نداشت — یعنی مرگ برایش
 *     اجباری بود، در حالی که خودِ پیام خطا وعدهٔ «بخشی از سلامت» می‌داد.
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { PrismaClient } from '@prisma/client'
import { ClinicService } from '../src/modules/health/clinic.service'
import { EventService } from '../src/modules/events/event.service'
import { NotificationService } from '../src/modules/notification/notification.service'
import { isMutatingInputFlow } from '../src/bot/handlers/text.handler'
import { checkSectionEntry } from '../src/bot/chat-policy'
import { PlayerStatus } from '@prisma/client'

// ───────────────────────────────────────────── ۱) قفلِ جریان‌های ورودی

describe('قفلِ شخصیتِ فوت‌شده — کدام جریان‌های ورودی می‌توانند مالکیت/پول را عوض کنند', () => {
  const mutating = [
    'bank_deposit',
    'bank_withdraw',
    'family_mahr',
    'family_set_mahr:prop-1',
    'family_gift',
    'biz_job_title:biz-1',
    'biz_jobsal:biz-1',
    'biz_profit:biz-1',
    'biz_salary:biz-1:emp-1',
    'pet_name:dog',
    'loan_request',
    'will_heir',
    'will_note',
    'auction_bid:auc-1',
    'ad_text',
    'market_sell:inv-1',
    'deposit_open:plan',
    'rental_price:prop-1'
  ]

  test('همهٔ جریان‌های مالی/مالکیتی شناخته می‌شوند', () => {
    for (const context of mutating) {
      expect(isMutatingInputFlow(context)).toBe(true)
    }
  })

  test('جریان‌های بی‌اثر روی اقتصاد قربانی نمی‌شوند', () => {
    // ثبت اعتراض حقِ بازیکن است و هیچ اثر مالی ندارد.
    expect(isMutatingInputFlow('support_text:some-report')).toBe(false)
    expect(isMutatingInputFlow('registration')).toBe(false)
    expect(isMutatingInputFlow('rebirth')).toBe(false)
  })

  test('گاردِ وضعیتِ بازیکن در مسیر پیام متنی، پیش از هر جریان ورودی اجرا می‌شود', () => {
    // آزمون متنی: ترتیب مهم است. اگر گارد بعد از جریان‌ها بیاید، بی‌اثر است.
    const src = readFileSync(join(__dirname, '..', 'src/bot/handlers/text.handler.ts'), 'utf8')
    const guardAt = src.indexOf('isMutatingInputFlow(pendingContext)')
    const firstFlowAt = src.indexOf("pendingContext === 'bank_deposit'")
    expect(guardAt).toBeGreaterThan(-1)
    expect(firstFlowAt).toBeGreaterThan(-1)
    expect(guardAt).toBeLessThan(firstFlowAt)
    // و جریان نیمه‌کاره پاک می‌شود، نه اینکه فقط نادیده گرفته شود.
    const guardBlock = src.slice(guardAt, guardAt + 700)
    expect(guardBlock).toContain('userStateRepository.clear')
    // حفرهٔ واقعیِ بعدی: مسدودسازی، `UserState` را پاک نمی‌کند؛ پس اگر این‌جا
    // فقط `DEAD` سنجیده شود، جریانِ نیمه‌کارهٔ *پیش از* مسدودشدن با یک پیام
    // ساده تمام می‌شود. قاعده باید از یک منبع بیاید و هر دو وضعیت را بگیرد.
    expect(guardBlock).toContain('actorStanding')
    expect(guardBlock).not.toContain("=== 'DEAD'")
    expect(guardBlock).toContain('blockedActorPanel')
  })
})

describe('بخش «زندگی تازه» برای شخصیتِ فوت‌شده باز است و برای مسدود بسته', () => {
  const dbWith = (status: PlayerStatus) =>
    ({
      playerRepository: {
        findByTelegramUserId: jest.fn().mockResolvedValue({ id: 'p-1', status })
      },
      groupRepository: { findByTelegramGroupId: jest.fn().mockResolvedValue(null) }
    }) as never

  const ctx = { chat: { type: 'private' }, from: { id: 1001 } } as never

  test('شخصیتِ فوت‌شده می‌تواند به بخش زندگی تازه برسد', async () => {
    const result = await checkSectionEntry(ctx, dbWith(PlayerStatus.DEAD), 'rebirth')
    expect(result).toBe('allowed')
  })

  test('حسابِ مسدود حتی برای زندگی تازه هم باز نمی‌شود', async () => {
    const result = await checkSectionEntry(ctx, dbWith(PlayerStatus.BANNED), 'rebirth')
    expect(result).toBe('banned')
  })

  test('شخصیتِ فوت‌شده به سایر بخش‌ها راه ندارد', async () => {
    const result = await checkSectionEntry(ctx, dbWith(PlayerStatus.DEAD), 'clinic')
    expect(result).toBe('dead')
  })
})

// ───────────────────────────────────────────── ۲) درمان اضطراری

function makeEvents() {
  return {
    recordPlayerEvent: jest.fn().mockResolvedValue(undefined),
    recordRegionEvent: jest.fn().mockResolvedValue(undefined)
  }
}

function makeNotifs() {
  return { notifyPlayerById: jest.fn().mockResolvedValue(true) }
}

/**
 * کلاینتِ جعلی با گذرِ مستقیم تراکنش.
 *
 * چرا `where`های نوشتار شرطی شبیه‌سازی می‌شوند؟ چون تضمینِ اصلیِ درمان
 * اضطراری همین است: اگر بین خواندن و نوشتن سلامت یا موجودی عوض شود، باید
 * صفر ردیف بنویسد. یک mock که همیشه `count: 1` بدهد، این تضمین را پنهان
 * می‌کرد و آزمون بی‌ارزش می‌شد.
 */
function makeClinicDb(player: Record<string, unknown>, balanceGuard = true) {
  const db: Record<string, unknown> = {
    player: {
      findUnique: jest.fn().mockResolvedValue(player),
      updateMany: jest.fn().mockResolvedValue({ count: balanceGuard ? 1 : 0 }),
      count: jest.fn().mockResolvedValue(1)
    },
    insurancePolicy: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn() },
    gymMembership: { findFirst: jest.fn().mockResolvedValue(null) },
    financialTransaction: { create: jest.fn().mockResolvedValue({}) }
  }
  db.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn(db)
  return db
}

function clinicOf(db: Record<string, unknown>) {
  return new ClinicService(
    db as unknown as PrismaClient,
    makeEvents() as unknown as EventService,
    makeNotifs() as unknown as NotificationService
  )
}

describe('ClinicService — درمان اضطراری: بستنِ بن‌بستِ سلامت', () => {
  test('موجودیِ کم، بخشی از سلامت را برمی‌گرداند (نه صفر، نه بن‌بست)', async () => {
    // سلامت ۲۰ از ۱۰۰، موجودی فقط ۱۲۰٬۰۰۰ = ده واحد درمان.
    const db = makeClinicDb({ id: 'p1', health: 20, balance: 120_000 })
    const service = clinicOf(db)

    const result = await service.treatEmergency(1n)

    expect(result.healedAmount).toBe(10)
    expect(result.paid).toBe(120_000)
    expect(result.newHealth).toBe(30)
  })

  test('پیش‌نمایش پنل همان چیزی را وعده می‌دهد که درمان می‌دهد', async () => {
    const db = makeClinicDb({ id: 'p1', health: 20, balance: 120_000 })
    const view = await clinicOf(db).getView(1n)

    expect(view.affordableUnits).toBe(10)
    expect(view.affordableCost).toBe(120_000)
    expect(view.missingHealth).toBe(80)
    // و همان عدد با درمان واقعی یکی است.
    const result = await clinicOf(db).treatEmergency(1n)
    expect(result.healedAmount).toBe(view.affordableUnits)
    expect(result.paid).toBe(view.affordableCost)
  })

  test('بیمهٔ فعال، هزینهٔ هر واحد را نصف می‌کند', async () => {
    const db = makeClinicDb({ id: 'p1', health: 20, balance: 120_000 })
    ;(db.insurancePolicy as { findFirst: jest.Mock }).findFirst.mockResolvedValue({
      coverRate: 0.5,
      coversUntil: new Date(Date.now() + 86_400_000)
    })

    const view = await clinicOf(db).getView(1n)
    expect(view.affordableUnits).toBe(20)
    expect(view.affordableCost).toBe(120_000)
  })

  test('موجودیِ صفر، پیام روشن می‌دهد — نه سکوت و نه کسر صفر', async () => {
    const db = makeClinicDb({ id: 'p1', health: 20, balance: 0 })
    await expect(clinicOf(db).treatEmergency(1n)).rejects.toThrow()
  })

  test('سلامتِ کامل، درخواست درمان را رد می‌کند', async () => {
    const db = makeClinicDb({ id: 'p1', health: 100, balance: 900_000 })
    await expect(clinicOf(db).treatEmergency(1n)).rejects.toThrow()
  })

  test('اگر حالت بین خواندن و نوشتن عوض شود، هیچ پولی کسر نمی‌شود', async () => {
    const db = makeClinicDb({ id: 'p1', health: 20, balance: 120_000 }, false)
    const txs = db.financialTransaction as { create: jest.Mock }
    await expect(clinicOf(db).treatEmergency(1n)).rejects.toThrow()
    expect(txs.create).not.toHaveBeenCalled()
  })
})
