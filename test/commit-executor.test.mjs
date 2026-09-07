import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { execa } from 'execa'
import { createCommitExecutor } from '../src/commit-executor.mjs'
import { createGitAdapter } from '../src/git-adapter.mjs'
import { createFileLeaseManager } from '../src/lease-manager.mjs'
import { createRepositoryWriterLock } from '../src/repository-writer-lock.mjs'

async function repository(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'workflow-commit-'))
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

function atomicPlan() {
  return {
    schemaVersion: 1,
    runId: 'task-1',
    groups: [{ id: 'owned', message: 'feat: update owned file', paths: ['owned.txt'] }],
  }
}

function setup(directory, faults) {
  const writerLock = createRepositoryWriterLock({
    leaseManager: createFileLeaseManager({
      rootDirectory: path.join(directory, '.git', 'workflow-leases'),
      ownerId: 'commit-writer',
    }),
  })
  const git = createGitAdapter({ repositoryDirectory: directory, writerLock })
  const executor = createCommitExecutor({
    git,
    writerLock,
    journalDirectory: path.join(directory, '.git', 'workflow-journals'),
    now: () => '2026-08-20T00:00:00.000Z',
    faults,
  })
  return { executor, git }
}

const preconditions = {
  authorized: true,
  verificationEvidence: ['pnpm test: passed'],
  sedimentEvidence: { decision: 'required', action: 'created' },
}

test('creates a local commit from exact paths and leaves unrelated changes untouched', async (t) => {
  const directory = await repository(t)
  const { executor, git } = setup(directory)

  const result = await executor.execute({
    plan: executionPlan(),
    commitPlan: atomicPlan(),
    ...preconditions,
  })

  assert.equal(result.ok, true)
  assert.equal(result.commits.length, 1)
  assert.deepEqual(await git.commitPaths(result.commits[0].commitSha), ['owned.txt'])
  assert.deepEqual(await git.listStagedPaths(), [])
  assert.deepEqual(await git.listChangedPaths(), ['unrelated.txt'])
  assert.equal(await readFile(path.join(directory, 'unrelated.txt'), 'utf8'), 'user change\n')
  const metadata = await git.commitMetadata(result.commits[0].commitSha)
  assert.equal(metadata.message, 'feat: update owned file')
})

test('requires explicit authorization, verification and sediment completion', async (t) => {
  const directory = await repository(t)
  const { executor, git } = setup(directory)

  const unauthorized = await executor.execute({
    plan: executionPlan(),
    commitPlan: atomicPlan(),
    ...preconditions,
    authorized: false,
  })
  const unverified = await executor.execute({
    plan: executionPlan(),
    commitPlan: atomicPlan(),
    ...preconditions,
    verificationEvidence: [],
  })
  const unsedimented = await executor.execute({
    plan: executionPlan(),
    commitPlan: atomicPlan(),
    ...preconditions,
    sedimentEvidence: { decision: 'blocked' },
  })

  assert.equal(unauthorized.error.code, 'COMMIT_NOT_AUTHORIZED')
  assert.equal(unverified.error.code, 'VERIFICATION_REQUIRED')
  assert.equal(unsedimented.error.code, 'SEDIMENT_REQUIRED')
  assert.deepEqual(await git.listStagedPaths(), [])
})

test('refuses to mix a pre-existing staged change into the commit', async (t) => {
  const directory = await repository(t)
  await execa('git', ['add', 'unrelated.txt'], { cwd: directory })
  const { executor, git } = setup(directory)

  const result = await executor.execute({
    plan: executionPlan(),
    commitPlan: atomicPlan(),
    ...preconditions,
  })

  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'INDEX_NOT_EMPTY')
  assert.deepEqual(await git.listStagedPaths(), ['unrelated.txt'])
})

test('fails preflight before staging when a planned path has no change', async (t) => {
  const directory = await repository(t)
  const { executor, git } = setup(directory)
  const plan = executionPlan()
  plan.context.changedFiles = ['owned.txt', 'unchanged.txt']
  await writeFile(path.join(directory, 'unchanged.txt'), 'tracked but unchanged\n')
  await execa('git', ['add', 'unchanged.txt'], { cwd: directory })
  await execa('git', ['commit', '--quiet', '-m', 'test: add unchanged fixture'], { cwd: directory })
  const commitPlan = atomicPlan()
  commitPlan.groups[0].paths.push('unchanged.txt')

  const result = await executor.execute({ plan, commitPlan, ...preconditions })

  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'COMMIT_PREFLIGHT_FAILED')
  assert.deepEqual(await git.listStagedPaths(), [])
})

test('reconciles a commit created before the receipt was persisted', async (t) => {
  const directory = await repository(t)
  let injected = false
  const { executor, git } = setup(directory, {
    async afterCommit() {
      if (!injected) {
        injected = true
        throw new Error('simulated crash after git commit')
      }
    },
  })

  const interrupted = await executor.execute({
    plan: executionPlan(),
    commitPlan: atomicPlan(),
    ...preconditions,
  })
  const headAfterCrash = await git.headSha()
  const reconciled = await executor.reconcile({
    plan: executionPlan(),
    commitPlan: atomicPlan(),
  })
  const resumed = await executor.execute({
    plan: executionPlan(),
    commitPlan: atomicPlan(),
    ...preconditions,
  })

  assert.equal(interrupted.ok, false)
  assert.equal(reconciled.status, 'succeeded')
  assert.equal(reconciled.evidence.commits[0].commitSha, headAfterCrash)
  assert.equal(resumed.ok, true)
  assert.equal(resumed.commits[0].commitSha, headAfterCrash)
  assert.equal(await git.headSha(), headAfterCrash)
})
