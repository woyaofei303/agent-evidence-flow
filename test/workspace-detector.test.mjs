import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import test from 'node:test'
import { inspectTargetTopology } from '../src/workspace-detector.mjs'

const execFile = promisify(execFileCallback)

async function gitRepository(root, relativePath, files) {
  const directory = path.join(root, relativePath)
  await mkdir(directory, { recursive: true })
  await execFile('git', ['init', '-q'], { cwd: directory })
  await Promise.all(Object.entries(files).map(([name, contents]) =>
    writeFile(path.join(directory, name), contents, 'utf8')))
  return directory
}

test('scans nested child Git repositories without writing them and flags heterogeneous stacks', async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'workflow-workspace-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const web = await gitRepository(workspace, 'apps/web', {
    'package.json': JSON.stringify({ name: 'web', scripts: { build: 'vite build' }, dependencies: { vue: '*' } }),
    'AGENTS.md': '# Web\nUse `.agents/workflows/task.md` before every task.\n',
  })
  await mkdir(path.join(web, '.agents'), { recursive: true })
  await writeFile(path.join(web, '.agents', 'project.conf'), 'OLD=true\n', 'utf8')
  const api = await gitRepository(workspace, 'services/api', {
    'Cargo.toml': '[package]\nname = "api"\nversion = "0.1.0"\n',
  })
  const before = await Promise.all([web, api].map(async (directory) =>
    (await execFile('git', ['status', '--short', '--untracked-files=all'], { cwd: directory })).stdout))

  const result = await inspectTargetTopology(workspace)
  const after = await Promise.all([web, api].map(async (directory) =>
    (await execFile('git', ['status', '--short', '--untracked-files=all'], { cwd: directory })).stdout))

  assert.equal(result.mode, 'workspace-candidate')
  assert.deepEqual(result.repositories.map((repo) => repo.path), ['apps/web', 'services/api'])
  assert.deepEqual(result.repositories.map((repo) => repo.id), ['apps-web', 'services-api'])
  assert.equal(result.heterogeneous, true)
  assert.match(result.warnings[0], /HETEROGENEOUS_STACKS/)
  assert.deepEqual(result.repositories[0].legacyWorkflow, {
    status: 'inactive',
    detectedEntrypoints: ['.agents/', 'AGENTS.md workflow directives'],
    instructionConflict: true,
  })
  assert.match(result.warnings.join('\n'), /CHILD_WORKFLOW_INACTIVE/)
  assert.match(result.warnings.join('\n'), /CHILD_AGENTS_WORKFLOW_CONFLICT/)
  assert.deepEqual(after, before)
})

test('keeps an exact Git root in single-repository mode', async (t) => {
  const repository = await mkdtemp(path.join(os.tmpdir(), 'workflow-single-'))
  t.after(() => rm(repository, { recursive: true, force: true }))
  await execFile('git', ['init', '-q'], { cwd: repository })

  const result = await inspectTargetTopology(repository)

  assert.equal(result.mode, 'single')
  assert.equal(result.repositoryDirectory, await execFile('git', ['rev-parse', '--show-toplevel'], { cwd: repository }).then(({ stdout }) => stdout.trim()))
})

test('rejects a directory with no Git repository to manage', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'workflow-empty-parent-'))
  t.after(() => rm(directory, { recursive: true, force: true }))

  await assert.rejects(
    inspectTargetTopology(directory),
    (error) => error.code === 'NO_GIT_REPOSITORIES',
  )
})
