import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { dropStaleBuildInfo } from './drop-stale-buildinfo'

const root = resolve(import.meta.dir, '..')

// Scaffold sources embed `import ... from '@breadai/...'` inside template
// strings. Those are generated app text, not modules this package imports.
function importedBreadPackages(source: string): Set<string> {
  const found = new Set<string>()
  const length = source.length
  let index = 0

  function skipSpaceAndComments(): void {
    for (;;) {
      while (index < length && /[\t\n\r\f ]/.test(source[index] ?? '')) index += 1
      if (source[index] === '/' && source[index + 1] === '/') {
        index += 2
        while (index < length && source[index] !== '\n') index += 1
        continue
      }
      if (source[index] === '/' && source[index + 1] === '*') {
        index += 2
        while (index + 1 < length && !(source[index] === '*' && source[index + 1] === '/')) index += 1
        index = Math.min(length, index + 2)
        continue
      }
      return
    }
  }

  function readQuoted(quote: '"' | "'"): string {
    let value = ''
    index += 1
    while (index < length) {
      const char = source[index]
      if (char === '\\') {
        value += source[index + 1] ?? ''
        index += 2
        continue
      }
      if (char === quote) {
        index += 1
        return value
      }
      if (char === '\n') return value
      value += char
      index += 1
    }
    return value
  }

  function skipRegex(): void {
    index += 1
    while (index < length) {
      const char = source[index]
      if (char === '\\') {
        index += 2
        continue
      }
      if (char === '[') {
        index += 1
        while (index < length && source[index] !== ']' && source[index] !== '\n') {
          if (source[index] === '\\') index += 2
          else index += 1
        }
        if (source[index] === ']') index += 1
        continue
      }
      if (char === '/' || char === '\n') {
        if (char === '/') index += 1
        break
      }
      index += 1
    }
    while (index < length && /[a-z]/i.test(source[index] ?? '')) index += 1
  }

  function templateIsStatic(start: number): boolean {
    let cursor = start + 1
    while (cursor < length) {
      const char = source[cursor]
      if (char === '\\') {
        cursor += 2
        continue
      }
      if (char === '`') return true
      if (char === '$' && source[cursor + 1] === '{') return false
      cursor += 1
    }
    return false
  }

  function readStaticTemplate(): string {
    let value = ''
    index += 1
    while (index < length) {
      const char = source[index]
      if (char === '\\') {
        value += source[index + 1] ?? ''
        index += 2
        continue
      }
      if (char === '`') {
        index += 1
        return value
      }
      value += char
      index += 1
    }
    return value
  }

  function record(spec: string): void {
    const match = /^@breadai\/[A-Za-z0-9-]+/.exec(spec)
    if (match?.[0]) found.add(match[0])
  }

  function canStartRegex(previous: string): boolean {
    if (previous === 'number' || previous === 'string' || previous === 'template' || previous === 'regex') {
      return false
    }
    if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(previous)) {
      return (
        previous === 'return' ||
        previous === 'throw' ||
        previous === 'case' ||
        previous === 'void' ||
        previous === 'typeof' ||
        previous === 'delete' ||
        previous === 'await' ||
        previous === 'yield' ||
        previous === 'else' ||
        previous === 'do' ||
        previous === 'in' ||
        previous === 'of' ||
        previous === 'instanceof' ||
        previous === 'new' ||
        previous === 'extends'
      )
    }
    return previous !== '++' && previous !== '--'
  }

  function scan(stopOnBrace: boolean): void {
    let brace = 0
    let previous = ''
    while (index < length) {
      skipSpaceAndComments()
      if (index >= length) return
      const char = source[index]
      if (stopOnBrace && char === '}' && brace === 0) {
        index += 1
        return
      }
      if (char === '{') {
        brace += 1
        index += 1
        previous = '{'
        continue
      }
      if (char === '}') {
        brace -= 1
        index += 1
        previous = '}'
        continue
      }
      if (char === "'" || char === '"') {
        const spec = readQuoted(char)
        if (previous === 'from' || previous === 'import' || previous === 'import-call') record(spec)
        previous = 'string'
        continue
      }
      if (char === '`') {
        const specifier =
          (previous === 'from' || previous === 'import' || previous === 'import-call') && templateIsStatic(index)
        if (specifier) {
          record(readStaticTemplate())
          previous = 'string'
          continue
        }
        index += 1
        while (index < length) {
          const templateChar = source[index]
          if (templateChar === '\\') {
            index += 2
            continue
          }
          if (templateChar === '`') {
            index += 1
            break
          }
          if (templateChar === '$' && source[index + 1] === '{') {
            index += 2
            scan(true)
            continue
          }
          index += 1
        }
        previous = 'template'
        continue
      }
      if (char === '/' && source[index + 1] !== '/' && source[index + 1] !== '*' && canStartRegex(previous)) {
        skipRegex()
        previous = 'regex'
        continue
      }
      if (char !== undefined && char >= '0' && char <= '9') {
        index += 1
        while (index < length && /[0-9A-Fa-fxo._]/.test(source[index] ?? '')) index += 1
        previous = 'number'
        continue
      }
      if (char !== undefined && /[A-Za-z_$]/.test(char)) {
        const start = index
        index += 1
        while (index < length && /[A-Za-z0-9_$]/.test(source[index] ?? '')) index += 1
        previous = source.slice(start, index)
        continue
      }
      if (char === '(' && previous === 'import') {
        index += 1
        previous = 'import-call'
        continue
      }
      if (char === '+' && source[index + 1] === '+') {
        index += 2
        previous = '++'
        continue
      }
      if (char === '-' && source[index + 1] === '-') {
        index += 2
        previous = '--'
        continue
      }
      index += 1
      previous = char ?? ''
    }
  }

  scan(false)
  return found
}

interface WorkspacePackage {
  name: string
  dir: string
  manifestPath: string
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

function workspacePackages(): WorkspacePackage[] {
  const manifest = readJson(join(root, 'package.json'))
  const patterns = manifest.workspaces
  if (!Array.isArray(patterns)) throw new Error('root package.json has no workspaces')
  const packages: WorkspacePackage[] = []
  for (const pattern of patterns) {
    if (typeof pattern !== 'string' || !pattern.endsWith('/*')) continue
    const parent = join(root, pattern.slice(0, -2))
    let entries: string[]
    try {
      entries = readdirSync(parent)
    } catch {
      continue
    }
    for (const entry of entries) {
      const dir = join(parent, entry)
      const manifestPath = join(dir, 'package.json')
      try {
        if (!statSync(dir).isDirectory() || !statSync(manifestPath).isFile()) continue
      } catch {
        continue
      }
      const pkg = readJson(manifestPath)
      if (typeof pkg.name !== 'string') continue
      packages.push({ name: pkg.name, dir, manifestPath })
    }
  }
  return packages
}

function isExample(dir: string): boolean {
  const rel = relative(root, dir).split(sep).join('/')
  return rel === 'examples' || rel.startsWith('examples/')
}

function solutionPackages(): WorkspacePackage[] {
  return workspacePackages().filter((pkg) => !isExample(pkg.dir) && statSync(join(pkg.dir, 'tsconfig.json')).isFile())
}

function walkSources(dir: string, acc: string[] = []): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return acc
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'dist' || entry === 'test') continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) walkSources(path, acc)
    else if (/\.(tsx?|mts|cts)$/.test(entry)) acc.push(path)
  }
  return acc
}

function srcImports(dir: string, self: string): Set<string> {
  const specs = new Set<string>()
  for (const file of walkSources(join(dir, 'src'))) {
    for (const spec of importedBreadPackages(readFileSync(file, 'utf8'))) specs.add(spec)
  }
  specs.delete(self)
  return specs
}

function packageDirsByName(packages: WorkspacePackage[]): Map<string, string> {
  const dirs = new Map<string, string>()
  for (const pkg of packages) dirs.set(pkg.name, pkg.dir)
  return dirs
}

interface Reference {
  path: string
}

function referenceDirs(fromDir: string, references: Reference[] | undefined): string[] {
  return (references ?? []).map((reference) => {
    const resolved = resolve(fromDir, reference.path)
    return resolved.endsWith(`${sep}tsconfig.json`) ? dirname(resolved) : resolved
  })
}

function everyManifest(): string[] {
  const found: string[] = []
  function walk(dir: string): void {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue
      const path = join(dir, entry)
      if (statSync(path).isDirectory()) walk(path)
      else if (entry === 'package.json') found.push(path)
    }
  }
  walk(root)
  return found
}

const tscCommand = 'tsc -b --pretty false --builders 1'
const rootTypecheck = `bun scripts/drop-stale-buildinfo.ts && ${tscCommand}`
const packageTypecheck = `bun ../../scripts/drop-stale-buildinfo.ts && ${tscCommand}`

function dependencyFields(manifest: Record<string, unknown>): Record<string, unknown>[] {
  const fields = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
  return fields
    .map((field) => manifest[field])
    .filter((value): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value))
}

describe('typecheck solution', () => {
  test('root typecheck is one tsc -b and build starts with that command', () => {
    const manifest = readJson(join(root, 'package.json'))
    const scripts = manifest.scripts
    if (typeof scripts !== 'object' || scripts === null) throw new Error('root scripts missing')
    const typecheck = (scripts as Record<string, unknown>).typecheck
    const build = (scripts as Record<string, unknown>).build
    expect(typeof typecheck).toBe('string')
    expect(typeof build).toBe('string')
    const typecheckCommand = typecheck as string
    const buildCommand = build as string
    expect(typecheckCommand).toBe(rootTypecheck)
    expect(typecheckCommand.includes('--filter')).toBe(false)
    expect(buildCommand.startsWith(`${typecheckCommand} && `)).toBe(true)
    const after = buildCommand.slice(typecheckCommand.length)
    expect(/\btsc\b/.test(after)).toBe(false)
  })

  test('package typecheck drops a stale cache and then runs one tsc -b', () => {
    const offenders: string[] = []
    for (const pkg of solutionPackages()) {
      const manifest = readJson(join(pkg.dir, 'package.json'))
      const scripts = manifest.scripts
      const command = typeof scripts === 'object' && scripts !== null ? (scripts as Record<string, unknown>).typecheck : undefined
      if (command !== packageTypecheck) offenders.push(`${pkg.name}: ${String(command)}`)
    }
    expect(offenders).toEqual([])
  })

  test('no package script runs tsc --noEmit or emitDeclarationOnly', () => {
    const offenders: string[] = []
    for (const manifestPath of everyManifest()) {
      const manifest = readJson(manifestPath)
      const scripts = manifest.scripts
      if (typeof scripts !== 'object' || scripts === null) continue
      for (const [name, command] of Object.entries(scripts)) {
        if (typeof command !== 'string') continue
        if (command.includes('tsc --noEmit') || command.includes('emitDeclarationOnly')) {
          offenders.push(`${relative(root, manifestPath)} ${name}: ${command}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  test('every typescript dependency is ^7', () => {
    const offenders: string[] = []
    for (const manifestPath of everyManifest()) {
      const manifest = readJson(manifestPath)
      for (const field of dependencyFields(manifest)) {
        const version = field.typescript
        if (version === undefined) continue
        if (typeof version !== 'string' || !/^\^7(\.|$)/.test(version)) {
          offenders.push(`${relative(root, manifestPath)} typescript=${String(version)}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  test('incremental state sits beside the package tsconfig and is gitignored', () => {
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toContain('*.tsbuildinfo')
    const base = readJson(join(root, 'tsconfig.base.json'))
    const baseOptions = base.compilerOptions
    if (typeof baseOptions !== 'object' || baseOptions === null) throw new Error('base compilerOptions missing')
    expect((baseOptions as Record<string, unknown>).tsBuildInfoFile).toBe('${configDir}/tsconfig.tsbuildinfo')
    const problems: string[] = []
    for (const pkg of solutionPackages()) {
      const tsconfig = readJson(join(pkg.dir, 'tsconfig.json'))
      const options = tsconfig.compilerOptions
      if (typeof options !== 'object' || options === null) {
        problems.push(`${pkg.name} has no compilerOptions`)
        continue
      }
      const record = options as Record<string, unknown>
      if (record.outDir !== './dist') problems.push(`${pkg.name} outDir is ${String(record.outDir)}`)
      if ('tsBuildInfoFile' in record) problems.push(`${pkg.name} overrides tsBuildInfoFile`)
    }
    expect(problems).toEqual([])
  })

  test('a package cache is removed when dist has no declarations', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'bread-buildinfo-'))
    try {
      const pkg = join(fixture, 'packages', 'core')
      mkdirSync(join(pkg, 'dist'), { recursive: true })
      writeFileSync(join(pkg, 'tsconfig.tsbuildinfo'), '{}')
      writeFileSync(join(pkg, 'dist', 'tsconfig.tsbuildinfo'), '{}')
      writeFileSync(join(pkg, 'dist', 'index.d.ts'), 'export {}')
      dropStaleBuildInfo(fixture)
      expect(existsSync(join(pkg, 'tsconfig.tsbuildinfo'))).toBe(true)
      expect(existsSync(join(pkg, 'dist', 'tsconfig.tsbuildinfo'))).toBe(false)

      rmSync(join(pkg, 'dist'), { recursive: true })
      dropStaleBuildInfo(fixture)
      expect(existsSync(join(pkg, 'tsconfig.tsbuildinfo'))).toBe(false)
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })

  test('root references are exactly the non-example workspace tsconfigs', () => {
    const tsconfig = readJson(join(root, 'tsconfig.json'))
    const references = Array.isArray(tsconfig.references) ? (tsconfig.references as Reference[]) : []
    const referenced = referenceDirs(root, references).map((dir) => relative(root, dir).split(sep).join('/')).sort()
    const examples = referenced.filter((dir) => dir === 'examples' || dir.startsWith('examples/'))
    expect(examples).toEqual([])
    const expected = solutionPackages()
      .map((pkg) => relative(root, pkg.dir).split(sep).join('/'))
      .sort()
    expect(referenced).toEqual(expected)
  })

  test('package references match @breadai imports from src', () => {
    const packages = workspacePackages()
    const dirs = packageDirsByName(packages)
    const problems: string[] = []
    for (const pkg of solutionPackages()) {
      const tsconfig = readJson(join(pkg.dir, 'tsconfig.json'))
      const references = Array.isArray(tsconfig.references) ? (tsconfig.references as Reference[]) : []
      const actual = referenceDirs(pkg.dir, references).sort()
      const expectedNames = [...srcImports(pkg.dir, pkg.name)].sort()
      const expected: string[] = []
      for (const name of expectedNames) {
        const dir = dirs.get(name)
        if (!dir) {
          problems.push(`${pkg.name} imports ${name}, which is not a workspace package`)
          continue
        }
        expected.push(dir)
      }
      expected.sort()
      if (actual.join('\n') !== expected.join('\n')) {
        const rel = (dir: string) => relative(root, dir).split(sep).join('/')
        problems.push(
          `${pkg.name} references [${actual.map(rel).join(', ')}] but src imports [${expected.map(rel).join(', ')}]`,
        )
      }
    }
    expect(problems).toEqual([])
  })

  test('package references are a DAG', () => {
    const color = new Map<string, number>()
    const graph = new Map<string, string[]>()
    for (const pkg of solutionPackages()) {
      const tsconfig = readJson(join(pkg.dir, 'tsconfig.json'))
      const references = Array.isArray(tsconfig.references) ? (tsconfig.references as Reference[]) : []
      graph.set(pkg.dir, referenceDirs(pkg.dir, references))
    }
    const stack: string[] = []
    function visit(dir: string): string[] | null {
      const state = color.get(dir) ?? 0
      if (state === 1) return [...stack, dir]
      if (state === 2) return null
      color.set(dir, 1)
      stack.push(dir)
      for (const next of graph.get(dir) ?? []) {
        const cycle = visit(next)
        if (cycle) return cycle
      }
      stack.pop()
      color.set(dir, 2)
      return null
    }
    const cycles: string[] = []
    for (const dir of graph.keys()) {
      const cycle = visit(dir)
      if (cycle) {
        cycles.push(cycle.map((item) => relative(root, item).split(sep).join('/')).join(' -> '))
        break
      }
    }
    expect(cycles).toEqual([])
  })

  test('typecheck and build workflows pin Node 24 before Bun', () => {
    const workflows = ['ci.yml', 'release.yml', 'publish.yml', 'example-check.yml']
    const problems: string[] = []
    for (const file of workflows) {
      const text = readFileSync(join(root, '.github/workflows', file), 'utf8')
      const setupNode = text.indexOf('actions/setup-node@v4')
      const setupBun = text.indexOf('oven-sh/setup-bun')
      if (setupNode < 0 || !/node-version:\s*["']24["']/.test(text)) {
        problems.push(`${file} is missing actions/setup-node@v4 with node-version 24`)
        continue
      }
      if (setupBun < 0 || setupNode > setupBun) problems.push(`${file} must set up Node 24 before Bun`)
    }
    expect(problems).toEqual([])
  })
})
