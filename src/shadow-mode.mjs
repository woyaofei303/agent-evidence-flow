import { randomUUID } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { validateCommitPlan } from './commit-plan.mjs'
import { decideSediment } from './sediment-adapter.mjs'

async function writeReport(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  })
  await rename(temporaryPath, filePath)
}

export function createShadowMode({ git, stateDirectory, now = () => new Date().toISOString() }) {
  const reportsDirectory = path.resolve(stateDirectory, 'shadow')

  async function evaluate({ plan, commitPlan, sedimentDetails = {} }) {
    const [changedPaths, stagedPaths, headSha] = await Promise.all([
      git.listChangedPaths(),
      git.listStagedPaths(),
      git.headSha(),
    ])
    const expectedPaths = [...new Set(plan.context.changedFiles)].sort()
    const unrelatedPaths = changedPaths.filter((filePath) => !expectedPaths.includes(filePath))
    const sediment = decideSediment(plan.context, sedimentDetails)
    const commitRequested = plan.context.signals.includes('COMMIT_REQUESTED')
    const reasons = []
    let validatedCommitPlan = null

    if (commitRequested) {
      if (stagedPaths.length > 0) {
        reasons.push({
          code: 'INDEX_NOT_EMPTY',
          message: `Index already contains staged paths: ${stagedPaths.join(', ')}`,
        })
      }
      if (sediment.decision === 'blocked') {
        reasons.push({ code: 'SEDIMENT_BLOCKED', message: sediment.reason })
      }

      const validation = validateCommitPlan(commitPlan, {
        runId: plan.runId,
        expectedPaths,
        observedPaths: changedPaths,
      })
      if (validation.ok) validatedCommitPlan = validation.plan
      else reasons.push(...validation.errors)
    }

    const decision = commitRequested ? (reasons.length === 0 ? 'ready' : 'blocked') : 'skip'
    const report = {
      schemaVersion: 1,
      mode: 'shadow',
      generatedAt: now(),
      runId: plan.runId,
      decision,
      sediment,
      commit: {
        decision,
        plan: validatedCommitPlan,
      },
      observed: { headSha, changedPaths, stagedPaths, expectedPaths, unrelatedPaths },
      reasons,
      writeOperations: [],
    }
    const reportPath = path.join(reportsDirectory, `${plan.runId}.json`)
    await writeReport(reportPath, report)
    return { ok: true, ...report, reportPath }
  }

  return { evaluate, reportsDirectory }
}
