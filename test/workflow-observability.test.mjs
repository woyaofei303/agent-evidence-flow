import assert from 'node:assert/strict'
import test from 'node:test'
import { explainRun, summarizeMetrics, summarizeRun, timelineRun } from '../src/workflow-observability.mjs'

const record = {
  plan: {
    planHash: 'plan-hash',
    context: {
      request: 'Change an API', signals: ['API_CONTRACT_CHANGE'],
      eventGates: [{ signal: 'API_CONTRACT_CHANGE', source: 'operator', confidence: 'declared' }],
      planningMode: 'openspec', executionMode: 'single-pass', modeReasons: ['planning mode openspec: matched API_CONTRACT_CHANGE'],
    },
    planningReasons: ['planning mode: openspec'],
    nodes: [{ id: 'intake', type: 'agent', requires: [] }, { id: 'planning', type: 'agent', requires: ['intake'] }],
    skippedNodes: [{ id: 'loop-execution', reason: 'did not match' }],
  },
  events: [
    { sequence: 1, at: '2026-01-01T00:00:00.000Z', type: 'RUN_CREATED' },
    { sequence: 2, at: '2026-01-01T00:01:00.000Z', type: 'NODE_TRANSITIONED', nodeId: 'intake', eventType: 'NODE_WAITING', nextState: 'waiting', evidence: { reason: 'need input' } },
    { sequence: 3, at: '2026-01-01T00:02:00.000Z', type: 'CONTEXT_RECORDED', evidence: { kind: 'lexical-context-references', query: 'API contract', indexedAt: '2026-01-01T00:00:00.000Z', reviewed: true, references: [{ path: 'src/api.mjs', line: 12, stale: false }] } },
  ],
}
const projection = { runId: 'task-1', planHash: 'plan-hash', status: 'waiting', nodeStates: { intake: 'waiting', planning: 'pending' }, activeExecutions: {} }

test('summarizes actionable progress without hiding waiting evidence', () => {
  const result = summarizeRun(record, projection)
  assert.deepEqual(result.progress, { total: 2, byState: { waiting: 1, pending: 1 }, completed: 0 })
  assert.deepEqual(result.waiting, [{ nodeId: 'intake', evidence: { reason: 'need input' } }])
  assert.equal(result.nextActions[0].nodeId, 'intake')
})

test('explains decision inputs and produces an ordered timeline', () => {
  const explanation = explainRun(record, projection)
  assert.equal(explanation.eventGates[0].source, 'operator')
  assert.deepEqual(explanation.contextReferences[0].references, [{ path: 'src/api.mjs', line: 12, stale: false }])
  assert.equal(explanation.includedNodes[0].state, 'waiting')
  assert.deepEqual(timelineRun(record).map((event) => event.sequence), [1, 2, 3])
})

test('measures execution and waiting separately and does not extend completion for later CLI reads', () => {
  const at = seconds => new Date(seconds * 1000).toISOString()
  const measured = { ...record, runId: 'measured', createdAt: at(0), updatedAt: at(9),
    plan: { ...record.plan, context: { ...record.plan.context, taskCategory: 'bugfix' } },
    events: [
      { type: 'RUN_CREATED', at: at(0) },
      { type: 'NODE_TRANSITIONED', nodeId: 'intake', nextState: 'waiting', at: at(1) },
      { type: 'NODE_TRANSITIONED', nodeId: 'intake', nextState: 'succeeded', at: at(2) },
      { type: 'NODE_TRANSITIONED', nodeId: 'planning', nextState: 'running', at: at(3) },
      { type: 'NODE_TRANSITIONED', nodeId: 'planning', nextState: 'succeeded', at: at(5) },
      { type: 'CLI_INVOKED', evidence: { command: 'status' }, at: at(9) },
    ] }
  const result = summarizeMetrics([measured], 12000)
  assert.equal(result.rows[0].elapsedMs, 5000)
  assert.equal(result.rows[0].executionMs, 2000)
  assert.equal(result.rows[0].waitingMs, 3000)
  assert.equal(result.byCategory.bugfix.completed, 1)
  assert.equal(result.cliCalls, 1)
})
