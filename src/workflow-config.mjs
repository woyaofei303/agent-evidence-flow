import path from 'node:path'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import {
  DEFAULT_EXECUTION_POLICY,
  DEFAULT_PLANNING_POLICY,
} from './planning-policy.mjs'
import { DEFAULT_QUALITY_POLICY } from './quality-policy.mjs'
import { DEFAULT_EVIDENCE_ROUTING_POLICY } from './evidence-routing-policy.mjs'

const commandSchema = z.strictObject({
  file: z.string().min(1),
  args: z.array(z.string()).default([]),
  timeoutMs: z.number().int().positive().default(120_000),
  coverage: z.enum(['behavior', 'build', 'static']).optional(),
})

const verificationSchema = z.union([commandSchema, z.strictObject({
  checks: z.array(commandSchema.extend({ id: z.string().min(1) })).min(1).max(20)
    .refine((checks) => new Set(checks.map((check) => check.id)).size === checks.length, 'Check ids must be unique'),
})])

const governanceSchema = z.strictObject({
  remotePatterns: z.array(z.string().min(1)).default([]),
  canonicalRemote: z.string().min(1).default('origin'),
  matchAllRemotes: z.boolean().default(false),
  protectedBranches: z.array(z.string().min(1)).default([]),
  commands: z.record(z.string().min(1), commandSchema.nullable()).default({}),
}).default({
  remotePatterns: [],
  canonicalRemote: 'origin',
  matchAllRemotes: false,
  protectedBranches: [],
  commands: {},
})

const planningPolicySchema = z.strictObject({
  defaultMode: z.enum(['inline', 'structured', 'openspec']).default('inline'),
  structuredSignals: z.array(z.string().min(1)).default([...DEFAULT_PLANNING_POLICY.structuredSignals]),
  openspecSignals: z.array(z.string().min(1)).default([...DEFAULT_PLANNING_POLICY.openspecSignals]),
}).default({
  defaultMode: DEFAULT_PLANNING_POLICY.defaultMode,
  structuredSignals: [...DEFAULT_PLANNING_POLICY.structuredSignals],
  openspecSignals: [...DEFAULT_PLANNING_POLICY.openspecSignals],
})

const executionPolicySchema = z.strictObject({
  defaultMode: z.enum(['single-pass', 'loop']).default('single-pass'),
  loopTriggerSignals: z.array(z.string().min(1)).default([...DEFAULT_EXECUTION_POLICY.loopTriggerSignals]),
  loopBlockedSignals: z.array(z.string().min(1)).default([...DEFAULT_EXECUTION_POLICY.loopBlockedSignals]),
  maxIterations: z.number().int().min(1).max(20).default(DEFAULT_EXECUTION_POLICY.maxIterations),
  noProgressLimit: z.number().int().min(1).max(5).default(DEFAULT_EXECUTION_POLICY.noProgressLimit),
  timeBudgetMinutes: z.number().int().min(1).max(1440).default(DEFAULT_EXECUTION_POLICY.timeBudgetMinutes),
}).default({
  defaultMode: DEFAULT_EXECUTION_POLICY.defaultMode,
  loopTriggerSignals: [...DEFAULT_EXECUTION_POLICY.loopTriggerSignals],
  loopBlockedSignals: [...DEFAULT_EXECUTION_POLICY.loopBlockedSignals],
  maxIterations: DEFAULT_EXECUTION_POLICY.maxIterations,
  noProgressLimit: DEFAULT_EXECUTION_POLICY.noProgressLimit,
  timeBudgetMinutes: DEFAULT_EXECUTION_POLICY.timeBudgetMinutes,
})

const qualityPolicySchema = z.strictObject({
  enabled: z.boolean().default(DEFAULT_QUALITY_POLICY.enabled),
  highRiskSignals: z.array(z.string().min(1)).default([...DEFAULT_QUALITY_POLICY.highRiskSignals]),
  negativeFeedbackSignals: z.array(z.string().min(1)).default([...DEFAULT_QUALITY_POLICY.negativeFeedbackSignals]),
  candidateCount: z.number().int().min(2).max(5).default(DEFAULT_QUALITY_POLICY.candidateCount),
  accuracyThreshold: z.number().min(0).max(1).default(DEFAULT_QUALITY_POLICY.accuracyThreshold),
}).default({
  enabled: DEFAULT_QUALITY_POLICY.enabled,
  highRiskSignals: [...DEFAULT_QUALITY_POLICY.highRiskSignals],
  negativeFeedbackSignals: [...DEFAULT_QUALITY_POLICY.negativeFeedbackSignals],
  candidateCount: DEFAULT_QUALITY_POLICY.candidateCount,
  accuracyThreshold: DEFAULT_QUALITY_POLICY.accuracyThreshold,
})

const capabilitySchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  kind: z.enum(['local', 'mcp']),
  access: z.enum(['read', 'write']),
  enabled: z.boolean().default(true),
  costUnits: z.number().int().min(0).max(1000).default(0),
  timeoutMs: z.number().int().positive().max(600_000).default(30_000),
  command: commandSchema.optional(),
})

const evidenceRoutingPolicySchema = z.strictObject({
  version: z.literal(1).default(DEFAULT_EVIDENCE_ROUTING_POLICY.version),
  localFirst: z.boolean().default(DEFAULT_EVIDENCE_ROUTING_POLICY.localFirst),
  maxMcpCallsPerRun: z.number().int().min(0).max(100).default(DEFAULT_EVIDENCE_ROUTING_POLICY.maxMcpCallsPerRun),
  maxCostUnitsPerRun: z.number().int().min(0).max(100_000).default(DEFAULT_EVIDENCE_ROUTING_POLICY.maxCostUnitsPerRun),
  cache: z.boolean().default(DEFAULT_EVIDENCE_ROUTING_POLICY.cache),
  capabilities: z.array(capabilitySchema).default([]),
}).superRefine((value, context) => {
  const seen = new Set()
  for (const [index, capability] of value.capabilities.entries()) {
    if (seen.has(capability.id)) context.addIssue({ code: 'custom', path: ['capabilities', index, 'id'], message: 'Capability id must be unique' })
    seen.add(capability.id)
    if (capability.access === 'write' && capability.enabled) context.addIssue({ code: 'custom', path: ['capabilities', index, 'enabled'], message: 'Write capabilities must be disabled at initialization' })
  }
}).default({ ...DEFAULT_EVIDENCE_ROUTING_POLICY, capabilities: [] })

const singleRepositorySchema = z.strictObject({
  schemaVersion: z.literal(1),
  projectName: z.string().min(1),
  workflowDefinition: z.string().min(1),
  stateDirectory: z.string().min(1),
  sedimentDirectory: z.string().min(1),
  verification: verificationSchema,
  planningPolicy: planningPolicySchema,
  executionPolicy: executionPolicySchema,
  qualityPolicy: qualityPolicySchema,
  evidenceRoutingPolicy: evidenceRoutingPolicySchema,
})

const workspaceSchema = z.strictObject({
  schemaVersion: z.literal(2),
  mode: z.literal('workspace'),
  workspaceName: z.string().min(1),
  workflowDefinition: z.string().min(1),
  stateDirectory: z.string().min(1),
  planningPolicy: planningPolicySchema,
  executionPolicy: executionPolicySchema,
  repositories: z.array(z.strictObject({
    id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
    projectName: z.string().min(1),
    stacks: z.array(z.string().min(1)).default([]),
    path: z.string().min(1),
    legacyWorkflowStatus: z.literal('inactive').default('inactive'),
    legacyWorkflowEntrypoints: z.array(z.string()).default([]),
    sedimentDirectory: z.string().min(1),
    verification: verificationSchema,
    qualityPolicy: qualityPolicySchema,
    evidenceRoutingPolicy: evidenceRoutingPolicySchema,
  })).min(1),
}).superRefine((value, context) => {
  for (const field of ['id', 'path']) {
    const seen = new Set()
    for (const [index, repository] of value.repositories.entries()) {
      if (seen.has(repository[field])) {
        context.addIssue({
          code: 'custom',
          path: ['repositories', index, field],
          message: `Duplicate repository ${field}: ${repository[field]}`,
        })
      }
      seen.add(repository[field])
    }
  }
})

function resolveInside(repositoryDirectory, candidate, field) {
  if (path.isAbsolute(candidate)) {
    throw new Error(`${field} must be repository-relative`)
  }
  const root = path.resolve(repositoryDirectory)
  const resolved = path.resolve(root, candidate)
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`${field} escapes the repository`)
  }
  return resolved
}

function schemaErrors(error) {
  return {
    ok: false,
    errors: error.issues.map((issue) => ({
      code: 'CONFIG_SCHEMA_ERROR',
      path: issue.path.join('.'),
      message: issue.message,
    })),
  }
}

export function loadWorkflowConfig(yamlSource, repositoryDirectory, { repositoryId } = {}) {
  let raw
  try {
    raw = parseYaml(yamlSource)
  } catch (error) {
    return { ok: false, errors: [{ code: 'CONFIG_YAML_ERROR', message: error.message }] }
  }
  const isV3 = raw?.schemaVersion === 3
  const isWorkspace = raw?.schemaVersion === 2 || raw?.mode === 'workspace'
  let governance = null
  let workspaceGovernance = new Map()
  let configSource = raw
  if (isV3) {
    const governanceResult = governanceSchema.safeParse(raw.governance ?? {})
    if (!governanceResult.success) return schemaErrors(governanceResult.error)
    governance = governanceResult.data
    const repositories = Array.isArray(raw.repositories)
      ? raw.repositories.map((repository) => {
          const result = governanceSchema.safeParse(repository.governance ?? {})
          if (!result.success) throw result.error
          workspaceGovernance.set(repository.id, result.data)
          const { governance: _governance, ...legacyRepository } = repository
          return legacyRepository
        })
      : undefined
    const { governance: _governance, schemaVersion: _schemaVersion, repositories: _repositories, ...legacy } = raw
    configSource = {
      ...legacy,
      schemaVersion: raw.mode === 'workspace' ? 2 : 1,
      ...(repositories ? { repositories } : {}),
    }
  }
  const parsed = ((isWorkspace || (isV3 && raw.mode === 'workspace'))
    ? workspaceSchema
    : singleRepositorySchema).safeParse(configSource)
  if (!parsed.success) return schemaErrors(parsed.error)

  try {
    if (isWorkspace) {
      const workspaceDirectory = path.resolve(repositoryDirectory)
      const workflowDefinition = resolveInside(
        workspaceDirectory,
        parsed.data.workflowDefinition,
        'workflowDefinition',
      )
      const stateDirectory = resolveInside(
        workspaceDirectory,
        parsed.data.stateDirectory,
        'stateDirectory',
      )
      const repositories = parsed.data.repositories.map((repository) => {
        const childDirectory = resolveInside(
          workspaceDirectory,
          repository.path,
          `repositories.${repository.id}.path`,
        )
        return {
          ...repository,
          repositoryDirectory: childDirectory,
          sedimentDirectory: resolveInside(
            childDirectory,
            repository.sedimentDirectory,
            `repositories.${repository.id}.sedimentDirectory`,
          ),
        }
      })
      const workspace = {
        schemaVersion: isV3 ? 3 : 2,
        mode: 'workspace',
        workspaceName: parsed.data.workspaceName,
        workspaceDirectory,
        workflowDefinition,
        stateDirectory,
        repositories,
      }
      if (!repositoryId) return { ok: true, mode: 'workspace', workspace, config: null, errors: [] }
      const selected = repositories.find((repository) => repository.id === repositoryId)
      if (!selected) {
        return {
          ok: false,
          errors: [{
            code: 'WORKSPACE_REPOSITORY_NOT_FOUND',
            message: `Unknown workspace repository: ${repositoryId}`,
            availableRepositories: repositories.map((repository) => repository.id),
          }],
        }
      }
      return {
        ok: true,
        mode: 'workspace',
        workspace,
        config: {
          schemaVersion: isV3 ? 3 : 2,
          projectName: selected.projectName,
          repositoryId: selected.id,
          workspace,
          repositoryDirectory: selected.repositoryDirectory,
          workflowDefinition,
          stateDirectory: path.join(stateDirectory, selected.id),
          sedimentDirectory: selected.sedimentDirectory,
          verification: selected.verification,
          planningPolicy: parsed.data.planningPolicy,
          executionPolicy: parsed.data.executionPolicy,
          qualityPolicy: selected.qualityPolicy,
          evidenceRoutingPolicy: selected.evidenceRoutingPolicy,
          governance: isV3 ? workspaceGovernance.get(selected.id) : undefined,
        },
        errors: [],
      }
    }
    return {
      ok: true,
      mode: 'single',
      config: {
        ...parsed.data,
        ...(isV3 ? { schemaVersion: 3 } : {}),
        ...(isV3 ? { governance } : {}),
        repositoryDirectory: path.resolve(repositoryDirectory),
        workflowDefinition: resolveInside(repositoryDirectory, parsed.data.workflowDefinition, 'workflowDefinition'),
        stateDirectory: resolveInside(repositoryDirectory, parsed.data.stateDirectory, 'stateDirectory'),
        sedimentDirectory: resolveInside(repositoryDirectory, parsed.data.sedimentDirectory, 'sedimentDirectory'),
      },
      errors: [],
    }
  } catch (error) {
    return { ok: false, errors: [{ code: 'CONFIG_PATH_ERROR', message: error.message }] }
  }
}
