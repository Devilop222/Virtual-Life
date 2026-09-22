/**
 * ممیزی عرضهٔ پول و آشتی‌دادن دفتر کل با موجودی‌ها.
 *
 * چرا این فایل وجود دارد؟
 * در کل پروژه هیچ‌جا نمی‌شد پرسید «الان چند تومان در بازی وجود دارد و این عدد
 * با دفتر کل می‌خواند؟». بدون این پرسش، خطاهایی مثل «پاداش بدون ثبت تراکنش»
 * یا «کسر پول بدون ثبت» فقط با چشم‌زدن به کد پیدا می‌شدند.
 *
 * این ماژول هیچ نوشتنی ندارد و کاملاً خالص است: ورودی‌اش ردیف‌های دفتر کل و
 * موجودی‌هاست، خروجی‌اش اختلاف‌ها. برای تست، ابزار داخلی و ممیزی آینده.
 *
 * مدل پول بازی (صریح و قابل‌ممیزی):
 *   • بخش خصوصی: کیف بازیکن، خزانهٔ کسب‌وکار، حساب/سپردهٔ بانکی
 *   • بخش عمومی: صندوق مناطق (`RegionStat.taxRevenue`) و ترازنامهٔ بانک
 *     (`bank_pool`) که با `bankPoolBalance` سنجیده می‌شود
 *
 * جهتِ هر ردیف از «طرف‌هایش» فهمیده می‌شود، نه از نوعش:
 *   • `MINT`     — تنها مقصد دارد: پول از بخش عمومی به یک حساب خصوصی آمده
 *                  (دستمزد، درآمد کسب‌وکار، پاداش، سود سپرده…)
 *   • `BURN`     — تنها مبدأ دارد: پول از حساب خصوصی به بخش عمومی رفته
 *                  (مالیات، خرید فروشگاه، اقساط، هزینه‌ها…)
 *   • `TRANSFER` — هر دو طرف: جابه‌جایی داخلی (بازار، اجاره، قرض بازیکنی…)
 *   • `SHARED`   — هیچ طرفی ندارد؛ همیشه یک بوی حسابداری است
 */

export type MoneyFlow = 'MINT' | 'BURN' | 'TRANSFER' | 'SHARED'

export interface LedgerRow {
  amount: unknown // Prisma.Decimal | number | string
  /** نوع تراکنش؛ در جهت‌گیری نقشی ندارد و فقط برای گزارش/برچسب است. */
  type?: string | null
  sourcePlayerId?: string | null
  destinationPlayerId?: string | null
  sourceBusinessId?: string | null
  destinationBusinessId?: string | null
}

export interface MoneySupplyInput {
  playerBalances: number[]
  businessTreasuries?: number[]
  bankBalances?: number[]
  /**
   * اصل سپرده‌های مدت‌دار.
   *
   * توجه: این پول *داخلِ* `bankPool` هم نشسته است (افتتاح سپرده به صندوق واریز
   * می‌کند)، پس `total` جمعِ ادعاها و صندوق‌هاست و برای پرسشِ «چقدر پول وجود
   * دارد» باید از `moneyInExistence` استفاده شود تا این هم‌پوشانی یک‌بار شمرده
   * شود.
   */
  lockedDeposits?: number[]
  /** صندوق‌های عمومی مناطق (مالیات جمع‌شده). */
  regionFunds?: number[]
  /** ترازنامهٔ بانک؛ منبع واقعی وام‌ها و سود سپرده‌ها. */
  bankPool?: number
}

export interface MoneySupply {
  wallets: number
  businesses: number
  banks: number
  lockedDeposits: number
  regionFunds: number
  bankPool: number
  total: number
}

/**
 * چقدر پول واقعاً در بازی وجود دارد.
 *
 * `moneySupply.total` جمعِ «ادعای بازیکنان» و «صندوق‌های عمومی» است و یک
 * هم‌پوشانی دارد: اصلِ سپرده‌های مدت‌دار هم ادعای بازیکن است و هم داخلِ
 * ترازنامهٔ بانک نشسته. اینجا آن هم‌پوشانی یک‌بار شمرده می‌شود؛ بقیهٔ اجزا
 * (کیف پول، حساب بانکی، خزانهٔ کسب‌وکار، صندوق مناطق) واقعاً جدا از هم‌اند.
 */
export function moneyInExistence(supply: MoneySupply): number {
  const backing = Math.min(toAmount(supply.bankPool), toAmount(supply.lockedDeposits))
  return toAmount(supply.total) - backing
}

export interface PublicSectorFlow {
  /** کل پولی که به بخش عمومی برگشته (مالیات، هزینه‌ها، اقساط…). */
  income: number
  /** کل پولی که بخش عمومی به بازیکنان/کسب‌وکارها داده (دستمزد، پاداش، وام، سود). */
  spending: number
  /** تراز: مثبت = انقباض، منفی = تورم. */
  net: number
  mintCount: number
  burnCount: number
}

export interface PlayerReconciliation {
  playerId: string
  /** جمع دفتر کل برای این بازیکن (ورودی‌ها منهای خروجی‌ها). */
  ledgerNet: number
  /** موجودی واقعی کیف پول. */
  balance: number
  difference: number
  ok: boolean
}

export interface LedgerAnomaly {
  kind: 'SHARED_ENTRY' | 'LEDGER_DRIFT'
  detail: string
  amount: number
}

/**
 * ردیف‌هایی که پول را *داخلِ* بخش خصوصی جابه‌جا می‌کنند: کیف پول ↔ حسابِ بانکیِ
 * خودِ بازیکن.
 *
 * چرا یک‌طرفه ثبت می‌شوند؟ صورت‌حسابِ بازیکن (`ledger.service`) جهتِ هر ردیف را از
 * طرفش می‌فهمد (`destinationPlayerId === playerId ? 'in' : 'out'`)، پس «واریز به
 * حسابِ خودم» باید فقط مبدأ داشته باشد تا در ستونِ «خروجیِ» کیف پول بنشیند.
 * اثرِ ناخواستهٔ این ثبتِ یک‌طرفه آن است که این دو ردیف در دفتر کل مثلِ جریانِ
 * عمومی به نظر می‌رسند: واریزِ بانکی مثلِ درآمدِ عمومی و برداشت مثلِ هزینهٔ
 * عمومی — در حالی که هیچ پولی بین بخش‌ها جابه‌جا نشده. پس در آشتیِ داراییِ خصوصی
 * و در ترازِ بخشِ عمومی باید نادیده گرفته شوند.
 */
export const INTERNAL_PRIVATE_TYPES: readonly string[] = ['BANK_DEPOSIT', 'BANK_WITHDRAWAL']

/*
 * مرزِ این فهرست: افتتاحِ سپردهٔ مدت‌دار (`DEPOSIT`) داخلی *نیست* — آن پول از
 * کیفِ بازیکن به ترازنامهٔ بانک می‌رود و منبعِ وام‌ها و سودها می‌شود. پیش‌تر هر دو
 * با نوعِ `BANK_DEPOSIT` ثبت می‌شدند و هیچ ممیزیِ مالی نمی‌توانست این دو را از هم
 * جدا کند.
 */

/** آیا این ردیف فقط پولِ بازیکن را بین کیف پول و حسابِ بانکیِ خودش جابه‌جا کرده؟ */
export function isInternalPrivateMove(row: LedgerRow): boolean {
  if (!row.type || !INTERNAL_PRIVATE_TYPES.includes(row.type)) {
    return false
  }
  return Boolean(row.sourcePlayerId || row.destinationPlayerId)
}

/** عددِ ایمن از هر ورودی عددی (Decimal، رشته یا عدد). */
export function toAmount(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? Math.round(parsed) : 0
}

/** طبقه‌بندی جهتِ پول فقط از روی طرف‌های تراکنش (بدون وابستگی به نوع). */
export function flowOf(row: LedgerRow): MoneyFlow {
  const hasSource = Boolean(row.sourcePlayerId || row.sourceBusinessId)
  const hasDestination = Boolean(row.destinationPlayerId || row.destinationBusinessId)
  if (hasSource && hasDestination) return 'TRANSFER'
  if (hasDestination) return 'MINT'
  if (hasSource) return 'BURN'
  return 'SHARED'
}

/** خالصِ یک ردیف برای یک بازیکن مشخص (ورودی مثبت، خروجی منفی). */
export function netForPlayer(row: LedgerRow, playerId: string): number {
  const amount = toAmount(row.amount)
  let net = 0
  if (row.destinationPlayerId === playerId) net += amount
  if (row.sourcePlayerId === playerId) net -= amount
  return net
}

/**
 * آشتی‌دادن دفتر کل با موجودیِ یک بازیکن.
 * هر تغییر موجودی باید در دفتر کل هم دیده شود؛ اختلاف یعنی یک مسیر مالی
 * بدون ثبت (یا ثبت بدون تغییر).
 */
export function reconcilePlayer(
  playerId: string,
  balance: number,
  rows: readonly LedgerRow[]
): PlayerReconciliation {
  const ledgerNet = rows.reduce((sum, row) => sum + netForPlayer(row, playerId), 0)
  const safeBalance = toAmount(balance)
  return {
    playerId,
    ledgerNet,
    balance: safeBalance,
    difference: safeBalance - ledgerNet,
    ok: safeBalance - ledgerNet === 0
  }
}

/** داراییِ خصوصیِ یک بازیکن: کیف پول + حساب‌های بانکیِ او. */
export interface PrivateHoldings {
  wallet: number
  bankAccounts?: number[]
}

/**
 * آشتیِ *کلِ داراییِ خصوصی* یک بازیکن با دفتر کل.
 *
 * تفاوتش با `reconcilePlayer` در دو چیز است: موجودیِ حساب بانکی هم بخشی از پولِ
 * بازیکن است، و ردیف‌های واریز/برداشتِ بانکی (که فقط پول را بین دو حسابِ خودِ
 * بازیکن جابه‌جا می‌کنند) شمرده نمی‌شوند. بدون این دو، هر بازیکنی که یک بار از
 * بانک استفاده کرده باشد «اختلاف» می‌خورد — پولی که واقعاً از بخش خصوصی بیرون
 * نرفته است.
 *
 * در خروجی، `balance` یعنی «هر چه این بازیکن در بخش خصوصی دارد».
 */
export function reconcilePrivateSector(
  playerId: string,
  holdings: PrivateHoldings,
  rows: readonly LedgerRow[]
): PlayerReconciliation {
  const held =
    toAmount(holdings.wallet) +
    (holdings.bankAccounts ?? []).reduce((sum, value) => sum + toAmount(value), 0)
  const ledgerNet = rows
    .filter((row) => !isInternalPrivateMove(row))
    .reduce((sum, row) => sum + netForPlayer(row, playerId), 0)
  return {
    playerId,
    ledgerNet,
    balance: held,
    difference: held - ledgerNet,
    ok: held - ledgerNet === 0
  }
}

/** جمع کل پولی که در بازی وجود دارد، به تفکیک جایی که نشسته است. */
export function moneySupply(input: MoneySupplyInput): MoneySupply {
  const sum = (values: number[] | undefined): number =>
    (values ?? []).reduce((acc, value) => acc + toAmount(value), 0)

  const wallets = sum(input.playerBalances)
  const businesses = sum(input.businessTreasuries)
  const banks = sum(input.bankBalances)
  const lockedDeposits = sum(input.lockedDeposits)
  const regionFunds = sum(input.regionFunds)
  const bankPool = toAmount(input.bankPool ?? 0)

  return {
    wallets,
    businesses,
    banks,
    lockedDeposits,
    regionFunds,
    bankPool,
    total: wallets + businesses + banks + lockedDeposits + regionFunds + bankPool
  }
}

/**
 * جریان پول بین بخش عمومی و خصوصی.
 *
 * «درآمد عمومی» = پولی که از بازیکن‌ها و کسب‌وکارها بیرون رفته (مالیات،
 * خرید فروشگاه، اقساط، هزینه‌ها) و «هزینهٔ عمومی» = پولی که به آن‌ها داده شده
 * (دستمزد، درآمد، پاداش، وام، سود). اختلاف این دو، تغییر خالصِ عرضهٔ پول است.
 */
export function publicSectorFlow(rows: readonly LedgerRow[]): PublicSectorFlow {
  let income = 0
  let spending = 0
  let mintCount = 0
  let burnCount = 0

  for (const row of rows) {
    // واریز/برداشتِ بانکیِ خودِ بازیکن جریانِ عمومی نیست؛ پولی بین بخش‌ها نرفته
    if (isInternalPrivateMove(row)) {
      continue
    }
    const flow = flowOf(row)
    const amount = toAmount(row.amount)
    if (flow === 'BURN') {
      income += amount
      burnCount += 1
    } else if (flow === 'MINT') {
      spending += amount
      mintCount += 1
    }
  }

  return { income, spending, net: income - spending, mintCount, burnCount }
}

export interface BankPoolSnapshot {
  balance: number
  totalDeposited: number
  totalDisbursed: number
  totalRepaid: number
  totalLoanInterest: number
  totalDepositInterest: number
}

/**
 * سنجش ترازنامهٔ بانک.
 *
 * ترازنامهٔ بانک یک حساب بسته است: موجودی باید دقیقاً برابر باشد با
 * سرمایهٔ اولیهٔ یک‌باره + سپرده‌های دریافتی + بازپرداخت‌ها و سود وام‌ها
 * منهای وام‌های پرداخت‌شده و سودهای پرداختی. اختلاف یعنی جایی از صندوق
 * بدون ثبت کم یا زیاد شده است.
 */
export function auditBankPool(
  snapshot: BankPoolSnapshot,
  seed: number
): { expected: number; actual: number; difference: number; ok: boolean } {
  const expected =
    toAmount(seed) +
    toAmount(snapshot.totalDeposited) +
    toAmount(snapshot.totalRepaid) +
    toAmount(snapshot.totalLoanInterest) -
    toAmount(snapshot.totalDisbursed) -
    toAmount(snapshot.totalDepositInterest)
  const actual = toAmount(snapshot.balance)
  return { expected, actual, difference: actual - expected, ok: actual === expected }
}

/**
 * یافتن ردیف‌هایی که هیچ طرفی ندارند.
 * این ردیف‌ها «پولِ بی‌صاحب»‌اند: نه از کسی کم شده و نه به کسی رسیده؛
 * هر ردیف از این جنس یعنی یک نوشتنِ مالی ناقص.
 */
export function findSharedEntries(rows: readonly LedgerRow[]): LedgerAnomaly[] {
  return rows
    .filter((row) => flowOf(row) === 'SHARED')
    .map((row) => ({
      kind: 'SHARED_ENTRY' as const,
      detail: 'تراکنش بدون طرف مبدأ و مقصد',
      amount: toAmount(row.amount)
    }))
}

/** فهرست کامل ناهنجاری‌های دفتر کل در یک نگاه. */
export function auditLedger(
  players: ReadonlyArray<{ id: string; balance: number; bankBalances?: number[] }>,
  rows: readonly LedgerRow[]
): { reconciliations: PlayerReconciliation[]; anomalies: LedgerAnomaly[]; drifted: number } {
  const reconciliations = players.map((player) =>
    reconcilePrivateSector(
      player.id,
      { wallet: player.balance, bankAccounts: player.bankBalances },
      rows
    )
  )
  const anomalies: LedgerAnomaly[] = findSharedEntries(rows)

  for (const item of reconciliations) {
    if (!item.ok) {
      anomalies.push({
        kind: 'LEDGER_DRIFT',
        detail: `اختلاف دفتر کل با داراییِ خصوصیِ بازیکن ${item.playerId}`,
        amount: item.difference
      })
    }
  }

  return {
    reconciliations,
    anomalies,
    drifted: reconciliations.filter((item) => !item.ok).length
  }
}
