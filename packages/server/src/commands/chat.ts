import * as readline from 'node:readline/promises'
import { BreadError, createBread } from '@bread/core'
import { v7 as uuidv7 } from 'uuid'
import type { BreadCrumb } from '@bread/core'
import { loadAgents, loadConfig, loadTasks } from '../loader.js'
import { dim, parseHumanResponse } from './render.js'

export interface ChatOptions {
  cwd: string
  agentId?: string
  skill?: string
  session?: string
}

// Interactive REPL against one agent. A single session id is reused for every
// turn so the agent keeps its memory across the conversation. When the agent
// calls a human tool the run stream ends at a checkpoint; we prompt the user and
// `resume`, which returns the continuation stream — consumed the same way (and
// recursively, since the continuation may suspend again).
export async function runChat(opts: ChatOptions): Promise<void> {
  const config = await loadConfig(opts.cwd)
  const agents = await loadAgents(opts.cwd, config.entrypoints)
  const tasks = await loadTasks(opts.cwd)

  const ids = [...agents.keys()]
  const agentId = opts.agentId ?? (ids.length === 1 ? ids[0] : undefined)
  if (agentId === undefined || !agents.has(agentId)) {
    throw new Error(
      opts.agentId
        ? `Agent "${opts.agentId}" not found. Available: ${ids.join(', ') || '(none)'}`
        : `Multiple agents loaded — specify one: ${ids.join(', ')}`,
    )
  }

  // `config.transport` is the single source of truth — strict everywhere, no
  // interactive or hardcoded fallback. A sink is enough here (chat doesn't
  // need mount/subscribe), but the user must pick one explicitly.
  if (!config.transport) {
    throw new BreadError(
      'No transport configured. Set `transport` in bread.config.ts — e.g. ' +
        "`transport: transport()` from `@bread/transport-stdout` to render the conversation.",
      'TRANSPORT_NOT_CONFIGURED',
    )
  }

  const bread = createBread(config, agents, tasks)
  await bread.start()

  const sessionId = opts.session ?? uuidv7()
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

  let stopped = false
  const shutdown = async (): Promise<void> => {
    if (stopped) return
    stopped = true
    rl.close()
    await bread.stop()
  }
  process.on('SIGINT', () => void shutdown().then(() => process.exit(0)))

  console.log(
    dim(`session ${sessionId} — talking to "${agentId}". Type /exit or press Ctrl-D to quit.`),
  )

  // text:delta/tool:call/error rendering is handled automatically by
  // config.transport via the crumb choke point (see @bread/transport-stdout).
  // This loop only handles what a sink can't: blocking for human input. On
  // human:required, prompt and recurse into the continuation stream returned
  // by resume (which may itself suspend again).
  const consume = async (stream: AsyncIterable<BreadCrumb>): Promise<void> => {
    for await (const crumb of stream) {
      if (crumb.type === 'human:required') {
        const schema =
          typeof crumb.schema === 'string' ? crumb.schema : JSON.stringify(crumb.schema)
        const answer = await rl.question(
          `\n${dim(`↳ ${crumb.toolName} needs input ${schema}`)}\n${crumb.prompt ? `${crumb.prompt} ` : ''}▸ `,
        )
        await consume(bread.resume(crumb.checkpointId, parseHumanResponse(answer)))
      }
    }
  }

  try {
    while (true) {
      let line: string
      try {
        line = await rl.question('\nyou ▸ ')
      } catch {
        break // Ctrl-D / closed input
      }
      const text = line.trim()
      if (text === '/exit' || text === '/quit') break
      if (!text) continue

      const stream = bread.run(agentId, text, {
        mode: 'stream',
        session: { id: sessionId },
        ...(opts.skill ? { skill: opts.skill } : {}),
      }) as AsyncIterable<BreadCrumb>

      await consume(stream)
      process.stdout.write('\n')
    }
  } finally {
    await shutdown()
  }
}
