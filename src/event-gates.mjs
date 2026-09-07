function makeEvidence(signal, source, details = {}) {
  return { signal, source, confidence: source === 'operator' ? 'declared' : 'deterministic', ...details }
}

export function deriveEventGates({
  signals = [],
  changedFiles = [],
  repositories = [],
  mode = 'single',
  affectedRepositories = [],
} = {}) {
  const normalized = new Set(signals)
  const evidence = signals.map((signal) => makeEvidence(signal, 'operator'))
  const touched = repositories.filter((repository) =>
    affectedRepositories.includes(repository.id) || changedFiles.some((file) => file === repository.path || file.startsWith(repository.path + '/')))
  if (mode === 'workspace' && touched.length > 1) {
    normalized.add('CROSS_REPO_AFFECTED')
    evidence.push(makeEvidence('CROSS_REPO_AFFECTED', 'deterministic', { repositories: touched.map((item) => item.id) }))
  }
  if (normalized.has('CROSS_REPO') || normalized.has('CROSS_REPO_AFFECTED')) {
    for (const signal of ['CROSS_REPO', 'CROSS_REPO_AFFECTED']) {
      if (!normalized.has(signal)) evidence.push(makeEvidence(signal, 'deterministic'))
      normalized.add(signal)
    }
  }
  return { signals: [...normalized].sort(), evidence }
}
