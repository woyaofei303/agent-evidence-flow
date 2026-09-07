import { execFile as execFileCallback } from 'node:child_process'
import { access, readFile, readdir, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { detectProject } from './project-detector.mjs'

const execFile = promisify(execFileCallback)
const ignoredDirectories = new Set([
  '.dart_tool',
  '.git',
  '.gradle',
  '.workflow',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'target',
])

function topologyError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, ...details })
}

async function gitRoot(directory) {
  try {
    const { stdout } = await execFile('git', ['rev-parse', '--show-toplevel'], { cwd: directory })
    return await realpath(stdout.trim())
  } catch {
    return null
  }
}

async function hasGitMarker(directory) {
  try {
    await access(path.join(directory, '.git'))
    return true
  } catch {
    return false
  }
}

async function exists(candidate) {
  try {
    await access(candidate)
    return true
  } catch {
    return false
  }
}

async function readOptional(candidate) {
  try {
    return await readFile(candidate, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return ''
    throw error
  }
}

async function detectLegacyWorkflow(directory) {
  const detectedEntrypoints = []
  const candidates = [
    ['.agents/', path.join(directory, '.agents')],
    ['.workflow/config.yaml', path.join(directory, '.workflow', 'config.yaml')],
    ['tooling/ai-workflow/', path.join(directory, 'tooling', 'ai-workflow')],
    ['public/workflow/', path.join(directory, 'public', 'workflow')],
  ]
  for (const [label, candidate] of candidates) {
    if (await exists(candidate)) detectedEntrypoints.push(label)
  }

  const settings = await readOptional(path.join(directory, '.claude', 'settings.json'))
  if (/\.agents\/|tooling\/ai-workflow\/cli\/workflow\.mjs|public\/workflow\//.test(settings)) {
    detectedEntrypoints.push('.claude/settings.json workflow hooks')
  }
  const agents = await readOptional(path.join(directory, 'AGENTS.md'))
  const instructionConflict = /\.agents\/|tooling\/ai-workflow|public\/workflow|\bworkflow\s+(?:start|status|resume|commit)\b/i.test(agents)
  if (instructionConflict) detectedEntrypoints.push('AGENTS.md workflow directives')

  return {
    status: 'inactive',
    detectedEntrypoints,
    instructionConflict,
  }
}

function repositoryId(relativePath) {
  return relativePath.replaceAll(path.sep, '-').replace(/[^a-zA-Z0-9._-]+/g, '-').toLowerCase()
}

export async function scanWorkspaceRepositories(workspaceDirectory, { maxDepth = 4 } = {}) {
  const root = await realpath(workspaceDirectory)
  const found = []

  async function visit(directory, depth) {
    if (depth >= maxDepth) return
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || ignoredDirectories.has(entry.name)) continue
      const child = path.join(directory, entry.name)
      const relativeChild = path.relative(root, child).split(path.sep).join('/')
      if (relativeChild === 'tooling/ai-workflow') continue
      if (await hasGitMarker(child)) {
        const resolvedRoot = await gitRoot(child)
        if (resolvedRoot === await realpath(child)) found.push(child)
        continue
      }
      await visit(child, depth + 1)
    }
  }

  await visit(root, 0)
  const repositories = await Promise.all(found.map(async (directory) => {
    const relativePath = path.relative(root, directory)
    return {
      id: repositoryId(relativePath),
      path: relativePath.split(path.sep).join('/'),
      detection: await detectProject(directory),
      legacyWorkflow: await detectLegacyWorkflow(directory),
    }
  }))
  return repositories.sort((left, right) => left.path.localeCompare(right.path))
}

export async function inspectTargetTopology(targetDirectory) {
  const info = await stat(targetDirectory).catch(() => null)
  if (!info?.isDirectory()) {
    throw topologyError('TARGET_NOT_FOUND', `Target directory does not exist: ${targetDirectory}`)
  }
  const target = await realpath(targetDirectory)
  const containingRoot = await gitRoot(target)
  if (containingRoot === target) {
    return { mode: 'single', repositoryDirectory: target }
  }
  if (containingRoot !== null) {
    throw topologyError(
      'TARGET_NOT_GIT_ROOT',
      `Target is inside a Git repository but is not its root: ${containingRoot}`,
      { repositoryDirectory: containingRoot },
    )
  }

  const repositories = await scanWorkspaceRepositories(target)
  if (repositories.length === 0) {
    throw topologyError('NO_GIT_REPOSITORIES', `No child Git repositories found under: ${target}`)
  }
  const signatures = new Set(repositories.map((repository) =>
    [...repository.detection.stacks].sort().join('|')))
  const heterogeneous = signatures.size > 1
  const warnings = heterogeneous
    ? [
        `[HETEROGENEOUS_STACKS] Detected ${signatures.size} different stack profiles across ` +
        `${repositories.length} repositories. Select every run with --repo and keep repository-specific verification.`,
      ]
    : []
  for (const repository of repositories) {
    if (repository.legacyWorkflow.detectedEntrypoints.length > 0) {
      warnings.push(
        `[CHILD_WORKFLOW_INACTIVE] ${repository.id}: detected ` +
        `${repository.legacyWorkflow.detectedEntrypoints.join(', ')}. Parent Workspace remains the only active engine; child files were not modified.`,
      )
    }
    if (repository.legacyWorkflow.instructionConflict) {
      warnings.push(
        `[CHILD_AGENTS_WORKFLOW_CONFLICT] ${repository.id}: child AGENTS.md contains workflow directives. ` +
        'Treat them as stale in parent-managed sessions; migrate that file before running an agent directly inside the child repository.',
      )
    }
  }
  return {
    mode: 'workspace-candidate',
    workspaceDirectory: target,
    repositories,
    heterogeneous,
    warnings,
  }
}
