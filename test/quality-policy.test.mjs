import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveQualityGate } from '../src/quality-policy.mjs'

const policy = {
  enabled: true,
  highRiskSignals: ['AUTH_OR_SECURITY_CHANGE'],
  negativeFeedbackSignals: ['USER_DISSATISFACTION'],
  candidateCount: 3,
  accuracyThreshold: 0.85,
}

test('enables a quality gate for configured high-risk and negative-feedback signals', () => {
  const highRisk = resolveQualityGate({ policy, signals: ['AUTH_OR_SECURITY_CHANGE'] })
  assert.equal(highRisk.enabled, true)
  assert.deepEqual(highRisk.triggers, [{ signal: 'AUTH_OR_SECURITY_CHANGE', source: 'high-risk' }])
  const feedback = resolveQualityGate({ policy, signals: ['USER_DISSATISFACTION'] })
  assert.equal(feedback.enabled, true)
  assert.equal(feedback.triggers[0].source, 'negative-feedback')
})

test('does not infer a quality gate for projects where initialization did not enable it', () => {
  assert.equal(resolveQualityGate({ signals: ['AUTH_OR_SECURITY_CHANGE'] }).enabled, false)
})
