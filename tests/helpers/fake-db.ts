/**
 * یک دیتابیس درون‌حافظه‌ای برای آزمونِ سیستمِ میراث.
 *
 * چرا دست‌ساز و نه mock با `jest.fn`؟ چون در میراث، **وضعیت نهایی** مهم است،
 * نه تعداد صدا‌زدن‌ها: باید بتوان اثبات کرد پول نه گم می‌شود و نه دوبار
 * منتقل، ملک دقیقاً یک مالک دارد، و اگر مرحله‌ای شکست بخورد هیچ نوشتاری
 * نیمه‌کاره نمی‌ماند. برای همین این fake:
 *
 *   • ردیف‌ها را واقعاً نگه می‌دارد و `where` را (برابری، `gte`، `gt`، `not`،
 *     `in`، `equals`، `OR` و کلیدهای مرکب) می‌فهمد،
 *   • عملگرهای `increment`/`decrement` را واقعاً روی مقدار اعمال می‌کند،
 *   • و `$transaction` را با **snapshot و بازگردانی** شبیه‌سازی می‌کند: اگر
 *     بدنهٔ تراکنش پرتاب کند، همهٔ ردیف‌ها به حالت قبل برمی‌گردند — همان
 *     تضمینی که Postgres می‌دهد و بدون آن، آزمونِ «خطا پول را نیمه‌کاره
 *     نمی‌گذارد» بی‌معنا می‌شد.
 *
 * این fake فقط مدل‌ها و متدهایی را پوشش می‌دهد که سرویس‌های میراث/وصیت صدا
 * می‌زنند؛ عمداً کوچک نگه داشته شده تا خواندنش آسان باشد.
 */

type Row = Record<string, unknown>

/** کلیدهای مرکبِ Prisma → نام فیلدهای واقعی. */
const COMPOUND_KEYS: Record<string, string[]> = {
  playerId_symbol: ['playerId', 'symbol'],
  playerId_itemId: ['playerId', 'itemId'],
  // کلید مرکبِ پروژهٔ شهری: «هر منطقه فقط یک پروژه از هر نوع».
  groupId_key: ['groupId', 'key']
}

function num(value: unknown): number {
  return Number(value ?? 0)
}

function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true
  return Object.entries(where).every(([key, condition]) => {
    if (key === 'OR') {
      return (condition as Row[]).some((clause) => matches(row, clause))
    }
    if (COMPOUND_KEYS[key] && condition && typeof condition === 'object') {
      return matches(row, condition as Row)
    }
    const value = row[key]
    if (condition !== null && typeof condition === 'object' && !Array.isArray(condition)) {
      const c = condition as Row
      if ('gte' in c) return num(value) >= num(c.gte)
      if ('lte' in c) return num(value) <= num(c.lte)
      if ('gt' in c) return num(value) > num(c.gt)
      if ('lt' in c) return num(value) < num(c.lt)
      if ('not' in c) return value !== c.not
      if ('in' in c) return (c.in as unknown[]).includes(value)
      if ('equals' in c) {
        return c.mode === 'insensitive'
          ? String(value ?? '').toLowerCase() === String(c.equals).toLowerCase()
          : value === c.equals
      }
    }
    return value === condition
  })
}

/** اعمالِ دادهٔ Prisma روی یک ردیف، با پشتیبانی از increment/decrement. */
function applyData(row: Row, data: Row): void {
  for (const [key, value] of Object.entries(data ?? {})) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      if ('increment' in value) {
        row[key] = num(row[key]) + num((value as Row).increment)
        continue
      }
      if ('decrement' in value) {
        row[key] = num(row[key]) - num((value as Row).decrement)
        continue
      }
    }
    row[key] = value
  }
}

/**
 * رابطه‌های موردنیاز سرویس‌های میراث — همان‌هایی که با `include` خوانده
 * می‌شوند. بدون این نگاشت، `will.heir` تهی می‌ماند و اعتبارسنجی وارث بی‌دلیل
 * شکست می‌خورد.
 */
const RELATIONS: Record<string, Record<string, { table: string; from: string }>> = {
  will: {
    owner: { table: 'player', from: 'ownerId' },
    heir: { table: 'player', from: 'heirId' }
  },
  inheritanceCase: {
    deceased: { table: 'player', from: 'deceasedId' },
    heir: { table: 'player', from: 'heirId' }
  },
  // سوابقِ کمک: هر رکورد باید بتواند نامِ پروژه و اهداکننده را بردارد.
  projectDonation: {
    project: { table: 'regionProject', from: 'projectId' },
    donor: { table: 'player', from: 'donorId' }
  },
  // وثیقهٔ وام: چرخهٔ نکول باید بتواند ملک/شرکتِ گرو گذاشته‌شده را ببیند،
  // وگرنه تملک در آزمون هرگز اجرا نمی‌شود و «تست سبزِ بی‌معنا» می‌سازیم.
  loan: {
    collateralProperty: { table: 'property', from: 'collateralPropertyId' },
    collateralBusiness: { table: 'business', from: 'collateralBusinessId' }
  }
}

class FakeTable {
  constructor(
    public readonly rows: Row[],
    private readonly prefix: string,
    /** مقادیر پیش‌فرض ستون‌ها — همان `@default` اسکیما، تا ردیفِ تازه
     *  ساخته‌شده با ردیف واقعیِ Prisma یکسان رفتار کند. */
    private readonly defaults: Row = {},
    private readonly modelName?: string,
    private readonly findRow?: (table: string, id: string) => Row | null
  ) {}

  /**
   * پرکردنِ رابطه‌های `include` (بدون پشتیبانی از select تودرتو).
   *
   * روی یک **کپی** انجام می‌شود؛ چرا؟ چون Prisma برای هر خواندن شیء تازه
   * می‌سازد و نوشتنِ بعدی روی همان ردیف، نتیجهٔ خوانده‌شدهٔ قبلی را تغییر
   * نمی‌دهد. اگر این fake همان شیء زنده را پس می‌داد، منطقی مثل
   * «اگر هنوز تکمیل نشده بود…» در تست درست کار می‌کرد ولی در دیتابیس واقعی
   * رفتار دیگری داشت (یا برعکس) — و آزمون بی‌ارزش می‌شد.
   */
  private hydrate(row: Row | null, include?: Row | null): Row | null {
    if (!row) return row
    const copy: Row = { ...row }
    const relations = this.modelName ? RELATIONS[this.modelName] : undefined
    if (!relations) return copy
    for (const field of Object.keys(include ?? {})) {
      const target = relations[field]
      if (!target) continue
      copy[field] = this.findRow?.(target.table, String(copy[target.from] ?? '')) ?? null
    }
    return copy
  }

  async findUnique({
    where,
    include,
    select
  }: {
    where: Row
    include?: Row
    select?: Row
  }): Promise<Row | null> {
    return this.hydrate(this.rows.find((row) => matches(row, where)) ?? null, include ?? select)
  }

  async findFirst({
    where,
    include,
    select
  }: { where?: Row; include?: Row; select?: Row } = {}): Promise<Row | null> {
    return this.hydrate(this.rows.find((row) => matches(row, where)) ?? null, include ?? select)
  }

  async findUniqueOrThrow({
    where,
    include,
    select
  }: {
    where: Row
    include?: Row
    select?: Row
  }): Promise<Row> {
    const row = this.hydrate(
      this.rows.find((item) => matches(item, where)) ?? null,
      include ?? select
    )
    if (!row) throw new Error('row not found')
    return row
  }

  async findMany(
    {
      where,
      orderBy,
      take,
      include,
      select
    }: { where?: Row; orderBy?: Row; take?: number; include?: Row; select?: Row } = {}
  ): Promise<Row[]> {
    let result = this.rows.filter((row) => matches(row, where))
    const order = Object.entries(orderBy ?? {})
    if (order.length > 0) {
      const [field, direction] = order[0]!
      result = [...result].sort((a, b) =>
        direction === 'desc' ? num(b[field]) - num(a[field]) : num(a[field]) - num(b[field])
      )
    }
    const sliced = typeof take === 'number' ? result.slice(0, take) : result
    // `include`/`select` هم مثل `findUnique` پر می‌شود: بدون آن، فهرستی که
    // رابطهٔ نام‌دار می‌خواند (مثل نام متوفی در پروندهٔ میراث) در تست
    // `undefined` می‌گرفت ولی در تولید درست بود — یعنی تست رفتار دیگری
    // می‌سنجید. همان دلیلِ `hydrate`: Prisma برای هر خواندن شیء تازه می‌سازد.
    return sliced.map((row) => this.hydrate(row, include ?? select) ?? {})
  }

  async count({ where }: { where?: Row } = {}): Promise<number> {
    return this.rows.filter((row) => matches(row, where)).length
  }

  /** گروه‌بندی تک‌ستونی — همان کاری که `participantCounts` انجام می‌دهد. */
  async groupBy({
    by = [],
    where
  }: { by?: string[]; where?: Row; _count?: Row; _sum?: Row } = {}): Promise<Row[]> {
    const key = by[0]
    if (!key) {
      return []
    }
    const rest = by.slice(1)
    const seen = new Set<string>()
    const out: Row[] = []
    for (const row of this.rows) {
      if (!matches(row, where)) continue
      const signature = by.map((field) => String(row[field] ?? '')).join('\u0000')
      if (seen.has(signature)) continue
      seen.add(signature)
      out.push({ ...row, ...Object.fromEntries(rest.map((field) => [field, row[field]])) })
    }
    return out
  }

  /** جمعِ یک ستون (`_sum`) — برای «مجموع کمک‌های من». */
  async aggregate({
    where,
    _sum
  }: { where?: Row; _sum?: Row } = {}): Promise<Row> {
    const rows = this.rows.filter((row) => matches(row, where))
    const sums: Row = {}
    for (const field of Object.keys(_sum ?? {})) {
      sums[field] = rows.reduce((total, row) => total + num(row[field]), 0)
    }
    return { _sum: sums }
  }

  async create({ data }: { data: Row }): Promise<Row> {
    const now = new Date()
    const row: Row = {
      ...this.defaults,
      id: `${this.prefix}-${this.rows.length + 1}`,
      createdAt: now,
      ...data,
      // همان کاری که `@updatedAt` در Prisma می‌کند؛ بدون آن، کلیدِ
      // ضدتکرارِ وابسته به زمان `undefined` می‌شود.
      updatedAt: (data.updatedAt as Date | undefined) ?? now
    }
    this.rows.push(row)
    return { ...row }
  }

  async update({ where, data }: { where: Row; data: Row }): Promise<Row> {
    const row = this.rows.find((item) => matches(item, where))
    if (!row) throw new Error(`update: row not found (${this.prefix})`)
    applyData(row, data)
    row.updatedAt = new Date()
    return { ...row }
  }

  async updateMany({ where, data }: { where: Row; data: Row }): Promise<{ count: number }> {
    const hits = this.rows.filter((row) => matches(row, where))
    for (const row of hits) {
      applyData(row, data)
      row.updatedAt = new Date()
    }
    return { count: hits.length }
  }

  async upsert({ where, create, update }: { where: Row; create: Row; update: Row }): Promise<Row> {
    const row = this.rows.find((item) => matches(item, where))
    if (row) {
      applyData(row, update)
      return { ...row }
    }
    return this.create({ data: create })
  }

  async delete({ where }: { where: Row }): Promise<Row> {
    const index = this.rows.findIndex((row) => matches(row, where))
    if (index < 0) throw new Error(`delete: row not found (${this.prefix})`)
    const [removed] = this.rows.splice(index, 1)
    return removed!
  }

  async deleteMany({ where }: { where: Row }): Promise<{ count: number }> {
    const kept = this.rows.filter((row) => !matches(row, where))
    const removed = this.rows.length - kept.length
    this.rows.length = 0
    this.rows.push(...kept)
    return { count: removed }
  }
}

export interface FakeSeed {
  players?: Row[]
  wills?: Row[]
  cases?: Row[]
  accounts?: Row[]
  loans?: Row[]
  playerLoans?: Row[]
  properties?: Row[]
  businesses?: Row[]
  deposits?: Row[]
  inventory?: Row[]
  pets?: Row[]
  sessions?: Row[]
  regionStats?: Row[]
  skills?: Row[]
  gymMemberships?: Row[]
  insurancePolicies?: Row[]
  projects?: Row[]
  projectDonations?: Row[]
}

/**
 * ساخت دیتابیسِ جعلی. ردیف‌ها با همان نامِ ستون‌های شمارشی (camelCase) نوشته
 * می‌شوند تا `where`های سرویس عیناً کار کنند.
 */
export function createFakeDb(seed: FakeSeed = {}) {
  const state = {
    players: seed.players ?? [],
    wills: seed.wills ?? [],
    cases: seed.cases ?? [],
    accounts: seed.accounts ?? [],
    loans: seed.loans ?? [],
    playerLoans: seed.playerLoans ?? [],
    properties: seed.properties ?? [],
    businesses: seed.businesses ?? [],
    deposits: seed.deposits ?? [],
    inventory: seed.inventory ?? [],
    pets: seed.pets ?? [],
    sessions: seed.sessions ?? [],
    regionStats: seed.regionStats ?? [],
    projects: seed.projects ?? [],
    projectDonations: seed.projectDonations ?? [],
    skills: seed.skills ?? [],
    gymMemberships: seed.gymMemberships ?? [],
    insurancePolicies: seed.insurancePolicies ?? [],
    dailyQuests: [] as Row[],
    dailyFortunes: [] as Row[],
    transactions: [] as Row[],
    // شناسهٔ `main` عیناً همان `BANK_POOL_ID` در `config/economy.ts` است؛ بدون
    // تطابق آن، `BankPoolService` ردیف صندوق را پیدا نمی‌کند و هر آزمونِ وابسته
    // به صندوق بی‌دلیل می‌شکند.
    pool: [{ id: 'main', balance: 0, totalRepaid: 0, totalLoanInterest: 0 }]
  }

  // ردیف‌های اولیه (seed) مثلِ یک دیتابیسِ واقعی باید پیش‌فرض‌های اسکیما را
  // داشته باشند؛ وگرنه منطقی که روی `lives` یا `healthSyncedAt` حساب می‌کند
  // در تست با `undefined` کار می‌کند و رفتارِ متفاوتی از تولید می‌گیرد.
  for (const player of state.players) {
    if (player.lives === undefined) player.lives = 1
    if (player.healthSyncedAt === undefined) player.healthSyncedAt = new Date()
  }
  for (const row of state.cases) {
    if (row.lifeIndex === undefined) row.lifeIndex = 1
  }

  /** جست‌وجوی یک ردیف در هر جدولی — پایهٔ پرکردنِ `include`. */
  const findRowById = (table: string, id: string): Row | null => {
    switch (table) {
      case 'player':
        return state.players.find((row) => row.id === id) ?? null
      case 'property':
        return state.properties.find((row) => row.id === id) ?? null
      case 'business':
        return state.businesses.find((row) => row.id === id) ?? null
      default:
        return null
    }
  }
  const findPlayerById = (table: string, id: string): Row | null => findRowById(table, id)

  // `will`/`inheritanceCase` از همان نگاشتِ عمومی استفاده می‌کنند؛ نامِ قدیمی
  // برای خوانایی مسیرِ میراث نگه داشته شده است.

  const tables = {
    player: new FakeTable(
      state.players,
      'player',
      // `lives` و `healthSyncedAt` پیش‌فرض‌های واقعیِ اسکیما هستند؛ بدونشان
      // منطقِ «چندمین زندگی» در تست‌ها به مقدارِ نامعلوم می‌خورد.
      { status: 'ACTIVE', balance: 0, health: 100, lives: 1, healthSyncedAt: new Date() },
      'player',
      findPlayerById
    ),
    will: new FakeTable(state.wills, 'will', {}, 'will', findPlayerById),
    inheritanceCase: new FakeTable(state.cases, 'case', {
      status: 'PENDING',
      cashTransferred: 0,
      debtSettled: 0,
      debtUnpaid: 0,
      propertiesCount: 0,
      businessesCount: 0,
      holdingsCount: 0,
      attempts: 0,
      lastError: null,
      heirId: null,
      completedAt: null,
      lifeIndex: 1
    }, 'inheritanceCase', findPlayerById),
    bankAccount: new FakeTable(state.accounts, 'account', { balance: 0 }),
    // `modelName` لازم است تا `include: { collateralProperty, collateralBusiness }`
    // پر شود؛ بدون آن، چرخهٔ نکول هرگز وثیقه را نمی‌بیند.
    loan: new FakeTable(state.loans, 'loan', { status: 'ACTIVE' }, 'loan', findRowById),
    playerLoan: new FakeTable(state.playerLoans, 'ploan', { status: 'ACTIVE' }),
    property: new FakeTable(state.properties, 'property'),
    business: new FakeTable(state.businesses, 'business'),
    termDeposit: new FakeTable(state.deposits, 'deposit', { status: 'ACTIVE' }),
    playerInventory: new FakeTable(state.inventory, 'inventory', { quantity: 0 }),
    pet: new FakeTable(state.pets, 'pet'),
    workSession: new FakeTable(state.sessions, 'session', { status: 'ACTIVE' }),
    financialTransaction: new FakeTable(state.transactions, 'tx'),
    bankPool: new FakeTable(state.pool, 'pool', {
      balance: 0,
      totalRepaid: 0,
      totalLoanInterest: 0
    }),
    // صندوق منطقه: مقصدِ داراییِ بی‌وارث و مالیات. بدون آن، مسیر «زندگی
    // تازه» هرگز نمی‌توانست دارایی بی‌وارث را با یک ردیف دفتری تسویه کند.
    regionStat: new FakeTable(state.regionStats, 'regionStat', { taxRevenue: 0 }),
    // پروژهٔ شهری: `include: { project: ... }` روی رکوردِ کمک لازم است تا
    // نامِ پروژه در سوابقِ بازیکن پر شود.
    regionProject: new FakeTable(
      state.projects,
      'project',
      { collectedAmount: 0, isCompleted: false, announcedAt: null, startedAt: null, completedAt: null },
      'regionProject'
    ),
    projectDonation: new FakeTable(state.projectDonations, 'donation', { amount: 0, gameDay: 0 }, 'projectDonation'),
    // جداولِ چسبیده به شخصیت که در زندگی تازه پاک می‌شوند.
    playerSkill: new FakeTable(state.skills, 'skill'),
    gymMembership: new FakeTable(state.gymMemberships, 'gym'),
    insurancePolicy: new FakeTable(state.insurancePolicies, 'policy'),
    dailyQuest: new FakeTable(state.dailyQuests, 'dquest'),
    dailyFortune: new FakeTable(state.dailyFortunes, 'fortune')
  }

  /** نگاشتِ هر جدول به کلیدِ آرایه‌اش در `state` — پایهٔ بازگردانی تراکنش. */
  const registry = [
    ['players', tables.player],
    ['wills', tables.will],
    ['cases', tables.inheritanceCase],
    ['accounts', tables.bankAccount],
    ['loans', tables.loan],
    ['playerLoans', tables.playerLoan],
    ['properties', tables.property],
    ['businesses', tables.business],
    ['deposits', tables.termDeposit],
    ['inventory', tables.playerInventory],
    ['pets', tables.pet],
    ['sessions', tables.workSession],
    ['transactions', tables.financialTransaction],
    ['pool', tables.bankPool],
    ['regionStats', tables.regionStat],
    ['projects', tables.regionProject],
    ['projectDonations', tables.projectDonation],
    ['skills', tables.playerSkill],
    ['gymMemberships', tables.gymMembership],
    ['insurancePolicies', tables.insurancePolicy],
    ['dailyQuests', tables.dailyQuest],
    ['dailyFortunes', tables.dailyFortune]
  ] as const

  const db = {
    ...tables,
    /**
     * تراکنش با بازگردانی واقعی: اگر بدنه پرتاب کند، حالت پیش از تراکنش
     * بازگردانده می‌شود. این همان چیزی است که آزمونِ اتمیک‌بودن را معنا می‌دهد.
     */
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      const backup = registry.map(([key, table]) => [key, table.rows.map((row) => ({ ...row }))] as const)
      try {
        return await fn(db)
      } catch (error) {
        for (const [key, rows] of backup) {
          const table = registry.find(([name]) => name === key)![1]
          table.rows.length = 0
          table.rows.push(...rows)
          ;(state as unknown as Record<string, Row[]>)[key] = table.rows
        }
        throw error
      }
    }
  }

  return {
    db: db as unknown as import('@prisma/client').PrismaClient,
    state,
    /** شبیه‌ساز صندوق بانک؛ فقط همان متدی که میراث صدا می‌زند. */
    poolStub: {
      creditRepayment: jest.fn(async (tx: { bankPool: { rows: Row[] } }, principal: number, interest: number) => {
        const row = tx.bankPool.rows[0] ?? state.pool[0]!
        row.balance = num(row.balance) + principal + interest
        row.totalRepaid = num(row.totalRepaid) + principal
        row.totalLoanInterest = num(row.totalLoanInterest) + interest
      })
    }
  }
}
