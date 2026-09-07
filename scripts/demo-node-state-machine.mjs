import { transitionNode } from '../src/node-state-machine.mjs'

const events = [
  { type: 'DEPENDENCIES_RESOLVED' },
  { type: 'NODE_STARTED' },
  { type: 'NODE_SUCCEEDED' },
]

let state = 'pending'
console.log(`initial state: ${state}`)

for (const event of events) {
  const result = transitionNode(state, event)

  if (!result.ok) {
    console.error(result.error)
    process.exit(1)
  }

  const { previousState, eventType, nextState } = result.transition
  console.log(`${previousState} --${eventType}--> ${nextState}`)
  state = nextState
}

console.log('\nTrying an invalid transition from a terminal state:')
const invalidResult = transitionNode(state, { type: 'NODE_STARTED' })
console.log(invalidResult.error)
