import assert from 'node:assert/strict'
import test from 'node:test'
import {
  NODE_EVENTS,
  TERMINAL_NODE_STATES,
  isTerminalNodeState,
  transitionNode,
} from '../src/node-state-machine.mjs'

const validTransitions = [
  ['pending', 'DEPENDENCIES_RESOLVED', 'ready'],
  ['pending', 'NODE_SKIPPED', 'skipped'],
  ['pending', 'NODE_CANCELLED', 'cancelled'],
  ['ready', 'NODE_STARTED', 'running'],
  ['ready', 'NODE_CANCELLED', 'cancelled'],
  ['running', 'NODE_SUCCEEDED', 'succeeded'],
  ['running', 'NODE_FAILED', 'failed'],
  ['running', 'NODE_WAITING', 'waiting'],
  ['running', 'NODE_CANCELLED', 'cancelled'],
  ['waiting', 'INPUT_RECEIVED', 'ready'],
  ['waiting', 'NODE_CANCELLED', 'cancelled'],
  ['failed', 'NODE_RETRIED', 'ready'],
  ['failed', 'NODE_CANCELLED', 'cancelled'],
]

for (const [currentState, eventType, expectedState] of validTransitions) {
  test(`${currentState} --${eventType}--> ${expectedState}`, () => {
    const result = transitionNode(currentState, { type: eventType })

    assert.equal(result.ok, true)
    assert.equal(result.transition.previousState, currentState)
    assert.equal(result.transition.eventType, eventType)
    assert.equal(result.transition.nextState, expectedState)
  })
}

test('terminal states reject every event', () => {
  for (const state of TERMINAL_NODE_STATES) {
    assert.equal(isTerminalNodeState(state), true)

    for (const eventType of NODE_EVENTS) {
      const result = transitionNode(state, { type: eventType })
      assert.equal(result.ok, false)
      assert.equal(result.error.code, 'INVALID_TRANSITION')
    }
  }
})

test('rejects an unknown state', () => {
  const result = transitionNode('lost', { type: 'NODE_STARTED' })

  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'UNKNOWN_STATE')
})

test('rejects an unknown event', () => {
  const result = transitionNode('ready', { type: 'NODE_EXPLODED' })

  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'UNKNOWN_EVENT')
})

test('rejects starting an already running node', () => {
  const result = transitionNode('running', { type: 'NODE_STARTED' })

  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'INVALID_TRANSITION')
})

test('rejects completing a node that has not started', () => {
  const result = transitionNode('ready', { type: 'NODE_SUCCEEDED' })

  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'INVALID_TRANSITION')
})

test('does not mutate the event object', () => {
  const event = Object.freeze({ type: 'NODE_STARTED', metadata: { runnerId: 'runner-1' } })

  transitionNode('ready', event)

  assert.deepEqual(event, {
    type: 'NODE_STARTED',
    metadata: { runnerId: 'runner-1' },
  })
})
