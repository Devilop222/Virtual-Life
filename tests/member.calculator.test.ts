import { computeRealMemberCount, countNonBots } from '../src/modules/groups/member.calculator'

describe('Member Calculator', () => {
  describe('countNonBots', () => {
    test('correctly counts non-bot users', () => {
      const users = [
        { id: 1, is_bot: false },
        { id: 2, is_bot: true },
        { id: 3, is_bot: false },
        { id: 4, is_bot: true }
      ]
      expect(countNonBots(users)).toBe(2)
    })

    test('returns 0 when all are bots', () => {
      const users = [
        { id: 1, is_bot: true },
        { id: 2, is_bot: true }
      ]
      expect(countNonBots(users)).toBe(0)
    })

    test('returns full length when no bots', () => {
      const users = [
        { id: 1, is_bot: false },
        { id: 2, is_bot: false }
      ]
      expect(countNonBots(users)).toBe(2)
    })
  })

  describe('computeRealMemberCount', () => {
    test('subtracts admin bots from total count', () => {
      expect(computeRealMemberCount(40, 20)).toBe(20)
    })

    test('never returns negative value', () => {
      expect(computeRealMemberCount(5, 10)).toBe(0)
    })
  })
})