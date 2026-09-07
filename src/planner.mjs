import { createHash } from 'node:crypto'
import { z } from 'zod'
import { validateGraph } from './workflow-graph.mjs'

export const planningContextSchema = z.strictObject({
  taskId: z.string().min(1),
  request: z.string().min(1),
  taskCategory: z.enum(['bugfix', 'feature', 'investigation', 'maintenance', 'unclassified']).default('unclassified'),
  sediment: z.enum(['required', 'skip']).default('required'),
  signals: z.array(z.string().min(1)).default([]),
  changedFiles: z.array(z.string().min(1)).default([]),
  affectedRepositories: z.array(z.string().min(1)).default([]),
  planningMode: z.enum(['inline', 'structured', 'openspec']).default('inline'),
  executionMode: z.enum(['single-pass', 'loop']).default('single-pass'),
  loop: z.strictObject({
    maxIterations: z.number().int().min(1).max(20),
    noProgressLimit: z.number().int().min(1).max(5),
    timeBudgetMinutes: z.number().int().min(1).max(1440),
  }).default({ maxIterations: 6, noProgressLimit: 2, timeBudgetMinutes: 60 }),
  modeReasons: z.array(z.string().min(1)).default([]),
  eventGates: z.array(z.strictObject({
    signal: z.string().min(1),
    source: z.enum(['operator', 'deterministic']),
    confidence: z.enum(['declared', 'deterministic']),
    repositories: z.array(z.string().min(1)).optional(),
  })).default([]),
  qualityGate: z.strictObject({
    enabled: z.boolean(),
    compareCandidates: z.boolean().optional(),
    candidateCount: z.number().int().min(2).max(5),
    accuracyThreshold: z.number().min(0).max(1).optional(),
    fallback: z.literal('verify-or-clarify'),
    triggers: z.array(z.strictObject({ signal: z.string().min(1), source: z.enum(['high-risk', 'negative-feedback']) })),
    reasons: z.array(z.string().min(1)),
  }).default({ enabled: false, candidateCount: 3, accuracyThreshold: 0.85, fallback: 'verify-or-clarify', triggers: [], reasons: [] }),
  evidenceRoute: z.strictObject({
    version: z.literal(1),
    localFirst: z.boolean(),
    cache: z.boolean(),
    budget: z.strictObject({ maxMcpCalls: z.number().int().min(0), maxCostUnits: z.number().int().min(0) }),
    localCapabilities: z.array(z.string().min(1)),
    mcpCapabilities: z.array(z.string().min(1)),
    capabilities: z.array(z.strictObject({ id: z.string().min(1), kind: z.enum(['local', 'mcp']), access: z.enum(['read', 'write']), enabled: z.boolean(), costUnits: z.number().int().min(0), timeoutMs: z.number().int().positive(), command: z.strictObject({ file: z.string().min(1), args: z.array(z.string()).default([]), timeoutMs: z.number().int().positive().optional(), coverage: z.enum(['behavior', 'build', 'static']).optional() }).optional() })),
    modelCandidates: z.number().int().min(1).max(5),
    escalation: z.string().min(1),
  }).default({ version: 1, localFirst: true, cache: true, budget: { maxMcpCalls: 0, maxCostUnits: 0 }, localCapabilities: [], mcpCapabilities: [], capabilities: [], modelCandidates: 1, escalation: 'no evidence routing configured' }),
  runContext: z.unknown().optional(),
  verificationChecks: z.array(z.strictObject({ id: z.string().min(1), file: z.string().min(1), args: z.array(z.string()).default([]), timeoutMs: z.number().int().positive().optional(), coverage: z.enum(['behavior', 'build', 'static']).optional() })).optional(),
})

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    )
  }
  return value
}

function hashPlan(plan) {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(plan)))
    .digest('hex')
}

function matchesCondition(node, context) {
  const condition = node.when
  if (!condition) return true

  const signals = new Set(context.signals)

  if (condition.signalsAll && !condition.signalsAll.every((signal) => signals.has(signal))) {
    return false
  }
  if (condition.signalsAny && !condition.signalsAny.some((signal) => signals.has(signal))) {
    return false
  }
  if (condition.signalsNone && condition.signalsNone.some((signal) => signals.has(signal))) {
    return false
  }

  return true
}

function resolveIncludedDependencies(nodeId, nodesById, includedIds, seen = new Set()) {
  if (seen.has(nodeId)) return []
  seen.add(nodeId)

  if (includedIds.has(nodeId)) return [nodeId]

  const node = nodesById.get(nodeId)
  if (!node) return []

  return node.requires.flatMap((dependencyId) =>
    resolveIncludedDependencies(dependencyId, nodesById, includedIds, new Set(seen)),
  )
}

function transitivelyDependsOn(nodeId, targetId, nodesById, seen = new Set()) {
  if (seen.has(nodeId)) return false
  seen.add(nodeId)

  const node = nodesById.get(nodeId)
  if (!node) return false

  return node.requires.some(
    (dependencyId) =>
      dependencyId === targetId ||
      transitivelyDependsOn(dependencyId, targetId, nodesById, seen),
  )
}

function removeRedundantDependencies(nodes) {
  const nodesById = new Map(nodes.map((node) => [node.id, node]))

  return nodes.map((node) => ({
    ...node,
    requires: node.requires.filter(
      (candidateId) =>
        !node.requires.some(
          (otherId) =>
            otherId !== candidateId &&
            transitivelyDependsOn(otherId, candidateId, nodesById),
        ),
    ),
  }))
}

function conditionReason(node, included, context) {
  if (!node.when) return 'unconditional node'
  const decision = included ? 'matched' : 'did not match'
  return `${decision}: signals=${context.signals.join(',') || '<none>'}`
}

export function compileExecutionPlan(definition, rawContext) {
  const parsedContext = planningContextSchema.safeParse(rawContext)
  if (!parsedContext.success) {
    return {
      ok: false,
      errors: parsedContext.error.issues.map((issue) => ({
        code: 'PLANNING_CONTEXT_ERROR',
        path: issue.path.join('.'),
        message: issue.message,
      })),
    }
  }

  const context = {
    ...parsedContext.data,
    signals: [...new Set(parsedContext.data.signals)].sort(),
    changedFiles: [...new Set(parsedContext.data.changedFiles)].sort(),
  }
  const nodesById = new Map(definition.nodes.map((node) => [node.id, node]))
  const includedIds = new Set(
    definition.nodes
      .filter((node) => matchesCondition(node, context))
      .map((node) => node.id),
  )

  const expandedNodes = definition.nodes
    .filter((node) => includedIds.has(node.id))
    .map((node) => {
      const requires = [
        ...new Set(
          node.requires.flatMap((dependencyId) =>
            resolveIncludedDependencies(dependencyId, nodesById, includedIds),
          ),
        ),
      ]
        .filter((dependencyId) => dependencyId !== node.id)
        .sort()

      const { when: _when, ...concreteNode } = node
      return { ...concreteNode, requires }
    })
    .sort((left, right) => left.id.localeCompare(right.id))
  const nodes = removeRedundantDependencies(expandedNodes)

  const graphValidation = validateGraph({ nodes })
  if (!graphValidation.ok) {
    return {
      ok: false,
      errors: graphValidation.errors.map((error) => ({
        ...error,
        code: `PLANNED_GRAPH_${error.code}`,
      })),
    }
  }

  const skippedNodes = definition.nodes
    .filter((node) => !includedIds.has(node.id))
    .map((node) => ({
      id: node.id,
      reason: conditionReason(node, false, context),
    }))
    .sort((left, right) => left.id.localeCompare(right.id))

  const planWithoutHash = {
    planVersion: 1,
    runId: context.taskId,
    workflow: {
      id: definition.id,
      version: definition.version,
    },
    context,
    nodes,
    skippedNodes,
    planningReasons: [
      `sediment policy: ${context.sediment}`,
      `signals: ${context.signals.join(', ') || 'none'}`,
      `planning mode: ${context.planningMode}`,
      `execution mode: ${context.executionMode}`,
      ...context.qualityGate.reasons,
      context.signals.includes('COMMIT_REQUESTED')
        ? 'explicit local commit requested'
        : 'no local commit requested',
      ...context.modeReasons,
    ],
  }

  return {
    ok: true,
    plan: {
      ...planWithoutHash,
      planHash: hashPlan(planWithoutHash),
    },
    errors: [],
  }
}
