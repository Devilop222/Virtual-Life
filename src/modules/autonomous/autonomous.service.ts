/**
 * ⚙️ لایهٔ پردازش خودکار — «ربات نباید منتظر باز شدن پنل بماند».
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  مشکلی که این فایل حل می‌کند
 * ─────────────────────────────────────────────────────────────────────────────
 *  پیش از این، همهٔ تغییرِ وضعیت‌های زمان‌محور به بازدیدِ بازیکن گره خورده بود:
 *  پایانِ تحصیل فقط وقتی صادر می‌شد که پنل تحصیل باز شود، شیفتِ کاری فقط وقتی
 *  بسته می‌شد که بازیکن کاری بکند، و سطحِ منطقه فقط وقتی بازبینی می‌شد که
 *  بازیکنِ تازه‌ای به گروه بپیوندد. یعنی «گذشتِ زمان» به‌تنهایی هیچ اثری نداشت.
 *
 *  این سرویس یک **زمان‌بندِ واحد** است: یک `setInterval` که هر تیک، کارهایی را
 *  که وقتشان رسیده اجرا می‌کند. هر کار فاصلهٔ خودش را دارد، پس نه همه‌چیز هر
 *  ثانیه اجرا می‌شود و نه برای هر قابلیت یک تایمرِ مستقل ساخته شده است.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  چهار قراردادی که این زمان‌بند باید رعایت کند
 * ─────────────────────────────────────────────────────────────────────────────
 *  ۱. **پایداری پس از ری‌استارت (Catch-up):** هیچ کاری «دقیقه‌های ازدست‌رفته» را
 *     تک‌تک بازپخش نمی‌کند؛ همه از تفاضلِ زمانی حساب می‌کنند
 *     (`gameMinutesSince`, `startedAt`, الی آخر). پس یک تیک پس از بالا آمدن،
 *     هرچه در زمان خاموشی سررسید شده بود یک‌جا و درست پردازش می‌شود. به همین
 *     دلیل اولین تیک بلافاصله اجرا می‌شود، نه بعد از یک فاصلهٔ کامل.
 *  ۲. **ضدتکرار:** اجرای دوبارهٔ یک کار نباید دو پول بدهد یا دو مدرک صادر کند.
 *     این تضمین در خودِ سرویس‌های دامنه است (نوشتارِ شرطی/کلیدِ یکتا)؛ زمان‌بند
 *     به آن تکیه می‌کند و به‌جای آن، اجرای **هم‌زمان** را هم می‌بندد.
 *  ۳. **محدود و بسته‌ای (Batched):** هر کار سقفِ ردیفِ خودش را دارد، پس یک
 *     انفجارِ سررسید (بعد از چند روز خاموشی) به یک پرس‌وجوی سنگین تبدیل نمی‌شود.
 *  ۴. **بی‌صدا در برابر خطا:** هیچ کاری نباید تیک را بکشد. خطای یک کار فقط لاگ
 *     می‌شود و بقیهٔ کارها و تیکِ بعدی سر جای خودشان هستند.
 *
 *  جای این منطق، `app.ts` است: زمان‌بند پس از اتصال دیتابیس شروع و در خاموشیِ
 *  نرم متوقف می‌شود تا هیچ کاری روی اتصالِ بسته اجرا نشود.
 */

import { logger } from '../../utils/logger'

/** فاصلهٔ تیکِ زمان‌بند. هر کارِ ثبت‌شده با ضریبِ خودش روی این تیک اجرا می‌شود. */
export const AUTONOMOUS_TICK_MS = 15_000

export interface AutonomousJob {
  /** نامِ کوتاه و پایدار برای لاگ و تست (بدون فاصله). */
  name: string
  /** فاصلهٔ اجرای این کار (میلی‌ثانیهٔ واقعی). */
  intervalMs: number
  /** کارِ چرخه — مسؤولِ گرفتنِ خطاهای جزئیِ خودش است. */
  run: () => Promise<unknown>
}

interface ScheduledJob {
  job: AutonomousJob
  /** اولین زمانی که این کار دوباره مجاز است اجرا شود. */
  nextRunAt: number
  /** آیا همین حالا در حال اجراست؟ (جلوگیری از روی‌هم‌افتادن) */
  running: boolean
}

export class AutonomousService {
  private readonly scheduled: ScheduledJob[] = []
  private timer: NodeJS.Timeout | null = null

  constructor(jobs: readonly AutonomousJob[] = []) {
    for (const job of jobs) {
      this.register(job)
    }
  }

  /** ثبتِ یک کار. فاصلهٔ غیرمعقول (صفر/منفی) به تیکِ پایه برگردانده می‌شود. */
  register(job: AutonomousJob): void {
    const interval = Number.isFinite(job.intervalMs)
      ? Math.max(AUTONOMOUS_TICK_MS, Math.floor(job.intervalMs))
      : AUTONOMOUS_TICK_MS
    this.scheduled.push({ job: { ...job, intervalMs: interval }, nextRunAt: 0, running: false })
  }

  /** فهرستِ نام کارها — برای تست و پنلِ وضعیت. */
  jobNames(): string[] {
    return this.scheduled.map((entry) => entry.job.name)
  }

  /**
   * یک تیک: هر کارِ سررسیدشده را یک‌بار اجرا می‌کند.
   *
   * تابعِ خالصی نیست (دیتابیس می‌خواند) ولی کاملاً قطعی است: هیچ حالتی جز
   * `nextRunAt` را عوض نمی‌کند و خروجی‌اش فهرستِ کارهایی است که واقعاً اجرا
   * شدند — یعنی تست می‌تواند بپرسد «پس از یک تیک، کدام کارها اجرا شدند؟».
   */
  async tick(now: number = Date.now()): Promise<string[]> {
    const ran: string[] = []
    for (const entry of this.scheduled) {
      if (entry.nextRunAt > now) {
        continue
      }
      // زمان‌بندی از «الان» شمرده می‌شود، نه از موعدِ قبلی: اگر سرور کند بوده
      // یا کار طول کشیده، در تیکِ بعدی سه بار پشت‌سرهم اجرا نمی‌شود.
      entry.nextRunAt = now + entry.job.intervalMs
      if (entry.running) {
        logger.warn({ job: entry.job.name }, 'autonomous job still running; skipping a slot')
        continue
      }
      entry.running = true
      ran.push(entry.job.name)
      try {
        await entry.job.run()
      } catch (error) {
        // یک کارِ خراب نباید تیک را بکشد؛ بقیهٔ کارها باید سر جایشان بمانند.
        logger.warn({ err: error, job: entry.job.name }, 'autonomous job failed')
      } finally {
        entry.running = false
      }
    }
    return ran
  }

  /**
   * شروعِ زمان‌بند + یک تیکِ فوری.
   *
   * تیکِ فوری همان Catch-up است: هر کاری `nextRunAt = 0` دارد، پس در اولین تیک
   * اجرا می‌شود و هر چیزی که در زمان خاموشی سررسید شده بود را می‌بندد.
   */
  start(): void {
    if (this.timer) {
      return
    }
    void this.tick()
    this.timer = setInterval(() => {
      void this.tick()
    }, AUTONOMOUS_TICK_MS)
    // تایمر نباید ربات را زنده نگه دارد؛ خاموشیِ نرم با SIGTERM می‌آید.
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }
}
