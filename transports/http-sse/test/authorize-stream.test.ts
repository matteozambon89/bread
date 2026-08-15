import { afterEach, describe, expect, test } from 'bun:test'
import type { AgentRegistry, AuthIdentity, BreadAuthStrategy, BreadConfig } from '@breadai/core'
import { authPlugin, startServer } from '@breadai/server'
import { store } from '@breadai/store-memory'
import { defineTestAgent, mockProvider, mockTextModel, readSse } from '@breadai/test-utils'
import { transport } from '@breadai/transport-http-sse'

// SEC-03: GET /runs/:runId/stream must respect an opt-in authorizeStream hook.
// Real Bun.serve() + authPlugin() round trip — not a unit call into the
// hook itself — proving the identity authMiddleware stashes actually reaches
// the hook and a 403 lands before any crumb is streamed.

function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response('') })
  const port = probe.port
  probe.stop(true)
  return port
}

// Trusts a plain `x-identity` header as the caller's subject — good enough
// for a test double, never a real auth strategy.
const headerStrategy: BreadAuthStrategy = {
  name: 'header',
  authenticate(req: Request): AuthIdentity | null {
    const subject = req.headers.get('x-identity')
    return subject ? { subject } : null
  },
}

function fixture(): { config: BreadConfig; agents: AgentRegistry } {
  const config: BreadConfig = {
    entrypoints: ['assistant'],
    store: store(),
    plugins: [authPlugin([headerStrategy])],
    transport: transport({ authorizeStream: (identity) => identity?.subject === 'alice' }),
    providers: mockProvider({ default: mockTextModel('hi') }),
  }
  const agents: AgentRegistry = new Map([['assistant', defineTestAgent()]])
  return { config, agents }
}

async function runAsAlice(url: string): Promise<string> {
  const res = await fetch(`${url}/agents/assistant/run`, {
    method: 'POST',
    headers: { 'x-identity': 'alice' },
    body: '{}',
  })
  const events = await readSse(res)
  const start = events.find((e) => e.type === 'agent:run:start')
  return (start?.payload as { runId?: string } | undefined)?.runId ?? ''
}

describe('@breadai/transport-http-sse — GET /runs/:runId/stream authorizeStream', () => {
  let stops: Array<() => Promise<void>> = []

  afterEach(async () => {
    await Promise.all(stops.map((s) => s()))
    stops = []
  })

  test('a caller the hook denies gets 403 before any crumb is read', async () => {
    const { config, agents } = fixture()
    const port = freePort()
    const server = await startServer(config, agents, { port })
    stops.push(server.stop)
    const url = `http://localhost:${port}`

    const runId = await runAsAlice(url)
    expect(runId).not.toBe('')

    const res = await fetch(`${url}/runs/${runId}/stream`, { headers: { 'x-identity': 'bob' } })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Forbidden' })
  })

  test('the owning caller still streams normally', async () => {
    const { config, agents } = fixture()
    const port = freePort()
    const server = await startServer(config, agents, { port })
    stops.push(server.stop)
    const url = `http://localhost:${port}`

    const runId = await runAsAlice(url)

    const res = await fetch(`${url}/runs/${runId}/stream`, { headers: { 'x-identity': 'alice' } })
    expect(res.status).toBe(200)
    const events = await readSse(res)
    expect(events.some((e) => e.type === 'agent:run:start')).toBe(true)
    expect(events.some((e) => e.type === 'agent:run:end')).toBe(true)
  })
})
