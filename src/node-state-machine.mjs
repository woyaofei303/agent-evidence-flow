export const NODE_STATES = Object.freeze([
  'pending',
  'ready',
  'running',
  'waiting',
  'failed',
  'succeeded',
  'skipped',
  'cancelled',
])

export const NODE_EVENTS = Object.freeze([
  'DEPENDENCIES_RESOLVED',
  'NODE_STARTED',
  'NODE_SUCCEEDED',
  'NODE_FAILED',
  'NODE_WAITING',
  'INPUT_RECEIVED',
  'NODE_RETRIED',
  'NODE_SKIPPED',
  'NODE_CANCELLED',
])

export const TERMINAL_NODE_STATES = Object.freeze([
  'succeeded',
  'skipped',
  'cancelled',
])

const stateSet = new Set(NODE_STATES)
const eventSet = new Set(NODE_EVENTS)

const transitions = Object.freeze({
  pending: Object.freeze({
    DEPENDENCIES_RESOLVED: 'ready',
    NODE_SKIPPED: 'skipped',
    NODE_CANCELLED: 'cancelled',
  }),
  ready: Object.freeze({
    NODE_STARTED: 'running',
    NODE_CANCELLED: 'cancelled',
  }),
  running: Object.freeze({
    NODE_SUCCEEDED: 'succeeded',
    NODE_FAILED: 'failed',
    NODE_WAITING: 'waiting',
    NODE_CANCELLED: 'cancelled',
  }),
  waiting: Object.freeze({
    INPUT_RECEIVED: 'ready',
    NODE_CANCELLED: 'cancelled',
  }),
  failed: Object.freeze({
    NODE_RETRIED: 'ready',
    NODE_CANCELLED: 'cancelled',
  }),
  succeeded: Object.freeze({}),
  skipped: Object.freeze({}),
  cancelled: Object.freeze({}),
})

function failure(code, message, state, eventType) {
  return {
    ok: false,
    error: {
      code,
      message,
      state,
      eventType,
    },
  }
}

export function transitionNode(currentState, event) {
  const eventType = event?.type

  if (!stateSet.has(currentState)) {
    return failure(
      'UNKNOWN_STATE',
      `Unknown node state: ${String(currentState)}`,
      currentState,
      eventType,
    )
  }

  if (!eventSet.has(eventType)) {
    return failure(
      'UNKNOWN_EVENT',
      `Unknown node event: ${String(eventType)}`,
      currentState,
      eventType,
    )
  }

  const nextState = transitions[currentState][eventType]

  if (!nextState) {
    return failure(
      'INVALID_TRANSITION',
      `Event ${eventType} is not allowed while node is ${currentState}`,
      currentState,
      eventType,
    )
  }

  return {
    ok: true,
    transition: {
      previousState: currentState,
      eventType,
      nextState,
    },
  }
}

export function isTerminalNodeState(state) {
  return TERMINAL_NODE_STATES.includes(state)
}
