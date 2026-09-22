/**
 * صفِ پرونده‌های میراث در پنل مدیریت — پولِ یخ‌زده باید راهِ بازگشت داشته باشد.
 *
 * ## حفره‌ای که این آزمون از تکرارش جلوگیری می‌کند
 *
 * اسکیما خودش وعده داده بود که پروندهٔ بی‌وارث «باز می‌ماند تا ادمین تصمیم
 * بگیرد» و اینکه پروندهٔ خطاخورده «به تلاش دوبارهٔ دستی» نیاز دارد. دو متد
 * دقیقاً برای همین ساخته شده بودند (`stalledCases`/`retry`) و **هیچ فراخوانی
 * نداشتند** — هیچ پنل، هیچ دکمه، هیچ مسیری. نتیجه: وقتی ترمیم خودکار سقفِ
 * تلاشش را پر می‌کرد یا پرونده بی‌وارث می‌ماند، دارایی متوفی تا ابد بلاتکلیف
 * می‌شد و هیچ‌کس هم خبردار نمی‌شد.
 *
 * این آزمون سه چیز را قفل می‌کند: دسترسی فقط برای ادمین، ثبتِ ردِ اقدام، و
 * اینکه «تلاش دوباره» واقعاً به سرویسِ میراث می‌رسد.
 */
import { BotAdminRole, PrismaClient } from '@prisma/client'
import { AdminService } from '../src/modules/admin/admin.service'
import { ConflictError, UnauthorizedError } from '../src/utils/classes/errors'
import type { InheritanceService } from '../src/modules/inheritance/inheritance.service'

const ADMIN_ID = 6910416744n
const STRANGER_ID = 42n
const CASE_ID = 'case-7'
const DECEASED_ID = 777n

const CASE_ROW = {
  status: 'SETTLED_DEBTS',
  lastError: 'connection reset',
  attempts: 5,
  deceased: { telegramUserId: DECEASED_ID, firstName: 'آرش', lastName: 'ک.' }
}

function makeAdminService() {
  const adminLogCreate = jest.fn().mockResolvedValue({})
  const tx = { adminLog: { create: adminLogCreate } }

  const db = {
    // `findAdmin` نقش را از جدول ادمین‌ها می‌خواند؛ فقط ادمینِ شناخته‌شده ردیف
    // برمی‌گرداند تا مسیر «غیرادمین هیچ پاسخی نمی‌گیرد» هم سنجیده شود.
    botAdmin: {
      findUnique: jest
        .fn()
        .mockImplementation(({ where }: { where: { telegramUserId: bigint } }) =>
          Promise.resolve(
            where.telegramUserId === ADMIN_ID
              ? { telegramUserId: ADMIN_ID, role: BotAdminRole.ADMIN, isActive: true }
              : null
          )
        )
    },
    inheritanceCase: { findUnique: jest.fn().mockResolvedValue(CASE_ROW) },
    $transaction: jest.fn().mockImplementation((fn: (t: unknown) => Promise<unknown>) => fn(tx)),
    adminLog: { create: adminLogCreate }
  }

  const stalledCases = jest.fn().mockResolvedValue([{ caseId: CASE_ID, status: 'SETTLED_DEBTS' }])
  const retry = jest.fn().mockResolvedValue({ caseId: CASE_ID, status: 'COMPLETED' })
  const inheritanceService = { stalledCases, retry } as unknown as InheritanceService

  const service = new AdminService(
    db as unknown as PrismaClient,
    undefined,
    inheritanceService
  )

  return { service, stalledCases, retry, adminLogCreate, db }
}

describe('صف پرونده‌های میراث در پنل مدیریت', () => {
  test('ادمین می‌تواند صف را ببیند و درخواست به سرویس میراث می‌رسد', async () => {
    const { service, stalledCases } = makeAdminService()

    const cases = await service.listStalledInheritance(ADMIN_ID)

    expect(cases).toHaveLength(1)
    expect(stalledCases).toHaveBeenCalledWith(5)
  })

  test('غیرادمین حتی فهرست را نمی‌بیند', async () => {
    const { service, stalledCases } = makeAdminService()

    await expect(service.listStalledInheritance(STRANGER_ID)).rejects.toThrow(UnauthorizedError)
    expect(stalledCases).not.toHaveBeenCalled()
  })

  test('غیرادمین نمی‌تواند تلاش دوباره را اجرا کند', async () => {
    const { service, retry } = makeAdminService()

    await expect(service.retryInheritanceCase(STRANGER_ID, CASE_ID)).rejects.toThrow(
      UnauthorizedError
    )
    expect(retry).not.toHaveBeenCalled()
  })

  test('تلاش دوباره به سرویس میراث می‌رسد و وضعیت تازه را برمی‌گرداند', async () => {
    const { service, retry } = makeAdminService()

    const result = await service.retryInheritanceCase(ADMIN_ID, CASE_ID)

    expect(retry).toHaveBeenCalledWith(CASE_ID)
    expect(result).toEqual({ deceasedName: 'آرش ک.', status: 'COMPLETED' })
  })

  test('قصدِ اقدام پیش از اجرا ثبت می‌شود تا ردِ مدیر باقی بماند', async () => {
    const { service, adminLogCreate } = makeAdminService()

    await service.retryInheritanceCase(ADMIN_ID, CASE_ID)

    expect(adminLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorUserId: ADMIN_ID,
        action: 'inheritance_retry',
        targetUserId: DECEASED_ID,
        details: expect.objectContaining({ caseId: CASE_ID, statusBefore: 'SETTLED_DEBTS' })
      })
    })
  })

  test('پروندهٔ بی‌وارث «تلاش دوباره» را رد می‌کند (مرز سمت سرور)', async () => {
    // انتقال وارث ندارد، پس اجرای دوباره هیچ چیزی را عوض نمی‌کند. این بررسی
    // باید سمت سرور باشد: پنهان‌کردن دکمه کافی نیست، چون یک callback قدیمی
    // یا صدا‌زدن مستقیم باید همان‌جا بمیرد.
    const { service, retry, db } = makeAdminService()
    db.inheritanceCase.findUnique.mockResolvedValue({ ...CASE_ROW, status: 'NO_HEIR' })

    await expect(service.retryInheritanceCase(ADMIN_ID, CASE_ID)).rejects.toThrow(ConflictError)
    expect(retry).not.toHaveBeenCalled()
  })

  test('پروندهٔ ناشناس خطا نمی‌دهد و چیزی را اجرا نمی‌کند', async () => {
    const { service, retry, db } = makeAdminService()
    db.inheritanceCase.findUnique.mockResolvedValue(null)

    await expect(service.retryInheritanceCase(ADMIN_ID, 'nope')).resolves.toBeNull()
    expect(retry).not.toHaveBeenCalled()
  })

  test('بدون سرویس میراث، صف خالی می‌ماند و پنل نمی‌شکند', async () => {
    // مسیر ساختِ container ممکن است در آزمون‌ها سرویس میراث را تزریق نکند؛
    // نبودش باید یعنی «صف خالی»، نه «خطای سراسری در پنل مدیریت».
    const service = new AdminService({
      botAdmin: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ telegramUserId: ADMIN_ID, role: BotAdminRole.ADMIN, isActive: true })
      }
    } as unknown as PrismaClient)

    await expect(service.listStalledInheritance(ADMIN_ID)).resolves.toEqual([])
    await expect(service.retryInheritanceCase(ADMIN_ID, CASE_ID)).resolves.toBeNull()
  })
})
