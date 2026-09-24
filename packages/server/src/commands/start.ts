import { loadAgents, loadConfig, loadTasks } from '../loader.js'
import { startServer } from '../server.js'

export interface StartOptions {
  cwd: string
  // bread-runtime-node injects startServerNode; the Bun CLI omits this and uses startServer.
  listen?: typeof startServer
  // Omitted flags fall through to config.server.{port,host,idleTimeout} in startServer.
  port?: number | undefined
  host?: string | undefined
  idleTimeout?: number | undefined
}

export async function runStart(opts: StartOptions): Promise<void> {
  const listen = opts.listen ?? startServer
  const config = await loadConfig(opts.cwd)
  const agents = await loadAgents(opts.cwd, config.entrypoints)
  const tasks = await loadTasks(opts.cwd)
  const { stop } = await listen(
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
