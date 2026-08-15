# loop

An agent-driven loop. The `editor` (host/judge) composes a `drafter → critic` pipeline at runtime,
runs it, judges the critique, and re-iterates the **same** pipeline until satisfied or its cap of 4
iterations is hit. `drafter` and `critic` are the editor's configured `pool`.

```bash
curl -N -X POST localhost:3000/agents/editor/run -d '{"input":"why sourdough rises"}'
```

Watch the SSE stream for `loop:start`, `loop:iteration:start` / `:end` (with the inner
`pipeline:step:*` crumbs), and `loop:end`. Then inspect the persisted run:

```bash
curl localhost:3000/loops?agent=editor
curl localhost:3000/loops/<loopId>
```

See [`docs/loops.md`](../../docs/loops.md) for the full feature reference.
