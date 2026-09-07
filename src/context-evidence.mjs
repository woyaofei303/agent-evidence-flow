import path from 'node:path'
import { z } from 'zod'

const relativePath = z.string().min(1).refine((value) => {
  const normalized = path.posix.normalize(value.replaceAll('\\', '/'))
  return !path.posix.isAbsolute(normalized) && normalized !== '.' && normalized !== '..' && !normalized.startsWith('../')
}, 'must be a repository-relative path')

const nonEmptyList = z.array(z.string().min(1)).min(1)
const base = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.string().min(1),
})

const intakeSchema = base.extend({
  kind: z.literal('intake'),
  request: z.string().min(1),
  ownedPaths: z.array(relativePath).min(1),
  acceptanceCriteria: nonEmptyList,
  assumptions: z.array(z.string().min(1)).default([]),
})

const inlinePlanSchema = base.extend({
  kind: z.literal('inline-plan'),
  goal: z.string().min(1),
  ownedPaths: z.array(relativePath).min(1),
  steps: nonEmptyList,
  acceptance: nonEmptyList,
  verification: nonEmptyList,
  risks: z.array(z.string().min(1)).default([]),
})

const structuredPlanSchema = base.extend({
  kind: z.literal('structured-plan'),
  goal: z.string().min(1),
  ownedPaths: z.array(relativePath).min(1),
  constraints: z.array(z.string().min(1)).default([]),
  tasks: z.array(z.strictObject({
    id: z.string().min(1),
    description: z.string().min(1),
    acceptance: z.string().min(1),
  })).min(1),
  verification: nonEmptyList,
  risks: z.array(z.string().min(1)).default([]),
})

const openspecSchema = base.extend({
  kind: z.literal('openspec-contract'),
  proposalPath: relativePath,
  proposalSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  behavior: nonEmptyList,
  acceptance: nonEmptyList,
  compatibility: z.array(z.string().min(1)).default([]),
})

const implementationSchema = base.extend({
  kind: z.literal('implementation'),
  summary: z.string().min(1),
  changedPaths: z.array(relativePath).min(1),
  verificationScope: nonEmptyList,
  residualRisks: z.array(z.string().min(1)).default([]),
})

const qualityAssessmentSchema = base.extend({
  kind: z.literal('quality-assessment'),
  candidateCount: z.number().int().min(2).max(5).optional(),
  selectedCandidateId: z.string().min(1).optional(),
  accuracyScore: z.number().min(0).max(1).optional(),
  candidates: z.array(z.strictObject({ id: z.string().min(1), summary: z.string().min(1) })).min(2).max(5).optional(),
  checks: z.array(z.strictObject({ criterion: z.string().min(1), passed: z.boolean(), reference: z.string().min(1), eventSequence: z.number().int().positive() })).min(1).optional(),
  threshold: z.number().min(0).max(1).optional(),
  evidence: z.array(z.strictObject({
    kind: z.enum(['retrieval', 'source-review', 'verification', 'independent-review']),
    reference: z.string().min(1),
  })).min(1),
  decision: z.enum(['accepted', 'verify-or-clarify']),
})

const commitPlanSchema = base.extend({
  kind: z.literal('atomic-commit-plan'),
  commitPlan: z.object({ schemaVersion: z.literal(1) }).passthrough(),
})

function failure(code, message, issues = []) {
  return { ok: false, error: { code, message, issues } }
}

function exactPaths(actual, expected) {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index])
}

function normalizePaths(paths) {
  return [...new Set(paths.map((value) => path.posix.normalize(value.replaceAll('\\', '/'))))].sort()
}

export function expectedImplementationPaths(context) {
  const generated = new Set([
    `openspec/changes/${context.taskId}/proposal.md`,
    ...context.changedFiles.filter((value) => /(?:^|\/)workflow-sediment\//.test(value) || /(?:^|\/)records\//.test(value)),
  ])
  return context.changedFiles.filter((value) => !generated.has(value))
}

export function validateNodeEvidence({ nodeId, evidence, context }) {
  const expectedPaths = normalizePaths(context.changedFiles)
  const parse = (schema) => {
    const result = schema.safeParse(evidence)
    return result.success
      ? { ok: true, evidence: result.data }
      : failure('EVIDENCE_SCHEMA_INVALID', `Invalid ${nodeId} evidence`, result.error.issues)
  }

  if (nodeId === 'bugfix-intake') return parse(base.extend({ kind: z.literal('bugfix-intake'),
    symptom: z.string().trim().min(1), impact: z.string().trim().min(1), rollback: z.string().trim().min(1), verificationLimits: nonEmptyList }))
  if (nodeId === 'cross-repo-parity') {
    const result = parse(base.extend({ kind: z.literal('cross-repo-parity'), repositories: z.array(z.strictObject({
      repository: z.string().trim().min(1), reference: z.string().trim().min(1), compatible: z.literal(true),
    })).min(2) }))
    if (!result.ok) return result
    const ids = result.evidence.repositories.map(item => item.repository).sort()
    if (new Set(ids).size !== ids.length || (context.affectedRepositories?.length && !exactPaths(ids, [...context.affectedRepositories].sort()))) return failure('CROSS_REPO_EVIDENCE_MISMATCH', 'Include every affected repository exactly once')
    return result
  }

  if (nodeId === 'intake') {
    const result = parse(intakeSchema)
    if (!result.ok) return result
    if (result.evidence.request !== context.request) {
      return failure('INTAKE_REQUEST_MISMATCH', 'Intake evidence must preserve the registered request')
    }
    if (!exactPaths(normalizePaths(result.evidence.ownedPaths), expectedPaths)) {
      return failure('INTAKE_OWNED_PATHS_MISMATCH', 'Intake evidence must declare exactly the Run owned paths')
    }
    return result
  }

  if (nodeId === 'openspec-contract') {
    const result = parse(openspecSchema)
    if (!result.ok) return result
    const expected = `openspec/changes/${context.taskId}/proposal.md`
    return result.evidence.proposalPath === expected
      ? result
      : failure('OPENSPEC_PATH_MISMATCH', `OpenSpec proposalPath must be ${expected}`)
  }

  if (nodeId === 'planning') {
    const schema = context.planningMode === 'inline'
      ? inlinePlanSchema
      : context.planningMode === 'structured'
        ? structuredPlanSchema
        : structuredPlanSchema
    const result = parse(schema)
    if (!result.ok) return result
    if (!exactPaths(normalizePaths(result.evidence.ownedPaths), expectedPaths)) {
      return failure('PLAN_OWNED_PATHS_MISMATCH', 'Planning evidence must declare exactly the Run owned paths')
    }
    return result
  }

  if (nodeId === 'implementation') {
    const result = parse(implementationSchema)
    if (!result.ok) return result
    const allowed = new Set(normalizePaths(context.changedFiles))
    const changedPaths = normalizePaths(result.evidence.changedPaths)
    if (changedPaths.some((value) => !allowed.has(value))) {
      return failure('IMPLEMENTATION_PATH_OUT_OF_SCOPE', 'Implementation evidence contains a path outside the Run owned paths')
    }
    return result
  }

  if (nodeId === 'quality-assessment') {
    const result = parse(qualityAssessmentSchema)
    if (!result.ok) return result
    const gate = context.qualityGate
    if (!gate?.enabled) return failure('QUALITY_GATE_NOT_ENABLED', 'Quality assessment is not part of this Run')
    if (result.evidence.candidateCount !== undefined && result.evidence.candidateCount !== gate.candidateCount) {
      return failure('QUALITY_GATE_POLICY_MISMATCH', 'Candidate comparison must preserve the Run candidate count')
    }
    const checks = result.evidence.checks
    if (checks) {
      const expected = context.acceptanceCriteria ?? []
      const actual = checks.map((check) => check.criterion)
      if (new Set(actual).size !== actual.length || !exactPaths([...actual].sort(), [...expected].sort())) {
        return failure('QUALITY_ACCEPTANCE_MISMATCH', 'Quality checks must cover every registered acceptance criterion exactly once')
      }
    }
    const accepted = Boolean(checks?.length && checks.every((check) => check.passed))
    if ((result.evidence.decision === 'accepted') !== accepted) {
      return failure('QUALITY_GATE_DECISION_INVALID', 'Accepted requires every registered acceptance check to pass')
    }
    if (accepted && gate.compareCandidates !== false) {
      const candidates = result.evidence.candidates ?? []
      if (!checks || candidates.length !== gate.candidateCount || new Set(candidates.map((candidate) => candidate.id)).size !== candidates.length || !candidates.some((candidate) => candidate.id === result.evidence.selectedCandidateId)) {
        return failure('QUALITY_ACCEPTANCE_REQUIRED', 'Acceptance requires checks and distinct documented candidates')
      }
    }
    delete result.evidence.accuracyScore
    delete result.evidence.threshold
    return result
  }

  if (nodeId === 'atomic-commit-plan') return parse(commitPlanSchema)
  return { ok: true, evidence }
}
