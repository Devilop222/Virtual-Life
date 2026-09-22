/**
 * رگرسیون کلاس باگ «سقف سلامت باشگاه نادیده گرفته می‌شد».
 *
 * عضویت فعال باشگاه سقف سلامت را به ۱۲۰ می‌برد (GYM_MAX_HEALTH). تا قبل از
 * اصلاح، سه سیستم clamp خودشان را با ۱۰۰ هاردکد کرده بودند:
 *  • استفادهٔ کالای فروشگاه: سلامت ۱۱۵ + کالای درمانی → ۱۰۰ (کاهش!)
 *  • استراحت در خانه: همان کاهش ناخواسته
 *  • پیش‌نمایش هزینهٔ درمانگاه: کمتر از مبلغ واقعی کسرشده نمایش داده می‌شد
 */
import { PrismaClient } from '@prisma/client'
import { ShopService } from '../src/modules/shop/shop.service'
import { ClinicService } from '../src/modules/health/clinic.service'
import { HousingRepository } from '../src/database/repositories/housing.repository'
import { GYM_MAX_HEALTH } from '../src/modules/health/max-health'

const GYM_MEMBER = { id: 'gym-1' }

describe('Health cap honours active gym membership everywhere', () => {
  test('using a healing item never lowers a gym member\'s health', async () => {
    const tx = {
      playerInventory: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'inv1',
          quantity: 1,
          player: { id: 'p1', telegramUserId: 42n, health: 115, fatigue: 10, experience: 5 },
          item: { name: 'کیت کمک‌های اولیه', effects: { health: 18 } }
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      },
      gymMembership: { findFirst: jest.fn().mockResolvedValue(GYM_MEMBER) },
      player: { update: jest.fn().mockResolvedValue({}) }
    }
    const db = { $transaction: jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx)) }
    const service = new ShopService(db as unknown as PrismaClient)

    const res = await service.useItem('inv1', 42n)

    // ۱۱۵ + ۱۸ = ۱۳۳ → با سقف ۱۲۰، نه clamp قدیمیِ ۱۰۰
    expect(res.health).toBe(GYM_MAX_HEALTH)
    expect(res.maxHealth).toBe(GYM_MAX_HEALTH)
    expect(tx.player.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ health: GYM_MAX_HEALTH })
      })
    )
  })

  test('a player without membership is still capped at 100', async () => {
    const tx = {
      playerInventory: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'inv1',
          quantity: 1,
          player: { id: 'p1', telegramUserId: 42n, health: 95, fatigue: 10, experience: 5 },
          item: { name: 'کیت کمک‌های اولیه', effects: { health: 18 } }
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      },
      gymMembership: { findFirst: jest.fn().mockResolvedValue(null) },
      player: { update: jest.fn().mockResolvedValue({}) }
    }
    const db = { $transaction: jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx)) }
    const service = new ShopService(db as unknown as PrismaClient)

    const res = await service.useItem('inv1', 42n)
    expect(res.health).toBe(100)
    expect(res.maxHealth).toBe(100)
  })

  test('clinic preview prices the trip to the real cap (120), not to 100', async () => {
    const db = {
      player: { findUnique: jest.fn().mockResolvedValue({ id: 'p1', health: 95 }) },
      insurancePolicy: { findFirst: jest.fn().mockResolvedValue(null) },
      gymMembership: { findFirst: jest.fn().mockResolvedValue(GYM_MEMBER) }
    }
    const service = new ClinicService(db as unknown as PrismaClient, {} as never, {} as never)

    const view = await service.getView(42n)

    expect(view.maxHealth).toBe(GYM_MAX_HEALTH)
    // ۲۵ واحد کمبود × ۱۲ هزار = ۳۰۰ هزار — همان چیزی که treat واقعاً برمی‌دارد
    expect(view.missingHealth).toBe(25)
    expect(view.fullCost).toBe(300_000)
  })

  test('finishing a rest never lowers a gym member\'s health', async () => {
    const db = {
      player: {
        findUnique: jest.fn().mockResolvedValue({ fatigue: 30, health: 115 }),
        // نوشتار شرطی روی «هنوز در حال استراحت بودن»: فقط یکی از دو کلیکِ
        // همزمان ریکاوری را اعمال می‌کند.
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      },
      gymMembership: { findFirst: jest.fn().mockResolvedValue(GYM_MEMBER) }
    }
    const repo = new HousingRepository(db as unknown as PrismaClient)

    const applied = await repo.stopResting('p1', 40, 10)

    expect(applied).toBe(true)
    expect(db.player.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'p1', restStartedAt: { not: null } }),
        data: expect.objectContaining({ health: GYM_MAX_HEALTH, fatigue: 0 })
      })
    )
  })

  test('a concurrent rest finish is a no-op (recovery applied once only)', async () => {
    const db = {
      player: {
        findUnique: jest.fn().mockResolvedValue({ fatigue: 30, health: 80 }),
        // بازندهٔ رقابت: شرط RESTING صفر ردیف می‌زند
        updateMany: jest.fn().mockResolvedValue({ count: 0 })
      },
      gymMembership: { findFirst: jest.fn().mockResolvedValue(null) }
    }
    const repo = new HousingRepository(db as unknown as PrismaClient)

    const applied = await repo.stopResting('p1', 40, 10)

    expect(applied).toBe(false)
  })
})
