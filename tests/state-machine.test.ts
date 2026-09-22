import { PlayerActivityState, PlayerStatus } from '@prisma/client'
import { PlayerStateMachine } from '../src/modules/identity/player-state-machine'
import { ConflictError, ValidationError } from '../src/utils/classes/errors'

describe('PlayerStateMachine and Invariants', () => {
  describe('assertCanStartActivity', () => {
    test('allows activity when player is ACTIVE and IDLE', () => {
      expect(() => {
        PlayerStateMachine.assertCanStartActivity(
          PlayerStatus.ACTIVE,
          PlayerActivityState.IDLE,
          PlayerActivityState.WORKING
        )
      }).not.toThrow()
    })

    test('prohibits DEAD players from starting activities', () => {
      expect(() => {
        PlayerStateMachine.assertCanStartActivity(
          PlayerStatus.DEAD,
          PlayerActivityState.IDLE,
          PlayerActivityState.WORKING
        )
      }).toThrow(ConflictError)
    })

    test('prohibits starting concurrent activity (e.g. studying while working)', () => {
      expect(() => {
        PlayerStateMachine.assertCanStartActivity(
          PlayerStatus.ACTIVE,
          PlayerActivityState.WORKING,
          PlayerActivityState.STUDYING
        )
      }).toThrow(ConflictError)
    })

    test('allows resuming the exact same ongoing activity', () => {
      expect(() => {
        PlayerStateMachine.assertCanStartActivity(
          PlayerStatus.ACTIVE,
          PlayerActivityState.WORKING,
          PlayerActivityState.WORKING
        )
      }).not.toThrow()
    })
  })

  describe('validateSalaryAdjustment', () => {
    test('accepts realistic salary adjustments', () => {
      expect(() => {
        PlayerStateMachine.validateSalaryAdjustment(200, 250)
      }).not.toThrow()
    })

    test('rejects negative or sub-minimum salaries', () => {
      expect(() => {
        PlayerStateMachine.validateSalaryAdjustment(200, 10)
      }).toThrow(ValidationError)
    })

    test('rejects predatory salary cuts greater than 50%', () => {
      expect(() => {
        PlayerStateMachine.validateSalaryAdjustment(500, 100)
      }).toThrow(ValidationError)
    })

    test('rejects unrealistic salary spikes greater than 300%', () => {
      expect(() => {
        PlayerStateMachine.validateSalaryAdjustment(500, 3000)
      }).toThrow(ValidationError)
    })
  })
})