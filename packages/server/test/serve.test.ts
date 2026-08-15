import { afterEach, describe, expect, test } from 'bun:test'
import type { AgentRegistry, BreadConfig } from '@bread/core'
import { startServer } from '@bread/server'
import { store } from '@bread/store-memory'
import { transport } from '@bread/transport-http-sse'
import { defineTestAgent, mockProvider, mockTextModel } from '@bread/test-utils'

// Smoke tests for the port-binding path (`bread dev`/`bread start` both call
// startServer, which binds via Bun.serve).

function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response('') })
  const port = probe.port
  probe.stop(true)
  return port
}

function fixture(): { config: BreadConfig; agents: AgentRegistry } {
  const config: BreadConfig = {
    entrypoints: ['greeter'],
    store: store(),
    transport: transport(),
    providers: mockProvider({ default: mockTextModel('served') }),
  }
  const agents: AgentRegistry = new Map([['greeter', defineTestAgent()]])
  return { config, agents }
}

describe('startServer', () => {
  let stop: (() => Promise<void>) | undefined

  afterEach(async () => {
    await stop?.()
    stop = undefined
  })

  test('binds a real port and serves the HTTP API', async () => {
    const { config, agents } = fixture()
    const port = freePort()
    ;({ stop } = await startServer(config, agents, { port }))

    const res = await fetch(`http://localhost:${port}/agents`)
    expect(res.status).toBe(200)
    expect(((await res.json()) as Array<{ id: string }>).map((a) => a.id)).toEqual(['greeter'])
  })

  test('serves end to end', async () => {
    const { config, agents } = fixture()
    const port = freePort()
    ;({ stop } = await startServer(config, agents, { port }))

    const res = await fetch(`http://localhost:${port}/agents/greeter/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'hi' }),
    })
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    expect(await res.text()).toContain('served')
  })

  test('config.server.port is honoured when no port override is passed', async () => {
    const { config, agents } = fixture()
    const port = freePort()
    config.server = { port }
    ;({ stop } = await startServer(config, agents))

    const res = await fetch(`http://localhost:${port}/agents`)
    expect(res.status).toBe(200)
  })

  test('an explicit port override beats config.server.port', async () => {
    const { config, agents } = fixture()
    const configPort = freePort()
    const flagPort = freePort()
    config.server = { port: configPort }
    ;({ stop } = await startServer(config, agents, { port: flagPort }))

    const res = await fetch(`http://localhost:${flagPort}/agents`)
    expect(res.status).toBe(200)
  })

  test('stop() releases the port for reuse', async () => {
    const { config, agents } = fixture()
    const port = freePort()
    const first = await startServer(config, agents, { port })
    await first.stop()

    // Rebinding the same port only works if stop() actually closed the server.
    ;({ stop } = await startServer(fixture().config, fixture().agents, { port }))
    const res = await fetch(`http://localhost:${port}/agents`)
    expect(res.status).toBe(200)
  })
})
