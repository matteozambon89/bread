# otel

Traces every run with `@bread/otel`: an `agent.run` span per run, a `tool.call.*` child span per
tool call, and `pipeline.step.*` spans for pipeline steps — exported here to the console via a
`NodeTracerProvider`; swap in an OTLP exporter for a real backend.

```bash
bun install && bread dev
curl -N -X POST localhost:3000/agents/assistant/run -d '{"input":"hi"}'
# spans print to the server console as the run progresses
```
