import { randomUUID } from 'node:crypto'
import { findRunnableNodes } from './workflow-graph.mjs'

const outcomeEvents = {
  succeeded: 'NODE_SUCCEEDED',
  failed: 'NODE_FAILED',
  waiting: 'NODE_WAITING',
}

const defaultAdapters = {
  rule: {
    idempotent: true,
    async execute({ node }) {
      return {
        status: 'succeeded',
        evidence: { kind: 'rule', message: `Rule node ${node.id} completed` },
      }
    },
  },
  manual: {
    async execute({ node }) {
      return {
        status: 'waiting',
        evidence: { kind: 'manual', message: `Manual input required for ${node.id}` },
      }
    },
  },
  agent: {
    async execute({ node }) {
      return {
        status: 'waiting',
        evidence: { kind: 'agent', message: `Agent result required for ${node.id}` },
      }
    },
  },
}

function runnerError(code, message, details = {}) {
  return { ok: false, error: { code, message, ...details } }
}

function adapterFor(node, adapters) {
  return adapters[node.id] ?? adapters[node.type] ?? defaultAdapters[node.type]
}

export function createRunner({
  store,
  adapters = {},
  leaseManager,
  leaseTtlMs = 30_000,
  createAttemptId = ({ nodeId, attempt }) => `${nodeId}-attempt-${attempt}-${randomUUID()}`,
}) {
  async function withRunLease(runId, operation) {
    if (!leaseManager) return operation()

    const acquired = await leaseManager.acquire(`run-${runId}`, {
      ttlMs: leaseTtlMs,
      metadata: { runId },
    })
    if (!acquired.ok) return acquired

    let activeLease = acquired.lease
    const heartbeat = setInterval(async () => {
      const renewed = await leaseManager.renew(activeLease)
      if (renewed.ok) activeLease = renewed.lease
    }, Math.max(100, Math.floor(leaseTtlMs / 3)))
    heartbeat.unref?.()

    try {
      return await operation()
    } finally {
      clearInterval(heartbeat)
      await leaseManager.release(activeLease)
    }
  }

  async function promoteRunnableNodes(runId) {
    const current = await store.getRun(runId)
    if (!current.ok) return current

    const runnable = findRunnableNodes(
      { nodes: current.record.plan.nodes },
      current.projection.nodeStates,
    )
    if (!runnable.ok) return { ok: false, error: runnable.errors[0] }

    for (const nodeId of runnable.nodeIds) {
      const promoted = await store.appendNodeEvent(runId, nodeId, {
        type: 'DEPENDENCIES_RESOLVED',
        idempotencyKey: `${runId}/${nodeId}/dependencies-resolved/${current.record.version}`,
      })
      if (!promoted.ok) return promoted
    }

    return store.getRun(runId)
  }

  async function recoverUnlocked(runId) {
    let current = await store.getRun(runId)
    if (!current.ok) return current
    const actions = []

    const runningNodes = current.record.plan.nodes
      .filter((node) => current.projection.nodeStates[node.id] === 'running')
      .sort((left, right) => left.id.localeCompare(right.id))

    for (const node of runningNodes) {
      const adapter = adapterFor(node, adapters)
      const execution = current.projection.activeExecutions[node.id]
      let reconciliation = { status: 'unknown' }

      if (adapter && typeof adapter.reconcile === 'function') {
        try {
          reconciliation = await adapter.reconcile({
            runId,
            node,
            plan: current.record.plan,
            execution,
          })
        } catch (error) {
          reconciliation = {
            status: 'unknown',
            error: { code: 'RECONCILE_ERROR', message: error.message },
          }
        }
      }

      if (outcomeEvents[reconciliation?.status]) {
        const reconciled = await store.appendNodeEvent(runId, node.id, {
          type: outcomeEvents[reconciliation.status],
          attemptId: execution?.attemptId,
          idempotencyKey: `${execution?.idempotencyKey ?? `${runId}/${node.id}`}/outcome`,
          evidence: reconciliation.evidence,
          error: reconciliation.error,
        })
        if (!reconciled.ok) return reconciled
        actions.push({ nodeId: node.id, action: `reconciled-${reconciliation.status}` })
        current = reconciled
        continue
      }

      const interrupted = await store.appendNodeEvent(runId, node.id, {
        type: 'NODE_FAILED',
        attemptId: execution?.attemptId,
        idempotencyKey: `${execution?.idempotencyKey ?? `${runId}/${node.id}`}/interrupted`,
        error: reconciliation?.error ?? {
          code: 'EXECUTION_INTERRUPTED',
          message: `Node ${node.id} was running when its runner stopped`,
        },
      })
      if (!interrupted.ok) return interrupted

      const attempts = interrupted.projection.attempts[node.id]
      const maxAttempts = node.retry?.maxAttempts ?? 1
      if (adapter?.idempotent === true && attempts < maxAttempts) {
        const retried = await store.appendNodeEvent(runId, node.id, {
          type: 'NODE_RETRIED',
          idempotencyKey: `${runId}/${node.id}/retry-after-${execution?.attemptId ?? attempts}`,
        })
        if (!retried.ok) return retried
        actions.push({ nodeId: node.id, action: 'retried-idempotent' })
        current = retried
      } else {
        actions.push({ nodeId: node.id, action: 'failed-safe' })
        current = interrupted
      }
    }

    const restored = await store.getRun(runId)
    return restored.ok
      ? { ...restored, actions }
      : restored
  }

  async function recover(runId) {
    return withRunLease(runId, () => recoverUnlocked(runId))
  }

  async function runNextUnlocked(runId, { signal } = {}) {
    const promoted = await promoteRunnableNodes(runId)
    if (!promoted.ok) return promoted

    const node = promoted.record.plan.nodes
      .filter((candidate) => promoted.projection.nodeStates[candidate.id] === 'ready')
      .sort((left, right) => left.id.localeCompare(right.id))[0]

    if (!node) {
      return { ok: true, progressed: false, projection: promoted.projection }
    }

    const adapter = adapterFor(node, adapters)
    if (!adapter || typeof adapter.execute !== 'function') {
      return runnerError(
        'ADAPTER_NOT_FOUND',
        `No adapter registered for node ${node.id} (${node.type})`,
      )
    }

    const attempt = promoted.projection.attempts[node.id] + 1
    const attemptId = createAttemptId({ runId, nodeId: node.id, attempt })
    const idempotencyKey = `${runId}/${node.id}/${attemptId}`
    const started = await store.appendNodeEvent(runId, node.id, {
      type: 'NODE_STARTED',
      attemptId,
      idempotencyKey: `${idempotencyKey}/start`,
    })
    if (!started.ok) return started

    let outcome
    try {
      outcome = await adapter.execute({
        runId,
        node,
        plan: started.record.plan,
        signal,
        attemptId,
        idempotencyKey,
      })
    } catch (error) {
      outcome = {
        status: 'failed',
        error: { code: 'ADAPTER_THROWN_ERROR', message: error.message },
      }
    }

    if (!outcomeEvents[outcome?.status]) {
      outcome = {
        status: 'failed',
        error: {
          code: 'INVALID_ADAPTER_RESULT',
          message: `Adapter returned unsupported status: ${String(outcome?.status)}`,
        },
      }
    }

    const completed = await store.appendNodeEvent(runId, node.id, {
      type: outcomeEvents[outcome.status],
      attemptId,
      idempotencyKey: `${idempotencyKey}/outcome`,
      evidence: outcome.evidence,
      error: outcome.error,
    })
    if (!completed.ok) return completed

    return {
      ok: true,
      progressed: true,
      nodeId: node.id,
      outcome,
      projection: completed.projection,
    }
  }

  async function runNext(runId, options = {}) {
    return withRunLease(runId, async () => {
      const recovered = await recoverUnlocked(runId)
      if (!recovered.ok) return recovered
      return runNextUnlocked(runId, options)
    })
  }

  async function runUntilBlocked(runId, { signal, maxSteps = 100 } = {}) {
    return withRunLease(runId, async () => {
      const recovered = await recoverUnlocked(runId)
      if (!recovered.ok) return recovered
      const steps = []

      for (let index = 0; index < maxSteps; index += 1) {
        const result = await runNextUnlocked(runId, { signal })
        if (!result.ok) return { ...result, steps }
        if (!result.progressed) {
          return { ok: true, steps, projection: result.projection }
        }
        steps.push({ nodeId: result.nodeId, status: result.outcome.status })
      }

      return runnerError('MAX_STEPS_EXCEEDED', `Runner exceeded ${maxSteps} steps`, { steps })
    })
  }

  return { promoteRunnableNodes, recover, runNext, runUntilBlocked }
}
