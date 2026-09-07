export const DEFAULT_EVIDENCE_ROUTING_POLICY = Object.freeze({
  version: 1,
  localFirst: true,
  maxMcpCallsPerRun: 0,
  maxCostUnitsPerRun: 0,
  cache: true,
  capabilities: Object.freeze([]),
})

export function resolveEvidenceRoute({ policy = DEFAULT_EVIDENCE_ROUTING_POLICY, qualityGate } = {}) {
  const local = policy.capabilities.filter((item) => item.enabled && item.kind === 'local' && item.access === 'read')
  const mcp = policy.capabilities.filter((item) => item.enabled && item.kind === 'mcp' && item.access === 'read')
  return {
    version: policy.version,
    localFirst: policy.localFirst,
    cache: policy.cache,
    budget: { maxMcpCalls: policy.maxMcpCallsPerRun, maxCostUnits: policy.maxCostUnitsPerRun },
    localCapabilities: local.map((item) => item.id),
    mcpCapabilities: mcp.map((item) => item.id),
    capabilities: policy.capabilities.map((item) => ({ id: item.id, kind: item.kind, access: item.access, enabled: item.enabled, costUnits: item.costUnits, timeoutMs: item.timeoutMs, ...(item.command ? { command: item.command } : {}) })),
    modelCandidates: qualityGate?.enabled && qualityGate.compareCandidates !== false ? qualityGate.candidateCount : 1,
    escalation: mcp.length > 0
      ? 'use registered local evidence first; invoke a registered read-only MCP capability only when local evidence is insufficient'
      : 'use local evidence first; no MCP capability is registered for this project',
  }
}

export function summarizeToolBudget(record, route) {
  const reservations = record.events.filter((event) => event.type === 'TOOL_CALL_STARTED' && Number.isInteger(event.evidence.costUnits))
  const reserved = new Set(reservations.map((event) => event.evidence.invocationId))
  const charged = [...reservations, ...record.events.filter((event) => event.type === 'TOOL_CALL_FINISHED' && !reserved.has(event.evidence.invocationId))]
  const mcpCalls = charged.filter((event) => event.evidence.kind === 'mcp').length
  const costUnits = charged.reduce((total, event) => total + event.evidence.costUnits, 0)
  return {
    mcpCalls,
    costUnits,
    remainingMcpCalls: Math.max(0, route.budget.maxMcpCalls - mcpCalls),
    remainingCostUnits: Math.max(0, route.budget.maxCostUnits - costUnits),
  }
}
