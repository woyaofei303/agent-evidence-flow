import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { execa } from 'execa'
import { stringify } from 'yaml'

const root = path.resolve(import.meta.dirname, '..')
const cli = path.join(root, 'cli/workflow.mjs')

test('shows help without installation and completes a task without intermediate evidence files', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workflow-cli-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const call = (...args) => execa(process.execPath, [cli, ...args, '--cwd', directory])
  assert.match((await call('--help')).stdout, /workflow retry/)
  await mkdir(path.join(directory, '.workflow'))
  await writeFile(path.join(directory, '.workflow/config.yaml'), stringify({
    schemaVersion: 1, projectName: 'cli-test', workflowDefinition: 'flow.yaml', stateDirectory: '.workflow/state', sedimentDirectory: 'records',
    verification: { file: process.execPath, args: ['-e', ''], coverage: 'behavior' },
  }))
  const { readFile } = await import('node:fs/promises')
  await writeFile(path.join(directory, 'flow.yaml'), await readFile(path.join(root, 'workflows/development-v1.yaml')))
  await writeFile(path.join(directory, 'owned.txt'), 'owned')
  await call('start', '--task-id', 'cli-task', '--request', 'Fix behavior', '--changed-file', 'owned.txt', '--sediment', 'skip', '--category', 'bugfix')
  const draft = JSON.parse((await call('evidence', '--node', 'intake')).stdout)
  assert.deepEqual(draft.evidence.ownedPaths, ['owned.txt'])
  for (const [nodeId, evidence] of Object.entries({ intake: { acceptanceCriteria: ['Correct behavior'] }, planning: { steps: ['Fix'] }, implementation: { summary: 'Fixed' } })) {
    const result = JSON.parse((await call('resolve', '--node', nodeId, '--json', JSON.stringify(evidence))).stdout)
    assert.ok(result.nextActions.length > 0)
    assert.equal(result.toolUsage.costUnits, 0)
  }
  const finished = JSON.parse((await call('sediment', '--json', '{}')).stdout)
  assert.equal(finished.projection.status, 'completed')
  const metrics = JSON.parse((await call('metrics')).stdout)
  assert.equal(metrics.completed, 1)
  assert.equal(metrics.byCategory.bugfix.completed, 1)
  assert.ok(metrics.rows[0].cliCalls >= 6)
  assert.ok(metrics.rows[0].waitingMs >= 0)
  assert.ok(metrics.rows[0].executionMs >= 0)
  await writeFile(path.join(directory, '.workflow/state/baseline.json'), JSON.stringify(metrics))
  const comparison = JSON.parse((await call('metrics', '--baseline', path.join(directory, '.workflow/state/baseline.json'))).stdout)
  assert.equal(comparison.comparison.bugfix.completedDelta, 0)
})
