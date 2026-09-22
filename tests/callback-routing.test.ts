import { readText } from './helpers/source'
import { join } from 'path'
import { InlineKeyboard } from 'grammy'
import { PART_TIME_JOBS, JOB_CATEGORIES } from '../src/modules/occupation/work-blueprints'
import {
  buildMyPropertiesKeyboard,
  buildPartTimeCategoriesKeyboard,
  buildBusinessManageKeyboard,
  buildJobPostingsKeyboard,
  buildJobDetailKeyboard,
  buildMyApplicationsKeyboard,
  buildMyJobKeyboard,
  buildQuitConfirmKeyboard,
  buildBusinessStaffKeyboard,
  buildJobWizardKeyboard,
  buildLoanCollateralKeyboard,
  buildLoanConfirmKeyboard,
  buildPartTimeJobsByCategoryKeyboard,
  buildActiveWorkKeyboard,
  buildHelpMainKeyboard,
  buildHelpCategoryKeyboard,
  buildHelpTopicKeyboard,
  buildFamilyKeyboard,
  buildFamilyCancelKeyboard,
  buildPetAdoptKeyboard,
  buildPetKeyboard,
  buildPetNameCancelKeyboard,
  buildPetRecoveryKeyboard,
  buildPetReviewKeyboard,
  buildAuctionKeyboard,
  buildAuctionCancelKeyboard,
  buildGymKeyboard,
  buildLoansKeyboard,
  buildLoanRequestCancelKeyboard,
  buildChallengeKeyboard,
  buildPolicyKeyboard,
  buildBranchKeyboard,
  buildBranchBusinessKeyboard,
  buildAdsKeyboard,
  buildAdsCancelKeyboard,
  buildCityKeyboard,
  buildBankingMenuKeyboard,
  buildHousingMenuKeyboard,
  buildWorkMenuKeyboard,
  buildStatsKeyboard,
  buildClinicKeyboard
} from '../src/bot/keyboards/main.keyboard'
import { DegreeLevel } from '@prisma/client'
import { HELP_CATEGORIES, HELP_TOPICS, getCategoryTopics } from '../src/bot/help-content'
import { PET_KINDS } from '../src/modules/pets/pet.service'
import { MAYOR_POLICIES } from '../src/modules/city/policy.service'

const HANDLER_SOURCES = [
  join(__dirname, '..', 'src', 'bot', 'handlers', 'text.handler.ts'),
  join(__dirname, '..', 'src', 'bot', 'handlers', 'expansion.handler.ts'),
  join(__dirname, '..', 'src', 'bot', 'handlers', 'start.handler.ts'),
  // سیستم‌های تکمیل‌شده (خانواده تا آگهی)
  join(__dirname, '..', 'src', 'bot', 'handlers', 'features.handler.ts'),
  // پنل مدیریت
  join(__dirname, '..', 'src', 'bot', 'handlers', 'admin.handler.ts')
]

/** الگوهای callback ثبت‌شده در تمام handlerها. */
function registeredHandlers(): Array<{ kind: 'exact' | 'regex'; pattern: string }> {
  const out: Array<{ kind: 'exact' | 'regex'; pattern: string }> = []
  for (const file of HANDLER_SOURCES) {
    const content = readText(file)
    for (const match of content.matchAll(/bot\.callbackQuery\('([^']+)'/g)) {
      out.push({ kind: 'exact', pattern: match[1]! })
    }
    for (const match of content.matchAll(/bot\.callbackQuery\(\/([^/]+)\//g)) {
      out.push({ kind: 'regex', pattern: match[1]! })
    }
  }
  return out
}

const HANDLERS = registeredHandlers()

/** آیا این callback_data به یک handler واقعی می‌رسد؟ */
function hasHandler(callbackData: string): boolean {
  return HANDLERS.some((handler) => {
    if (handler.kind === 'exact') return handler.pattern === callbackData
    try {
      return new RegExp(handler.pattern).test(callbackData)
    } catch {
      return false
    }
  })
}

/** استخراج callback_dataها از یک InlineKeyboard ساخته‌شده. */
function callbacksOf(keyboard: InlineKeyboard): string[] {
  return keyboard.inline_keyboard
    .flat()
    .flatMap((button) => ('callback_data' in button ? [button.callback_data] : []))
}

/** یافتن یک دکمه بر اساس callback_data برای بررسی متن آن. */
function buttonOf(keyboard: InlineKeyboard, callbackData: string): { text: string } {
  const button = keyboard.inline_keyboard
    .flat()
    .find((b) => 'callback_data' in b && b.callback_data === callbackData)

  expect(button).toBeDefined()
  return button as { text: string }
}

describe('The admin panel has no dead buttons', () => {
  const ADMIN_SRC = join(__dirname, '..', 'src', 'bot', 'handlers', 'admin.handler.ts')
  // دکمه‌های صفحه‌بندیِ راهنمای ادمین در ماژول جدا زندگی می‌کنند؛ بدون آن
  // این تست آن دکمه‌ها را «مرده» می‌دید در حالی که واقعاً صادر می‌شوند.
  const ADMIN_HELP_SRC = join(__dirname, '..', 'src', 'bot', 'admin-help.ts')
  const adminSource =
    readText(ADMIN_SRC) + '\n' + readText(ADMIN_HELP_SRC)

  /**
   * همهٔ callback_dataهای تولیدشده در پنل مدیریت (ثابت و قالبی).
   *
   * استخراج فقط با الگوی `callback_data:` یا آرگومانِ سادهٔ `.text(...)` کافی
   * نبود: دکمه‌ای مثل `.text(label.slice(0, 60), `adm:report:${id}`)` هیچ‌کدام
   * از آن دو الگو را نمی‌گیرد، پس هندلرِ زندهٔ `adm:report:<id>` «مرده» شمرده
   * می‌شد. حالا هر رشتهٔ نقل‌قولی که با `adm:` شروع شود دکمهٔ صادرشده است —
   * به‌جز خودِ ثبتِ هندلرها (`bot.callbackQuery(...)`) که دکمه تولید نمی‌کند و
   * پیش از استخراج حذف می‌شود تا یک «الگوی ثبت‌شده» اشتباهاً «دکمه» نشود.
   */
  function adminCallbacks(): string[] {
    const emitted = adminSource
      .replace(/bot\.callbackQuery\([^)]*\)/g, '')
      // `slice('adm:apply:'.length)` و مانند آن، پیشوندِ callback را به‌عنوان
      // رشتهٔ کد دارند نه دکمه؛ اگر حذف نشوند یک دکمه دوبار شمرده می‌شود.
      .replace(/\.(?:slice|startsWith|endsWith)\([^)]*\)/g, '')
    const out: string[] = []
    for (const match of emitted.matchAll(/callback_data:\s*(?:'|`)([^'`]+)/g)) {
      out.push(match[1]!)
    }
    for (const match of emitted.matchAll(/(?:'|`)(adm:[^'`]+)(?:'|`)/g)) {
      const index = match.index ?? 0
      // مقدارهای `currentContext` وضعیتِ جریانِ ورودی‌اند (مثلاً `adm:amount:ban:1`
      // یا `adm:search`) نه دکمه؛ شمردنِ آن‌ها به‌عنوان دکمه، تست را مثبتِ کاذب می‌کند.
      if (emitted.slice(Math.max(0, index - 48), index).includes('currentContext')) {
        continue
      }
      out.push(match[1]!)
    }
    return [...new Set(out)]
  }

  /**
   * جای‌گذاری نمونه به‌جای درون‌یابی‌ها تا بتوان الگو را آزمود.
   * مقدارها از همان دامنه‌های واقعی گرفته می‌شوند (مثل `DegreeLevel`) تا تست
   * چیزی را «مرده» نبیند که در عمل سالم است.
   */
  function sampleOf(raw: string): string {
    return raw
      .replace(/\$\{[^}]*telegramUserId[^}]*\}/g, '4242')
      .replace(/\$\{id\}/g, '4242')
      .replace(/\$\{token\}/g, '11111111-1111-4111-8111-111111111111')
      .replace(/\$\{group\.telegramGroupId[^}]*\}/g, '-1004242')
      .replace(/\$\{telegramGroupId[^}]*\}/g, '-1004242')
      .replace(/\$\{skill\.id\}/g, 'clx0sample0000000000000000')
      .replace(/\$\{level\}/g, 'BACHELOR')
      .replace(/\$\{action\}/g, 'ban')
      .replace(/\$\{kind\}/g, 'groups')
      .replace(/\$\{page[^}]*\}/g, '1')
      .replace(/\$\{[^}]*\}/g, '4242')
  }

  test('every real degree level matches the degree handler pattern', () => {
    // اگر روزی مقدار این enum حروف کوچک یا عدد گرفت، این تست قبل از دکمهٔ مرده هشدار می‌دهد
    for (const level of Object.values(DegreeLevel)) {
      expect(hasHandler(`adm:degree:${level}:4242`)).toBe(true)
    }
  })

  test('every button emitted by the admin handler routes to a live handler', () => {
    const callbacks = adminCallbacks()
    expect(callbacks.length).toBeGreaterThan(20)
    for (const raw of callbacks) {
      const sample = sampleOf(raw)
      // callback_data باید در محدودیت تلگرام بماند
      expect(Buffer.byteLength(sample)).toBeLessThanOrEqual(64)
      expect(hasHandler(sample)).toBe(true)
    }
  })

  test('every adm: handler is reachable from at least one emitted button', () => {
    const samples = adminCallbacks().map(sampleOf)
    const patterns = HANDLERS.filter(
      (h) => h.kind === 'regex' && h.pattern.startsWith('^adm:') && h.pattern !== '^adm:run:'
    )
    expect(patterns.length).toBeGreaterThan(10)
    for (const handler of patterns) {
      const reachable = samples.some((sample) => new RegExp(handler.pattern).test(sample))
      expect(reachable).toBe(true)
    }
  })

  test('destructive admin actions always pass through a confirm step', () => {
    // هیچ دکمهٔ مخربی نباید مستقیم به adm:run برسد
    const directRun = adminCallbacks()
      .map(sampleOf)
      .filter((cb) => cb.startsWith('adm:run:'))
    expect(directRun).toHaveLength(0)
    expect(adminCallbacks().filter(cb => cb.startsWith('adm:apply:'))).toHaveLength(1)
    const destructive = ['work_stop', 'edu_stop', 'streak_reset', 'state_reset', 'ban', 'admin_remove']
    for (const action of destructive) {
      const confirmSource = adminSource.includes(`adm:confirm:${action}`)
      expect(confirmSource).toBe(true)
    }
  })
})

describe('Every job button routes to a live handler', () => {
  const capacityMap = Object.fromEntries(
    PART_TIME_JOBS.map((job) => [job.key, { capacity: job.baseCapacity, occupied: 0 }])
  )

  test('category buttons all resolve', () => {
    for (const cb of callbacksOf(buildPartTimeCategoriesKeyboard())) {
      expect(hasHandler(cb)).toBe(true)
    }
  })

  test('only categories that actually contain jobs are offered', () => {
    const offered = callbacksOf(buildPartTimeCategoriesKeyboard())
      .filter((cb) => cb.startsWith('work:pt:cat:'))
      .map((cb) => cb.slice('work:pt:cat:'.length))

    expect(offered.length).toBeGreaterThan(0)
    for (const category of offered) {
      expect(PART_TIME_JOBS.some((job) => job.category === category)).toBe(true)
    }

    // دستهٔ خالی نباید دکمه داشته باشد، وگرنه بازیکن به فهرست خالی می‌رسد
    const emptyCategories = JOB_CATEGORIES.filter(
      (category) => !PART_TIME_JOBS.some((job) => job.category === category)
    )
    for (const category of emptyCategories) {
      expect(offered).not.toContain(category)
    }
  })

  test('every job in every category has a start handler', () => {
    for (const category of JOB_CATEGORIES) {
      const jobs = PART_TIME_JOBS.filter((job) => job.category === category)
      if (jobs.length === 0) continue

      const keyboard = buildPartTimeJobsByCategoryKeyboard(category, capacityMap)
      const callbacks = callbacksOf(keyboard)

      for (const job of jobs) {
        expect(callbacks).toContain(`work:start_pt:${job.key}`)
      }
      for (const cb of callbacks) {
        expect(hasHandler(cb)).toBe(true)
      }
    }
  })

  test('job buttons surface requirements before the player clicks', () => {
    const gated = PART_TIME_JOBS.find(
      (job) => job.requiredEducation !== undefined || (job.minExperience ?? 0) > 0
    )!
    const keyboard = buildPartTimeJobsByCategoryKeyboard(gated.category, capacityMap)
    const button = buttonOf(keyboard, `work:start_pt:${gated.key}`)

    if (gated.requiredEducation) expect(button.text).toContain('🎓')
    if (gated.minExperience) expect(button.text).toContain('⭐')
  })

  test('a full job is marked before the player wastes a click', () => {
    const job = PART_TIME_JOBS[0]!
    const full = { [job.key]: { capacity: job.baseCapacity, occupied: job.baseCapacity } }
    const keyboard = buildPartTimeJobsByCategoryKeyboard(job.category, full)

    expect(buttonOf(keyboard, `work:start_pt:${job.key}`).text).toContain('🔴')
  })

  test('overtime button appears only when overtime is ready', () => {
    expect(callbacksOf(buildActiveWorkKeyboard(true))).toContain('work:overtime')
    expect(callbacksOf(buildActiveWorkKeyboard(false))).not.toContain('work:overtime')
  })

  test('active work keyboard has no dead buttons', () => {
    for (const cb of [...callbacksOf(buildActiveWorkKeyboard(true)), ...callbacksOf(buildActiveWorkKeyboard(false))]) {
      expect(hasHandler(cb)).toBe(true)
    }
  })
})

/**
 * راهنمای بازیکنِ فعال و راهنمای تازه‌وارد یکی نیستند.
 *
 * بازیکنی که سال‌ها شخصیت دارد نباید نه دکمهٔ «شروع تازه‌کار» ببیند، نه آموزشِ
 * ساختِ شخصیت — نه در صفحهٔ اصلی و نه داخل فصلِ «قدم‌های اول».
 */
describe('The guide separates newcomers from existing players', () => {
  test('a player without a character gets the start shortcut', () => {
    const callbacks = callbacksOf(buildHelpMainKeyboard({ newcomer: true }))
    expect(callbacks).toContain('help:topic:basics:start')
  })

  test('an existing player sees no start shortcut and no character-creation lesson', () => {
    const callbacks = callbacksOf(buildHelpMainKeyboard({ newcomer: false }))
    expect(callbacks).not.toContain('help:topic:basics:start')

    // بقیهٔ فصلِ «قدم‌های اول» باید سر جایش باشد؛ حذفِ کلِ فصل یعنی بازیکن
    // راهنمای زمان و کلمه‌های بازی را هم از دست می‌دهد.
    const basics = callbacksOf(buildHelpCategoryKeyboard('basics', { newcomer: false }))
    expect(basics).not.toContain('help:topic:basics:start')
    // «پنل‌ها و دکمه‌ها» دیگر وجود ندارد: یک فصلِ آموزشِ رابط بود، نه آموزشِ بازی.
    // مسیرِ دکمه هم برداشته شده، پس نه در فصل هست و نه در فهرستِ موضوع‌ها.
    expect(basics).not.toContain('help:topic:basics:panels')
    expect(HELP_TOPICS.some((topic) => topic.key === 'panels')).toBe(false)
    expect(basics).toContain('help:topic:basics:timing')
  })

  test('every chapter keeps its topics for an existing player', () => {
    for (const category of HELP_CATEGORIES) {
      const callbacks = callbacksOf(buildHelpCategoryKeyboard(category.key, { newcomer: false }))
      for (const topic of getCategoryTopics(category.key)) {
        if (category.key === 'basics' && topic.key === 'start') {
          continue
        }
        expect(callbacks).toContain(`help:topic:${category.key}:${topic.key}`)
      }
    }
  })
})

describe('Help navigation has no dead ends', () => {
  test('the top level offers categories, not a wall of topics', () => {
    // پیش‌فرضِ کیبورد «بازیکنِ موجود» است: مسیرِ نادرست، مسیرِ خاموش
    const callbacks = callbacksOf(buildHelpMainKeyboard())
    const categoryButtons = callbacks.filter((cb) => cb.startsWith('help:cat:'))

    expect(categoryButtons).toHaveLength(HELP_CATEGORIES.length)
    expect(callbacks.length).toBeLessThanOrEqual(HELP_CATEGORIES.length + 2)

    for (const cb of callbacks) {
      expect(hasHandler(cb)).toBe(true)
    }
  })

  test('each category lists its topics and offers a way back', () => {
    for (const category of HELP_CATEGORIES) {
      // تازه‌واردها همهٔ موضوع‌ها را می‌بینند — از جمله «شروع بازی»
      const callbacks = callbacksOf(buildHelpCategoryKeyboard(category.key, { newcomer: true }))

      for (const topic of getCategoryTopics(category.key)) {
        expect(callbacks).toContain(`help:topic:${category.key}:${topic.key}`)
      }
      expect(callbacks).toContain('help:main')
      expect(callbacks).toContain('panel:close')

      for (const cb of callbacks) {
        expect(hasHandler(cb)).toBe(true)
      }
    }
  })

  test('a topic returns to its own category, not to the root', () => {
    const callbacks = callbacksOf(buildHelpTopicKeyboard('income'))
    expect(callbacks).toContain('help:cat:income')

    // بدون فصل، بازگشت به فهرست اصلی می‌رود و همچنان زنده است
    expect(callbacksOf(buildHelpTopicKeyboard())).toContain('help:main')
    for (const cb of callbacks) {
      expect(hasHandler(cb)).toBe(true)
    }
  })
})

describe('Completed gameplay systems have no dead buttons', () => {
  const boards: Array<{ name: string; keyboard: InlineKeyboard }> = [
    {
      name: 'family (single man)',
      keyboard: buildFamilyKeyboard({
        hasSpouse: false,
        bonusReady: false,
        genderIsMale: true,
        incomingProposals: [],
        outgoingProposals: []
      })
    },
    {
      name: 'family (married + bonus)',
      keyboard: buildFamilyKeyboard({
        hasSpouse: true,
        bonusReady: true,
        genderIsMale: true,
        incomingProposals: [],
        outgoingProposals: []
      })
    },
    {
      name: 'family (proposal pending)',
      keyboard: buildFamilyKeyboard({
        hasSpouse: false,
        bonusReady: false,
        genderIsMale: false,
        incomingProposals: [{ id: 'p1', canAccept: true, canSetMahr: true }],
        outgoingProposals: []
      })
    },
    {
      name: 'family (outgoing awaiting confirm)',
      keyboard: buildFamilyKeyboard({
        hasSpouse: false,
        bonusReady: false,
        genderIsMale: true,
        incomingProposals: [],
        outgoingProposals: [{ id: 'p2', awaitingMyAnswer: true }]
      })
    },
    { name: 'family mahr cancel', keyboard: buildFamilyCancelKeyboard() },
    { name: 'pet adopt list', keyboard: buildPetAdoptKeyboard([...PET_KINDS]) },
    { name: 'pet (none)', keyboard: buildPetKeyboard(false, false, false) },
    { name: 'pet (owned, ready)', keyboard: buildPetKeyboard(true, true, true) },
    { name: 'pet name cancel', keyboard: buildPetNameCancelKeyboard() },
    { name: 'pet recovery after failure', keyboard: buildPetRecoveryKeyboard() },
    { name: 'pet review (affordable)', keyboard: buildPetReviewKeyboard('cat', true) },
    { name: 'pet review (too expensive)', keyboard: buildPetReviewKeyboard('dog', false) },
    { name: 'auction (can bid)', keyboard: buildAuctionKeyboard(true, 1_000_000) },
    { name: 'auction (locked)', keyboard: buildAuctionKeyboard(false, 1_000_000) },
    { name: 'auction bid cancel', keyboard: buildAuctionCancelKeyboard() },
    { name: 'gym (inactive)', keyboard: buildGymKeyboard(false) },
    { name: 'gym (active)', keyboard: buildGymKeyboard(true) },
    { name: 'loans (requests + debts)', keyboard: buildLoansKeyboard([{ id: 'r1' }], [{ id: 'l1' }]) },
    { name: 'loans (empty)', keyboard: buildLoansKeyboard([], []) },
    { name: 'loan request cancel', keyboard: buildLoanRequestCancelKeyboard() },
    { name: 'challenge (claimable, in group)', keyboard: buildChallengeKeyboard(true, true) },
    { name: 'challenge (private view)', keyboard: buildChallengeKeyboard(false, false) },
    { name: 'policy (mayor)', keyboard: buildPolicyKeyboard([...MAYOR_POLICIES], true) },
    { name: 'policy (citizen)', keyboard: buildPolicyKeyboard([...MAYOR_POLICIES], false) },
    {
      name: 'branches (income + new region)',
      keyboard: buildBranchKeyboard(
        [{ id: 'b1', regionTitle: 'منطقه', pendingIncome: 500_000 }],
        true,
        [{ id: 'g1', title: 'منطقهٔ تازه' }]
      )
    },
    {
      name: 'branch business picker',
      keyboard: buildBranchBusinessKeyboard('g1', [
        { id: 'biz1', name: 'کسب‌وکار یک' },
        { id: 'biz2', name: 'کسب‌وکار دو' }
      ])
    },
    { name: 'ads', keyboard: buildAdsKeyboard() },
    { name: 'ads cancel', keyboard: buildAdsCancelKeyboard() },
    { name: 'city hub', keyboard: buildCityKeyboard() },
    { name: 'banking menu', keyboard: buildBankingMenuKeyboard() },
    { name: 'housing menu', keyboard: buildHousingMenuKeyboard(false) },
    { name: 'work menu', keyboard: buildWorkMenuKeyboard() },
    { name: 'stats/life menu', keyboard: buildStatsKeyboard() },
    { name: 'clinic menu', keyboard: buildClinicKeyboard(true, false) },
    {
      name: 'my properties (furnish + sell available)',
      keyboard: buildMyPropertiesKeyboard([
        { id: 'pr1', title: 'آپارتمان', isFurnished: false, rentedOut: false },
        { id: 'pr2', title: 'ویلای مبله', isFurnished: true, rentedOut: false }
      ])
    }
  ]

  test.each(boards.map((board) => [board.name, board.keyboard] as const))(
    'every button in the %s panel routes to a live handler',
    (_name, keyboard) => {
      const callbacks = callbacksOf(keyboard)
      expect(callbacks.length).toBeGreaterThan(0)
      for (const callback of callbacks) {
        expect({ callback, hasHandler: hasHandler(callback) }).toEqual({ callback, hasHandler: true })
      }
    }
  )

  test('every pet kind gets an adopt button', () => {
    const callbacks = callbacksOf(buildPetAdoptKeyboard([...PET_KINDS]))
    for (const kind of PET_KINDS) {
      expect(callbacks).toContain(`pet:adopt:${kind.key}`)
    }
  })

  test('every mayor policy is settable from the policy panel', () => {
    const callbacks = callbacksOf(buildPolicyKeyboard([...MAYOR_POLICIES], true))
    for (const policy of MAYOR_POLICIES) {
      expect(callbacks).toContain(`pol:set:${policy.key}`)
    }
  })
})

describe('Employment and business panels have no dead buttons', () => {
  const boards: Array<{ name: string; keyboard: InlineKeyboard }> = [
    { name: 'business manage', keyboard: buildBusinessManageKeyboard('b1') },
    { name: 'job postings (paged)', keyboard: buildJobPostingsKeyboard([{ id: 'j1' }], 1, 3) },
    { name: 'job detail (eligible)', keyboard: buildJobDetailKeyboard('j1', false, []) },
    { name: 'job detail (applied)', keyboard: buildJobDetailKeyboard('j1', true, []) },
    {
      name: 'job detail (blocked)',
      keyboard: buildJobDetailKeyboard('j1', false, ['حداقل مدرک: کارشناسی'])
    },
    { name: 'my applications', keyboard: buildMyApplicationsKeyboard([{ id: 'a1' }]) },
    { name: 'my job (employed)', keyboard: buildMyJobKeyboard(true) },
    { name: 'my job (free)', keyboard: buildMyJobKeyboard(false) },
    { name: 'quit confirm', keyboard: buildQuitConfirmKeyboard('e1') },
    {
      name: 'staff rows',
      keyboard: buildBusinessStaffKeyboard(
        [
          { text: '✅ پذیرش آرش', cb: 'job:hire:a1' },
          { text: '❌ رد آرش', cb: 'job:rej:a1' }
        ],
        'biz:manage:b1'
      )
    },
    { name: 'job wizard', keyboard: buildJobWizardKeyboard(true) },
    {
      name: 'loan collateral',
      keyboard: buildLoanCollateralKeyboard(
        [{ id: 'p1', title: 'آپارتمان' }],
        [{ id: 'b1', name: 'شرکت' }]
      )
    },
    { name: 'loan confirm', keyboard: buildLoanConfirmKeyboard('property', 'p1') }
  ]

  test.each(boards)('$name routes to a live handler', ({ keyboard }) => {
    const callbacks = callbacksOf(keyboard)
    expect(callbacks.length).toBeGreaterThan(0)
    for (const cb of callbacks) {
      expect(hasHandler(cb)).toBe(true)
    }
  })

  test('the wizard cancel button always routes back to the business panel', () => {
    const cb = callbacksOf(buildJobWizardKeyboard(true)).find((c) => c === 'biz:jf:cancel')
    expect(cb).toBeDefined()
    expect(hasHandler(cb!)).toBe(true)
  })
})
