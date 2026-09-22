import { PrismaClient } from '@prisma/client'
import { NotFoundError } from '../../utils/classes/errors'
import { isPlayerEmployed } from '../occupation/employment'

export type MissionKey =
  | 'open_bank_account'
  | 'first_job'
  | 'first_savings'
  | 'buy_first_home'
  | 'finish_education'
  | 'start_education'
  | 'grow_savings'
  | 'found_company'
  | 'hire_employee'
  | 'upgrade_company'
  | 'recover_health'
  | 'reduce_fatigue'
  | 'repay_loan'
  | 'buy_shop_item'
  | 'build_wealth'

export interface Mission {
  key: MissionKey
  title: string
  description: string
  hint: string
  progress: number
  target: number
  done: boolean
  reward: string
  difficulty: 1 | 2 | 3
  /** فوریت نمایش: مأموریت‌های فوری (سلامت، خستگی، بدهی) اول نشان داده می‌شوند. */
  urgent?: boolean
}

export interface MissionBoard {
  missions: Mission[]
  completedCount: number
  totalTracked: number
}

interface PlayerSnapshot {
  id: string
  age: number
  balance: number
  bankBalance: number
  health: number
  fatigue: number
  experience: number
  currentDegree: string
  isEnrolled: boolean
  hasJob: boolean
  properties: number
  businesses: number
  employees: number
  businessLevel: number
  activeDebt: number
  inventoryItems: number
}

const DEGREE_ORDER: Record<string, number> = {
  DIPLOMA: 1,
  ASSOCIATE: 2,
  BACHELOR: 3,
  MASTER: 4,
  DOCTORATE: 5
}

/** حداکثر تعداد مأموریت فعال نمایش‌داده‌شده. */
const MAX_ACTIVE_MISSIONS = 4

/**
 * موتور مأموریت بر پایهٔ قواعد (Rule Engine).
 * هیچ فراخوانی LLM یا تولید تصادفی در Runtime انجام نمی‌شود؛
 * مأموریت‌ها از وضعیت واقعی بازیکن استخراج می‌شوند تا CPU و تأخیر کم بماند.
 */
export class MissionService {
  constructor(private readonly db: PrismaClient) {}

  async getMissionBoard(telegramUserId: bigint): Promise<MissionBoard> {
    const snapshot = await this.loadSnapshot(telegramUserId)
    const all = this.evaluate(snapshot)

    const completed = all.filter((m) => m.done)

    // مأموریت‌های فوری همیشه بالای فهرست می‌آیند و توسط سقف حذف نمی‌شوند
    const pending = all
      .filter((m) => !m.done)
      .sort((a, b) => {
        const urgency = Number(Boolean(b.urgent)) - Number(Boolean(a.urgent))
        if (urgency !== 0) return urgency
        return a.difficulty - b.difficulty
      })

    return {
      missions: pending.slice(0, MAX_ACTIVE_MISSIONS),
      completedCount: completed.length,
      totalTracked: all.length
    }
  }

  /** خواندن وضعیت بازیکن با حداقل Query و بدون N+1. */
  private async loadSnapshot(telegramUserId: bigint): Promise<PlayerSnapshot> {
    const player = await this.db.player.findUnique({
      where: { telegramUserId },
      select: {
        id: true,
        age: true,
        balance: true,
        health: true,
        fatigue: true,
        experience: true,
        currentDegree: true,
        isEnrolled: true
      }
    })
    if (!player) {
      throw new NotFoundError('Player not found')
    }

    const [
      bankAgg,
      propertyCount,
      businesses,
      employeeCount,
      debtAgg,
      inventoryCount,
      employed
    ] = await Promise.all([
        this.db.bankAccount.aggregate({
          where: { playerId: player.id },
          _sum: { balance: true }
        }),
        this.db.property.count({ where: { ownerId: player.id } }),
        this.db.business.findMany({
          where: { ownerId: player.id, status: 'ACTIVE' },
          select: { id: true, level: true }
        }),
        this.db.businessEmployee.count({
          where: { business: { ownerId: player.id }, isActive: true }
        }),
        this.db.loan.aggregate({
          where: { playerId: player.id, status: 'ACTIVE' },
          _sum: { remainingAmount: true }
        }),
        this.db.playerInventory.count({ where: { playerId: player.id, quantity: { gt: 0 } } }),
        isPlayerEmployed(this.db, player.id)
      ])

    return {
      id: player.id,
      age: player.age,
      balance: Number(player.balance),
      bankBalance: Number(bankAgg._sum.balance ?? 0),
      health: player.health,
      fatigue: player.fatigue,
      experience: player.experience,
      currentDegree: player.currentDegree,
      isEnrolled: player.isEnrolled,
      hasJob: employed,
      properties: propertyCount,
      businesses: businesses.length,
      employees: employeeCount,
      businessLevel: businesses.reduce((max, b) => Math.max(max, b.level), 0),
      activeDebt: Number(debtAgg._sum.remainingAmount ?? 0),
      inventoryItems: inventoryCount
    }
  }

  /** قواعد مأموریت؛ ترتیب از ساده به پیشرفته. */
  private evaluate(s: PlayerSnapshot): Mission[] {
    const missions: Mission[] = []
    const degreeRank = DEGREE_ORDER[s.currentDegree] ?? 1

    missions.push({
      key: 'open_bank_account',
      title: 'افتتاح حساب بانکی',
      description: 'برای پس‌انداز و دریافت سود، حساب بانکی باز کن.',
      hint: 'کلمهٔ «بانک» را بفرست.',
      progress: s.bankBalance > 0 ? 1 : 0,
      target: 1,
      done: s.bankBalance > 0,
      reward: 'دسترسی به سود سپرده و وام',
      difficulty: 1
    })

    missions.push({
      key: 'first_job',
      title: 'اولین تجربهٔ کاری',
      description: 'یک کار پاره‌وقت انجام بده و اولین دستمزدت را بگیر.',
      hint: 'در گروه، کلمهٔ «کار» را بفرست.',
      progress: s.hasJob ? 10 : Math.min(s.experience, 10),
      target: 10,
      // اشتغال واقعی (نوبت کاری یا کسب‌وکار) بر تجربهٔ خام اولویت دارد
      done: s.hasJob || s.experience >= 10,
      reward: 'کسب تجربه و درآمد پایه',
      difficulty: 1
    })

    missions.push({
      key: 'first_savings',
      title: 'اولین پس‌انداز',
      description: 'موجودی حساب بانکی‌ات را به یک میلیون تومان برسان.',
      hint: 'از بخش بانک، مبلغی واریز کن.',
      progress: Math.min(s.bankBalance, 1_000_000),
      target: 1_000_000,
      done: s.bankBalance >= 1_000_000,
      reward: 'افزایش امتیاز اعتباری',
      difficulty: 1
    })

    if (!s.isEnrolled && degreeRank < 5) {
      missions.push({
        key: 'start_education',
        title: 'ادامهٔ تحصیل',
        description: 'در مقطع بعدی تحصیلی ثبت‌نام کن.',
        hint: 'در گروه، کلمهٔ «تحصیل» را بفرست.',
        progress: 0,
        target: 1,
        done: false,
        reward: 'دسترسی به مشاغل بهتر',
        difficulty: 2
      })
    }

    if (s.isEnrolled) {
      missions.push({
        key: 'finish_education',
        title: 'تکمیل دورهٔ تحصیلی',
        description: 'دورهٔ تحصیلی فعلی‌ات را تا فارغ‌التحصیلی کامل کن.',
        hint: 'در گروه، از پنل تحصیل پیشرفت را ببین.',
        progress: 0,
        target: 1,
        done: false,
        reward: 'مدرک بالاتر و افزایش درآمد',
        difficulty: 2
      })
    }

    missions.push({
      key: 'buy_first_home',
      title: 'خرید اولین خانه',
      description: 'یک ملک بخر تا بتوانی استراحت کنی و دارایی بسازی.',
      hint: 'در گروه، کلمهٔ «خانه» را بفرست.',
      progress: Math.min(s.properties, 1),
      target: 1,
      done: s.properties >= 1,
      reward: 'ریکاوری خستگی و افزایش دارایی',
      difficulty: 2
    })

    if (s.fatigue >= 60) {
      missions.push({
        key: 'reduce_fatigue',
        title: 'رفع خستگی',
        description: 'خستگی‌ات را به کمتر از ۳۰ درصد برسان.',
        hint: 'در گروه: در خانه استراحت کن یا از فروشگاه نوشیدنی انرژی بخر.',
        progress: Math.max(0, 100 - s.fatigue),
        target: 70,
        done: false,
        reward: 'کارایی بیشتر در کار',
        difficulty: 1,
        urgent: true
      })
    }

    if (s.health <= 60) {
      missions.push({
        key: 'recover_health',
        title: 'بازیابی سلامت',
        description: 'سلامتت را به بالای ۸۰ درصد برسان.',
        hint: 'در گروه، از فروشگاه کالای درمانی بخر یا استراحت کن.',
        progress: s.health,
        target: 80,
        done: false,
        reward: 'جلوگیری از توقف کار',
        difficulty: 1,
        urgent: true
      })
    }

    if (s.activeDebt > 0) {
      missions.push({
        key: 'repay_loan',
        title: 'تسویهٔ بدهی',
        description: 'وام جاری‌ات را تسویه کن تا اعتبار مالی‌ات بالا برود.',
        hint: 'از پنل بانک، قسط پرداخت کن.',
        progress: 0,
        target: 1,
        done: false,
        reward: 'افزایش امتیاز اعتباری',
        difficulty: 2,
        urgent: true
      })
    }

    if (s.inventoryItems === 0) {
      missions.push({
        key: 'buy_shop_item',
        title: 'اولین خرید از فروشگاه',
        description: 'یک کالا از فروشگاه بخر و در انبارت نگه دار.',
        hint: 'در گروه، کلمهٔ «فروشگاه» را بفرست.',
        progress: 0,
        target: 1,
        done: false,
        reward: 'دسترسی به اثرات کالاها',
        difficulty: 1
      })
    }

    missions.push({
      key: 'grow_savings',
      title: 'پس‌انداز ده میلیونی',
      description: 'موجودی بانکی‌ات را به ده میلیون تومان برسان.',
      hint: 'در گروه مرتب کار کن و بخشی از درآمد را واریز کن.',
      progress: Math.min(s.bankBalance, 10_000_000),
      target: 10_000_000,
      done: s.bankBalance >= 10_000_000,
      reward: 'سقف اعتباری بالاتر',
      difficulty: 2
    })

    if (s.experience >= 50 && s.businesses === 0) {
      missions.push({
        key: 'found_company',
        title: 'تأسیس کسب‌وکار',
        description: 'با سرمایه و سابقهٔ کافی، کسب‌وکار خودت را راه بینداز.',
        hint: 'در گروه: کار ← کار تمام‌وقت ← تأسیس کسب‌وکار',
        progress: 0,
        target: 1,
        done: false,
        reward: 'درآمد غیرفعال',
        difficulty: 3
      })
    }

    if (s.businesses > 0) {
      missions.push({
        key: 'hire_employee',
        title: 'استخدام نیروی کار',
        description: 'برای کسب‌وکارت حداقل سه کارمند فعال داشته باش.',
        hint: 'در گروه، از پنل کسب‌وکار آگهی استخدام بزن.',
        progress: Math.min(s.employees, 3),
        target: 3,
        done: s.employees >= 3,
        reward: 'افزایش بهره‌وری شرکت',
        difficulty: 3
      })

      missions.push({
        key: 'upgrade_company',
        title: 'ارتقای کسب‌وکار',
        description: 'کسب‌وکارت را به سطح ۳ برسان.',
        hint: 'در گروه، از پنل کسب‌وکار ارتقا بزن.',
        progress: Math.min(s.businessLevel, 3),
        target: 3,
        done: s.businessLevel >= 3,
        reward: 'ظرفیت و درآمد بیشتر',
        difficulty: 3
      })
    }

    missions.push({
      key: 'build_wealth',
      title: 'ثروت صد میلیونی',
      description: 'مجموع دارایی نقدی و بانکی‌ات را به صد میلیون تومان برسان.',
      hint: 'ترکیبی از کار، کسب‌وکار و سرمایه‌گذاری.',
      progress: Math.min(s.balance + s.bankBalance, 100_000_000),
      target: 100_000_000,
      done: s.balance + s.bankBalance >= 100_000_000,
      reward: 'ورود به جمع ثروتمندان منطقه',
      difficulty: 3
    })

    return missions
  }
}
