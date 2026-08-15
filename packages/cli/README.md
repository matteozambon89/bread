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
| `bread start` | Production server (add auth yourself via `authPlugin()` — see [auth.md](https://github.com/matteozambon89/bread/blob/HEAD/docs/auth.md)) |
| `bread build` | Compile-check the app's agents and config |
| `bread chat [agent]` | Interactive REPL with human-in-the-loop support |
| `bread invoke <agent> [input]` | One-shot run (`--json` for structured output) |
| `bread eval` | Run the project's evals |
| `bread sessions list\|cleanup` | Inspect / prune stored sessions |

## Requires Bun

**`bread` requires [Bun](https://bun.sh).** It runs `bun:sqlite` (`@breadai/store-sqlite`) with
zero flags. If Bun isn't installed, `bread` fails immediately.

Part of **[bread](https://github.com/matteozambon89/bread)** — an explicit-by-design framework for AI agents.
Docs: [CLI](https://github.com/matteozambon89/bread/blob/HEAD/docs/cli.md) ·
[all docs](https://github.com/matteozambon89/bread#documentation).

## License

MIT © Matteo Zambon
