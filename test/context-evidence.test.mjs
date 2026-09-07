import assert from 'node:assert/strict'
import test from 'node:test'
import { validateNodeEvidence } from '../src/context-evidence.mjs'

const context = {
  taskId: 'context-task',
  request: 'Change the documented behavior',
  changedFiles: ['src/feature.mjs', 'records/context-task.md'],
  planningMode: 'inline',
}

test('rejects free-form evidence and preserves the registered request and owned paths', () => {
  assert.equal(validateNodeEvidence({ nodeId: 'intake', evidence: { message: 'done' }, context }).ok, false)
  assert.equal(validateNodeEvidence({
    nodeId: 'intake',
    context,
    evidence: {
      schemaVersion: 1,
      kind: 'intake',
      request: 'a different request',
      ownedPaths: context.changedFiles,
      acceptanceCriteria: ['A visible result'],
    },
  }).error.code, 'INTAKE_REQUEST_MISMATCH')
  assert.equal(validateNodeEvidence({
    nodeId: 'intake',
    context,
    evidence: {
      schemaVersion: 1,
      kind: 'intake',
      request: context.request,
      ownedPaths: ['src/feature.mjs'],
      acceptanceCriteria: ['A visible result'],
    },
  }).error.code, 'INTAKE_OWNED_PATHS_MISMATCH')
})

test('rejects planning and implementation evidence that expands the Run scope', () => {
  assert.equal(validateNodeEvidence({
    nodeId: 'planning',
    context,
    evidence: {
      schemaVersion: 1,
      kind: 'inline-plan',
      goal: 'Change behavior',
      ownedPaths: [...context.changedFiles, 'src/unowned.mjs'],
      steps: ['Edit the implementation'],
      acceptance: ['The behavior changes'],
      verification: ['node --test'],
    },
  }).error.code, 'PLAN_OWNED_PATHS_MISMATCH')
  assert.equal(validateNodeEvidence({
    nodeId: 'implementation',
    context,
    evidence: {
      schemaVersion: 1,
      kind: 'implementation',
      summary: 'Implemented',
      changedPaths: ['src/unowned.mjs'],
      verificationScope: ['Focused test'],
    },
  }).error.code, 'IMPLEMENTATION_PATH_OUT_OF_SCOPE')
})

test('requires the Run-specific OpenSpec proposal path', () => {
  const openspecContext = { ...context, planningMode: 'openspec' }
  assert.equal(validateNodeEvidence({
    nodeId: 'openspec-contract',
    context: openspecContext,
    evidence: {
      schemaVersion: 1,
      kind: 'openspec-contract',
      proposalPath: 'openspec/changes/another-task/proposal.md',
      behavior: ['New behavior'],
      acceptance: ['Verified behavior'],
    },
  }).error.code, 'OPENSPEC_PATH_MISMATCH')
})

test('accepts legacy rejected assessments but never accepts a numeric score alone', () => {
  const qualityContext = {
    ...context,
    qualityGate: { enabled: true, candidateCount: 3, accuracyThreshold: 0.85 },
  }
  const evidence = {
    schemaVersion: 1, kind: 'quality-assessment', candidateCount: 3, selectedCandidateId: 'candidate-1',
    accuracyScore: 0.8, threshold: 0.85,
    evidence: [{ kind: 'verification', reference: 'focused test passed' }],
    decision: 'accepted',
  }
  assert.equal(validateNodeEvidence({ nodeId: 'quality-assessment', context: qualityContext, evidence }).error.code, 'QUALITY_GATE_DECISION_INVALID')
  assert.equal(validateNodeEvidence({
    nodeId: 'quality-assessment', context: qualityContext,
    evidence: { ...evidence, decision: 'verify-or-clarify' },
  }).ok, true)
})
