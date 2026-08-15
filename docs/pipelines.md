# Pipelines & supervisors

Two ways to compose multiple agents, with deliberately distinct roles:

| | Pipeline | Supervisor |
|---|---|---|
| What | Fixed data-flow: output → next input | Runtime routing: an agent delegating to sub-agents |
| Declared | `pipelines:` in `bread.config.ts` — not an agent | `supervisor:` on an agent's config |
| Composition intelligence | None — the shape is fixed ahead of time | The supervisor's own model decides whether/when/what/how-parallel, per run |

(A third composition, [loops](./loops.md), re-runs a pipeline until an agent judge is satisfied.)

## Pipelines

Define pipelines in config; run them at `POST /pipelines/:id/run`. A pipeline is an ordered list of
steps; each step's output feeds the next.

```ts
// bread.config.ts
export default defineConfig({
  entrypoints: ['researcher', 'fact-checker', 'writer'],
  pipelines: {
    article: [
      { type: 'agent', agentId: 'researcher' },
      { type: 'parallel', steps: [
        { type: 'agent', agentId: 'fact-checker' },
        { type: 'agent', agentId: 'researcher', skill: 'deep-research' },
      ] },
      { type: 'map', agentId: 'writer' },
    ],
  },
})
```

Step types:

| Type | Behaviour |
|------|-----------|
| `agent` | Run one agent. Optional `skill` activates a caller-driven skill. |
| `parallel` | Run nested steps concurrently, merge crumb streams. The step's output is the **ordered array of branch outputs**. |
| `map` | Fan the input array out across `agentId` — each element runs through the agent; output is the array of per-element outputs. |

```bash
curl -N -X POST localhost:3000/pipelines/article/run -d '{"input":{"topic":"bread"}}'
```

### HITL inside a pipeline

A step's agent suspending for a human tool **stops the pipeline durably**: the stream ends at
`human:required` (for a `parallel` step, after every sibling branch settles), and the checkpoint
records the pipeline continuation — remaining steps included, self-contained. Resuming the
suspended agent runs the rest of the pipeline in the same continuation stream, across restarts and
processes. See [hitl.md](./hitl.md#hitl-inside-a-composition).

## Supervisors

A supervisor is a normal agent whose model can **delegate**: configuring `supervisor` injects the
`core_delegate` tool and a system-prompt section describing the roster. The model decides at
runtime whether, when, and with what input to hand work to each sub-agent, reads every output back
as the tool result, and composes its own final answer. Steer the strategy through the agent's
`prompt.md` (see [`examples/researcher-writer`](../examples/researcher-writer)).

```ts
defineAgent({
  model: { provider: 'anthropic', model: 'claude-opus-4-8' },
  inputSchema: z.string(),
  outputSchema: z.string(),
  output: { format: 'text' },
  supervisor: {
    max: 2,                          // at most 2 delegations in flight at once
    agents: [
      { agentId: 'researcher', visibility: 'passthrough' },
      { agentId: 'fact-checker', visibility: 'mediate' },
    ],
  },
})
```

- **Parallel** delegation = several `core_delegate` calls in one model turn (executed
  concurrently); **series** = delegate, read the result, delegate again.
- `max` caps concurrency at two levels: top-level (all delegations) and per sub-agent. A call over
  a cap fails with a `DELEGATION_LIMIT` tool error the model can react to; delegating outside the
  roster fails with `DELEGATE_AGENT_NOT_CONFIGURED`.
- Being a normal run, the supervisor has its own output format, hooks, and HITL. A **delegated**
  run that suspends for HITL chain-suspends the supervisor durably — see
  [hitl.md](./hitl.md#hitl-inside-a-composition).

`visibility` controls how much of a delegated run's stream surfaces to the client: `passthrough`
(all crumbs, the default), `mediate` (only `subagent:run:start` / `subagent:run:end` framing),
`hidden` (none). Visibility never blinds the supervisor itself — the output always returns as the
tool result — and `human:required` always surfaces, whatever the visibility.
