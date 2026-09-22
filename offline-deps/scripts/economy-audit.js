#!/usr/bin/env node
/**
 * ممیزی اقتصاد (Offline economy audit) — فقط خواندنی
 * ------------------------------------------------
 * همان پرسش‌هایی را پاسخ می‌دهد که تا امروز هیچ ابزاری برایشان نبود:
 *   • الان چند تومان در بازی وجود دارد و کجا نشسته است؟ (بدونِ دوبار شمردنِ
 *     سپردهٔ مدت‌دار که هم ادعای بازیکن است و هم داخلِ ترازنامهٔ بانک نشسته)
 *   • دفتر کل هر بازیکن با *داراییِ خصوصی‌اش* می‌خواند؟ یعنی کیف پول + حسابِ
 *     بانکی، بدونِ شمردنِ جابه‌جاییِ بین این دو (پاداش/کسر بدون ثبت)
 *   • ترازنامهٔ بانک بسته است؟ (وام و سود سپرده از هیچ ساخته نشده باشد)
 *
 * هیچ نوشتنی انجام نمی‌دهد، هیچ وابستگی‌ای جز `pg` و خروجی کامپایل‌شدهٔ
 * `dist/modules/economy/money-supply.js` لازم ندارد و روی سرور آفلاین هم
 * اجرا می‌شود.
 *
 * استفاده:  node offline-deps/scripts/economy-audit.js [مسیر-ریشه-پروژه]
 * کد خروج: ۰ = سالم، ۱ = اختلاف پیدا شد (برای Cron/پایش)
 */
'use strict'

const fs = require('fs')
const path = require('path')
const { Client } = require('pg')

function loadEnvFromDotEnv(repoRoot) {
  if (process.env.DATABASE_URL) return
  const envFile = path.join(repoRoot, '.env')
  if (!fs.existsSync(envFile)) return
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
    if (m && m[1] === 'DATABASE_URL') {
      process.env.DATABASE_URL = m[2].replace(/^["']|["']$/g, '')
      return
    }
  }
}

const repoRoot = path.resolve(process.argv[2] || path.join(__dirname, '..', '..'))
loadEnvFromDotEnv(repoRoot)

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL پیدا نشد (نه در محیط و نه در .env)')
  process.exit(1)
}

const supplyModule = path.join(repoRoot, 'dist', 'modules', 'economy', 'money-supply.js')
if (!fs.existsSync(supplyModule)) {
  console.error(`ماژول ممیزی پیدا نشد: ${supplyModule} — اول بیلد بگیر (dist).`)
  process.exit(1)
}
const { moneySupply, moneyInExistence, reconcilePrivateSector, auditBankPool } =
  require(supplyModule)

const BANK_POOL_ID = 'main'
const BANK_POOL_SEED = 500_000_000

const num = (value) => (value === null || value === undefined ? 0 : Number(value))

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()
  try {
    const players = (
      await client.query('SELECT id, first_name, last_name, balance FROM players ORDER BY created_at ASC')
    ).rows
    // نام ستون‌ها در SQL اسنیک‌کیس است؛ ماژول ممیزی با همان نام‌های مدل
    // Prisma (camelCase) کار می‌کند، پس همین‌جا نگاشت می‌شوند.
    const transactions = (
      await client.query(
        `SELECT amount, type, source_player_id, destination_player_id,
                source_business_id, destination_business_id
           FROM financial_transactions`
      )
    ).rows.map((row) => ({
      amount: row.amount,
      // نوع ردیف برای جهت‌گیری لازم نیست، ولی برای شناختنِ جابه‌جاییِ داخلیِ
      // «کیف پول ↔ حسابِ بانکیِ خودِ بازیکن» ضروری است
      type: row.type,
      sourcePlayerId: row.source_player_id,
      destinationPlayerId: row.destination_player_id,
      sourceBusinessId: row.source_business_id,
      destinationBusinessId: row.destination_business_id
    }))
    const businesses = (await client.query('SELECT treasury FROM businesses')).rows
    const accounts = (
      await client.query('SELECT player_id, balance FROM bank_accounts')
    ).rows
    const deposits = (
      await client.query(`SELECT principal FROM term_deposits WHERE status = 'ACTIVE'`)
    ).rows
    const regions = (await client.query('SELECT tax_revenue FROM region_stats')).rows
    const poolRows = await client.query(
      `SELECT balance, total_deposited, total_disbursed, total_repaid,
              total_loan_interest, total_deposit_interest
         FROM bank_pool WHERE id = $1`,
      [BANK_POOL_ID]
    )
    const pool = poolRows.rows[0] ?? {
      balance: BANK_POOL_SEED,
      total_deposited: 0,
      total_disbursed: 0,
      total_repaid: 0,
      total_loan_interest: 0,
      total_deposit_interest: 0
    }

    // خودآزمایی: اگر ستونِ `type` نرسد، جابه‌جاییِ داخلیِ «کیف پول ↔ حسابِ
    // بانکیِ خودِ بازیکن» مثلِ پولِ بیرون‌رفته از بخش خصوصی شمرده می‌شود و ممیزی
    // برای هر بازیکنِ بانک‌دار اختلافِ خیالی گزارش می‌کند. چون این ابزار برای
    // پایش با کد خروج ۱ استفاده می‌شود، هشدارِ بی‌دلیل بدتر از نبودِ ابزار است.
    if (transactions.length > 0 && transactions.every((row) => row.type === undefined)) {
      console.error('  ❌ ردیف‌های دفتر کل بدونِ نوع خوانده شده‌اند؛ آشتی قابل اتکا نیست.')
      process.exit(1)
    }

    const fmt = (value) => Number(value).toLocaleString('en-US')
    console.log('── عرضهٔ پول ──')
    const supply = moneySupply({
      playerBalances: players.map((p) => num(p.balance)),
      businessTreasuries: businesses.map((b) => num(b.treasury)),
      bankBalances: accounts.map((a) => num(a.balance)),
      lockedDeposits: deposits.map((d) => num(d.principal)),
      regionFunds: regions.map((r) => num(r.tax_revenue)),
      bankPool: num(pool.balance)
    })
    console.log(`  کیف پول بازیکنان : ${fmt(supply.wallets)}`)
    console.log(`  خزانهٔ کسب‌وکارها : ${fmt(supply.businesses)}`)
    console.log(`  حساب‌های بانکی    : ${fmt(supply.banks)}`)
    console.log(`  سپرده‌های قفل‌شده  : ${fmt(supply.lockedDeposits)}`)
    console.log(`  صندوق مناطق      : ${fmt(supply.regionFunds)}`)
    console.log(`  ترازنامهٔ بانک    : ${fmt(supply.bankPool)}`)
    console.log(`  جمع ادعا و صندوق : ${fmt(supply.total)}`)
    console.log(
      `  ── پولِ موجود    : ${fmt(moneyInExistence(supply))}` +
        (moneyInExistence(supply) === supply.total
          ? ''
          : `  (سپردهٔ قفل‌شده داخلِ ترازنامهٔ بانک هم هست؛ یک‌بار شمرده شد)`)
    )

    console.log('\n── ترازنامهٔ بانک ──')
    const poolAudit = auditBankPool(
      {
        balance: num(pool.balance),
        totalDeposited: num(pool.total_deposited),
        totalDisbursed: num(pool.total_disbursed),
        totalRepaid: num(pool.total_repaid),
        totalLoanInterest: num(pool.total_loan_interest),
        totalDepositInterest: num(pool.total_deposit_interest)
      },
      BANK_POOL_SEED
    )
    console.log(
      poolAudit.ok
        ? '  ✅ بسته است: سرمایهٔ اولیه + سپرده‌ها + بازپرداخت‌ها + سود وام‌ها − وام‌ها − سود سپرده‌ها'
        : `  ❌ اختلاف ${fmt(poolAudit.difference)} (انتظار ${fmt(poolAudit.expected)} — واقعی ${fmt(poolAudit.actual)})`
    )

    console.log('\n── آشتی دفتر کل با داراییِ خصوصیِ بازیکنان ──')
    const bankByPlayer = new Map()
    for (const account of accounts) {
      const held = bankByPlayer.get(account.player_id) ?? []
      held.push(num(account.balance))
      bankByPlayer.set(account.player_id, held)
    }

    let drifted = 0
    for (const player of players) {
      const rows = transactions.filter(
        (t) => t.sourcePlayerId === player.id || t.destinationPlayerId === player.id
      )
      const check = reconcilePrivateSector(
        player.id,
        { wallet: num(player.balance), bankAccounts: bankByPlayer.get(player.id) ?? [] },
        rows
      )
      if (!check.ok) {
        drifted += 1
        const name = `${player.first_name ?? ''} ${player.last_name ?? ''}`.trim() || player.id
        console.log(
          `  ❌ ${name} (${player.id}): اختلاف ${fmt(check.difference)} (دفتر ${fmt(check.ledgerNet)} / دارایی ${fmt(check.balance)})`
        )
      }
    }
    if (drifted === 0) {
      console.log(`  ✅ هر ${players.length} بازیکن با دفتر کل می‌خواند`)
    } else {
      console.log(`  ⚠️ ${drifted} بازیکن اختلاف دارند (کسر/پاداش بدون ردیف دفتر کل)`)
    }

    if (drifted > 0 || !poolAudit.ok) {
      process.exitCode = 1
    }
  } finally {
    await client.end()
  }
}

main().catch((error) => {
  console.error('خطای ممیزی:', error.message)
  process.exit(1)
})
