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
  providers: providerCatalog,            // @breadai/provider-catalog
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
from prototype to deploy. See the full list in [CLI](/cli).

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
[architecture](/architecture#one-crumb-stream-the-choke-point).

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
    <ul><li><a href="/architecture">Architecture</a></li><li><a href="/cli">CLI</a></li></ul>
  </div>
  <div>
    <h6>Building agents</h6>
    <ul>
      <li><a href="/agents">Agents</a></li>
      <li><a href="/providers">Providers</a></li>
      <li><a href="/tools">Tools</a></li>
      <li><a href="/skills">Skills</a></li>
      <li><a href="/sessions">Sessions</a></li>
      <li><a href="/hitl">HITL</a></li>
    </ul>
  </div>
  <div>
    <h6>Composition</h6>
    <ul>
      <li><a href="/pipelines">Pipelines</a></li>
      <li><a href="/loops">Loops</a></li>
      <li><a href="/tasks">Tasks</a></li>
      <li><a href="/evals">Evals</a></li>
      <li><a href="/plugins">Plugins</a></li>
    </ul>
  </div>
  <div>
    <h6>Distribution</h6>
    <ul>
      <li><a href="/remote-agents">Remote agents</a></li>
      <li><a href="/transports">Transports</a></li>
      <li><a href="/mcp-client">MCP client</a></li>
      <li><a href="/mcp-server">MCP server</a></li>
      <li><a href="/a2a">A2A server</a></li>
      <li><a href="/a2ui">A2UI</a></li>
      <li><a href="/auth">Auth</a></li>
      <li><a href="/otel">OTel</a></li>
      <li><a href="/ag-ui">AG-UI</a></li>
    </ul>
  </div>
  <div>
    <h6>Reference</h6>
    <ul>
      <li><a href="/http-api">HTTP API</a></li>
      <li><a href="/store">Store</a></li>
      <li><a href="/glossary">Glossary</a></li>
    </ul>
  </div>
</div>
