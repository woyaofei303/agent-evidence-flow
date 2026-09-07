export function verificationChecks(config) {
  const commands = config.governance?.commands
  if (commands && Object.keys(commands).length) {
    const aggregate = ['check', 'verify'].find((id) => commands[id])
    const selected = aggregate ? [[aggregate, commands[aggregate]]] : ['lint', 'typecheck', 'test', 'build'].filter((id) => Object.hasOwn(commands, id)).map((id) => [id, commands[id]])
    if (!selected.length) return verificationChecks({ verification: config.verification })
    return selected.flatMap(([id, command]) => command ? [{ id, ...command }] : [])
  }
  const verification = config.verification
  return verification?.checks ?? (verification ? [{ id: 'verification', ...verification }] : [])
}

export function hasBehaviorVerification(checks) {
  return checks.some((check) => {
    if (check.coverage) return check.coverage === 'behavior'
    const command = [check.file, ...(check.args ?? [])].join(' ')
    return /(?:^|\s)(?:test|--test|pytest|vitest|jest)(?:\s|$)/.test(command)
  })
}

export function verificationDescription(verification) {
  return (verification?.checks ?? [verification]).filter(Boolean)
    .map((check) => [check.file, ...(check.args ?? [])].join(' ')).join(' && ')
}
