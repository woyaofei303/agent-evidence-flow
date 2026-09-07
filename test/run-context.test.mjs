import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { execa } from 'execa'
import { createGitAdapter } from '../src/git-adapter.mjs'
import { captureRunContext } from '../src/run-context.mjs'

test('captures a redacted identity and rejects a mismatched configured remote', async (t) => {
  const repository = await mkdtemp(path.join(os.tmpdir(), 'workflow-run-context-'))
  t.after(() => rm(repository, { recursive: true, force: true }))
  await execa('git', ['init', '-q'], { cwd: repository })
  await execa('git', ['remote', 'add', 'origin', 'https://user:secret@example.com/team/app.git'], { cwd: repository })
  await writeFile(path.join(repository, 'changed.txt'), 'changed\n')
  const git = createGitAdapter({ repositoryDirectory: repository })

  const matched = await captureRunContext({
    git,
    repositoryDirectory: repository,
    governance: { remotePatterns: ['example.com/team/app'] },
  })
  const mismatched = await captureRunContext({
    git,
    repositoryDirectory: repository,
    governance: { remotePatterns: ['example.com/team/other'] },
  })

  assert.equal(matched.ok, true)
  assert.equal(matched.context.repository.identity.matchedRemote.normalized, 'example.com/team/app')
  assert.deepEqual(matched.context.repository.changedPaths, ['changed.txt'])
  assert.equal(JSON.stringify(matched.context).includes('secret'), false)
  assert.equal(mismatched.error.code, 'PROJECT_IDENTITY_UNVERIFIED')
})
