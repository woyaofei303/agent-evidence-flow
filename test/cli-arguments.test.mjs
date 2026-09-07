import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeCliArguments } from '../src/cli-arguments.mjs'

test('removes the pnpm argument separator before the command', () => {
  assert.deepEqual(normalizeCliArguments(['--', 'status']), ['status'])
})

test('preserves command options and values', () => {
  assert.deepEqual(
    normalizeCliArguments(['start', '--task-id', 'task-1']),
    ['start', '--task-id', 'task-1'],
  )
})
