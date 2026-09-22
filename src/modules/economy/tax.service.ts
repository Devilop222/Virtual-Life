import { Prisma, TransactionType } from '@prisma/client'
import { businessProfitTaxOf, incomeTaxOf } from '../../config/economy'

/**
 * کلاینت تراکنش (یا کلاینت عادی). مالیات همیشه داخل تراکنشِ همان عملیات مالی
 * اجرا می‌شود تا «کسر پول» و «ثبت مالیات» از هم جدا نشوند.
 */
export type EconomyDb = Prisma.TransactionClient

export interface WithheldIncomeTax {
  /** مبلغ ناخالص پیش از مالیات. */
  gross: number
  /** مالیات کسرشده. */
  tax: number
  /** مبلغی که واقعاً به بازیکن می‌رسد. */
  net: number
  /** منطقه‌ای که مالیات به صندوقش واریز شد (اگر بازیکن منطقه داشته باشد). */
  groupId: string | null
}

/**
 * صندوق عمومی منطقه — تنها منبع حقیقتِ پولِ عمومیِ هر منطقه.
 *
 * دو جریان دارد:
 *   • ورودی: مالیات بر درآمد، مالیات بر سود کسب‌وکار، فروش بلیت قرعه‌کشی
 *   • خروجی: جایزهٔ قرعه‌کشی هفتگی (از همان پولی که بابت بلیت‌ها جمع شده)
 *
 * پیش از این، `RegionStat.taxRevenue` فقط یک عدد مشتق بود
 * (`۲٪ گردش مالی هفته`) که هیچ‌کس آن را نمی‌پرداخت و هیچ‌جا خرج نمی‌شد؛ و
 * جایزهٔ قرعه‌کشی مستقیماً از هیچ ساخته می‌شد. حالا هر دو طرف واقعی‌اند:
 * پول از کیف بازیکن بیرون می‌رود، در صندوق منطقه می‌نشیند و از همان‌جا
 * پرداخت می‌شود.
 *
 * ستون دیتابیسی همان `tax_revenue` است (بدون مهاجرت اسکیما) و همهٔ نوشتن‌ها
 * فقط از همین فایل انجام می‌شود.
 */
export class RegionFundService {
  /** افزودن مبلغ به صندوق منطقه (بدون منفی و بدون سرریز). */
  async credit(tx: EconomyDb, groupId: string, amount: number): Promise<number> {
    const safe = Math.max(0, Math.round(Number.isFinite(amount) ? amount : 0))
    if (safe <= 0) {
      return 0
    }

    await tx.regionStat.upsert({
      where: { groupId },
      create: { groupId, taxRevenue: safe },
      update: { taxRevenue: { increment: safe } }
    })

    return safe
  }

  /**
   * برداشت از صندوق منطقه با شرط کفایت موجودی.
   * اگر صندوق کمتر از مبلغ درخواستی باشد، فقط به‌اندازهٔ موجودی برداشت
   * می‌شود — هرگز منفی نمی‌شود و هرگز پول از هیچ ساخته نمی‌شود.
   *
   * @returns مبلغی که واقعاً برداشت شد (ممکن است صفر باشد)
   */
  async debitUpTo(tx: EconomyDb, groupId: string, amount: number): Promise<number> {
    const requested = Math.max(0, Math.round(Number.isFinite(amount) ? amount : 0))
    if (requested <= 0) {
      return 0
    }

    const stat = await tx.regionStat.findUnique({
      where: { groupId },
      select: { taxRevenue: true }
    })
    const available = Math.max(0, Math.round(Number(stat?.taxRevenue ?? 0)))
    const payable = Math.min(requested, available)
    if (payable <= 0) {
      return 0
    }

    const drained = await tx.regionStat.updateMany({
      where: { groupId, taxRevenue: { gte: payable } },
      data: { taxRevenue: { decrement: payable } }
    })

    // رقابت همزمان: تراکنش جاری برمی‌گردد و فراخواننده می‌تواند صفر فرض کند
    return drained.count === 1 ? payable : 0
  }
}

/**
 * مالیات — تنها مسیر قانونیِ کسر مالیات در کل بازی.
 *
 * چرا این فایل وجود دارد؟
 * پیش از این، «مالیات محلی» روی پنل منطقه یک عدد مشتق بود که هیچ‌کس آن را
 * نمی‌پرداخت؛ تنها مالیات واقعیِ بازی ۱۵٪ برداشت مالک از خزانه بود که نه نوع
 * تراکنش درستی داشت و نه به منطقه می‌رسید. نتیجه: نه بازیکن می‌فهمید چرا
 * مالیات می‌دهد، نه منطقه از آن چیزی می‌گرفت.
 *
 * حالا هر کسر مالیات از همین‌جا می‌گذرد و سه کار را با هم انجام می‌دهد:
 *   ۱. مبلغ ناخالص را در دفتر کل ثبت می‌کند (تا دستمزد واقعی گم نشود)
 *   ۲. مالیات را با نوع `TAX_PAYMENT` به‌عنوان خروج ثبت می‌کند
 *   ۳. همان مبلغ را به صندوق منطقه واریز می‌کند
 *
 * نکتهٔ حسابداری: مالیات‌گیری «در مبدأ» است — بازیکن هیچ‌وقت پول مالیات را
 * در دست نمی‌گیرد، ولی دفتر او هم ناخالص (درآمد) و هم مالیات (خروج) را
 * می‌بیند، پس جمعِ دفتر همیشه با تغییر واقعی موجودی برابر است.
 */
export class TaxService {
  constructor(private readonly regionFund = new RegionFundService()) {}

  /**
   * مالیات بر درآمد یک مبلغ ناخالص.
   * نرخ‌ها در `config/economy` زندگی می‌کنند؛ این متد فقط روپوشِ تست‌پذیر و
   * خوانای همان تابع است (پنل/آزمون‌ها از همین‌جا می‌خوانند تا هیچ‌کس نرخ را
   * دوباره پیاده نکند).
   */
  static incomeTax(gross: number): number {
    return incomeTaxOf(gross)
  }

  /** مالیات بر سود توزیع‌شدهٔ کسب‌وکار (روپوشِ خوانای `businessProfitTaxOf`). */
  static profitTax(gross: number): number {
    return businessProfitTaxOf(gross)
  }

  /**
   * کسر مالیات بر درآمد در مبدأ.
   *
   * @param tx کلاینت تراکنشِ همان عملیات مالی (اتمی با پرداخت حقوق)
   * @param input بازیکن، مبلغ ناخالص و توضیح تراکنش
   */
  async withholdIncomeTax(
    tx: EconomyDb,
    input: { playerId: string; gross: number; reference: string; groupId?: string | null }
  ): Promise<WithheldIncomeTax> {
    const gross = Math.max(0, Math.floor(Number.isFinite(input.gross) ? input.gross : 0))
    const tax = incomeTaxOf(gross)
    if (tax <= 0) {
      return { gross, tax: 0, net: gross, groupId: null }
    }

    const groupId =
      input.groupId !== undefined
        ? input.groupId
        : // منطقهٔ بازیکن = منطقهٔ سکونت (همان «اقامت»)؛ بدون اقامت،
          // مالیات محلی جایی برای واریز ندارد و تنها در دفتر جهانی می‌ماند.
          ((
            await tx.player.findUnique({
              where: { id: input.playerId },
              select: { homeGroupId: true }
            })
          )?.homeGroupId ?? null)

    await tx.financialTransaction.create({
      data: {
        amount: tax,
        type: TransactionType.TAX_PAYMENT,
        sourcePlayerId: input.playerId,
        reference: `مالیات بر درآمد — ${input.reference}`
      }
    })

    if (groupId) {
      await this.regionFund.credit(tx, groupId, tax)
    }

    return { gross, tax, net: gross - tax, groupId }
  }

  /**
   * مالیات بر سود توزیع‌شدهٔ کسب‌وکار (برداشت مالک از خزانه / درآمد شعبه).
   * پول از قبل از خزانه یا از درآمد کسر شده است؛ اینجا فقط ثبت و انتقال به
   * صندوق منطقه انجام می‌شود.
   */
  async takeProfitTax(
    tx: EconomyDb,
    input: {
      amount: number
      reference: string
      groupId: string | null
      /** پرداخت‌کنندهٔ مالیات: مالک کسب‌وکار. */
      playerId: string
      /** خزانهٔ کسب‌وکاری که مالیات از آن بیرون آمده (برداشت سود). */
      sourceBusinessId?: string
      /** درآمد شعبه از خزانه کم نشده؛ پس پول مالیات هم باید واقعاً کسر شود. */
      fromPlayerBalance?: boolean
    }
  ): Promise<number> {
    const tax = businessProfitTaxOf(input.amount)
    if (tax <= 0) {
      return 0
    }

    if (input.fromPlayerBalance) {
      const debited = await tx.player.updateMany({
        where: { id: input.playerId, balance: { gte: tax } },
        data: { balance: { decrement: tax } }
      })
      if (debited.count !== 1) {
        // موجودی کافی نیست: مالیات کسر نمی‌شود (نه منفی، نه از هیچ)
        return 0
      }
    }

    await tx.financialTransaction.create({
      data: {
        amount: tax,
        type: TransactionType.TAX_PAYMENT,
        sourcePlayerId: input.playerId,
        sourceBusinessId: input.sourceBusinessId,
        reference: `مالیات بر سود کسب‌وکار — ${input.reference}`
      }
    })

    if (input.groupId) {
      await this.regionFund.credit(tx, input.groupId, tax)
    }

    return tax
  }
}
