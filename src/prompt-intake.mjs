const HARD_BLOCK = /(绕过(必要)?验证|跳过必要验证|--no-verify|删除生产数据|清空生产|drop\s+database|truncate\s+table|rm\s+-rf|git\s+reset\s+--hard|git\s+push[^\n]*(--force|-f\b))/i
const AMBIGUOUS = /(需求|范围|验收|规则|口径|风险).{0,12}(不清楚|不明确|待定|未定|按需|看情况|由\s*AI\s*决定)|\b(unclear|tbd|to be decided)\b/i

export function evaluatePromptIntake({ request = '', changedFiles = [] } = {}) {
  const text = String(request).trim()
  if (HARD_BLOCK.test(text)) return { decision: 'HARD_BLOCK', reasons: ['unsafe, irreversible, or verification-bypass request'] }
  if (AMBIGUOUS.test(text)) return { decision: 'WAIT_CONFIRMATION', reasons: ['material requirement or risk ambiguity'] }
  const missing = []
  if (!text) missing.push('goal')
  if (!Array.isArray(changedFiles) || changedFiles.length === 0) missing.push('exact scope')
  if (missing.length > 0) return { decision: 'RECOMMEND', reasons: missing, template: '目标：\n范围：\n验收：\nGit：不 Commit、不 Push' }
  return { decision: 'CONTINUE', reasons: [] }
}
