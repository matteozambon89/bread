import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import type { AgentRegistry, BreadConfig } from '@bread/core'
import { authPlugin, startServer } from '@bread/server'
import { store } from '@bread/store-memory'
import { transport } from '@bread/transport-http-sse'
import { defineTestAgent, mockProvider, mockTextModel } from '@bread/test-utils'

// Reversal of the 2026-07-05 "consumer's job, not the framework's" decision,
// narrowed to a warning (not a gate): binding non-loopback with zero plugin
// middleware registered prints a loud, impossible-to-miss console.warn. It
// can't know whether any middleware present actually *is* an auth check —
// only that at least one plugin hooked in — so it stays a floor, not a
// guarantee, and never blocks startup either way.

function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response('') })
  const port = probe.port
  probe.stop(true)
  return port
}

function fixture(plugins: BreadConfig['plugins'] = []): { config: BreadConfig; agents: AgentRegistry } {
  const config: BreadConfig = {
    entrypoints: ['greeter'],
    store: store(),
    transport: transport(),
    providers: mockProvider({ default: mockTextModel('served') }),
    plugins,
  }
  const agents: AgentRegistry = new Map([['greeter', defineTestAgent()]])
  return { config, agents }
}

describe('startServer — non-loopback bind warning', () => {
  let stop: (() => Promise<void>) | undefined
  let warnSpy: ReturnType<typeof spyOn> | undefined

  afterEach(async () => {
    await stop?.()
    stop = undefined
    warnSpy?.mockRestore()
    warnSpy = undefined
  })

  test('binding "localhost" (the default) never warns', async () => {
    warnSpy = spyOn(console, 'warn')
    const { config, agents } = fixture()
    const port = freePort()
    ;({ stop } = await startServer(config, agents, { port }))
    expect(warnSpy).not.toHaveBeenCalled()
  })

  test('binding "127.0.0.1" never warns', async () => {
    warnSpy = spyOn(console, 'warn')
    const { config, agents } = fixture()
    const port = freePort()
    ;({ stop } = await startServer(config, agents, { port, host: '127.0.0.1' }))
    expect(warnSpy).not.toHaveBeenCalled()
  })

  test('binding "0.0.0.0" with no plugin middleware warns loudly', async () => {
    warnSpy = spyOn(console, 'warn')
    const { config, agents } = fixture()
    const port = freePort()
    ;({ stop } = await startServer(config, agents, { port, host: '0.0.0.0' }))
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const message = warnSpy.mock.calls[0]?.[0] as string
    expect(message).toContain('WARNING')
    expect(message).toContain('0.0.0.0')
  })

  test('binding "0.0.0.0" with a middleware-registering plugin does not warn', async () => {
    warnSpy = spyOn(console, 'warn')
    const { config, agents } = fixture([authPlugin([{ name: 'noop', authenticate: () => null }])])
    const port = freePort()
    ;({ stop } = await startServer(config, agents, { port, host: '0.0.0.0' }))
    expect(warnSpy).not.toHaveBeenCalled()
  })

  test('the warning never blocks startup — the server still serves', async () => {
    warnSpy = spyOn(console, 'warn')
    const { config, agents } = fixture()
    const port = freePort()
    ;({ stop } = await startServer(config, agents, { port, host: '0.0.0.0' }))

    const res = await fetch(`http://localhost:${port}/agents`)
    expect(res.status).toBe(200)
  })
})
