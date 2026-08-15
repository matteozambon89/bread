import { createBread } from '@breadai/core'
import type {
  AgentDefinition,
  BreadConfig,
  BreadCrumb,
  BreadInstance,
  BreadPlugin,
  TaskDefinition,
  TaskRegistry,
} from '@breadai/core'
import { createServer } from '@breadai/server'
import { store } from '@breadai/store-memory'
import { transport } from '@breadai/transport-http-sse'
import type { LanguageModel } from 'ai'
import { mockProvider } from './mock-plugin.js'

export interface HarnessOpts {
  /** Agent id → definition. */
  agents: Record<string, AgentDefinition<unknown, unknown>>
  /** One-shot task definitions; registered under each task's `config.name`. */
  tasks?: Record<string, TaskDefinition<unknown, unknown>>
  /** Shorthand for the common single-model case — registered under id 'default'. */
  model?: LanguageModel
  /** Mock model id → fake model, for multi-model tests. Use `model` for one. */
  models?: Record<string, LanguageModel>
  /** Extra plugins (auth strategies, protocol plugins, …). */
  plugins?: BreadPlugin[]
  /** Extra BreadConfig fields (pipelines, concurrency, …). */
  config?: Partial<BreadConfig>
}

function buildConfig(opts: HarnessOpts): {
  config: BreadConfig
  agents: Map<string, AgentDefinition<unknown, unknown>>
  tasks: TaskRegistry
} {
  const models = opts.models ?? (opts.model ? { default: opts.model } : {})
  if (Object.keys(models).length === 0) {
    throw new Error('makeBread/makeServer: pass either `model` or `models`')
  }
  const agents = new Map(Object.entries(opts.agents))
  const tasks: TaskRegistry = new Map(
    Object.values(opts.tasks ?? {}).map((def) => [def.config.name, def]),
  )
  const config: BreadConfig = {
    entrypoints: Object.keys(opts.agents),
    store: store(),
    // @breadai/transport-http-sse is a wire-compatible relocation of the SSE
    // format server.ts used to hand-roll — the default here so every test
    // using this harness keeps working against readSse/parseSse unchanged.
    transport: transport(),
    providers: mockProvider(models),
    plugins: opts.plugins ?? [],
    ...opts.config,
  }
  return { config, agents, tasks }
}

/**
 * Runs an agent in stream mode and returns the typed crumb stream — avoids the
 * `as AsyncIterable<BreadCrumb>` cast forced by `bread.run`'s overloads.
 */
export function stream(
  bread: BreadInstance,
  agentId: string,
  input: unknown,
  opts?: Parameters<BreadInstance['run']>[2],
): AsyncIterable<BreadCrumb> {
  return bread.run(agentId, input, { ...opts, mode: 'stream' })
}

/** Drains a crumb generator to an array — the common assertion shape. */
export async function collect(gen: AsyncIterable<BreadCrumb>): Promise<BreadCrumb[]> {
  const out: BreadCrumb[] = []
  for await (const c of gen) out.push(c)
  return out
}

/**
 * Parses an `app.request` SSE response into its decoded events. The server
 * frames each event as `[id: <seq>\n]data: {json}\n\n` where json is
 * `{ type, payload }`; `retry:` fields and `: ping` comments are skipped.
 */
export async function readSse(
  res: Response,
): Promise<Array<{ type: string; payload: unknown; id?: number }>> {
  return parseSse(await res.text())
}

/** `readSse` over raw SSE text — for incrementally-read bodies. */
export function parseSse(body: string): Array<{ type: string; payload: unknown; id?: number }> {
  const events: Array<{ type: string; payload: unknown; id?: number }> = []
  for (const block of body.split('\n\n')) {
    let id: number | undefined
    let data = ''
    for (const line of block.split('\n')) {
      if (line.startsWith('id: ')) id = Number(line.slice(4))
      else if (line.startsWith('data: ')) data += line.slice(6)
    }
    if (!data) continue
    const parsed = JSON.parse(data) as { type: string; payload: unknown }
    events.push(id !== undefined ? { ...parsed, id } : parsed)
  }
  return events
}

/** `stream` + `collect`: run an agent and get all its crumbs. */
export function runCollect(
  bread: BreadInstance,
  agentId: string,
  input: unknown,
  opts?: Parameters<BreadInstance['run']>[2],
): Promise<BreadCrumb[]> {
  return collect(stream(bread, agentId, input, opts))
}

/**
 * Boots a started `BreadInstance` over an in-memory store with the mock provider.
 * The returned `stop` tears it down. Use for runner-level behavioral tests.
 */
export async function makeBread(opts: HarnessOpts): Promise<{
  bread: BreadInstance
  stop: () => Promise<void>
}> {
  const { config, agents, tasks } = buildConfig(opts)
  const bread = createBread(config, agents, tasks)
  await bread.start()
  return { bread, stop: () => bread.stop() }
}

/**
 * Boots the Hono server (and its underlying BreadInstance) over the same harness.
 * Drive `app.request(...)` in-process — no port is opened.
 */
export async function makeServer(opts: HarnessOpts): Promise<{
  app: ReturnType<typeof createServer>['app']
  bread: BreadInstance
  stop: () => Promise<void>
}> {
  const { config, agents, tasks } = buildConfig(opts)
  const { bread, app } = createServer(config, agents, tasks)
  await bread.start()
  return { app, bread, stop: () => bread.stop() }
}
