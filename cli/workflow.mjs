#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { normalizeCliArguments } from '../src/cli-arguments.mjs'
import { evaluateHook } from '../src/hook-adapter.mjs'
import { buildContextIndex, searchContextIndex } from '../src/context-index.mjs'
import { loadWorkflowConfig } from '../src/workflow-config.mjs'
import { resolveProject } from '../src/project-resolver.mjs'
import { createWorkflowRuntime, validateOwnedPaths } from '../src/workflow-runtime.mjs'
import { compareMetrics, explainRun, summarizeEvidence, summarizeRun, timelineRun } from '../src/workflow-observability.mjs'

function parseArguments(values) {
  const options = { _: [] }
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]
    if (!value.startsWith('--')) {
      options._.push(value)
      continue
    }
    const key = value.slice(2)
    if (key === 'commit' || key === 'yes' || key === 'verbose' || key === 'reviewed' || key === 'evidence-stdin' || key === 'fresh') {
      options[key] = true
      continue
    }
    const next = values[index + 1]
    if (next === undefined || next.startsWith('--')) throw new Error(`Missing value for --${key}`)
    index += 1
    if (key === 'changed-file' || key === 'signal' || key === 'verification' || key === 'affected-repo') {
      options[key] = [...(options[key] ?? []), next]
    } else {
      options[key] = next
    }
  }
  return options
}

async function readJson(filePath) {
  return JSON.parse(await readFile(path.resolve(filePath), 'utf8'))
}

async function readStdin() {
  if (process.stdin.isTTY) return ''
  let value = ''
  for await (const chunk of process.stdin) value += chunk
  return value
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function help() {
  process.stdout.write(`Agent Evidence Flow CLI\n\n` +
    `workflow repos\nworkflow evidence [--run ID] [--node ID]\nworkflow retry [--run ID] --node ID --reason TEXT\nworkflow loop check [--run ID] --change TEXT\nworkflow tool execute [--run ID] --capability ID --json INPUT [--local-evidence TEXT]\nworkflow sediment recommend [--run ID]\nworkflow sediment reuse [--run ID] --json DETAILS\nworkflow intervention [--run ID] --reason TEXT\nworkflow metrics [--repo ID] [--baseline FILE]\nworkflow reconcile [--run ID]\nworkflow activate --run ID [--replace-active OLD_ID]\nworkflow log --digest SHA256 [--offset N] [--limit N]\n` +
    `workflow index [--repo ID]\nworkflow search [--repo ID] --query TEXT [--limit N]\nworkflow context record [--repo ID] [--run ID] --query TEXT --select-file FILE --reviewed\nworkflow tool record [--repo ID] [--run ID] --details FILE\n` +
    `workflow start [--repo ID] --task-id ID --request TEXT --changed-file PATH [--planning-mode inline|structured|openspec] [--execution-mode single-pass|loop] [--signal NAME] [--affected-repo ID] [--category bugfix|feature|investigation|maintenance] [--replace-active OLD_ID] [--commit] [--sediment required|skip]\n` +
    `workflow status [--repo ID] [--run ID] [--verbose]\nworkflow explain [--repo ID] [--run ID]\nworkflow timeline [--repo ID] [--run ID]\nworkflow resume [--repo ID] [--run ID]\n` +
    `workflow resolve [--repo ID] --node ID [--run ID] [--json JSON | --evidence-stdin | --evidence-file FILE]\n` +
    `  intake/planning/implementation/quality-assessment/atomic-commit-plan accept partial JSON merged with workflow evidence; successful submissions advance automatically.\n` +
    `workflow sediment [--repo ID] [--details FILE | --json JSON] [--run ID]\n` +
    `workflow shadow [--repo ID] --plan FILE --details FILE [--run ID]\n` +
    `workflow commit [--repo ID] --plan FILE --yes [--run ID]\n`)
}

async function activeRunGuard(runtime, config) {
  const runId = await runtime.activeRun()
  if (!runId) return null
  const current = await runtime.status(runId)
  if (!current.ok) return null
  if (!(await validateOwnedPaths(config.repositoryDirectory, current.record.plan.context.changedFiles)).ok) return null
  const paths = current.record.plan.context.changedFiles.map((item) => path.resolve(config.repositoryDirectory, item))
  const states = current.projection.nodeStates
  const implementationOpen = ['ready', 'waiting'].includes(states.implementation) || ['ready', 'waiting'].includes(states['loop-execution'])
  const proposal = path.resolve(config.repositoryDirectory, `openspec/changes/${current.record.plan.context.taskId}/proposal.md`)
  return {
    runId,
    status: current.projection.status,
    ownedPaths: paths,
    editablePaths: implementationOpen ? paths : ['ready', 'waiting'].includes(states['openspec-contract']) ? [proposal] : [],
  }
}

async function outputHook(event, activeRun, workspaceMessage = '', suppliedInput = null) {
  const inputText = suppliedInput ?? await readStdin()
  let input = {}
  try { input = inputText.trim() ? JSON.parse(inputText) : {} } catch { input = {} }
  const decision = evaluateHook(event, input, { activeRun })
  if (event === 'pre-tool-use' && decision.decision === 'deny') {
    print({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: decision.reason,
      },
    })
    process.exit(0)
  }
  process.stdout.write(`${workspaceMessage}${decision.message ?? decision.reason}\n`)
  process.exit(0)
}

const [command = 'help', ...rest] = normalizeCliArguments(process.argv.slice(2))
const options = parseArguments(rest)
const repositoryDirectory = path.resolve(options.cwd ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd())
if (command === 'help' || command === '--help') {
  help()
  process.exit(0)
}

const configSource = await readFile(path.join(repositoryDirectory, '.workflow', 'config.yaml'), 'utf8').catch((error) => {
  if (error.code !== 'ENOENT') throw error
  print({ ok: false, error: { code: 'WORKFLOW_NOT_INSTALLED', message: 'Install the workflow in this repository first; use --help for commands' } })
  process.exit(1)
})
const configResult = loadWorkflowConfig(configSource, repositoryDirectory, {
  repositoryId: options.repo,
})
if (!configResult.ok) {
  print(configResult)
  process.exit(1)
}

if (command === 'repos') {
  if (configResult.mode === 'workspace') {
    print({
      ok: true,
      mode: 'workspace',
      workspaceName: configResult.workspace.workspaceName,
      repositories: configResult.workspace.repositories.map((repository) => ({
        id: repository.id,
        projectName: repository.projectName,
        path: repository.path,
        stacks: repository.stacks,
        legacyWorkflowStatus: repository.legacyWorkflowStatus,
        legacyWorkflowEntrypoints: repository.legacyWorkflowEntrypoints,
        verification: repository.verification,
      })),
    })
  } else {
    print({
      ok: true,
      mode: 'single',
      repositories: [{ id: configResult.config.projectName, path: '.' }],
    })
  }
  process.exit(0)
}

if (configResult.mode === 'workspace' && !configResult.config) {
  if (command === 'hook') {
    const inputText = await readStdin()
    let hookInput = {}
    try { hookInput = inputText.trim() ? JSON.parse(inputText) : {} } catch { hookInput = {} }
    const rawTarget = hookInput?.tool_input?.file_path ?? hookInput?.toolInput?.filePath ?? ''
    const absoluteTarget = rawTarget ? path.resolve(repositoryDirectory, rawTarget) : ''
    const matched = configResult.workspace.repositories
      .map((item) => ({ ...item, absolutePath: path.resolve(repositoryDirectory, item.path) }))
      .filter((item) => absoluteTarget === item.absolutePath || absoluteTarget.startsWith(`${item.absolutePath}${path.sep}`))
      .sort((left, right) => right.absolutePath.length - left.absolutePath.length)[0]
    if (matched) {
      const selected = loadWorkflowConfig(configSource, repositoryDirectory, { repositoryId: matched.id })
      const selectedRuntime = selected.ok ? await createWorkflowRuntime({ config: selected.config }) : selected
      if (selectedRuntime.ok) {
        await outputHook(options._[0], await activeRunGuard(selectedRuntime.runtime, selected.config), '', inputText)
      }
    }
    const ids = configResult.workspace.repositories.map((repository) => repository.id).join(', ')
    await outputHook(
      options._[0],
      null,
      `Workspace mode. Repositories: ${ids}. Select CLI operations with --repo <id>. `,
      inputText,
    )
  }
  print({
    ok: false,
    error: {
      code: 'WORKSPACE_REPOSITORY_REQUIRED',
      message: 'Workspace commands require --repo <id>',
      availableRepositories: configResult.workspace.repositories.map((repository) => repository.id),
    },
  })
  process.exit(1)
}

if (configResult.config?.governance?.remotePatterns?.length > 0) {
  const identity = await resolveProject({
    repositoryDirectory: configResult.config.repositoryDirectory,
    remotePatterns: configResult.config.governance.remotePatterns,
    canonicalRemote: configResult.config.governance.canonicalRemote,
    matchAllRemotes: configResult.config.governance.matchAllRemotes,
  })
  if (!identity.ok) {
    print({
      ok: false,
      error: {
        code: 'PROJECT_REMOTE_' + identity.status.toUpperCase().replaceAll('-', '_'),
        message: 'Repository remote did not match configured project identity: ' + identity.status,
        canonical: identity.canonical?.normalized ?? null,
      },
    })
    process.exit(1)
  }
}

const runtimeResult = await createWorkflowRuntime({ config: configResult.config })
if (!runtimeResult.ok) {
  print(runtimeResult)
  process.exit(1)
}
const runtime = runtimeResult.runtime
let result

if (command === 'start') {
  result = await runtime.start({
    taskId: options['task-id'],
    request: options.request,
    taskCategory: options.category,
    sediment: options.sediment ?? 'required',
    signals: [...(options.signal ?? []), ...(options.commit ? ['COMMIT_REQUESTED'] : [])],
    changedFiles: options['changed-file'] ?? [],
    affectedRepositories: options['affected-repo'] ?? [],
    planningMode: options['planning-mode'],
    executionMode: options['execution-mode'],
  }, { replaceActiveRun: options['replace-active'] })
} else if (command === 'activate') {
  result = await runtime.activate(options.run, { replaceActiveRun: options['replace-active'] })
} else if (command === 'status') {
  result = await runtime.status(options.run)
  if (result.ok) result = { ok: true, projection: result.projection, ...summarizeRun(result.record, result.projection) }
} else if (command === 'explain') {
  result = await runtime.status(options.run)
  if (result.ok) result = { ok: true, explanation: explainRun(result.record, result.projection) }
} else if (command === 'timeline') {
  result = await runtime.status(options.run)
  if (result.ok) result = { ok: true, runId: result.record.runId, events: timelineRun(result.record) }
} else if (command === 'resume') {
  result = await runtime.resume(options.run)
} else if (command === 'reconcile') {
  result = await runtime.reconcile(options.run)
} else if (command === 'evidence') {
  result = await runtime.evidenceTemplate(options.run, options.node)
} else if (command === 'retry') {
  result = await runtime.retry(options.run, { nodeId: options.node, reason: options.reason })
} else if (command === 'loop') {
  if (options._[0] !== 'check') throw new Error('Use workflow loop check')
  result = await runtime.loopCheck(options.run, { change: options.change })
} else if (command === 'metrics') {
  result = await runtime.metrics()
  if (result.ok && options.baseline) result = compareMetrics(result, await readJson(options.baseline))
} else if (command === 'log') {
  result = await runtime.log(options.digest, { ...(options.offset ? { offset: Number(options.offset) } : {}), ...(options.limit ? { limit: Number(options.limit) } : {}) })
} else if (command === 'intervention') {
  result = await runtime.recordIntervention(options.run, options.reason)
} else if (command === 'resolve') {
  const evidence = options['evidence-file'] ? await readJson(options['evidence-file'])
    : JSON.parse(options.json ?? (options['evidence-stdin'] ? await readStdin() : '{}'))
  result = await runtime.submitEvidence(options.run, options.node, evidence, { status: options.status ?? 'succeeded' })
} else if (command === 'sediment') {
  if (options._[0] === 'recommend') result = await runtime.recommendations(options.run)
  else if (options._[0] === 'reuse') result = await runtime.recordReuse(options.run, options.details ? await readJson(options.details) : JSON.parse(options.json ?? '{}'))
  else {
    const draft = await runtime.evidenceTemplate(options.run, 'sediment')
    result = draft.ok ? await runtime.sediment(options.run, { ...draft.evidence, ...(options.details ? await readJson(options.details) : JSON.parse(options.json ?? '{}')) }) : draft
  }
} else if (command === 'shadow') {
  result = await runtime.shadow(
    options.run,
    await readJson(options.plan),
    await readJson(options.details),
  )
} else if (command === 'commit') {
  result = await runtime.commit(options.run, {
    commitPlan: await readJson(options.plan),
    authorized: options.yes === true,
  })
} else if (command === 'hook') {
  const event = options._[0]
  await outputHook(event, await activeRunGuard(runtime, configResult.config))
} else if (command === 'index') {
  result = await buildContextIndex({
    repositoryDirectory: configResult.config.repositoryDirectory,
    stateDirectory: configResult.config.stateDirectory,
  })
} else if (command === 'search') {
  result = await searchContextIndex({
    repositoryDirectory: configResult.config.repositoryDirectory,
    stateDirectory: configResult.config.stateDirectory,
    query: options.query,
    limit: options.limit === undefined ? undefined : Number(options.limit),
  })
} else if (command === 'context') {
  if (options._[0] !== 'record') throw new Error(`Unknown context command: ${options._[0] ?? '<missing>'}`)
  const selectionDocument = await readJson(options['select-file'])
  result = await runtime.recordContext(options.run, {
    query: options.query,
    selections: Array.isArray(selectionDocument) ? selectionDocument : selectionDocument.selections,
    reviewed: options.reviewed === true,
  })
} else if (command === 'tool') {
  if (options._[0] === 'execute') result = await runtime.executeTool(options.run, { capabilityId: options.capability, input: JSON.parse(options.json ?? '{}'), purpose: options.purpose, localEvidence: options['local-evidence'], fresh: options.fresh })
  else if (options._[0] === 'record') result = await runtime.recordToolCall(options.run, await readJson(options.details))
  else throw new Error('Use workflow tool execute or workflow tool record')
} else {
  throw new Error(`Unknown workflow command: ${command}`)
}

if (result?.ok && ((command === 'start') || (command === 'sediment' && !options._[0] && result.outcome?.status === 'succeeded') || (command === 'commit' && result.outcome?.status === 'succeeded') || (command === 'shadow' && result.decision === 'ready'))) {
  const advanced = await runtime.resume(options.run ?? result.record?.runId)
  result = { ...result, ...advanced }
}
if (!['metrics', 'hook'].includes(command)) {
  const measured = await runtime.recordCliCall(result?.projection?.runId ?? options.run, command, result?.ok === true)
  if (!measured.ok) result = { ...result, measurementWarning: measured.error }
}
if (result?.ok && result.projection) {
  const current = await runtime.status(result.projection.runId)
  result = current.ok ? { ...result, record: current.record, projection: current.projection } : current
}
if (result?.ok && result.record && result.projection && !options.verbose) {
  result = { ok: true, projection: result.projection, ...summarizeRun(result.record, result.projection),
    ...(result.recommendations ? { recommendations: result.recommendations } : {}),
    ...(result.loop ? { loop: result.loop } : {}),
    ...(result.outcome ? { outcome: { status: result.outcome.status, error: result.outcome.error, evidence: summarizeEvidence(result.outcome.evidence) } } : {}),
  }
}
const action = result?.nextActions?.find((item) => item.templateCommand)
if (action) {
  const draft = await runtime.evidenceTemplate(result.projection?.runId, action.nodeId)
  if (draft.ok) action.requiredFields = draft.requiredFields
}
print(result)
if (!result?.ok) process.exitCode = 1
