# CLI

The `bread` binary (`@bread/cli`) is a thin wrapper over `@bread/server`; every
command resolves agents from the filesystem (`loadConfig` + `loadAgents`) and runs them
through the same core `bread.run(agentId, input, opts)` the HTTP server uses.

| Command | What it does |
|---------|--------------|
| `bread dev` | Dev server with hot reload (`-p` port, `-H` host — omitted flags fall through to `config.server.{port,host}`, then `3000`/`localhost`) |
| `bread build` | Validate every agent has an `inputSchema`, `outputSchema`, and complete `model` config |
| `bread start` | Production server (no watch) |
| `bread chat [agent]` | Interactive REPL with an agent (supports HITL) |
| `bread invoke <agent> [input]` | Run an agent once, non-interactively (no HITL) |
| `bread eval [path]` | Run evals in `agents/**/evals/*.eval.ts` |
| `bread sessions list` | List sessions (`--tag key=value`) |
| `bread sessions cleanup` | Bulk delete (`--older-than <days>`, `--tag`) |
| `bread provider list` | List catalog providers with install/env status for this project |
| `bread provider add <name>` | Install a catalog provider's peer package and show required env vars |

All commands accept `--cwd <dir>` to point at a project root other than the current
directory. The command **enters** that directory, so relative paths in `bread.config.ts`
(e.g. a SQLite file) resolve against the project root, exactly as if you had run the
command from there.

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
