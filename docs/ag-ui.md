# AG-UI — `@bread/protocol-ag-ui`

Bridges bread's crumb stream to [AG-UI protocol](https://ag-ui.com) events for frontend
integrations. The mapping is **stateful** — that's what produces spec-conformant text framing:
an assistant message opens on a run's first `text:delta` and closes at the next tool call, run
end, error, or HITL suspension.

## Crumb → event mapping

`CUSTOM` is the AG-UI spec's own general-purpose extensibility event
(`{type:'CUSTOM', name, value}`, `EventType.CUSTOM`) — used here only for `FILE_GENERATED`, the
same shape regardless of whether a model generated the file directly or a tool stored it and the
agent echoed the reference.

| Crumb | AG-UI events |
|-------|--------------|
| `agent:run:start` | `RUN_STARTED` (`threadId` = bread sessionId, `runId`) |
| `text:delta` | `TEXT_MESSAGE_START` (first delta) then `TEXT_MESSAGE_CONTENT` (`messageId`, `delta`) |
| `file:generated` | `CUSTOM` (`name: 'FILE_GENERATED'`, `value: {uri, mimeType, name?}`) |
| `tool:input:start` | `TEXT_MESSAGE_END` (if a message is open) → `TOOL_CALL_START` (`toolCallName`, `parentMessageId`) |
| `tool:input:delta` | `TOOL_CALL_ARGS` (real per-chunk `delta`, as streamed by the provider) |
| `tool:input:end` | `TOOL_CALL_END` |
| `tool:call` | For a provider that streamed its input (the common case, see above): a no-op — `TOOL_CALL_START`/`ARGS`/`END` were already emitted. Fallback for a provider that didn't stream input: `TEXT_MESSAGE_END` (if open) → `TOOL_CALL_START` → `TOOL_CALL_ARGS` (full JSON as one delta) → `TOOL_CALL_END` |
| `tool:result` | `TOOL_CALL_RESULT` (`content`) |
| `tool:error` | `TOOL_CALL_RESULT` with `{ error: { code, message } }` content |
| `agent:run:end` | `TEXT_MESSAGE_END` (if open) → `CUSTOM` (`name: 'FILE_GENERATED'`, only when the run's output is a tool-echoed file reference) → `RUN_FINISHED` (`result`) |
| `agent:error` | `TEXT_MESSAGE_END` (if open) → `RUN_ERROR` (`message`, `code`) |
| `human:required` | `TEXT_MESSAGE_END` (the run suspends; the suspension itself is bread-specific) |
| `pipeline:step:start/end` | `STEP_STARTED` / `STEP_FINISHED` (`stepName`) |
| `loop:*` | `STATE_SNAPSHOT` with one consistent, accreting `{ loop: { loopId, phase, iteration, … } }` shape, plus `STEP_STARTED/FINISHED` per iteration |
| `subagent:run:start/end` | `STEP_STARTED` / `STEP_FINISHED` (`stepName: subagent_<subagentId>`), plus a `STATE_SNAPSHOT` (`{ subagent: { parentAgentId, subagentId, status, output? } }`) |
| `task:start/end` | `STEP_STARTED` / `STEP_FINISHED` (`stepName: task_<taskRunId>`), plus a `STATE_SNAPSHOT` (`{ task: { taskRunId, taskId, model?, status, durationMs?, usage?, error? } }`) — not linked to a wrapping tool call (`task:start`/`task:end` carry no `toolCallId`); a task's own `tool:call` still emits its own `TOOL_CALL_START/ARGS/END` wrapper independently, exactly like any other tool |

## HTTP ingress

Passing `agentId` turns `agUi()` into a real AG-UI ingress: it registers an HTTP route (via
`BreadPlugin.routes`, same seam `a2aServer()` uses) that accepts a spec-conformant
[`RunAgentInput`](https://docs.ag-ui.com/concepts/messages) POST body and streams the mapped
`AgUiEvent`s back as bare SSE frames (`data: {event json}\n\n` — no envelope, unlike A2A's
JSON-RPC wrapping).

```ts
// bread.config.ts
import { defineConfig } from '@bread/core'
import { agUi } from '@bread/protocol-ag-ui'

export default defineConfig({
  entrypoints: ['assistant'],
  plugins: [
    agUi({ agentId: 'assistant', path: '/ag-ui/run' }), // path defaults to '/ag-ui/run'
  ],
})
```

```
POST /ag-ui/run
{
  "threadId": "thread-1",
  "runId": "run-1",
  "state": null,
  "messages": [{ "id": "m1", "role": "user", "content": "hi" }],
  "tools": [],
  "context": [],
  "forwardedProps": null
}
```

streams:

```
data: {"type":"RUN_STARTED","threadId":"thread-1","runId":"...", ...}

data: {"type":"TEXT_MESSAGE_START", ...}

data: {"type":"TEXT_MESSAGE_CONTENT","delta":"hello", ...}

data: {"type":"TEXT_MESSAGE_END", ...}

data: {"type":"RUN_FINISHED", ...}
```

What it does and doesn't do:

- `threadId` maps directly to bread's own `session.id` — multi-turn history is accumulated
  server-side by bread's session store, not by replaying `messages`. Only the **last** message's
  `content` becomes the new turn's input; earlier entries in a resent `messages` array are
  assumed to already be in that session's history (they'd otherwise be fed back to the model
  twice). Non-text messages (no string `content`) are rejected with `400` — there's no
  tool-result/data-part mapping into bread's `input` yet.
  A malformed body (missing `threadId`, empty `messages`) is rejected with `400` before any run
  starts — never a silently empty stream.
- One plugin instance binds to exactly one agent, mirroring `a2aServer()`'s `A2AServerConfig`.
  Expose more agents by mounting `agUi(...)` again with a different `agentId`/`path`.
- `state`, `tools`, `context`, and `forwardedProps` on the incoming `RunAgentInput` are accepted
  (schema-valid) but not yet wired into the run — no state-diffing or frontend-tool-call-back
  support on this side.
- The route uses its own per-request transformer instance internally, independent of the
  crumb-bus subscription `onEvent` uses (see below) — the two never share transformer state, even
  when both are configured on the same `agUi(...)` instance.
- **Authorization**: opt-in via `agUi({ authorizeThread })`. `authorizeThread(identity, threadId)`
  receives whatever `authMiddleware`/`authPlugin()` stashed as the caller's `AuthIdentity`
  (`undefined` if no auth ran) and the request's `threadId`; returning/resolving `false` responds
  `403` before any run starts. No `authorizeThread` configured → `threadId` is used directly as
  bread's `session.id` with no ownership check — any caller who knows or guesses a `threadId` can
  read/write that session's history. Same opt-in shape as
  [`authorizeStream`](./http-api.md#get-runsrunidstream) on the passive run-stream route.

## Output-mapper usage

`agentId`/`path` and `onEvent` are independent — set either, or both. Without `agentId`, `agUi()`
registers no route at all (output-mapper-only, the original behavior):

```ts
// bread.config.ts
import { defineConfig } from '@bread/core'
import { agUi } from '@bread/protocol-ag-ui'

export default defineConfig({
  entrypoints: ['assistant'],
  plugins: [
    agUi({ onEvent: (event) => transport.send(event) }), // your AG-UI client transport
  ],
})
```

The plugin subscribes to the crumb bus, so it sees every run on the instance. For a
per-connection stream (one transformer per SSE/WebSocket client), build on the exported
transformer instead — it's stateful, so use one instance per stream:

```ts
import { createAgUiTransformer } from '@bread/protocol-ag-ui'

const transform = createAgUiTransformer()
for await (const crumb of bread.run('assistant', input, { mode: 'stream' })) {
  for (const event of transform(crumb)) send(event)
}
```

See [`examples/ag-ui-plugin`](../examples/ag-ui-plugin) for a runnable version that logs the
event stream.
