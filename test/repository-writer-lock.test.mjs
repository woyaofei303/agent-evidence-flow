import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createFileLeaseManager } from '../src/lease-manager.mjs'
import { createRepositoryWriterLock } from '../src/repository-writer-lock.mjs'

test('holds one repository writer across the complete operation', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workflow-writer-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const first = createRepositoryWriterLock({
    leaseManager: createFileLeaseManager({ rootDirectory: directory, ownerId: 'first' }),
  })
  const second = createRepositoryWriterLock({
    leaseManager: createFileLeaseManager({ rootDirectory: directory, ownerId: 'second' }),
  })

  const result = await first.withLock('outer', async (capability) => {
    assert.equal(first.assertHeld(capability).ok, true)
    const rejected = await second.withLock('competing', async () => ({ ok: true }))
    assert.equal(rejected.ok, false)
    assert.equal(rejected.error.code, 'LEASE_HELD')
    return { ok: true, value: 'done' }
  })

  assert.equal(result.value, 'done')
})

test('invalidates the writer capability after release', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workflow-writer-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const writer = createRepositoryWriterLock({
    leaseManager: createFileLeaseManager({ rootDirectory: directory, ownerId: 'writer' }),
  })
  let captured

  await writer.withLock('capture', async (capability) => {
    captured = capability
    return { ok: true }
  })

  assert.equal(writer.assertHeld(captured).error.code, 'WRITER_LOCK_REQUIRED')
})
