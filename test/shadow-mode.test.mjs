import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { execa } from 'execa'
import { createGitAdapter } from '../src/git-adapter.mjs'
import { createShadowMode } from '../src/shadow-mode.mjs'

async function repository(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'workflow-shadow-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await execa('git', ['init', '--quiet'], { cwd: directory })
  await execa('git', ['config', 'user.name', 'Workflow Test'], { cwd: directory })
  await execa('git', ['config', 'user.email', 'workflow@example.invalid'], { cwd: directory })
  await writeFile(path.join(directory, 'owned.txt'), 'initial\n')
  await writeFile(path.join(directory, 'unrelated.txt'), 'initial\n')
  await execa('git', ['add', 'owned.txt', 'unrelated.txt'], { cwd: directory })
  await execa('git', ['commit', '--quiet', '-m', 'test: initial'], { cwd: directory })
  await writeFile(path.join(directory, 'owned.txt'), 'owned change\n')
  await writeFile(path.join(directory, 'unrelated.txt'), 'user change\n')
  return directory
}

function executionPlan() {
  return {
    runId: 'task-1',
    context: {
      taskId: 'task-1',
      request: 'Change owned file',
      sediment: 'required',
      signals: ['COMMIT_REQUESTED'],
      changedFiles: ['owned.txt'],
    },
  }
}

function commitPlan() {
  return {
    schemaVersion: 1,
    runId: 'task-1',
    groups: [{ id: 'owned', message: 'feat: update owned file', paths: ['owned.txt'] }],
  }
}

test('writes a shadow decision without changing index or HEAD', async (t) => {
  const directory = await repository(t)
  const git = createGitAdapter({ repositoryDirectory: directory })
  const stateDirectory = path.join(directory, '.workflow-state')
  const shadow = createShadowMode({ git, stateDirectory, now: () => '2026-08-20T00:00:00.000Z' })
  const headBefore = await git.headSha()

  const result = await shadow.evaluate({
    plan: executionPlan(),
    commitPlan: commitPlan(),
    sedimentDetails: { summary: 'Updated owned file.', verification: ['test passed'] },
  })

  assert.equal(result.ok, true)
  assert.equal(result.decision, 'ready')
  assert.deepEqual(result.observed.unrelatedPaths, ['unrelated.txt'])
  assert.deepEqual(await git.listStagedPaths(), [])
  assert.equal(await git.headSha(), headBefore)
  const report = JSON.parse(await readFile(result.reportPath, 'utf8'))
  assert.deepEqual(report.writeOperations, [])
})

test('blocks when the index already contains staged changes', async (t) => {
  const directory = await repository(t)
  await execa('git', ['add', 'unrelated.txt'], { cwd: directory })
  const git = createGitAdapter({ repositoryDirectory: directory })
  const shadow = createShadowMode({ git, stateDirectory: path.join(directory, '.workflow-state') })

  const result = await shadow.evaluate({
    plan: executionPlan(),
    commitPlan: commitPlan(),
    sedimentDetails: { summary: 'Updated owned file.', verification: ['test passed'] },
  })

  assert.equal(result.decision, 'blocked')
  assert.equal(result.reasons.some((reason) => reason.code === 'INDEX_NOT_EMPTY'), true)
  assert.deepEqual(await git.listStagedPaths(), ['unrelated.txt'])
})

test('returns skip when commit was not requested', async (t) => {
  const directory = await repository(t)
  const git = createGitAdapter({ repositoryDirectory: directory })
  const shadow = createShadowMode({ git, stateDirectory: path.join(directory, '.workflow-state') })
  const plan = executionPlan()
  plan.context.signals = []

  const result = await shadow.evaluate({
    plan,
    commitPlan: null,
    sedimentDetails: { summary: 'Updated owned file.', verification: ['test passed'] },
  })

  assert.equal(result.decision, 'skip')
  assert.equal(result.commit.decision, 'skip')
})
