import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveEvidenceRoute, summarizeToolBudget } from '../src/evidence-routing-policy.mjs'

test('routes local evidence before registered read-only MCP capability', () => {
  const route = resolveEvidenceRoute({
    policy: { version: 1, localFirst: true, maxMcpCallsPerRun: 2, maxCostUnitsPerRun: 8, cache: true, capabilities: [
      { id: 'local-search', kind: 'local', access: 'read', enabled: true },
      { id: 'docs-read', kind: 'mcp', access: 'read', enabled: true },
      { id: 'write-unsafe', kind: 'mcp', access: 'write', enabled: false },
    ] },
    qualityGate: { enabled: true, candidateCount: 3 },
  })
  assert.deepEqual(route.localCapabilities, ['local-search'])
  assert.deepEqual(route.mcpCapabilities, ['docs-read'])
  assert.equal(route.modelCandidates, 3)
})

test('charges failed as well as successful tool calls against a Run budget', () => {
  const budget = summarizeToolBudget({ events: [
    { type: 'TOOL_CALL_FINISHED', evidence: { outcome: 'succeeded', kind: 'mcp', costUnits: 2 } },
    { type: 'TOOL_CALL_FINISHED', evidence: { outcome: 'failed', kind: 'mcp', costUnits: 3 } },
  ] }, { budget: { maxMcpCalls: 3, maxCostUnits: 8 } })
  assert.deepEqual(budget, { mcpCalls: 2, costUnits: 5, remainingMcpCalls: 1, remainingCostUnits: 3 })
})

test('charges pending reservations once even before a result is recorded', () => {
  const budget = summarizeToolBudget({ events: [
    { type: 'TOOL_CALL_STARTED', evidence: { invocationId: 'finished', kind: 'mcp', costUnits: 2 } },
    { type: 'TOOL_CALL_FINISHED', evidence: { invocationId: 'finished', kind: 'mcp', costUnits: 2 } },
    { type: 'TOOL_CALL_STARTED', evidence: { invocationId: 'interrupted', kind: 'mcp', costUnits: 3 } },
  ] }, { budget: { maxMcpCalls: 2, maxCostUnits: 5 } })
  assert.equal(budget.mcpCalls, 2)
  assert.equal(budget.remainingCostUnits, 0)
})
