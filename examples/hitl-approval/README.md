# hitl-approval

The agent pauses on `approve_publish` and emits a `human:required` crumb.
Resume with:

```bash
curl -X POST localhost:3000/resume/<checkpointId> -d '{"response":{"approved":true}}'
```

See [docs/hitl.md](../../docs/hitl.md) for the restart caveat.
