import { PrismaClient, LoanStatus, PlayerStatus, TransactionType } from '@prisma/client'
import { NotFoundError } from '../../utils/classes/errors'
import { isPlayerEmployed } from '../occupation/employment'
import { businessCollateralValue } from '../banking/collateral'

export interface CreditProfile {
  score: number
  grade: string
  gradeLabel: string
  cashBalance: number
  bankBalance: number
  assetValue: number
  totalDebt: number
  netWorth: number
  activeLoans: number
  repaidLoans: number
  hasJob: boolean
  maxLoanAmount: number
  factors: Array<{ label: string; impact: number }>
}

const MIN_SCORE = 300
const MAX_SCORE = 900
const BASE_SCORE = 500

/**
 * محاسبهٔ اعتبار مالی بازیکن.
 * امتیاز از داده‌های واقعی (Source of Truth) محاسبه می‌شود و در دیتابیس ذخیره نمی‌شود
 * تا هیچ‌وقت با وضعیت واقعی ناسازگار نشود.
 */
export class CreditService {
  constructor(private readonly db: PrismaClient) {}

  async getCreditProfile(telegramUserId: bigint): Promise<CreditProfile> {
    const player = await this.db.player.findUnique({
      where: { telegramUserId },
      select: {
        id: true,
        status: true,
        experience: true,
        balance: true
      }
    })
    if (!player) {
      throw new NotFoundError('Player not found')
    }

    const [
      bankAccounts,
      properties,
      businesses,
      activeLoans,
      repaidLoans,
      salaryCount,
      employed,
      p2pDefaults,
      bankDefaults
    ] = await Promise.all([
      this.db.bankAccount.findMany({
        where: { playerId: player.id },
        select: { balance: true }
      }),
      this.db.property.findMany({
        where: { ownerId: player.id },
        select: { baseAssetValue: true }
      }),
      this.db.business.findMany({
        where: { ownerId: player.id },
        select: { level: true, treasury: true }
      }),
      this.db.loan.findMany({
        where: { playerId: player.id, status: LoanStatus.ACTIVE },
        select: { remainingAmount: true }
      }),
      this.db.loan.count({ where: { playerId: player.id, status: LoanStatus.PAID } }),
      this.db.financialTransaction.count({
        where: { destinationPlayerId: player.id, type: TransactionType.SALARY_PAYMENT }
      }),
      isPlayerEmployed(this.db, player.id),
      // نکول قرض بازیکنی: هر نکول، اعتبار واقعیِ بازیکن را پایین می‌آورد
      this.db.playerLoan.count({ where: { borrowerId: player.id, status: 'DEFAULTED' } }),
      // نکول وام بانکی: سررسیدگذشته‌های تسویه‌نشده باید در اعتبار دیده شوند،
      // وگرنه نکول یک عملِ بی‌عاقبت می‌شد و سقف وامِ بعدی تغییری نمی‌کرد.
      this.db.loan.count({ where: { playerId: player.id, status: LoanStatus.DEFAULTED } })
      ])

    const cashBalance = Number(player.balance)
    const bankBalance = bankAccounts.reduce((acc, a) => acc + Number(a.balance), 0)
    const propertyValue = properties.reduce((acc, p) => acc + Number(p.baseAssetValue), 0)
    const businessValue = businesses.reduce(
      (acc, b) => acc + businessCollateralValue(Number(b.treasury), b.level),
      0
    )
    const assetValue = propertyValue + businessValue
    const totalDebt = activeLoans.reduce((acc, l) => acc + Number(l.remainingAmount), 0)
    const netWorth = cashBalance + bankBalance + assetValue - totalDebt

    const factors: Array<{ label: string; impact: number }> = []
    let score = BASE_SCORE

    // دارایی نقدی و بانکی
    const liquidity = cashBalance + bankBalance
    const liquidityPoints = Math.min(120, Math.floor(liquidity / 5_000_000) * 10)
    if (liquidityPoints !== 0) {
      score += liquidityPoints
      factors.push({ label: 'موجودی نقدی و بانکی', impact: liquidityPoints })
    }

    // دارایی ثابت (ملک و شرکت)
    const assetPoints = Math.min(150, Math.floor(assetValue / 20_000_000) * 15)
    if (assetPoints !== 0) {
      score += assetPoints
      factors.push({ label: 'ارزش دارایی‌ها', impact: assetPoints })
    }

    // بدهی جاری
    const debtPenalty = totalDebt > 0 ? -Math.min(180, Math.floor(totalDebt / 5_000_000) * 20) : 0
    if (debtPenalty !== 0) {
      score += debtPenalty
      factors.push({ label: 'بدهی جاری', impact: debtPenalty })
    }

    // سابقهٔ بازپرداخت موفق
    const repayPoints = Math.min(120, repaidLoans * 40)
    if (repayPoints !== 0) {
      score += repayPoints
      factors.push({ label: 'سابقهٔ بازپرداخت وام', impact: repayPoints })
    }

    // ثبات شغلی (تعداد دفعات دریافت حقوق)
    const jobPoints = Math.min(90, Math.floor(salaryCount / 5) * 15)
    if (jobPoints !== 0) {
      score += jobPoints
      factors.push({ label: 'ثبات شغلی', impact: jobPoints })
    }

    // اشتغال جاری: درآمد فعال ریسک اعتباری را کم می‌کند
    if (employed) {
      score += 40
      factors.push({ label: 'اشتغال فعال', impact: 40 })
    }      // نکول قرض بازیکنی: قوری که سررسیدش را نگرفت، اعتبارش را هم از دست داده است.
      // (همین جریمه است که نکول را از «پاداش رایگان» به «هزینهٔ واقعی» تبدیل می‌کند.)
      const defaultPenalty = -Math.min(200, p2pDefaults * 50)
      if (defaultPenalty !== 0) {
        score += defaultPenalty
        factors.push({ label: 'نکول قرض بازیکنی', impact: defaultPenalty })
      }

      // نکول وام بانکی: وامی که پس از مهلت پرداخت نشد و وثیقه‌اش تملک شد.
      // جریمهٔ سنگین‌تر از قرض بازیکنی است چون طرفِ مقابلش خودِ بانک است.
      const bankDefaultPenalty = -Math.min(240, bankDefaults * 80)
      if (bankDefaultPenalty !== 0) {
        score += bankDefaultPenalty
        factors.push({ label: 'نکول وام بانکی', impact: bankDefaultPenalty })
      }

    // تجربهٔ کاری
    const expPoints = Math.min(60, Math.floor(player.experience / 100) * 10)
    if (expPoints !== 0) {
      score += expPoints
      factors.push({ label: 'تجربهٔ کاری', impact: expPoints })
    }

    // وضعیت حساب
    if (player.status !== PlayerStatus.ACTIVE) {
      score -= 100
      factors.push({ label: 'وضعیت غیرفعال حساب', impact: -100 })
    }

    score = Math.max(MIN_SCORE, Math.min(MAX_SCORE, Math.round(score)))
    const { grade, label } = gradeOf(score)

    // سقف وام: تابعی از اعتبار و دارایی، با درنظرگرفتن بدهی فعلی
    const creditFactor = (score - MIN_SCORE) / (MAX_SCORE - MIN_SCORE) // 0..1
    const assetCap = Math.round(assetValue * 0.5)
    const creditCap = Math.round(creditFactor * 60_000_000)
    const maxLoanAmount = Math.max(0, Math.min(assetCap, creditCap) - totalDebt)

    return {
      score,
      grade,
      gradeLabel: label,
      cashBalance,
      bankBalance,
      assetValue,
      totalDebt,
      netWorth,
      activeLoans: activeLoans.length,
      repaidLoans,
      hasJob: employed,
      maxLoanAmount,
      factors
    }
  }
}

function gradeOf(score: number): { grade: string; label: string } {
  if (score >= 800) return { grade: 'A+', label: 'بسیار عالی' }
  if (score >= 700) return { grade: 'A', label: 'عالی' }
  if (score >= 620) return { grade: 'B', label: 'خوب' }
  if (score >= 540) return { grade: 'C', label: 'متوسط' }
  if (score >= 450) return { grade: 'D', label: 'ضعیف' }
  return { grade: 'E', label: 'پرخطر' }
}
