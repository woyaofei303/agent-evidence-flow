#!/usr/bin/env node
import path from 'node:path'
import process from 'node:process'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import { installWorkflow } from '../src/workflow-installer.mjs'

function usage() {
  process.stdout.write(`Agent Evidence Flow installer\n\n` +
    `Usage: /absolute/path/to/agent-evidence-flow/install.sh /absolute/target [options]\n\n` +
    `Options:\n` +
    `  --apply          Write the previewed changes\n` +
    `  --workspace      Confirm that a non-Git parent manages detected child repositories\n` +
    `  --remove-legacy  Remove target .agents/ and its Claude hook entries\n` +
    `  --skip-install   Do not install engine dependencies\n` +
    `  --skip-check     Do not run engine tests and CLI smoke check\n` +
    `  --help           Show this help\n`)
}

function parseArguments(values) {
  const options = {
    apply: false,
    workspace: false,
    removeLegacy: false,
    skipInstall: false,
    skipCheck: false,
  }
  for (const value of values) {
    if (value === '--apply') options.apply = true
    else if (value === '--workspace') options.workspace = true
    else if (value === '--remove-legacy') options.removeLegacy = true
    else if (value === '--skip-install') options.skipInstall = true
    else if (value === '--skip-check') options.skipCheck = true
    else if (value === '--help') options.help = true
    else if (value.startsWith('--')) throw new Error(`Unknown option: ${value}`)
    else if (!options.targetDirectory) options.targetDirectory = value
    else throw new Error(`Unexpected argument: ${value}`)
  }
  return options
}

function printWorkspaceCandidate(error) {
  process.stderr.write(`\nDetected child Git repositories:\n`)
  for (const repository of error.repositories) {
    process.stderr.write(
      `  - ${repository.id}: ${repository.path} | ${repository.stacks.join(', ')} | ` +
      `${repository.verificationCommand}\n`,
    )
  }
  for (const warning of error.warnings ?? []) process.stderr.write(`\nWARNING: ${warning}\n`)
}

async function confirmWorkspace(error) {
  printWorkspaceCandidate(error)
  if (!process.stdin.isTTY || !process.stderr.isTTY) return false
  const prompt = createInterface({ input: process.stdin, output: process.stderr })
  try {
    const answer = await prompt.question(
      '\nTarget is not a Git repository. Manage these child repositories from the parent directory? [y/N] ',
    )
    return /^(?:y|yes)$/i.test(answer.trim())
  } finally {
    prompt.close()
  }
}

try {
  const options = parseArguments(process.argv.slice(2))
  if (options.help) {
    usage()
    process.exit(0)
  }
  if (!options.targetDirectory) {
    usage()
    process.exit(1)
  }
  const major = Number(process.versions.node.split('.')[0])
  if (major < 20) throw new Error(`Node.js >=20 is required; current version is ${process.versions.node}`)
  const sourceDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  let result
  try {
    result = await installWorkflow({ ...options, sourceDirectory })
  } catch (error) {
    if (error.code !== 'WORKSPACE_CONFIRMATION_REQUIRED') throw error
    const confirmed = await confirmWorkspace(error)
    if (!confirmed) {
      if (!process.stdin.isTTY || !process.stderr.isTTY) {
        process.stderr.write('\nWORKSPACE_CONFIRMATION_REQUIRED: re-run with --workspace after reviewing the scan.\n')
        process.exit(2)
      }
      process.stderr.write('\nWorkspace installation cancelled; no files were written.\n')
      process.exit(0)
    }
    result = await installWorkflow({ ...options, workspace: true, sourceDirectory })
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  if (!options.apply) process.stdout.write('\nDry-run only. Re-run with --apply to write these changes.\n')
} catch (error) {
  process.stderr.write(`Installer error: ${error.message}\n`)
  process.exit(1)
}
