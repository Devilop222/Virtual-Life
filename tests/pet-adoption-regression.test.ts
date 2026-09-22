/**
 * قفلِ رگرسیونیِ «سرپرستیِ حیوان خانگی».
 *
 * باگ‌های واقعی که این تست‌ها نگه می‌دارند:
 *  ۱. ترتیب Validation غلط بود: بازیکن بی‌پول تا *پس از نوشتن نام* نمی‌فهمید
 *     موجودی ندارد و بعد از آن فروشگاه تا مدت‌ها پیام «تو فقط یک حیوان
 *     می‌توانی داشته باشی» می‌داد.
 *  ۲. هر خطایی (از جمله کمبود موجودی) به «قبلاً حیوان داری» نگاشت می‌شد؛ پس
 *     پیام، علتِ واقعیِ شکست را پنهان می‌کرد.
 *  ۳. بی‌غذاییِ بیش از دو روز وضعیت «بیمار» می‌سازد و درمانش فقط یک وعده
 *     غذاست؛ در این وضعیت نه هدیه‌ای هست و نه بازی.
 *
 * همهٔ تست‌ها با دیتابیس ماک اجرا می‌شوند و قطعی‌اند: هیچ شاخه‌ای به تصادفِ
 * هشِ هدیهٔ روزانه وابسته نیست.
 */
import { PrismaClient } from '@prisma/client'
import { ConflictError, NotFoundError } from '../src/utils/classes/errors'
import { EventService } from '../src/modules/events/event.service'
import {
  PET_BOND_LEVELS,
  PET_INFO,
  PET_KINDS,
  PetService,
  petBonusAmount
} from '../src/modules/pets/pet.service'
import { dayIndex } from '../src/utils/game-time'

const KIND = { key: 'rabbit', price: 500_000 }

interface DbOptions {
  /** نتیجهٔ خواندن حیوان بازیکن. `null` یعنی هنوز حیوانی ندارد. */
  pet?: Record<string, unknown> | null
  /** نتیجهٔ کسرِ شرطی پول؛ `false` یعنی موجودی کافی نیست. */
  canPay?: boolean
  /** موجودی‌ای که پس از شکست کسر، برای محاسبهٔ کمبود خوانده می‌شود. */
  balanceWhenShort?: number
  /** کلیدهای رخدادِ امروز (غذا/بازی/هدیه) برای شبیه‌سازی سابقهٔ مراقبت. */
  eventKeys?: string[]
}

function makeDb(options: DbOptions = {}) {
  const pet = options.pet ?? null
  const db = {
    player: {
      findUnique: jest.fn().mockResolvedValue({ id: 'p1' }),
      findUniqueOrThrow: jest
        .fn()
        .mockResolvedValue({ balance: options.balanceWhenShort ?? 100_000 }),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: options.canPay === false ? 0 : 1 })
    },
    pet: {
      findUnique: jest.fn().mockResolvedValue(pet),
      findUniqueOrThrow: jest.fn().mockResolvedValue({ ...(pet ?? {}), mood: 25 }),
      create: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 })
    },
    financialTransaction: { create: jest.fn().mockResolvedValue({}) },
    gameEvent: {
      create: jest.fn().mockResolvedValue({}),
      count: jest.fn().mockResolvedValue((options.eventKeys ?? []).length),
      findMany: jest
        .fn()
        .mockResolvedValue((options.eventKeys ?? []).map((dedupeKey) => ({ dedupeKey })))
    }
  }
  return {
    ...db,
    $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(db))
  }
}

function makeEvents() {
  return {
    recordPlayerEvent: jest.fn().mockResolvedValue(undefined),
    recordRegionEvent: jest.fn().mockResolvedValue(undefined)
  }
}

function serviceFor(db: ReturnType<typeof makeDb>, notify?: jest.Mock) {
  return new PetService(
    db as unknown as PrismaClient,
    makeEvents() as unknown as EventService,
    notify ? { notifyPlayerById: notify } : undefined
  )
}

/** یک حیوانِ خسته و گرسنه: سه روز بی‌غذا، پس بیمار. */
function sickPet() {
  return {
    id: 'pet1',
    playerId: 'p1',
    kind: 'cat',
    name: 'پشمک',
    hunger: 0,
    mood: 0,
    lastFedAt: new Date(Date.now() - 3 * 86_400_000),
    adoptedAt: new Date(Date.now() - 5 * 86_400_000),
    lastBonusDayIndex: 0
  }
}

describe('pet adoption — money is checked before any commitment', () => {
  test('an underfunded player is told the real reason, not "you already have a pet"', async () => {
    const service = serviceFor(makeDb({ canPay: false, balanceWhenShort: 120_000 }))

    const error = await service.adopt(42n, KIND.key, 'پشمک').catch((err: unknown) => err)

    expect(error).toBeInstanceOf(ConflictError)
    const message = (error as ConflictError).persianMessage
    // علتِ واقعی، با همان قالب‌بندیِ خودِ سرویس...
    expect(message).toContain((KIND.price - 120_000).toLocaleString('fa-IR'))
    expect(message).toContain('کم داری')
    // ...و پیامِ گمراه‌کنندهٔ «قبلاً حیوان داری» هرگز نمی‌آید
    expect(message).not.toContain('یک حیوان')
  })

  test('a failed purchase leaves no pet row and no ledger row behind', async () => {
    const db = makeDb({ canPay: false, balanceWhenShort: 0 })

    await expect(serviceFor(db).adopt(42n, KIND.key, 'پشمک')).rejects.toBeInstanceOf(ConflictError)
    expect(db.pet.create).not.toHaveBeenCalled()
    expect(db.financialTransaction.create).not.toHaveBeenCalled()
  })

  test('owning a pet is refused with that pet by name, before any money moves', async () => {
    const db = makeDb({ pet: { name: 'سیاه', kind: 'dog' } })

    const error = await serviceFor(db).adopt(42n, KIND.key, 'پشمک').catch((err: unknown) => err)

    expect(error).toBeInstanceOf(ConflictError)
    expect((error as ConflictError).persianMessage).toContain('سیاه')
    expect(db.pet.create).not.toHaveBeenCalled()
    expect(db.financialTransaction.create).not.toHaveBeenCalled()
  })

  test('a successful adoption writes the pet and one PET_EXPENSE ledger row', async () => {
    const db = makeDb({ pet: null, canPay: true })

    const result = await serviceFor(db).adopt(42n, KIND.key, '  پشمک   کوچولو ')

    expect(result.name).toBe('پشمک کوچولو')
    expect(result.price).toBe(KIND.price)
    expect(db.pet.create).toHaveBeenCalledTimes(1)
    expect(db.financialTransaction.create).toHaveBeenCalledTimes(1)
    const row = db.financialTransaction.create.mock.calls[0]![0] as {
      data: { amount: number; type: string; sourcePlayerId: string }
    }
    expect(row.data.amount).toBe(KIND.price)
    expect(row.data.type).toBe('PET_EXPENSE')
    expect(row.data.sourcePlayerId).toBe('p1')
  })

  test('an unknown breed and a one-letter name are human errors, not crashes', async () => {
    const service = serviceFor(makeDb())
    await expect(service.adopt(42n, 'dragon', 'پشمک')).rejects.toBeInstanceOf(NotFoundError)
    await expect(service.adopt(42n, KIND.key, 'ب')).rejects.toBeInstanceOf(NotFoundError)
  })
})

describe('pet care — sickness is real and treatable', () => {
  test('a pet unfed for three days cannot give a gift', async () => {
    const error = await serviceFor(makeDb({ pet: sickPet() }))
      .claimDailyBonus(42n)
      .catch((err: unknown) => err)

    expect(error).toBeInstanceOf(ConflictError)
    expect((error as ConflictError).persianMessage).toContain('بیمار')
  })

  test('a sick pet cannot play either', async () => {
    await expect(serviceFor(makeDb({ pet: sickPet() })).play(42n)).rejects.toBeInstanceOf(
      ConflictError
    )
  })

  test('one meal cures it and the result says so', async () => {
    const db = makeDb({ pet: sickPet() })

    const result = await serviceFor(db).feed(42n)

    expect(result.cured).toBe(true)
    expect(result.cost).toBe(PET_INFO.feedCost)
    expect(db.financialTransaction.create).toHaveBeenCalledTimes(1)
  })

  test('the sick notice is bound to the pet and the day, so it never spams', async () => {
    const notify = jest.fn().mockResolvedValue(true)

    await serviceFor(makeDb({ pet: sickPet() }), notify).getView(42n)

    expect(notify).toHaveBeenCalledTimes(1)
    const args = notify.mock.calls[0]! as unknown[]
    expect(args[0]).toBe('p1')
    expect(args[4]).toBe(`pet-sick:pet1:${dayIndex()}`)
  })

  /**
   * رگرسیونِ «هدیهٔ صفر»: گامِ گردکردن با واحدِ اقتصاد هم‌تراز نبود و هر
   * هدیه‌ای را زیر ۲٬۵۰۰ به صفر می‌رساند. نتیجه این بود که Hدیهٔ روزانه در
   * تمامِ نژادها و تمامِ سطوحِ پیوند صفر تومان بود.
   */
  test('هدیهٔ روزانه هرگز صفر نمی‌شود — در هیچ نژاد و هیچ سطحِ پیوند', () => {
    for (const kind of PET_KINDS) {
      for (const level of PET_BOND_LEVELS) {
        const multiplierPercent = Math.round((1 + level.level * 0.05) * 100)
        // ۲۰۰ حالتِ مختلفِ انتخابِ روز را می‌پوشاند (بیشتر از stepCount هر نژاد)
        for (let variant = 0; variant < 200; variant++) {
          const amount = petBonusAmount(kind, multiplierPercent, variant)
          expect(amount).toBeGreaterThan(0)
          expect(amount).toBeGreaterThanOrEqual(kind.bonusMin)
        }
      }
    }
  })

  test('هدیه در بدترین حالت هم از خرجِ روزانهٔ غذا بیشتر است', () => {
    for (const kind of PET_KINDS) {
      expect(kind.bonusMin).toBeGreaterThan(PET_INFO.feedCost)
    }
  })

  test('پیوندِ بالاتر واقعاً هدیه را بیشتر می‌کند', () => {
    for (const kind of PET_KINDS) {
      const lowest = petBonusAmount(kind, 100, 0)
      const highest = petBonusAmount(kind, 120, 0)
      expect(highest).toBeGreaterThan(lowest)
    }
  })

  test('نژادِ گران‌تر هدیهٔ بیشتری می‌دهد و انتخابِ روز واقعاً اثر دارد', () => {
    const base = PET_BOND_LEVELS[0]!
    const multiplierPercent = Math.round((1 + base.level * 0.05) * 100)

    const averageByPrice = [...PET_KINDS]
      .sort((a, b) => a.price - b.price)
      .map((kind) => {
        let sum = 0
        for (let variant = 0; variant < 50; variant++) {
          sum += petBonusAmount(kind, multiplierPercent, variant)
        }
        return sum / 50
      })

    for (let i = 1; i < averageByPrice.length; i++) {
      expect(averageByPrice[i]!).toBeGreaterThan(averageByPrice[i - 1]!)
    }

    // تنوعِ روزانه: حداقل دو مبلغِ متفاوت در یک نژاد (وگرنه `variant` مرده است)
    const distinct = new Set(
      Array.from({ length: 50 }, (_, variant) =>
        petBonusAmount(PET_KINDS[0]!, multiplierPercent, variant)
      )
    )
    expect(distinct.size).toBeGreaterThan(1)
  })

  test('مسیر جاری که هدیه نمی‌دهد، هیچ پولی هم نمی‌سازد (roll گارد)', async () => {
    // حال و غذا اوکی است؛ فقط آخرین روزِ هدیه پر شده تا شاخهٔ گارد اجرا شود.
    const db = makeDb({
      pet: {
        ...sickPet(),
        hunger: 0,
        mood: 90,
        lastFedAt: new Date(),
        lastBonusDayIndex: dayIndex()
      }
    })

    await expect(serviceFor(db).claimDailyBonus(42n)).rejects.toBeInstanceOf(ConflictError)
    expect(db.financialTransaction.create).not.toHaveBeenCalled()
    expect(db.player.update).not.toHaveBeenCalled()
  })

  test('a fed, happy pet reports the day as cared for', async () => {
    const db = makeDb({
      pet: {
        ...sickPet(),
        hunger: 0,
        mood: 90,
        lastFedAt: new Date(),
        lastBonusDayIndex: dayIndex()
      },
      eventKeys: [`pet-feed:pet1:${dayIndex()}`]
    })

    const view = await serviceFor(db).getView(42n)

    expect(view).not.toBeNull()
    expect(view!.isSick).toBe(false)
    expect(view!.fedToday).toBe(true)
    expect(view!.playedToday).toBe(false)
    expect(view!.canPlay).toBe(true)
    expect(view!.bonusCheckedToday).toBe(true)
    expect(view!.bonusReady).toBe(false)
  })
})
