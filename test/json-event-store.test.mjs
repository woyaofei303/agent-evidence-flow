import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createJsonEventStore } from '../src/json-event-store.mjs'

function samplePlan(runId = 'run-1') {
  return {
    planVersion: 1,
    runId,
    workflow: { id: 'test', version: 1 },
    context: {
      taskId: runId,
      request: 'Test persistence',
      sediment: 'required',
      signals: [],
      changedFiles: [],
    },
    nodes: [
      { id: 'intake', type: 'rule', requires: [] },
      { id: 'complete', type: 'rule', requires: ['intake'] },
    ],
    skippedNodes: [],
    planningReasons: [],
    planHash: 'test-plan-hash',
  }
}

async function temporaryState(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'workflow-store-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

test('creates a run with an immutable plan and RUN_CREATED event', async (t) => {
  const directory = await temporaryState(t)
  const store = createJsonEventStore({
    rootDirectory: directory,
    now: () => '2026-08-19T00:00:00.000Z',
  })
  const result = await store.createRun(samplePlan())

  assert.equal(result.ok, true)
  assert.equal(result.record.events[0].type, 'RUN_CREATED')
  assert.equal(result.projection.lastSequence, 1)
  assert.equal(result.projection.nodeStates.intake, 'pending')
})

test('appends valid node transitions with monotonic sequence numbers', async (t) => {
  const directory = await temporaryState(t)
  const store = createJsonEventStore({ rootDirectory: directory })
  await store.createRun(samplePlan())

  await store.appendNodeEvent('run-1', 'intake', { type: 'DEPENDENCIES_RESOLVED' })
  await store.appendNodeEvent('run-1', 'intake', { type: 'NODE_STARTED' })
  const result = await store.appendNodeEvent('run-1', 'intake', { type: 'NODE_SUCCEEDED' })

  assert.equal(result.ok, true)
  assert.deepEqual(
    result.record.events.map((event) => event.sequence),
    [1, 2, 3, 4],
  )
  assert.equal(result.projection.nodeStates.intake, 'succeeded')
})

test('restores the same projection from a new store instance', async (t) => {
  const directory = await temporaryState(t)
  const firstStore = createJsonEventStore({ rootDirectory: directory })
  await firstStore.createRun(samplePlan())
  await firstStore.appendNodeEvent('run-1', 'intake', { type: 'DEPENDENCIES_RESOLVED' })

  const beforeRestart = await firstStore.getRun('run-1')
  const restartedStore = createJsonEventStore({ rootDirectory: directory })
  const afterRestart = await restartedStore.getRun('run-1')

  assert.deepEqual(afterRestart.projection, beforeRestart.projection)
})

test('does not persist an invalid transition', async (t) => {
  const directory = await temporaryState(t)
  const store = createJsonEventStore({ rootDirectory: directory })
  const created = await store.createRun(samplePlan())
  const before = await readFile(created.filePath, 'utf8')

  const result = await store.appendNodeEvent('run-1', 'intake', {
    type: 'NODE_SUCCEEDED',
  })
  const after = await readFile(created.filePath, 'utf8')

  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'INVALID_TRANSITION')
  assert.equal(after, before)
})

test('rejects duplicate run ids and unknown nodes', async (t) => {
  const directory = await temporaryState(t)
  const store = createJsonEventStore({ rootDirectory: directory })
  await store.createRun(samplePlan())

  const duplicate = await store.createRun(samplePlan())
  const unknownNode = await store.appendNodeEvent('run-1', 'missing', {
    type: 'NODE_STARTED',
  })

  assert.equal(duplicate.error.code, 'RUN_ALREADY_EXISTS')
  assert.equal(unknownNode.error.code, 'NODE_NOT_FOUND')
})

test('rejects unsafe run ids', async (t) => {
  const directory = await temporaryState(t)
  const store = createJsonEventStore({ rootDirectory: directory })
  const result = await store.createRun(samplePlan('../outside'))

  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'INVALID_RUN_ID')
})

test('deduplicates an event by idempotency key', async (t) => {
  const directory = await temporaryState(t)
  const store = createJsonEventStore({ rootDirectory: directory })
  await store.createRun(samplePlan())

  const first = await store.appendNodeEvent('run-1', 'intake', {
    type: 'DEPENDENCIES_RESOLVED',
    idempotencyKey: 'run-1/intake/ready',
  })
  const duplicate = await store.appendNodeEvent('run-1', 'intake', {
    type: 'DEPENDENCIES_RESOLVED',
    idempotencyKey: 'run-1/intake/ready',
  })

  assert.equal(first.ok, true)
  assert.equal(duplicate.ok, true)
  assert.equal(duplicate.deduplicated, true)
  assert.equal(duplicate.projection.lastSequence, first.projection.lastSequence)
})

test('projects active execution and attempt count for recovery', async (t) => {
  const directory = await temporaryState(t)
  const store = createJsonEventStore({ rootDirectory: directory })
  await store.createRun(samplePlan())
  await store.appendNodeEvent('run-1', 'intake', { type: 'DEPENDENCIES_RESOLVED' })
  await store.appendNodeEvent('run-1', 'intake', {
    type: 'NODE_STARTED',
    attemptId: 'attempt-1',
    idempotencyKey: 'run-1/intake/attempt-1/start',
  })

  const restored = await store.getRun('run-1')

  assert.equal(restored.projection.attempts.intake, 1)
  assert.equal(restored.projection.activeExecutions.intake.attemptId, 'attempt-1')
})
