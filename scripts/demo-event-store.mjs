import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createJsonEventStore } from '../src/json-event-store.mjs'
import { compileExecutionPlan } from '../src/planner.mjs'
import { loadWorkflowDefinition } from '../src/workflow-definition.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const workflowYaml = await readFile(
  path.join(root, 'workflows', 'development-v1.yaml'),
  'utf8',
)
const definitionResult = loadWorkflowDefinition(workflowYaml, 'development-v1.yaml')

if (!definitionResult.ok) {
  console.error(definitionResult.errors)
  process.exit(1)
}

const runId = `lesson-5-${Date.now()}`
const planResult = compileExecutionPlan(definitionResult.definition, {
  taskId: runId,
  request: 'Demonstrate local event persistence',
  sediment: 'required',
  signals: [],
  changedFiles: [],
})

if (!planResult.ok) {
  console.error(planResult.errors)
  process.exit(1)
}

const stateDirectory = path.join(root, 'state')
const store = createJsonEventStore({ rootDirectory: stateDirectory })
const created = await store.createRun(planResult.plan)

if (!created.ok) {
  console.error(created.error)
  process.exit(1)
}

for (const event of [
  { type: 'DEPENDENCIES_RESOLVED' },
  { type: 'NODE_STARTED' },
  { type: 'NODE_SUCCEEDED' },
]) {
  const result = await store.appendNodeEvent(runId, 'intake', event)
  if (!result.ok) {
    console.error(result.error)
    process.exit(1)
  }
}

console.log('saved run:', created.filePath)
console.log('events written: 4 (RUN_CREATED + 3 transitions)')

const restartedStore = createJsonEventStore({ rootDirectory: stateDirectory })
const restored = await restartedStore.getRun(runId)

console.log('restored run status:', restored.projection.status)
console.log('restored intake state:', restored.projection.nodeStates.intake)
console.log('restored last sequence:', restored.projection.lastSequence)
