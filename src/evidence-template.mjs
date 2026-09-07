import { verificationChecks, verificationDescription } from './verification-policy.mjs'

export function latestNodeEvidence(record, nodeId) {
  const invalidatedAt = record.events.filter((event) => event.type === 'RUN_REPAIR_REQUESTED' && event.evidence.invalidatedNodes.includes(nodeId)).at(-1)?.sequence ?? 0
  return record.events.filter((event) => event.sequence > invalidatedAt && event.nodeId === nodeId && event.eventType === 'NODE_SUCCEEDED').at(-1)
}

export function draftEvidence(record, nodeId, config) {
  const context = record.plan.context
  const intake = latestNodeEvidence(record, 'intake')?.evidence
  const acceptance = intake?.acceptanceCriteria ?? ['']
  const verification = (context.verificationChecks ?? verificationChecks(config)).map((check) => verificationDescription(check))
  const base = { schemaVersion: 1 }
  const ownedPaths = context.changedFiles
  const implementationPaths = ownedPaths.filter((item) => item !== `openspec/changes/${context.taskId}/proposal.md` && item !== config.sedimentPath)
  const verified = latestNodeEvidence(record, 'verification')
  const templates = {
    'bugfix-intake': { ...base, kind: 'bugfix-intake', symptom: '', impact: '', rollback: '', verificationLimits: [''] },
    'cross-repo-parity': { ...base, kind: 'cross-repo-parity', repositories: (context.affectedRepositories?.length ? context.affectedRepositories : ['', '']).map(repository => ({ repository, reference: '', compatible: false })) },
    intake: { ...base, kind: 'intake', request: context.request, ownedPaths, acceptanceCriteria: acceptance, assumptions: [] },
    planning: context.planningMode === 'inline'
      ? { ...base, kind: 'inline-plan', goal: context.request, ownedPaths, steps: [''], acceptance, verification, risks: [] }
      : { ...base, kind: 'structured-plan', goal: context.request, ownedPaths, constraints: [], tasks: acceptance.map((criterion, index) => ({ id: `task-${index + 1}`, description: '', acceptance: criterion })), verification, risks: [] },
    'openspec-contract': { ...base, kind: 'openspec-contract', proposalPath: `openspec/changes/${context.taskId}/proposal.md`, behavior: [''], acceptance, compatibility: [] },
    implementation: { ...base, kind: 'implementation', summary: '', changedPaths: implementationPaths, verificationScope: acceptance, residualRisks: [] },
    'quality-assessment': {
      ...base, kind: 'quality-assessment',
      ...(context.qualityGate?.compareCandidates !== false ? { candidateCount: context.qualityGate?.candidateCount,
        candidates: Array.from({ length: context.qualityGate?.candidateCount ?? 2 }, (_, index) => ({ id: `candidate-${index + 1}`, summary: '' })), selectedCandidateId: '' } : {}),
      checks: acceptance.map((criterion) => ({ criterion, passed: false, reference: '', eventSequence: verified?.sequence ?? 0 })),
      evidence: [{ kind: 'verification', reference: `Run event ${verified?.sequence ?? 'pending'}` }], decision: 'verify-or-clarify',
    },
    sediment: {
      summary: latestNodeEvidence(record, 'implementation')?.evidence.summary ?? '',
      verification: verified ? (verified.evidence.checks ?? [verified.evidence]).map((check) => `${check.id ?? 'verification'}: exit ${check.exitCode ?? 'skipped'} (Run event ${verified.sequence})`) : [],
      ...(context.signals.includes('PRODUCTION_BUG') ? { symptom: '', rootCause: '', fix: '', risk: '' } : {}),
    },
    'atomic-commit-plan': { ...base, kind: 'atomic-commit-plan', commitPlan: { schemaVersion: 1, runId: record.runId, groups: [{ id: 'change', message: '', paths: ownedPaths }] } },
  }
  const evidence = templates[nodeId]
  if (!evidence) return { ok: false, error: { code: 'EVIDENCE_TEMPLATE_UNAVAILABLE', message: `Use the dedicated command for ${nodeId}` } }
  const missing = (value, prefix = '') => Object.entries(value).flatMap(([key, item]) => {
    const field = prefix ? `${prefix}.${key}` : key
    return item === '' ? [field] : item && typeof item === 'object' ? missing(item, field) : []
  })
  return { ok: true, nodeId, evidence, requiredFields: missing(evidence) }
}
