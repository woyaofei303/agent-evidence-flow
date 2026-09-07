import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

function leaseError(code, message, details = {}) {
  return { ok: false, error: { code, message, ...details } }
}

function safeLeaseName(name) {
  return typeof name === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)
}

async function readLeaseRecord(directory) {
  try {
    return {
      ok: true,
      lease: JSON.parse(await readFile(path.join(directory, 'lease.json'), 'utf8')),
    }
  } catch (error) {
    if (error.code === 'ENOENT') return { ok: true, lease: null }
    return leaseError('LEASE_READ_ERROR', error.message)
  }
}

export function createFileLeaseManager({
  rootDirectory,
  ownerId = `${process.pid}-${randomUUID()}`,
  now = () => Date.now(),
  createToken = () => randomUUID(),
}) {
  const leasesDirectory = path.resolve(rootDirectory)

  function leaseDirectory(name) {
    return path.join(leasesDirectory, `${name}.lock`)
  }

  async function inspect(name) {
    if (!safeLeaseName(name)) {
      return leaseError('INVALID_LEASE_NAME', 'Lease name contains unsupported characters')
    }

    return readLeaseRecord(leaseDirectory(name))
  }

  async function createLease(name, options) {
    const directory = leaseDirectory(name)
    const acquiredAt = now()
    const lease = {
      name,
      token: createToken(),
      ownerId,
      acquiredAt,
      heartbeatAt: acquiredAt,
      expiresAt: acquiredAt + options.ttlMs,
      ttlMs: options.ttlMs,
      metadata: options.metadata ?? {},
    }

    await mkdir(directory)
    await writeFile(path.join(directory, 'lease.json'), `${JSON.stringify(lease, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    })
    return { ok: true, lease }
  }

  async function acquire(name, { ttlMs = 30_000, metadata = {} } = {}) {
    if (!safeLeaseName(name)) {
      return leaseError('INVALID_LEASE_NAME', 'Lease name contains unsupported characters')
    }
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      return leaseError('INVALID_LEASE_TTL', 'Lease ttlMs must be a positive number')
    }

    await mkdir(leasesDirectory, { recursive: true })

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await createLease(name, { ttlMs, metadata })
      } catch (error) {
        if (error.code !== 'EEXIST') {
          return leaseError('LEASE_ACQUIRE_ERROR', error.message)
        }
      }

      const current = await inspect(name)
      if (!current.ok) return current
      if (!current.lease) continue

      if (current.lease.expiresAt > now()) {
        return leaseError('LEASE_HELD', `Lease ${name} is held by ${current.lease.ownerId}`, {
          ownerId: current.lease.ownerId,
          expiresAt: current.lease.expiresAt,
        })
      }

      const staleDirectory = `${leaseDirectory(name)}.stale.${randomUUID()}`
      try {
        await rename(leaseDirectory(name), staleDirectory)
        await rm(staleDirectory, { recursive: true, force: true })
      } catch (error) {
        if (error.code !== 'ENOENT') {
          return leaseError('LEASE_TAKEOVER_ERROR', error.message)
        }
      }
    }

    return leaseError('LEASE_CONTENTION', `Could not acquire lease ${name}`)
  }

  async function renew(lease) {
    const current = await inspect(lease?.name)
    if (!current.ok) return current
    if (!current.lease || current.lease.token !== lease.token) {
      return leaseError('LEASE_NOT_OWNED', `Lease ${lease?.name ?? '<unknown>'} is not owned`)
    }

    const heartbeatAt = now()
    const renewed = {
      ...current.lease,
      heartbeatAt,
      expiresAt: heartbeatAt + current.lease.ttlMs,
    }
    await writeFile(
      path.join(leaseDirectory(lease.name), 'lease.json'),
      `${JSON.stringify(renewed, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    )
    return { ok: true, lease: renewed }
  }

  async function release(lease) {
    const current = await inspect(lease?.name)
    if (!current.ok) return current
    if (!current.lease || current.lease.token !== lease.token) {
      return leaseError('LEASE_NOT_OWNED', `Lease ${lease?.name ?? '<unknown>'} is not owned`)
    }

    await rm(leaseDirectory(lease.name), { recursive: true })
    return { ok: true }
  }

  return { acquire, inspect, renew, release, leasesDirectory, ownerId }
}
