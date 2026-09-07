import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_EXECUTION_POLICY,
  DEFAULT_PLANNING_POLICY,
  resolveWorkflowModes,
} from '../src/planning-policy.mjs'

test('uses inline planning and single-pass execution by default', () => {
  const result = resolveWorkflowModes({
    planningPolicy: DEFAULT_PLANNING_POLICY,
    executionPolicy: DEFAULT_EXECUTION_POLICY,
    signals: [],
    automatedFeedbackAvailable: true,
  })

  assert.equal(result.ok, true)
  assert.equal(result.planningMode, 'inline')
  assert.equal(result.executionMode, 'single-pass')
})

test('long work selects a structured plan but does not trigger a loop by itself', () => {
  const result = resolveWorkflowModes({
    planningPolicy: DEFAULT_PLANNING_POLICY,
    executionPolicy: DEFAULT_EXECUTION_POLICY,
    signals: ['LONG_RUNNING_IMPLEMENTATION'],
    automatedFeedbackAvailable: true,
  })

  assert.equal(result.planningMode, 'structured')
  assert.equal(result.executionMode, 'single-pass')
})

test('contract signals require OpenSpec planning', () => {
  const result = resolveWorkflowModes({
    planningPolicy: DEFAULT_PLANNING_POLICY,
    executionPolicy: DEFAULT_EXECUTION_POLICY,
    signals: ['API_CONTRACT_CHANGE', 'MULTI_STEP'],
    automatedFeedbackAvailable: true,
  })

  assert.equal(result.planningMode, 'openspec')
  assert.match(result.reasons.join('\n'), /API_CONTRACT_CHANGE/)
})

test('iterative acceptance enters loop mode only with automated feedback', () => {
  const withoutFeedback = resolveWorkflowModes({
    planningPolicy: DEFAULT_PLANNING_POLICY,
    executionPolicy: DEFAULT_EXECUTION_POLICY,
    signals: ['ITERATIVE_ACCEPTANCE'],
    automatedFeedbackAvailable: false,
  })
  const withFeedback = resolveWorkflowModes({
    planningPolicy: DEFAULT_PLANNING_POLICY,
    executionPolicy: DEFAULT_EXECUTION_POLICY,
    signals: ['ITERATIVE_ACCEPTANCE'],
    automatedFeedbackAvailable: true,
  })

  assert.equal(withoutFeedback.executionMode, 'single-pass')
  assert.equal(withFeedback.executionMode, 'loop')
})

test('blocked signals prevent loop execution', () => {
  const result = resolveWorkflowModes({
    planningPolicy: DEFAULT_PLANNING_POLICY,
    executionPolicy: DEFAULT_EXECUTION_POLICY,
    signals: ['LOOP_REQUESTED', 'REQUIREMENT_UNCLEAR'],
    automatedFeedbackAvailable: true,
  })

  assert.equal(result.executionMode, 'single-pass')
  assert.match(result.reasons.join('\n'), /REQUIREMENT_UNCLEAR/)
})

test('explicit modes may escalate planning and request an eligible loop', () => {
  const result = resolveWorkflowModes({
    planningPolicy: DEFAULT_PLANNING_POLICY,
    executionPolicy: DEFAULT_EXECUTION_POLICY,
    signals: [],
    requestedPlanningMode: 'structured',
    requestedExecutionMode: 'loop',
    automatedFeedbackAvailable: true,
  })

  assert.equal(result.ok, true)
  assert.equal(result.planningMode, 'structured')
  assert.equal(result.executionMode, 'loop')
})

test('explicit planning cannot downgrade a required OpenSpec contract', () => {
  const result = resolveWorkflowModes({
    planningPolicy: DEFAULT_PLANNING_POLICY,
    executionPolicy: DEFAULT_EXECUTION_POLICY,
    signals: ['AUTH_OR_SECURITY_CHANGE'],
    requestedPlanningMode: 'inline',
    automatedFeedbackAvailable: true,
  })

  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'PLANNING_MODE_DOWNGRADE_FORBIDDEN')
})
