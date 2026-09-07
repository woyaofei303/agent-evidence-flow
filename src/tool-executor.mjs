import { createHash, randomUUID } from 'node:crypto'
import { createCommandAdapter, redactText } from './command-adapter.mjs'
import { summarizeToolBudget } from './evidence-routing-policy.mjs'

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const failure = (code, message) => ({ ok: false, error: { code, message } })

// The runtime holds the Run lease across reservation, execution and receipt.
export async function executeRegisteredTool({ store, runId, config, capabilityId, input = {}, purpose = '', localEvidence, cacheContext, handler, fresh = false, now = () => Date.now() }) {
  const current = await store.getRun(runId)
  if (!current.ok) return current
  const route = current.record.plan.context.evidenceRoute
  const capability = route.capabilities.find((item) => item.id === capabilityId)
  if (!capability?.enabled || capability.access !== 'read') return failure('TOOL_CAPABILITY_NOT_ALLOWED', 'Only registered read-only capabilities can execute')
  if (!capability.command && !handler) return failure('TOOL_EXECUTOR_NOT_CONFIGURED', 'Configure a fixed command for this capability')
  if (capability.kind === 'mcp' && route.localFirst && (typeof localEvidence !== 'string' || !localEvidence.trim())) {
    return failure('LOCAL_EVIDENCE_REQUIRED', 'Explain why local evidence is insufficient before calling MCP')
  }
  const inputDigest = digest(input)
  const cacheKey = digest({ capability, inputDigest, cacheContext })
  // ponytail: short-lived cache; use fresh for upstream data that changes within 30 seconds.
  const cached = !fresh && route.cache && current.record.events.findLast((event) => event.type === 'TOOL_CALL_FINISHED' && now() - Date.parse(event.at) < 30_000 && event.evidence.cacheKey === cacheKey && event.evidence.outcome === 'succeeded' && event.evidence.result)
  if (cached) return { ok: true, cached: true, result: cached.evidence.result, invocation: cached.evidence }
  const budget = summarizeToolBudget(current.record, route)
  if (capability.kind === 'mcp' && budget.remainingMcpCalls < 1) return failure('MCP_CALL_BUDGET_EXCEEDED', 'Run has exhausted its MCP call budget')
  if (capability.costUnits > budget.remainingCostUnits) return failure('TOOL_COST_BUDGET_EXCEEDED', 'Run has exhausted its tool cost budget')
  const invocation = { invocationId: randomUUID(), capabilityId, kind: capability.kind, inputDigest, cacheKey, costUnits: capability.costUnits, purpose: redactText(purpose).slice(0, 240), ...(localEvidence ? { localEvidence: redactText(localEvidence).slice(0, 600) } : {}) }
  const started = await store.appendRunEvent(runId, { type: 'TOOL_CALL_STARTED', evidence: invocation })
  if (!started.ok) return started
  const startedAt = now()
  let outcome
  try {
    outcome = handler ? await handler() : await createCommandAdapter({ ...capability.command, timeoutMs: capability.timeoutMs, cwd: config.repositoryDirectory }).execute({ node: {}, input: `${JSON.stringify(input)}\n` })
  } catch (error) {
    outcome = { status: 'failed', error: { code: 'TOOL_EXECUTION_FAILED', message: redactText(error.message) }, evidence: {} }
  }
  const result = outcome.evidence ?? {}
  const receipt = { ...invocation, resultDigest: digest(result), outcome: outcome.status, elapsedMs: Math.max(0, now() - startedAt), result, error: outcome.error }
  const finished = await store.appendRunEvent(runId, { type: 'TOOL_CALL_FINISHED', evidence: receipt })
  if (!finished.ok) return finished
  const stored = finished.appendedEvent.evidence
  return { ok: outcome.status === 'succeeded', cached: false, result: stored.result, invocation: stored, ...(outcome.error ? { error: outcome.error } : {}) }
}
