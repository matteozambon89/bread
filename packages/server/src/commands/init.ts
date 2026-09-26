import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { BreadError } from '@breadai/core'
import { assertKnownProvider, assertModelId } from '../scaffold/catalog.js'
import { assertAgentId, pathExists } from '../scaffold/names.js'
import {
  GITIGNORE,
  PROMPT_MD,
  agentSource,
  breadConfig,
  packageJson,
  type ListenRuntime,
  type StoreKind,
  type TransportKind,
} from '../scaffold/templates.js'

export interface InitOptions {
  dir?: string
  runtime: ListenRuntime
  store: StoreKind
  transport: TransportKind
  agent: string
  provider: string
  model: string
  noInstall?: boolean
}

const RUNTIMES = new Set<ListenRuntime>(['bun', 'node'])
const STORES = new Set<StoreKind>(['sqlite', 'memory', 'postgres'])
const TRANSPORTS = new Set<TransportKind>(['chunked', 'sse'])

function assertChoices(opts: InitOptions): void {
  if (!RUNTIMES.has(opts.runtime) || !STORES.has(opts.store) || !TRANSPORTS.has(opts.transport)) {
    throw new BreadError(
      `Unsupported scaffold choice (runtime ${opts.runtime}, store ${opts.store}, transport ${opts.transport}).`,
      'SCAFFOLD_INVALID_NAME',
      { runtime: opts.runtime, store: opts.store, transport: opts.transport },
    )
  }
  if (opts.runtime === 'node' && opts.store === 'sqlite') {
    throw new BreadError(
      'Refusing --runtime node with --store sqlite: a Node listen child cannot load bun:sqlite. Pass --store memory or --store postgres. Nothing was written.',
      'SCAFFOLD_INVALID_NAME',
      { runtime: opts.runtime, store: opts.store },
    )
  }
}

async function assertTarget(root: string): Promise<void> {
  if (!(await pathExists(root))) return
  for (const marker of ['bread.config.ts', 'package.json', 'agents']) {
    if (await pathExists(join(root, marker))) {
      throw new BreadError(
        `Refusing to init ${root}: ${marker} already exists. Nothing was written.`,
        'SCAFFOLD_EXISTS',
        { dir: root, path: marker },
      )
    }
  }
}

function appendIgnoreLines(existing: string): string {
  const present = new Set(existing.split(/\r?\n/))
  const missing = GITIGNORE.split(/\r?\n/).filter((line) => line.length > 0 && !present.has(line))
  if (missing.length === 0) return existing
  const prefix = existing.length === 0 || existing.endsWith('\n') ? existing : `${existing}\n`
  return `${prefix}${missing.join('\n')}\n`
}

interface RollbackState {
  files: string[]
  dirs: string[]
  gitignore?: { path: string; prior: string }
}

async function rollback(state: RollbackState): Promise<void> {
  for (const file of [...state.files].reverse()) await rm(file, { force: true })
  const dirs = [...state.dirs].sort((a, b) => b.length - a.length)
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
  if (state.gitignore) await writeFile(state.gitignore.path, state.gitignore.prior)
}

async function writeNew(path: string, body: string, state: RollbackState): Promise<void> {
  state.files.push(path)
  await writeFile(path, body)
}

async function writeGitignore(root: string, state: RollbackState): Promise<void> {
  const path = join(root, '.gitignore')
  if (!(await pathExists(path))) {
    await writeNew(path, GITIGNORE, state)
    return
  }
  const prior = await readFile(path, 'utf8')
  const next = appendIgnoreLines(prior)
  if (next === prior) return
  state.gitignore = { path, prior }
  await writeFile(path, next)
}

export async function runInit(opts: InitOptions): Promise<void> {
  const root = resolve(opts.dir ?? '.')
  assertAgentId(opts.agent)
  assertChoices(opts)
  const provider = assertKnownProvider(opts.provider)
  const model = assertModelId(opts.model)
  await assertTarget(root)

  const choices = {
    agent: opts.agent,
    runtime: opts.runtime,
    store: opts.store,
    transport: opts.transport,
  }
  // A partial tree makes the next init throw SCAFFOLD_EXISTS. bun install stays
  // outside this try: that error already says the project files were written.
  const state: RollbackState = { files: [], dirs: [] }
  const agentsDir = join(root, 'agents')
  const agentDir = join(agentsDir, opts.agent)
  try {
    if (!(await pathExists(root))) state.dirs.push(root)
    state.dirs.push(agentsDir, agentDir)
    await mkdir(agentDir, { recursive: true })
    await writeNew(join(root, 'package.json'), packageJson(root, choices), state)
    await writeNew(join(root, 'bread.config.ts'), breadConfig(choices), state)
    await writeNew(join(agentDir, 'agent.ts'), agentSource(provider, model), state)
    await writeNew(join(agentDir, 'prompt.md'), PROMPT_MD, state)
    await writeGitignore(root, state)
  } catch (err) {
    await rollback(state)
    throw err
  }

  if (!opts.noInstall) {
    const proc = Bun.spawn(['bun', 'install'], {
      cwd: root,
      stdout: 'inherit',
      stderr: 'inherit',
    })
    const exitCode = await proc.exited
    if (exitCode !== 0) {
      throw new BreadError(
        `Project files were written, but bun install failed (exit ${exitCode}).`,
        'SCAFFOLD_INSTALL_FAILED',
        { cwd: root, exitCode },
      )
    }
  }

  console.log(`[bread] Scaffolded ${root}`)
  console.log(`[bread] bread provider add ${provider}`)
  console.log('[bread] bread dev')
  if (opts.store === 'postgres') console.log('[bread] Set DATABASE_URL')
}
