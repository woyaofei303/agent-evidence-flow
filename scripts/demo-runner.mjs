import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCommandAdapter } from '../src/command-adapter.mjs'
import { createJsonEventStore } from '../src/json-event-store.mjs'
import { createRunner } from '../src/runner.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const runId = `lesson-6-${Date.now()}`
const plan = {
  planVersion: 1,
  runId,
  workflow: { id: 'runner-demo', version: 1 },
  context: {
    taskId: runId,
    request: 'Demonstrate the local runner',
    sediment: 'required',
    signals: [],
    changedFiles: [],
  },
  nodes: [
    { id: 'prepare', type: 'rule', requires: [] },
    { id: 'verify', type: 'command', requires: ['prepare'], timeoutMs: 2000 },
    { id: 'complete', type: 'rule', requires: ['verify'] },
  ],
  skippedNodes: [],
  planningReasons: ['runner lesson'],
  planHash: 'lesson-6-plan',
}

const store = createJsonEventStore({ rootDirectory: path.join(root, 'state') })
const created = await store.createRun(plan)

if (!created.ok) {
  console.error(created.error)
  process.exit(1)
}

const runner = createRunner({
  store,
  adapters: {
    verify: createCommandAdapter({
      file: process.execPath,
      args: ['-e', "process.stdout.write('focused verification passed\\n')"],
      cwd: root,
    }),
  },
})
const result = await runner.runUntilBlocked(runId)

if (!result.ok) {
  console.error(result.error)
  process.exit(1)
}

const restored = await store.getRun(runId)
const commandEvidence = restored.record.events.find(
  (event) => event.nodeId === 'verify' && event.eventType === 'NODE_SUCCEEDED',
)?.evidence

console.log('\nRunner steps:')
for (const step of result.steps) console.log(`- ${step.nodeId}: ${step.status}`)
console.log('final run status:', result.projection.status)
console.log('command stdout:', commandEvidence?.stdout.trim())
console.log('state file is under the Git-ignored state/ directory')
