import { BreadError, createBread } from '@breadai/core'
import type { BreadCrumb } from '@breadai/core'
import { loadAgents, loadConfig, loadTasks } from '../loader.js'
import { formatToolCall } from './render.js'

export interface InvokeOptions {
  cwd: string
  agentId: string
  input: unknown
  skill?: string
  json?: boolean
  session?: string
  trace?: boolean
}

// Run an agent once, non-interactively. There is no HITL here: if the agent
// calls a human tool the run can never complete unattended, so we abort with a
// clear message and a non-zero exit instead of hanging on the checkpoint.
export async function runInvoke(opts: InvokeOptions): Promise<void> {
  const config = await loadConfig(opts.cwd)
  const agents = await loadAgents(opts.cwd, config.entrypoints)
  const tasks = await loadTasks(opts.cwd)

  if (!agents.has(opts.agentId)) {
    throw new Error(
      `Agent "${opts.agentId}" not found. Available: ${[...agents.keys()].join(', ') || '(none)'}`,
    )
  }

  // `config.transport` is the single source of truth — strict everywhere, no
  // interactive or hardcoded fallback. invoke's own --trace/--json printing
  // stays as-is below; a sink is enough (mount/subscribe aren't needed here).
  if (!config.transport) {
    throw new BreadError(
      'No transport configured. Set `transport` in bread.config.ts — e.g. ' +
        '`transport: transport()` from `@breadai/transport-stdout`.',
      'TRANSPORT_NOT_CONFIGURED',
    )
  }

  const bread = createBread(config, agents, tasks)
  await bread.start()

  let output: unknown
  let failed = false
  try {
    const stream = bread.run(opts.agentId, opts.input, {
      mode: 'stream',
      ...(opts.skill ? { skill: opts.skill } : {}),
      ...(opts.session ? { session: { id: opts.session } } : {}),
    }) as AsyncIterable<BreadCrumb>

    for await (const crumb of stream) {
      if (crumb.type === 'human:required') {
        process.stderr.write(
          `\n[bread] Agent "${opts.agentId}" requires human input via tool "${crumb.toolName}". ` +
            '`invoke` is non-interactive — use `bread chat` instead.\n',
        )
        failed = true
        break
      }
      if (crumb.type === 'tool:call' && opts.trace) process.stderr.write(`${formatToolCall(crumb)}\n`)
      if (crumb.type === 'text:delta' && !opts.json) process.stdout.write(crumb.delta)
      if (crumb.type === 'agent:run:end') output = crumb.output
    }
  } finally {
    await bread.stop()
  }

  if (failed) process.exit(1)

  if (opts.json) process.stdout.write(`${JSON.stringify(output)}\n`)
  else process.stdout.write('\n')
}
