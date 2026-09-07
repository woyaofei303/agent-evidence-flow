import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadWorkflowDefinition } from '../src/workflow-definition.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = path.join(root, 'workflows', 'lesson-3.yaml')
const yaml = await readFile(source, 'utf8')
const result = loadWorkflowDefinition(yaml, 'workflows/lesson-3.yaml')

if (!result.ok) {
  console.error(result.errors)
  process.exit(1)
}

console.log('workflow:', `${result.definition.id}@${result.definition.version}`)
console.log('schema version:', result.definition.schemaVersion)
console.log('graph hash:', result.graphHash)
console.log('normalized nodes:')

for (const node of result.definition.nodes) {
  console.log(`- ${node.id} [${node.type}] requires: ${node.requires.join(', ') || '<none>'}`)
}
