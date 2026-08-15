import { watch } from 'chokidar'
import { loadAgents, loadConfig, loadTasks } from '../loader.js'
import { startServer } from '../server.js'
import type { AgentRegistry } from '@breadai/core'

export interface DevOptions {
  cwd: string
  // Omitted flags fall through to config.server.{port,host,idleTimeout} in startServer.
  port?: number | undefined
  host?: string | undefined
  idleTimeout?: number | undefined
}

export async function runDev(opts: DevOptions): Promise<void> {
  let stop: (() => Promise<void>) | null = null
  let agents: AgentRegistry = new Map()

  async function boot() {
    if (stop) {
      console.log('[bread] Reloading...')
      await stop()
    }

    // Bust module cache for hot reload (Bun re-imports the same path)
    const config = await loadConfig(opts.cwd)
    agents = await loadAgents(opts.cwd, config.entrypoints)
    const tasks = await loadTasks(opts.cwd)

    const server = await startServer(
      config,
      agents,
      {
        ...(opts.port !== undefined ? { port: opts.port } : {}),
        ...(opts.host !== undefined ? { host: opts.host } : {}),
        ...(opts.idleTimeout !== undefined ? { idleTimeout: opts.idleTimeout } : {}),
      },
      tasks,
    )
    stop = server.stop
    console.log(`[bread] ${agents.size} agent(s) loaded: ${[...agents.keys()].join(', ')}`)
  }

  await boot()

  // Watch for file changes
  const watcher = watch(
    [`${opts.cwd}/agents/**/*.ts`, `${opts.cwd}/tasks/**/*.ts`, `${opts.cwd}/bread.config.ts`],
    {
      ignoreInitial: true,
      persistent: true,
    },
  )

  let debounce: ReturnType<typeof setTimeout> | null = null

  watcher.on('all', (_event, path) => {
    console.log(`[bread] Changed: ${path}`)
    if (debounce) clearTimeout(debounce)
    debounce = setTimeout(async () => {
      try {
        await boot()
      } catch (err) {
        console.error('[bread] Reload failed:', err)
      }
    }, 200)
  })

  // Graceful shutdown
  process.on('SIGINT', async () => {
    await watcher.close()
    await stop?.()
    process.exit(0)
  })

  // Keep alive
  await new Promise<never>(() => {})
}
