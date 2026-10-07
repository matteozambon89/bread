---
layout: home

hero:
  name: bread
  text: Explicit by design.
  tagline: A file-system-convention framework for building, running, and observing AI agents on the Vercel AI SDK — no silent defaults, no auto-wired fallbacks.
  image:
    light: /mark-light-512.png
    dark: /mark-dark-512.png
    alt: bread
  actions:
    - theme: brand
      text: Start with architecture
      link: /architecture
    - theme: alt
      text: View on GitHub
      link: https://github.com/matteozambon89/bread
---

<div class="bread-proof">

<section>

## No silent defaults

bread refuses to guess on your behalf. Store, transport, and providers are arguments you pass,
not conventions it infers — swap `@breadai/store-sqlite` for `@breadai/store-postgres` and
nothing else in the app changes.

```ts
// bread.config.ts — store/transport/providers are never inferred
export default defineConfig({
  entrypoints: ['researcher', 'writer'],
  store: store({ path: './bread.db' }),  // @breadai/store-sqlite
  transport: transport(),                // @breadai/transport-http-chunked
  providers: providerLlm,                // @breadai/provider-llm
})
```

</section>

<section>

## bread discovers everything by convention

No registry, no decorators — an agent is a folder.

<div class="bread-tree">
bread.config.ts<br>
agents/<br>
&nbsp;&nbsp;researcher/<br>
&nbsp;&nbsp;&nbsp;&nbsp;<span class="file">agent.ts</span><br>
&nbsp;&nbsp;&nbsp;&nbsp;<span class="file">prompt.md</span><br>
&nbsp;&nbsp;&nbsp;&nbsp;tools/<span class="file">web-search.ts</span><br>
&nbsp;&nbsp;&nbsp;&nbsp;skills/deep-research/<br>
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<span class="file">SKILL.md</span>
</div>

</section>

<section>

## One CLI, every stage

Dev server, build validation, production start, and an interactive REPL — the same commands
from prototype to deploy. See the full list in [CLI](./cli.md).

| Command | What it does |
|---|---|
| `bread dev` | Dev server with hot reload |
| `bread build` | Validate every agent's schema + model config |
| `bread start` | Production server (no watch) |
| `bread chat [agent]` | Interactive REPL — supports human-in-the-loop |
| `bread eval [path]` | Run evals in `agents/**/evals/*.eval.ts` |

</section>

<section>

## Every run streams as crumbs

One choke point assigns a per-run `seq`, persists to the crumb log, and fans out to the client,
your plugins, and other replicas — the same well-defined stream everywhere. See
[architecture](./architecture.md#one-crumb-stream-the-choke-point).

```bash
curl -N -X POST localhost:3000/agents/researcher/run \
  -d '{"input":"survey vector db options"}'

# → agent:run:start, text:delta, tool:call, tool:result, agent:run:end
```

</section>

<section>

## Sessions, HITL, pipelines, loops, and plugins — built in

Compose agents without reaching for a second framework:

<div class="bread-pills">
<span class="bread-pill">@breadai/otel</span>
<span class="bread-pill">@breadai/protocol-ag-ui</span>
<span class="bread-pill">@breadai/protocol-a2a-server</span>
<span class="bread-pill">@breadai/a2ui</span>
<span class="bread-pill">@breadai/protocol-mcp-client</span>
<span class="bread-pill">@breadai/protocol-mcp-server</span>
<span class="bread-pill">@breadai/auth-api-key</span>
<span class="bread-pill">@breadai/auth-jwt</span>
<span class="bread-pill">@breadai/auth-oauth2</span>
<span class="bread-pill">@breadai/transport-http-chunked</span>
<span class="bread-pill">@breadai/transport-http-sse</span>
<span class="bread-pill">@breadai/transport-redis</span>
<span class="bread-pill">@breadai/transport-stdout</span>
</div>

</section>

</div>

<div class="bread-index">

<div>

<h6>Introduction</h6>

- [Architecture](./architecture.md)
- [CLI](./cli.md)

</div>

<div>

<h6>Building agents</h6>

- [Agents](./agents.md)
- [Providers](./providers.md)
- [Decisions](./decisions.md)
- [Tools](./tools.md)
- [Skills](./skills.md)
- [Sessions](./sessions.md)
- [HITL](./hitl.md)

</div>

<div>

<h6>Composition</h6>

- [Pipelines](./pipelines.md)
- [Loops](./loops.md)
- [Tasks](./tasks.md)
- [Evals](./evals.md)
- [Plugins](./plugins.md)

</div>

<div>

<h6>Distribution</h6>

- [Remote agents](./remote-agents.md)
- [Transports](./transports.md)
- [MCP client](./mcp-client.md)
- [MCP server](./mcp-server.md)
- [A2A server](./a2a.md)
- [A2UI](./a2ui.md)
- [Auth](./auth.md)
- [OTel](./otel.md)
- [AG-UI](./ag-ui.md)

</div>

<div>

<h6>Reference</h6>

- [HTTP API](./http-api.md)
- [Store](./store.md)
- [Glossary](./glossary.md)

</div>

</div>
