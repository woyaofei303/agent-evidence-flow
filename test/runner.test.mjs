import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createCommandAdapter } from '../src/command-adapter.mjs'
import { createJsonEventStore } from '../src/json-event-store.mjs'
import { createFileLeaseManager } from '../src/lease-manager.mjs'
import { createRunner } from '../src/runner.mjs'

function samplePlan(runId, nodes) {
  return {
    planVersion: 1,
    runId,
    workflow: { id: 'runner-test', version: 1 },
    context: { taskId: runId, request: 'Runner test', sediment: 'required', signals: [], changedFiles: [] },
    nodes,
    skippedNodes: [],
    planningReasons: [],
    planHash: `hash-${runId}`,
  }
}

async function setup(t, runId, nodes, adapters = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'workflow-runner-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = createJsonEventStore({ rootDirectory: directory })
  await store.createRun(samplePlan(runId, nodes))
  const leaseManager = createFileLeaseManager({
    rootDirectory: path.join(directory, 'leases'),
    ownerId: `owner-${runId}`,
  })
  return {
    store,
    runner: createRunner({ store, adapters, leaseManager }),
    leaseManager,
    directory,
  }
}

test('runs rule and command nodes to completion', async (t) => {
  const nodes = [
    { id: 'prepare', type: 'rule', requires: [] },
    { id: 'verify', type: 'command', requires: ['prepare'], timeoutMs: 1000 },
    { id: 'complete', type: 'rule', requires: ['verify'] },
  ]
  const { store, runner } = await setup(t, 'success-run', nodes, {
    verify: createCommandAdapter({
      file: process.execPath,
      args: ['-e', "process.stdout.write('ok')"],
    }),
  })

  const result = await runner.runUntilBlocked('success-run')
  const restored = await store.getRun('success-run')

  assert.equal(result.ok, true)
  assert.equal(result.projection.status, 'completed')
  assert.deepEqual(result.steps, [
    { nodeId: 'prepare', status: 'succeeded' },
    { nodeId: 'verify', status: 'succeeded' },
    { nodeId: 'complete', status: 'succeeded' },
  ])
  const evidence = restored.record.events.find(
    (event) => event.nodeId === 'verify' && event.eventType === 'NODE_SUCCEEDED',
  ).evidence
  assert.equal(evidence.stdout, 'ok')
})

test('records non-zero exit and redacts secrets', async (t) => {
  const secret = 'secret-value-123'
  const nodes = [{ id: 'verify', type: 'command', requires: [], timeoutMs: 1000 }]
  const { store, runner } = await setup(t, 'failed-run', nodes, {
    verify: createCommandAdapter({
      file: process.execPath,
      args: ['-e', `process.stderr.write('token=${secret}'); process.exit(2)`],
      secrets: [secret],
    }),
  })

  const result = await runner.runUntilBlocked('failed-run')
  const restored = await store.getRun('failed-run')
  const failedEvent = restored.record.events.find(
    (event) => event.nodeId === 'verify' && event.eventType === 'NODE_FAILED',
  )

  assert.equal(result.projection.status, 'failed')
  assert.equal(failedEvent.error.code, 'COMMAND_EXIT_NON_ZERO')
  assert.equal(JSON.stringify(failedEvent).includes(secret), false)
  assert.match(failedEvent.evidence.stderr, /\[REDACTED\]/)
})

test('records command timeout', async (t) => {
  const nodes = [{ id: 'slow', type: 'command', requires: [], timeoutMs: 30 }]
  const { store, runner } = await setup(t, 'timeout-run', nodes, {
    slow: createCommandAdapter({
      file: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 1000)'],
    }),
  })

  const result = await runner.runUntilBlocked('timeout-run')
  const restored = await store.getRun('timeout-run')
  const failedEvent = restored.record.events.find((event) => event.eventType === 'NODE_FAILED')

  assert.equal(result.projection.status, 'failed')
  assert.equal(failedEvent.error.code, 'COMMAND_TIMEOUT')
})

test('moves agent nodes to waiting without pretending they succeeded', async (t) => {
  const nodes = [{ id: 'implementation', type: 'agent', requires: [] }]
  const { runner } = await setup(t, 'waiting-run', nodes)

  const result = await runner.runUntilBlocked('waiting-run')

  assert.equal(result.ok, true)
  assert.equal(result.projection.status, 'waiting')
  assert.deepEqual(result.steps, [{ nodeId: 'implementation', status: 'waiting' }])
})

test('records command cancellation', async (t) => {
  const nodes = [{ id: 'slow', type: 'command', requires: [], timeoutMs: 2000 }]
  const { store, runner } = await setup(t, 'cancel-run', nodes, {
    slow: createCommandAdapter({
      file: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 1000)'],
    }),
  })
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 30)

  await runner.runNext('cancel-run', { signal: controller.signal })
  const restored = await store.getRun('cancel-run')
  const failedEvent = restored.record.events.find((event) => event.eventType === 'NODE_FAILED')

  assert.equal(failedEvent.error.code, 'COMMAND_CANCELLED')
})

test('reconciles a running node after restart instead of executing it twice', async (t) => {
  const nodes = [{ id: 'commit', type: 'agent', requires: [], retry: { maxAttempts: 1 } }]
  let executeCount = 0
  let reconcileCount = 0
  const adapter = {
    async execute() {
      executeCount += 1
      return { status: 'succeeded' }
    },
    async reconcile({ execution }) {
      reconcileCount += 1
      assert.equal(execution.attemptId, 'commit-attempt-1')
      return {
        status: 'succeeded',
        evidence: { kind: 'commit-reconcile', commitSha: 'abc123' },
      }
    },
  }
  const { store, runner } = await setup(t, 'reconcile-run', nodes, { commit: adapter })
  await store.appendNodeEvent('reconcile-run', 'commit', { type: 'DEPENDENCIES_RESOLVED' })
  await store.appendNodeEvent('reconcile-run', 'commit', {
    type: 'NODE_STARTED',
    attemptId: 'commit-attempt-1',
    idempotencyKey: 'reconcile-run/commit/commit-attempt-1/start',
  })

  const recovered = await runner.recover('reconcile-run')
  const restored = await store.getRun('reconcile-run')

  assert.equal(recovered.ok, true)
  assert.equal(reconcileCount, 1)
  assert.equal(executeCount, 0)
  assert.equal(restored.projection.nodeStates.commit, 'succeeded')
})

test('does not retry an interrupted non-idempotent adapter', async (t) => {
  const nodes = [{ id: 'unsafe', type: 'agent', requires: [], retry: { maxAttempts: 2 } }]
  const { store, runner } = await setup(t, 'unsafe-run', nodes, {
    unsafe: { async execute() { return { status: 'succeeded' } } },
  })
  await store.appendNodeEvent('unsafe-run', 'unsafe', { type: 'DEPENDENCIES_RESOLVED' })
  await store.appendNodeEvent('unsafe-run', 'unsafe', {
    type: 'NODE_STARTED',
    attemptId: 'unsafe-attempt-1',
  })

  const recovered = await runner.recover('unsafe-run')

  assert.equal(recovered.ok, true)
  assert.equal(recovered.actions[0].action, 'failed-safe')
  assert.equal(recovered.projection.nodeStates.unsafe, 'failed')
})

test('retries an interrupted adapter only when it declares idempotency', async (t) => {
  const nodes = [{ id: 'safe', type: 'agent', requires: [], retry: { maxAttempts: 2 } }]
  let executeCount = 0
  const { store, runner } = await setup(t, 'safe-run', nodes, {
    safe: {
      idempotent: true,
      async execute() {
        executeCount += 1
        return { status: 'succeeded' }
      },
    },
  })
  await store.appendNodeEvent('safe-run', 'safe', { type: 'DEPENDENCIES_RESOLVED' })
  await store.appendNodeEvent('safe-run', 'safe', {
    type: 'NODE_STARTED',
    attemptId: 'safe-attempt-1',
  })

  const recovered = await runner.recover('safe-run')
  const resumed = await runner.runUntilBlocked('safe-run')

  assert.equal(recovered.actions[0].action, 'retried-idempotent')
  assert.equal(resumed.projection.status, 'completed')
  assert.equal(executeCount, 1)
})

test('refuses to advance a run while another runner holds its lease', async (t) => {
  const nodes = [{ id: 'only', type: 'rule', requires: [] }]
  const { store, leaseManager, directory } = await setup(t, 'leased-run', nodes)
  const held = await leaseManager.acquire('run-leased-run', { ttlMs: 5000 })
  const competitor = createRunner({
    store,
    leaseManager: createFileLeaseManager({
      rootDirectory: path.join(directory, 'leases'),
      ownerId: 'competitor',
    }),
  })

  const result = await competitor.runNext('leased-run')

  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'LEASE_HELD')
  await leaseManager.release(held.lease)
})
