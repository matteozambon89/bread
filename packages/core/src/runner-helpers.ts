import type { RunnerContext } from './runner-types.js'
import type {
  AgentConfig,
  AgentErrorCrumb,
  BreadHooks,
  HumanRequiredCrumb,
} from './types.js'
import { BreadError } from './types.js'

export function nowMs(): number {
  return Date.now()
}

export function crumbBase(
  agentId: string,
  runId: string,
  sessionId: string,
): { agentId: string; runId: string; sessionId: string; timestamp: number } {
  return { agentId, runId, sessionId, timestamp: nowMs() }
}

export function toBreadError(err: unknown, agentId: string): BreadError {
  if (err instanceof BreadError) return err
  return new BreadError(
    err instanceof Error ? err.message : String(err),
    'AGENT_ERROR',
    { agentId },
    err,
  )
}

export function makeErrorCrumb(
  agentId: string,
  runId: string,
  sessionId: string,
  err: unknown,
): AgentErrorCrumb {
  return {
    type: 'agent:error',
    agentId,
    runId,
    sessionId,
    error: toBreadError(err, agentId),
    timestamp: nowMs(),
  }
}

export function cancelledOutcome(
  agentId: string,
  runId: string,
  sessionId: string,
): { crumb: AgentErrorCrumb; error: BreadError } {
  const error = new BreadError('run cancelled', 'RUN_CANCELLED', { agentId, runId })
  return { crumb: makeErrorCrumb(agentId, runId, sessionId, error), error }
}

export function makeHumanRequiredCrumb(
  agentId: string,
  runId: string,
  sessionId: string,
  checkpointId: string,
  toolName: string,
  schema: unknown,
  kind: 'input' | 'approval',
): HumanRequiredCrumb {
  return {
    type: 'human:required',
    ...crumbBase(agentId, runId, sessionId),
    checkpointId,
    toolName,
    schema,
    kind,
  }
}

// Builds the ordered [scoped, ...plugins, global] hook array for one BreadHooks
// key. The scoped (Agent) hook is declared against RunContext, a subset of
// GlobalHookContext's 'agent' member — safe to widen since this array is only
// ever invoked with `{ scope: 'agent', ... }` contexts.
export function agentHookChain<K extends keyof BreadHooks>(
  cfg: AgentConfig<unknown, unknown>,
  ctx: RunnerContext,
  key: K,
): Array<BreadHooks[K] | undefined> {
  return [
    cfg.hooks?.[key] as unknown as BreadHooks[K] | undefined,
    ...(ctx.pluginHooks ?? []).map((h) => h[key]),
    ctx.hooks?.[key],
  ]
}
