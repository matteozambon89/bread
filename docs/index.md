---
layout: home

hero:
  name: bread
  text: Explicit by design.
  tagline: A file-system-convention framework for building, running, and observing AI agents on top of the Vercel AI SDK — no silent defaults, you pick the store, the transport, and the providers yourself.
  image:
    light: /mark-light-512.png
    dark: /mark-dark-512.png
    alt: bread
  actions:
    - theme: brand
      text: Get Started
      link: /architecture
    - theme: alt
      text: View on GitHub
      link: https://github.com/matteozambon89/bread

features:
  - title: Sessions
    details: Multi-turn conversations with pluggable, durable storage — Postgres, SQLite, or in-memory.
    link: /sessions
  - title: Human-in-the-loop
    details: Suspend a run for approval or input, then resume it — restart-safe and cross-process.
    link: /hitl
  - title: Pipelines & supervisors
    details: Compose agents into deterministic pipelines or let an LLM supervisor delegate work at runtime.
    link: /pipelines
  - title: Skills & tools
    details: Agent-driven skills and typed tools, auto-loaded by filesystem convention from each agent's folder.
    link: /skills
  - title: Transports
    details: Stream agent work as structured "crumb" events over HTTP (SSE or NDJSON), Redis, or the terminal.
    link: /transports
  - title: Protocols
    details: Expose or consume agents over MCP, A2A, and AG-UI — interoperate with the wider agent ecosystem.
    link: /mcp-server
---
