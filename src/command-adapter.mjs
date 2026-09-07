import { execa } from 'execa'
import { createHash } from 'node:crypto'
import { verificationChecks } from './verification-policy.mjs'

const DEFAULT_REDACTION_PATTERNS = [
  /(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi,
  /((?:token|api[_-]?key|password)\s*[=:]\s*)[^\s,;]+/gi,
]

export function redactText(value, { secrets = [] } = {}) {
  let output = String(value ?? '')

  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length > 0) {
      output = output.split(secret).join('[REDACTED]')
    }
  }

  for (const pattern of DEFAULT_REDACTION_PATTERNS) {
    output = output.replace(pattern, '$1[REDACTED]')
  }

  return output
}

export function createCommandAdapter({
  file,
  args = [],
  cwd = process.cwd(),
  environment = {},
  allowedEnvironmentVariables = [],
  secrets = [],
  idempotent = false,
  timeoutMs,
}) {
  if (typeof file !== 'string' || file.length === 0) {
    throw new TypeError('Command adapter requires a non-empty executable file')
  }

  const selectedEnvironment = {
    PATH: process.env.PATH,
    ...Object.fromEntries(
      allowedEnvironmentVariables
        .filter((name) => Object.hasOwn(process.env, name))
        .map((name) => [name, process.env[name]]),
    ),
    ...environment,
  }

  function commandEvidence(result) {
    return {
      kind: 'command',
      executable: file,
      arguments: args.map((argument) => redactText(argument, { secrets })),
      exitCode: result.exitCode ?? null,
      stdout: redactText(result.stdout, { secrets }),
      stderr: redactText(result.stderr, { secrets }),
    }
  }

  return {
    idempotent,
    async execute({ node, signal, input }) {
      try {
        const result = await execa(file, args, {
          cwd,
          env: selectedEnvironment,
          extendEnv: false,
          reject: false,
          timeout: node.timeoutMs ?? timeoutMs,
          cancelSignal: signal,
          stripFinalNewline: false,
          input,
        })
        const evidence = commandEvidence(result)

        if (result.exitCode === 0) return { status: 'succeeded', evidence }

        const code = result.timedOut
          ? 'COMMAND_TIMEOUT'
          : result.isCanceled
            ? 'COMMAND_CANCELLED'
            : 'COMMAND_EXIT_NON_ZERO'

        return {
          status: 'failed',
          error: {
            code,
            message:
              code === 'COMMAND_EXIT_NON_ZERO'
                ? `Command exited with ${result.exitCode}`
                : redactText(result.shortMessage, { secrets }),
          },
          evidence,
        }
      } catch (error) {
        const code = error.timedOut
          ? 'COMMAND_TIMEOUT'
          : error.isCanceled
            ? 'COMMAND_CANCELLED'
            : 'COMMAND_EXECUTION_ERROR'

        return {
          status: 'failed',
          error: { code, message: redactText(error.shortMessage ?? error.message, { secrets }) },
          evidence: commandEvidence(error),
        }
      }
    },
  }
}

export function createVerificationAdapter(config) {
  const checks = verificationChecks(config)
  if (!checks.length) return null
  const adapters = checks.map((check) => createCommandAdapter({ ...check, cwd: config.repositoryDirectory, idempotent: true }))
  return {
    idempotent: true,
    async execute(input) {
      const results = []
      for (const [index, adapter] of adapters.entries()) {
        const outcome = await adapter.execute(input)
        const stableOutput = value => String(value ?? '').replace(/\u001b\[[0-9;]*m/g, '')
          .replace(/\d{4}-\d\d-\d\d[T ][\d:.]+Z?/g, '<timestamp>')
          .replace(/\bduration_ms:\s*[\d.]+/g, 'duration_ms: <time>')
          .replace(/\b\d+(?:\.\d+)?\s*(?:ms|milliseconds|seconds|s)\b/g, '<duration>')
        // ponytail: normalize common test log noise; add reporter-specific failure IDs only when needed.
        const feedbackDigest = createHash('sha256').update(JSON.stringify([outcome.error?.code, outcome.evidence?.exitCode, stableOutput(outcome.evidence?.stdout), stableOutput(outcome.evidence?.stderr)])).digest('hex')
        results.push({ id: checks[index].id, coverage: checks[index].coverage ?? 'unspecified', status: outcome.status, ...outcome.evidence, error: outcome.error, feedbackDigest })
        if (input.signal?.aborted) break
      }
      const failure = results.find((result) => result.status !== 'succeeded')
      return {
        status: failure ? 'failed' : 'succeeded',
        ...(failure ? { error: failure.error } : {}),
        evidence: { ...(results.length === 1 ? results[0] : { kind: 'verification' }), checks: results },
      }
    },
  }
}
