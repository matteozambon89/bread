import { z } from 'zod'
import type { BreadCrumb, SubAgentVisibility, SupervisorConfig, ToolDefinition } from './types.js'
import { BreadError } from './types.js'
import { runAgent } from './runner.js'
import type { RunnerContext } from './runner.js'

// LLM-driven supervision. A supervisor is a normal agent whose config injects
// the core_delegate tool: the model decides at runtime whether, when, with what
// input, and how many times in parallel to hand work to its configured roster
// of sub-agents, reading each output back as the tool result and composing its
// own final answer. Static composition is a pipeline's job — see pipeline.ts.

export interface BuildSupervisorToolsArgs {
  supervisorCfg: SupervisorConfig
  agentId: string
  ctx: RunnerContext
  // Sink that surfaces a sub-agent crumb in the host run's stream (the
  // runner's crumbBuffer).
  onCrumb: (crumb: BreadCrumb) => void
}

export interface SupervisorRuntime {
  tools: ToolDefinition[]
  // Drains the human:required crumbs of delegations that suspended this turn.
  // Held back (not forwarded live) so the runner can persist the supervisor's
  // chain-suspension checkpoint and the child linkage BEFORE a client can see
  // the suspension and resume it. Also drained at retry-attempt start to drop
  // stale holds.
  takeHeldCrumbs(): BreadCrumb[]
}

const delegateSchema = z.object({
  agentId: z.string().describe('Id of the configured sub-agent to delegate to'),
  input: z.unknown().describe('The input to run the sub-agent with'),
})

type DelegateArgs = z.infer<typeof delegateSchema>

// One-line system-prompt hint, injected when the agent has a supervisor roster.
export function supervisorSummary(cfg: SupervisorConfig): string {
  const roster = cfg.agents
    .map((sa) => (sa.max !== undefined ? `${sa.agentId} (max ${sa.max} concurrent)` : sa.agentId))
    .join(', ')
  const lines = [
    '## Delegation',
    `You can delegate work to these sub-agents: ${roster}.`,
    'Call `core_delegate` with `agentId` and `input`; the sub-agent runs and its output is returned ' +
      'to you as the tool result. Delegate in parallel by making several `core_delegate` calls in ' +
      'one turn, or in series by delegating, reading the result, then delegating again.',
  ]
  if (cfg.max !== undefined) {
    lines.push(`At most ${cfg.max} delegations run concurrently overall.`)
  }
  return lines.join('\n')
}

export function buildSupervisorTools(args: BuildSupervisorToolsArgs): SupervisorRuntime {
  const { supervisorCfg, agentId, ctx, onCrumb } = args

  // Concurrency bookkeeping across parallel tool calls within one model turn
  // (the AI SDK executes them concurrently).
  let activeTotal = 0
  const activePerAgent = new Map<string, number>()
  let heldCrumbs: BreadCrumb[] = []

  const delegate: ToolDefinition<DelegateArgs, unknown> = {
    name: 'core_delegate',
    description:
      'Delegate a piece of work to one of your configured sub-agents. The sub-agent runs with ' +
      '`input` and its output is returned as this tool result.',
    schema: delegateSchema,
    execute: async ({ agentId: subAgentId, input }): Promise<unknown> => {
      const sa = supervisorCfg.agents.find((s) => s.agentId === subAgentId)
      if (!sa) {
        throw new BreadError(
          `"${subAgentId}" is not in this supervisor's sub-agent roster. ` +
            `Configured sub-agents: ${supervisorCfg.agents.map((s) => s.agentId).join(', ')}.`,
          'DELEGATE_AGENT_NOT_CONFIGURED',
          { agentId, subAgentId, roster: supervisorCfg.agents.map((s) => s.agentId) },
        )
      }
      if (!ctx.agents.has(subAgentId)) {
        throw new BreadError(`Sub-agent not registered: "${subAgentId}".`, 'AGENT_NOT_FOUND', {
          agentId,
          subAgentId,
        })
      }
      if (supervisorCfg.max !== undefined && activeTotal >= supervisorCfg.max) {
        throw new BreadError(
          `Delegation limit reached: at most ${supervisorCfg.max} delegations may run concurrently. ` +
            'Wait for an active delegation to finish (its tool result to arrive) before delegating again.',
          'DELEGATION_LIMIT',
          { agentId, subAgentId, max: supervisorCfg.max, active: activeTotal },
        )
      }
      const activeForAgent = activePerAgent.get(subAgentId) ?? 0
      if (sa.max !== undefined && activeForAgent >= sa.max) {
        throw new BreadError(
          `Delegation limit reached for "${subAgentId}": at most ${sa.max} concurrent ` +
            'delegation(s) to this sub-agent. Wait for its active run(s) to finish first.',
          'DELEGATION_LIMIT',
          { agentId, subAgentId, max: sa.max, active: activeForAgent },
        )
      }

      activeTotal++
      activePerAgent.set(subAgentId, activeForAgent + 1)
      try {
        let output: unknown
        let suspendedCheckpointId: string | undefined
        // Output and suspension are read off the RAW stream — visibility only
        // governs what surfaces to the client, never what the supervisor sees.
        for await (const crumb of runAgent(subAgentId, input, {}, ctx)) {
          if (crumb.type === 'agent:run:end') output = crumb.output
          if (crumb.type === 'human:required') {
            // Held for the runner's chain-suspension path — see takeHeldCrumbs.
            suspendedCheckpointId = crumb.checkpointId
            heldCrumbs.push(crumb)
            continue
          }
          const filtered = filterSubAgentCrumb(crumb, subAgentId, agentId, sa.visibility ?? 'passthrough')
          if (filtered) onCrumb(filtered)
        }
        if (suspendedCheckpointId !== undefined) {
          // The sub-run suspended for HITL — its stream ended with no output.
          // This throw is the chain-suspension signal, not a failure: the
          // runner turns it into a suspended supervisor checkpoint (and the
          // onError/retry machinery is told to let it pass through untouched).
          throw new BreadError(
            `Delegated run of "${subAgentId}" suspended for human input (checkpoint ` +
              `${suspendedCheckpointId}); the supervisor run suspends with it.`,
            'DELEGATION_SUSPENDED',
            { agentId, subAgentId, checkpointId: suspendedCheckpointId },
          )
        }
        return output
      } finally {
        activeTotal--
        const n = activePerAgent.get(subAgentId) ?? 1
        activePerAgent.set(subAgentId, n - 1)
      }
    },
  }

  return {
    tools: [delegate as ToolDefinition],
    takeHeldCrumbs() {
      const held = heldCrumbs
      heldCrumbs = []
      return held
    },
  }
}

// What (if anything) of one sub-agent crumb surfaces to the client under the
// given visibility. Pure per-crumb so the delegate loop can read the raw
// stream for outputs while filtering only what it forwards.
export function filterSubAgentCrumb(
  crumb: BreadCrumb,
  subAgentId: string,
  parentAgentId: string,
  visibility: SubAgentVisibility,
): BreadCrumb | null {
  // HITL crumbs always surface, whatever the visibility — swallowing a
  // human:required means the run suspends with nobody able to see or answer
  // it. (human:resumed is its paired closure on the resume stream.)
  if (crumb.type === 'human:required' || crumb.type === 'human:resumed') return crumb
  if (visibility === 'hidden') return null
  if (visibility === 'passthrough') return crumb
  // mediate: only surface start/end crumbs for the sub-agent
  if (crumb.type === 'agent:run:start' && 'agentId' in crumb && crumb.agentId === subAgentId) {
    return { ...crumb, type: 'subagent:run:start', parentAgentId, subagentId: subAgentId } as BreadCrumb
  }
  if (crumb.type === 'agent:run:end' && 'agentId' in crumb && crumb.agentId === subAgentId) {
    return {
      ...crumb,
      type: 'subagent:run:end',
      parentAgentId,
      subagentId: subAgentId,
      output: (crumb as { output?: unknown }).output,
    } as BreadCrumb
  }
  return null
}
