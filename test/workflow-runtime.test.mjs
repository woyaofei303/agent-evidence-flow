import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { createWorkflowRuntime } from '../src/workflow-runtime.mjs'
import { buildContextIndex } from '../src/context-index.mjs'
import { createJsonEventStore } from '../src/json-event-store.mjs'
import { createCommitExecutor } from '../src/commit-executor.mjs'
import { createGitAdapter } from '../src/git-adapter.mjs'
import { createFileLeaseManager } from '../src/lease-manager.mjs'
import { createRepositoryWriterLock } from '../src/repository-writer-lock.mjs'

const workflowRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function createTask(t, overrides = {}, options = {}) {
  const repositoryDirectory = await mkdtemp(path.join(tmpdir(), 'workflow-task-'))
  t.after(() => rm(repositoryDirectory, { recursive: true, force: true }))
  await writeFile(path.join(repositoryDirectory, 'owned.txt'), 'initial\n')
  const config = {
    repositoryDirectory,
    workflowDefinition: path.join(workflowRoot, 'workflows/development-v1.yaml'),
    stateDirectory: path.join(repositoryDirectory, '.workflow/state'),
    sedimentDirectory: path.join(repositoryDirectory, 'records'),
    verification: { file: process.execPath, args: ['-e', ''], timeoutMs: 1000, coverage: 'behavior' },
    ...overrides,
  }
  const { runtime } = await createWorkflowRuntime({ config, ...options })
  return { runtime, config, repositoryDirectory }
}

async function implementTask(runtime, signals = []) {
  const started = await runtime.start({ taskId: 'task', request: 'Fix the owned behavior', changedFiles: ['owned.txt'], sediment: 'skip', signals })
  assert.equal(started.ok, true, JSON.stringify(started.error))
  for (const [nodeId, evidence] of Object.entries({
    intake: { schemaVersion: 1, kind: 'intake', request: 'Fix the owned behavior', ownedPaths: ['owned.txt'], acceptanceCriteria: ['Expected behavior'] },
    planning: { schemaVersion: 1, kind: 'inline-plan', goal: 'Fix behavior', ownedPaths: ['owned.txt'], steps: ['Fix'], acceptance: ['Expected behavior'], verification: ['configured checks'] },
    implementation: { schemaVersion: 1, kind: 'implementation', summary: 'Fixed', changedPaths: ['owned.txt'], verificationScope: ['Expected behavior'] },
  })) {
    await runtime.resume()
    const result = await runtime.resolveNode(null, nodeId, { evidence })
    assert.equal(result.ok, true, JSON.stringify(result.error))
  }
  return runtime.resume()
}

test('runtime reconciles a committed group after interruption without creating a second commit', async (t) => {
  for (const legacyFailure of [false, true]) {
    const { runtime, config, repositoryDirectory } = await createTask(t)
    const gitCommand = (...args) => execa('git', args, { cwd: repositoryDirectory })
    await gitCommand('init', '--quiet')
    await gitCommand('config', 'user.name', 'Workflow Test')
    await gitCommand('config', 'user.email', 'workflow@example.invalid')
    await gitCommand('add', 'owned.txt')
    await gitCommand('commit', '--quiet', '-m', 'test: initial')
    await writeFile(path.join(repositoryDirectory, 'owned.txt'), 'changed\n')
    await implementTask(runtime, ['COMMIT_REQUESTED'])
    await runtime.sediment(null, {})
    await runtime.resume()
    const commitPlan = { schemaVersion: 1, runId: 'task', groups: [{ id: 'fix', message: 'fix: owned behavior', paths: ['owned.txt'] }] }
    await runtime.submitEvidence(null, 'atomic-commit-plan', { commitPlan })
    await runtime.shadow(null, commitPlan, {})
    await runtime.resume()
    const store = createJsonEventStore({ rootDirectory: config.stateDirectory })
    await store.appendNodeEvent('task', 'commit', { type: 'INPUT_RECEIVED' })
    await store.appendNodeEvent('task', 'commit', { type: 'NODE_STARTED', attemptId: 'interrupted' })
    const writerLock = createRepositoryWriterLock({ leaseManager: createFileLeaseManager({ rootDirectory: path.join(config.stateDirectory, 'leases') }) })
    const executor = createCommitExecutor({ git: createGitAdapter({ repositoryDirectory, writerLock }), writerLock,
      journalDirectory: path.join(config.stateDirectory, 'commit-journals'), faults: { afterCommit() { throw new Error('receipt interrupted') } } })
    const current = await runtime.status()
    await executor.execute({ plan: current.record.plan, commitPlan, authorized: true,
      verificationEvidence: [current.record.events.findLast(event => event.nodeId === 'verification' && event.eventType === 'NODE_SUCCEEDED').evidence],
      sedimentEvidence: { decision: 'skip' } })
    if (legacyFailure) await store.appendNodeEvent('task', 'commit', { type: 'NODE_FAILED', error: { code: 'EXECUTION_INTERRUPTED', message: 'Older runner failed the interrupted node' } })
    const head = (await gitCommand('rev-parse', 'HEAD')).stdout
    const { runtime: restarted } = await createWorkflowRuntime({ config })
    const recovered = legacyFailure ? await restarted.reconcile() : await restarted.resume()
    assert.equal(recovered.projection.status, 'completed', JSON.stringify(recovered))
    assert.equal((await gitCommand('rev-parse', 'HEAD')).stdout, head)
  }
})

test('keeps rejected quality waiting and protects engine-owned nodes from resolve', async (t) => {
  const { runtime } = await createTask(t, { qualityPolicy: { enabled: true, highRiskSignals: ['HIGH_RISK_REQUEST'], negativeFeedbackSignals: [], candidateCount: 2, accuracyThreshold: 0.85 } })
  await implementTask(runtime, ['HIGH_RISK_REQUEST'])
  const result = await runtime.resolveNode(null, 'quality-assessment', { evidence: {
    schemaVersion: 1, kind: 'quality-assessment', candidateCount: 2, selectedCandidateId: 'a', accuracyScore: 0,
    threshold: 0.85, evidence: [{ kind: 'source-review', reference: 'owned.txt:1' }], decision: 'verify-or-clarify',
  } })
  assert.equal(result.projection.nodeStates['quality-assessment'], 'waiting')
  for (const nodeId of ['verification', 'sediment', 'shadow-decision', 'commit', 'complete', 'loop-execution']) {
    const blocked = await runtime.resolveNode(null, nodeId, { evidence: { message: 'done' } })
    assert.equal(blocked.error.code, 'ENGINE_OWNED_NODE', nodeId)
  }
})

test('cross-repository and production gates have consistent signals and block dependent work', async (t) => {
  for (const signal of ['CROSS_REPO', 'CROSS_REPO_AFFECTED']) {
    const { runtime } = await createTask(t)
    const result = await runtime.start({ taskId: 'cross', request: 'Change shared behavior', changedFiles: ['owned.txt'], sediment: 'skip', signals: [signal, 'PRODUCTION_BUG'] })
    assert.equal(result.record.plan.context.planningMode, 'openspec')
    const nodes = result.record.plan.nodes
    assert.ok(nodes.some(node => node.id === 'cross-repo-parity'))
    assert.ok(nodes.find(node => node.id === 'implementation').requires.includes('bugfix-intake'))
    assert.ok(nodes.find(node => node.id === 'sediment').requires.includes('cross-repo-parity'))
    await runtime.resume()
    await runtime.submitEvidence(null, 'intake', { acceptanceCriteria: ['Compatibility maintained'] })
    const invalid = await runtime.submitEvidence(null, 'bugfix-intake', {})
    assert.equal(invalid.error.code, 'EVIDENCE_SCHEMA_INVALID')
  }
})

test('workspace affected repositories require a real contract and complete parity evidence', async (t) => {
  const { runtime, repositoryDirectory } = await createTask(t, { repositoryId: 'api', workspace: { repositories: [{ id: 'api', path: 'api' }, { id: 'web', path: 'web' }] } })
  const result = await runtime.start({ taskId: 'workspace', request: 'Align behavior', changedFiles: ['owned.txt'], sediment: 'skip', affectedRepositories: ['api', 'web'] })
  assert.equal(result.record.plan.context.planningMode, 'openspec')
  assert.ok(result.record.plan.context.signals.includes('CROSS_REPO_AFFECTED'))
  await runtime.resume()
  await runtime.submitEvidence(null, 'intake', { acceptanceCriteria: ['Both repositories agree'] })
  assert.equal((await runtime.submitEvidence(null, 'openspec-contract', { behavior: ['Shared behavior'] })).error.code, 'OPENSPEC_PROPOSAL_REQUIRED')
  await mkdir(path.join(repositoryDirectory, 'openspec/changes/workspace'), { recursive: true })
  await writeFile(path.join(repositoryDirectory, 'openspec/changes/workspace/proposal.md'), '# Shared behavior\nBoth repositories agree.\n')
  await runtime.submitEvidence(null, 'openspec-contract', { behavior: ['Shared behavior'] })
  await runtime.submitEvidence(null, 'planning', { tasks: [{ id: 'align', description: 'Align implementation', acceptance: 'Both repositories agree' }] })
  await runtime.submitEvidence(null, 'implementation', { summary: 'Aligned' })
  assert.equal((await runtime.sediment(null, {})).error.code, 'NODE_NOT_READY')
  const repositories = ['api', 'web'].map(repository => ({ repository, reference: `${repository}: validated shared behavior`, compatible: true }))
  assert.equal((await runtime.submitEvidence(null, 'cross-repo-parity', { repositories: [repositories[0], repositories[0]] })).error.code, 'CROSS_REPO_EVIDENCE_MISMATCH')
  assert.equal((await runtime.submitEvidence(null, 'cross-repo-parity', { repositories })).projection.nodeStates.sediment, 'waiting')
  await runtime.sediment(null, {})
  assert.equal((await runtime.resume()).projection.status, 'completed')
})

test('resumes only the pending commit group after reconciliation', async (t) => {
  const { runtime, config, repositoryDirectory } = await createTask(t)
  const gitCommand = (...args) => execa('git', args, { cwd: repositoryDirectory })
  await gitCommand('init', '--quiet')
  await gitCommand('config', 'user.name', 'Workflow Test')
  await gitCommand('config', 'user.email', 'workflow@example.invalid')
  await writeFile(path.join(repositoryDirectory, 'other.txt'), 'initial')
  await gitCommand('add', 'owned.txt', 'other.txt')
  await gitCommand('commit', '--quiet', '-m', 'test: initial')
  for (const file of ['owned.txt', 'other.txt']) await writeFile(path.join(repositoryDirectory, file), 'changed')
  await runtime.start({ taskId: 'partial', request: 'Fix both files', changedFiles: ['owned.txt', 'other.txt'], signals: ['COMMIT_REQUESTED'], sediment: 'skip' })
  await runtime.resume()
  for (const [nodeId, evidence] of Object.entries({ intake: { acceptanceCriteria: ['Both files fixed'] }, planning: { steps: ['Fix both'] }, implementation: { summary: 'Fixed both' } })) await runtime.submitEvidence(null, nodeId, evidence)
  await runtime.sediment(null, {})
  await runtime.resume()
  const commitPlan = { schemaVersion: 1, runId: 'partial', groups: ['owned', 'other'].map(id => ({ id, message: `fix: ${id}`, paths: [`${id}.txt`] })) }
  await runtime.submitEvidence(null, 'atomic-commit-plan', { commitPlan })
  await runtime.shadow(null, commitPlan, {})
  await runtime.resume()
  const store = createJsonEventStore({ rootDirectory: config.stateDirectory })
  await store.appendNodeEvent('partial', 'commit', { type: 'INPUT_RECEIVED' })
  await store.appendNodeEvent('partial', 'commit', { type: 'NODE_STARTED', attemptId: 'partial-interruption' })
  const writerLock = createRepositoryWriterLock({ leaseManager: createFileLeaseManager({ rootDirectory: path.join(config.stateDirectory, 'leases') }) })
  const executor = createCommitExecutor({ git: createGitAdapter({ repositoryDirectory, writerLock }), writerLock, journalDirectory: path.join(config.stateDirectory, 'commit-journals'), faults: { afterCommit() { throw new Error('interrupted after first group') } } })
  const current = await runtime.status()
  await executor.execute({ plan: current.record.plan, commitPlan, authorized: true, verificationEvidence: [{}], sedimentEvidence: { decision: 'skip' } })
  const { runtime: restarted } = await createWorkflowRuntime({ config })
  assert.equal((await restarted.resume()).projection.nodeStates.commit, 'waiting')
  assert.equal((await gitCommand('rev-list', '--count', 'HEAD')).stdout, '2')
  assert.equal((await restarted.commit(null, { commitPlan, authorized: true })).outcome.status, 'succeeded')
  assert.equal((await restarted.resume()).projection.status, 'completed')
  assert.equal((await gitCommand('rev-list', '--count', 'HEAD')).stdout, '3')
})

test('repairs a failed verification in the same Run and invalidates downstream evidence', async (t) => {
  const { runtime, repositoryDirectory } = await createTask(t, { verification: { file: process.execPath, args: ['-e', "process.exit(require('fs').readFileSync('owned.txt','utf8').trim() === 'fixed' ? 0 : 1)"], timeoutMs: 1000 } })
  assert.equal((await implementTask(runtime)).projection.nodeStates.verification, 'failed')
  const repaired = await runtime.retry(null, { nodeId: 'verification', reason: 'Fix the failed assertion' })
  assert.equal(repaired.projection.nodeStates.implementation, 'waiting')
  assert.equal(repaired.projection.nodeStates.verification, 'pending')
  await writeFile(path.join(repositoryDirectory, 'owned.txt'), 'fixed\n')
  await runtime.resolveNode(null, 'implementation', { evidence: { schemaVersion: 1, kind: 'implementation', summary: 'Fixed assertion', changedPaths: ['owned.txt'], verificationScope: ['Expected behavior'] } })
  assert.equal((await runtime.resume()).projection.nodeStates.verification, 'succeeded')
  const retry = await runtime.retry(null, { nodeId: 'verification', reason: 'Code needs another adjustment' })
  assert.equal(retry.projection.nodeStates.sediment, 'pending')
})

test('runs all configured checks and rejects unattended work with only static verification', async (t) => {
  const { runtime } = await createTask(t, { verification: { checks: [
    { id: 'lint', file: process.execPath, args: ['-e', "console.log('lint')"], coverage: 'static' },
    { id: 'test', file: process.execPath, args: ['-e', 'process.exit(1)'], coverage: 'behavior' },
  ] } })
  const result = await implementTask(runtime)
  assert.equal(result.projection.nodeStates.verification, 'failed')
  const status = await runtime.status()
  const event = status.record.events.filter((item) => item.nodeId === 'verification' && item.eventType === 'NODE_FAILED').at(-1)
  assert.deepEqual(event.evidence.checks.map((check) => check.id), ['lint', 'test'])
  const { runtime: staticRuntime } = await createTask(t, { verification: { file: 'git', args: ['diff', '--check'] } })
  const blocked = await staticRuntime.start({ taskId: 'static', request: '无人值守修复本地文件', changedFiles: ['owned.txt'] })
  assert.equal(blocked.error.code, 'UNATTENDED_ELIGIBILITY_REQUIRED')
})

test('prefills evidence, advances after submission and binds accepted quality to fresh verification', async (t) => {
  const { runtime } = await createTask(t, { qualityPolicy: { enabled: true, highRiskSignals: ['HIGH_RISK_REQUEST'], negativeFeedbackSignals: [], candidateCount: 2, accuracyThreshold: 0.85 } })
  await runtime.start({ taskId: 'task', request: 'Expected behavior', changedFiles: ['owned.txt'], sediment: 'skip', signals: ['HIGH_RISK_REQUEST', 'SOLUTION_TRADEOFF'] })
  await runtime.resume()
  const draft = await runtime.evidenceTemplate(null, 'intake')
  assert.deepEqual(draft.evidence.ownedPaths, ['owned.txt'])
  assert.equal(draft.evidence.request, 'Expected behavior')
  assert.equal((await runtime.submitEvidence(null, 'intake', { acceptanceCriteria: ['Expected behavior'] })).projection.nodeStates.planning, 'waiting')
  await runtime.submitEvidence(null, 'planning', { steps: ['Fix behavior'] })
  const result = await runtime.submitEvidence(null, 'implementation', { summary: 'Fixed behavior' })
  assert.equal(result.projection.nodeStates['quality-assessment'], 'waiting')
  const quality = (await runtime.evidenceTemplate(null, 'quality-assessment')).evidence
  quality.selectedCandidateId = quality.candidates[0].id
  quality.candidates.forEach((candidate) => { candidate.summary = `Reviewed ${candidate.id}` })
  quality.checks[0].passed = true
  quality.checks[0].reference = 'owned.txt:1 and configured test'
  quality.decision = 'accepted'
  const invalid = await runtime.submitEvidence(null, 'quality-assessment', { ...quality, checks: [{ ...quality.checks[0], eventSequence: 1 }] })
  assert.equal(invalid.error.code, 'QUALITY_VERIFICATION_REFERENCE_INVALID')
  const accepted = await runtime.submitEvidence(null, 'quality-assessment', quality)
  assert.equal(accepted.projection.nodeStates['quality-assessment'], 'succeeded')
  assert.equal(accepted.projection.nodeStates.sediment, 'waiting')
})

test('executes bounded loop checks, detects stalled feedback and reuses the successful check', async (t) => {
  const { runtime, repositoryDirectory } = await createTask(t, { verification: { file: process.execPath, args: ['-e', "process.exit(require('fs').readFileSync('owned.txt','utf8').trim() === 'fixed' ? 0 : 1)"], timeoutMs: 1000, coverage: 'behavior' } })
  await implementTask(runtime, ['LOOP_REQUESTED'])
  const first = await runtime.loopCheck(null, { change: 'First attempt' })
  assert.equal(first.loop.iterations, 1)
  assert.equal(first.loop.stopReason, null)
  await writeFile(path.join(repositoryDirectory, 'owned.txt'), 'fixed\n')
  const passed = await runtime.loopCheck(null, { change: 'Fix assertion' })
  assert.equal(passed.loop.stopReason, 'acceptance-passed')
  assert.equal(passed.projection.nodeStates.verification, 'succeeded')
  const verified = (await runtime.status()).record.events.filter((event) => event.nodeId === 'verification' && event.eventType === 'NODE_SUCCEEDED').at(-1)
  assert.ok(verified.evidence.loopEventSequence)

  const { runtime: stalled } = await createTask(t, { verification: { file: process.execPath, args: ['-e', 'process.exit(1)'], timeoutMs: 1000, coverage: 'behavior' } })
  await implementTask(stalled, ['LOOP_REQUESTED'])
  await stalled.loopCheck(null, { change: 'Try one' })
  await stalled.loopCheck(null, { change: 'Try two' })
  const stopped = await stalled.loopCheck(null, { change: 'Try three' })
  assert.equal(stopped.loop.stopReason, 'no-progress')
  assert.equal((await stalled.loopCheck(null, { change: 'Do not run again' })).error.code, 'LOOP_STOPPED')
})

test('enforces elapsed loop budgets across calls and keeps verifier configuration immutable', async (t) => {
  let time = Date.now()
  const { runtime } = await createTask(t, { verification: { file: process.execPath, args: ['-e', 'process.exit(1)'], coverage: 'behavior' } }, { now: () => time })
  await implementTask(runtime, ['LOOP_REQUESTED'])
  await runtime.loopCheck(null, { change: 'First attempt' })
  time += 61 * 60_000
  const expired = await runtime.loopCheck(null, { change: 'Too late' })
  assert.equal(expired.loop.stopReason, 'budget-exhausted')
  assert.equal(expired.loop.iterations, 1)
  const { runtime: limited } = await createTask(t, {
    verification: { file: process.execPath, args: ['-e', 'process.exit(1)'], coverage: 'behavior' },
    executionPolicy: { defaultMode: 'single-pass', loopTriggerSignals: ['LOOP_REQUESTED'], loopBlockedSignals: [], maxIterations: 1, noProgressLimit: 2, timeBudgetMinutes: 60 },
  })
  await implementTask(limited, ['LOOP_REQUESTED'])
  assert.equal((await limited.loopCheck(null, { change: 'Only allowed attempt' })).loop.stopReason, 'budget-exhausted')
  assert.equal((await limited.retry(null, { nodeId: 'loop-execution', reason: 'Cannot reset the budget' })).error.code, 'LOOP_STOPPED')

  const { runtime: original, config: originalConfig } = await createTask(t, { verification: { file: process.execPath, args: ['-e', 'process.exit(1)'], coverage: 'behavior' } })
  await implementTask(original)
  const { runtime: reloaded } = await createWorkflowRuntime({ config: { ...originalConfig, verification: { file: process.execPath, args: ['-e', ''], coverage: 'behavior' } } })
  await reloaded.retry(null, { reason: 'Retry with the recorded verifier' })
  await reloaded.submitEvidence(null, 'implementation', { summary: 'Rechecked' })
  assert.equal((await reloaded.status()).projection.nodeStates.verification, 'failed')
})

test('reserves tool budget before execution, caches real results and invalidates changed inputs', async (t) => {
  const { runtime, repositoryDirectory } = await createTask(t, { evidenceRoutingPolicy: {
    version: 1, localFirst: false, maxMcpCallsPerRun: 2, maxCostUnitsPerRun: 4, cache: true,
    capabilities: [{ id: 'docs-read', kind: 'mcp', access: 'read', enabled: true, costUnits: 2, timeoutMs: 1000,
      command: { file: process.execPath, args: ['-e', "process.stdin.on('data', b => console.log('reply ' + b))"] } }],
  } })
  await runtime.start({ taskId: 'task', request: 'Read documentation', changedFiles: ['owned.txt'], sediment: 'skip' })
  const first = await runtime.executeTool(null, { capabilityId: 'docs-read', input: { query: 'first' } })
  assert.equal(first.ok, true, JSON.stringify(first.error))
  assert.match(first.result.stdout, /first/)
  assert.equal((await runtime.executeTool(null, { capabilityId: 'docs-read', input: { query: 'first' } })).cached, true)
  await writeFile(path.join(repositoryDirectory, 'owned.txt'), 'changed\n')
  assert.equal((await runtime.executeTool(null, { capabilityId: 'docs-read', input: { query: 'first' } })).cached, false)
  assert.equal((await runtime.executeTool(null, { capabilityId: 'docs-read', input: { query: 'third' } })).error.code, 'MCP_CALL_BUDGET_EXCEEDED')
  const events = (await runtime.status()).record.events.filter((event) => event.type.startsWith('TOOL_CALL_'))
  assert.deepEqual(events.map((event) => event.type), ['TOOL_CALL_STARTED', 'TOOL_CALL_FINISHED', 'TOOL_CALL_STARTED', 'TOOL_CALL_FINISHED'])
})

test('recommends relevant sediment and reports measured reuse and intervention counts', async (t) => {
  const { runtime, config } = await createTask(t)
  await mkdir(config.sedimentDirectory)
  await writeFile(path.join(config.sedimentDirectory, 'prior.md'), '# Prior fix\n\n## Summary\n\nFix the owned behavior using a guard.\n')
  await implementTask(runtime)
  const recommendations = await runtime.recommendations()
  assert.equal(recommendations.recommendations[0].path, 'records/prior.md')
  assert.equal((await runtime.recordReuse(null, { path: 'records/other.md', adopted: true, helped: true })).error.code, 'SEDIMENT_NOT_RECOMMENDED')
  await runtime.recordReuse(null, { path: 'records/prior.md', adopted: true, helped: true })
  await runtime.recordIntervention(null, 'Clarified an acceptance criterion')
  await runtime.sediment(null, {})
  await runtime.resume()
  const metrics = await runtime.metrics()
  assert.equal(metrics.runs, 1)
  assert.equal(metrics.completed, 1)
  assert.equal(metrics.firstPassRate, 1)
  assert.equal(metrics.interventions, 1)
  assert.equal(metrics.sedimentAdopted, 1)
  assert.equal(metrics.sedimentHelpful, 1)
  assert.ok(metrics.averageCompletedMs >= 0)
})

test('requires fresh verification before finishing a no-commit Run', async (t) => {
  const { runtime, repositoryDirectory } = await createTask(t)
  await implementTask(runtime)
  await writeFile(path.join(repositoryDirectory, 'owned.txt'), 'changed after check')
  assert.equal((await runtime.sediment(null, {})).error.code, 'VERIFICATION_STALE')
})

test('rejects directory scopes and symlink parents, including links introduced after verification', async (t) => {
  const { runtime, repositoryDirectory } = await createTask(t)
  await mkdir(path.join(repositoryDirectory, 'directory'))
  await symlink(repositoryDirectory, path.join(repositoryDirectory, 'alias'))
  const start = changedFiles => runtime.start({ taskId: 'boundary', request: 'Fix behavior', changedFiles, sediment: 'skip' })
  assert.equal((await start(['directory'])).error.code, 'OWNED_PATH_NOT_FILE')
  assert.equal((await start(['alias/owned.txt'])).error.code, 'OWNED_PATH_SYMLINK_UNSUPPORTED')
  await implementTask(runtime)
  await rm(path.join(repositoryDirectory, 'owned.txt'))
  await symlink('directory/other.txt', path.join(repositoryDirectory, 'owned.txt'))
  assert.equal((await runtime.sediment(null, {})).error.code, 'VERIFICATION_STALE')
})

test('invalidates verification when dependency content changes and rechecks before completion', async (t) => {
  const { runtime, repositoryDirectory } = await createTask(t)
  await writeFile(path.join(repositoryDirectory, 'package.json'), '{"version":"1"}')
  await implementTask(runtime)
  await writeFile(path.join(repositoryDirectory, 'package.json'), '{"version":"2"}')
  assert.equal((await runtime.sediment(null, {})).error.code, 'VERIFICATION_STALE')
  await runtime.retry(null, { reason: 'Reverify changed dependencies' })
  await runtime.submitEvidence(null, 'implementation', { summary: 'Checked new dependencies' })
  await runtime.sediment(null, {})
  await writeFile(path.join(repositoryDirectory, 'package.json'), '{"version":"3"}')
  assert.equal((await runtime.resume()).projection.nodeStates.complete, 'failed')
})

test('starting another task requires explicit selection and cannot race the active pointer', async (t) => {
  const { runtime, config } = await createTask(t)
  const context = taskId => ({ taskId, request: 'Fix behavior', changedFiles: ['owned.txt'], sediment: 'skip' })
  const { runtime: another } = await createWorkflowRuntime({ config })
  const results = await Promise.all([runtime.start(context('first')), another.start(context('second'))])
  assert.equal(results.filter(result => result.ok).length, 1)
  const active = await runtime.activeRun()
  const blocked = await runtime.start(context('third'))
  assert.equal(blocked.error.code, 'ACTIVE_RUN_EXISTS')
  assert.equal(await runtime.activeRun(), active)
  assert.equal((await runtime.start(context('third'), { replaceActiveRun: active })).ok, true)
  assert.equal((await runtime.activate(active)).error.code, 'ACTIVE_RUN_EXISTS')
  assert.equal((await runtime.activate(active, { replaceActiveRun: 'third' })).ok, true)
  assert.equal(await runtime.activeRun(), active)
})

test('finds Chinese experience by words and ranks shared paths and error codes', async (t) => {
  const { runtime, repositoryDirectory } = await createTask(t)
  await mkdir(path.join(repositoryDirectory, 'records'))
  await writeFile(path.join(repositoryDirectory, 'records/login.md'), '## Summary\n登录请求偶发超时；owned.txt；ETIMEDOUT。')
  await writeFile(path.join(repositoryDirectory, 'records/other.md'), '## Summary\n修复其他问题。')
  await runtime.start({ taskId: 'chinese', request: '修复登录超时问题 ETIMEDOUT', changedFiles: ['owned.txt'], sediment: 'skip' })
  const result = await runtime.recommendations()
  assert.equal(result.recommendations[0].path, 'records/login.md')
  await buildContextIndex({ repositoryDirectory, stateDirectory: path.join(repositoryDirectory, '.workflow/state') })
  const { searchContextIndex } = await import('../src/context-index.mjs')
  const found = await searchContextIndex({ repositoryDirectory, stateDirectory: path.join(repositoryDirectory, '.workflow/state'), query: '登录 超时' })
  assert.ok(found.results.some(item => item.path === 'records/login.md'))
  const { findRelatedSediment } = await import('../src/sediment-adapter.mjs')
  assert.equal((await findRelatedSediment({ repositoryDirectory, sedimentDirectory: path.join(repositoryDirectory, 'records'), request: '登录 超时', taskId: 'new' }))[0]?.path, 'records/login.md')
})

test('stops repeated failures despite changing durations and timestamps', async (t) => {
  const { runtime } = await createTask(t, { verification: { file: process.execPath, coverage: 'behavior', args: ['-e', "console.error(new Date().toISOString()); console.error('not ok 1 - owned behavior'); console.error('duration_ms: ' + Math.random()); console.error('ERR_ASSERTION: expected true'); process.exit(1)"] } })
  await implementTask(runtime, ['LOOP_REQUESTED'])
  await runtime.loopCheck(null, { change: 'First attempt' })
  await runtime.loopCheck(null, { change: 'Second attempt' })
  assert.equal((await runtime.loopCheck(null, { change: 'Third attempt' })).loop.stopReason, 'no-progress')
})

test('keeps large verifier logs out of events and summaries while preserving on-demand access', async (t) => {
  const { runtime, config } = await createTask(t, { verification: { file: process.execPath, args: ['-e', "console.log('x'.repeat(50000))"], coverage: 'behavior' } })
  await implementTask(runtime)
  const current = await runtime.status()
  const check = current.record.events.findLast(event => event.nodeId === 'verification' && event.eventType === 'NODE_SUCCEEDED').evidence.checks[0]
  assert.ok(check.stdout.length < 3000)
  assert.ok(check.stdoutLog.sha256)
  assert.equal((await runtime.log(check.stdoutLog.sha256, { offset: 40000, limit: 100 })).text, 'x'.repeat(100))
  assert.ok((await readFile(path.join(config.stateDirectory, 'runs/task.json'))).length < 30000)
  const { summarizeRun } = await import('../src/workflow-observability.mjs')
  assert.ok(JSON.stringify(summarizeRun(current.record, current.projection)).length < 5000)
})

test('quality accepts complete fresh checks without manufactured alternatives or scores', async (t) => {
  const policy = { enabled: true, highRiskSignals: ['HIGH_RISK_REQUEST'], negativeFeedbackSignals: [], candidateCount: 3, accuracyThreshold: 0.85 }
  const { runtime } = await createTask(t, { qualityPolicy: policy })
  await implementTask(runtime, ['HIGH_RISK_REQUEST'])
  const draft = (await runtime.evidenceTemplate(null, 'quality-assessment')).evidence
  assert.equal(draft.candidates, undefined)
  assert.equal(draft.threshold, undefined)
  draft.checks[0].passed = true
  draft.checks[0].reference = 'owned.txt:1 and configured check'
  draft.decision = 'accepted'
  assert.equal((await runtime.submitEvidence(null, 'quality-assessment', draft)).projection.nodeStates['quality-assessment'], 'succeeded')
  const { runtime: tradeoff } = await createTask(t, { qualityPolicy: policy })
  await implementTask(tradeoff, ['HIGH_RISK_REQUEST', 'SOLUTION_TRADEOFF'])
  assert.equal((await tradeoff.evidenceTemplate(null, 'quality-assessment')).evidence.candidates.length, 3)
})

test('selects planning and execution nodes from deterministic signals', async (t) => {
  const repositoryDirectory = await mkdtemp(path.join(tmpdir(), 'workflow-runtime-modes-'))
  t.after(() => rm(repositoryDirectory, { recursive: true, force: true }))
  const runtimeResult = await createWorkflowRuntime({
    config: {
      repositoryDirectory,
      workflowDefinition: path.join(workflowRoot, 'workflows', 'development-v1.yaml'),
      stateDirectory: path.join(repositoryDirectory, '.workflow', 'state'),
      sedimentDirectory: path.join(repositoryDirectory, 'records'),
      verification: {
        file: process.execPath,
        args: ['-e', "process.stdout.write('verified')"],
        timeoutMs: 1000, coverage: 'behavior',
      },
    },
  })
  const runtime = runtimeResult.runtime

  const longTask = await runtime.start({
    taskId: 'long-task',
    request: 'A long but deterministic migration',
    sediment: 'skip',
    signals: ['LONG_RUNNING_IMPLEMENTATION'],
    changedFiles: ['example.txt'],
  })
  assert.equal(longTask.record.plan.context.planningMode, 'structured')
  assert.equal(longTask.record.plan.context.executionMode, 'single-pass')
  assert.equal(longTask.record.plan.nodes.some((node) => node.id === 'loop-execution'), false)

  const loopTask = await runtime.start({
    taskId: 'loop-task',
    request: 'Iterate against automated acceptance',
    sediment: 'skip',
    signals: ['ITERATIVE_ACCEPTANCE'],
    changedFiles: ['example.txt'],
  }, { replaceActiveRun: 'long-task' })
  assert.equal(loopTask.record.plan.context.executionMode, 'loop')
  assert.equal(loopTask.record.plan.nodes.some((node) => node.id === 'loop-execution'), true)

  const contractTask = await runtime.start({
    taskId: 'contract-task',
    request: 'Change an API contract',
    sediment: 'skip',
    signals: ['API_CONTRACT_CHANGE'],
    changedFiles: ['example.txt'],
  }, { replaceActiveRun: 'loop-task' })
  assert.equal(contractTask.record.plan.context.planningMode, 'openspec')
  assert.equal(contractTask.record.plan.nodes.some((node) => node.id === 'openspec-contract'), true)
  assert.deepEqual(contractTask.record.plan.context.eventGates, [{
    signal: 'API_CONTRACT_CHANGE', source: 'operator', confidence: 'declared',
  }])
})

test('refuses a Run without registered owned paths before it can collect AI evidence', async (t) => {
  const repositoryDirectory = await mkdtemp(path.join(tmpdir(), 'workflow-runtime-owned-paths-'))
  t.after(() => rm(repositoryDirectory, { recursive: true, force: true }))
  const runtimeResult = await createWorkflowRuntime({
    config: {
      repositoryDirectory,
      workflowDefinition: path.join(workflowRoot, 'workflows', 'development-v1.yaml'),
      stateDirectory: path.join(repositoryDirectory, '.workflow', 'state'),
      sedimentDirectory: path.join(repositoryDirectory, 'records'),
      verification: { file: process.execPath, args: ['-e', ''], timeoutMs: 1000, coverage: 'behavior' },
    },
  })
  const result = await runtimeResult.runtime.start({
    taskId: 'missing-owned-paths', request: 'No paths', sediment: 'skip', signals: [], changedFiles: [],
  })
  assert.equal(result.error.code, 'OWNED_PATHS_REQUIRED')
})

test('enforces unattended eligibility inside runtime and never silently downgrades it', async (t) => {
  const repositoryDirectory = await mkdtemp(path.join(tmpdir(), 'workflow-runtime-unattended-'))
  t.after(() => rm(repositoryDirectory, { recursive: true, force: true }))
  const base = {
    repositoryDirectory,
    workflowDefinition: path.join(workflowRoot, 'workflows', 'development-v1.yaml'),
    sedimentDirectory: path.join(repositoryDirectory, 'records'),
  }
  const enabled = await createWorkflowRuntime({ config: {
    ...base,
    stateDirectory: path.join(repositoryDirectory, '.workflow', 'enabled'),
    verification: { file: process.execPath, args: ['-e', ''], timeoutMs: 1000, coverage: 'behavior' },
  } })
  await writeFile(path.join(repositoryDirectory, 'owned.mjs'), '')
  const started = await enabled.runtime.start({ taskId: 'unattended-ok', request: '无人值守完善本地模块', sediment: 'skip', signals: [], changedFiles: ['owned.mjs'] })
  assert.equal(started.record.plan.context.executionMode, 'loop')
  assert.equal(started.record.plan.context.signals.includes('UNATTENDED'), true)
  const downgraded = await enabled.runtime.start({ taskId: 'unattended-single', request: '无人值守完善本地模块', sediment: 'skip', signals: [], changedFiles: ['owned.mjs'], executionMode: 'single-pass' })
  assert.equal(downgraded.error.code, 'UNATTENDED_LOOP_REQUIRED')

  const disabled = await createWorkflowRuntime({ config: {
    ...base,
    stateDirectory: path.join(repositoryDirectory, '.workflow', 'disabled'),
    governance: { commands: { test: null } },
    verification: { file: process.execPath, args: ['-e', ''], timeoutMs: 1000, coverage: 'behavior' },
  } })
  const blocked = await disabled.runtime.start({ taskId: 'unattended-no-test', request: '无人值守完善本地模块', sediment: 'skip', signals: [], changedFiles: ['owned.mjs'] })
  assert.equal(blocked.error.code, 'UNATTENDED_ELIGIBILITY_REQUIRED')
  assert.deepEqual(blocked.error.blockers, ['no automated verification command'])
})

test('records only explicit, reviewed lexical references used by a Run', async (t) => {
  const repositoryDirectory = await mkdtemp(path.join(tmpdir(), 'workflow-runtime-context-'))
  t.after(() => rm(repositoryDirectory, { recursive: true, force: true }))
  await writeFile(path.join(repositoryDirectory, 'service.mjs'), 'export const paymentToken = token\n')
  const stateDirectory = path.join(repositoryDirectory, '.workflow', 'state')
  await buildContextIndex({ repositoryDirectory, stateDirectory })
  const runtimeResult = await createWorkflowRuntime({
    config: {
      repositoryDirectory,
      workflowDefinition: path.join(workflowRoot, 'workflows', 'development-v1.yaml'),
      stateDirectory,
      sedimentDirectory: path.join(repositoryDirectory, 'records'),
      verification: { file: process.execPath, args: ['-e', ''], timeoutMs: 1000, coverage: 'behavior' },
    },
  })
  const runtime = runtimeResult.runtime
  await runtime.start({ taskId: 'context-record', request: 'Trace payment token', sediment: 'skip', signals: [], changedFiles: ['service.mjs'] })
  assert.equal((await runtime.recordContext(null, {
    query: 'payment token', selections: [{ path: 'service.mjs', line: 1 }], reviewed: false,
  })).error.code, 'CONTEXT_REVIEW_REQUIRED')
  const recorded = await runtime.recordContext(null, {
    query: 'payment token', selections: [{ path: 'service.mjs', line: 1 }], reviewed: true,
  })
  assert.equal(recorded.ok, true)
  assert.deepEqual(recorded.appendedEvent.evidence.references, [{ path: 'service.mjs', line: 1, stale: false }])
  assert.equal(recorded.appendedEvent.evidence.content, undefined)
  assert.equal((await runtime.recordContext(null, {
    query: 'payment token', selections: [{ path: 'missing.mjs', line: 1 }], reviewed: true,
  })).error.code, 'CONTEXT_SELECTION_NOT_RETRIEVED')
})

test('adds the initialized project quality gate for high-risk work', async (t) => {
  const repositoryDirectory = await mkdtemp(path.join(tmpdir(), 'workflow-runtime-quality-'))
  t.after(() => rm(repositoryDirectory, { recursive: true, force: true }))
  const runtimeResult = await createWorkflowRuntime({
    config: {
      repositoryDirectory,
      workflowDefinition: path.join(workflowRoot, 'workflows', 'development-v1.yaml'),
      stateDirectory: path.join(repositoryDirectory, '.workflow', 'state'),
      sedimentDirectory: path.join(repositoryDirectory, 'records'),
      verification: { file: process.execPath, args: ['-e', ''], timeoutMs: 1000, coverage: 'behavior' },
      qualityPolicy: {
        enabled: true, highRiskSignals: ['AUTH_OR_SECURITY_CHANGE'], negativeFeedbackSignals: ['USER_DISSATISFACTION'], candidateCount: 3, accuracyThreshold: 0.85,
      },
    },
  })
  const started = await runtimeResult.runtime.start({
    taskId: 'quality-gate', request: 'Secure a boundary', sediment: 'skip', signals: ['AUTH_OR_SECURITY_CHANGE'], changedFiles: ['auth.mjs'],
  })
  assert.equal(started.record.plan.context.qualityGate.enabled, true)
  assert.equal(started.record.plan.context.qualityGate.candidateCount, 3)
  assert.equal(started.record.plan.nodes.some((node) => node.id === 'quality-assessment'), true)
  assert.deepEqual(started.record.plan.nodes.find((node) => node.id === 'sediment').requires, ['quality-assessment'])
})

test('refuses an existing symbolic link as an owned path', async (t) => {
  const repositoryDirectory = await mkdtemp(path.join(tmpdir(), 'workflow-runtime-symlink-'))
  t.after(() => rm(repositoryDirectory, { recursive: true, force: true }))
  await writeFile(path.join(repositoryDirectory, 'outside.txt'), 'outside\n')
  await symlink('outside.txt', path.join(repositoryDirectory, 'owned-link.txt'))
  const runtimeResult = await createWorkflowRuntime({
    config: {
      repositoryDirectory,
      workflowDefinition: path.join(workflowRoot, 'workflows', 'development-v1.yaml'),
      stateDirectory: path.join(repositoryDirectory, '.workflow', 'state'),
      sedimentDirectory: path.join(repositoryDirectory, 'records'),
      verification: { file: process.execPath, args: ['-e', ''], timeoutMs: 1000, coverage: 'behavior' },
    },
  })
  const result = await runtimeResult.runtime.start({
    taskId: 'symlink-path', request: 'Reject a link', sediment: 'skip', signals: [], changedFiles: ['owned-link.txt'],
  })
  assert.equal(result.error.code, 'OWNED_PATH_SYMLINK_UNSUPPORTED')
})

test('records an explicit verification skip but does not convert it into fresh verification evidence', async (t) => {
  const repositoryDirectory = await mkdtemp(path.join(tmpdir(), 'workflow-runtime-verification-skip-'))
  t.after(() => rm(repositoryDirectory, { recursive: true, force: true }))
  const runtimeResult = await createWorkflowRuntime({
    config: {
      repositoryDirectory,
      workflowDefinition: path.join(workflowRoot, 'workflows', 'development-v1.yaml'),
      stateDirectory: path.join(repositoryDirectory, '.workflow', 'state'),
      sedimentDirectory: path.join(repositoryDirectory, 'records'),
      verification: { file: process.execPath, args: ['-e', 'throw new Error()'], timeoutMs: 1000 },
      governance: { commands: { test: null } },
    },
  })
  const runtime = runtimeResult.runtime
  await runtime.start({ taskId: 'skip-check', request: 'Skip is explicit', sediment: 'skip', signals: [], changedFiles: ['owned.txt'] })
  const evidence = {
    intake: { schemaVersion: 1, kind: 'intake', request: 'Skip is explicit', ownedPaths: ['owned.txt'], acceptanceCriteria: ['Skip is reported'] },
    planning: { schemaVersion: 1, kind: 'inline-plan', goal: 'Report skip', ownedPaths: ['owned.txt'], steps: ['Run verification node'], acceptance: ['Skip is reported'], verification: ['not configured'] },
    implementation: { schemaVersion: 1, kind: 'implementation', summary: 'No file needed', changedPaths: ['owned.txt'], verificationScope: ['skip report'] },
  }
  for (const nodeId of ['intake', 'planning', 'implementation']) {
    await runtime.resume()
    await runtime.resolveNode(null, nodeId, { evidence: evidence[nodeId] })
  }
  await runtime.resume()
  const status = await runtime.status()
  const event = status.record.events.find((item) => item.nodeId === 'verification' && item.eventType === 'NODE_SUCCEEDED')
  assert.equal(event.evidence.decision, 'skipped')
})

test('drives a complete no-commit run through CLI runtime operations', async (t) => {
  const repositoryDirectory = await mkdtemp(path.join(tmpdir(), 'workflow-runtime-'))
  t.after(() => rm(repositoryDirectory, { recursive: true, force: true }))
  const runtimeResult = await createWorkflowRuntime({
    config: {
      repositoryDirectory,
      workflowDefinition: path.join(workflowRoot, 'workflows', 'development-v1.yaml'),
      stateDirectory: path.join(repositoryDirectory, '.workflow', 'state'),
      sedimentDirectory: path.join(repositoryDirectory, 'records'),
      verification: {
        file: process.execPath,
        args: ['-e', "process.stdout.write('verified')"],
        timeoutMs: 1000, coverage: 'behavior',
      },
    },
  })
  assert.equal(runtimeResult.ok, true)
  const runtime = runtimeResult.runtime

  await runtime.start({
    taskId: 'runtime-task',
    request: 'Exercise runtime lifecycle',
    sediment: 'required',
    signals: [],
    changedFiles: ['example.txt'],
  })
  const started = await runtime.status()
  assert.deepEqual(started.record.plan.context.changedFiles, [
    'example.txt',
    'records/runtime-task.md',
  ])
  await runtime.resume()
  await runtime.resolveNode(null, 'intake', { evidence: {
    schemaVersion: 1, kind: 'intake', request: 'Exercise runtime lifecycle',
    ownedPaths: ['example.txt', 'records/runtime-task.md'], acceptanceCriteria: ['Lifecycle completes'],
  } })
  await runtime.resume()
  await runtime.resolveNode(null, 'planning', { evidence: {
    schemaVersion: 1, kind: 'inline-plan', goal: 'Exercise lifecycle',
    ownedPaths: ['example.txt', 'records/runtime-task.md'], steps: ['Run lifecycle'],
    acceptance: ['Lifecycle completes'], verification: ['node verification'],
  } })
  await runtime.resume()
  await runtime.resolveNode(null, 'implementation', { evidence: {
    schemaVersion: 1, kind: 'implementation', summary: 'Lifecycle exercised',
    changedPaths: ['example.txt'], verificationScope: ['node verification'],
  } })
  const verified = await runtime.resume()

  assert.equal(verified.projection.nodeStates.verification, 'succeeded')
  assert.equal(verified.projection.nodeStates.sediment, 'waiting')

  const sediment = await runtime.sediment(null, {
    summary: 'Runtime lifecycle completed.',
    verification: ['node verification: passed'],
  })
  assert.equal(sediment.outcome.status, 'succeeded')
  const completed = await runtime.resume()

  assert.equal(completed.projection.status, 'completed')
  assert.match(
    await readFile(path.join(repositoryDirectory, 'records', 'runtime-task.md'), 'utf8'),
    /Runtime lifecycle completed/,
  )
})

test('uses Run evidence to shadow and commit implementation plus generated sediment', async (t) => {
  const repositoryDirectory = await mkdtemp(path.join(tmpdir(), 'workflow-runtime-commit-'))
  t.after(() => rm(repositoryDirectory, { recursive: true, force: true }))
  await execa('git', ['init', '--quiet'], { cwd: repositoryDirectory })
  await execa('git', ['config', 'user.name', 'Workflow Test'], { cwd: repositoryDirectory })
  await execa('git', ['config', 'user.email', 'workflow@example.invalid'], { cwd: repositoryDirectory })
  await writeFile(path.join(repositoryDirectory, 'owned.txt'), 'initial\n')
  await execa('git', ['add', 'owned.txt'], { cwd: repositoryDirectory })
  await execa('git', ['commit', '--quiet', '-m', 'test: initial'], { cwd: repositoryDirectory })
  await writeFile(path.join(repositoryDirectory, 'owned.txt'), 'changed\n')

  const runtimeResult = await createWorkflowRuntime({
    config: {
      repositoryDirectory,
      workflowDefinition: path.join(workflowRoot, 'workflows', 'development-v1.yaml'),
      stateDirectory: path.join(repositoryDirectory, '.workflow', 'state'),
      sedimentDirectory: path.join(repositoryDirectory, 'records'),
      verification: {
        file: process.execPath,
        args: ['-e', "process.stdout.write('verified')"],
        timeoutMs: 1000, coverage: 'behavior',
      },
    },
  })
  const runtime = runtimeResult.runtime
  const details = { summary: 'Committed through runtime.', verification: ['node check passed'] }
  const commitPlan = {
    schemaVersion: 1,
    runId: 'commit-task',
    groups: [
      {
        id: 'runtime-change',
        message: 'feat: commit through workflow runtime',
        paths: ['owned.txt', 'records/commit-task.md'],
      },
    ],
  }

  await runtime.start({
    taskId: 'commit-task',
    request: 'Commit through runtime',
    sediment: 'required',
    signals: ['COMMIT_REQUESTED'],
    changedFiles: ['owned.txt'],
  })
  const nodeEvidence = {
    intake: { schemaVersion: 1, kind: 'intake', request: 'Commit through runtime', ownedPaths: ['owned.txt', 'records/commit-task.md'], acceptanceCriteria: ['Commit completes'] },
    planning: { schemaVersion: 1, kind: 'inline-plan', goal: 'Commit change', ownedPaths: ['owned.txt', 'records/commit-task.md'], steps: ['Commit exact paths'], acceptance: ['Commit completes'], verification: ['node verification'] },
    implementation: { schemaVersion: 1, kind: 'implementation', summary: 'Changed owned file', changedPaths: ['owned.txt'], verificationScope: ['node verification'] },
  }
  for (const nodeId of ['intake', 'planning', 'implementation']) {
    await runtime.resume()
    await runtime.resolveNode(null, nodeId, { evidence: nodeEvidence[nodeId] })
  }
  await runtime.resume()
  await runtime.sediment(null, details)
  const verifiedRun = await runtime.status()
  const verificationEvidence = verifiedRun.record.events
    .filter((event) => event.nodeId === 'verification' && event.eventType === 'NODE_SUCCEEDED')
    .at(-1).evidence
  assert.equal(verificationEvidence.freshness.planHash, verifiedRun.record.plan.planHash)
  assert.equal(verificationEvidence.freshness.after.repository.status, 'git')
  await writeFile(path.join(repositoryDirectory, 'owned.txt'), 'changed after verification\n')
  const staleCommit = await runtime.commit(null, { commitPlan, authorized: true })
  assert.equal(staleCommit.error.code, 'VERIFICATION_STALE')
  await writeFile(path.join(repositoryDirectory, 'owned.txt'), 'changed\n')
  await runtime.resume()
  await runtime.resolveNode(null, 'atomic-commit-plan', { evidence: { schemaVersion: 1, kind: 'atomic-commit-plan', commitPlan } })
  await runtime.resume()
  const shadow = await runtime.shadow(null, commitPlan, details)
  assert.equal(shadow.decision, 'ready')
  await runtime.resume()
  const committed = await runtime.commit(null, { commitPlan, authorized: true })
  assert.equal(committed.outcome.status, 'succeeded')
  const completed = await runtime.resume()

  assert.equal(completed.projection.status, 'completed')
  const committedPaths = (await execa(
    'git',
    ['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', 'HEAD'],
    { cwd: repositoryDirectory },
  )).stdout.split('\n').filter(Boolean).sort()
  assert.deepEqual(committedPaths, ['owned.txt', 'records/commit-task.md'])
})
