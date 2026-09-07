import { createHash } from 'node:crypto'
import { lstat, mkdir, readdir, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { execa } from 'execa'

const ignoredDirectories = new Set(['.git', '.workflow', 'coverage', 'dist', 'node_modules', 'target', 'build', 'output-tdd', 'docs-tdd', '.next', '.nuxt', '.cache', '.venv', 'venv', '.gradle'])
const indexedExtensions = new Set(['.c', '.cc', '.css', '.go', '.java', '.js', '.json', '.jsx', '.kt', '.kts', '.md', '.mjs', '.py', '.rb', '.rs', '.sh', '.sql', '.ts', '.tsx', '.vue', '.yaml', '.yml'])
const maxBytes = 512 * 1024
const maxResults = 50

function digest(source) {
  return createHash('sha256').update(source).digest('hex')
}

const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })
const stopWords = new Set(['修复', '问题', '实现', '功能', '调整', '优化', '的', '和', 'the', 'a', 'an'])
export function tokenize(value) {
  const chunks = String(value).toLowerCase().match(/[\p{L}\p{N}_/-]+/gu) ?? []
  return [...new Set(chunks.flatMap(chunk => /\p{Script=Han}/u.test(chunk)
    ? [...segmenter.segment(chunk)].filter(item => item.isWordLike).map(item => item.segment)
    : [chunk]))].filter(term => !stopWords.has(term))
}

function safeRelative(root, candidate) {
  const relative = path.relative(root, candidate).split(path.sep).join('/')
  return relative && !relative.startsWith('../') && !path.isAbsolute(relative) ? relative : null
}

async function writeJsonAtomically(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'w', mode: 0o600 })
  await rename(temporary, filePath)
}

export async function collectContextFiles(root, directory = root, output = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue
    const candidate = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) await collectContextFiles(root, candidate, output)
      continue
    }
    if (entry.isFile() && indexedExtensions.has(path.extname(entry.name).toLowerCase())) output.push(candidate)
  }
  return output
}

export function indexFilePath(stateDirectory) {
  return path.join(path.resolve(stateDirectory), 'context-index', 'lexical-v1.json')
}

export async function buildContextIndex({ repositoryDirectory, stateDirectory }) {
  const root = await realpath(repositoryDirectory)
  const listing = await execa('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, reject: false })
  const files = listing.exitCode === 0
    ? [...new Set(listing.stdout.split('\0').filter((name) => name && !name.split('/').some((part) => ignoredDirectories.has(part)) && indexedExtensions.has(path.extname(name).toLowerCase())).map((name) => path.resolve(root, name)))]
    : await collectContextFiles(root)
  const documents = []
  const skipped = []
  for (const filePath of files.sort()) {
    const relativePath = safeRelative(root, filePath)
    const metadata = await lstat(filePath).catch(() => null)
    if (!relativePath || !metadata?.isFile() || metadata.size > maxBytes || !safeRelative(root, await realpath(filePath))) {
      skipped.push(relativePath)
      continue
    }
    const source = await readFile(filePath)
    if (source.byteLength > maxBytes || source.includes(0)) {
      skipped.push(relativePath)
      continue
    }
    const text = source.toString('utf8')
    documents.push({
      path: relativePath,
      sha256: digest(source),
      lines: text.split(/\r?\n/).map((content, index) => ({ line: index + 1, content })).filter((item) => item.content.trim()),
    })
  }
  const index = {
    schemaVersion: 1,
    kind: 'deterministic-lexical-context-index',
    indexedAt: new Date().toISOString(),
    repositoryDirectory: root,
    documents,
    skipped,
  }
  const filePath = indexFilePath(stateDirectory)
  await writeJsonAtomically(filePath, index)
  return { ok: true, filePath, documents: documents.length, skipped: skipped.length }
}

async function currentDigest(repositoryDirectory, relativePath) {
  try {
    const root = await realpath(repositoryDirectory)
    const candidate = path.resolve(root, relativePath)
    if (!safeRelative(root, candidate) || !safeRelative(root, await realpath(candidate))) return null
    return digest(await readFile(candidate))
  } catch {
    return null
  }
}

export async function searchContextIndex({ repositoryDirectory, stateDirectory, query, limit = 10 }) {
  if (typeof query !== 'string') return { ok: false, error: { code: 'EMPTY_CONTEXT_QUERY', message: 'Query must contain searchable terms' } }
  const terms = tokenize(query)
  if (terms.length === 0) return { ok: false, error: { code: 'EMPTY_CONTEXT_QUERY', message: 'Query must contain searchable terms' } }
  if (!Number.isInteger(limit) || limit < 1 || limit > maxResults) {
    return { ok: false, error: { code: 'CONTEXT_SEARCH_LIMIT_INVALID', message: `limit must be an integer from 1 to ${maxResults}` } }
  }
  let index
  try {
    index = JSON.parse(await readFile(indexFilePath(stateDirectory), 'utf8'))
  } catch (error) {
    return { ok: false, error: { code: 'CONTEXT_INDEX_NOT_FOUND', message: 'Build the context index before searching' } }
  }
  if (index.schemaVersion !== 1 || index.kind !== 'deterministic-lexical-context-index') {
    return { ok: false, error: { code: 'CONTEXT_INDEX_INVALID', message: 'Unsupported context index format' } }
  }
  const normalizedQuery = String(query).toLowerCase()
  const results = []
  for (const document of index.documents) {
    for (const entry of document.lines) {
      const normalized = entry.content.toLowerCase()
      const matchedTerms = terms.filter((term) => normalized.includes(term))
      if (matchedTerms.length === 0) continue
      const score = matchedTerms.length * 10 + (normalized.includes(normalizedQuery) ? 20 : 0) + terms.filter(term => document.path.toLowerCase().includes(term)).length * 4
      results.push({ path: document.path, line: entry.line, content: entry.content, matchedTerms, score })
    }
  }
  const selected = results.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path) || left.line - right.line).slice(0, limit)
  const hashes = new Map(index.documents.map((document) => [document.path, document.sha256]))
  const freshness = new Map(await Promise.all([...new Set(selected.map((entry) => entry.path))].map(async (file) => [file, await currentDigest(repositoryDirectory, file) !== hashes.get(file)])))
  return {
    ok: true,
    query,
    indexFile: indexFilePath(stateDirectory),
    indexedAt: index.indexedAt,
    checkedDocuments: freshness.size,
    results: selected.map((entry) => ({ ...entry, stale: freshness.get(entry.path) })),
  }
}
