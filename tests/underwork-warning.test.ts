import { join } from 'path'
import { PrismaClient } from '@prisma/client'
import { PayrollService } from '../src/modules/occupation/payroll.service'
import {
  GAME_DAYS_PER_MONTH,
  REAL_MS_PER_GAME_DAY,
  REAL_MS_PER_GAME_MINUTE,
  formatGameHours,
  gameMonthStart,
  monthIndex
} from '../src/utils/game-time'
import {
  DEFAULT_CONTRACT_GAME_HOURS_PER_MONTH,
  SALARY_MINUTES_PER_DAY,
  closedGameMonthRange,
  contractMinutesFromGameHours,
  underworkMessage,
  underworkReport
} from '../src/modules/occupation/payroll-math'
import { readText } from './helpers/source'

/**
 * گزارشِ ماهانهٔ کم‌کارکردی.
 *
 * این فایل سه چیز را قفل می‌کند که بدون آن‌ها هشدار یا بی‌فایده است یا مزاحم:
 *  ۱. مرزِ تصمیم — کی «کم‌کار» حساب می‌شود و کی نه.
 *  ۲. تعدیلِ ماهِ اول — تازه‌استخدام نباید به‌خاطر روزهای نداشته «کم‌کار» شود.
 *  ۳. ضدتکرار — یک ماهِ بازی، یک هشدار؛ و هیچ اخراجِ خودکار.
 */

/**
 * بازهٔ «ماهِ بسته‌شده» — همان تعریفی که خودِ سرویس استفاده می‌کند.
 *
 * اینجا عمداً از همان تابعِ سرویس می‌آید: اگر تست مرزِ خودش را بسازد،
 * سنجه و بازهٔ گزارش با هم فرق می‌کنند و تست سبزِ بی‌معنا می‌شود.
 */
function closedMonth(): { start: Date; end: Date } {
  return closedGameMonthRange(Date.now())
}

/** حجمِ قراردادِ نمادینِ پرامپت: ۱۵۰ ساعت بازی در ماه. */
const CONTRACT_150 = contractMinutesFromGameHours(150)
/** قراردادِ پیش‌فرضِ بازی (کار تمام‌وقت) — تا تست با واقعیتِ سیستم هم‌خوان بماند. */
const FULL_MONTH_MINUTES = contractMinutesFromGameHours(DEFAULT_CONTRACT_GAME_HOURS_PER_MONTH)

describe('سنجشِ کم‌کارکردی — ریاضیات', () => {
  test('کارکردِ کاملِ حجم، هشدار نمی‌دهد', () => {
    const report = underworkReport({
      contractMinutes: CONTRACT_150,
      workedMinutes: CONTRACT_150,
      availableDays: GAME_DAYS_PER_MONTH
    })
    expect(report.expectedMinutes).toBe(CONTRACT_150)
    expect(report.shortfallMinutes).toBe(0)
    expect(report.shouldWarn).toBe(false)
  })

  test('اختلافِ ناچیز (۱۴۵ از ۱۵۰ ساعت) هشدار نیست', () => {
    const report = underworkReport({
      contractMinutes: CONTRACT_150,
      workedMinutes: 145 * 60,
      availableDays: GAME_DAYS_PER_MONTH
    })
    expect(report.shouldWarn).toBe(false)
  })

  test('کارکردِ ۱۰۰ از ۱۵۰ ساعت هشدار است، با کمبودِ دقیق', () => {
    const report = underworkReport({
      contractMinutes: CONTRACT_150,
      workedMinutes: 100 * 60,
      availableDays: GAME_DAYS_PER_MONTH
    })
    expect(report.expectedMinutes).toBe(150 * 60)
    expect(report.workedMinutes).toBe(100 * 60)
    expect(report.shortfallMinutes).toBe(50 * 60)
    expect(Math.round(report.ratio * 100)).toBe(67)
    expect(report.shouldWarn).toBe(true)
  })

  test('مرزِ آستانه همان ۹۰٪ است', () => {
    // ۱۳۵ از ۱۵۰ = دقیقاً ۹۰٪ → هنوز هشدار نیست (زیر آستانه شرط است)
    const atThreshold = underworkReport({
      contractMinutes: CONTRACT_150,
      workedMinutes: 135 * 60,
      availableDays: GAME_DAYS_PER_MONTH
    })
    expect(atThreshold.shouldWarn).toBe(false)

    const below = underworkReport({
      contractMinutes: CONTRACT_150,
      workedMinutes: 134 * 60,
      availableDays: GAME_DAYS_PER_MONTH
    })
    expect(below.shouldWarn).toBe(true)
  })

  test('استخدامِ وسطِ ماه: حجم به نسبتِ روزهای در دسترس کوچک می‌شود', () => {
    // نیمِ ماه زیرِ قرارداد بوده ⇒ انتظار ۷۵ ساعت، نه ۱۵۰
    const half = underworkReport({
      contractMinutes: CONTRACT_150,
      workedMinutes: 70 * 60,
      availableDays: 15
    })
    expect(half.expectedMinutes).toBe(75 * 60)
    expect(half.shouldWarn).toBe(false)

    // همان روزها ولی کارکردِ ناکافی ⇒ هشدار
    const short = underworkReport({
      contractMinutes: CONTRACT_150,
      workedMinutes: 30 * 60,
      availableDays: 15
    })
    expect(short.expectedMinutes).toBe(75 * 60)
    expect(short.shouldWarn).toBe(true)
  })

  test('قراردادِ صفر هرگز هشدار نمی‌سازد و تقسیم بر صفر نمی‌کند', () => {
    const report = underworkReport({
      contractMinutes: 0,
      workedMinutes: 0,
      availableDays: GAME_DAYS_PER_MONTH
    })
    expect(report.expectedMinutes).toBe(0)
    expect(report.ratio).toBe(1)
    expect(report.shouldWarn).toBe(false)
  })

  test('دادهٔ ناقص/منفی، سنجه را به هشدارِ تصادفی تبدیل نمی‌کند', () => {
    const report = underworkReport({
      contractMinutes: Number.NaN,
      workedMinutes: -50,
      availableDays: Number.NaN
    })
    expect(report.workedMinutes).toBe(0)
    expect(report.expectedMinutes).toBe(0)
    expect(report.shouldWarn).toBe(false)
  })

  test('متنِ هشدار فارسی، خوانا و بدون اصطلاحِ داخلی است', () => {
    const report = underworkReport({
      contractMinutes: CONTRACT_150,
      workedMinutes: 100 * 60,
      availableDays: GAME_DAYS_PER_MONTH
    })
    const text = underworkMessage({ employeeName: 'محمد رضایی', report })
    expect(/[\u0600-\u06FF]/.test(text)).toBe(true)
    expect(text).toContain('محمد رضایی')
    // هر دو عدد در «ساعت بازی» — نه روز، نه دقیقه
    // پیشنهادِ مدیریتی هست، ولی هیچ واژهٔ فنی/داخلی ندارد
    expect(text).toContain('پیشنهاد')
    for (const banned of ['Repository', 'Service', 'Database', 'Prisma', 'SQL', 'State']) {
      expect(text).not.toContain(banned)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
//  چرخهٔ واقعی — با یک دیتابیسِ جعلی
// ─────────────────────────────────────────────────────────────────────────────

interface FakeShift {
  businessId: string
  playerId: string
  startedAt: Date
  endedAt: Date
}

interface FakeEmployee {
  id: string
  playerId: string
  contractMinutesPerMonth: number
  hiredAt: Date
  player: { firstName: string; lastName: string | null }
  business: { id: string; name: string; ownerId: string }
}

/**
 * دیتابیسِ جعلیِ کمینه — فقط همان دو کوئری‌ای که این چرخه می‌زند.
 *
 * فیلترِ `endedAt` عمداً پیاده شده است: اگر جعلی همهٔ شیفت‌ها را برمی‌گرداند،
 * تست بازهٔ ماهِ بسته‌شده را نمی‌سنجید و سبزی‌اش بی‌معنا بود.
 */
function makeDb(employees: FakeEmployee[], shifts: FakeShift[]) {
  return {
    businessEmployee: {
      findMany: async () => employees
    },
    workSession: {
      findMany: async (args: {
        where: { businessId: string; endedAt: { gt: Date; lte?: Date } }
      }) =>
        shifts
          .filter((s) => s.businessId === args.where.businessId)
          .filter((s) => s.endedAt > args.where.endedAt.gt)
          .filter((s) => !args.where.endedAt.lte || s.endedAt <= args.where.endedAt.lte)
          .map((s) => ({ playerId: s.playerId, startedAt: s.startedAt, endedAt: s.endedAt }))
    }
  } as unknown as PrismaClient
}

/** جعلیِ اعلان — کلیدِ ضدتکرار را مثلِ خودِ سیستمِ اعلان یکتا نگه می‌دارد. */
function makeNotifier() {
  const seen = new Set<string>()
  const sent: Array<{ playerId: string; title: string; message: string; key?: string }> = []
  return {
    sent,
    announce: async (input: {
      playerId: string
      title: string
      message: string
      dedupeKey?: string
    }) => {
      if (input.dedupeKey && seen.has(input.dedupeKey)) {
        return false
      }
      if (input.dedupeKey) {
        seen.add(input.dedupeKey)
      }
      sent.push({
        playerId: input.playerId,
        title: input.title,
        message: input.message,
        key: input.dedupeKey
      })
      return true
    }
  }
}

/** `count` شیفتِ تمام‌شده با حداکثر کارکردِ روزانه، تا از سقفِ هر شیفت رد نشود. */
function shiftsFilling(
  businessId: string,
  playerId: string,
  count: number,
  from: Date
): FakeShift[] {
  const out: FakeShift[] = []
  for (let i = 0; i < count; i++) {
    // هر شیفت ۴۸۰ دقیقهٔ بازی (سقفِ کارکردِ روزانه) ⇒ هر شیفت ۱۶ دقیقه واقعی
    const startedAt = new Date(from.getTime() + i * 20 * 60_000)
    out.push({
      businessId,
      playerId,
      startedAt,
      endedAt: new Date(startedAt.getTime() + SALARY_MINUTES_PER_DAY * REAL_MS_PER_GAME_MINUTE)
    })
  }
  return out
}

function employeeOf(overrides: Partial<FakeEmployee> = {}): FakeEmployee {
  return {
    id: 'emp-1',
    playerId: 'player-1',
    contractMinutesPerMonth: FULL_MONTH_MINUTES,
    // دو ماهِ بازی پیش استخدام شده ⇒ کل ماهِ بسته‌شده زیرِ قرارداد بوده
    hiredAt: new Date(Date.now() - 3 * REAL_MS_PER_GAME_DAY * GAME_DAYS_PER_MONTH),
    player: { firstName: 'محمد', lastName: 'رضایی' },
    business: { id: 'biz-1', name: 'سوپرمارکت', ownerId: 'owner-1' },
    ...overrides
  }
}

describe('چرخهٔ پایشِ کم‌کارکردی', () => {
  test('کم‌کارکردی به کارفرما خبر می‌رسد، با کارکرد و حجمِ واقعی', async () => {
    const { start: monthStart } = closedMonth()
    // ۶ شیفت × ۴۸۰ دقیقه = ۲۸۸۰ دقیقه = ۴۸ ساعت بازی از ۲۴۰ ساعتِ قرارداد
    const shifts = shiftsFilling('biz-1', 'player-1', 6, new Date(monthStart.getTime() + 3_600_000))
    const notifier = makeNotifier()
    const service = new PayrollService(makeDb([employeeOf()], shifts), notifier)

    const result = await service.notifyUnderworked()

    expect(result.checked).toBe(1)
    expect(result.warned).toBe(1)
    expect(notifier.sent).toHaveLength(1)
    const alert = notifier.sent[0]!
    expect(alert.playerId).toBe('owner-1')
    expect(alert.title).toContain('سوپرمارکت')
    // ۲۸۸۰ دقیقه = ۴۸ ساعت کارکرد از حجمِ ۲۴۰ ساعته
    expect(alert.message).toContain(formatGameHours(48))
    expect(alert.message).toContain(formatGameHours(240))
  })

  test('همان ماه دوبار هشدار نمی‌سازد (کلیدِ ضدتکرار)', async () => {
    const { start: monthStart, end: monthEnd } = closedMonth()
    const shifts = shiftsFilling('biz-1', 'player-1', 6, new Date(monthStart.getTime() + 3_600_000))
    const notifier = makeNotifier()
    const service = new PayrollService(makeDb([employeeOf()], shifts), notifier)

    const first = await service.notifyUnderworked()
    const second = await service.notifyUnderworked()

    expect(first.warned).toBe(1)
    // بارِ دوم همان کلید را می‌فرستد ⇒ خودِ سیستمِ اعلان جلویش را می‌گیرد
    expect(second.warned).toBe(0)
    expect(notifier.sent).toHaveLength(1)
    expect(notifier.sent[0]!.key).toBe(`underwork:emp-1:${monthIndex(monthEnd.getTime())}`)
  })

  test('کارکردِ کافی هیچ اعلانی نمی‌سازد', async () => {
    const { start: monthStart } = closedMonth()
    // ۳۱ شیفت × ۴۸۰ دقیقه = ۱۴۸۸۰ دقیقه = ۲۴۸ ساعت ≥ ۲۴۰ ⇒ قرارداد پر است
    const shifts = shiftsFilling('biz-1', 'player-1', 31, new Date(monthStart.getTime() + 3_600_000))
    const notifier = makeNotifier()
    const service = new PayrollService(makeDb([employeeOf()], shifts), notifier)

    const result = await service.notifyUnderworked()
    expect(result.checked).toBe(1)
    expect(result.warned).toBe(0)
    expect(notifier.sent).toHaveLength(0)
  })

  test('تازه‌استخدامِ وسطِ ماه به‌خاطرِ روزهای نداشته هشدار نمی‌گیرد', async () => {
    const { start: monthStart, end: monthEnd } = closedMonth()
    // دو روزِ بازی پیش از پایانِ ماهِ بسته‌شده استخدام شده
    const hiredAt = new Date(monthEnd.getTime() - 2 * REAL_MS_PER_GAME_DAY)
    // ۲ شیفت × ۴۸۰ دقیقه = ۹۶۰ دقیقه، در برابر انتظارِ تعدیل‌شدهٔ ۹۶۰ دقیقه
    // (۲۴۰ ساعت × ۲/۳۰ = ۱۶ ساعت) ⇒ کارکرد کاملِ روزهای در دسترس
    const shifts = shiftsFilling('biz-1', 'player-1', 2, new Date(monthStart.getTime() + 3_600_000))
    const notifier = makeNotifier()
    const service = new PayrollService(makeDb([employeeOf({ hiredAt })], shifts), notifier)

    await service.notifyUnderworked()
    expect(notifier.sent).toHaveLength(0)
  })

  test('مالک که خودش در فهرستِ کارکنان است، به خودش گزارش نمی‌گیرد', async () => {
    const { start: monthStart } = closedMonth()
    const shifts = shiftsFilling('biz-1', 'owner-1', 1, new Date(monthStart.getTime() + 3_600_000))
    const notifier = makeNotifier()
    const service = new PayrollService(
      makeDb(
        [
          employeeOf({
            id: 'emp-owner',
            playerId: 'owner-1',
            business: { id: 'biz-1', name: 'سوپرمارکت', ownerId: 'owner-1' }
          })
        ],
        shifts
      ),
      notifier
    )

    const result = await service.notifyUnderworked()
    expect(result.checked).toBe(1)
    expect(notifier.sent).toHaveLength(0)
  })

  test('استخدامِ همین ماهِ جاری بازبینی نمی‌شود (روزی از ماهِ بسته‌شده زیرِ قرارداد نبوده)', async () => {
    const nowStart = gameMonthStart(Date.now())
    const shifts = shiftsFilling('biz-1', 'player-1', 1, new Date(nowStart.getTime() + 3_600_000))
    const notifier = makeNotifier()
    const service = new PayrollService(
      makeDb([employeeOf({ hiredAt: new Date(nowStart.getTime() + 60_000) })], shifts),
      notifier
    )

    const result = await service.notifyUnderworked()
    expect(result.checked).toBe(1)
    expect(notifier.sent).toHaveLength(0)
  })

  test('شیفت‌های ماهِ جاری در کارکردِ ماهِ بسته‌شده شمرده نمی‌شوند', async () => {
    const nowStart = gameMonthStart(Date.now())
    // یک شیفتِ پر، فقط در ماهِ جاری — کارکردِ ماهِ بسته‌شده همچنان صفر است
    const shifts = shiftsFilling('biz-1', 'player-1', 1, new Date(nowStart.getTime() + 3_600_000))
    const notifier = makeNotifier()
    const service = new PayrollService(makeDb([employeeOf()], shifts), notifier)

    await service.notifyUnderworked()
    expect(notifier.sent).toHaveLength(1)
    // کارکردِ گزارش‌شده از همین ماهِ بسته‌شده است ⇒ صفر، نه ۸ ساعتِ ماهِ جاری
    expect(notifier.sent[0]!.message).toContain(formatGameHours(0))
  })

  test('بدونِ سرویسِ اعلان، چرخه بی‌خطا و بی‌اثر است', async () => {
    const service = new PayrollService(makeDb([employeeOf()], []))
    await expect(service.notifyUnderworked()).resolves.toEqual({ checked: 0, warned: 0 })
  })
})

describe('قراردادِ «فقط گزارش، تصمیم دستِ کارفرما»', () => {
  const source = readText(join('src', 'modules', 'occupation', 'payroll.service.ts'))

  test('چرخهٔ پایش هیچ اخراج/تغییرِ قراردادی انجام نمی‌دهد', () => {
    const start = source.indexOf('async notifyUnderworked')
    expect(start).toBeGreaterThan(-1)
    // تا شروعِ متدِ بعدی
    const rest = source.slice(start)
    const end = rest.indexOf('\n  /**')
    const body = end > 0 ? rest.slice(0, end) : rest
    for (const forbidden of [
      'fireEmployee',
      'resignEmployee',
      'updateEmployeeContract',
      'businessEmployee.update',
      'businessEmployee.delete'
    ]) {
      expect(body).not.toContain(forbidden)
    }
    expect(body).toContain('announce')
  })

  test('چرخه در زمان‌بندِ واحدِ برنامه ثبت شده است', () => {
    // گزارشِ کم‌کارکردی دیگر در `app.ts` دستی صدا زده نمی‌شود؛ یکی از کارهای
    // همان زمان‌بندِ واحد است. پس دو چیز باید برقرار باشد: کار در فهرستِ
    // کارهای خودکار باشد، و در `Container` به متدِ واقعیِ حقوق وصل شده باشد.
    const jobs = readText(join('src', 'modules', 'autonomous', 'autonomous.jobs.ts'))
    const container = readText(join('src', 'services', 'container.ts'))
    const app = readText(join('src', 'app.ts'))

    expect(jobs).toContain('underwork')
    expect(container).toContain('notifyUnderworked')
    // و زمان‌بند در نقطهٔ راه‌اندازی بازی شروع شود، نه جایی دیگر.
    expect(app).toContain('autonomousService.start()')
  })
})
