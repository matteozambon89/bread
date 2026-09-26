import { loadAgents, loadConfig, loadTasks } from '../loader.js'
import type { ListenFn } from './listen.js'

export interface StartOptions {
  cwd: string
  /** Injected by the CLI — e.g. `startServer` from `@breadai/runtime-bun`. */
  listen: ListenFn
  // Omitted flags fall through to config.server.{port,host,idleTimeout} in listen.
  port?: number | undefined
  host?: string | undefined
  idleTimeout?: number | undefined
}

export async function runStart(opts: StartOptions): Promise<void> {
  const config = await loadConfig(opts.cwd)
  const agents = await loadAgents(opts.cwd, config.entrypoints)
  const tasks = await loadTasks(opts.cwd)
  const { stop } = await opts.listen(
    config,
    agents,
    {
      ...(opts.port !== undefined ? { port: opts.port } : {}),
      ...(opts.host !== undefined ? { host: opts.host } : {}),
      ...(opts.idleTimeout !== undefined ? { idleTimeout: opts.idleTimeout } : {}),
    },
    tasks,
  )

  console.log(`[bread] ${agents.size} agent(s) loaded: ${[...agents.keys()].join(', ')}`)

  process.on('SIGINT', async () => {
    await stop()
    process.exit(0)
  })

  await new Promise<never>(() => {})
}
