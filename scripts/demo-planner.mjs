import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { compileExecutionPlan } from '../src/planner.mjs'
import { loadWorkflowDefinition } from '../src/workflow-definition.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const workflowPath = path.join(root, 'workflows', 'development-v1.yaml')
const workflowResult = loadWorkflowDefinition(await readFile(workflowPath, 'utf8'), workflowPath)

if (!workflowResult.ok) {
  console.error(workflowResult.errors)
  process.exit(1)
}

const examples = [
  {
    taskId: 'demo-no-commit',
    request: 'Implement and verify without committing',
    sediment: 'required',
    signals: [],
    changedFiles: ['src/example.mjs'],
  },
  {
    taskId: 'demo-commit',
    request: 'Implement and create an explicitly authorized local commit',
    sediment: 'required',
    signals: ['COMMIT_REQUESTED'],
    changedFiles: ['src/example.mjs'],
  },
]

for (const context of examples) {
  const result = compileExecutionPlan(workflowResult.definition, context)
  if (!result.ok) {
    console.error(result.errors)
    process.exit(1)
  }

  console.log(`\n${context.taskId}: signals=${context.signals.join(',') || '<none>'}`)
  console.log(`plan hash: ${result.plan.planHash}`)
  for (const node of result.plan.nodes) {
    console.log(`- ${node.id} <- ${node.requires.join(', ') || '<root>'}`)
  }
}
