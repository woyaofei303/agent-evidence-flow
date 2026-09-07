import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createFileLeaseManager } from '../src/lease-manager.mjs'
import { createRepositoryWriterLock } from '../src/repository-writer-lock.mjs'
import { createSedimentAdapter, decideSediment } from '../src/sediment-adapter.mjs'

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'workflow-sediment-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

function plan({ taskId = 'task-1', sediment = 'required', signals = [] } = {}) {
  return {
    runId: taskId,
    context: { taskId, request: 'Implement workflow', sediment, signals, changedFiles: ['src/a.js'] },
  }
}

test('uses deterministic three-state sediment decisions without scores', () => {
  assert.equal(decideSediment(plan({ sediment: 'skip' }).context, {}).decision, 'skip')
  assert.equal(
    decideSediment(plan().context, { summary: 'done', verification: ['ok'] }).decision,
    'required',
  )
  const blocked = decideSediment(
    plan({ signals: ['PRODUCTION_BUG'] }).context,
    { summary: 'fixed', verification: ['test passed'] },
  )
  assert.equal(blocked.decision, 'blocked')
  assert.deepEqual(blocked.missingFields, ['symptom', 'rootCause', 'fix', 'risk'])
})

test('does not write a file for a skip decision', async (t) => {
  const directory = await temporaryDirectory(t)
  const writerLock = createRepositoryWriterLock({
    leaseManager: createFileLeaseManager({
      rootDirectory: path.join(directory, 'leases'),
      ownerId: 'writer',
    }),
  })
  const adapter = createSedimentAdapter({
    sedimentDirectory: path.join(directory, 'records'),
    writerLock,
  })

  const result = await adapter.execute({ plan: plan({ sediment: 'skip' }) })

  assert.equal(result.status, 'succeeded')
  assert.equal(result.evidence.decision, 'skip')
  await assert.rejects(access(path.join(directory, 'records', 'task-1.md')))
})

test('writes and idempotently reconciles a required sediment record', async (t) => {
  const directory = await temporaryDirectory(t)
  const writerLock = createRepositoryWriterLock({
    leaseManager: createFileLeaseManager({
      rootDirectory: path.join(directory, 'leases'),
      ownerId: 'writer',
    }),
  })
  const details = {
    summary: 'Implemented the local workflow.',
    verification: ['pnpm test: passed'],
  }
  const adapter = createSedimentAdapter({
    sedimentDirectory: path.join(directory, 'records'),
    writerLock,
    details: () => details,
    now: () => '2026-08-20T00:00:00.000Z',
  })

  const first = await adapter.execute({ plan: plan() })
  const second = await adapter.execute({ plan: plan() })
  const reconciled = await adapter.reconcile({ plan: plan() })
  const content = await readFile(path.join(directory, 'records', 'task-1.md'), 'utf8')

  assert.equal(first.evidence.action, 'created')
  assert.equal(second.evidence.action, 'unchanged')
  assert.equal(reconciled.status, 'succeeded')
  assert.match(content, /Implemented the local workflow\./)
  assert.match(content, /pnpm test: passed/)
  assert.doesNotMatch(content, /score|weight/i)
})
