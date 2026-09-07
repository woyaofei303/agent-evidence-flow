import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { detectProject } from '../src/project-detector.mjs'
import { verificationChecks } from '../src/verification-policy.mjs'

async function fixture(files) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'workflow-detector-'))
  await Promise.all(Object.entries(files).map(([name, contents]) =>
    writeFile(path.join(directory, name), contents, 'utf8')))
  return directory
}

test('uses an existing comprehensive check or combines independent verification scripts', async (t) => {
  const directory = await fixture({ 'package.json': JSON.stringify({ scripts: { check: 'node --test', test: 'node --test', lint: 'biome check .' } }) })
  t.after(() => rm(directory, { recursive: true, force: true }))
  assert.deepEqual((await detectProject(directory)).verification.args, ['run', 'check'])
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ scripts: { test: 'node --test', lint: 'biome check .', typecheck: 'tsc --noEmit', build: 'vite build' } }))
  const combined = await detectProject(directory)
  assert.deepEqual(combined.verification.checks.map((check) => check.id), ['lint', 'typecheck', 'test', 'build'])
  assert.equal(combined.verification.checks.find((check) => check.id === 'test').coverage, 'behavior')
  assert.deepEqual(verificationChecks({ governance: { commands: {
    test: { file: 'node', args: ['--test'] }, release: { file: 'npm', args: ['publish'] },
  } } }).map((check) => check.id), ['test'])
})

test('detects a pnpm Vue repository and its existing build command', async (t) => {
  const directory = await fixture({
    'package.json': JSON.stringify({
      name: 'web-console',
      scripts: { build: 'vite build' },
      dependencies: { vue: '^3.0.0' },
    }),
    'pnpm-lock.yaml': 'lockfileVersion: 9\n',
  })
  t.after(() => rm(directory, { recursive: true, force: true }))

  const result = await detectProject(directory)

  assert.equal(result.projectName, 'web-console')
  assert.equal(result.packageManager, 'pnpm')
  assert.deepEqual(result.stacks, ['Node.js', 'Vue'])
  assert.deepEqual(result.verification, { file: 'pnpm', args: ['build'], timeoutMs: 120_000 })
})

test('detects Flutter without requiring a package.json', async (t) => {
  const directory = await fixture({
    'pubspec.yaml': 'name: field_app\ndependencies:\n  flutter:\n    sdk: flutter\n',
  })
  t.after(() => rm(directory, { recursive: true, force: true }))

  const result = await detectProject(directory)

  assert.equal(result.projectName, 'field_app')
  assert.deepEqual(result.stacks, ['Dart', 'Flutter'])
  assert.deepEqual(result.verification, { file: 'flutter', args: ['test'], timeoutMs: 300_000 })
})

test('detects backend and polyglot manifests deterministically', async (t) => {
  const directory = await fixture({
    'Cargo.toml': '[package]\nname = "event-api"\nversion = "0.1.0"\n',
    'go.mod': 'module example.com/sidecar\n\ngo 1.23\n',
  })
  t.after(() => rm(directory, { recursive: true, force: true }))

  const result = await detectProject(directory)

  assert.equal(result.projectName, 'event-api')
  assert.deepEqual(result.stacks, ['Rust', 'Go'])
  assert.deepEqual(result.verification, { file: 'cargo', args: ['test'], timeoutMs: 300_000 })
})

test('detects Java Gradle projects and prefers the repository wrapper', async (t) => {
  const directory = await fixture({
    'settings.gradle': "rootProject.name = 'orders-service'\n",
    'build.gradle': "plugins { id 'java' }\n",
    gradlew: '#!/bin/sh\n',
  })
  t.after(() => rm(directory, { recursive: true, force: true }))

  const result = await detectProject(directory)

  assert.equal(result.projectName, 'orders-service')
  assert.deepEqual(result.stacks, ['Java/JVM', 'Gradle'])
  assert.deepEqual(result.verification, { file: './gradlew', args: ['test'], timeoutMs: 300_000 })
})

test('detects Java Maven projects and derives artifactId', async (t) => {
  const directory = await fixture({
    'pom.xml': '<project><modelVersion>4.0.0</modelVersion><artifactId>billing-api</artifactId></project>\n',
  })
  t.after(() => rm(directory, { recursive: true, force: true }))

  const result = await detectProject(directory)

  assert.equal(result.projectName, 'billing-api')
  assert.deepEqual(result.stacks, ['Java/JVM', 'Maven'])
  assert.deepEqual(result.verification, { file: 'mvn', args: ['test'], timeoutMs: 300_000 })
})
