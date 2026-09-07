import { randomUUID } from 'node:crypto'

function writerError(code, message) {
  return { ok: false, error: { code, message } }
}

export function createRepositoryWriterLock({ leaseManager, ttlMs = 30_000 }) {
  const activeCapabilities = new Set()

  function assertHeld(capability) {
    if (!capability || !activeCapabilities.has(capability.token)) {
      return writerError(
        'WRITER_LOCK_REQUIRED',
        'A live repository writer capability is required for this operation',
      )
    }
    return { ok: true }
  }

  async function withLock(operation, callback) {
    const acquired = await leaseManager.acquire('repository-writer', {
      ttlMs,
      metadata: { operation },
    })
    if (!acquired.ok) return acquired

    const capability = Object.freeze({
      token: randomUUID(),
      operation,
      leaseToken: acquired.lease.token,
    })
    activeCapabilities.add(capability.token)
    let activeLease = acquired.lease
    const heartbeat = setInterval(async () => {
      const renewed = await leaseManager.renew(activeLease)
      if (renewed.ok) activeLease = renewed.lease
    }, Math.max(100, Math.floor(ttlMs / 3)))
    heartbeat.unref?.()

    try {
      return await callback(capability)
    } catch (error) {
      return writerError('WRITER_OPERATION_ERROR', error.message)
    } finally {
      clearInterval(heartbeat)
      activeCapabilities.delete(capability.token)
      await leaseManager.release(activeLease)
    }
  }

  return { assertHeld, withLock }
}
