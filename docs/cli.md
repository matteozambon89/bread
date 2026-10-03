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
| `bread init [dir]` | Scaffold a project (flags only; `--provider` and `--model` are required; a TTY missing another choice errors and names the flag) |
| `bread agent add <id>` | Add an agent (`--provider` and `--model` required) and insert its id into `entrypoints` |
| `bread agent eval <agent> <name>` | Write `agents/<agent>/evals/<name>.eval.ts` (does not run evals) |
| `bread tool add <agent> <name>` | Write a `defineTool` (`--human` writes `defineHumanTool`) |
| `bread skill add <agent> <id>` | Write `agents/<agent>/skills/<id>/SKILL.md` |

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

This layer is flags only. It does not prompt. On a TTY, a missing `--runtime`,
`--store`, `--transport`, or `--agent` throws and names the flag. Without a TTY those
use defaults, and install still runs unless `--no-install` is set. `--provider` and
`--model` have no default: missing either throws and writes nothing, on a TTY and
without one. An unknown provider throws `UNKNOWN_PROVIDER` before any file is written.
Only the catalog's own keys count, so an inherited name such as `constructor` throws
`UNKNOWN_PROVIDER` before any write and before `bun install`. The model is any non-empty
string.

| Flag | Meaning |
|------|---------|
| `--runtime bun\|node` | Listen runtime. Default `bun` when there is no TTY. Always written as `server.runtime`. |
| `--store sqlite\|memory\|postgres` | Default `sqlite` for bun, `memory` for node, when there is no TTY. |
| `--transport chunked\|sse` | HTTP ingress. Default `chunked` when there is no TTY. |
| `--agent <id>` | Agent to create. Default `assistant` when there is no TTY. |
| `--provider <name>` | Catalog provider id. Required. Written into `agents/<id>/agent.ts`. |
| `--model <id>` | Model id. Required. Any non-empty string. Written into `agents/<id>/agent.ts`. |
| `--no-install` | Skip `bun install`. |

`--runtime node` depends on `@breadai/runtime-node`, sets `engines.node` to `>=22.18`, and
defaults the store to memory. Bun projects do not depend on `@breadai/runtime-bun`.
`--runtime node --store sqlite` errors and writes nothing: a Node listen child cannot load
`bun:sqlite`. Postgres uses `store()` from `@breadai/store-postgres`. SSE imports
`@breadai/transport-http-sse`.

`agents/<id>/agent.ts` sets `model.provider` and `model.model` to those strings.
`bread.config.ts` keeps `providers: providerCatalog`. Init does not install the provider
package. Success text names `bread provider add <provider>`, then `bread dev`. A postgres
project also says to set `DATABASE_URL`. If `bun install` fails, the files stay and the
error says they were written and install failed. If a write fails, only the paths
this call created are removed and a pre-existing `.gitignore` is left as it was. A
failed `bun install` is not rolled back.

### Adding files

Add commands take `--cwd`. They require an existing project. Tool, skill, and eval also
require `agents/<agent>/agent.ts` — they do not create the agent. A duplicate id, agent
directory, tool file, skill directory, or eval file writes nothing. A missing name throws
and writes nothing.

- `bread agent add <id>` requires `--provider` and `--model`, writes those into the agent file, then inserts the id into `entrypoints`. Tool, skill, and eval do not take those flags.
- `bread tool add <agent> <name>` writes `defineTool`. `--human` writes `defineHumanTool`.
- `bread skill add <agent> <id>` writes `SKILL.md`. Optional `--description`.
- `bread agent eval <agent> <name>` writes one functional eval. It does not change `bread eval`.

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
