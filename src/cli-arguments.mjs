export function normalizeCliArguments(values) {
  return values[0] === '--' ? values.slice(1) : [...values]
}
