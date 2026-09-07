import assert from 'node:assert/strict'
import test from 'node:test'
import {
  hashWorkflowDefinition,
  loadWorkflowDefinition,
} from '../src/workflow-definition.mjs'

const validYaml = `
schemaVersion: 1
id: sample-workflow
version: 1
nodes:
  - id: intake
    type: rule
  - id: complete
    type: rule
    requires: [intake]
`

test('loads and normalizes a valid workflow definition', () => {
  const result = loadWorkflowDefinition(validYaml, 'valid.yaml')

  assert.equal(result.ok, true)
  assert.equal(result.definition.id, 'sample-workflow')
  assert.deepEqual(
    result.definition.nodes.map((node) => node.id),
    ['complete', 'intake'],
  )
  assert.match(result.graphHash, /^[a-f0-9]{64}$/)
})

test('rejects malformed YAML', () => {
  const result = loadWorkflowDefinition('nodes: [', 'broken.yaml')

  assert.equal(result.ok, false)
  assert.equal(result.errors[0].code, 'YAML_PARSE_ERROR')
})

test('rejects an unknown node type', () => {
  const result = loadWorkflowDefinition(
    validYaml.replace('type: rule', 'type: unknown'),
    'unknown-type.yaml',
  )

  assert.equal(result.ok, false)
  assert.equal(result.errors[0].code, 'SCHEMA_VALIDATION_ERROR')
  assert.equal(result.errors[0].path, 'nodes.0.type')
})

test('rejects unknown fields', () => {
  const result = loadWorkflowDefinition(`${validYaml}\nunexpected: true\n`, 'strict.yaml')

  assert.equal(result.ok, false)
  assert.equal(result.errors[0].code, 'SCHEMA_VALIDATION_ERROR')
})

test('rejects a graph with a missing dependency', () => {
  const result = loadWorkflowDefinition(
    validYaml.replace('requires: [intake]', 'requires: [missing]'),
    'missing.yaml',
  )

  assert.equal(result.ok, false)
  assert.equal(result.errors[0].code, 'GRAPH_MISSING_DEPENDENCY')
})

test('produces the same hash for equivalent node and dependency order', () => {
  const first = loadWorkflowDefinition(`
schemaVersion: 1
id: stable-workflow
version: 1
nodes:
  - id: first
    type: rule
  - id: second
    type: rule
  - id: complete
    type: rule
    requires: [second, first]
`)
  const second = loadWorkflowDefinition(`
version: 1
id: stable-workflow
schemaVersion: 1
nodes:
  - type: rule
    requires:
      - first
      - second
    id: complete
  - type: rule
    id: second
  - id: first
    type: rule
`)

  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.equal(first.graphHash, second.graphHash)
})

test('changes the hash when workflow semantics change', () => {
  const original = loadWorkflowDefinition(validYaml)
  const changed = loadWorkflowDefinition(validYaml.replace('version: 1', 'version: 2'))

  assert.equal(original.ok, true)
  assert.equal(changed.ok, true)
  assert.notEqual(original.graphHash, changed.graphHash)
})

test('hash helper is deterministic', () => {
  const result = loadWorkflowDefinition(validYaml)

  assert.equal(hashWorkflowDefinition(result.definition), result.graphHash)
})
