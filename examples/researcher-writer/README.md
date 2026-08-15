# researcher-writer

An LLM supervisor: the `editor` agent delegates via the `core_delegate` tool —
researcher + fact-checker in one parallel turn (`max: 2` caps concurrency), then the
writer composes an article from the verified facts, and the editor returns the final
piece as its own answer.

Watch the crumbs: raw researcher/writer streams (`passthrough` visibility),
`subagent:run:start` / `subagent:run:end` framing for the fact-checker (`mediate`),
and one `tool:call`/`tool:result` pair per delegation.

```bash
curl -N -X POST localhost:3000/agents/editor/run -d '{"input":"sourdough"}'
```
