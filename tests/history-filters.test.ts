import {
  HISTORY_FILTERS,
  historyFilterLabel,
  historyFilterTypes,
  isHistoryFilterKey
} from '../src/modules/events/history-filters'

describe('History filters — the dead `types` parameter is now a real feature', () => {
  test('every filter key is accepted, garbage is not', () => {
    for (const filter of HISTORY_FILTERS) {
      expect(isHistoryFilterKey(filter.key)).toBe(true)
    }
    expect(isHistoryFilterKey('hack')).toBe(false)
    expect(isHistoryFilterKey('')).toBe(false)
  })

  test('«all» means no filter — the service gets undefined, not an empty list', () => {
    expect(historyFilterTypes('all')).toBeUndefined()
  })

  test('each named filter maps to a non-empty, unique set of event types', () => {
    const seen = new Set<string>()
    for (const filter of HISTORY_FILTERS) {
      if (filter.key === 'all') continue
      const types = historyFilterTypes(filter.key)
      expect(Array.isArray(types)).toBe(true)
      expect(types!.length).toBeGreaterThan(0)
      for (const type of types!) {
        // یک رخداد نباید در دو برش بیفتد؛ تاریخچهٔ «کار» با «مالی» قاطی نمی‌شود
        expect(seen.has(type)).toBe(false)
        seen.add(type)
      }
    }
  })

  test('life-story anchors live in the right slices', () => {
    expect(historyFilterTypes('family')).toContain('MARRIAGE_REGISTERED')
    expect(historyFilterTypes('family')).toContain('DIVORCE_REGISTERED')
    expect(historyFilterTypes('work')).toContain('JOB_STARTED')
    expect(historyFilterTypes('money')).toContain('LOAN_CREATED')
    expect(historyFilterTypes('city')).toContain('RESIDENCE_MIGRATED')
  })

  test('labels are human and unique', () => {
    const labels = HISTORY_FILTERS.map((f) => historyFilterLabel(f.key))
    expect(new Set(labels).size).toBe(labels.length)
    expect(historyFilterLabel('work')).toContain('کار')
  })
})
