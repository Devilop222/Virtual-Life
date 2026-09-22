import { EnvironmentClassifier } from '../src/modules/groups/environment.classifier'
import { GroupEnvironmentLevel } from '@prisma/client'

describe('EnvironmentClassifier', () => {
  const classifier = new EnvironmentClassifier()

  test.each([
    [0, GroupEnvironmentLevel.VILLAGE],
    [5, GroupEnvironmentLevel.VILLAGE],
    [14, GroupEnvironmentLevel.VILLAGE],
    [15, GroupEnvironmentLevel.CITY],
    [25, GroupEnvironmentLevel.CITY],
    [30, GroupEnvironmentLevel.CITY],
    [31, GroupEnvironmentLevel.PROVINCE],
    [45, GroupEnvironmentLevel.PROVINCE],
    [50, GroupEnvironmentLevel.PROVINCE],
    [51, GroupEnvironmentLevel.COUNTRY],
    [100, GroupEnvironmentLevel.COUNTRY]
  ])('classifies %i members as %s', (count, expected) => {
    expect(classifier.classify(count)).toBe(expected)
  })

  test('throws for negative member count', () => {
    expect(() => classifier.classify(-1)).toThrow(RangeError)
  })

  test('throws for fractional member count', () => {
    expect(() => classifier.classify(12.5)).toThrow(RangeError)
  })
})