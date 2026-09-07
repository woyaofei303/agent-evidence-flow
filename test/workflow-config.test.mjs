import assert from 'node:assert/strict'
import test from 'node:test'
import { loadWorkflowConfig } from '../src/workflow-config.mjs'

const valid = `
schemaVersion: 1
projectName: sample
workflowDefinition: tooling/workflow.yaml
stateDirectory: .workflow/state
sedimentDirectory: records
verification:
  file: pnpm
  args: [test]
  timeoutMs: 1000
planningPolicy:
  defaultMode: inline
  structuredSignals: [MULTI_STEP, LONG_RUNNING_IMPLEMENTATION]
  openspecSignals: [API_CONTRACT_CHANGE]
executionPolicy:
  defaultMode: single-pass
  loopTriggerSignals: [LOOP_REQUESTED, ITERATIVE_ACCEPTANCE]
  loopBlockedSignals: [REQUIREMENT_UNCLEAR, EXTERNAL_SIDE_EFFECT]
  maxIterations: 6
  noProgressLimit: 2
  timeBudgetMinutes: 60
`

test('loads strict repository-relative workflow configuration', () => {
  const result = loadWorkflowConfig(valid, '/tmp/project')

  assert.equal(result.ok, true)
  assert.equal(result.config.stateDirectory, '/tmp/project/.workflow/state')
  assert.equal(result.config.planningPolicy.defaultMode, 'inline')
  assert.equal(result.config.executionPolicy.maxIterations, 6)
  assert.equal(result.config.qualityPolicy.enabled, false)
})

test('supplies planning and execution defaults for existing configs', () => {
  const legacyCompatible = valid
    .replace(/planningPolicy:[\s\S]*?timeBudgetMinutes: 60\n/, '')
  const result = loadWorkflowConfig(legacyCompatible, '/tmp/project')

  assert.equal(result.ok, true)
  assert.equal(result.config.planningPolicy.defaultMode, 'inline')
  assert.equal(result.config.executionPolicy.defaultMode, 'single-pass')
  assert.equal(result.config.executionPolicy.maxIterations, 6)
  assert.equal(result.config.qualityPolicy.enabled, false)
})

test('rejects paths escaping the repository and scoring fields', () => {
  const escaped = loadWorkflowConfig(valid.replace('.workflow/state', '../state'), '/tmp/project')
  const scored = loadWorkflowConfig(`${valid}\nscore: 10\nweight: 1\n`, '/tmp/project')

  assert.equal(escaped.errors[0].code, 'CONFIG_PATH_ERROR')
  assert.equal(scored.errors[0].code, 'CONFIG_SCHEMA_ERROR')
})

const workspace = `
schemaVersion: 2
mode: workspace
workspaceName: sample-workspace
workflowDefinition: tooling/ai-workflow/workflows/development-v1.yaml
stateDirectory: .workflow/state
planningPolicy:
  defaultMode: inline
  structuredSignals: [MULTI_STEP]
  openspecSignals: [CROSS_REPO]
executionPolicy:
  defaultMode: single-pass
  loopTriggerSignals: [LOOP_REQUESTED]
  loopBlockedSignals: [REQUIREMENT_UNCLEAR]
  maxIterations: 4
  noProgressLimit: 2
  timeBudgetMinutes: 30
repositories:
  - id: web
    projectName: web-console
    stacks: [Node.js, Vue]
    path: apps/web
    legacyWorkflowStatus: inactive
    legacyWorkflowEntrypoints: [.agents/, AGENTS.md workflow directives]
    sedimentDirectory: docs/workflow-sediment
    verification:
      file: pnpm
      args: [build]
      timeoutMs: 120000
  - id: api
    projectName: event-api
    stacks: [Rust]
    path: services/api
    legacyWorkflowStatus: inactive
    legacyWorkflowEntrypoints: []
    sedimentDirectory: docs/workflow-sediment
    verification:
      file: cargo
      args: [test]
      timeoutMs: 300000
`

test('loads workspace metadata without selecting a child repository', () => {
  const result = loadWorkflowConfig(workspace, '/tmp/workspace')

  assert.equal(result.ok, true)
  assert.equal(result.mode, 'workspace')
  assert.equal(result.config, null)
  assert.deepEqual(result.workspace.repositories.map((repository) => repository.id), ['web', 'api'])
  assert.deepEqual(result.workspace.repositories[0].legacyWorkflowEntrypoints, [
    '.agents/',
    'AGENTS.md workflow directives',
  ])
})

test('selects a workspace repository with central state and child-local sediment', () => {
  const result = loadWorkflowConfig(workspace, '/tmp/workspace', { repositoryId: 'api' })

  assert.equal(result.ok, true)
  assert.equal(result.config.repositoryDirectory, '/tmp/workspace/services/api')
  assert.equal(result.config.stateDirectory, '/tmp/workspace/.workflow/state/api')
  assert.equal(result.config.sedimentDirectory, '/tmp/workspace/services/api/docs/workflow-sediment')
  assert.deepEqual(result.config.verification.args, ['test'])
  assert.equal(result.config.executionPolicy.maxIterations, 4)
  assert.equal(result.config.qualityPolicy.enabled, false)
})

test('rejects unknown workspace repositories and escaping child paths', () => {
  const unknown = loadWorkflowConfig(workspace, '/tmp/workspace', { repositoryId: 'missing' })
  const escaped = loadWorkflowConfig(workspace.replace('path: apps/web', 'path: ../web'), '/tmp/workspace')

  assert.equal(unknown.errors[0].code, 'WORKSPACE_REPOSITORY_NOT_FOUND')
  assert.equal(escaped.errors[0].code, 'CONFIG_PATH_ERROR')
})

test('loads v3 governance without changing the legacy runtime contract', () => {
  const source = valid.replace('schemaVersion: 1', 'schemaVersion: 3') +
    '\ngovernance:\n' +
    '  remotePatterns: [github.com/example/governed]\n' +
    '  canonicalRemote: origin\n' +
    '  protectedBranches: [main]\n' +
    '  commands:\n' +
    '    test:\n' +
    '      file: pnpm\n' +
    '      args: [test]\n' +
    '      timeoutMs: 2000\n'
  const result = loadWorkflowConfig(source, '/tmp/project')

  assert.equal(result.ok, true)
  assert.equal(result.config.schemaVersion, 3)
  assert.equal(result.config.governance.remotePatterns[0], 'github.com/example/governed')
  assert.equal(result.config.verification.file, 'pnpm')
})

test('preserves an explicit null governance test command instead of falling back implicitly', () => {
  const source = valid.replace('schemaVersion: 1', 'schemaVersion: 3') +
    '\ngovernance:\n  commands:\n    test: null\n'
  const result = loadWorkflowConfig(source, '/tmp/project')
  assert.equal(result.ok, true)
  assert.equal(Object.hasOwn(result.config.governance.commands, 'test'), true)
  assert.equal(result.config.governance.commands.test, null)
})

test('loads v3 workspace governance on each child repository', () => {
  const source = workspace.replace('schemaVersion: 2', 'schemaVersion: 3')
    .replace(
      '    verification:\n      file: pnpm',
      '    governance:\n' +
      '      remotePatterns: [gitlab.example.com/xcenter/web]\n' +
      '      commands:\n' +
      '        test: {file: pnpm, args: [test], timeoutMs: 1000}\n' +
      '    verification:\n      file: pnpm',
    )
  const result = loadWorkflowConfig(source, '/tmp/workspace', { repositoryId: 'web' })

  assert.equal(result.ok, true)
  assert.equal(result.config.schemaVersion, 3)
  assert.equal(result.config.governance.remotePatterns[0], 'gitlab.example.com/xcenter/web')
})
