import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test, { before } from 'node:test'
import { fileURLToPath } from 'node:url'
import { compileExecutionPlan } from '../src/planner.mjs'
import { loadWorkflowDefinition } from '../src/workflow-definition.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let definition

before(async () => {
  const workflowYaml = await readFile(path.join(root, 'workflows', 'development-v1.yaml'), 'utf8')
  const workflowResult = loadWorkflowDefinition(workflowYaml, 'development-v1.yaml')
  assert.equal(workflowResult.ok, true)
  definition = workflowResult.definition
})

function context(overrides = {}) {
  return {
    taskId: 'task-1',
    request: 'Implement a local workflow change',
    sediment: 'required',
    signals: [],
    changedFiles: ['src/workflow.mjs'],
    planningMode: 'inline',
    executionMode: 'single-pass',
    loop: {
      maxIterations: 6,
      noProgressLimit: 2,
      timeBudgetMinutes: 60,
    },
    ...overrides,
  }
}

test('compiles the minimal development path without legacy ceremony nodes', () => {
  const result = compileExecutionPlan(definition, context())

  assert.equal(result.ok, true)
  assert.deepEqual(result.plan.nodes.map((node) => node.id), [
    'complete',
    'implementation',
    'intake',
    'planning',
    'sediment',
    'verification',
  ])
  assert.deepEqual(result.plan.nodes.find((node) => node.id === 'complete').requires, ['sediment'])
  assert.equal(JSON.stringify(result.plan).includes('tier'), false)
  assert.equal(JSON.stringify(result.plan).includes('score'), false)
  assert.equal(JSON.stringify(result.plan).includes('weight'), false)
})

test('adds the OpenSpec contract node only for OpenSpec planning', () => {
  const result = compileExecutionPlan(
    definition,
    context({
      planningMode: 'openspec',
      signals: ['PLANNING_OPENSPEC'],
    }),
  )

  assert.equal(result.ok, true)
  assert.deepEqual(
    result.plan.nodes.find((node) => node.id === 'planning').requires,
    ['openspec-contract'],
  )
})

test('adds bounded loop execution only in loop mode', () => {
  const result = compileExecutionPlan(
    definition,
    context({
      executionMode: 'loop',
      signals: ['EXECUTION_LOOP'],
    }),
  )

  assert.equal(result.ok, true)
  assert.deepEqual(
    result.plan.nodes.find((node) => node.id === 'verification').requires,
    ['loop-execution'],
  )
  assert.equal(result.plan.context.loop.maxIterations, 6)
})

test('adds shadow and commit nodes only after explicit commit request', () => {
  const result = compileExecutionPlan(
    definition,
    context({ signals: ['COMMIT_REQUESTED', 'COMMIT_REQUESTED'] }),
  )
  const byId = new Map(result.plan.nodes.map((node) => [node.id, node]))

  assert.deepEqual(byId.get('atomic-commit-plan').requires, ['sediment'])
  assert.deepEqual(byId.get('shadow-decision').requires, ['atomic-commit-plan'])
  assert.deepEqual(byId.get('commit').requires, ['shadow-decision'])
  assert.deepEqual(byId.get('complete').requires, ['commit'])
})

test('normalizes signal and changed-file ordering before hashing', () => {
  const first = compileExecutionPlan(
    definition,
    context({ signals: ['B', 'A'], changedFiles: ['b.ts', 'a.ts'] }),
  )
  const second = compileExecutionPlan(
    definition,
    context({ signals: ['A', 'B', 'A'], changedFiles: ['a.ts', 'b.ts'] }),
  )

  assert.equal(first.plan.planHash, second.plan.planHash)
})

test('rejects an invalid planning context', () => {
  const result = compileExecutionPlan(definition, context({ request: '', sediment: 'maybe' }))

  assert.equal(result.ok, false)
  assert.equal(result.errors[0].code, 'PLANNING_CONTEXT_ERROR')
})
