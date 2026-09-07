export const PLANNING_MODES = Object.freeze(['inline', 'structured', 'openspec'])
export const EXECUTION_MODES = Object.freeze(['single-pass', 'loop'])

export const DEFAULT_PLANNING_POLICY = Object.freeze({
  defaultMode: 'inline',
  structuredSignals: Object.freeze([
    'MULTI_STEP',
    'MULTI_COMPONENT',
    'MULTIPLE_ACCEPTANCE_CHECKS',
    'RESUMABLE_TASK',
    'ITERATIVE_IMPLEMENTATION',
    'LONG_RUNNING_IMPLEMENTATION',
  ]),
  openspecSignals: Object.freeze([
    'CROSS_REPO',
    'API_CONTRACT_CHANGE',
    'DATA_MODEL_CHANGE',
    'AUTH_OR_SECURITY_CHANGE',
    'PUBLIC_BEHAVIOR_CHANGE',
    'LONG_LIVED_DESIGN_DECISION',
  ]),
})

export const DEFAULT_EXECUTION_POLICY = Object.freeze({
  defaultMode: 'single-pass',
  loopTriggerSignals: Object.freeze([
    'LOOP_REQUESTED',
    'UNATTENDED',
    'ITERATIVE_ACCEPTANCE',
    'EXPECTED_MULTIPLE_ITERATIONS',
  ]),
  loopBlockedSignals: Object.freeze([
    'REQUIREMENT_UNCLEAR',
    'EXTERNAL_SIDE_EFFECT',
    'SENSITIVE_OPERATION',
  ]),
  maxIterations: 6,
  noProgressLimit: 2,
  timeBudgetMinutes: 60,
})

function matchingSignals(signals, candidates) {
  const signalSet = new Set(signals)
  return candidates.filter((signal) => signalSet.has(signal))
}

function requiredPlanningMode(policy, signals) {
  const openspecMatches = matchingSignals(signals, policy.openspecSignals)
  if (openspecMatches.length > 0) return { mode: 'openspec', matches: openspecMatches }

  const structuredMatches = matchingSignals(signals, policy.structuredSignals)
  if (structuredMatches.length > 0) return { mode: 'structured', matches: structuredMatches }

  return { mode: policy.defaultMode, matches: [] }
}

function planningRank(mode) {
  return PLANNING_MODES.indexOf(mode)
}

export function resolveWorkflowModes({
  planningPolicy = DEFAULT_PLANNING_POLICY,
  executionPolicy = DEFAULT_EXECUTION_POLICY,
  signals = [],
  requestedPlanningMode,
  requestedExecutionMode,
  automatedFeedbackAvailable = false,
}) {
  const normalizedSignals = [...new Set(signals)].sort()
  const required = requiredPlanningMode(planningPolicy, normalizedSignals)
  const planningMode = requestedPlanningMode ?? required.mode

  if (!PLANNING_MODES.includes(planningMode)) {
    return {
      ok: false,
      error: {
        code: 'INVALID_PLANNING_MODE',
        message: `Unsupported planning mode: ${String(planningMode)}`,
      },
    }
  }
  if (planningRank(planningMode) < planningRank(required.mode)) {
    return {
      ok: false,
      error: {
        code: 'PLANNING_MODE_DOWNGRADE_FORBIDDEN',
        message: `${required.mode} planning is required by signals: ${required.matches.join(', ')}`,
        requiredMode: required.mode,
        matchingSignals: required.matches,
      },
    }
  }

  if (requestedExecutionMode && !EXECUTION_MODES.includes(requestedExecutionMode)) {
    return {
      ok: false,
      error: {
        code: 'INVALID_EXECUTION_MODE',
        message: `Unsupported execution mode: ${String(requestedExecutionMode)}`,
      },
    }
  }

  const loopTriggers = matchingSignals(normalizedSignals, executionPolicy.loopTriggerSignals)
  const loopBlockers = matchingSignals(normalizedSignals, executionPolicy.loopBlockedSignals)
  const automaticLoop =
    loopTriggers.length > 0 && automatedFeedbackAvailable && loopBlockers.length === 0
  let executionMode = requestedExecutionMode ?? (automaticLoop ? 'loop' : executionPolicy.defaultMode)
  const reasons = []

  reasons.push(
    required.matches.length > 0
      ? `planning mode ${planningMode}: matched ${required.matches.join(', ')}`
      : `planning mode ${planningMode}: default or explicit selection`,
  )

  if (executionMode === 'loop' && !automatedFeedbackAvailable) {
    executionMode = 'single-pass'
    reasons.push('loop disabled: no automated verification feedback is configured')
  } else if (executionMode === 'loop' && loopBlockers.length > 0) {
    executionMode = 'single-pass'
    reasons.push(`loop disabled: blocked by ${loopBlockers.join(', ')}`)
  } else if (executionMode === 'loop') {
    reasons.push(
      loopTriggers.length > 0
        ? `loop enabled: matched ${loopTriggers.join(', ')}`
        : 'loop enabled: explicit selection with automated feedback',
    )
  } else if (loopBlockers.length > 0) {
    reasons.push(`single-pass execution: loop blocked by ${loopBlockers.join(', ')}`)
  } else if (loopTriggers.length > 0) {
    reasons.push('single-pass execution: loop trigger lacks automated feedback')
  } else {
    reasons.push('single-pass execution: no loop trigger matched')
  }

  return {
    ok: true,
    planningMode,
    executionMode,
    loop: {
      maxIterations: executionPolicy.maxIterations,
      noProgressLimit: executionPolicy.noProgressLimit,
      timeBudgetMinutes: executionPolicy.timeBudgetMinutes,
    },
    signals: normalizedSignals,
    reasons,
  }
}
