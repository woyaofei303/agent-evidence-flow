import { projectRun } from './json-event-store.mjs'
import { summarizeToolBudget } from './evidence-routing-policy.mjs'

function latestEvent(record, nodeId, types) {
  return record.events.filter((event) => event.nodeId === nodeId && types.includes(event.eventType)).at(-1)
}

function counts(nodeStates) {
  return Object.values(nodeStates).reduce((output, state) => ({ ...output, [state]: (output[state] ?? 0) + 1 }), {})
}

export function summarizeEvidence(evidence) {
  if (!evidence || typeof evidence !== 'object') return null
  const result = {}
  for (const key of ['kind', 'decision', 'reason', 'message', 'summary', 'stopReason', 'iterations', 'elapsedMs', 'status']) {
    if (evidence[key] !== undefined) result[key] = typeof evidence[key] === 'string' ? evidence[key].slice(0, 320) : evidence[key]
  }
  if (evidence.error) result.error = { code: evidence.error.code, message: String(evidence.error.message ?? '').slice(0, 320) }
  if (evidence.checks) result.checks = { total: evidence.checks.length, failed: evidence.checks.filter(check => check.status !== 'succeeded').map(check => ({ id: check.id, code: check.error?.code })) }
  const logs = []
  const collect = value => {
    if (!value || typeof value !== 'object') return
    for (const [key, item] of Object.entries(value)) {
      if (['stdoutLog', 'stderrLog'].includes(key)) logs.push(item)
      else collect(item)
    }
  }
  collect(evidence)
  if (logs.length) result.logs = [...new Map(logs.map(log => [log.sha256, log])).values()].slice(0, 10)
  return result
}

function nextActions(record, projection) {
  const run = ` --run ${projection.runId}`
  if (Object.keys(projection.activeExecutions).length > 0) {
    return [{ kind: 'monitor', message: 'A node is executing; inspect the next status update before taking another action.', command: `workflow status${run} --verbose` }]
  }
  const failed = Object.entries(projection.nodeStates).find(([, state]) => state === 'failed')
  if (failed) {
    const repairable = ['implementation', 'verification', 'quality-assessment'].includes(failed[0])
    return [{ kind: 'investigate-failure', nodeId: failed[0], message: 'Inspect the failure; retry invalidates implementation and downstream evidence.', command: failed[0] === 'commit' ? `workflow reconcile${run}` : repairable ? `workflow retry${run} --node ${failed[0]} --reason "Describe the repair"` : `workflow timeline${run}` }]
  }
  const waiting = Object.entries(projection.nodeStates).find(([, state]) => state === 'waiting')
  if (waiting) {
    const dedicated = {
      'loop-execution': `workflow loop check${run} --change "Describe the change"`,
      sediment: `workflow sediment${run} --json '{}'`,
      'shadow-decision': `workflow shadow${run} --plan <plan.json> --details <sediment.json>`,
      commit: `workflow commit${run} --plan <plan.json> --yes`,
    }
    return [{ kind: 'provide-evidence', nodeId: waiting[0], message: waiting[0] === 'commit' ? 'Commit requires explicit user authorization.' : 'Supply the remaining evidence; successful submissions advance automatically.',
      command: dedicated[waiting[0]] ?? `workflow resolve${run} --node ${waiting[0]} --json '<fields>'`,
      ...(['intake', 'planning', 'implementation', 'openspec-contract', 'quality-assessment', 'bugfix-intake', 'cross-repo-parity', 'sediment', 'atomic-commit-plan'].includes(waiting[0]) ? { templateCommand: `workflow evidence${run} --node ${waiting[0]}` } : {}),
    }]
  }
  if (Object.values(projection.nodeStates).some((state) => state === 'ready')) {
    return [{ kind: 'advance', message: 'The Run has ready nodes and can advance until it needs evidence or completes.', command: `workflow resume${run}` }]
  }
  if (projection.status === 'completed') {
    return [{ kind: 'review', message: 'The Run is complete; inspect its decision and event history for handoff or audit.', command: `workflow explain${run}` }]
  }
  return []
}

function toolUsage(record) {
  const calls = record.events.filter((event) => event.type === 'TOOL_CALL_FINISHED').map((event) => event.evidence)
  const budget = summarizeToolBudget(record, record.plan.context.evidenceRoute ?? { budget: { maxMcpCalls: 0, maxCostUnits: 0 } })
  return { calls: calls.length, costUnits: budget.costUnits, adopted: calls.filter((call) => call.adopted).length }
}

export function summarizeRun(record, projection) {
  const states = projection.nodeStates
  const lastEvent = record.events.findLast(event => event.type !== 'CLI_INVOKED')
  const waiting = Object.entries(states).filter(([, state]) => state === 'waiting').map(([nodeId]) => ({
    nodeId,
    evidence: summarizeEvidence(latestEvent(record, nodeId, ['NODE_WAITING'])?.evidence),
  }))
  const failed = Object.entries(states).filter(([, state]) => state === 'failed').map(([nodeId]) => ({
    nodeId,
    error: latestEvent(record, nodeId, ['NODE_FAILED'])?.error ?? null,
    evidence: summarizeEvidence(latestEvent(record, nodeId, ['NODE_FAILED'])?.evidence),
  }))
  return {
    runId: projection.runId,
    status: projection.status,
    progress: { total: Object.keys(states).length, byState: counts(states), completed: (counts(states).succeeded ?? 0) + (counts(states).skipped ?? 0) },
    readyNodes: Object.entries(states).filter(([, state]) => state === 'ready').map(([nodeId]) => nodeId),
    activeExecutions: projection.activeExecutions,
    waiting,
    failed,
    toolUsage: toolUsage(record),
    nextActions: nextActions(record, projection),
    lastEvent: lastEvent ? { sequence: lastEvent.sequence, at: lastEvent.at, type: lastEvent.type, nodeId: lastEvent.nodeId, eventType: lastEvent.eventType, evidence: summarizeEvidence(lastEvent.evidence) } : null,
  }
}

export function explainRun(record, projection) {
  return {
    runId: projection.runId,
    planHash: projection.planHash,
    status: projection.status,
    request: record.plan.context.request,
    signals: record.plan.context.signals,
    eventGates: record.plan.context.eventGates ?? [],
    qualityGate: record.plan.context.qualityGate,
    evidenceRoute: record.plan.context.evidenceRoute,
    toolUsage: toolUsage(record),
    contextReferences: record.events
      .filter((event) => event.type === 'CONTEXT_RECORDED')
      .map((event) => ({ sequence: event.sequence, at: event.at, ...event.evidence })),
    modes: { planning: record.plan.context.planningMode, execution: record.plan.context.executionMode, reasons: record.plan.context.modeReasons },
    planningReasons: record.plan.planningReasons,
    includedNodes: record.plan.nodes.map((node) => ({ id: node.id, type: node.type, requires: node.requires, state: projection.nodeStates[node.id] })),
    skippedNodes: record.plan.skippedNodes,
  }
}

export function timelineRun(record) {
  return record.events.map((event) => ({
    sequence: event.sequence,
    at: event.at,
    type: event.type,
    nodeId: event.nodeId ?? null,
    transition: event.eventType ?? null,
    state: event.nextState ?? null,
    error: event.error ?? null,
  }))
}

export function summarizeMetrics(records, now = Date.now()) {
  const rows = records.map((record) => {
    const projection = projectRun(record)
    const verification = record.events.filter((event) => event.type === 'LOOP_ITERATION_FINISHED' ||
      (event.nodeId === 'verification' && ['NODE_SUCCEEDED', 'NODE_FAILED'].includes(event.eventType) && event.evidence?.decision !== 'skipped' && !event.evidence?.loopEventSequence))
    const first = verification[0]
    const reuse = new Map(record.events.filter((event) => event.type === 'SEDIMENT_REUSED').map((event) => [event.evidence.path, event.evidence]))
    const finishedAt = record.events.filter((event) => event.type === 'NODE_TRANSITIONED').at(-1)?.at ?? record.updatedAt
    const end = ['completed', 'failed', 'cancelled'].includes(projection.status) ? Date.parse(finishedAt) : now
    let previous = Date.parse(record.createdAt), executionMs = 0
    const running = new Set()
    for (const event of record.events) {
      const at = Math.min(end, Date.parse(event.at))
      if (running.size) executionMs += Math.max(0, at - previous)
      previous = at
      if (event.type === 'NODE_TRANSITIONED') {
        if (event.nextState === 'running') running.add(event.nodeId)
        else running.delete(event.nodeId)
      }
    }
    if (running.size) executionMs += Math.max(0, end - previous)
    const elapsedMs = Math.max(0, end - Date.parse(record.createdAt))
    return {
      runId: record.runId, status: projection.status,
      taskCategory: record.plan.context.taskCategory ?? 'unclassified',
      elapsedMs, executionMs, waitingMs: Math.max(0, elapsedMs - executionMs),
      cliCalls: record.events.filter(event => event.type === 'CLI_INVOKED').length,
      verificationAttempts: verification.length,
      firstPass: first ? (first.type === 'LOOP_ITERATION_FINISHED' ? first.evidence.outcome.status === 'succeeded' : first.eventType === 'NODE_SUCCEEDED') : null,
      repairs: record.events.filter((event) => event.type === 'RUN_REPAIR_REQUESTED').length,
      interventions: record.events.filter((event) => event.type === 'INTERVENTION_RECORDED').length,
      sedimentAdopted: [...reuse.values()].filter((item) => item.adopted).length,
      sedimentHelpful: [...reuse.values()].filter((item) => item.adopted && item.helped === true).length,
    }
  })
  const completed = rows.filter((row) => row.status === 'completed')
  const verified = rows.filter((row) => row.firstPass !== null)
  const total = (field) => rows.reduce((sum, row) => sum + row[field], 0)
  const byCategory = Object.fromEntries([...new Set(rows.map(row => row.taskCategory))].sort().map(category => {
    const group = rows.filter(row => row.taskCategory === category)
    const finished = group.filter(row => row.status === 'completed')
    const checked = group.filter(row => row.firstPass !== null)
    return [category, { runs: group.length, completed: finished.length,
      averageCompletedMs: finished.length ? finished.reduce((sum, row) => sum + row.elapsedMs, 0) / finished.length : null,
      averageWaitingMs: finished.length ? finished.reduce((sum, row) => sum + row.waitingMs, 0) / finished.length : null,
      firstPassRate: checked.length ? checked.filter(row => row.firstPass).length / checked.length : null,
      cliCalls: group.reduce((sum, row) => sum + row.cliCalls, 0) }]
  }))
  return { ok: true, runs: rows.length, completed: completed.length, verifiedRuns: verified.length,
    byCategory, byStatus: counts(Object.fromEntries(rows.map(row => [row.runId, row.status]))), cliCalls: total('cliCalls'),
    firstPassRate: verified.length ? verified.filter((row) => row.firstPass).length / verified.length : null,
    averageCompletedMs: completed.length ? completed.reduce((sum, row) => sum + row.elapsedMs, 0) / completed.length : null,
    verificationAttempts: total('verificationAttempts'), repairs: total('repairs'), interventions: total('interventions'),
    sedimentAdopted: total('sedimentAdopted'), sedimentHelpful: total('sedimentHelpful'), rows }
}

export function compareMetrics(current, baseline) {
  if (!baseline?.byCategory || typeof baseline.byCategory !== 'object' || Array.isArray(baseline.byCategory)) return { ok: false, error: { code: 'METRICS_BASELINE_INVALID', message: 'Use a metrics export with byCategory as the baseline' } }
  const comparison = {}
  for (const [category, value] of Object.entries(current.byCategory)) {
    const prior = baseline.byCategory[category]
    if (!prior || !Number.isFinite(prior.completed)) continue
    const delta = field => Number.isFinite(value[field]) && Number.isFinite(prior[field]) ? value[field] - prior[field] : null
    comparison[category] = { baselineRuns: prior.runs, currentRuns: value.runs, completedDelta: delta('completed'), averageCompletedMsDelta: delta('averageCompletedMs'), averageWaitingMsDelta: delta('averageWaitingMs'), firstPassRateDelta: delta('firstPassRate') }
  }
  return { ...current, comparison }
}
