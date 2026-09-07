import assert from 'node:assert/strict'
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import test from 'node:test'
import { installWorkflow } from '../src/workflow-installer.mjs'
import { parse } from 'yaml'

const execFile = promisify(execFileCallback)
const sourceDirectory = path.resolve(import.meta.dirname, '..')

async function createTarget() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'workflow-installer-'))
  await execFile('git', ['init', '-q'], { cwd: directory })
  await mkdir(path.join(directory, '.claude'), { recursive: true })
  await mkdir(path.join(directory, '.agents'), { recursive: true })
  await writeFile(path.join(directory, 'AGENTS.md'), '# Existing business rules\n', 'utf8')
  await writeFile(path.join(directory, 'CLAUDE.md'), '# Existing Claude notes\n', 'utf8')
  await writeFile(path.join(directory, '.agents', 'legacy.md'), 'legacy\n', 'utf8')
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({
    name: 'target-web',
    scripts: { build: 'vite build' },
    dependencies: { vue: '^3.0.0' },
  }, null, 2) + '\n', 'utf8')
  await writeFile(path.join(directory, '.claude', 'settings.json'), JSON.stringify({
    hooks: {
      Notification: [{ hooks: [{ type: 'command', command: 'notify-me' }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'bash .agents/scripts/session-stop.sh' }] }],
    },
  }, null, 2) + '\n', 'utf8')
  await writeFile(path.join(directory, '.gitignore'), 'dist/\n', 'utf8')
  return directory
}

async function createWorkspace() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'workflow-parent-'))
  const repositories = [
    {
      path: 'web',
      files: {
        'package.json': JSON.stringify({ name: 'web', scripts: { build: 'vite build' }, dependencies: { vue: '*' } }),
        'AGENTS.md': '# Web rules\nRun `.agents/scripts/check.sh` before completion.\n',
      },
    },
    {
      path: 'api',
      files: {
        'Cargo.toml': '[package]\nname = "api"\nversion = "0.1.0"\n',
        'AGENTS.md': '# API rules\n',
      },
    },
  ]
  for (const repository of repositories) {
    const child = path.join(directory, repository.path)
    await mkdir(child, { recursive: true })
    await execFile('git', ['init', '-q'], { cwd: child })
    await Promise.all(Object.entries(repository.files).map(([name, contents]) =>
      writeFile(path.join(child, name), contents, 'utf8')))
  }
  await mkdir(path.join(directory, 'web', '.agents', 'scripts'), { recursive: true })
  await writeFile(path.join(directory, 'web', '.agents', 'scripts', 'check.sh'), '#!/bin/sh\n', 'utf8')
  return directory
}

async function exists(filePath) {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

test('dry-run detects and plans without writing target files', async (t) => {
  const target = await createTarget()
  t.after(() => rm(target, { recursive: true, force: true }))
  const before = await readFile(path.join(target, 'AGENTS.md'), 'utf8')

  const result = await installWorkflow({ sourceDirectory, targetDirectory: target })

  assert.equal(result.mode, 'dry-run')
  assert.deepEqual(result.detection.stacks, ['Node.js', 'Vue'])
  assert.equal(await exists(path.join(target, '.workflow', 'config.yaml')), false)
  assert.equal(await readFile(path.join(target, 'AGENTS.md'), 'utf8'), before)
})

test('distributes executable sources and tests without copying Git metadata', async (t) => {
  const target = await createTarget()
  t.after(() => rm(target, { recursive: true, force: true }))
  await installWorkflow({ sourceDirectory, targetDirectory: target, apply: true, skipInstall: true, skipCheck: true })
  const engine = path.join(target, 'tooling/ai-workflow')
  assert.equal(await exists(path.join(engine, '.git')), false)
  assert.equal(await exists(path.join(engine, 'src/workflow-runtime.mjs')), true)
  assert.equal(await exists(path.join(engine, 'test/cli-workflow.test.mjs')), true)
  for (const name of ['LICENSE', 'NOTICE.md']) {
    assert.equal(await readFile(path.join(engine, name), 'utf8'), await readFile(path.join(sourceDirectory, name), 'utf8'))
  }
})

test('apply preserves project content, merges integrations and is idempotent', async (t) => {
  const target = await createTarget()
  t.after(() => rm(target, { recursive: true, force: true }))

  const options = {
    sourceDirectory,
    targetDirectory: target,
    apply: true,
    skipInstall: true,
    skipCheck: true,
  }
  await installWorkflow(options)
  await installWorkflow(options)

  const agents = await readFile(path.join(target, 'AGENTS.md'), 'utf8')
  const claude = await readFile(path.join(target, 'CLAUDE.md'), 'utf8')
  const gitignore = await readFile(path.join(target, '.gitignore'), 'utf8')
  const settings = JSON.parse(await readFile(path.join(target, '.claude', 'settings.json'), 'utf8'))
  const packageJson = JSON.parse(await readFile(path.join(target, 'package.json'), 'utf8'))
  const settingsText = JSON.stringify(settings)

  assert.match(agents, /# Existing business rules/)
  assert.equal(agents.match(/local-ai-workflow:start/g)?.length, 1)
  assert.match(agents, /Node\.js, Vue/)
  assert.match(agents, /planningMode/)
  assert.match(agents, /Loop Engineering/)
  assert.match(claude, /# Existing Claude notes/)
  assert.match(claude, /@AGENTS\.md/)
  assert.equal(claude.match(/local-ai-workflow-claude:start/g)?.length, 1)
  assert.equal(gitignore.match(/local-ai-workflow:start/g)?.length, 1)
  assert.match(gitignore, /\/\.workflow\/state\//)
  assert.match(settingsText, /notify-me/)
  assert.equal(settingsText.match(/tooling\/ai-workflow\/cli\/workflow\.mjs/g)?.length, 5)
  assert.equal(packageJson.scripts.build, 'vite build')
  assert.equal(packageJson.scripts.workflow, 'node tooling/ai-workflow/cli/workflow.mjs')
  assert.equal(await exists(path.join(target, '.agents', 'legacy.md')), true)
  assert.equal(await exists(path.join(target, 'tooling', 'ai-workflow', 'node_modules')), false)

  const { stdout } = await execFile('git', ['diff', '--cached', '--name-only'], { cwd: target })
  assert.equal(stdout, '')
})

test('removeLegacy deletes only the old workflow directory and hook references', async (t) => {
  const target = await createTarget()
  t.after(() => rm(target, { recursive: true, force: true }))

  await installWorkflow({
    sourceDirectory,
    targetDirectory: target,
    apply: true,
    removeLegacy: true,
    skipInstall: true,
    skipCheck: true,
  })

  const settingsText = await readFile(path.join(target, '.claude', 'settings.json'), 'utf8')
  assert.equal(await exists(path.join(target, '.agents')), false)
  assert.doesNotMatch(settingsText, /\.agents\/scripts/)
  assert.match(settingsText, /tooling\/ai-workflow\/cli\/workflow\.mjs/)
})

test('installs into Flutter repositories without creating package.json', async (t) => {
  const target = await mkdtemp(path.join(os.tmpdir(), 'workflow-installer-flutter-'))
  t.after(() => rm(target, { recursive: true, force: true }))
  await execFile('git', ['init', '-q'], { cwd: target })
  await writeFile(path.join(target, 'pubspec.yaml'), [
    'name: mobile_client',
    'dependencies:',
    '  flutter:',
    '    sdk: flutter',
    '',
  ].join('\n'), 'utf8')

  await installWorkflow({
    sourceDirectory,
    targetDirectory: target,
    apply: true,
    skipInstall: true,
    skipCheck: true,
  })

  const config = await readFile(path.join(target, '.workflow', 'config.yaml'), 'utf8')
  assert.match(config, /projectName: "mobile_client"/)
  assert.equal(parse(config).verification.file, 'flutter')
  assert.match(config, /qualityPolicy:/)
  assert.equal(await exists(path.join(target, 'package.json')), false)
})

test('requires explicit workspace confirmation after scanning a non-Git parent', async (t) => {
  const target = await createWorkspace()
  t.after(() => rm(target, { recursive: true, force: true }))

  await assert.rejects(
    installWorkflow({ sourceDirectory, targetDirectory: target }),
    (error) => error.code === 'WORKSPACE_CONFIRMATION_REQUIRED' && error.repositories.length === 2,
  )
  assert.equal(await exists(path.join(target, '.workflow')), false)
})

test('workspace apply writes only the parent and documents heterogeneous child flows', async (t) => {
  const target = await createWorkspace()
  t.after(() => rm(target, { recursive: true, force: true }))
  const childStatusBefore = await Promise.all(['web', 'api'].map(async (name) =>
    (await execFile('git', ['status', '--short', '--untracked-files=all'], { cwd: path.join(target, name) })).stdout))

  const result = await installWorkflow({
    sourceDirectory,
    targetDirectory: target,
    workspace: true,
    apply: true,
    skipInstall: true,
    skipCheck: true,
  })

  const config = await readFile(path.join(target, '.workflow', 'config.yaml'), 'utf8')
  const agents = await readFile(path.join(target, 'AGENTS.md'), 'utf8')
  const claude = await readFile(path.join(target, 'CLAUDE.md'), 'utf8')
  const cli = path.join(sourceDirectory, 'cli', 'workflow.mjs')
  const repos = JSON.parse((await execFile(process.execPath, [cli, 'repos', '--cwd', target])).stdout)
  const started = JSON.parse((await execFile(process.execPath, [
    cli,
    'start',
    '--cwd',
    target,
    '--repo',
    'web',
    '--task-id',
    'workspace-cli',
    '--request',
    'exercise workspace selection',
    '--changed-file',
    'src/example.ts',
  ])).stdout)
  const childStatusAfter = await Promise.all(['web', 'api'].map(async (name) =>
    (await execFile('git', ['status', '--short', '--untracked-files=all'], { cwd: path.join(target, name) })).stdout))

  assert.equal(result.topology, 'workspace')
  assert.equal(result.heterogeneous, true)
  assert.match(result.warnings.join('\n'), /HETEROGENEOUS_STACKS/)
  assert.match(config, /schemaVersion: 2/)
  assert.match(config, /planningPolicy:/)
  assert.match(config, /openspecSignals:/)
  assert.match(config, /executionPolicy:/)
  assert.match(config, /maxIterations: 6/)
  assert.match(config, /qualityPolicy:/)
  assert.match(config, /path: "web"/)
  assert.match(config, /path: "api"/)
  assert.match(config, /legacyWorkflowStatus: "inactive"/)
  assert.match(config, /"\.agents\/"/)
  assert.match(agents, /异构技术栈特别流程/)
  assert.match(agents, /子仓库旧工作流停用规则/)
  assert.match(agents, /web.*inactive.*\.agents\//)
  assert.match(agents, /--repo <id>/)
  assert.match(agents, /长任务本身不会触发 Loop/)
  assert.match(claude, /@AGENTS\.md/)
  assert.equal(claude.match(/local-ai-workflow-claude:start/g)?.length, 1)
  assert.deepEqual(repos.repositories.map((repository) => repository.id), ['api', 'web'])
  assert.equal(repos.repositories.find((repository) => repository.id === 'web').legacyWorkflowStatus, 'inactive')
  assert.deepEqual(
    repos.repositories.find((repository) => repository.id === 'web').legacyWorkflowEntrypoints,
    ['.agents/', 'AGENTS.md workflow directives'],
  )
  assert.equal(started.ok, true)
  assert.equal(await exists(path.join(target, '.workflow', 'state', 'web', 'runs', 'workspace-cli.json')), true)
  assert.equal(await exists(path.join(target, '.workflow', 'state', 'api')), false)
  assert.deepEqual(childStatusAfter, childStatusBefore)
  assert.match(result.warnings.join('\n'), /CHILD_WORKFLOW_INACTIVE/)
  assert.match(result.warnings.join('\n'), /CHILD_AGENTS_WORKFLOW_CONFLICT/)
  for (const name of ['web', 'api']) {
    assert.equal(await exists(path.join(target, name, 'tooling', 'ai-workflow')), false)
    assert.equal(await exists(path.join(target, name, '.workflow')), false)
  }
})
