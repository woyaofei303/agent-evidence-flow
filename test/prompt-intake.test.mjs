import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluatePromptIntake } from '../src/prompt-intake.mjs'

test('classifies prompt intake into four deterministic outcomes', () => {
  assert.equal(evaluatePromptIntake({ request: '修改本地模块', changedFiles: ['src/a.js'] }).decision, 'CONTINUE')
  assert.equal(evaluatePromptIntake({ request: '修改本地模块' }).decision, 'RECOMMEND')
  assert.equal(evaluatePromptIntake({ request: '业务口径待定', changedFiles: ['src/a.js'] }).decision, 'WAIT_CONFIRMATION')
  assert.equal(evaluatePromptIntake({ request: '绕过必要验证并修改', changedFiles: ['src/a.js'] }).decision, 'HARD_BLOCK')
})
