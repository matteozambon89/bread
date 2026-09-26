# CLI

The `bread` binary (`@breadai/cli`) is a thin wrapper over `@breadai/server`; every
command resolves agents from the filesystem (`loadConfig` + `loadAgents`) and runs them
through the same core `bread.run(agentId, input, opts)` the HTTP server uses.

| Command | What it does |
|---------|--------------|
| `bread dev` | Dev server with hot reload (`-p` port, `-H` host, `--runtime bun or node` — omitted flags fall through to `config.server.{port,host,runtime}`, then `3000`/`localhost`/`bun`) |
| `bread build` | Validate every agent has an `inputSchema`, `outputSchema`, and complete `model` config |
| `bread start` | Production server (no watch; same port/host/runtime flags as `dev`) |
| `bread chat [agent]` | Interactive REPL with an agent (supports HITL) |
| `bread invoke <agent> [input]` | Run an agent once, non-interactively (no HITL) |
| `bread eval [path]` | Run evals in `agents/**/evals/*.eval.ts` |
| `bread sessions list` | List sessions (`--tag key=value`) |
| `bread sessions cleanup` | Bulk delete (`--older-than <days>`, `--tag`) |
| `bread provider list` | List catalog providers with install/env status for this project |
| `bread provider add <name>` | Install a catalog provider's peer package and show required env vars |
| `bread init [dir]` | Scaffold a project (TTY wizard; without a TTY, runtime, store, transport, agent, and install keep their defaults, and `--provider` and `--model` are required) |
| `bread agent add [id]` | Add an agent (`--provider` and `--model`; a TTY asks when omitted) and insert its id into `entrypoints` |
| `bread agent eval [agent] [name]` | Write `agents/<agent>/evals/<name>.eval.ts` (does not run evals) |
| `bread tool add [agent] [name]` | Write a `defineTool` (`--human` writes `defineHumanTool`) |
| `bread skill add [agent] [id]` | Write `agents/<agent>/skills/<id>/SKILL.md` |

All commands accept `--cwd <dir>` to point at a project root other than the current
directory. The command **enters** that directory, so relative paths in `bread.config.ts`
(e.g. a SQLite file) resolve against the project root, exactly as if you had run the
command from there.

## Listen runtime (`--runtime` / `config.server.runtime`)

`bread` is Bun-hosted (`#!/usr/bin/env bun`). Listen adapters are separate packages:

| Runtime | Package | How the CLI listens |
|---------|---------|---------------------|
| `bun` (default) | `@breadai/runtime-bun` | In-process `Bun.serve` |
| `node` | `@breadai/runtime-node` | Spawns a `node` child running that package's bin — never loads `@hono/node-server` into the Bun process |

Resolution: `--runtime` → `config.server.runtime` → `bun`. `@breadai/runtime-bun` is a dependency of `@breadai/cli`. `@breadai/runtime-node` is an optional peer.

The node child loads `bread.config.ts` and agents, so `bun:` imports (`@breadai/store-sqlite`) fail and the postgres or memory store is required.

## `build`

Loads every entrypoint agent and checks that each one has an `inputSchema`, an `outputSchema`, and a
complete `model.provider`/`model.model` — printing one `[bread] Agent "<id>" missing <field>` line
per failure and exiting non-zero if any agent fails. It does **not** run `tsc` or otherwise
type-check the project; use `bun run typecheck` for that.

## `chat`

Opens an interactive prompt and streams the agent's reply live. A single session id is
reused for every turn, so the agent keeps its memory across the conversation; the id is
printed at startup.

```bash
bread chat support            # talk to the "support" agent
bread chat                    # agent omitted — allowed only when one agent is loaded
bread chat support -s ses_42  # resume an existing session id
```

- `--skill <skill>` scopes the run to a skill.
- `-s, --session <id>` resumes a prior session instead of starting a fresh one.
- Type `/exit` (or `/quit`, or press Ctrl-D) to leave.

**Human-in-the-loop.** When the agent calls a [human tool](./hitl.md) the run suspends on a
checkpoint and `chat` prompts you inline, showing the tool name and its argument schema.
Your answer is parsed as JSON when it parses, otherwise sent as a raw string, and the run
[resumes from the store](./hitl.md#persistence-and-restart-safe-resume) — it picks up even if the
checkpoint was created in an earlier process.

## `invoke`

Runs an agent exactly once and is meant for scripting and pipes. Text deltas stream to
stdout as they arrive.

```bash
bread invoke echo "summarize this"          # streamed text → stdout, exit 0
echo "summarize this" | bread invoke echo    # input read from stdin when omitted
bread invoke echo "data" --json              # print the final structured output instead
bread invoke echo "data" --trace             # also log tool calls to stderr
```

- `--json` prints the final structured output (the agent's `agent:run:end` output) instead
  of streamed text.
- `--trace` writes tool calls to stderr so stdout stays clean for piping.
- `--skill <skill>` / `-s, --session <id>` as for `chat`.

**No human-in-the-loop.** `invoke` is non-interactive, so if the agent calls a human tool
the run could never complete unattended. Instead of hanging, `invoke` prints a clear message
to stderr naming the tool and exits non-zero — use `bread chat` for flows that need
approval.

## Scaffold

`bread init [dir]` writes `package.json`, `bread.config.ts`, `agents/<id>/agent.ts`,
`prompt.md`, and `.gitignore`, then runs `bun install` unless `--no-install` is set.
`dir` resolves against the current directory and defaults to `.`. Init does not take
`--cwd`. It writes nothing if `bread.config.ts`, `package.json`, or `agents/` already
exists. A missing directory is created. A directory that contains only `.git` is allowed.
A `.gitignore` already in that directory is not a project marker. Its bytes stay, and
any of `node_modules`, `.env`, `bread.db`, `bread.db-shm`, and `bread.db-wal` that are
not already lines in the file are appended.

On a TTY, `@clack/prompts` runs one wizard (`intro('bread')` once). A flag that was
passed is not asked. Enter accepts the default for runtime, store, transport, agent,
and install. Provider and model have no default: a blank answer is asked again, and it
is not a skip. Without a TTY, runtime, store, transport, agent, and install keep their
defaults (`bun`, `sqlite` or `memory` on node, `chunked`, `assistant`, install), and a
missing `--provider` or `--model` throws and writes nothing. An existing
`bread.config.ts`, `package.json`, or `agents/` throws `SCAFFOLD_EXISTS` before the
first question, with the same error `runInit` throws. `runInit` checks those markers
again. A flag-only init that never asks is unchanged. Cancel (`isCancel`) calls
`cancel` and exits 0. If that happens before any write, the directory is unchanged.
That exit 0 is only the question path. The wizard lives in the CLI. `runInit` and the
add runners do not read stdin.

| Order | Question | Prompt | Default |
|-------|----------|--------|---------|
| 1 | Runtime | select | `bun` (`node` is the other choice) |
| 2 | Store | select | `sqlite` on bun. On node the choices are `memory` and `postgres` only, default `memory` |
| 3 | Transport | select | `chunked` (`sse` is the other choice) |
| 4 | Agent id | text | `assistant`. An invalid id is asked again |
| 5 | Install | confirm | yes (`initialValue: true`). Skipped when `--no-install` was passed |
| 6 | Provider | text | none. A blank answer is asked again. Checked against the catalog before any write |
| 7 | Model id | text | none. A blank answer is asked again. Any non-empty string |

| Flag | Meaning |
|------|---------|
| `--runtime bun\|node` | Listen runtime. Default `bun` when there is no TTY. Always written as `server.runtime`. |
| `--store sqlite\|memory\|postgres` | Default `sqlite` for bun, `memory` for node, when there is no TTY. |
| `--transport chunked\|sse` | HTTP ingress. Default `chunked` when there is no TTY. |
| `--agent <id>` | Agent to create. Default `assistant` when there is no TTY. |
| `--provider <name>` | Catalog provider id. Required. No default. Written into `agents/<id>/agent.ts`. |
| `--model <id>` | Model id. Required. No default. Any non-empty string. Written into `agents/<id>/agent.ts`. |
| `--no-install` | Skip `bun install` and the provider package install. Not asked when passed. |

`--runtime node` depends on `@breadai/runtime-node`, sets `engines.node` to `>=22.18`, and
defaults the store to memory. Bun projects do not depend on `@breadai/runtime-bun`.
`--runtime node --store sqlite` errors and writes nothing: a Node listen child cannot load
`bun:sqlite`. Postgres uses `store()` from `@breadai/store-postgres`. SSE imports
`@breadai/transport-http-sse`.

`agents/<id>/agent.ts` sets `model.provider` and `model.model` to JSON string literals
for the chosen provider and model. `bread.config.ts` keeps `providers: providerCatalog`.
An unknown provider throws `UNKNOWN_PROVIDER` before any file is written. Only the
catalog's own keys count, so an inherited name such as `constructor` throws before any
write and before `bun install` or `bun add`. When install
runs, `bread provider add <provider>` runs after `bun install` succeeds. Each command
prints a status line, then its output — not a Clack spinner, which would take raw mode
and `process.exit(0)` on Ctrl+C without signalling the child. Ctrl+C during either
command kills that child and exits non-zero. `--no-install` prints
`bread provider add <provider>` instead of installing it. The outro names that provider,
then `bread dev` — it does not name a different provider. The outro also names the
scaffolded directory. A postgres project also says to set `DATABASE_URL`. If
`bun install` fails, the files stay and the error says they were written and install
failed. If a write fails, only the paths this call created are removed and a
pre-existing `.gitignore` is left as it was. A failed `bun install` is not rolled back.
If the catalog package install fails after those files were written, the error says
the project files were already written, that a second `bread init` will refuse with
`SCAFFOLD_EXISTS`, and it keeps the underlying `bun add` failure. `bread provider add`
on an existing project keeps its own error and does not add that wording.

### Adding files

Add commands take `--cwd`. They require an existing project. Tool, skill, and eval also
require `agents/<agent>/agent.ts` — they do not create the agent. A duplicate id, agent
directory, tool file, skill directory, or eval file writes nothing. A missing name throws
and writes nothing.

On a TTY, each missing name is one text prompt. There is no default. Without a TTY, a
missing name throws before prompting and writes nothing. `--human` and `--description`
stay flags and are not asked. Cancel exits 0; before any write, the directory is unchanged.

- `bread agent add [id]` also takes `--provider` and `--model`. A TTY asks for each one that was not passed; a blank answer is asked again. Without a TTY, missing either throws and writes nothing. It writes those strings into the agent file, then inserts the id into `entrypoints`.
- `bread tool add [agent] [name]` writes `defineTool`. `--human` writes `defineHumanTool`. It does not take `--provider` or `--model`.
- `bread skill add [agent] [id]` writes `SKILL.md`. Optional `--description`. It does not take `--provider` or `--model`.
- `bread agent eval [agent] [name]` writes one functional eval. It does not change `bread eval`, and it does not take `--provider` or `--model`.

**Names.** Agent ids match `^[a-z][a-z0-9]*([_-][a-z0-9]+)*$` (`assistant`, `ticket-lookup`).
Tool names, skill ids, and eval stems use `assertName` (`^[a-z][a-z0-9_]*$`). `web-search`
is not a tool name. `Bad` is not an agent id.

**Plain entrypoints list.** `agent add` edits `entrypoints` only when the file has exactly
one `entrypoints:` in code and the array contains only whitespace, commas, and quoted
strings. Space, tab, newline, and carriage return may separate the name from `:`.
Comments, strings, and template literals do not count. A `/` in code that is
not a comment (a regexp or a division) and a `$` on an identifier boundary
(`foo$entrypoints`, `$schema`) refuse the edit — the scanner will not guess. `-` is part
of an identifier, so `my-entrypoints:` is not a match. Zero code matches, two or more
code matches, or anything else in the array (a spread, a variable, a comment, a leading,
doubled, or elided comma, or two quoted strings with no comma between them) refuses the
edit, writes nothing, and tells you to add the id by hand. A typed binding
(`const entrypoints: ['echo'] = ['echo']`) is not a plain list and refuses the edit.
`entrypoints: ['echo'] as const` stays editable. One trailing comma is kept
(`['assistant',]` becomes `['assistant', 'writer']`).
An id already listed errors and writes nothing. The new id uses the first element's
quote, or a single quote when the array is empty (`[]` becomes `['id']`). A one-line
array gets a comma and the id before `]`. A multi-line array gets a new line at the last
element's indent, and a comma on the previous element when it lacks one. When `]` shares
that element's line, the new id is inserted above it and `]` stays on the new id's line
so the bracket does not drop to column 0.

**Agent argument.** `tool add`, `skill add`, and `agent eval` check the agent with the
same agent-id rule. `..` and a quote are rejected, and nothing is written outside the
project. `--description` must be a single line. A newline would add a YAML key or close
the frontmatter, so the command writes nothing.
