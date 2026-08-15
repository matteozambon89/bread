import { runEvals } from '@breadai/core'
import { loadAgents, loadConfig, loadEvals, loadTasks } from '../loader.js'
import { createBread } from '@breadai/core'

export interface EvalCommandOptions {
  cwd: string
  path?: string
}

export async function runEvalCommand(opts: EvalCommandOptions): Promise<void> {
  const config = await loadConfig(opts.cwd)
  const agents = await loadAgents(opts.cwd, config.entrypoints)
  const evalDefs = await loadEvals(opts.cwd, opts.path)

  if (evalDefs.length === 0) {
    console.log('[bread] No eval files found')
    return
  }

  const tasks = await loadTasks(opts.cwd)
  const bread = createBread(config, agents, tasks)
  await bread.start()

  let totalPassed = 0
  let totalFailed = 0

  for (const evalDef of evalDefs) {
    console.log(`\n[bread eval] Running: ${evalDef.config.agentId} (${evalDef.config.type ?? 'functional'})`)

    const suite = await runEvals(
      evalDef,
      async (agentId, input, skill) => {
        const { output } = await bread.run(agentId, input, { mode: 'sync', ...(skill ? { skill } : {}) })
        return output
      },
      config.providers,
    )

    for (const result of suite.results) {
      const icon = result.passed ? '✓' : '✗'
      const detail = result.details ? ` — ${result.details}` : ''
      console.log(`  ${icon} ${result.name} (score: ${result.score.toFixed(2)})${detail}`)
    }

    console.log(`  ${suite.passed}/${suite.total} passed`)
    totalPassed += suite.passed
    totalFailed += suite.failed
  }

  await bread.stop()

  console.log(`\n[bread eval] Total: ${totalPassed} passed, ${totalFailed} failed`)

  if (totalFailed > 0) process.exit(1)
}
