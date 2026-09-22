import { PrismaClient } from '@prisma/client'
import { PlayerLoanService } from '../src/modules/lending/player-loan.service'
import { BusinessService } from '../src/modules/occupation/business.service'

/**
 * قفلِ رگرسیونیِ «چرخه‌های بدون صاحبِ اجرا».
 *
 * این سه اصلاح، سیستم‌هایی را که سرویسِ کامل داشتند ولی هیچ مسیری به آن‌ها
 * وصل نبود (یا فقط از یک سمت قابل اجرا بودند) به‌صورت end-to-end می‌بندند:
 *  • سررسید قرض بازیکنی از هر دو طرف قابل اجراست
 *  • بدهکار از نکول و وصول اجباریِ کیفش باخبر می‌شود
 *  • تغییر حقوق کارمند و بستن آگهی از پنل مالک قابل انجام است
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
// دیتابیسِ ساختگی تست‌ها تایپ آزاد دارد؛ همان الگوی production-hardening.test.ts

function txOf(db: Record<string, any>) {
  return (fn: (tx: Record<string, any>) => Promise<unknown>) => fn(db)
}

function makeEvents() {
  return { recordPlayerEvent: jest.fn().mockResolvedValue(undefined) }
}

const loan = {
  id: 'l1',
  lenderId: 'lend1',
  borrowerId: 'bor1',
  principal: 1_000_000,
  totalRepay: 1_100_000,
  status: 'ACTIVE',
  dueAt: new Date(Date.now() - 3_600_000)
}

describe('p2p loan — either side can drive the maturity cycle', () => {
  function makeDb() {
    const db: Record<string, any> = {
      player: {
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        count: jest.fn().mockResolvedValue(0)
      },
      playerLoan: {
        findMany: jest.fn().mockResolvedValue([loan]),
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      },
      financialTransaction: { create: jest.fn() }
    }
    db.$transaction = jest.fn(txOf(db))
    return db
  }

  test('query targets the borrower side regardless of who triggered the sweep', async () => {
    const db = makeDb()
    const service = new PlayerLoanService(db as unknown as PrismaClient, makeEvents() as never)
    await service.settleDueLoans('lend1')

    // جست‌وجو روی طرفِ بدهکارِ قرارداد انجام می‌شود، نه روی اجراکنندهٔ چرخه
    expect(db.playerLoan.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ borrowerId: 'lend1' }, { lenderId: 'lend1' }]
        })
      })
    )
  })

  test('the borrower is notified when their wallet is force-collected', async () => {
    const db = makeDb()
    db.player.count.mockResolvedValue(0)
    db.player.findUnique.mockResolvedValue({ balance: 500_000 })
    const notify = jest.fn().mockResolvedValue(true)
    const service = new PlayerLoanService(
      db as unknown as PrismaClient,
      makeEvents() as never,
      { notifyPlayerById: notify }
    )

    await service.settleDueLoans('lend1')

    const calls = notify.mock.calls.map((c) => c[0])
    // هر دو طرف اعلان می‌گیرند
    expect(calls).toContain('lend1')
    expect(calls).toContain('bor1')
    // اعلان بدهکار دربارهٔ وصول کیفِ خودش است
    const borrowerCall = notify.mock.calls.find((c) => c[0] === 'bor1')!
    expect(borrowerCall[1]).toContain('نکول')
  })
})

describe('owner-side employment controls', () => {
  function makeLoanServiceDeps() {
    return {
      businessRepository: {
        findById: jest.fn().mockResolvedValue({
          id: 'biz1',
          name: 'کافه ستاره',
          ownerId: 'p1',
          status: 'ACTIVE',
          employees: [
            {
              playerId: 'p2',
              salaryPerMinute: 200,
              isActive: true,
              player: { firstName: 'علی', lastName: 'رضایی' }
            }
          ]
        }),
        updateEmployeeSalary: jest.fn().mockResolvedValue({ salaryPerMinute: 250 })
      },
      playerRepository: {
        findByTelegramUserId: jest.fn().mockResolvedValue({ id: 'p1' })
      }
    }
  }

  test('setEmployeeSalary validates, updates and returns human-readable result', async () => {
    const deps = makeLoanServiceDeps()
    const service = new BusinessService(
      deps.businessRepository as never,
      deps.playerRepository as never,
      { previewPayroll: jest.fn(), settlePayroll: jest.fn() } as never
    )

    const result = await service.setEmployeeSalary(1n, 'biz1', 'p2', 250)

    expect(result.salaryPerMinute).toBe(250)
    expect(result.employeeName).toBe('علی رضایی')
    expect(result.businessName).toBe('کافه ستاره')
    expect(deps.businessRepository.updateEmployeeSalary).toHaveBeenCalledWith(
      'biz1',
      'p2',
      250
    )
  })

  test('setEmployeeSalary rejects a foreign owner', async () => {
    const deps = makeLoanServiceDeps()
    deps.businessRepository.findById.mockResolvedValue({
      id: 'biz1',
      ownerId: 'someone-else',
      employees: []
    })
    const service = new BusinessService(
      deps.businessRepository as never,
      deps.playerRepository as never,
      { previewPayroll: jest.fn(), settlePayroll: jest.fn() } as never
    )

    await expect(service.setEmployeeSalary(1n, 'biz1', 'p2', 250)).rejects.toThrow()
  })
})
