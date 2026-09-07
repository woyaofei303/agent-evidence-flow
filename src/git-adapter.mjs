import path from 'node:path'
import { execa } from 'execa'

function gitError(code, message, details = {}) {
  return { ok: false, error: { code, message, ...details } }
}

function parseNullSeparated(value) {
  return value.split('\0').filter(Boolean)
}

export function normalizeRepositoryPaths(paths) {
  if (!Array.isArray(paths) || paths.length === 0) {
    return gitError('EMPTY_GIT_PATHS', 'At least one exact repository-relative path is required')
  }

  const normalized = []
  for (const candidate of paths) {
    if (
      typeof candidate !== 'string' ||
      candidate.length === 0 ||
      candidate.includes('\0') ||
      path.isAbsolute(candidate)
    ) {
      return gitError('UNSAFE_GIT_PATH', `Unsafe Git path: ${String(candidate)}`)
    }

    const clean = path.posix.normalize(candidate.replaceAll('\\', '/'))
    if (clean === '..' || clean.startsWith('../') || clean === '.') {
      return gitError('UNSAFE_GIT_PATH', `Unsafe Git path: ${candidate}`)
    }
    normalized.push(clean)
  }

  return { ok: true, paths: [...new Set(normalized)].sort() }
}

export function createGitAdapter({
  repositoryDirectory,
  writerLock,
  executable = 'git',
}) {
  const cwd = path.resolve(repositoryDirectory)

  async function run(args, { reject = true } = {}) {
    return execa(executable, args, {
      cwd,
      reject,
      extendEnv: true,
      stripFinalNewline: false,
    })
  }

  async function listFrom(args) {
    const result = await run(args)
    return parseNullSeparated(result.stdout).sort()
  }

  async function assertRepository() {
    const result = await run(['rev-parse', '--show-toplevel'], { reject: false })
    if (result.exitCode !== 0) {
      return gitError('NOT_A_GIT_REPOSITORY', result.stderr.trim() || 'Not a Git repository')
    }
    return { ok: true, root: path.resolve(result.stdout.trim()) }
  }

  async function listStagedPaths() {
    return listFrom(['diff', '--cached', '--name-only', '-z', '--'])
  }

  async function listChangedPaths() {
    const [unstaged, staged, untracked] = await Promise.all([
      listFrom(['diff', '--name-only', '-z', '--']),
      listStagedPaths(),
      listFrom(['ls-files', '--others', '--exclude-standard', '-z', '--']),
    ])
    return [...new Set([...unstaged, ...staged, ...untracked])].sort()
  }

  async function stagedDiff() {
    const result = await run(['diff', '--cached', '--no-ext-diff', '--binary', '--'])
    return result.stdout
  }

  async function stageExact(paths, { capability } = {}) {
    const lock = writerLock?.assertHeld(capability)
    if (!lock?.ok) return lock ?? gitError('WRITER_LOCK_REQUIRED', 'Writer lock is not configured')
    const validated = normalizeRepositoryPaths(paths)
    if (!validated.ok) return validated

    const result = await run(['add', '-A', '--', ...validated.paths], { reject: false })
    if (result.exitCode !== 0) {
      return gitError('GIT_STAGE_FAILED', result.stderr.trim(), { paths: validated.paths })
    }
    return { ok: true, paths: validated.paths }
  }

  async function headSha() {
    const result = await run(['rev-parse', 'HEAD'], { reject: false })
    return result.exitCode === 0 ? result.stdout.trim() : null
  }

  async function writeTree({ capability } = {}) {
    const lock = writerLock?.assertHeld(capability)
    if (!lock?.ok) return lock ?? gitError('WRITER_LOCK_REQUIRED', 'Writer lock is not configured')
    const result = await run(['write-tree'], { reject: false })
    return result.exitCode === 0
      ? { ok: true, tree: result.stdout.trim() }
      : gitError('GIT_WRITE_TREE_FAILED', result.stderr.trim())
  }

  async function commit(message, { capability } = {}) {
    const lock = writerLock?.assertHeld(capability)
    if (!lock?.ok) return lock ?? gitError('WRITER_LOCK_REQUIRED', 'Writer lock is not configured')
    const result = await run(['commit', '--no-gpg-sign', '-m', message], { reject: false })
    return result.exitCode === 0
      ? { ok: true, commitSha: await headSha(), stdout: result.stdout }
      : gitError('GIT_COMMIT_FAILED', result.stderr.trim() || result.stdout.trim())
  }

  async function commitMetadata(reference = 'HEAD') {
    const result = await run(
      ['show', '-s', '--format=%H%x00%P%x00%T%x00%B', reference],
      { reject: false },
    )
    if (result.exitCode !== 0) return null
    const [commitSha, parents, tree, ...messageParts] = result.stdout.split('\0')
    return {
      commitSha,
      parents: parents.split(' ').filter(Boolean),
      tree,
      message: messageParts.join('\0').trimEnd(),
    }
  }

  async function commitPaths(reference = 'HEAD') {
    return listFrom([
      'diff-tree',
      '--root',
      '--no-commit-id',
      '--name-only',
      '-r',
      '-z',
      reference,
      '--',
    ])
  }

  return {
    assertRepository,
    commit,
    commitMetadata,
    commitPaths,
    headSha,
    listChangedPaths,
    listStagedPaths,
    stageExact,
    stagedDiff,
    writeTree,
  }
}
