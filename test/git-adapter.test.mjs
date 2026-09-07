import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { execa } from 'execa'
import { createGitAdapter } from '../src/git-adapter.mjs'
import { createFileLeaseManager } from '../src/lease-manager.mjs'
import { createRepositoryWriterLock } from '../src/repository-writer-lock.mjs'

async function temporaryRepository(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'workflow-git-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await execa('git', ['init', '--quiet'], { cwd: directory })
  await execa('git', ['config', 'user.name', 'Workflow Test'], { cwd: directory })
  await execa('git', ['config', 'user.email', 'workflow@example.invalid'], { cwd: directory })
  await writeFile(path.join(directory, 'first.txt'), 'first\n')
  await writeFile(path.join(directory, 'second.txt'), 'second\n')
  await execa('git', ['add', 'first.txt', 'second.txt'], { cwd: directory })
  await execa('git', ['commit', '--quiet', '-m', 'test: initial'], { cwd: directory })
  return directory
}

function setupAdapter(directory, ownerId = 'writer-a') {
  const leaseManager = createFileLeaseManager({
    rootDirectory: path.join(directory, '.workflow-test-leases'),
    ownerId,
  })
  const writerLock = createRepositoryWriterLock({ leaseManager })
  return {
    writerLock,
    git: createGitAdapter({ repositoryDirectory: directory, writerLock }),
  }
}

test('stages only explicitly selected paths while preserving other changes', async (t) => {
  const directory = await temporaryRepository(t)
  await writeFile(path.join(directory, 'first.txt'), 'changed first\n')
  await writeFile(path.join(directory, 'second.txt'), 'changed second\n')
  const { git, writerLock } = setupAdapter(directory)

  await writerLock.withLock('stage-test', (capability) =>
    git.stageExact(['first.txt'], { capability }),
  )

  assert.deepEqual(await git.listStagedPaths(), ['first.txt'])
  assert.deepEqual(await git.listChangedPaths(), ['first.txt', 'second.txt'])
  assert.equal(await readFile(path.join(directory, 'second.txt'), 'utf8'), 'changed second\n')
})

test('rejects Git writes without a live writer capability', async (t) => {
  const directory = await temporaryRepository(t)
  await writeFile(path.join(directory, 'first.txt'), 'changed\n')
  const { git } = setupAdapter(directory)

  const result = await git.stageExact(['first.txt'])

  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'WRITER_LOCK_REQUIRED')
  assert.deepEqual(await git.listStagedPaths(), [])
})

test('rejects absolute and parent-traversal pathspecs', async (t) => {
  const directory = await temporaryRepository(t)
  const { git, writerLock } = setupAdapter(directory)

  const absolute = await writerLock.withLock('absolute', (capability) =>
    git.stageExact(['/tmp/outside'], { capability }),
  )
  const traversal = await writerLock.withLock('traversal', (capability) =>
    git.stageExact(['../outside'], { capability }),
  )

  assert.equal(absolute.error.code, 'UNSAFE_GIT_PATH')
  assert.equal(traversal.error.code, 'UNSAFE_GIT_PATH')
})
