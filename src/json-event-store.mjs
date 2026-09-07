import { mkdir, open, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { deriveRunStatus } from './workflow-graph.mjs'
import { transitionNode } from './node-state-machine.mjs'

function storeError(code, message, details = {}) {
  return { ok: false, error: { code, message, ...details } }
}

function safeRunId(runId) {
  return typeof runId === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(runId)
}

async function readJson(filePath) {
  try {
    return { ok: true, value: JSON.parse(await readFile(filePath, 'utf8')) }
  } catch (error) {
    if (error.code === 'ENOENT') {
      return storeError('RUN_NOT_FOUND', `Run file does not exist: ${filePath}`)
    }
    return storeError('RUN_READ_ERROR', error.message)
  }
}

async function writeJsonAtomically(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  const handle = await open(temporaryPath, 'wx', 0o600)

  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }

  await rename(temporaryPath, filePath)
}

export function projectRun(record) {
  const nodeStates = Object.fromEntries(record.plan.nodes.map((node) => [node.id, 'pending']))
  const attempts = Object.fromEntries(record.plan.nodes.map((node) => [node.id, 0]))
  const activeExecutions = {}

  for (const event of record.events) {
    if (event.type === 'RUN_REPAIR_REQUESTED') {
      for (const nodeId of event.evidence.invalidatedNodes) {
        nodeStates[nodeId] = 'pending'
        delete activeExecutions[nodeId]
      }
    }
    if (event.type !== 'NODE_TRANSITIONED') continue
    nodeStates[event.nodeId] = event.nextState

    if (event.eventType === 'NODE_STARTED') {
      attempts[event.nodeId] += 1
      activeExecutions[event.nodeId] = {
        attemptId: event.attemptId ?? `${event.nodeId}-attempt-${attempts[event.nodeId]}`,
        idempotencyKey: event.idempotencyKey,
        startedAt: event.at,
        sequence: event.sequence,
      }
    } else if (['NODE_SUCCEEDED', 'NODE_FAILED', 'NODE_WAITING', 'NODE_CANCELLED'].includes(event.eventType)) {
      delete activeExecutions[event.nodeId]
    }
  }

  const statusResult = deriveRunStatus({ nodes: record.plan.nodes }, nodeStates)

  return {
    runId: record.runId,
    version: record.version,
    planHash: record.plan.planHash,
    status: statusResult.ok ? statusResult.status : 'invalid',
    nodeStates,
    attempts,
    activeExecutions,
    lastSequence: record.events.at(-1)?.sequence ?? 0,
  }
}

export function createJsonEventStore({ rootDirectory, now = () => new Date().toISOString() }) {
  const runsDirectory = path.resolve(rootDirectory, 'runs')
  const logsDirectory = path.resolve(rootDirectory, 'logs')

  async function compactEvidence(value) {
    if (!value || typeof value !== 'object') return value
    if (Array.isArray(value)) return Promise.all(value.map(compactEvidence))
    const output = {}
    for (const [key, item] of Object.entries(value)) {
      if (['stdout', 'stderr'].includes(key) && typeof item === 'string' && Buffer.byteLength(item) > 2048) {
        const sha256 = createHash('sha256').update(item).digest('hex')
        await mkdir(logsDirectory, { recursive: true })
        await writeFile(path.join(logsDirectory, `${sha256}.log`), item, { flag: 'wx', mode: 0o600 }).catch(error => { if (error.code !== 'EEXIST') throw error })
        output[key] = item.slice(0, 1024)
        output[`${key}Log`] = { sha256, bytes: Buffer.byteLength(item), path: `logs/${sha256}.log` }
      } else output[key] = await compactEvidence(item)
    }
    return output
  }

  async function readLog(sha256, { offset = 0, limit = 16000 } = {}) {
    if (!/^[a-f0-9]{64}$/.test(sha256 ?? '') || !Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 64000) return storeError('LOG_REQUEST_INVALID', 'Use a SHA-256 log ID, nonnegative offset and limit from 1 to 64000 characters')
    try {
      const source = await readFile(path.join(logsDirectory, `${sha256}.log`), 'utf8')
      return { ok: true, sha256, offset, text: source.slice(offset, offset + limit), nextOffset: offset + limit < source.length ? offset + limit : null }
    } catch (error) { return storeError('LOG_READ_ERROR', error.message) }
  }

  function runFile(runId) {
    return path.join(runsDirectory, `${runId}.json`)
  }

  async function createRun(plan) {
    if (!safeRunId(plan?.runId)) {
      return storeError('INVALID_RUN_ID', 'Run id contains unsupported characters')
    }

    const filePath = runFile(plan.runId)
    const existing = await readJson(filePath)
    if (existing.ok) {
      return storeError('RUN_ALREADY_EXISTS', `Run already exists: ${plan.runId}`)
    }
    if (existing.error.code !== 'RUN_NOT_FOUND') return existing

    const createdAt = now()
    const record = {
      schemaVersion: 1,
      runId: plan.runId,
      version: 1,
      createdAt,
      updatedAt: createdAt,
      plan,
      events: [
        {
          sequence: 1,
          type: 'RUN_CREATED',
          at: createdAt,
          planHash: plan.planHash,
        },
      ],
    }

    await writeJsonAtomically(filePath, record)
    return { ok: true, record, projection: projectRun(record), filePath }
  }

  async function getRun(runId) {
    if (!safeRunId(runId)) {
      return storeError('INVALID_RUN_ID', 'Run id contains unsupported characters')
    }

    const result = await readJson(runFile(runId))
    if (!result.ok) return result
    return { ok: true, record: result.value, projection: projectRun(result.value) }
  }

  async function appendNodeEvent(runId, nodeId, event) {
    const current = await getRun(runId)
    if (!current.ok) return current

    if (event?.idempotencyKey) {
      const existingEvent = current.record.events.find(
        (candidate) => candidate.idempotencyKey === event.idempotencyKey,
      )
      if (existingEvent) {
        return {
          ok: true,
          record: current.record,
          projection: current.projection,
          appendedEvent: existingEvent,
          deduplicated: true,
        }
      }
    }

    if (!current.record.plan.nodes.some((node) => node.id === nodeId)) {
      return storeError('NODE_NOT_FOUND', `Node does not exist in plan: ${nodeId}`, { nodeId })
    }

    const currentState = current.projection.nodeStates[nodeId]
    const transition = transitionNode(currentState, event)
    if (!transition.ok) return transition

    if (event.evidence) event = { ...event, evidence: await compactEvidence(event.evidence) }
    const at = now()
    const nextSequence = current.projection.lastSequence + 1
    const nextRecord = {
      ...current.record,
      version: current.record.version + 1,
      updatedAt: at,
      events: [
        ...current.record.events,
        {
          sequence: nextSequence,
          type: 'NODE_TRANSITIONED',
          at,
          nodeId,
          eventType: event.type,
          previousState: transition.transition.previousState,
          nextState: transition.transition.nextState,
          ...(event.attemptId === undefined ? {} : { attemptId: event.attemptId }),
          ...(event.idempotencyKey === undefined
            ? {}
            : { idempotencyKey: event.idempotencyKey }),
          ...(event.evidence === undefined ? {} : { evidence: event.evidence }),
          ...(event.error === undefined ? {} : { error: event.error }),
        },
      ],
    }

    await writeJsonAtomically(runFile(runId), nextRecord)
    return {
      ok: true,
      record: nextRecord,
      projection: projectRun(nextRecord),
      appendedEvent: nextRecord.events.at(-1),
    }
  }

  async function appendRunEvent(runId, event) {
    const current = await getRun(runId)
    if (!current.ok) return current

    if (event?.idempotencyKey) {
      const existingEvent = current.record.events.find(
        (candidate) => candidate.idempotencyKey === event.idempotencyKey,
      )
      if (existingEvent) {
        return { ok: true, record: current.record, projection: current.projection, appendedEvent: existingEvent, deduplicated: true }
      }
    }

    if (event.evidence) event = { ...event, evidence: await compactEvidence(event.evidence) }
    const at = now()
    const nextRecord = {
      ...current.record,
      version: current.record.version + 1,
      updatedAt: at,
      events: [...current.record.events, {
        sequence: current.projection.lastSequence + 1,
        type: event.type,
        at,
        ...(event.idempotencyKey === undefined ? {} : { idempotencyKey: event.idempotencyKey }),
        ...(event.evidence === undefined ? {} : { evidence: event.evidence }),
      }],
    }
    await writeJsonAtomically(runFile(runId), nextRecord)
    return { ok: true, record: nextRecord, projection: projectRun(nextRecord), appendedEvent: nextRecord.events.at(-1) }
  }

  async function listRuns() {
    const files = await readdir(runsDirectory).catch((error) => {
      if (error.code === 'ENOENT') return []
      throw error
    })
    const records = []
    for (const file of files.filter((file) => file.endsWith('.json')).sort()) {
      const result = await getRun(file.slice(0, -5))
      if (!result.ok) return result
      records.push(result.record)
    }
    return { ok: true, records }
  }

  return { createRun, getRun, listRuns, readLog, appendNodeEvent, appendRunEvent, runsDirectory }
}
