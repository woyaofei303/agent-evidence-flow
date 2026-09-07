import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { validateCommitPlan } from './commit-plan.mjs'

function commitError(code, message, details = {}) {
  return { ok: false, error: { code, message, ...details } }
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex')
}

function samePaths(left, right) {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort())
}

function sameCommit(metadata, journal, paths) {
  if (!metadata) return false
  const expectedParents = journal.parentSha ? [journal.parentSha] : []
  return (
    samePaths(metadata.parents, expectedParents) &&
    metadata.tree === journal.tree &&
    metadata.message === journal.message &&
    samePaths(paths, journal.paths)
  )
}

async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

async function writeJsonAtomically(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  })
  await rename(temporaryPath, filePath)
}

export function createCommitExecutor({
  git,
  writerLock,
  journalDirectory,
  now = () => new Date().toISOString(),
  faults = {},
}) {
  const journalsRoot = path.resolve(journalDirectory)

  function journalPath(plan, group, index) {
    return path.join(journalsRoot, plan.runId, `${String(index + 1).padStart(3, '0')}-${group.id}.json`)
  }

  function planFingerprint(commitPlan) {
    return hash(JSON.stringify(commitPlan))
  }

  async function inspectGroup(plan, commitPlan, group, index) {
    const filePath = journalPath(plan, group, index)
    const journal = await readJson(filePath)
    if (!journal) return { status: 'pending', filePath, group }
    if (journal.planFingerprint !== planFingerprint(commitPlan)) {
      return {
        status: 'conflict',
        filePath,
        group,
        error: {
          code: 'COMMIT_JOURNAL_PLAN_MISMATCH',
          message: `Commit journal no longer matches plan for group ${group.id}`,
        },
      }
    }

    if (journal.status === 'committed') {
      const metadata = await git.commitMetadata(journal.commitSha)
      const paths = metadata ? await git.commitPaths(journal.commitSha) : []
      return sameCommit(metadata, journal, paths)
        ? { status: 'committed', filePath, group, journal, commitSha: journal.commitSha }
        : {
            status: 'conflict',
            filePath,
            group,
            journal,
            error: {
              code: 'COMMIT_RECEIPT_MISMATCH',
              message: `Recorded commit no longer matches group ${group.id}`,
            },
          }
    }

    if (journal.status === 'prepared') {
      const metadata = await git.commitMetadata('HEAD')
      const paths = metadata ? await git.commitPaths('HEAD') : []
      if (sameCommit(metadata, journal, paths)) {
        return {
          status: 'committed-detected',
          filePath,
          group,
          journal,
          commitSha: metadata.commitSha,
        }
      }
      const headSha = await git.headSha()
      if (headSha === journal.parentSha) {
        return { status: 'prepared', filePath, group, journal }
      }
      return {
        status: 'conflict',
        filePath,
        group,
        journal,
        error: {
          code: 'COMMIT_RECONCILE_CONFLICT',
          message: `HEAD moved after group ${group.id} was prepared`,
        },
      }
    }

    return {
      status: 'conflict',
      filePath,
      group,
      journal,
      error: { code: 'INVALID_COMMIT_JOURNAL', message: `Unknown journal status for ${group.id}` },
    }
  }

  async function inspectPlan(plan, commitPlan) {
    const groups = []
    for (const [index, group] of commitPlan.groups.entries()) {
      groups.push(await inspectGroup(plan, commitPlan, group, index))
    }
    return groups
  }

  async function reconcile({ plan, commitPlan }) {
    const validation = validateCommitPlan(commitPlan, {
      runId: plan.runId,
      expectedPaths: plan.context.changedFiles,
      observedPaths: plan.context.changedFiles,
    })
    if (!validation.ok) {
      return {
        status: 'failed',
        error: { code: 'INVALID_COMMIT_PLAN', message: validation.errors[0].message },
        evidence: { kind: 'commit-reconcile', errors: validation.errors },
      }
    }

    const groups = await inspectPlan(plan, validation.plan)
    const conflict = groups.find((group) => group.status === 'conflict')
    if (conflict) {
      return {
        status: 'failed',
        error: conflict.error,
        evidence: { kind: 'commit-reconcile', groups },
      }
    }
    const commits = groups
      .filter((group) => ['committed', 'committed-detected'].includes(group.status))
      .map((group) => ({ groupId: group.group.id, commitSha: group.commitSha }))
    if (commits.length === groups.length) {
      return { status: 'succeeded', evidence: { kind: 'commit-reconcile', commits } }
    }
    return {
      status: 'waiting',
      evidence: {
        kind: 'commit-reconcile',
        commits,
        pendingGroups: groups
          .filter((group) => !['committed', 'committed-detected'].includes(group.status))
          .map((group) => group.group.id),
        message: 'Explicit commit authorization is required to resume pending groups',
      },
    }
  }

  async function execute({
    plan,
    commitPlan,
    authorized = false,
    verificationEvidence = [],
    sedimentEvidence,
  }) {
    if (!authorized) {
      return commitError('COMMIT_NOT_AUTHORIZED', 'Local commit requires explicit authorization')
    }
    if (!Array.isArray(verificationEvidence) || verificationEvidence.length === 0) {
      return commitError('VERIFICATION_REQUIRED', 'Fresh verification evidence is required')
    }
    if (!sedimentEvidence || sedimentEvidence.decision === 'blocked') {
      return commitError('SEDIMENT_REQUIRED', 'Sediment must be completed or explicitly skipped')
    }

    return writerLock.withLock(`commit:${plan.runId}`, async (capability) => {
      const changedPaths = await git.listChangedPaths()
      const preliminary = validateCommitPlan(commitPlan, {
        runId: plan.runId,
        expectedPaths: plan.context.changedFiles,
        observedPaths: [...new Set([...changedPaths, ...plan.context.changedFiles])],
      })
      if (!preliminary.ok) {
        return commitError('INVALID_COMMIT_PLAN', preliminary.errors[0].message, {
          errors: preliminary.errors,
        })
      }

      const states = await inspectPlan(plan, preliminary.plan)
      const conflict = states.find((state) => state.status === 'conflict')
      if (conflict) return { ok: false, error: conflict.error }
      const previouslyCommittedPaths = states
        .filter((state) => ['committed', 'committed-detected'].includes(state.status))
        .flatMap((state) => state.group.paths)
      const currentValidation = validateCommitPlan(preliminary.plan, {
        runId: plan.runId,
        expectedPaths: plan.context.changedFiles,
        observedPaths: [...new Set([...changedPaths, ...previouslyCommittedPaths])],
      })
      if (!currentValidation.ok) {
        return commitError('COMMIT_PREFLIGHT_FAILED', currentValidation.errors[0].message, {
          errors: currentValidation.errors,
        })
      }
      const commits = states
        .filter((state) => ['committed', 'committed-detected'].includes(state.status))
        .map((state) => ({ groupId: state.group.id, commitSha: state.commitSha }))
      // Persist detected receipts before a later group moves HEAD away from them.
      for (const state of states.filter(state => state.status === 'committed-detected')) {
        await writeJsonAtomically(state.filePath, { ...state.journal, status: 'committed', commitSha: state.commitSha, committedAt: now() })
      }
      if (commits.length === states.length) return { ok: true, commits, reconciled: true }

      const firstPendingIndex = states.findIndex(
        (state) => !['committed', 'committed-detected'].includes(state.status),
      )
      if (
        states.slice(firstPendingIndex + 1).some(
          (state) => ['committed', 'committed-detected'].includes(state.status),
        )
      ) {
        return commitError('COMMIT_GROUP_ORDER_CONFLICT', 'Commit groups were not applied in order')
      }

      for (let index = firstPendingIndex; index < preliminary.plan.groups.length; index += 1) {
        const group = preliminary.plan.groups[index]
        let state = states[index]
        let journal = state.journal
        const stagedBefore = await git.listStagedPaths()

        if (state.status === 'pending') {
          if (stagedBefore.length > 0) {
            return commitError(
              'INDEX_NOT_EMPTY',
              `Refusing to mix pre-existing staged paths: ${stagedBefore.join(', ')}`,
              { stagedPaths: stagedBefore },
            )
          }

          const staged = await git.stageExact(group.paths, { capability })
          if (!staged.ok) return staged
          const stagedPaths = await git.listStagedPaths()
          if (!samePaths(stagedPaths, group.paths)) {
            return commitError('STAGED_PATH_MISMATCH', `Staged paths do not match group ${group.id}`, {
              expectedPaths: group.paths,
              stagedPaths,
            })
          }
          const diff = await git.stagedDiff()
          if (!diff.trim()) {
            return commitError('EMPTY_STAGED_DIFF', `Group ${group.id} has no staged diff`)
          }
          const parentSha = await git.headSha()
          const treeResult = await git.writeTree({ capability })
          if (!treeResult.ok) return treeResult
          journal = {
            schemaVersion: 1,
            status: 'prepared',
            runId: plan.runId,
            groupId: group.id,
            groupIndex: index,
            planFingerprint: planFingerprint(preliminary.plan),
            parentSha,
            tree: treeResult.tree,
            message: group.message,
            paths: group.paths,
            stagedDiffHash: hash(diff),
            preparedAt: now(),
          }
          await writeJsonAtomically(journalPath(plan, group, index), journal)
          state = { ...state, status: 'prepared', journal }
        } else if (state.status === 'prepared') {
          const treeResult = await git.writeTree({ capability })
          if (
            !samePaths(stagedBefore, group.paths) ||
            !treeResult.ok ||
            treeResult.tree !== journal.tree
          ) {
            return commitError(
              'PREPARED_INDEX_MISMATCH',
              `Prepared index no longer matches group ${group.id}`,
            )
          }
        }

        const committed = await git.commit(group.message, { capability })
        if (!committed.ok) return committed
        await faults.afterCommit?.({ plan, group, commitSha: committed.commitSha })

        const metadata = await git.commitMetadata(committed.commitSha)
        const committedPaths = await git.commitPaths(committed.commitSha)
        if (!sameCommit(metadata, journal, committedPaths)) {
          return commitError(
            'CREATED_COMMIT_MISMATCH',
            `Created commit does not match prepared group ${group.id}`,
          )
        }
        const receipt = {
          ...journal,
          status: 'committed',
          commitSha: committed.commitSha,
          committedAt: now(),
        }
        await writeJsonAtomically(journalPath(plan, group, index), receipt)
        commits.push({ groupId: group.id, commitSha: committed.commitSha })
      }

      return { ok: true, commits, reconciled: false }
    })
  }

  return { execute, reconcile, journalsRoot }
}

export function createCommitAdapter({ executor, commitPlan, authorization }) {
  return {
    async execute({ plan }) {
      const result = await executor.execute({
        plan,
        commitPlan: commitPlan({ plan }),
        ...authorization({ plan }),
      })
      return result.ok
        ? { status: 'succeeded', evidence: { kind: 'atomic-commit', commits: result.commits } }
        : { status: 'failed', error: result.error, evidence: { kind: 'atomic-commit' } }
    },
    async reconcile({ plan }) {
      return executor.reconcile({ plan, commitPlan: commitPlan({ plan }) })
    },
  }
}
