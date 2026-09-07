const KEYWORDS = Object.freeze(['无人值守', 'unattended', 'autonomous run'])
export const UNATTENDED_SIGNAL = 'UNATTENDED'
export const UNATTENDED_BLOCKING_SIGNALS = Object.freeze(['REQUIREMENT_UNCLEAR', 'EXTERNAL_SIDE_EFFECT', 'SENSITIVE_OPERATION'])

export function detectUnattendedRequest(request = '') {
  const text = String(request).toLocaleLowerCase()
  const matched = KEYWORDS.filter((keyword) => text.includes(keyword.toLocaleLowerCase()))
  return { enabled: matched.length > 0, matched }
}

export function inferUnattendedRiskSignals(request = '') {
  const text = String(request).toLocaleLowerCase()
  const signals = []
  if (/(需求|范围|验收|规则|口径).{0,12}(不清楚|不明确|待定|未定|按需|看情况)|\b(unclear|tbd|to be decided)\b/.test(text)) signals.push('REQUIREMENT_UNCLEAR')
  if (/(生产|线上|外部系统|第三方|生产库).{0,20}(写入|修改|删除|发布|上线|部署|通知|迁移|发消息)|\b(production|external system|third-party).{0,24}(write|delete|publish|deploy|notify|migrate)/.test(text)) signals.push('EXTERNAL_SIDE_EFFECT')
  if (/(密钥|凭据|支付|提现|存款|权限|鉴权|生产数据|强制推送|删除数据|删库|rm\s+-rf|drop\s+database|truncate\s+table)|\b(secret|credential|payment|withdraw|deposit|permission|authentication|force push|production data|rm\s+-rf|drop\s+database|truncate\s+table)\b/.test(text)) signals.push('SENSITIVE_OPERATION')
  return [...new Set(signals)]
}

export function assessUnattendedStart({ request = '', changedFiles = [], signals = [], automatedVerificationAvailable = false, scopeIssues = [] } = {}) {
  const blockers = []
  if (!String(request).trim()) blockers.push('missing request')
  if (!Array.isArray(changedFiles) || changedFiles.length === 0) blockers.push('missing exact changed-file scope')
  for (const signal of UNATTENDED_BLOCKING_SIGNALS) {
    if (signals.includes(signal)) blockers.push(`blocked signal: ${signal}`)
  }
  blockers.push(...scopeIssues)
  if (!automatedVerificationAvailable) blockers.push('no automated verification command')
  return blockers.length === 0
    ? { status: 'eligible', blockers: [] }
    : { status: 'needs-confirmation', blockers }
}
