import { detectUnattendedRequest, inferUnattendedRiskSignals } from './unattended-policy.mjs'
import { evaluatePromptIntake } from './prompt-intake.mjs'

// Parse literal arguments only; shell expansion and redirection stay outside this gate.
function shellCommands(source) {
  const commands = []
  let words = [], word = '', quote = null, started = false
  const flush = () => { if (started) words.push(word); word = ''; started = false }
  for (let index = 0; index < source.length; index++) {
    const char = source[index]
    if (quote === "'") {
      if (char === "'") quote = null
      else word += char
      continue
    }
    if (char === '\\') {
      const next = source[++index]
      if (next === undefined || /[\r\n]/.test(next)) return null
      word += next; started = true
      continue
    }
    if (char === '$' || char === '`') return null
    if (quote === '"') {
      if (char === '"') quote = null
      else word += char
      continue
    }
    if (char === '"' || char === "'") { quote = char; started = true; continue }
    if (/[<>\r\n(){}*?\[\]#~]/.test(char)) return null
    if (/[;&|]/.test(char)) {
      flush()
      if (!words.length) return null
      commands.push(words); words = []
      if (char === '&' && source[index + 1] !== '&') return null
      if ((char === '&' || char === '|') && source[index + 1] === char) index++
    } else if (/\s/.test(char)) flush()
    else { word += char; started = true }
  }
  if (quote) return null
  flush()
  if (!words.length && commands.length) return null
  if (words.length) commands.push(words)
  return commands
}

function allowedInvocation([file, ...args]) {
  if (['ls', 'grep', 'cat', 'head', 'tail', 'wc'].includes(file)) return true
  if (file === 'pwd') return args.every(arg => ['-L', '-P'].includes(arg))
  if (file === 'rg') return args.every(arg => !/^--(?:pre|hostname-bin)/.test(arg))
  if (file === 'git') {
    const [operation, ...rest] = args
    if (operation === 'diff') {
      const separator = rest.indexOf('--')
      return (separator < 0 ? rest : rest.slice(0, separator)).every(arg =>
        ['--check', '--stat', '--name-only', '--name-status', '--no-ext-diff', '--no-textconv', '--cached', '--staged'].includes(arg) || /^-U\d+$/.test(arg) || /^[A-Za-z0-9][A-Za-z0-9_./~^@{}-]*$/.test(arg))
    }
    if (operation === 'status') return rest.every(arg => ['--short', '--porcelain', '-sb'].includes(arg))
    if (operation === 'rev-parse') return rest.length === 1 && ['HEAD', '--show-toplevel'].includes(rest[0])
    if (operation === 'remote') return rest.join(' ') === '-v' || (rest[0] === 'get-url' && rest.slice(1, -1).every(arg => ['--all', '--push'].includes(arg)) && /^[A-Za-z0-9._-]+$/.test(rest.at(-1) ?? ''))
    return false
  }
  if (file === 'node') file = args[0]
  return file === 'workflow' || /(?:^|\/)tooling\/ai-workflow\/cli\/workflow\.mjs$/.test(file ?? '')
}

function isAllowedShell(command) {
  const commands = shellCommands(String(command))
  return commands !== null && commands.every(allowedInvocation)
}

export function evaluateHook(event, input = {}, { activeRun } = {}) {
  if (event === 'pre-tool-use') {
    const toolName = input?.tool_name ?? input?.toolName ?? ''
    if (/^(Write|Edit|MultiEdit)$/i.test(toolName)) {
      if (!activeRun || ['completed', 'failed', 'cancelled', 'blocked'].includes(activeRun.status)) {
        return { decision: 'deny', reason: 'Start an active eligible workflow Run before modifying files.' }
      }
      const target = input?.tool_input?.file_path ?? input?.toolInput?.filePath ?? ''
      if (!target || !activeRun.ownedPaths?.includes(target)) {
        return { decision: 'deny', reason: 'The file is outside the active Run immutable owned paths.' }
      }
      if (activeRun.editablePaths && !activeRun.editablePaths.includes(target)) {
        return { decision: 'deny', reason: 'This phase is not open for editing. Submit planning evidence, or use workflow retry before repairing a verified implementation.' }
      }
    }
    const command = input?.tool_input?.command ?? input?.toolInput?.command ?? ''
    if (!isAllowedShell(command)) {
      return { decision: 'deny', reason: 'Unclassified Bash is denied. Use read-only shell commands, the workflow CLI, or a registered command adapter.' }
    }
    return { decision: 'allow', reason: 'Command is on the read-only/workflow CLI allowlist.' }
  }

  const runText = activeRun ? `Active workflow run: ${activeRun.runId ?? activeRun}.` : 'No active workflow run.'
  if (event === 'session-start') {
    return { decision: 'allow', message: `${runText} Use workflow start/status/resume to enter the local state machine.` }
  }
  if (event === 'user-prompt-submit') {
    const prompt = input?.prompt ?? input?.user_prompt ?? ''
    const intake = evaluatePromptIntake({ request: prompt })
    const unattended = detectUnattendedRequest(prompt)
    if (unattended.enabled) {
      const blockers = inferUnattendedRiskSignals(prompt)
      return {
        decision: 'allow',
        message: blockers.length > 0
          ? `${runText} 无人值守资格评估：WAIT_CONFIRMATION（${blockers.join(', ')}）。补齐业务边界并确认后才能启动。`
          : `${runText} 无人值守资格评估已请求；仍需在 start 时确认精确 changed-file 与自动验证能力，合格后才会启用受限 Loop。`,
      }
    }
    return {
      decision: 'allow',
      message: `${runText} Prompt Intake: ${intake.decision}. ${intake.reasons.join(', ') || 'ready'}${intake.template ? `\n${intake.template}` : ''}`,
    }
  }
  if (event === 'stop') {
    return { decision: 'allow', message: `${runText} Check workflow status before claiming completion.` }
  }
  return { decision: 'allow', message: runText }
}
