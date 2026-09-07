import assert from 'node:assert/strict'
import test from 'node:test'
import { validateCommitPlan } from '../src/commit-plan.mjs'

const validPlan = {
  schemaVersion: 1,
  runId: 'task-1',
  groups: [
    {
      id: 'workflow-core',
      message: 'feat(workflow): add local recovery',
      paths: ['src/recovery.mjs', 'test/recovery.test.mjs'],
    },
  ],
}

test('accepts an explicit atomic commit plan for exactly owned paths', () => {
  const result = validateCommitPlan(validPlan, {
    runId: 'task-1',
    expectedPaths: ['test/recovery.test.mjs', 'src/recovery.mjs'],
    observedPaths: ['README.md', 'src/recovery.mjs', 'test/recovery.test.mjs'],
  })

  assert.equal(result.ok, true)
  assert.deepEqual(result.plan.groups[0].paths, ['src/recovery.mjs', 'test/recovery.test.mjs'])
})

test('rejects duplicate paths, missing owned paths and non-conventional messages', () => {
  const duplicate = validateCommitPlan(
    {
      ...validPlan,
      groups: [
        validPlan.groups[0],
        { id: 'duplicate', message: 'docs: duplicate', paths: ['src/recovery.mjs'] },
      ],
    },
    { runId: 'task-1', expectedPaths: validPlan.groups[0].paths, observedPaths: validPlan.groups[0].paths },
  )
  const missing = validateCommitPlan(validPlan, {
    runId: 'task-1',
    expectedPaths: [...validPlan.groups[0].paths, 'src/missing.mjs'],
    observedPaths: [...validPlan.groups[0].paths, 'src/missing.mjs'],
  })
  const message = validateCommitPlan(
    { ...validPlan, groups: [{ ...validPlan.groups[0], message: 'updated files' }] },
    { runId: 'task-1', expectedPaths: validPlan.groups[0].paths, observedPaths: validPlan.groups[0].paths },
  )

  assert.equal(duplicate.errors.some((error) => error.code === 'DUPLICATE_COMMIT_PATH'), true)
  assert.equal(missing.errors.some((error) => error.code === 'UNPLANNED_OWNED_PATH'), true)
  assert.equal(message.errors[0].code, 'COMMIT_PLAN_SCHEMA_ERROR')
})

test('strictly rejects scoring and weight fields', () => {
  const result = validateCommitPlan({ ...validPlan, score: 0.9, weight: 10 }, {
    runId: 'task-1',
    expectedPaths: validPlan.groups[0].paths,
    observedPaths: validPlan.groups[0].paths,
  })

  assert.equal(result.ok, false)
  assert.equal(result.errors[0].code, 'COMMIT_PLAN_SCHEMA_ERROR')
})
