# Branching — status and next steps

> Status note, not a spec. Companion to the pipeline → graph layers discussion.

## Where we are

- **Pipelines are shipped**: `agent`, `parallel`, `map` step types, `POST /pipelines/:id/run`, durable HITL suspension with checkpoint linkage carrying remaining steps, `pipeline:step:start` / `pipeline:step:end` framing crumbs.
- **Branching is spec-only** (PR #22, `docs/pipeline-graph.md`). No runtime, no Zod schema, no HTTP surface. The spec proposes exclusive paths chosen by data predicates on structured output — not a free agent turn.

## What branching adds

- A new step type (proposed name: `branch`) with arms gated by predicates over the previous step's structured output.
- Strict-match vs range predicates, empty-arm behavior, and the predicate language are open questions the implementation PR must resolve — the graph layer inherits those decisions.

## What it does *not* add

- No new executor. Branch compiles into the existing series-parallel runtime.
- No model routing on edges. Predicates are data, not LLM calls.

## Sequencing

Branch is the next milestone after pipelines. The graph layer (Layer 3 in the spec) is explicitly a separate minor *after* Branch has real users — do not build it in the same PR.

## Open questions to settle in the implementation PR

1. Predicate language (JSONPath? custom DSL? Zod-derived?).
2. Strict match vs ranges vs custom functions.
3. Empty arms: error, skip, or default arm?
4. How `branch` interacts with `parallel` and `map` (nesting rules).
5. Crumb framing: do branch arms get their own start/end crumbs, or reuse `pipeline:step:*`?
