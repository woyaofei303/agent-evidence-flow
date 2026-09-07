import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createFileLeaseManager } from '../src/lease-manager.mjs'

async function temporaryState(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'workflow-lease-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

test('allows only one active owner for a lease', async (t) => {
  const directory = await temporaryState(t)
  const first = createFileLeaseManager({
    rootDirectory: directory,
    ownerId: 'runner-a',
    now: () => 1000,
  })
  const second = createFileLeaseManager({
    rootDirectory: directory,
    ownerId: 'runner-b',
    now: () => 1000,
  })

  const acquired = await first.acquire('run-example', { ttlMs: 5000 })
  const rejected = await second.acquire('run-example', { ttlMs: 5000 })

  assert.equal(acquired.ok, true)
  assert.equal(rejected.ok, false)
  assert.equal(rejected.error.code, 'LEASE_HELD')
  assert.equal(rejected.error.ownerId, 'runner-a')
})

test('takes over an expired lease without accepting the stale token', async (t) => {
  const directory = await temporaryState(t)
  let currentTime = 1000
  const first = createFileLeaseManager({
    rootDirectory: directory,
    ownerId: 'runner-a',
    now: () => currentTime,
  })
  const second = createFileLeaseManager({
    rootDirectory: directory,
    ownerId: 'runner-b',
    now: () => currentTime,
  })

  const stale = await first.acquire('run-example', { ttlMs: 100 })
  currentTime = 1200
  const replacement = await second.acquire('run-example', { ttlMs: 100 })
  const staleRelease = await first.release(stale.lease)

  assert.equal(replacement.ok, true)
  assert.equal(replacement.lease.ownerId, 'runner-b')
  assert.equal(staleRelease.ok, false)
  assert.equal(staleRelease.error.code, 'LEASE_NOT_OWNED')
})

test('renews and releases an owned lease', async (t) => {
  const directory = await temporaryState(t)
  let currentTime = 1000
  const manager = createFileLeaseManager({
    rootDirectory: directory,
    ownerId: 'runner-a',
    now: () => currentTime,
  })

  const acquired = await manager.acquire('run-example', { ttlMs: 100 })
  currentTime = 1050
  const renewed = await manager.renew(acquired.lease)
  const released = await manager.release(renewed.lease)
  const inspected = await manager.inspect('run-example')

  assert.equal(renewed.ok, true)
  assert.equal(renewed.lease.expiresAt, 1150)
  assert.equal(released.ok, true)
  assert.equal(inspected.ok, true)
  assert.equal(inspected.lease, null)
})
