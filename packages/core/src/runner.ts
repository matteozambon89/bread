import { v7 as uuidv7 } from 'uuid'
import { RELAYED } from './crumb-log.js'
import { runAfterRunChain, runBeforeRunChain } from './hooks.js'
import { agentHookChain, crumbBase, nowMs } from './runner-helpers.js'
import { continueRun } from './runner-continue.js'
import type { RunnerContext } from './runner-types.js'
import type {
  AgentConfig,
  AgentRunEndCrumb,
  AgentRunStartCrumb,
  BreadCrumb,
  GlobalHookContext,
  RunContext,
  RunOptions,
} from './types.js'
import { BreadError } from './types.js'

// This file is the runner's public entry point + barrel. The implementation is
// split across sibling runner-*.ts files along its natural seams — see each
// file's own header comment:
//   - runner-types.ts: RunnerContext/AgentRegistry/ExecutableEntry/AssembledTools
//   - runner-helpers.ts: crumb/error builders + the agent hook-chain helper
//   - runner-tool-execution.ts: running one tool call (incl. its streaming form)
//   - runner-tool-assembly.ts: collecting + permission-filtering a run's toolset
//   - runner-continue.ts: continueRun — the model-streaming loop itself
//   - runner-resume.ts: resumeRun + composition (pipeline/supervisor) continuation
// Only runAgent lives here: it's the one entry point every caller (bread.ts,
// pipeline.ts, supervisor.ts, loop.ts) reaches through this file specifically.
export type { AgentRegistry, RunnerContext } from './runner-types.js'
export { buildToolCredentials } from './runner-tool-execution.js'
export { resumeRun } from './runner-resume.js'

export async function* runAgent(
  agentId: string,
  rawInput: unknown,
  opts: RunOptions,
  ctx: RunnerContext,
): AsyncGenerator<BreadCrumb> {
  // Remote agents (config.remoteAgents) take precedence over the local registry:
  // relay the remote agent's crumb stream (the instance-level choke point
  // handles local observers/bus). The remote owns its session/store — its
  // runId/sessionId don't exist locally — so crumbs are tagged RELAYED and
  // the crumb-log writer (crumb-log.ts) skips persisting them (hooks don't
  // apply here either, for the same reason).
  const remote = ctx.remoteAgents?.[agentId]
  if (remote) {
    for await (const crumb of remote.run(agentId, rawInput, opts)) {
      yield { ...crumb, [RELAYED]: true } as unknown as BreadCrumb
    }
    return
  }

  const def = ctx.agents.get(agentId)
  if (!def) {
    throw new BreadError(`Agent not found: "${agentId}"`, 'AGENT_NOT_FOUND', { agentId })
  }

  const cfg = def.config as AgentConfig<unknown, unknown>
  const runId = uuidv7()

  // Session
  const existingSession = opts.session?.id ? await ctx.store.getSession(opts.session.id) : undefined
  const session =
    existingSession ??
    (await ctx.store.createSession({
      ...(opts.session?.id ? { id: opts.session.id } : {}),
      ...(opts.session?.tags ? { tags: opts.session.tags } : {}),
    }))
  const sessionId = session.id

  const runCtx: RunContext = {
    agentId,
    runId,
    sessionId,
    ...(opts.skill ? { skill: opts.skill } : {}),
  }

  // beforeRun: agent hook first, then plugin hooks, then BreadConfig.hooks.
  // First short-circuit stops the chain; an override feeds forward as the
  // input seen by the next hook.
  const before = await runBeforeRunChain<unknown, unknown, GlobalHookContext>(
    agentHookChain(cfg, ctx, 'beforeRun'),
    { scope: 'agent', ...runCtx, input: rawInput },
  )
  const input = before.input

  // agent:run:start
  const startCrumb: AgentRunStartCrumb = {
    type: 'agent:run:start',
    ...crumbBase(agentId, runId, sessionId),
    input,
    ...(opts.skill ? { skill: opts.skill } : {}),
  }
  yield startCrumb

  if (before.shortCircuited) {
    const start = nowMs()
    // afterRun runs before the crumb/persist so its (possibly replaced) output
    // is what's actually recorded — nothing downstream re-reads a return value
    // from this generator, the crumb is the only observable result.
    const output = await runAfterRunChain<unknown, unknown, GlobalHookContext>(
      agentHookChain(cfg, ctx, 'afterRun'),
      { scope: 'agent', ...runCtx, input, output: before.output, durationMs: nowMs() - start },
    )
    await ctx.store.addMessage(sessionId, {
      role: 'user',
      content: typeof input === 'string' ? input : JSON.stringify(input),
      timestamp: nowMs(),
    })
    await ctx.store.addMessage(sessionId, {
      role: 'assistant',
      content: JSON.stringify(output),
      timestamp: nowMs(),
    })
    const endCrumb: AgentRunEndCrumb = {
      type: 'agent:run:end',
      ...crumbBase(agentId, runId, sessionId),
      output,
      durationMs: nowMs() - start,
    }
    yield endCrumb
    return
  }

  // Persist the incoming user message, then run. continueRun reads the full
  // session history (including this message) to build the model prompt.
  await ctx.store.addMessage(sessionId, {
    role: 'user',
    content: typeof input === 'string' ? input : JSON.stringify(input),
    timestamp: nowMs(),
  })

  yield* continueRun(agentId, def, runId, sessionId, input, opts, ctx)
}
