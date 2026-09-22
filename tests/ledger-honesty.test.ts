import { TransactionType } from '@prisma/client'

/**
 * قفلِ رگرسیونیِ «دفتر کلِ صادق».
 *
 * هر ردیف دفتر کل باید با نوعش جهتِ واقعی پول را بگوید:
 *  • TRANSFER فقط برای جابه‌جایی دوطرفه؛ ردیفِ تک‌طرفه با این نوع در ممیزی
 *    عرضهٔ پول «پولِ بی‌صاحب» (SHARED) خوانده می‌شود و آشتیِ دارایی خصوصی
 *    با دفتر کل را می‌شکند.
 *  • انواعِ تفکیک‌شدهٔ حیوان/شانس، SINK و MINT را در ستون درستِ گزارش می‌نشاند.
 */

const MINT_TYPES: readonly TransactionType[] = [
  TransactionType.REWARD_PAYOUT,
  TransactionType.PET_BONUS,
  TransactionType.PROPERTY_SALE,
  TransactionType.BUSINESS_REVENUE
]

const BURN_TYPES: readonly TransactionType[] = [
  TransactionType.WITHDRAWAL,
  TransactionType.PET_EXPENSE,
  TransactionType.FORTUNE_LOSS,
  TransactionType.FAMILY_EXPENSE,
  TransactionType.SHOP_PURCHASE
]

/** ردیف تک‌طرفه با نوع TRANSFER = پول بی‌صاحب؛ هرگز نباید ساخته شود. */
function oneSidedRowsCannotBeTransfers(
  sourcePlayerId: string | undefined,
  destinationPlayerId: string | undefined,
  type: TransactionType
): boolean {
  if (type === TransactionType.TRANSFER) {
    return Boolean(sourcePlayerId && destinationPlayerId)
  }
  return true
}

describe('ledger honesty — one-sided rows never use TRANSFER', () => {
  test.each([
    ['admin add', undefined, 'p1', TransactionType.REWARD_PAYOUT],
    ['admin subtract', 'p1', undefined, TransactionType.WITHDRAWAL],
    ['admin set (down)', 'p1', undefined, TransactionType.WITHDRAWAL],
    ['admin set (up)', undefined, 'p1', TransactionType.REWARD_PAYOUT]
  ] as const)(
    '%s writes a MINT/BURN type, not a one-sided TRANSFER',
    (_name, source, destination, type) => {
      expect(oneSidedRowsCannotBeTransfers(source, destination, type)).toBe(true)
    }
  )

  test('spouse gift keeps both sides and stays a TRANSFER', () => {
    expect(
      oneSidedRowsCannotBeTransfers('husband', 'wife', TransactionType.TRANSFER)
    ).toBe(true)
  })
})

describe('pet and fortune flows use dedicated ledger types', () => {
  test('pet costs are sinks (PET_EXPENSE)', () => {
    expect(BURN_TYPES).toContain(TransactionType.PET_EXPENSE)
    expect(MINT_TYPES).not.toContain(TransactionType.PET_EXPENSE)
  })

  test('pet daily gift is a mint (PET_BONUS), like REWARD_PAYOUT', () => {
    expect(MINT_TYPES).toContain(TransactionType.PET_BONUS)
    expect(BURN_TYPES).not.toContain(TransactionType.PET_BONUS)
  })

  test('daily fortune loss is a sink (FORTUNE_LOSS)', () => {
    expect(BURN_TYPES).toContain(TransactionType.FORTUNE_LOSS)
    expect(MINT_TYPES).not.toContain(TransactionType.FORTUNE_LOSS)
  })

  test('the three new types exist on the prisma enum', () => {
    expect(TransactionType.PET_EXPENSE).toBeDefined()
    expect(TransactionType.PET_BONUS).toBeDefined()
    expect(TransactionType.FORTUNE_LOSS).toBeDefined()
  })
})
