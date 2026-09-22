import {
  HELP_TOPICS,
  HELP_MAIN_TEXT,
  HELP_CATEGORIES,
  getHelpTopic,
  getHelpCategory,
  getCategoryTopics,
  renderCategoryPanel
} from '../src/bot/help-content'
import { SECTION_PURPOSE, catalogForPolicy } from '../src/bot/command-catalog'

describe('Help system content', () => {
  test('has all core topics with unique keys', () => {
    const keys = HELP_TOPICS.map((t) => t.key)
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys).toEqual(
      expect.arrayContaining([
        'start',
        'residence',
        'identity',
        'business',
        'work',
        'education',
        'housing',
        'bank',
        'shop',
        'leaderboard',
        'group',
        'credit',
        'ledger',
        'stats',
        'city',
        'news',
        'region',
        'rank',
        'mission',
        'history',
        'manage',
        'commands'
      ])
    )
  })

  test('every topic has a persian button label, title and body', () => {
    for (const topic of HELP_TOPICS) {
      expect(topic.buttonLabel.length).toBeGreaterThan(0)
      expect(topic.title.length).toBeGreaterThan(0)
      expect(topic.body.length).toBeGreaterThan(40)
      // بدنه باید فارسی باشد
      expect(/[\u0600-\u06FF]/.test(topic.body)).toBe(true)
    }
  })

  test('getHelpTopic resolves known keys and rejects unknown ones', () => {
    expect(getHelpTopic('bank')?.key).toBe('bank')
    expect(getHelpTopic('does-not-exist')).toBeUndefined()
  })

  test('help covers every user-facing section of the bot', () => {
    // هر بخش قابل استفاده در ربات باید راهنما داشته باشد
    const requiredTopics = [
      'start',
      'residence',
      'identity',
      'work',
      'business',
      'education',
      'housing',
      'bank',
      'shop',
      'leaderboard',
      'rank',
      'mission',
      'history',
      'ledger',
      'stats',
      'credit',
      'news',
      'region',
      'city',
      'group',
      'manage',
      'commands'
    ]
    const keys = HELP_TOPICS.map((t) => t.key)
    for (const topic of requiredTopics) {
      expect(keys).toContain(topic)
    }
  })

  test('no help body leaks developer wording or raw identifiers', () => {
    const forbidden = [
      'undefined',
      'null',
      'Error',
      'TypeError',
      'PrismaClient',
      'telegramUserId',
      'groupId',
      'callback_data',
      'ACTIVE',
      'IDLE'
    ]
    for (const topic of HELP_TOPICS) {
      for (const word of forbidden) {
        expect(topic.body).not.toContain(word)
      }
    }
  })

  test('every help body is long enough to actually explain the feature', () => {
    for (const topic of HELP_TOPICS) {
      const lines = topic.body.split('\n').filter((l) => l.trim().length > 0)
      expect(lines.length).toBeGreaterThanOrEqual(5)
    }
  })

  test('every help body starts with a bold title followed by a divider', () => {
    for (const topic of HELP_TOPICS) {
      const lines = topic.body.split('\n')
      expect(lines[0]!.startsWith('*')).toBe(true)
      expect(lines[1]).toBe('')
      expect(topic.body).not.toMatch(/[━┈]/)
    }
  })

  test('main help text is persian and mentions text-first gameplay', () => {
    expect(/[\u0600-\u06FF]/.test(HELP_MAIN_TEXT)).toBe(true)
    expect(HELP_MAIN_TEXT).toContain('راهنمای میراث')
  })

  test('هیچ خط راهنما شکل «کلمه = کلمه» ندارد', () => {
    // فهرست کلمه‌ها باید بگوید آن بخش *چه کاری* می‌کند. پیش‌تر برای بخش‌هایی
    // که عنوان و کلیدواژه‌شان یکی بود، خطی مثل «شناسنامه — «شناسنامه»»
    // ساخته می‌شد که هیچ اطلاعاتی به بازیکن نمی‌داد.
    const bodies = ['commands', 'commands_group']
      .map((key) => getHelpTopic(key)!.body)
      .join('\n')
    for (const line of bodies.split('\n')) {
      const match = line.match(/^\S+ («[^»]+») — (.+)$/u)
      if (!match) continue
      const keyword = match[1]!.replace(/[«»]/g, '')
      const purpose = match[2]!.trim()
      expect(purpose).not.toBe(keyword)
      expect(purpose).not.toBe(`«${keyword}»`)
      expect(purpose.length).toBeGreaterThan(10)
    }
  })

  test('هر خط راهنما روی موبایل می‌شکند، نه اینکه سرریز کند', () => {
    // تلگرام خطوط بلند را خودش می‌شکند و نتیجه‌اش پاراگراف درهم می‌شود.
    // سقف ۸۰ نویسه، عرض راحت یک گوشی معمولی است.
    const overflow: string[] = []
    const fragments: Array<[string, string]> = [
      ...HELP_TOPICS.map((topic) => [topic.key, topic.body] as [string, string]),
      ...HELP_CATEGORIES.map((category) => [`cat:${category.key}`, renderCategoryPanel(category.key)] as [string, string])
    ]
    for (const [key, fragment] of fragments) {
      for (const line of fragment.split('\n')) {
        const plain = line.replace(/[*«»]/g, '')
        if (plain.length > 80) overflow.push(`${key} (${plain.length}): ${plain}`)
      }
    }
    expect(overflow).toEqual([])
  })

  test('واحد پول دو بار پشت هم نمی‌آید', () => {
    // `money()` خودش «تومان» را اضافه می‌کند؛ نوشتن دوبارهٔ واحد، متن را
    // به «۲۰۰ تومان تومان» تبدیل می‌کند. این ایراد یک بار در راهنما کشف شد.
    for (const topic of HELP_TOPICS) {
      expect(topic.body).not.toMatch(/تومان[\s\u200c]*تومان/)
    }
  })

  test('نشانه‌های بولد در هیچ متن راهنما لنگ نمی‌مانند', () => {
    // یک «*» بی‌جفت، مارک‌داون تلگرام را می‌شکند و پنل بی‌قالب می‌رود.
    const fragments = [
      ...HELP_TOPICS.map((topic) => topic.body),
      HELP_MAIN_TEXT,
      ...HELP_CATEGORIES.map((category) => renderCategoryPanel(category.key))
    ]
    for (const fragment of fragments) {
      const stars = (fragment.match(/\*/g) ?? []).length
      expect(stars % 2).toBe(0)
    }
  })

  test('هر بخشِ فهرستِ راهنما کاربردِ نوشته‌شده دارد', () => {
    for (const policy of ['BOTH', 'GROUP_ONLY', 'PRIVATE_ONLY'] as const) {
      for (const entry of catalogForPolicy(policy)) {
        const purpose = SECTION_PURPOSE[entry.section]
        expect(purpose).toBeDefined()
        expect(purpose!.length).toBeGreaterThan(8)
        expect(/[\u0600-\u06FF]/.test(purpose!)).toBe(true)
        expect(purpose).not.toBe(entry.keyword)
        expect(purpose).not.toBe(entry.title)
      }
    }
  })
})

describe('Help navigation structure', () => {
  test('every category maps to existing topics', () => {
    for (const category of HELP_CATEGORIES) {
      expect(category.topicKeys.length).toBeGreaterThan(0)
      for (const topicKey of category.topicKeys) {
        expect(getHelpTopic(topicKey)).toBeDefined()
      }
    }
  })

  test('every topic is reachable from exactly one category', () => {
    const reachable = HELP_CATEGORIES.flatMap((c) => c.topicKeys)
    expect(new Set(reachable).size).toBe(reachable.length)

    for (const topic of HELP_TOPICS) {
      expect(reachable).toContain(topic.key)
    }
  })

  test('no category holds more topics than a clean panel can show', () => {
    for (const category of HELP_CATEGORIES) {
      expect(category.topicKeys.length).toBeLessThanOrEqual(8)
    }
  })

  test('getCategoryTopics preserves the declared order', () => {
    for (const category of HELP_CATEGORIES) {
      expect(getCategoryTopics(category.key).map((t) => t.key)).toEqual([...category.topicKeys])
    }
    expect(getCategoryTopics('does-not-exist')).toEqual([])
  })

  test('category panel lists its topics and stays short', () => {
    for (const category of HELP_CATEGORIES) {
      const out = renderCategoryPanel(category.key)
      expect(out).toContain(category.description)
      expect(out.split('\n').length).toBeLessThanOrEqual(16)
    }
    expect(renderCategoryPanel('does-not-exist')).toBe(HELP_MAIN_TEXT)
  })

  test('getHelpCategory resolves known keys and rejects unknown ones', () => {
    expect(getHelpCategory('basics')?.key).toBe('basics')
    expect(getHelpCategory('nope')).toBeUndefined()
  })
})
