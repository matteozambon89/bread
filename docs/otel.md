# OpenTelemetry — `@bread/otel`

Traces every run. The plugin subscribes to the crumb bus and maps each crumb type to a span:

| Span | Opens on | Closes on | Attributes |
|------|----------|-----------|------------|
| `agent.run` | `agent:run:start` | `agent:run:end` / `agent:error` (exception recorded) | `bread.agent_id`, `bread.run_id`, `bread.session_id`, `bread.duration_ms`, `bread.output_file_uri` (only when the run's output is a tool-echoed file reference) |
| `tool.call.<leaf>` | `tool:call` | `tool:result` / `tool:error` (exception recorded) | `bread.tool_name`, `bread.tool_call_id`, `bread.duration_ms` |
| `pipeline.step.<n>` | `pipeline:step:start` | `pipeline:step:end` | `bread.pipeline_id`, `bread.step_index`, `bread.agent_id` |
| `human.wait` | `human:required` | `human:resumed` | `bread.checkpoint_id`, `bread.tool_name`, `bread.kind` |
| `subagent.run` | `subagent:run:start` | `subagent:run:end` | `bread.agent_id` (the sub-agent's id), `bread.parent_agent_id`, `bread.run_id` |
| `loop.run` | `loop:start` | `loop:end` | `bread.loop_id`, `bread.pipeline`, `bread.max_iterations`, `bread.status`, `bread.iterations` (the last two on close) |
| `loop.iteration.<n>` | `loop:iteration:start` | `loop:iteration:end` (or closed by `loop:end` if a failed iteration left one dangling) | `bread.loop_id`, `bread.iteration` |
| `file.generated` | `file:generated` | (single-shot — opens and closes immediately) | `bread.file_uri`, `bread.file_mime_type` |

Tool, human-wait, subagent, loop, and file spans are children of their run span (`subagent.run` finds
its parent via a secondary `agentId`-keyed index, since `subagent:run:start` carries `parentAgentId`,
not a parent `runId`). `close()` ends any spans a crashed run left open.

## Setup

```ts
// bread.config.ts
import { defineConfig } from '@bread/core'
import { otel } from '@bread/otel'

export default defineConfig({
  entrypoints: ['researcher'],
  plugins: [otel({ serviceName: 'my-bread-app' })],
})
```

The plugin depends only on `@opentelemetry/api` — spans go wherever your app's registered tracer
provider sends them. For local visibility, register a console exporter (this is what
[`examples/otel`](../examples/otel) does):

```ts
import { ConsoleSpanExporter, NodeTracerProvider, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-node'

new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(new ConsoleSpanExporter())],
}).register()
```

In production, swap the exporter for OTLP and point it at your collector. Alternatively pass a
`tracer` directly: `otel({ tracer: myTracer })`.

## What it deliberately doesn't do

- No metrics or logs — spans only.
- No context propagation into tool `execute()` bodies; a tool doing its own tracing starts a new
  trace unless you wire propagation yourself.
