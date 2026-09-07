import { resolveProject } from './project-resolver.mjs'

function identitySummary(resolution) {
  return {
    status: resolution.status,
    canonicalRemote: resolution.canonical
      ? { name: resolution.canonical.name, normalized: resolution.canonical.normalized }
      : null,
    matchedRemote: resolution.match
      ? { name: resolution.match.name, normalized: resolution.match.normalized }
      : null,
  }
}

export async function captureRunContext({ git, repositoryDirectory, governance }) {
  const repository = await git.assertRepository()
  if (!repository.ok) {
    return {
      ok: true,
      context: { schemaVersion: 1, repository: { status: 'not-a-git-repository' } },
    }
  }

  const [headSha, changedPaths, identity] = await Promise.all([
    git.headSha(),
    git.listChangedPaths(),
    resolveProject({
      repositoryDirectory,
      remotePatterns: governance?.remotePatterns ?? [],
      canonicalRemote: governance?.canonicalRemote ?? 'origin',
      matchAllRemotes: governance?.matchAllRemotes ?? false,
    }),
  ])
  if (governance?.remotePatterns?.length > 0 && identity.status !== 'matched') {
    return {
      ok: false,
      error: {
        code: 'PROJECT_IDENTITY_UNVERIFIED',
        message: 'Configured governance remotePatterns did not match this repository',
        identity: identitySummary(identity),
      },
    }
  }
  return {
    ok: true,
    context: {
      schemaVersion: 1,
      repository: {
        status: 'git',
        root: repository.root,
        headSha,
        changedPaths,
        identity: identitySummary(identity),
      },
    },
  }
}
