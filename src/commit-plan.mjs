import { z } from 'zod'
import { normalizeRepositoryPaths } from './git-adapter.mjs'

const conventionalCommitPattern = /^(?:build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(?:\([a-z0-9._/-]+\))?!?: .+$/

const commitGroupSchema = z.strictObject({
  id: z.string().min(1).regex(/^[a-z][a-z0-9-]*$/),
  message: z.string().min(1).regex(conventionalCommitPattern, 'must be a Conventional Commit message'),
  paths: z.array(z.string().min(1)).min(1),
})

const commitPlanSchema = z.strictObject({
  schemaVersion: z.literal(1),
  runId: z.string().min(1),
  groups: z.array(commitGroupSchema).min(1),
})

function planError(code, message, details = {}) {
  return { code, message, ...details }
}

export function validateCommitPlan(rawPlan, {
  runId,
  expectedPaths = [],
  observedPaths = [],
} = {}) {
  const parsed = commitPlanSchema.safeParse(rawPlan)
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) =>
        planError('COMMIT_PLAN_SCHEMA_ERROR', issue.message, { path: issue.path.join('.') }),
      ),
    }
  }

  const errors = []
  if (parsed.data.runId !== runId) {
    errors.push(planError('COMMIT_PLAN_RUN_MISMATCH', `Expected run ${runId}, got ${parsed.data.runId}`))
  }

  const normalizedGroups = []
  const ids = new Set()
  const plannedPaths = new Set()
  for (const group of parsed.data.groups) {
    if (ids.has(group.id)) {
      errors.push(planError('DUPLICATE_COMMIT_GROUP', `Duplicate commit group: ${group.id}`))
    }
    ids.add(group.id)

    const normalized = normalizeRepositoryPaths(group.paths)
    if (!normalized.ok) {
      errors.push(planError(normalized.error.code, normalized.error.message, { groupId: group.id }))
      continue
    }
    for (const filePath of normalized.paths) {
      if (plannedPaths.has(filePath)) {
        errors.push(planError('DUPLICATE_COMMIT_PATH', `Path is assigned more than once: ${filePath}`))
      }
      plannedPaths.add(filePath)
    }
    normalizedGroups.push({ ...group, paths: normalized.paths })
  }

  const expected = normalizeRepositoryPaths(expectedPaths)
  if (!expected.ok && expectedPaths.length > 0) {
    errors.push(planError(expected.error.code, expected.error.message))
  }
  const observed = new Set(observedPaths)
  for (const filePath of expected.ok ? expected.paths : []) {
    if (!plannedPaths.has(filePath)) {
      errors.push(planError('UNPLANNED_OWNED_PATH', `Owned path is absent from commit plan: ${filePath}`))
    }
  }
  for (const filePath of plannedPaths) {
    if (!(expected.ok ? expected.paths : []).includes(filePath)) {
      errors.push(planError('PATH_OUTSIDE_TASK_SCOPE', `Planned path is outside task scope: ${filePath}`))
    }
    if (!observed.has(filePath)) {
      errors.push(planError('PLANNED_PATH_NOT_CHANGED', `Planned path has no observed change: ${filePath}`))
    }
  }

  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, plan: { ...parsed.data, groups: normalizedGroups }, errors: [] }
}
