import assert from 'node:assert/strict'
import test from 'node:test'
import {
  deriveRunStatus,
  findRunnableNodes,
  validateGraph,
} from '../src/workflow-graph.mjs'

const graph = {
  id: 'diamond',
  nodes: [
    { id: 'A', type: 'task', requires: [] },
    { id: 'B', type: 'task', requires: [] },
    { id: 'C', type: 'task', requires: ['A', 'B'] },
    { id: 'D', type: 'task', requires: ['C'] },
  ],
}

test('accepts a valid DAG', () => {
  assert.deepEqual(validateGraph(graph), { ok: true, errors: [] })
})

test('rejects duplicate node ids', () => {
  const invalidGraph = {
    nodes: [
      { id: 'A', type: 'task', requires: [] },
      { id: 'A', type: 'task', requires: [] },
    ],
  }

  assert.equal(validateGraph(invalidGraph).errors[0].code, 'DUPLICATE_NODE_ID')
})

test('rejects a missing dependency', () => {
  const invalidGraph = {
    nodes: [{ id: 'A', type: 'task', requires: ['missing'] }],
  }

  assert.equal(validateGraph(invalidGraph).errors[0].code, 'MISSING_DEPENDENCY')
})

test('rejects a self dependency', () => {
  const invalidGraph = {
    nodes: [{ id: 'A', type: 'task', requires: ['A'] }],
  }

  assert.equal(validateGraph(invalidGraph).errors[0].code, 'SELF_DEPENDENCY')
})

test('rejects a cycle', () => {
  const invalidGraph = {
    nodes: [
      { id: 'A', type: 'task', requires: ['B'] },
      { id: 'B', type: 'task', requires: ['A'] },
    ],
  }
  const result = validateGraph(invalidGraph)

  assert.equal(result.ok, false)
  assert.equal(result.errors[0].code, 'CYCLE_DETECTED')
  assert.deepEqual(result.errors[0].cycleNodeIds, ['A', 'B'])
})

test('rejects a three-node cycle', () => {
  const invalidGraph = {
    nodes: [
      { id: 'A', type: 'task', requires: ['C'] },
      { id: 'B', type: 'task', requires: ['A'] },
      { id: 'C', type: 'task', requires: ['B'] },
    ],
  }
  const result = validateGraph(invalidGraph)

  assert.equal(result.ok, false)
  assert.equal(result.errors[0].code, 'CYCLE_DETECTED')
  assert.deepEqual(result.errors[0].cycleNodeIds, ['A', 'B', 'C'])
})

test('finds root nodes in the initial ready set', () => {
  assert.deepEqual(findRunnableNodes(graph).nodeIds, ['A', 'B'])
})

test('waits for every dependency before making a node runnable', () => {
  assert.deepEqual(findRunnableNodes(graph, { A: 'succeeded' }).nodeIds, ['B'])
  assert.deepEqual(
    findRunnableNodes(graph, { A: 'succeeded', B: 'succeeded' }).nodeIds,
    ['C'],
  )
})

test('makes downstream nodes runnable in dependency order', () => {
  const states = { A: 'succeeded', B: 'succeeded', C: 'succeeded' }

  assert.deepEqual(findRunnableNodes(graph, states).nodeIds, ['D'])
})

test('treats a skipped dependency as satisfied', () => {
  const states = { A: 'succeeded', B: 'skipped' }

  assert.deepEqual(findRunnableNodes(graph, states).nodeIds, ['C'])
})

test('does not run downstream nodes after a failed dependency', () => {
  const states = { A: 'succeeded', B: 'failed' }

  assert.deepEqual(findRunnableNodes(graph, states).nodeIds, [])
})

test('derives the run status from node states', () => {
  assert.equal(deriveRunStatus(graph, {}).status, 'ready')
  assert.equal(deriveRunStatus(graph, { A: 'running' }).status, 'running')
  assert.equal(
    deriveRunStatus(graph, { A: 'succeeded', B: 'waiting' }).status,
    'waiting',
  )
  assert.equal(
    deriveRunStatus(graph, { A: 'succeeded', B: 'failed' }).status,
    'failed',
  )
  assert.equal(
    deriveRunStatus(graph, {
      A: 'succeeded',
      B: 'skipped',
      C: 'succeeded',
      D: 'succeeded',
    }).status,
    'completed',
  )
})
