import { execFile as execFileCallback } from 'node:child_process'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { detectProject } from './project-detector.mjs'
import { inspectTargetTopology } from './workspace-detector.mjs'
import { stringify } from 'yaml'
import { hasBehaviorVerification, verificationChecks } from './verification-policy.mjs'

const execFile = promisify(execFileCallback)
const workflowHookNeedle = 'tooling/ai-workflow/cli/workflow.mjs'
const distributionEntries = new Set(['cli', 'src', 'scripts', 'templates', 'workflows', 'docs', 'test', 'package.json', 'pnpm-lock.yaml', 'install.sh', 'README.md', 'LICENSE', 'NOTICE.md', '.gitignore'])

async function readOptional(filePath) {
  try {
    return await readFile(filePath, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

async function writeText(filePath, contents) {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, contents, 'utf8')
}

function replaceManagedBlock(source, block, startMarker, endMarker) {
  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker)
  if ((start === -1) !== (end === -1) || (start !== -1 && end < start)) {
    throw new Error(`Incomplete managed block: ${startMarker}`)
  }
  const normalizedBlock = block.trimEnd()
  if (start === -1) {
    const separator = source.trim() ? '\n\n' : ''
    return `${source.trimEnd()}${separator}${normalizedBlock}\n`
  }
  return `${source.slice(0, start)}${normalizedBlock}${source.slice(end + endMarker.length)}`
}

function renderSingleConfig(detection) {
  const command = detection.verification
  return [
    'schemaVersion: 1',
    `projectName: ${JSON.stringify(detection.projectName)}`,
    'workflowDefinition: tooling/ai-workflow/workflows/development-v1.yaml',
    'stateDirectory: .workflow/state',
    'sedimentDirectory: docs/workflow-sediment',
    ...renderPlanningAndExecutionPolicy(),
    ...renderQualityPolicy(detection),
    ...renderEvidenceRoutingPolicy(detection),
    ...renderVerification(command, 0),
    '',
  ].join('\n')
}

function renderEvidenceRoutingPolicy(detection, indentation = 0) {
  const prefix = ' '.repeat(indentation)
  const checks = verificationChecks(detection)
  const verificationCost = checks.every((check) => check.file === 'git') ? 0 : 1
  return [
    `${prefix}evidenceRoutingPolicy:`,
    `${prefix}  version: 1`,
    `${prefix}  localFirst: true`,
    `${prefix}  maxMcpCallsPerRun: 0`,
    `${prefix}  maxCostUnitsPerRun: ${verificationCost * 6 + 6}`,
    `${prefix}  cache: true`,
    `${prefix}  capabilities:`,
    `${prefix}    - id: local-context-search`,
    `${prefix}      kind: local`,
    `${prefix}      access: read`,
    `${prefix}      enabled: true`,
    `${prefix}      costUnits: 0`,
    `${prefix}      timeoutMs: 30000`,
    `${prefix}    - id: local-verification`,
    `${prefix}      kind: local`,
    `${prefix}      access: read`,
    `${prefix}      enabled: true`,
    `${prefix}      costUnits: ${verificationCost}`,
    `${prefix}      timeoutMs: ${Math.max(...checks.map((check) => check.timeoutMs))}`,
  ]
}

function renderQualityPolicy(detection, indentation = 0) {
  const prefix = ' '.repeat(indentation)
  const behavioral = hasBehaviorVerification(verificationChecks(detection))
  const candidateCount = behavioral ? 3 : 2
  return [
    `${prefix}qualityPolicy:`,
    `${prefix}  enabled: true`,
    `${prefix}  highRiskSignals: [API_CONTRACT_CHANGE, AUTH_OR_SECURITY_CHANGE, DATA_MODEL_CHANGE, PUBLIC_BEHAVIOR_CHANGE, PRODUCTION_BUG, HIGH_RISK_REQUEST]`,
    `${prefix}  negativeFeedbackSignals: [USER_DISSATISFACTION]`,
    `${prefix}  candidateCount: ${candidateCount}`,
  ]
}

function renderPlanningAndExecutionPolicy() {
  return [
    'planningPolicy:',
    '  defaultMode: inline',
    '  structuredSignals: [MULTI_STEP, MULTI_COMPONENT, MULTIPLE_ACCEPTANCE_CHECKS, RESUMABLE_TASK, ITERATIVE_IMPLEMENTATION, LONG_RUNNING_IMPLEMENTATION]',
    '  openspecSignals: [CROSS_REPO, API_CONTRACT_CHANGE, DATA_MODEL_CHANGE, AUTH_OR_SECURITY_CHANGE, PUBLIC_BEHAVIOR_CHANGE, LONG_LIVED_DESIGN_DECISION]',
    'executionPolicy:',
    '  defaultMode: single-pass',
    '  loopTriggerSignals: [LOOP_REQUESTED, ITERATIVE_ACCEPTANCE, EXPECTED_MULTIPLE_ITERATIONS]',
    '  loopBlockedSignals: [REQUIREMENT_UNCLEAR, EXTERNAL_SIDE_EFFECT, SENSITIVE_OPERATION]',
    '  maxIterations: 6',
    '  noProgressLimit: 2',
    '  timeBudgetMinutes: 60',
  ]
}

function renderVerification(command, indentation) {
  const prefix = ' '.repeat(indentation)
  return stringify({ verification: command }).trimEnd().split('\n').map((line) => prefix + line)
}

function renderWorkspaceConfig(target, repositories) {
  const lines = [
    'schemaVersion: 2',
    'mode: workspace',
    `workspaceName: ${JSON.stringify(path.basename(target))}`,
    'workflowDefinition: tooling/ai-workflow/workflows/development-v1.yaml',
    'stateDirectory: .workflow/state',
    ...renderPlanningAndExecutionPolicy(),
    'repositories:',
  ]
  for (const repository of repositories) {
    lines.push(
      `  - id: ${JSON.stringify(repository.id)}`,
      `    projectName: ${JSON.stringify(repository.detection.projectName)}`,
      `    stacks: [${repository.detection.stacks.map((stack) => JSON.stringify(stack)).join(', ')}]`,
      `    path: ${JSON.stringify(repository.path)}`,
      '    legacyWorkflowStatus: "inactive"',
      `    legacyWorkflowEntrypoints: [${repository.legacyWorkflow.detectedEntrypoints.map((entry) => JSON.stringify(entry)).join(', ')}]`,
      '    sedimentDirectory: docs/workflow-sediment',
      ...renderQualityPolicy(repository.detection, 4),
      ...renderEvidenceRoutingPolicy(repository.detection, 4),
      ...renderVerification(repository.detection.verification, 4),
    )
  }
  return `${lines.join('\n')}\n`
}

function renderAgents(template, detection) {
  return template
    .replaceAll('{{PROJECT_NAME}}', detection.projectName)
    .replaceAll('{{STACKS}}', detection.stacks.join(', '))
    .replaceAll('{{MANIFESTS}}', detection.manifests.join(', ') || '未发现已知清单')
    .replaceAll('{{VERIFICATION_COMMAND}}', detection.verificationCommand)
}

function renderWorkspaceAgents(template, repositories, heterogeneous) {
  const table = [
    '| ID | Path | Stack | Verification |',
    '| --- | --- | --- | --- |',
    ...repositories.map((repository) =>
      `| ${repository.id} | ${repository.path} | ${repository.detection.stacks.join(', ')} | ` +
      `${repository.detection.verificationCommand} |`),
  ].join('\n')
  const notice = heterogeneous
    ? [
        '### 异构技术栈特别流程',
        '',
        '当前 Workspace 包含不同技术栈。禁止用一个仓库的验证命令替代另一个仓库的验证；切换仓库时必须重新读取上表和子仓库入口文档，并分别保留验证证据。',
      ].join('\n')
    : '当前子仓库技术栈同构，但验证仍按仓库分别执行。'
  const legacyRows = repositories
    .filter((repository) => repository.legacyWorkflow.detectedEntrypoints.length > 0)
    .map((repository) =>
      `- ${repository.id}: inactive — ${repository.legacyWorkflow.detectedEntrypoints.join(', ')}`)
  const legacyNotice = legacyRows.length > 0
    ? legacyRows.join('\n')
    : '- 未检测到子仓库旧工作流入口。'
  return template
    .replace('{{REPOSITORY_TABLE}}', table)
    .replace('{{HETEROGENEOUS_NOTICE}}', notice)
    .replace('{{LEGACY_WORKFLOW_NOTICE}}', legacyNotice)
}

function isManagedHook(entry) {
  return JSON.stringify(entry).includes(workflowHookNeedle)
}

function isLegacyHook(entry) {
  return JSON.stringify(entry).includes('.agents/')
}

function mergeHooks(settings, hookTemplate, removeLegacy) {
  const next = structuredClone(settings)
  next.hooks ??= {}
  for (const [event, entries] of Object.entries(next.hooks)) {
    if (!Array.isArray(entries)) throw new Error(`Claude hook ${event} must be an array`)
    next.hooks[event] = entries.filter((entry) =>
      !isManagedHook(entry) && !(removeLegacy && isLegacyHook(entry)))
  }
  for (const [event, entries] of Object.entries(hookTemplate)) {
    next.hooks[event] = [...(next.hooks[event] ?? []), ...structuredClone(entries)]
  }
  return next
}

async function mergePackageScripts(targetDirectory, warnings) {
  const filePath = path.join(targetDirectory, 'package.json')
  const source = await readOptional(filePath)
  if (source === null) return false
  const packageJson = JSON.parse(source)
  packageJson.scripts ??= {}
  const scripts = {
    workflow: 'node tooling/ai-workflow/cli/workflow.mjs',
    'workflow:check': 'node --test tooling/ai-workflow/test/*.test.mjs',
  }
  for (const [name, value] of Object.entries(scripts)) {
    if (packageJson.scripts[name] && packageJson.scripts[name] !== value) {
      warnings.push(`package.json script ${name} already exists and was preserved`)
      continue
    }
    packageJson.scripts[name] = value
  }
  await writeText(filePath, `${JSON.stringify(packageJson, null, 2)}\n`)
  return true
}

function shouldCopy(sourceDirectory, sourcePath) {
  const relative = path.relative(sourceDirectory, sourcePath)
  if (!relative) return true
  const first = relative.split(path.sep)[0]
  return distributionEntries.has(first) && !relative.split(path.sep).some((part) => ['.git', 'node_modules', '.workflow', 'output-tdd', 'docs-tdd', 'coverage'].includes(part))
}

async function commandExists(command) {
  try {
    await execFile(command, ['--version'])
    return true
  } catch {
    return false
  }
}

async function installDependencies(engineDirectory, warnings) {
  if (await readOptional(path.join(engineDirectory, 'pnpm-lock.yaml')) !== null && await commandExists('pnpm')) {
    await execFile('pnpm', ['install', '--frozen-lockfile'], { cwd: engineDirectory })
    return 'pnpm install --frozen-lockfile'
  }
  warnings.push('pnpm or its distributed lockfile was unavailable; npm installed from package.json without creating a second lockfile')
  await execFile('npm', ['install', '--ignore-scripts', '--no-package-lock'], { cwd: engineDirectory })
  return 'npm install --ignore-scripts --no-package-lock'
}

async function runChecks(engineDirectory, targetDirectory) {
  await execFile(process.execPath, ['--test'], { cwd: engineDirectory })
  await execFile(process.execPath, [
    path.join(engineDirectory, 'cli', 'workflow.mjs'),
    'help',
    '--cwd',
    targetDirectory,
  ], { cwd: targetDirectory })
  await execFile(process.execPath, [
    path.join(engineDirectory, 'cli', 'workflow.mjs'),
    'repos',
    '--cwd',
    targetDirectory,
  ], { cwd: targetDirectory })
}

export async function installWorkflow({
  sourceDirectory,
  targetDirectory,
  apply = false,
  workspace = false,
  removeLegacy = false,
  skipInstall = false,
  skipCheck = false,
}) {
  const source = path.resolve(sourceDirectory)
  const topology = await inspectTargetTopology(path.resolve(targetDirectory))
  if (topology.mode === 'workspace-candidate' && !workspace) {
    throw Object.assign(
      new Error(
        `Target is not a Git repository and contains ${topology.repositories.length} child repositories. ` +
        'Confirm parent-managed Workspace mode with --workspace.',
      ),
      {
        code: 'WORKSPACE_CONFIRMATION_REQUIRED',
        repositories: topology.repositories.map((repository) => ({
          id: repository.id,
          path: repository.path,
          stacks: repository.detection.stacks,
          verificationCommand: repository.detection.verificationCommand,
        })),
        heterogeneous: topology.heterogeneous,
        warnings: topology.warnings,
      },
    )
  }
  if (topology.mode === 'single' && workspace) {
    throw Object.assign(
      new Error('Target is already a Git repository root; use the existing single-repository mode.'),
      { code: 'WORKSPACE_NOT_APPLICABLE' },
    )
  }
  const isWorkspace = topology.mode === 'workspace-candidate'
  const target = isWorkspace ? topology.workspaceDirectory : topology.repositoryDirectory
  const detection = isWorkspace ? null : await detectProject(target)
  const warnings = isWorkspace
    ? [
        ...topology.warnings,
        ...topology.repositories.flatMap((repository) =>
          repository.detection.warnings.map((warning) => `[${repository.id}] ${warning}`)),
      ]
    : [...detection.warnings]
  const actions = [
    'copy language-neutral workflow engine',
    'create .workflow/config.yaml when absent',
    'initialize planning modes and bounded loop policy',
    'merge the managed AGENTS.md block',
    'merge a thin CLAUDE.md bridge to the AGENTS.md source of truth',
    'merge Claude hooks without replacing unrelated hooks',
    'ensure local runtime state is Git ignored',
  ]
  if (!isWorkspace) actions.push('add workflow scripts when package.json exists')
  else actions.push('leave every child Git repository unchanged during installation')
  if (removeLegacy) actions.push('remove .agents/ and legacy .agents hook entries')

  if (!apply) {
    return {
      mode: 'dry-run',
      topology: isWorkspace ? 'workspace' : 'single',
      targetDirectory: target,
      detection,
      repositories: isWorkspace ? topology.repositories : undefined,
      heterogeneous: isWorkspace ? topology.heterogeneous : false,
      actions,
      warnings,
    }
  }

  const engineDirectory = path.join(target, 'tooling', 'ai-workflow')
  if (source !== engineDirectory) {
    await mkdir(path.dirname(engineDirectory), { recursive: true })
    await cp(source, engineDirectory, {
      recursive: true,
      force: true,
      filter: (sourcePath) => shouldCopy(source, sourcePath),
    })
  }

  const configPath = path.join(target, '.workflow', 'config.yaml')
  if (await readOptional(configPath) === null) {
    await writeText(
      configPath,
      isWorkspace
        ? renderWorkspaceConfig(target, topology.repositories)
        : renderSingleConfig(detection),
    )
  }
  else warnings.push('.workflow/config.yaml already exists and was preserved')

  const agentsTemplate = await readFile(
    path.join(source, 'templates', isWorkspace ? 'AGENTS.workspace.block.md' : 'AGENTS.block.md'),
    'utf8',
  )
  const agentsPath = path.join(target, 'AGENTS.md')
  const agentsSource = await readOptional(agentsPath) ?? ''
  await writeText(agentsPath, replaceManagedBlock(
    agentsSource,
    isWorkspace
      ? renderWorkspaceAgents(agentsTemplate, topology.repositories, topology.heterogeneous)
      : renderAgents(agentsTemplate, detection),
    '<!-- local-ai-workflow:start -->',
    '<!-- local-ai-workflow:end -->',
  ))

  const claudeTemplate = await readFile(
    path.join(source, 'templates', 'CLAUDE.block.md'),
    'utf8',
  )
  const claudePath = path.join(target, 'CLAUDE.md')
  const claudeSource = await readOptional(claudePath) ?? ''
  await writeText(claudePath, replaceManagedBlock(
    claudeSource,
    claudeTemplate,
    '<!-- local-ai-workflow-claude:start -->',
    '<!-- local-ai-workflow-claude:end -->',
  ))

  const gitignorePath = path.join(target, '.gitignore')
  const gitignoreSource = await readOptional(gitignorePath) ?? ''
  const gitignoreBlock = [
    '# local-ai-workflow:start',
    '# Local state, leases, journals, reports and operator-only inputs.',
    '/.workflow/state/',
    '/.workflow/*.local.json',
    '# local-ai-workflow:end',
  ].join('\n')
  await writeText(gitignorePath, replaceManagedBlock(
    gitignoreSource,
    gitignoreBlock,
    '# local-ai-workflow:start',
    '# local-ai-workflow:end',
  ))

  const settingsPath = path.join(target, '.claude', 'settings.json')
  const settingsSource = await readOptional(settingsPath)
  const settings = settingsSource === null ? {} : JSON.parse(settingsSource)
  const hookTemplate = JSON.parse(await readFile(path.join(source, 'templates', 'claude-hooks.json'), 'utf8'))
  await writeText(settingsPath, `${JSON.stringify(mergeHooks(settings, hookTemplate, removeLegacy), null, 2)}\n`)

  if (!isWorkspace) await mergePackageScripts(target, warnings)
  if (removeLegacy) await rm(path.join(target, '.agents'), { recursive: true, force: true })

  let dependencyCommand = null
  if (!skipInstall) dependencyCommand = await installDependencies(engineDirectory, warnings)
  if (!skipCheck) await runChecks(engineDirectory, target)

  return {
    mode: 'applied',
    topology: isWorkspace ? 'workspace' : 'single',
    targetDirectory: target,
    detection,
    repositories: isWorkspace ? topology.repositories : undefined,
    heterogeneous: isWorkspace ? topology.heterogeneous : false,
    actions,
    dependencyCommand,
    checks: skipCheck ? 'skipped' : 'passed',
    warnings,
  }
}
