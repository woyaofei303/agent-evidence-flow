import test from 'node:test'
import assert from 'node:assert/strict'
import { assessUnattendedStart, detectUnattendedRequest } from '../src/unattended-policy.mjs'

test('detects unattended keywords', () => {
  assert.deepEqual(detectUnattendedRequest('请进入无人值守状态'), { enabled: true, matched: ['无人值守'] })
  assert.equal(detectUnattendedRequest('run unattended').enabled, true)
  assert.equal(detectUnattendedRequest('普通任务').enabled, false)
})

test('requires eligibility before unattended mode', () => {
  assert.equal(assessUnattendedStart({ request: '无人值守', changedFiles: ['src/a.js'], automatedVerificationAvailable: true }).status, 'eligible')
  const blocked = assessUnattendedStart({ request: '无人值守', changedFiles: [], signals: ['SENSITIVE_OPERATION'], automatedVerificationAvailable: false })
  assert.equal(blocked.status, 'needs-confirmation')
  assert.equal(blocked.blockers.length, 3)
})
