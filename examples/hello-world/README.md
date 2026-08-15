# hello-world

The smallest bread app: one agent, one NDJSON call.

```bash
bun install && bread dev
curl -N -X POST localhost:3000/agents/echo/run -d '{"input":"hi"}'
```
