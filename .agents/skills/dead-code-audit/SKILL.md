---
name: dead-code-audit
description: Find and remove dead code across the bread monorepo (unused files, exports, dependencies) using knip plus agent verification against bread's dynamic-loading conventions. Use when the user asks to audit, clean up, or find dead/unused code in the repo.
---

`knip` is already installed and configured (`knip.json` at repo root, `bun run knip` script) —
no setup needed, this is a repeatable check, not a one-off.

## Steps

1. `bun run knip --reporter json > .tmp/knip-raw.json` — regenerate the candidate list. Inspect
   with `jq` (counts per category first, then the flagged files/names) before doing anything else.
2. **Never trust a knip finding blind.** Verify each candidate before treating it as dead:
   - An "unused export" can be legitimate public API surface (re-exported from a package's
     barrel `src/index.ts`) even with zero internal callers — check the barrel before flagging.
   - An "unlisted dependency" (imported but not declared) can silently resolve today via
     workspace hoisting or a transitive package's private `node_modules` copy — confirm it's
     genuinely missing, not just undeclared-but-working, then add it explicitly rather than
     leaving it to luck.
   - A type/interface used only internally by its own file (never imported by name elsewhere,
     not re-exported from the barrel) is safe to de-export (drop `export`), not necessarily
     safe to delete — check whether the file still needs it.
3. For a handful of findings, verify by hand (Read/grep). For enough volume to be worth
   parallelizing, use the `Workflow` tool: pipeline each finding-category through a verify stage
   (agent greps/reads to confirm or refute) then a synthesize stage (agent writes confirmed
   findings into a section of `.tmp/dead-code-audit.md`). Don't spin up a heavy multi-agent
   pipeline for a dozen items — scale the workflow to what knip actually found, not to the plan
   written before running it.
4. Walk the audit document section by section with the user before touching anything — build
   the action list together, then execute only what's approved, one section at a time.
5. After edits: `bun install` (if any package.json dependency changed), then
   `bun run typecheck && bun run build && bun run test` must stay green.

## Why `knip.json` looks the way it does

bread loads a lot of code dynamically rather than via static imports — the CLI loader
(`packages/server/src/loader.ts`) globs `agents/<id>/agent.ts`, `agents/<id>/tools/*.ts`,
`agents/<id>/skills/*/SKILL.md`, `tasks/*.ts`, and `**/*.eval.ts` under each `examples/*` app's
project root. None of that is reachable via static analysis, so `knip.json`'s
`workspaces["examples/*"].entry` explicitly lists those glob shapes as entry points. Separately,
`**/test/fixtures/**` is in `ignore` — those are intentionally-unimported fixture files the
loader's own tests load dynamically at runtime, not dead code.

## Known limitations

- The `knip.json` entry/ignore config is tuned for the current package and `examples/*` layout.
  A newly added package with a non-barrel `exports` shape, or a new example with a dynamic-load
  convention not already listed above, needs a `knip.json` update first — otherwise it will
  either over-flag (false positives) or silently under-flag (miss real dead code).
