import {
  deriveRunStatus,
  findRunnableNodes,
  validateGraph,
} from '../src/workflow-graph.mjs'

const graph = {
  id: 'lesson-2',
  nodes: [
    { id: 'A', type: 'task', requires: [] },
    { id: 'B', type: 'task', requires: [] },
    { id: 'C', type: 'task', requires: ['A', 'B'] },
    { id: 'D', type: 'task', requires: ['C'] },
  ],
}

const nodeStates = {}

function printStep(label) {
  const runnable = findRunnableNodes(graph, nodeStates)
  const runStatus = deriveRunStatus(graph, nodeStates)

  console.log(label)
  console.log(`  node states: ${JSON.stringify(nodeStates)}`)
  console.log(`  runnable: ${runnable.nodeIds.join(', ') || '<none>'}`)
  console.log(`  run status: ${runStatus.status}`)
}

console.log('graph validation:', validateGraph(graph))
printStep('\n1. Initial graph')

nodeStates.A = 'succeeded'
printStep('\n2. A succeeded')

nodeStates.B = 'succeeded'
printStep('\n3. B succeeded')

nodeStates.C = 'succeeded'
printStep('\n4. C succeeded')

nodeStates.D = 'succeeded'
printStep('\n5. D succeeded')
