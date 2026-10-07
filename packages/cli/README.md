<p align="center">
  <a href="https://github.com/matteozambon89/bread">
    <img alt="bread" src="https://cdn.jsdelivr.net/gh/matteozambon89/bread/assets/brand/mark-light-512.png" height="64">
  </a>
</p>

# @breadai/cli

The `bread` command-line interface.

```bash
bun add -g @breadai/cli   # or: npm i -g @breadai/cli
```

| Command | What it does |
|---------|--------------|
| `bread dev` | Hot-reload dev server |
| `bread start` | Production server (add auth yourself via `authPlugin()` — see [auth.md](https://matteozambon89.github.io/bread/auth.html)) |
| `bread build` | Compile-check the app's agents and config |
| `bread chat [agent]` | Interactive REPL with human-in-the-loop support |
| `bread invoke <agent> [input]` | One-shot run (`--json` for structured output) |
| `bread eval` | Run the project's evals |
| `bread sessions list\|cleanup` | Inspect / prune stored sessions |
| `bread init [dir]` | Scaffold a project. On a TTY, asks the questions below. Without a TTY, runtime, store, transport, agent, and install keep their defaults; `--provider` and `--model` are required |
| `bread agent add [id]` | Add an agent (`--provider` and `--model`; a TTY asks when either is omitted) to a plain `entrypoints` list (`assistant`, `ticket-lookup`) |
| `bread tool add [agent] [name]` | Write a tool (`--human` stays a flag). `web-search` is not a valid tool name |
| `bread skill add [agent] [id]` | Write `SKILL.md` (`--description` stays a flag) |
| `bread agent eval [agent] [name]` | Write an eval file. Does not change `bread eval` |

`bread init` on a TTY asks in this order. A passed flag is not asked. An existing `bread.config.ts`, `package.json`, or `agents/` throws `SCAFFOLD_EXISTS` before the first question. Enter accepts the default for runtime, store, transport, agent, and install. Provider and model have no default: a blank answer is asked again. Cancel exits 0; before any write, the directory is unchanged. Without a TTY, missing `--provider` or `--model` throws and writes nothing. A flag-only init that never asks is unchanged.

| Order | Question | Prompt | Default |
|-------|----------|--------|---------|
| 1 | Runtime | select | `bun` |
| 2 | Store | select | `sqlite` on bun; on node, `memory` or `postgres` only, default `memory` |
| 3 | Transport | select | `chunked` |
| 4 | Agent id | text | `assistant` (an invalid id is asked again) |
| 5 | Install | confirm | yes |
| 6 | Provider | text | none — a blank answer is asked again |
| 7 | Model id | text | none — a blank answer is asked again |

The chosen provider is installed after `bun install`. `--no-install` prints `bread provider add <name>` instead. The outro names that provider. Add commands use text only for a missing name. Tool, skill, and eval do not ask for a provider or model.

## Listen runtime

Default listen is Bun (`@breadai/runtime-bun`, a dependency of `@breadai/cli`, in-process). For Node listen, install the optional peer `@breadai/runtime-node` and pass `--runtime node` (or set `config.server.runtime: 'node'`) — the CLI spawns a Node child so `@hono/node-server` never runs inside the Bun process. That child loads `bread.config.ts` and agents, so `bun:` imports (`@breadai/store-sqlite`) fail and the postgres or memory store is required.

## Requires Bun

**`bread` requires [Bun](https://bun.sh).** It runs `bun:sqlite` (`@breadai/store-sqlite`) with
zero flags. If Bun isn't installed, `bread` fails immediately.

Part of **[bread](https://github.com/matteozambon89/bread)** — an explicit-by-design framework for AI agents.
Docs: [CLI](https://matteozambon89.github.io/bread/cli.html) ·
[all docs](https://matteozambon89.github.io/bread/).

## License

MIT © Matteo Zambon
