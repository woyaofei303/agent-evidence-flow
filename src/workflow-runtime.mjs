import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { createVerificationAdapter } from './command-adapter.mjs'
import { hasBehaviorVerification, verificationChecks } from './verification-policy.mjs'
import { createCommitExecutor } from './commit-executor.mjs'
import { deriveEventGates } from './event-gates.mjs'
import { validateNodeEvidence } from './context-evidence.mjs'
import { createGitAdapter, normalizeRepositoryPaths } from './git-adapter.mjs'
import { createJsonEventStore } from './json-event-store.mjs'
import { createFileLeaseManager } from './lease-manager.mjs'
import { compileExecutionPlan } from './planner.mjs'
import { resolveWorkflowModes } from './planning-policy.mjs'
import { createRepositoryWriterLock } from './repository-writer-lock.mjs'
import { captureRunContext } from './run-context.mjs'
import { createRunner } from './runner.mjs'
import { createSedimentAdapter, findRelatedSediment } from './sediment-adapter.mjs'
import { createShadowMode } from './shadow-mode.mjs'
import { loadWorkflowDefinition } from './workflow-definition.mjs'
import { collectContextFiles, indexFilePath, searchContextIndex } from './context-index.mjs'
import { resolveQualityGate } from './quality-policy.mjs'
import { resolveEvidenceRoute, summarizeToolBudget } from './evidence-routing-policy.mjs'
import { assessUnattendedStart, detectUnattendedRequest, inferUnattendedRiskSignals, UNATTENDED_SIGNAL } from './unattended-policy.mjs'
import { evaluatePromptIntake } from './prompt-intake.mjs'
import { draftEvidence, latestNodeEvidence } from './evidence-template.mjs'
import { executeRegisteredTool } from './tool-executor.mjs'
import { summarizeMetrics } from './workflow-observability.mjs'

function runtimeError(code, message, details = {}) {
  return { ok: false, error: { code, message, ...details } }
}

function sedimentPathFor(config, taskId) {
  return path.relative(config.repositoryDirectory, path.join(config.sedimentDirectory, `${taskId}.md`))
    .split(path.sep)
    .join('/')
}

async function fingerprintPaths(repositoryDirectory, paths) {
  return Promise.all(paths.map(async (relativePath) => {
    const filePath = path.join(repositoryDirectory, relativePath)
    try {
      const valid = await validateOwnedPaths(repositoryDirectory, [relativePath])
      if (!valid.ok) return { path: relativePath, kind: 'unsafe' }
      const metadata = await lstat(filePath)
      if (!metadata.isFile()) return { path: relativePath, kind: 'non-file' }
      return { path: relativePath, kind: 'file', digest: createHash('sha256').update(await readFile(filePath)).digest('hex') }
    } catch (error) {
      if (error.code === 'ENOENT') return { path: relativePath, kind: 'missing' }
      throw error
    }
  })).then((items) => items.sort((left, right) => left.path.localeCompare(right.path)))
}

export async function validateOwnedPaths(repositoryDirectory, paths) {
  for (const relativePath of paths) {
    const parts = relativePath.split('/')
    for (let index = 1; index <= parts.length; index++) {
      try {
        const metadata = await lstat(path.join(repositoryDirectory, ...parts.slice(0, index)))
        if (metadata.isSymbolicLink()) return runtimeError('OWNED_PATH_SYMLINK_UNSUPPORTED', `Owned path traverses a symbolic link: ${relativePath}`)
        if (index === parts.length && !metadata.isFile()) return runtimeError('OWNED_PATH_NOT_FILE', `Owned path must name an exact file: ${relativePath}`)
      } catch (error) {
        if (error.code === 'ENOENT') break
        throw error
      }
    }
  }
  return { ok: true }
}

async function writeTextAtomically(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporaryPath, value, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  await rename(temporaryPath, filePath)
}

export async function createWorkflowRuntime({ config, now = () => Date.now() }) {
  const workflowResult = loadWorkflowDefinition(
    await readFile(config.workflowDefinition, 'utf8'),
    config.workflowDefinition,
  )
  if (!workflowResult.ok) return { ok: false, errors: workflowResult.errors }

  const store = createJsonEventStore({ rootDirectory: config.stateDirectory, now: () => new Date(now()).toISOString() })
  const leaseManager = createFileLeaseManager({
    rootDirectory: path.join(config.stateDirectory, 'leases'),
  })
  const writerLock = createRepositoryWriterLock({ leaseManager })
  const git = createGitAdapter({ repositoryDirectory: config.repositoryDirectory, writerLock })
  const commitExecutor = createCommitExecutor({ git, writerLock, journalDirectory: path.join(config.stateDirectory, 'commit-journals') })
  async function reconcileCommit({ runId, plan }) {
    const current = await store.getRun(runId)
    if (!current.ok) return { status: 'failed', error: current.error }
    const commitPlan = latestNodeEvidence(current.record, 'atomic-commit-plan')?.evidence.commitPlan
    if (!commitPlan) return { status: 'failed', error: { code: 'COMMIT_PLAN_REQUIRED', message: 'No recorded commit plan to reconcile' } }
    return commitExecutor.reconcile({ plan, commitPlan })
  }
  async function environmentSnapshot(plan, baseline) {
    const repository = await git.assertRepository()
    const candidates = repository.ok ? await git.listChangedPaths()
      : (await collectContextFiles(config.repositoryDirectory)).map(file => path.relative(config.repositoryDirectory, file).split(path.sep).join('/'))
    const statePrefix = path.relative(config.repositoryDirectory, config.stateDirectory).split(path.sep).join('/')
    const owned = new Set(plan.context.changedFiles)
    const critical = ['package.json', 'pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lock', 'bun.lockb', 'Cargo.lock', 'Cargo.toml', 'go.mod', 'go.sum', 'pyproject.toml', 'uv.lock', 'requirements.txt', 'tsconfig.json', '.workflow/config.yaml']
    const paths = [...new Set([...candidates, ...critical, ...(baseline?.paths ?? []).map(item => item.path)])]
      .filter(file => !owned.has(file) && file !== statePrefix && !file.startsWith(statePrefix + '/') && !file.split('/').some(part => ['.git', 'node_modules', 'output-tdd', 'docs-tdd', 'coverage', 'dist', 'build'].includes(part)))
    return { head: repository.ok ? await git.headSha() : null, paths: await fingerprintPaths(config.repositoryDirectory, paths) }
  }

  async function verificationFresh(plan, verified, allowCommits = false) {
    const fresh = verified?.freshness
    if (fresh?.planHash !== plan.planHash || !Array.isArray(fresh.ownedPathFingerprints) || !fresh.environment) return false
    if (JSON.stringify(fresh.ownedPathFingerprints) !== JSON.stringify(await fingerprintPaths(config.repositoryDirectory, fresh.ownedPathFingerprints.map(item => item.path)))) return false
    const environment = await environmentSnapshot(plan, fresh.environment)
    if (allowCommits && environment.head !== fresh.environment.head) {
      const reconciled = await reconcileCommit({ runId: plan.runId, plan })
      let head = fresh.environment.head
      for (const commit of reconciled.evidence?.commits ?? []) {
        const metadata = await git.commitMetadata(commit.commitSha)
        if (!metadata || JSON.stringify(metadata.parents) !== JSON.stringify(head ? [head] : [])) return false
        head = commit.commitSha
      }
      if (head !== environment.head) return false
      environment.head = fresh.environment.head
    }
    return JSON.stringify(environment) === JSON.stringify(fresh.environment)
  }

  const behavioralVerification = hasBehaviorVerification(verificationChecks(config))
  async function verify(input) {
    const checks = input.plan.context.verificationChecks ?? verificationChecks(config)
    const verificationAdapter = createVerificationAdapter({ repositoryDirectory: config.repositoryDirectory, verification: { checks } })
    if (verificationAdapter === null) return { status: 'succeeded', evidence: { kind: 'verification', decision: 'skipped', reason: 'governance.commands.test is explicitly null' } }
    const paths = input.plan.context.changedFiles.filter((item) => item !== sedimentPathFor(config, input.plan.context.taskId))
    const fingerprintsBefore = await fingerprintPaths(config.repositoryDirectory, paths)
    const environmentBefore = await environmentSnapshot(input.plan)
    const before = await captureRunContext({ git, repositoryDirectory: config.repositoryDirectory, governance: config.governance })
    if (!before.ok) return { status: 'failed', error: before.error }
    const registered = input.plan.context.evidenceRoute.capabilities.some((capability) => capability.id === 'local-verification' && capability.enabled)
    const tracked = registered ? await executeRegisteredTool({ store, runId: input.runId, config, capabilityId: 'local-verification', input: { checks }, cacheContext: { fingerprintsBefore, attemptId: randomUUID() }, handler: () => verificationAdapter.execute(input), now }) : null
    const outcome = tracked ? { status: tracked.ok ? 'succeeded' : 'failed', evidence: tracked.result, error: tracked.error } : await verificationAdapter.execute(input)
    const after = await captureRunContext({ git, repositoryDirectory: config.repositoryDirectory, governance: config.governance })
    if (!after.ok) return { status: 'failed', error: after.error, evidence: outcome.evidence }
    const ownedPathFingerprints = await fingerprintPaths(config.repositoryDirectory, paths)
    const environment = await environmentSnapshot(input.plan, environmentBefore)
    const changed = fingerprintsBefore.some(item => ['unsafe', 'non-file'].includes(item.kind)) || JSON.stringify(fingerprintsBefore) !== JSON.stringify(ownedPathFingerprints) || JSON.stringify(environmentBefore) !== JSON.stringify(environment)
    return {
      ...outcome,
      ...(changed ? { status: 'failed', error: { code: 'VERIFICATION_CHANGED_FILES', message: 'Verification changed owned files; inspect and verify again' } } : {}),
      evidence: { ...outcome.evidence, freshness: { planHash: input.plan.planHash, before: before.context, after: after.context, ownedPathFingerprints, environment } },
    }
  }

  const runner = createRunner({
    store, leaseManager,
    adapters: { complete: {
      idempotent: true,
      async execute({ plan, runId }) {
        const current = await store.getRun(runId)
        const verified = current.ok && latestNodeEvidence(current.record, 'verification')?.evidence
        return verified?.decision === 'skipped' || await verificationFresh(plan, verified, true)
          ? { status: 'succeeded', evidence: { kind: 'complete' } }
          : { status: 'failed', error: { code: 'VERIFICATION_STALE', message: 'Verification became stale before completion' } }
      },
    }, commit: {
      execute: async () => ({ status: 'waiting', evidence: { kind: 'commit', message: 'Explicit local commit authorization required' } }),
      reconcile: reconcileCommit,
    }, verification: {
      idempotent: true,
      async execute(input) {
        const current = await store.getRun(input.runId)
        const loop = current.ok && latestNodeEvidence(current.record, 'loop-execution')
        if (loop && await verificationFresh(input.plan, loop.evidence.verification)) {
          return { status: 'succeeded', evidence: { ...loop.evidence.verification, loopEventSequence: loop.sequence } }
        }
        return verify(input)
      },
    } },
  })
  const activeRunPath = path.join(config.stateDirectory, 'active-run')

  async function activeRun() {
    try {
      return (await readFile(activeRunPath, 'utf8')).trim() || null
    } catch (error) {
      if (error.code === 'ENOENT') return null
      throw error
    }
  }

  async function resolveRunId(runId) {
    return runId || (await activeRun())
  }

  async function withRunLease(runId, operation) {
    const acquired = await leaseManager.acquire(`run-${runId}`, {
      ttlMs: 30_000,
      metadata: { operation: 'external-node' },
    })
    if (!acquired.ok) return acquired
    let lease = acquired.lease
    const heartbeat = setInterval(async () => {
      const renewed = await leaseManager.renew(lease)
      if (renewed.ok) lease = renewed.lease
    }, 10_000)
    heartbeat.unref?.()
    try {
      return await operation()
    } finally {
      clearInterval(heartbeat)
      await leaseManager.release(lease)
    }
  }

  async function checkActiveSelection(targetId, replaceActiveRun) {
    const previous = await activeRun()
    if (!previous || previous === targetId) return { ok: true }
    const current = await store.getRun(previous)
    if (!current.ok) return current
    if (Object.keys(current.projection.activeExecutions).length) return runtimeError('RUN_BUSY', 'The active Run is executing')
    if (!['completed', 'cancelled'].includes(current.projection.status) && replaceActiveRun !== previous) return runtimeError('ACTIVE_RUN_EXISTS', 'Resume the active Run, or explicitly replace its selection with --replace-active ID', { activeRun: previous })
    return { ok: true }
  }

  async function activate(runId, { replaceActiveRun } = {}) {
    return withRunLease('active-selection', async () => {
      const target = await store.getRun(runId)
      if (!target.ok) return target
      const selection = await checkActiveSelection(runId, replaceActiveRun)
      if (!selection.ok) return selection
      await writeTextAtomically(activeRunPath, `${runId}\n`)
      return target
    })
  }

  async function start(context, { replaceActiveRun } = {}) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(context.taskId)) {
      return runtimeError('INVALID_RUN_ID', 'Task id contains unsupported characters')
    }
    if (!Array.isArray(context.changedFiles) || context.changedFiles.length === 0) {
      return runtimeError(
        'OWNED_PATHS_REQUIRED',
        'Start requires at least one exact repository-relative --changed-file path',
      )
    }
    const intake = evaluatePromptIntake({ request: context.request, changedFiles: context.changedFiles })
    if (intake.decision === 'HARD_BLOCK' || intake.decision === 'WAIT_CONFIRMATION') {
      return runtimeError(`PROMPT_INTAKE_${intake.decision}`, 'Prompt Intake did not authorize implementation', { reasons: intake.reasons })
    }
    const ownedPaths = normalizeRepositoryPaths(context.changedFiles)
    if (!ownedPaths.ok) return ownedPaths
    const symlinkValidation = await validateOwnedPaths(config.repositoryDirectory, ownedPaths.paths)
    if (!symlinkValidation.ok) return symlinkValidation
    const unattendedRequest = detectUnattendedRequest(context.request)
    let requestedSignals = [...new Set([
      ...(context.signals ?? []),
      ...inferUnattendedRiskSignals(context.request),
      ...(unattendedRequest.enabled ? [UNATTENDED_SIGNAL, 'LOOP_REQUESTED'] : []),
    ])]
    const affectedRepositories = [...new Set(context.affectedRepositories ?? [])]
    if (affectedRepositories.some(id => !config.workspace?.repositories.some(repository => repository.id === id))) return runtimeError('UNKNOWN_AFFECTED_REPOSITORY', 'Affected repositories must be registered workspace IDs')
    if (affectedRepositories.length && config.repositoryId && !affectedRepositories.includes(config.repositoryId)) affectedRepositories.push(config.repositoryId)
    const selectedPath = config.workspace?.repositories.find(repository => repository.id === config.repositoryId)?.path
    const eventGates = deriveEventGates({ signals: requestedSignals, affectedRepositories,
      mode: config.workspace ? 'workspace' : 'single', repositories: config.workspace?.repositories,
      changedFiles: selectedPath ? ownedPaths.paths.map(file => `${selectedPath}/${file}`) : ownedPaths.paths })
    requestedSignals = eventGates.signals
    if (unattendedRequest.enabled || requestedSignals.includes(UNATTENDED_SIGNAL)) {
      const scopeIssues = []
      for (const ownedPath of ownedPaths.paths) {
        try {
          const metadata = await lstat(path.join(config.repositoryDirectory, ownedPath))
          if (!metadata.isFile()) scopeIssues.push(`unattended scope is not a file: ${ownedPath}`)
        } catch (error) {
          if (error.code === 'ENOENT' && !requestedSignals.includes('NEW_FILE_SCOPE')) scopeIssues.push(`new unattended path requires NEW_FILE_SCOPE: ${ownedPath}`)
          else if (error.code !== 'ENOENT') throw error
        }
      }
      const assessment = assessUnattendedStart({
        request: context.request,
        changedFiles: ownedPaths.paths,
        signals: requestedSignals,
        automatedVerificationAvailable: behavioralVerification,
        scopeIssues,
      })
      if (assessment.status !== 'eligible') {
        return runtimeError('UNATTENDED_ELIGIBILITY_REQUIRED', '无人值守尚未开启：请先补齐并确认资格条件', { blockers: assessment.blockers })
      }
    }
    const runContext = await captureRunContext({
      git,
      repositoryDirectory: config.repositoryDirectory,
      governance: config.governance,
    })
    if (!runContext.ok) return runContext
    const sedimentRequired =
      context.sediment !== 'skip' ||
      requestedSignals.includes('PRODUCTION_BUG') ||
      requestedSignals.includes('SEDIMENT_REQUIRED')
    const sedimentPath = sedimentPathFor(config, context.taskId)
    const modes = resolveWorkflowModes({
      planningPolicy: config.planningPolicy,
      executionPolicy: config.executionPolicy,
      signals: requestedSignals,
      requestedPlanningMode: context.planningMode,
      requestedExecutionMode: context.executionMode,
      automatedFeedbackAvailable: behavioralVerification,
    })
    if (!modes.ok) return modes
    if (requestedSignals.includes(UNATTENDED_SIGNAL) && modes.executionMode !== 'loop') {
      return runtimeError('UNATTENDED_LOOP_REQUIRED', '无人值守必须使用可验证的受限 Loop，不能降级为 single-pass')
    }
    const qualityGate = resolveQualityGate({ policy: config.qualityPolicy, signals: eventGates.signals })
    const evidenceRoute = resolveEvidenceRoute({ policy: config.evidenceRoutingPolicy, qualityGate })
    const modeSignals = [
      ...(modes.planningMode === 'openspec' ? ['PLANNING_OPENSPEC'] : []),
      ...(modes.executionMode === 'loop' ? ['EXECUTION_LOOP'] : []),
    ]
    const compiled = compileExecutionPlan(workflowResult.definition, {
      ...context,
      affectedRepositories,
      changedFiles: ownedPaths.paths,
      runContext: runContext.context,
      verificationChecks: verificationChecks(config),
      planningMode: modes.planningMode,
      executionMode: modes.executionMode,
      loop: modes.loop,
      modeReasons: modes.reasons,
      signals: [...eventGates.signals, ...modeSignals, ...(qualityGate.enabled ? ['QUALITY_GATE'] : [])],
      eventGates: eventGates.evidence,
      qualityGate,
      evidenceRoute,
      changedFiles: [
        ...ownedPaths.paths,
        ...(modes.planningMode === 'openspec'
          ? [`openspec/changes/${context.taskId}/proposal.md`]
          : []),
        ...(sedimentRequired ? [sedimentPath] : []),
      ],
    })
    if (!compiled.ok) return compiled
    const allPaths = normalizeRepositoryPaths(compiled.plan.context.changedFiles)
    if (!allPaths.ok) return allPaths
    const safePaths = await validateOwnedPaths(config.repositoryDirectory, allPaths.paths)
    if (!safePaths.ok) return safePaths
    const created = await withRunLease('active-selection', async () => {
      const selection = await checkActiveSelection(compiled.plan.runId, replaceActiveRun)
      if (!selection.ok) return selection
      const result = await store.createRun(compiled.plan)
      if (result.ok) await writeTextAtomically(activeRunPath, `${compiled.plan.runId}\n`)
      return result
    })
    if (!created.ok) return created
    const related = await recommendations(compiled.plan.runId)
    return related.ok ? { ...created, recommendations: related.recommendations } : related
  }

  async function status(runId) {
    const resolved = await resolveRunId(runId)
    if (!resolved) return runtimeError('NO_ACTIVE_RUN', 'No active workflow run')
    return store.getRun(resolved)
  }

  async function resume(runId) {
    const resolved = await resolveRunId(runId)
    if (!resolved) return runtimeError('NO_ACTIVE_RUN', 'No active workflow run')
    return runner.runUntilBlocked(resolved)
  }

  async function reconcile(runId) {
    const resolved = await resolveRunId(runId)
    if (!resolved) return runtimeError('NO_ACTIVE_RUN', 'No active workflow run')
    const result = await withRunLease(resolved, async () => {
      const current = await status(resolved)
      if (!current.ok) return current
      if (current.projection.nodeStates.commit !== 'failed') return current
      const outcome = await reconcileCommit({ runId: resolved, plan: current.record.plan })
      if (outcome.status === 'failed') return { ok: false, error: outcome.error }
      const retried = await store.appendNodeEvent(resolved, 'commit', { type: 'NODE_RETRIED' })
      if (!retried.ok) return retried
      const prepared = await prepareExternalNode(resolved, 'commit')
      if (!prepared.ok) return prepared
      return finishExternalNode(resolved, 'commit', outcome, prepared.attemptId)
    })
    return result.ok ? resume(resolved) : result
  }

  async function retry(runId, { nodeId = 'verification', reason } = {}) {
    const resolved = await resolveRunId(runId)
    if (!resolved) return runtimeError('NO_ACTIVE_RUN', 'No active workflow run')
    if (typeof reason !== 'string' || !reason.trim()) return runtimeError('REPAIR_REASON_REQUIRED', 'Explain the repair before retrying')
    const result = await withRunLease(resolved, async () => {
      const current = await status(resolved)
      if (!current.ok) return current
      if (!['implementation', 'verification', 'quality-assessment', 'loop-execution'].includes(nodeId) ||
          !['failed', 'succeeded', 'waiting'].includes(current.projection.nodeStates[nodeId])) {
        return runtimeError('NODE_NOT_REPAIRABLE', 'Repair requires an implementation, loop, verification or quality result')
      }
      if (Object.keys(current.projection.activeExecutions).length) return runtimeError('RUN_BUSY', 'Wait for the active execution before repairing')
      if ((current.projection.attempts.commit ?? 0) > 0) return runtimeError('COMMIT_RECONCILIATION_REQUIRED', 'A commit was attempted; reconcile it before starting a new Run')
      const loopStop = current.record.events.filter((event) => event.type === 'LOOP_ITERATION_FINISHED').at(-1)?.evidence.stopReason
      if (['no-progress', 'budget-exhausted'].includes(loopStop) || current.record.events.some((event) => event.error?.code === 'LOOP_BUDGET_EXHAUSTED')) return runtimeError('LOOP_STOPPED', 'The loop budget cannot be reset by retry; inspect the results before creating another Run')
      const invalidated = new Set(['implementation'])
      let size
      do {
        size = invalidated.size
        for (const node of current.record.plan.nodes) {
          if (node.requires.some((id) => invalidated.has(id))) invalidated.add(node.id)
        }
      } while (invalidated.size !== size)
      return store.appendRunEvent(resolved, {
        type: 'RUN_REPAIR_REQUESTED',
        evidence: { nodeId, reason: reason.trim(), invalidatedNodes: [...invalidated].sort() },
      })
    })
    return result.ok ? resume(resolved) : result
  }

  async function evidenceTemplate(runId, nodeId) {
    const current = await status(runId)
    if (!current.ok) return current
    const selected = nodeId ?? current.record.plan.nodes.find((node) => current.projection.nodeStates[node.id] === 'waiting')?.id
    if (!current.record.plan.nodes.some((node) => node.id === selected)) return runtimeError('NODE_NOT_FOUND', `Unknown node: ${selected}`)
    return draftEvidence(current.record, selected, { ...config, sedimentPath: sedimentPathFor(config, current.record.plan.context.taskId) })
  }

  async function loopCheck(runId, { change } = {}) {
    const resolved = await resolveRunId(runId)
    if (!resolved) return runtimeError('NO_ACTIVE_RUN', 'No active workflow run')
    if (typeof change !== 'string' || !change.trim()) return runtimeError('LOOP_CHANGE_REQUIRED', 'Describe this iteration')
    const result = await withRunLease(resolved, async () => {
      const current = await status(resolved)
      if (!current.ok) return current
      const context = current.record.plan.context
      if (context.executionMode !== 'loop' || !hasBehaviorVerification(context.verificationChecks ?? verificationChecks(config))) return runtimeError('LOOP_NOT_ENABLED', 'A loop requires behavioral verification')
      const previous = current.record.events.filter((event) => event.type === 'LOOP_ITERATION_FINISHED').at(-1)
      if (['no-progress', 'budget-exhausted'].includes(previous?.evidence.stopReason) || ['failed', 'succeeded'].includes(current.projection.nodeStates['loop-execution'])) return runtimeError('LOOP_STOPPED', 'The loop has stopped; inspect its results before starting another Run')
      const prepared = await prepareExternalNode(resolved, 'loop-execution')
      if (!prepared.ok) return prepared
      const starts = current.record.events.filter((event) => event.type === 'LOOP_ITERATION_STARTED')
      const startedAt = starts[0]?.at ?? new Date(now()).toISOString()
      const remainingMs = Math.floor(context.loop.timeBudgetMinutes * 60_000 - (now() - Date.parse(startedAt)))
      const exhausted = remainingMs <= 0 || starts.length >= context.loop.maxIterations
      if (exhausted) {
        const stopped = await finishExternalNode(resolved, 'loop-execution', { status: 'failed', error: { code: 'LOOP_BUDGET_EXHAUSTED', message: 'The loop budget is exhausted' } }, prepared.attemptId)
        return { ...stopped, loop: { iterations: starts.length, stopReason: 'budget-exhausted' } }
      }
      const iteration = starts.length + 1
      const started = await store.appendRunEvent(resolved, { type: 'LOOP_ITERATION_STARTED', evidence: { iteration, change: change.trim() } })
      if (!started.ok) return started
      const outcome = await verify({ runId: resolved, plan: current.record.plan, node: { timeoutMs: remainingMs }, signal: AbortSignal.timeout(remainingMs) })
      const feedbackDigest = createHash('sha256').update(JSON.stringify([outcome.error?.code, (outcome.evidence?.checks ?? []).filter((check) => check.status !== 'succeeded').map(check => ({ id: check.id, feedbackDigest: check.feedbackDigest }))])).digest('hex')
      const noProgress = previous?.evidence.feedbackDigest === feedbackDigest ? previous.evidence.noProgress + 1 : 0
      const elapsedMs = Math.max(0, now() - Date.parse(startedAt))
      const stopReason = elapsedMs >= context.loop.timeBudgetMinutes * 60_000 || ['TOOL_COST_BUDGET_EXCEEDED', 'MCP_CALL_BUDGET_EXCEEDED'].includes(outcome.error?.code) ? 'budget-exhausted'
        : outcome.status === 'succeeded' ? 'acceptance-passed'
        : noProgress >= context.loop.noProgressLimit ? 'no-progress'
        : iteration >= context.loop.maxIterations ? 'budget-exhausted' : null
      const finished = await store.appendRunEvent(resolved, { type: 'LOOP_ITERATION_FINISHED', evidence: { iteration, change: change.trim(), elapsedMs, noProgress, feedbackDigest, stopReason, outcome } })
      if (!finished.ok) return finished
      const completion = await finishExternalNode(resolved, 'loop-execution', {
        status: stopReason === 'acceptance-passed' ? 'succeeded' : stopReason ? 'failed' : 'waiting',
        evidence: { kind: 'loop-check', iterations: iteration, elapsedMs, stopReason, verification: outcome.evidence },
        ...(stopReason && stopReason !== 'acceptance-passed' ? { error: { code: 'LOOP_STOPPED', message: stopReason } } : {}),
      }, prepared.attemptId)
      return { ...completion, loop: { iterations: iteration, elapsedMs, noProgress, stopReason } }
    })
    if (!result.ok || result.loop?.stopReason !== 'acceptance-passed') return result
    return { ...await resume(resolved), loop: result.loop }
  }

  async function submitEvidence(runId, nodeId, supplied, options = {}) {
    if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied)) return runtimeError('EVIDENCE_SCHEMA_INVALID', 'Evidence must be an object')
    const template = await evidenceTemplate(runId, nodeId)
    if (!template.ok && template.error.code !== 'EVIDENCE_TEMPLATE_UNAVAILABLE') return template
    const resolved = await resolveRunId(runId)
    const selected = template.nodeId ?? nodeId
    const result = await resolveNode(resolved, selected, { ...options, evidence: supplied.schemaVersion ? supplied : { ...template.evidence, ...supplied } })
    if (!result.ok || result.projection.nodeStates[selected] !== 'succeeded') return result
    return resume(resolved)
  }

  async function recordContext(runId, { query, selections, reviewed = false } = {}) {
    const resolved = await resolveRunId(runId)
    if (!resolved) return runtimeError('NO_ACTIVE_RUN', 'No active workflow run')
    if (reviewed !== true) {
      return runtimeError('CONTEXT_REVIEW_REQUIRED', 'Record context only after verifying the selected locations with rg and source reading')
    }
    if (!Array.isArray(selections) || selections.length === 0) {
      return runtimeError('CONTEXT_SELECTIONS_REQUIRED', 'Record context requires at least one selected path and line')
    }
    const retrieval = await searchContextIndex({
      repositoryDirectory: config.repositoryDirectory,
      stateDirectory: config.stateDirectory,
      query,
      limit: 50,
    })
    if (!retrieval.ok) return retrieval
    const requested = new Map()
    for (const selection of selections) {
      if (!selection || typeof selection.path !== 'string' || !Number.isInteger(selection.line) || selection.line < 1) {
        return runtimeError('CONTEXT_SELECTION_INVALID', 'Every selection requires a repository-relative path and positive integer line')
      }
      requested.set(`${selection.path}:${selection.line}`, { path: selection.path, line: selection.line })
    }
    const matches = new Map(retrieval.results.map((result) => [`${result.path}:${result.line}`, result]))
    const missing = [...requested.keys()].filter((key) => !matches.has(key))
    if (missing.length > 0) {
      return runtimeError('CONTEXT_SELECTION_NOT_RETRIEVED', 'Selected locations must be present in the current lexical retrieval', { missing })
    }
    const references = [...requested.values()].map((selection) => {
      const result = matches.get(`${selection.path}:${selection.line}`)
      return { path: result.path, line: result.line, stale: result.stale }
    }).sort((left, right) => left.path.localeCompare(right.path) || left.line - right.line)
    return withRunLease(resolved, () => store.appendRunEvent(resolved, {
      type: 'CONTEXT_RECORDED',
      idempotencyKey: `${resolved}/context/${createHash('sha256').update(JSON.stringify({ query: retrieval.query, indexedAt: retrieval.indexedAt, references })).digest('hex')}`,
      evidence: {
        kind: 'lexical-context-references',
        query: retrieval.query,
        indexFile: path.relative(config.repositoryDirectory, retrieval.indexFile).split(path.sep).join('/'),
        indexedAt: retrieval.indexedAt,
        reviewed: true,
        references,
      },
    }))
  }

  async function recordToolCall(runId, details = {}) {
    const resolved = await resolveRunId(runId)
    if (!resolved) return runtimeError('NO_ACTIVE_RUN', 'No active workflow run')
    if (!/^[a-f0-9]{64}$/i.test(details.inputDigest ?? '') || !/^[a-f0-9]{64}$/i.test(details.resultDigest ?? '')) {
      return runtimeError('TOOL_DIGEST_INVALID', 'Tool calls require SHA-256 inputDigest and resultDigest values')
    }
    return withRunLease(resolved, async () => {
      const current = await status(resolved)
      if (!current.ok) return current
      const route = current.record.plan.context.evidenceRoute
      const capability = route.capabilities.find((item) => item.id === details.capabilityId)
      if (!capability || !capability.enabled) return runtimeError('TOOL_CAPABILITY_NOT_ALLOWED', 'Tool capability is not registered and enabled in this immutable Run')
      if (capability.access !== 'read') return runtimeError('TOOL_WRITE_REQUIRES_AUTHORIZATION', 'Evidence routing records only read-only tool calls')
      const previous = current.record.events.find((event) => event.type === 'TOOL_CALL_FINISHED' && event.evidence?.capabilityId === capability.id && event.evidence?.inputDigest === details.inputDigest && event.evidence?.outcome === 'succeeded')
      if (route.cache && previous) return { ok: true, cached: true, record: current.record, projection: current.projection, invocation: previous.evidence }
      const budget = summarizeToolBudget(current.record, route)
      if (capability.kind === 'mcp' && budget.mcpCalls >= route.budget.maxMcpCalls) return runtimeError('MCP_CALL_BUDGET_EXCEEDED', 'Run has exhausted its MCP call budget', budget)
      const costUnits = details.costUnits ?? capability.costUnits
      if (!Number.isInteger(costUnits) || costUnits < 0 || costUnits > capability.costUnits) return runtimeError('TOOL_COST_INVALID', 'Tool costUnits must not exceed the registered capability cost')
      if (budget.costUnits + costUnits > route.budget.maxCostUnits) return runtimeError('TOOL_COST_BUDGET_EXCEEDED', 'Run has exhausted its tool cost budget', budget)
      const invocationId = `${capability.id}-${createHash('sha256').update(`${details.inputDigest}/${details.resultDigest}`).digest('hex').slice(0, 16)}`
      const started = await store.appendRunEvent(resolved, { type: 'TOOL_CALL_STARTED', idempotencyKey: `${resolved}/tool/${invocationId}/start`, evidence: { invocationId, capabilityId: capability.id, kind: capability.kind, purpose: String(details.purpose ?? '').slice(0, 240), inputDigest: details.inputDigest } })
      if (!started.ok) return started
      return store.appendRunEvent(resolved, { type: 'TOOL_CALL_FINISHED', idempotencyKey: `${resolved}/tool/${invocationId}/finish`, evidence: { invocationId, capabilityId: capability.id, kind: capability.kind, purpose: String(details.purpose ?? '').slice(0, 240), inputDigest: details.inputDigest, resultDigest: details.resultDigest, outcome: details.outcome === 'failed' ? 'failed' : 'succeeded', elapsedMs: Number.isInteger(details.elapsedMs) && details.elapsedMs >= 0 ? details.elapsedMs : 0, costUnits, adopted: details.adopted === true } })
    })
  }

  async function executeTool(runId, details = {}) {
    const resolved = await resolveRunId(runId)
    if (!resolved) return runtimeError('NO_ACTIVE_RUN', 'No active workflow run')
    if (details.capabilityId === 'local-verification') return runtimeError('ENGINE_OWNED_NODE', 'Use resume or loop check for verification')
    return withRunLease(resolved, async () => {
      const current = await status(resolved)
      if (!current.ok) return current
      const paths = current.record.plan.context.changedFiles.filter((item) => item !== sedimentPathFor(config, current.record.plan.context.taskId))
      const cacheContext = {
        paths: await fingerprintPaths(config.repositoryDirectory, paths),
        head: await git.headSha(),
        index: await readFile(indexFilePath(config.stateDirectory)).then((value) => createHash('sha256').update(value).digest('hex')).catch(() => null),
      }
      const handler = details.capabilityId === 'local-context-search' ? async () => {
        const result = await searchContextIndex({ repositoryDirectory: config.repositoryDirectory, stateDirectory: config.stateDirectory, query: details.input?.query, limit: details.input?.limit })
        return { status: result.ok ? 'succeeded' : 'failed', evidence: result, error: result.error }
      } : undefined
      return executeRegisteredTool({ store, runId: resolved, config, capabilityId: details.capabilityId, input: details.input, purpose: details.purpose, localEvidence: details.localEvidence, cacheContext, handler, fresh: details.fresh === true || Boolean(handler), now })
    })
  }

  async function recommendations(runId) {
    const current = await status(runId)
    if (!current.ok) return current
    const related = await findRelatedSediment({ ...config, request: current.record.plan.context.request, taskId: current.record.plan.context.taskId, changedFiles: current.record.plan.context.changedFiles })
    if (related.length) {
      const recorded = await withRunLease(current.record.runId, () => store.appendRunEvent(current.record.runId, {
        type: 'SEDIMENT_RECOMMENDED', idempotencyKey: `sediment/${createHash('sha256').update(JSON.stringify(related)).digest('hex')}`, evidence: { recommendations: related },
      }))
      if (!recorded.ok) return recorded
    }
    return { ok: true, recommendations: related }
  }

  async function recordReuse(runId, details = {}) {
    const resolved = await resolveRunId(runId)
    if (!resolved) return runtimeError('NO_ACTIVE_RUN', 'No active workflow run')
    return withRunLease(resolved, async () => {
      const current = await status(resolved)
      if (!current.ok) return current
      const recommended = current.record.events.filter((event) => event.type === 'SEDIMENT_RECOMMENDED').flatMap((event) => event.evidence.recommendations).findLast((item) => item.path === details.path)
      if (!recommended) return runtimeError('SEDIMENT_NOT_RECOMMENDED', 'Select a recommendation from this Run')
      if (typeof details.adopted !== 'boolean' || ![true, false, null, undefined].includes(details.helped)) return runtimeError('SEDIMENT_REUSE_INVALID', 'adopted and helped must be booleans (helped may be unknown)')
      const snapshot = await fingerprintPaths(config.repositoryDirectory, [recommended.path])
      if (snapshot[0].digest !== recommended.sha256) return runtimeError('SEDIMENT_STALE', 'Refresh the changed recommendation before recording reuse')
      return store.appendRunEvent(resolved, { type: 'SEDIMENT_REUSED', evidence: { path: recommended.path, sha256: recommended.sha256, adopted: details.adopted, helped: details.helped ?? null } })
    })
  }

  async function recordIntervention(runId, reason) {
    const resolved = await resolveRunId(runId)
    if (!resolved) return runtimeError('NO_ACTIVE_RUN', 'No active workflow run')
    if (typeof reason !== 'string' || !reason.trim()) return runtimeError('INTERVENTION_REASON_REQUIRED', 'Describe the human intervention')
    return withRunLease(resolved, () => store.appendRunEvent(resolved, { type: 'INTERVENTION_RECORDED', evidence: { reason: reason.trim() } }))
  }

  async function metrics() {
    const result = await store.listRuns()
    return result.ok ? summarizeMetrics(result.records, now()) : result
  }

  async function recordCliCall(runId, command, succeeded) {
    const resolved = await resolveRunId(runId)
    if (!resolved) return { ok: true }
    return withRunLease(resolved, () => store.appendRunEvent(resolved, { type: 'CLI_INVOKED', evidence: { command, succeeded } }))
  }

  async function prepareExternalNode(runId, nodeId) {
    let current = await store.getRun(runId)
    if (!current.ok) return current
    let state = current.projection.nodeStates[nodeId]
    if (!state) return runtimeError('NODE_NOT_FOUND', `Unknown node: ${nodeId}`)
    if (state === 'waiting') {
      current = await store.appendNodeEvent(runId, nodeId, {
        type: 'INPUT_RECEIVED',
        idempotencyKey: `${runId}/${nodeId}/external-input/${current.record.version}`,
      })
      if (!current.ok) return current
      state = 'ready'
    }
    if (state !== 'ready') {
      return runtimeError('NODE_NOT_READY', `Node ${nodeId} is ${state}, expected ready or waiting`)
    }
    const attemptId = `${nodeId}-external-${randomUUID()}`
    const started = await store.appendNodeEvent(runId, nodeId, {
      type: 'NODE_STARTED',
      attemptId,
      idempotencyKey: `${runId}/${nodeId}/${attemptId}/start`,
    })
    return started.ok ? { ...started, attemptId } : started
  }

  async function finishExternalNode(runId, nodeId, outcome, attemptId) {
    const eventType = outcome.status === 'succeeded'
      ? 'NODE_SUCCEEDED'
      : outcome.status === 'waiting'
        ? 'NODE_WAITING'
        : 'NODE_FAILED'
    return store.appendNodeEvent(runId, nodeId, {
      type: eventType,
      attemptId,
      idempotencyKey: `${runId}/${nodeId}/${attemptId}/outcome`,
      evidence: outcome.evidence,
      error: outcome.error,
    })
  }

  async function resolveNode(runId, nodeId, { status: outcomeStatus = 'succeeded', evidence = {} } = {}) {
    if (['verification', 'sediment', 'shadow-decision', 'commit', 'complete', 'loop-execution'].includes(nodeId)) {
      return runtimeError('ENGINE_OWNED_NODE', `Use the dedicated workflow command for ${nodeId}`)
    }
    if (!['succeeded', 'waiting', 'failed'].includes(outcomeStatus)) return runtimeError('INVALID_NODE_OUTCOME', 'Unsupported node outcome')
    const resolved = await resolveRunId(runId)
    if (!resolved) return runtimeError('NO_ACTIVE_RUN', 'No active workflow run')
    return withRunLease(resolved, async () => {
      const current = await store.getRun(resolved)
      if (!current.ok) return current
      const node = current.record.plan.nodes.find((item) => item.id === nodeId)
      if (!node) return runtimeError('NODE_NOT_FOUND', `Unknown node: ${nodeId}`)
      if (!['agent', 'manual'].includes(node.type)) return runtimeError('ENGINE_OWNED_NODE', `Node ${nodeId} requires its adapter`)
      if (outcomeStatus === 'succeeded' || (outcomeStatus === 'waiting' && nodeId === 'quality-assessment')) {
        const evidenceValidation = validateNodeEvidence({
          nodeId,
          evidence,
          context: { ...current.record.plan.context, acceptanceCriteria: latestNodeEvidence(current.record, 'intake')?.evidence.acceptanceCriteria },
        })
        if (!evidenceValidation.ok) return evidenceValidation
        evidence = evidenceValidation.evidence
        if (nodeId === 'openspec-contract') {
          const [proposal] = await fingerprintPaths(config.repositoryDirectory, [evidence.proposalPath])
          if (proposal.kind !== 'file' || !(await readFile(path.join(config.repositoryDirectory, evidence.proposalPath), 'utf8')).trim()) return runtimeError('OPENSPEC_PROPOSAL_REQUIRED', 'Write the nonempty Run proposal before submitting its contract')
          evidence.proposalSha256 = proposal.digest
        }
        if (nodeId === 'quality-assessment' && evidence.decision !== 'accepted') outcomeStatus = 'waiting'
        if (nodeId === 'quality-assessment' && evidence.decision === 'accepted') {
          const verified = latestNodeEvidence(current.record, 'verification')
          if (!verified || verified.evidence.decision === 'skipped' || evidence.checks.some((check) => check.eventSequence !== verified.sequence)) {
            return runtimeError('QUALITY_VERIFICATION_REFERENCE_INVALID', 'Accepted checks must reference the latest successful verification event')
          }
          if (!await verificationFresh(current.record.plan, verified.evidence)) {
            return runtimeError('VERIFICATION_STALE', 'Repair and reverify the changed implementation before accepting quality')
          }
        }
      }
      const prepared = await prepareExternalNode(resolved, nodeId)
      if (!prepared.ok) return prepared
      return finishExternalNode(
        resolved,
        nodeId,
        outcomeStatus === 'succeeded' || outcomeStatus === 'waiting'
          ? { status: outcomeStatus, evidence }
          : { status: 'failed', error: { code: 'EXTERNAL_NODE_FAILED', message: String(evidence) } },
        prepared.attemptId,
      )
    })
  }

  async function runAdapterNode(runId, nodeId, adapter) {
    const resolved = await resolveRunId(runId)
    if (!resolved) return runtimeError('NO_ACTIVE_RUN', 'No active workflow run')
    return withRunLease(resolved, async () => {
      if (nodeId === 'sediment') {
        const current = await status(resolved)
        if (!current.ok) return current
        const verified = latestNodeEvidence(current.record, 'verification')?.evidence
        if (verified?.decision !== 'skipped' && !await verificationFresh(current.record.plan, verified)) {
          return runtimeError('VERIFICATION_STALE', 'Repair and verify the changed implementation before sediment or completion')
        }
      }
      const prepared = await prepareExternalNode(resolved, nodeId)
      if (!prepared.ok) return prepared
      const outcome = await adapter.execute({
        runId: resolved,
        node: prepared.record.plan.nodes.find((node) => node.id === nodeId),
        plan: prepared.record.plan,
        attemptId: prepared.attemptId,
        idempotencyKey: `${resolved}/${nodeId}/${prepared.attemptId}`,
      })
      const finished = await finishExternalNode(resolved, nodeId, outcome, prepared.attemptId)
      return finished.ok ? { ...finished, outcome } : finished
    })
  }

  async function sediment(runId, sedimentDetails) {
    const adapter = createSedimentAdapter({
      sedimentDirectory: config.sedimentDirectory,
      writerLock,
      details: () => sedimentDetails,
    })
    return runAdapterNode(runId, 'sediment', adapter)
  }

  async function shadow(runId, commitPlan, sedimentDetails) {
    const current = await status(runId)
    if (!current.ok) return current
    const shadowMode = createShadowMode({ git, stateDirectory: config.stateDirectory })
    const decision = await shadowMode.evaluate({
      plan: current.record.plan,
      commitPlan,
      sedimentDetails,
    })
    if (decision.decision === 'ready') {
      const completed = await runAdapterNode(current.record.runId, 'shadow-decision', {
        execute: async () => ({ status: 'succeeded', evidence: { kind: 'shadow-decision', reportPath: decision.reportPath } }),
      })
      if (!completed.ok) return completed
    }
    return decision
  }

  async function commit(runId, options) {
    const current = await status(runId)
    if (!current.ok) return current
    const approvedPlan = latestNodeEvidence(current.record, 'atomic-commit-plan')?.evidence.commitPlan
    const verificationEvidence = latestNodeEvidence(current.record, 'verification')?.evidence
    const sedimentEvidence = latestNodeEvidence(current.record, 'sediment')?.evidence
    if (!verificationEvidence || current.projection.nodeStates.verification !== 'succeeded') {
      return runtimeError('VERIFICATION_REQUIRED', 'Run has no successful verification evidence')
    }
    if (verificationEvidence.decision === 'skipped') {
      return runtimeError('VERIFICATION_SKIPPED', 'An explicitly skipped verification cannot authorize a local commit')
    }
    if (verificationEvidence.freshness?.planHash !== current.record.plan.planHash) {
      return runtimeError(
        'VERIFICATION_NOT_FRESH',
        'Verification evidence is not bound to the current immutable Run plan',
      )
    }
    const freshPaths = verificationEvidence.freshness.ownedPathFingerprints
    if (!Array.isArray(freshPaths)) {
      return runtimeError('VERIFICATION_NOT_FRESH', 'Verification evidence has no owned-path content snapshot')
    }
    if (!await verificationFresh(current.record.plan, verificationEvidence, true)) return runtimeError('VERIFICATION_STALE', 'Implementation or verification environment changed after verification')
    if (!sedimentEvidence || current.projection.nodeStates.sediment !== 'succeeded') {
      return runtimeError('SEDIMENT_REQUIRED', 'Run has no successful sediment decision')
    }
    if (!approvedPlan || !isDeepStrictEqual(options.commitPlan, approvedPlan)) return runtimeError('COMMIT_PLAN_MISMATCH', 'Commit must use the recorded atomic commit plan')
    return runAdapterNode(current.record.runId, 'commit', {
      execute: () => commitExecutor.execute({
        plan: current.record.plan,
        commitPlan: options.commitPlan,
        authorized: options.authorized,
        verificationEvidence: [verificationEvidence],
        sedimentEvidence,
      }).then((result) => result.ok
        ? { status: 'succeeded', evidence: { kind: 'atomic-commit', commits: result.commits } }
        : { status: 'failed', error: result.error }),
    })
  }

  return {
    ok: true,
    runtime: { log: store.readLog, activeRun, activate, commit, reconcile, evidenceTemplate, submitEvidence, recordContext, recordToolCall, executeTool, recommendations, recordReuse, recordIntervention, recordCliCall, metrics, resolveNode, resume, retry, loopCheck, sediment, shadow, start, status },
  }
}
