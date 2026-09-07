import { execa } from 'execa'

function normalizeRemote(value) {
  let source = String(value ?? '').trim()
  source = source.replace(/\.git\/?$/, '').replace(/\/+$/, '')
  const scp = source.match(/^(?:[^@]+@)?([^:\/]+):(.+)$/)
  if (scp && !source.includes('://')) source = 'ssh://' + scp[1] + '/' + scp[2]
  try {
    const parsed = new URL(source)
    parsed.username = ''
    parsed.password = ''
    parsed.hostname = parsed.hostname.toLowerCase()
    parsed.pathname = parsed.pathname.replace(/\.git\/?$/, '').replace(/\/+$/, '')
    return parsed.hostname + parsed.pathname
  } catch {
    return source.toLowerCase()
  }
}

function result(status, details = {}) {
  return { ok: status === 'matched', status, ...details }
}

export async function readGitRemotes(repositoryDirectory, executable = 'git') {
  const response = await execa(executable, ['remote'], { cwd: repositoryDirectory, reject: false })
  if (response.exitCode !== 0) return result('not-a-repository', { message: response.stderr.trim() })
  const names = response.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)
  const remotes = []
  for (const name of names) {
    const urls = await Promise.all([
      execa(executable, ['remote', 'get-url', '--all', name], { cwd: repositoryDirectory, reject: false }),
      execa(executable, ['remote', 'get-url', '--push', '--all', name], { cwd: repositoryDirectory, reject: false }),
    ])
    for (const url of urls) {
      if (url.exitCode !== 0) continue
      for (const value of url.stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
        remotes.push({ name, url: value, normalized: normalizeRemote(value) })
      }
    }
  }
  return { ok: true, status: remotes.length ? 'ready' : 'no-remote', remotes }
}

export async function resolveProject({
  repositoryDirectory,
  remotePatterns = [],
  canonicalRemote = 'origin',
  matchAllRemotes = false,
  executable = 'git',
} = {}) {
  const listed = await readGitRemotes(repositoryDirectory, executable)
  if (!listed.ok) return listed
  if (listed.remotes.length === 0) return listed
  const selected = listed.remotes.find((remote) => remote.name === canonicalRemote)
    ?? listed.remotes.find((remote) => remote.name === 'origin')
    ?? [...listed.remotes].sort((left, right) => left.name.localeCompare(right.name))[0]
  const candidates = matchAllRemotes ? listed.remotes : listed.remotes.filter((remote) => remote.name === selected.name)
  const normalizedPatterns = remotePatterns.map(normalizeRemote)
  if (normalizedPatterns.length === 0) return result('not-found', { canonical: selected, remotes: listed.remotes })
  const unexpected = candidates.filter((remote) => !normalizedPatterns.includes(remote.normalized))
  if (unexpected.length > 0) {
    return result('not-found', {
      canonical: selected,
      remotes: listed.remotes,
      unexpectedRemotes: unexpected.map((remote) => ({ name: remote.name, normalized: remote.normalized })),
    })
  }
  const matches = candidates.filter((remote) => normalizedPatterns.includes(remote.normalized))
  const distinctMatches = [...new Map(matches.map((remote) => [remote.normalized, remote])).values()]
  if (distinctMatches.length > 1) return result('ambiguous', { canonical: selected, matches: distinctMatches })
  if (distinctMatches.length === 0) return result('not-found', { canonical: selected, remotes: listed.remotes })
  return result('matched', { canonical: selected, match: distinctMatches[0], remotes: listed.remotes })
}

export { normalizeRemote }
