import { Prisma } from '@prisma/client'
import { BANK_POOL_ID, BANK_POOL_SEED } from '../../config/economy'

/**
 * صندوق بانک — تنها جایی که بانک واقعاً پول دارد.
 *
 * چرا این فایل وجود دارد؟
 * پیش از این، `disburseLoan` اصل وام را «از هیچ» می‌ساخت و سود سپرده هم
 * بدون هیچ منبعی به حساب بازیکن اضافه می‌شد. نتیجه: بانک در دفاتر یک
 * ترازنامهٔ خالی داشت و تنها راه فهمیدن تورم، مقایسهٔ مجموع موجودی‌ها بود.
 *
 * حالا مدل بانک صریح است:
 *   • سپرده‌گذاری بازیکن ⇒ افزایش صندوق (پول از کیف بازیکن بیرون می‌رود و
 *     در ترازنامهٔ بانک می‌نشیند؛ دو بار در گردش نیست)
 *   • پرداخت وام ⇒ کاهش شرطی صندوق؛ اگر صندوق کافی نباشد وام پرداخت نمی‌شود
 *   • بازپرداخت وام ⇒ افزایش صندوق (با تفکیک اصل و سود در دفتر کل)
 *   • سود سپرده/حساب ⇒ کاهش صندوق تا سقف موجودی (سود هرگز از هیچ ساخته نمی‌شود)
 *
 * تنها پولِ «تازه»ی بانک، سرمایهٔ اولیهٔ یک‌بارهٔ `BANK_POOL_SEED` است که
 * با اولین دسترسی ساخته می‌شود و دیگر هرگز تکرار نمی‌شود.
 *
 * همهٔ متدها کلاینت تراکنش می‌گیرند تا تغییر صندوق و ردیف دفتر کل اتمی باشد.
 */
export class BankPoolService {
  /** اطمینان از وجود ردیف صندوق (یک‌بار؛ دوباره بذر نمی‌پاشد). */
  async ensure(tx: Prisma.TransactionClient): Promise<void> {
    try {
      await tx.bankPool.upsert({
        where: { id: BANK_POOL_ID },
        create: { id: BANK_POOL_ID, balance: BANK_POOL_SEED },
        // ردیف موجود دست‌نخورده می‌ماند؛ فقط یک no-op تا upsert معتبر باشد
        update: { balance: { increment: 0 } }
      })
    } catch (error) {
      // رقابت دو درخواست همزمان روی ساخت نخستین ردیف: دیگری ساخته است
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return
      }
      throw error
    }
  }

  /** موجودی واقعی صندوق (بدون بذرپاشی تازه). */
  async balance(tx: Prisma.TransactionClient): Promise<number> {
    const row = await tx.bankPool.findUnique({
      where: { id: BANK_POOL_ID },
      select: { balance: true }
    })
    return Math.max(0, Math.round(Number(row?.balance ?? 0)))
  }

  /**
   * کسر شرطی از صندوق (برای پرداخت وام).
   * @returns آیا مبلغ به‌طور کامل کسر شد؟
   */
  async debit(tx: Prisma.TransactionClient, amount: number): Promise<boolean> {
    const safe = this.safeAmount(amount)
    if (safe <= 0) {
      return true
    }
    await this.ensure(tx)

    const debited = await tx.bankPool.updateMany({
      where: { id: BANK_POOL_ID, balance: { gte: safe } },
      data: {
        balance: { decrement: safe },
        totalDisbursed: { increment: safe }
      }
    })
    return debited.count === 1
  }

  /** کسر تا سقف موجودی (برای سود سپرده)؛ هرگز منفی نمی‌شود. */
  async debitUpTo(tx: Prisma.TransactionClient, amount: number): Promise<number> {
    const safe = this.safeAmount(amount)
    if (safe <= 0) {
      return 0
    }
    await this.ensure(tx)

    const available = await this.balance(tx)
    const payable = Math.min(safe, available)
    if (payable <= 0) {
      return 0
    }

    const debited = await tx.bankPool.updateMany({
      where: { id: BANK_POOL_ID, balance: { gte: payable } },
      data: {
        balance: { decrement: payable },
        totalDepositInterest: { increment: payable }
      }
    })
    return debited.count === 1 ? payable : 0
  }

  /** واریز به صندوق: سپردهٔ بازیکن. */
  async creditDeposit(tx: Prisma.TransactionClient, amount: number): Promise<number> {
    const safe = this.safeAmount(amount)
    if (safe <= 0) {
      return 0
    }
    await this.ensure(tx)
    await tx.bankPool.update({
      where: { id: BANK_POOL_ID },
      data: {
        balance: { increment: safe },
        totalDeposited: { increment: safe }
      }
    })
    return safe
  }

  /**
   * واریز بازپرداخت وام به صندوق با تفکیک اصل و سود.
   * سود وام درآمد بانک است و همان چیزی است که سود سپرده‌ها را می‌پردازد.
   */
  async creditRepayment(
    tx: Prisma.TransactionClient,
    principal: number,
    interest: number
  ): Promise<void> {
    const safePrincipal = this.safeAmount(principal)
    const safeInterest = this.safeAmount(interest)
    const total = safePrincipal + safeInterest
    if (total <= 0) {
      return
    }

    await tx.bankPool.update({
      where: { id: BANK_POOL_ID },
      data: {
        balance: { increment: total },
        totalRepaid: { increment: safePrincipal },
        totalLoanInterest: { increment: safeInterest }
      }
    })
  }

  /** نمای صندوق برای ممیزی و پنل. */
  async snapshot(
    db: Prisma.TransactionClient
  ): Promise<{
    balance: number
    totalDeposited: number
    totalDisbursed: number
    totalRepaid: number
    totalLoanInterest: number
    totalDepositInterest: number
  }> {
    const row = await db.bankPool.findUnique({ where: { id: BANK_POOL_ID } })
    return {
      balance: Math.max(0, Math.round(Number(row?.balance ?? 0))),
      totalDeposited: Math.round(Number(row?.totalDeposited ?? 0)),
      totalDisbursed: Math.round(Number(row?.totalDisbursed ?? 0)),
      totalRepaid: Math.round(Number(row?.totalRepaid ?? 0)),
      totalLoanInterest: Math.round(Number(row?.totalLoanInterest ?? 0)),
      totalDepositInterest: Math.round(Number(row?.totalDepositInterest ?? 0))
    }
  }

  private safeAmount(amount: number): number {
    return Number.isFinite(amount) ? Math.max(0, Math.round(amount)) : 0
  }
}
