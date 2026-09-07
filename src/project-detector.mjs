import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { verificationDescription } from './verification-policy.mjs'

async function readOptional(directory, name) {
  try {
    return await readFile(path.join(directory, name), 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

function matchValue(source, pattern) {
  return source?.match(pattern)?.[1]?.trim() ?? null
}

function packageManager(files, packageJson) {
  const declared = packageJson?.packageManager?.split('@')[0]
  if (['pnpm', 'yarn', 'npm', 'bun'].includes(declared)) return declared
  if (files.pnpmLock !== null) return 'pnpm'
  if (files.yarnLock !== null) return 'yarn'
  if (files.bunLock !== null || files.bunLockb !== null) return 'bun'
  return packageJson ? 'npm' : null
}

function nodeVerification(manager, scripts = {}) {
  const available = ['check', 'verify', 'lint', 'typecheck', 'test', 'build'].filter((candidate) => {
    const value = scripts[candidate]
    return typeof value === 'string' && value.trim() && !/no test specified/i.test(value)
  })
  if (!available.length) return null
  const aggregate = available.find((id) => ['check', 'verify'].includes(id))
  const selected = aggregate ? [aggregate] : available
  const commands = selected.map((script) => ({ file: manager, args: ['pnpm', 'yarn'].includes(manager) ? [script] : ['run', script], timeoutMs: 120_000 }))
  if (commands.length === 1) return {
    ...commands[0],
    ...(aggregate ? { coverage: /\b(?:test|vitest|jest|pytest)\b/.test(scripts[aggregate]) ? 'behavior' : 'static' } : {}),
  }
  return { checks: commands.map((command, index) => ({ id: selected[index], ...command, coverage: selected[index] === 'test' ? 'behavior' : selected[index] === 'build' ? 'build' : 'static' })) }
}

function nodeStacks(packageJson) {
  if (!packageJson) return []
  const dependencies = { ...packageJson.devDependencies, ...packageJson.dependencies }
  const frameworks = [
    ['next', 'Next.js'],
    ['nuxt', 'Nuxt'],
    ['vue', 'Vue'],
    ['react', 'React'],
    ['@nestjs/core', 'NestJS'],
    ['express', 'Express'],
    ['svelte', 'Svelte'],
  ]
  return ['Node.js', ...frameworks.filter(([name]) => dependencies[name]).map(([, label]) => label)]
}

function parseJson(source, fileName, warnings) {
  if (source === null) return null
  try {
    return JSON.parse(source)
  } catch (error) {
    warnings.push(`${fileName} could not be parsed: ${error.message}`)
    return null
  }
}

export async function detectProject(directory) {
  const repositoryDirectory = path.resolve(directory)
  const names = {
    packageJson: 'package.json',
    pnpmLock: 'pnpm-lock.yaml',
    yarnLock: 'yarn.lock',
    bunLock: 'bun.lock',
    bunLockb: 'bun.lockb',
    pubspec: 'pubspec.yaml',
    cargo: 'Cargo.toml',
    goMod: 'go.mod',
    pyproject: 'pyproject.toml',
    requirements: 'requirements.txt',
    gradle: 'build.gradle',
    gradleKts: 'build.gradle.kts',
    settingsGradle: 'settings.gradle',
    settingsGradleKts: 'settings.gradle.kts',
    gradleWrapper: 'gradlew',
    maven: 'pom.xml',
    mavenWrapper: 'mvnw',
  }
  const entries = await Promise.all(Object.entries(names).map(async ([key, name]) =>
    [key, await readOptional(repositoryDirectory, name)]))
  const files = Object.fromEntries(entries)
  const warnings = []
  const packageJson = parseJson(files.packageJson, 'package.json', warnings)
  const manager = packageManager(files, packageJson)
  const stacks = nodeStacks(packageJson)
  const manifests = []

  if (files.packageJson !== null) manifests.push('package.json')
  const isFlutter = files.pubspec !== null && /\n\s*flutter:\s*\n\s*sdk:\s*flutter\b/m.test(`\n${files.pubspec}`)
  if (files.pubspec !== null) {
    manifests.push('pubspec.yaml')
    stacks.push('Dart')
    if (isFlutter) stacks.push('Flutter')
  }
  if (files.cargo !== null) {
    manifests.push('Cargo.toml')
    stacks.push('Rust')
  }
  if (files.goMod !== null) {
    manifests.push('go.mod')
    stacks.push('Go')
  }
  if (files.pyproject !== null || files.requirements !== null) {
    if (files.pyproject !== null) manifests.push('pyproject.toml')
    if (files.requirements !== null) manifests.push('requirements.txt')
    stacks.push('Python')
  }
  if (files.gradle !== null || files.gradleKts !== null) {
    manifests.push(files.gradleKts !== null ? 'build.gradle.kts' : 'build.gradle')
    stacks.push('Java/JVM')
    if (/org\.jetbrains\.kotlin|kotlin\s*\(/.test(`${files.gradle ?? ''}\n${files.gradleKts ?? ''}`)) {
      stacks.push('Kotlin')
    }
    stacks.push('Gradle')
  }
  if (files.maven !== null) {
    manifests.push('pom.xml')
    stacks.push('Java/JVM')
    if (/kotlin-maven-plugin|kotlin-stdlib/.test(files.maven)) stacks.push('Kotlin')
    stacks.push('Maven')
  }

  const nodeCommand = packageJson ? nodeVerification(manager, packageJson.scripts) : null
  let verification = nodeCommand
  if (!verification && isFlutter) verification = { file: 'flutter', args: ['test'], timeoutMs: 300_000 }
  if (!verification && files.pubspec !== null) verification = { file: 'dart', args: ['test'], timeoutMs: 300_000 }
  if (!verification && files.cargo !== null) verification = { file: 'cargo', args: ['test'], timeoutMs: 300_000 }
  if (!verification && files.goMod !== null) verification = { file: 'go', args: ['test', './...'], timeoutMs: 300_000 }
  if (!verification && (files.pyproject !== null || files.requirements !== null)) {
    verification = { file: 'python', args: ['-m', 'pytest'], timeoutMs: 300_000 }
  }
  if (!verification && (files.gradle !== null || files.gradleKts !== null)) {
    verification = {
      file: files.gradleWrapper !== null ? './gradlew' : 'gradle',
      args: ['test'],
      timeoutMs: 300_000,
    }
  }
  if (!verification && files.maven !== null) {
    verification = {
      file: files.mavenWrapper !== null ? './mvnw' : 'mvn',
      args: ['test'],
      timeoutMs: 300_000,
    }
  }
  if (!verification) verification = { file: 'git', args: ['diff', '--check'], timeoutMs: 120_000 }

  const pubspecName = matchValue(files.pubspec, /^name:\s*([^\s#]+)\s*$/m)
  const cargoName = matchValue(files.cargo, /^name\s*=\s*["']([^"']+)["']/m)
  const goModule = matchValue(files.goMod, /^module\s+([^\s]+)\s*$/m)
  const pythonName = matchValue(files.pyproject, /^name\s*=\s*["']([^"']+)["']/m)
  const gradleSettings = `${files.settingsGradle ?? ''}\n${files.settingsGradleKts ?? ''}`
  const gradleName = matchValue(gradleSettings, /rootProject\.name\s*=\s*["']([^"']+)["']/m)
  const pomWithoutParent = files.maven?.replace(/<parent>[\s\S]*?<\/parent>/, '') ?? null
  const mavenName = matchValue(pomWithoutParent, /<artifactId>\s*([^<\s]+)\s*<\/artifactId>/m)
  const projectName = packageJson?.name || pubspecName || cargoName ||
    (goModule ? goModule.split('/').at(-1) : null) || pythonName || gradleName || mavenName ||
    path.basename(repositoryDirectory)

  return {
    projectName,
    stacks: [...new Set(stacks.length ? stacks : ['Unknown'])],
    packageManager: manager,
    manifests,
    verification,
    verificationCommand: verificationDescription(verification),
    warnings,
  }
}
