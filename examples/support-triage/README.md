# support-triage

The flagship combined example: a `triage-supervisor` delegates a ticket to `investigator`, which
loops over `ticket-lookup` → `policy-check` to decide refund eligibility, then pauses for a human
to approve any refund before finishing. Exposed over AG-UI so a real frontend could drive it.

Four capabilities in one run, each exercising a specific, previously real bug fix rather than being
here "because it exists": supervisor `mediate`-visibility crumb relabeling, loop iteration/judge
tools, HITL suspend that survives a process restart, and AG-UI as a real ingress. See
[`docs/pipelines.md#supervisors`](../../docs/pipelines.md#supervisors),
[`docs/loops.md`](../../docs/loops.md), [`docs/hitl.md`](../../docs/hitl.md), and
[`docs/ag-ui.md`](../../docs/ag-ui.md) for each feature on its own.

## Run it

```bash
bread dev
```

Two tickets reliably reach the human-approval gate; one doesn't:

```bash
# damaged item -> eligible -> pauses for approval
curl -N -X POST localhost:3000/agents/triage-supervisor/run -d '{"input":"ord-1001, keyboard arrived cracked"}'

# billing error -> eligible -> pauses for approval
curl -N -X POST localhost:3000/agents/triage-supervisor/run -d '{"input":"ord-1002, charged twice"}'

# old order, no damage/billing issue -> not eligible -> no approval gate, resolves immediately
curl -N -X POST localhost:3000/agents/triage-supervisor/run -d '{"input":"ord-1003, want a refund"}'
```

Watch the stream for `subagent:run:start`/`:end` around the investigator's work (not its raw
tokens — that's `mediate` visibility), `loop:start`/`loop:iteration:*`/`loop:end` around the
lookup→policy pipeline, and `human:required` carrying a `checkpointId` when a refund is proposed.

## Resume — including across a restart

```bash
curl -X POST localhost:3000/resume/<checkpointId> -d '{"response":{"approved":true}}'
```

To see the restart-safety this example is built to prove: stop `bread dev` (Ctrl-C) after the run
pauses at `human:required`, start it again, then send the same resume call above against the new
process. It completes from the persisted checkpoint — no in-memory run to lose. See
[`docs/hitl.md#persistence-and-restart-safe-resume`](../../docs/hitl.md#persistence-and-restart-safe-resume)
for why (and [`#hitl-inside-a-composition`](../../docs/hitl.md#hitl-inside-a-composition) for how
the suspend chain-suspends the supervisor above it).

From a terminal, [`bread chat triage-supervisor`](../../docs/cli.md#chat) drives the whole
prompt/resume loop for you instead of raw curl.
