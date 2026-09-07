import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execa } from 'execa'
import test from 'node:test'
import { normalizeRemote, resolveProject } from '../src/project-resolver.mjs'

test('normalizes HTTPS, SSH and scp-like remotes identically', () => {
  assert.equal(normalizeRemote('https://GitHub.com/example/app.git/'), 'github.com/example/app')
  assert.equal(normalizeRemote('git@github.com:example/app.git'), 'github.com/example/app')
  assert.equal(normalizeRemote('ssh://git@github.com/example/app'), 'github.com/example/app')
})

test('matches only the selected canonical remote by exact normalized value', async (t) => {
  const repository = await mkdtemp(path.join(os.tmpdir(), 'workflow-resolver-'))
  t.after(() => rm(repository, { recursive: true, force: true }))
  await execa('git', ['init', '-q'], { cwd: repository })
  await execa('git', ['remote', 'add', 'origin', 'git@github.com:example/app.git'], { cwd: repository })
  await execa('git', ['remote', 'add', 'upstream', 'https://github.com/example/other.git'], { cwd: repository })

  const matched = await resolveProject({
    repositoryDirectory: repository,
    remotePatterns: ['github.com/example/app'],
  })
  const rejectedSubstring = await resolveProject({
    repositoryDirectory: repository,
    remotePatterns: ['github.com/example'],
  })

  assert.equal(matched.status, 'matched')
  assert.equal(matched.match.name, 'origin')
  assert.equal(rejectedSubstring.status, 'not-found')
})

test('checks every configured URL on the canonical remote and rejects conflicting identities', async (t) => {
  const repository = await mkdtemp(path.join(os.tmpdir(), 'workflow-resolver-multi-url-'))
  t.after(() => rm(repository, { recursive: true, force: true }))
  await execa('git', ['init', '-q'], { cwd: repository })
  await execa('git', ['remote', 'add', 'origin', 'git@github.com:example/app.git'], { cwd: repository })
  await execa('git', ['remote', 'set-url', '--push', 'origin', 'git@github.com:example/other.git'], { cwd: repository })

  const rejectedMixedIdentity = await resolveProject({
    repositoryDirectory: repository,
    remotePatterns: ['github.com/example/app'],
  })
  const ambiguous = await resolveProject({
    repositoryDirectory: repository,
    remotePatterns: ['github.com/example/app', 'github.com/example/other'],
  })

  assert.equal(rejectedMixedIdentity.status, 'not-found')
  assert.equal(ambiguous.status, 'ambiguous')
})
