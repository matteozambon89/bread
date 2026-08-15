import { loadAgents, loadConfig } from '../loader.js'

export interface BuildOptions {
  cwd: string
}

export async function runBuild(opts: BuildOptions): Promise<void> {
  console.log('[bread] Building...')

  const config = await loadConfig(opts.cwd)
  const agents = await loadAgents(opts.cwd, config.entrypoints)

  let errors = 0
  for (const [id, def] of agents) {
    if (!def.config.inputSchema) {
      console.error(`[bread] Agent "${id}" missing inputSchema`)
      errors++
    }
    if (!def.config.outputSchema) {
      console.error(`[bread] Agent "${id}" missing outputSchema`)
      errors++
    }
    if (!def.config.model?.provider || !def.config.model?.model) {
      console.error(`[bread] Agent "${id}" has incomplete model config`)
      errors++
    }
    console.log(`[bread] ✓ ${id} (${def.config.model.provider}/${def.config.model.model})`)
  }

  if (errors > 0) {
    console.error(`[bread] Build failed with ${errors} error(s)`)
    process.exit(1)
  }

  console.log(`[bread] Build succeeded — ${agents.size} agent(s)`)
}
