# A2UI — `@bread/a2ui`

Bridges bread's crumb stream to Google's [A2UI](https://github.com/google-a2ui/a2ui) declarative UI
spec (`v1.0-candidate`) — a client-agnostic way to render agent activity (progress, streamed text,
tool calls, forms, errors) without a UI having to understand bread's own crumb shapes.

The plugin subscribes to `bread.on('crumb', ...)` and passes every crumb through `crumbToA2UI`
(`extensions/a2ui/src/index.ts`), a pure `switch (crumb.type)` mapper. A matched crumb produces an
`A2UISpec`, handed to your `onSpec` callback alongside the original crumb; an unmatched crumb is
silently dropped (`default: return null`).

## Setup

```ts
// bread.config.ts
import { defineConfig } from '@bread/core'
import { a2ui } from '@bread/a2ui'

export default defineConfig({
  entrypoints: ['assistant'],
  plugins: [
    a2ui({
      onSpec: (spec, crumb) => {
        // ship `spec` to your UI (websocket push, SSE, etc.); `crumb` is the
        // original bread event, in case you need fields the spec dropped.
        ui.send(spec)
      },
    }),
  ],
})
```

`A2UISpec` shape:

```ts
interface A2UISpec {
  type: 'text' | 'markdown' | 'card' | 'form' | 'progress' | 'error' | 'file'
  content?: string
  fields?: Array<{ name: string; type: string; label: string; required?: boolean }>
  progress?: number
  message?: string
  metadata?: Record<string, unknown>
}
```

## Crumb → spec mapping

| Crumb | Spec `type` | `progress` | `message` | `metadata` |
|---|---|---|---|---|
| `agent:run:start` | `progress` | `0` | `Agent <agentId> started` | — |
| `agent:run:end` | `progress` | `1` | `Done` | — |
| `agent:error` | `error` | — | error message | — |
| `text:delta` | `markdown` | — | — (`content` = delta) | — |
| `reasoning:delta` | `text` | — | — (`content` = delta) | — |
| `file:generated` | `file` | — | — | `uri`, `mimeType`, `name` |
| `tool:call` | `card` | — | — | `toolName`, `status: 'calling'` |
| `tool:result` | `card` | — | — | `toolName`, `status: 'done'`, `result`, `durationMs` |
| `tool:error` | `error` | — | error message | `toolName`, `toolCallId`, `durationMs` |
| `human:required` | `form` | — | prompt (or a default) | `checkpointId`, `toolName`; one `response` field |
| `human:resumed` | `progress` | `1` | `Human input received` | `checkpointId`, `kind`, `response` |
| `subagent:run:start` | `progress` | `0` | `Sub-agent <subagentId> started` | `parentAgentId`, `subagentId` |
| `subagent:run:end` | `progress` | `1` | `Sub-agent <subagentId> done` | `parentAgentId`, `subagentId`, `output` |
| `pipeline:step:start` | `progress` | `0` | `Pipeline step <stepIndex> started` | `pipelineId`, `stepIndex` |
| `pipeline:step:end` | `progress` | `1` | `Pipeline step <stepIndex> done` | `pipelineId`, `stepIndex`, `output` |
| `loop:start` | `progress` | `0` | `Loop started: <pipeline>` | `loopId`, `maxIterations` |
| `loop:iteration:start` | `progress` | — | `Iteration <n>` | `loopId`, `iteration` |
| `loop:iteration:end` | `progress` | — | `Iteration <n> done` | `loopId`, `iteration`, `output` |
| `loop:end` | `progress` | `1` | `Loop <status> after <n> iteration(s)` | `loopId`, `status` |
| `task:start` | `progress` | `0` | `Task <taskId> started` | `taskRunId`, `taskId`, `model` |
| `task:end` | `progress` | `1` | `Task <taskId> <status>` | `taskRunId`, `taskId`, `status`, `durationMs`, `usage`, `error` |

`agent:run:end` can produce a **second** spec: when the run's own output is a tool-echoed file
reference (`{kind:'file', uri, mimeType?, name?}` — a tool stored a file via `ctx.blobStore.put()`
and the agent echoed the reference as its structured output), `onSpec` fires once with a `file` spec
(same shape as the `file:generated` row above) *and* once with the usual `progress`/`Done` spec for
that one crumb — in that order, file first.

## What it deliberately doesn't do

- `reasoning:delta` maps to the `'text'` component type — deliberately not `'markdown'`
  (`text:delta`'s type), since reasoning/thinking tokens are a distinct content channel from the
  final assistant answer. `'text'` was already a defined but unused `A2UIComponentType` member, so
  this reuses it rather than adding a new named type — the same "distinguish by `type` tag alone"
  convention every other row in this table already follows.
- `file:generated` (and a tool-echoed file output) maps to a **new** `'file'` component type instead
  of reusing `'card'` (the closest existing "here's a concrete result" type, used by `tool:call`/
  `tool:result`) — unlike `reasoning:delta`, no existing `A2UIComponentType` member was idle to reuse;
  every one of the other five is already claimed by another crumb. Collapsing a generated file into a
  generic `card` would force a UI to inspect `metadata` just to tell "this is an attachment" apart
  from "this is a status card," defeating the point of a declarative, type-tagged spec.
- No component nests another — e.g. a loop's per-iteration history isn't rendered as a single `list`
  spec; each iteration is its own standalone `progress` event, consistent with how every other
  `*:start`/`*:end` pair in this table is handled.
- No spec carries auth/redaction — `metadata.result`/`output`/`response` pass the crumb's raw value
  through untouched; redact before calling `onSpec` if a tool result or task output is sensitive.
