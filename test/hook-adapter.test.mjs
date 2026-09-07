import assert from 'node:assert/strict'
import test from 'node:test'
import { evaluateHook } from '../src/hook-adapter.mjs'

test('understands quoted search and JSON arguments without allowing executable options', () => {
  const decision = command => evaluateHook('pre-tool-use', { tool_name: 'Bash', tool_input: { command } }).decision
  for (const command of ['rg "foo|bar" src', 'git diff -- src/a.js', `node tooling/ai-workflow/cli/workflow.mjs resolve --json '{"text":"a > b; c|d"}'`, 'git diff --no-ext-diff --no-textconv --stat']) assert.equal(decision(command), 'allow', command)
  for (const command of ['rg --pre=touch foo src', 'rg --hostname-bin touch foo', 'git diff --output=out', 'git diff --textconv', 'pwdanything', 'cat "$(touch out)"', 'cat x &', 'rg "unterminated', 'node tooling/ai-workflow/cli/workflow.mjs status; touch out']) assert.equal(decision(command), 'deny', command)
})

test('denies direct staging and committing so the engine owns Git mutations', () => {
  assert.equal(
    evaluateHook('pre-tool-use', { tool_input: { command: 'git add src/a.ts' } }).decision,
    'deny',
  )
  assert.equal(
    evaluateHook('pre-tool-use', { tool_input: { command: 'pnpm test && git commit -m test' } }).decision,
    'deny',
  )
  assert.equal(evaluateHook('pre-tool-use', { tool_input: { command: 'rm -rf build' } }).decision, 'deny')
  assert.equal(evaluateHook('pre-tool-use', { tool_input: { command: 'sed -i s/a/b/ src/a.js' } }).decision, 'deny')
  for (const command of [
    'command rm x', 'env rm x', 'if rm x; then true; fi', '/bin/rm x', "bash -c 'rm x'",
    `python -c "open('x','w').write('x')"`, `node -e "require('fs').writeFileSync('x','x')"`,
    'dd if=/dev/null of=x', 'truncate -s 0 x', 'patch < change.diff', 'git apply change.diff',
    'git restore x', 'git checkout -- x', 'git reset --hard', 'git clean -fd',
    'cat source > out', 'rg pattern > out', 'cat $(touch out)', 'cat `touch out`',
    'find . -fprintf out text', 'git branch -D name', 'git remote add name url', 'git diff --ext-diff',
    'rm -rf x tooling/ai-workflow/cli/workflow.mjs',
  ]) assert.equal(evaluateHook('pre-tool-use', { tool_input: { command } }).decision, 'deny', command)
  assert.equal(evaluateHook('pre-tool-use', { tool_input: { command: 'rg -n TODO src | head -20' } }).decision, 'allow')
  assert.equal(evaluateHook('pre-tool-use', { tool_input: { command: 'git status --short && git diff --check' } }).decision, 'allow')
  assert.equal(evaluateHook('pre-tool-use', { tool_input: { command: 'node tooling/ai-workflow/cli/workflow.mjs status' } }).decision, 'allow')
})

test('allows ordinary commands and reports the active run', () => {
  assert.equal(
    evaluateHook('pre-tool-use', { tool_input: { command: 'rg -n TODO src' } }).decision,
    'allow',
  )
  assert.match(evaluateHook('session-start', {}, { activeRun: 'task-1' }).message, /task-1/)
})

test('reports unattended eligibility before start and surfaces inferred blockers', () => {
  const eligible = evaluateHook('user-prompt-submit', { prompt: '无人值守完成明确的本地改动' }, { activeRun: null })
  assert.match(eligible.message, /资格评估已请求/)
  const blocked = evaluateHook('user-prompt-submit', { prompt: '无人值守，需求口径待定并修改生产数据' }, { activeRun: null })
  assert.match(blocked.message, /WAIT_CONFIRMATION/)
  assert.match(blocked.message, /REQUIREMENT_UNCLEAR/)
  assert.match(blocked.message, /SENSITIVE_OPERATION/)
})

test('denies file mutation before an active workflow run exists', () => {
  assert.equal(evaluateHook('pre-tool-use', { tool_name: 'Write' }, { activeRun: null }).decision, 'deny')
  const activeRun = { runId: 'task-1', status: 'waiting', ownedPaths: ['/repo/owned.js'] }
  assert.equal(evaluateHook('pre-tool-use', { tool_name: 'Edit', tool_input: { file_path: '/repo/owned.js' } }, { activeRun }).decision, 'allow')
  assert.equal(evaluateHook('pre-tool-use', { tool_name: 'Edit', tool_input: { file_path: '/repo/owned.js' } }, { activeRun: { ...activeRun, editablePaths: [] } }).decision, 'deny')
  assert.equal(evaluateHook('pre-tool-use', { tool_name: 'Edit', tool_input: { file_path: '/repo/other.js' } }, { activeRun }).decision, 'deny')
  assert.equal(evaluateHook('pre-tool-use', { tool_name: 'Edit', tool_input: { file_path: '/repo/owned.js' } }, { activeRun: { ...activeRun, status: 'completed' } }).decision, 'deny')
  assert.equal(evaluateHook('pre-tool-use', { tool_name: 'Edit', tool_input: { file_path: '/repo/owned.js' } }, { activeRun: { ...activeRun, status: 'blocked' } }).decision, 'deny')
})
