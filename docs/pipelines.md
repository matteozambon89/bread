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
| `decision` | Ask one System One question. The step-end output is `{ label, answer }`. The next step still receives the pre-decision value. See [decisions.md](./decisions.md). |
| `image` | Read the current value as a string or `{ text?, images, mask? }` and call `generateImage` once (`n: 1`, `maxRetries: 0`). Store the bytes with `config.blobStore`, emit `file:generated`, and pass the `FileOutput` on. See [Image](#image). |
| `branch` | Run exactly one arm. `cases` match `eq` with strict string equality, first hit. See [Branch](#branch). |

```bash
curl -N -X POST localhost:3000/pipelines/article/run -d '{"input":{"topic":"bread"}}'
```

Step crumbs carry the runId `<pipelineRunId>:<pipelineId>:<stepIndex>`. `pipelineRunId` is a
UUIDv7 minted for each pipeline run, so step ids are unique per run and can't be guessed. Nested
`parallel` and `branch` steps extend the `pipelineId` part (for example `…:article:1:parallel:0:0`),
and resuming a paused pipeline reuses the original `pipelineRunId`. Releases before this one used
`<pipelineId>:<stepIndex>`. See [HTTP API](./http-api.md#post-pipelinesidrun).

### Image

```ts
{
  type: 'image',
  provider: 'openai',
  model: 'gpt-image-1',
}
```

The current value is a string, or `{ text?, images, mask? }` — the AI SDK `GenerateImagePrompt`. A string is the text prompt. The object passes `images` through (optional `text` and `mask` too), so a model that enhances a source image can receive one. Topaz ignores text and fails unless `images` is set. Anything else throws `IMAGE_PROMPT` before a model call. The step calls the image registry (`config.image`, not `config.providers`) once, stores `image.uint8Array` with `config.blobStore`, and yields `file:generated` (`agentId: 'image'`, same `runId` as the step). The step-end `output` is the `FileOutput` (`{ kind: 'file', uri, mimeType }`), and that object is the next step's input. Unlike `decision`, this step replaces the value.

No `blobStore` throws `BLOB_STORE_NOT_CONFIGURED`. No `image` registry throws `IMAGE_NOT_CONFIGURED`. An unknown `provider` throws `UNKNOWN_IMAGE_PROVIDER`. A rejected `generateImage` (bad key, content policy, empty image) is rethrown as `BreadError` `AGENT_ERROR` with the provider message, `pipelineId`, and `stepIndex`. The catalog is [`@breadai/provider-image`](https://github.com/matteozambon89/bread/tree/HEAD/providers/image) — see [providers.md](./providers.md#image-models). The crumb's session is the pipeline invocation, so the log keeps the URI and `deleteSession` cascades the row. Bytes still live in the blob store — see [store.md](./store.md#blob-storage).

[`examples/pipeline`](https://github.com/matteozambon89/bread/tree/HEAD/examples/pipeline) pipeline `cover` runs the writer, then this step, so the writer's paragraph is the prompt.

### Branch

```ts
{
  type: 'branch',
  on: 'status', // omit to use the latest decision label in this run
  cases: [
    { eq: 'needs_review', steps: [{ type: 'agent', agentId: 'investigator' }] },
    { eq: 'auto_refund', steps: [{ type: 'agent', agentId: 'policy-check' }] },
    { eq: 'deny', steps: [{ type: 'agent', agentId: 'policy-check' }] },
  ],
  default: [{ type: 'agent', agentId: 'investigator' }],
}
```

`on` reads that dot path from the current value. With `on` omitted, the label is the latest
decision step in this run (the decision step does not replace the value the arm receives).
Parallel slots join into that same label when each slot finishes or resumes. A slot that does
not decide leaves it, and one new label replaces it. Two different new labels throw
`PIPELINE_DECISION_CONFLICT` before any later step; the previous label is not reused and the
branch does not run as if no decision happened. No `on`
and no decision label throws `PIPELINE_BRANCH_NO_LABEL` before any arm. `default` is required; a
missing default throws `PIPELINE_BRANCH_DEFAULT` before any arm, including when a case would have
matched. A missing path or a non-string value is no match, so `default` runs. An empty arm passes
the current value through and calls no agent. The arm's output — or the current value, when the
arm is empty — is the branch step's output.

`pipeline:branch:taken` is yielded once, after the branch step starts and before the arm, with
`agentId: 'branch'`, the matched `eq` (`null` for the default arm), and `caseIndex` (`-1` for
default). Untaken arms emit no
crumbs. `pipeline:step:start` and `pipeline:step:end` still fire for the branch step
(`agentId: 'branch'`) and for steps inside the taken arm. The crumb log skips
`pipeline:branch:taken` the same way it skips `pipeline:step:*`: those crumbs have no session.

A human pause inside the arm stores the rest of that arm, then the steps after the
branch, as checkpoint frames. Resume finishes the arm and then those steps. It does
not evaluate the predicate again.

### HITL inside a pipeline

A step's agent suspending for a human tool **stops the pipeline durably**: the stream ends at
`human:required` (for a `parallel` step, after every sibling branch settles), and the checkpoint
records the pipeline continuation — remaining steps included, self-contained. Resuming the
suspended agent runs the rest of the pipeline in the same continuation stream, across restarts and
processes. A pause inside a `branch` arm resumes that stored arm, not a newly matched one. See
[hitl.md](./hitl.md#hitl-inside-a-composition).

## Supervisors

A supervisor is a normal agent whose model can **delegate**: configuring `supervisor` injects the
`core_delegate` tool and a system-prompt section describing the roster. The model decides at
runtime whether, when, and with what input to hand work to each sub-agent, reads every output back
as the tool result, and composes its own final answer. Steer the strategy through the agent's
`prompt.md` (see [`examples/researcher-writer`](https://github.com/matteozambon89/bread/tree/HEAD/examples/researcher-writer)).

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
