import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import type { AgentRegistry, BreadConfig } from '@breadai/core'
import { BreadError } from '@breadai/core'
import { startServer } from '@breadai/runtime-bun'
import { authPlugin } from '@breadai/server'
import { store } from '@breadai/store-memory'
import { transport } from '@breadai/transport-http-sse'
import { defineTestAgent, mockProvider, mockTextModel } from '@breadai/test-utils'

// No auth listens only on loopback and warns. Auth without authorize, authorize
// without auth on a public bind, and neither on a public bind do not listen.

function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response('') })
  const port = probe.port
  probe.stop(true)
  return port
}

function fixture(
  plugins: BreadConfig['plugins'] = [],
  server?: BreadConfig['server'],
): { config: BreadConfig; agents: AgentRegistry } {
  const config: BreadConfig = {
    entrypoints: ['greeter'],
    store: store(),
    transport: transport(),
    providers: mockProvider({ default: mockTextModel('served') }),
    plugins,
    ...(server ? { server } : {}),
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

  test('binding "localhost" warns that the loopback exemption is not a network boundary', async () => {
    warnSpy = spyOn(console, 'warn')
    const { config, agents } = fixture()
    const port = freePort()
    ;({ stop } = await startServer(config, agents, { port }))
    const messages = warnSpy.mock.calls.map((call) => String(call[0]))
    expect(messages.some((message) => message.includes('reverse proxy'))).toBe(true)
    expect(messages.some((message) => message.includes('[::1]'))).toBe(true)
  })

  test('binding "127.0.0.1" warns about the same loopback exemption', async () => {
    warnSpy = spyOn(console, 'warn')
    const { config, agents } = fixture()
    const port = freePort()
    ;({ stop } = await startServer(config, agents, { port, host: '127.0.0.1' }))
    const messages = warnSpy.mock.calls.map((call) => String(call[0]))
    expect(messages.some((message) => message.includes('reverse proxy'))).toBe(true)
  })

  test('binding "0.0.0.0" with no auth plugin throws and does not listen', async () => {
    const { config, agents } = fixture()
    const port = freePort()
    try {
      await startServer(config, agents, { port, host: '0.0.0.0' })
      throw new Error('expected startServer to throw')
    } catch (err) {
      expect(err).toBeInstanceOf(BreadError)
      expect((err as BreadError).code).toBe('AUTH_NOT_CONFIGURED')
    }
    const probe = Bun.serve({ port, fetch: () => new Response('free') })
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe('free')
    probe.stop(true)
  })

  test('middleware that is not named auth still refuses a public bind', async () => {
    const { config, agents } = fixture([{ name: 'not-auth', middleware() {} }])
    const port = freePort()
    try {
      await startServer(config, agents, { port, host: '0.0.0.0' })
      throw new Error('expected startServer to throw')
    } catch (err) {
      expect((err as BreadError).code).toBe('AUTH_NOT_CONFIGURED')
    }
  })

  test('binding "0.0.0.0" with auth and authorize does not warn', async () => {
    warnSpy = spyOn(console, 'warn')
    const { config, agents } = fixture([authPlugin([{ name: 'noop', authenticate: () => null }])], {
      authorize: () => true,
    })
    const port = freePort()
    ;({ stop } = await startServer(config, agents, { port, host: '0.0.0.0' }))
    const messages = warnSpy.mock.calls.map((call) => String(call[0]))
    expect(messages.some((message) => message.includes('reverse proxy'))).toBe(false)
  })

  test('auth without authorize throws before listen, including on loopback', async () => {
    const { config, agents } = fixture([authPlugin([{ name: 'noop', authenticate: () => null }])])
    const port = freePort()
    try {
      await startServer(config, agents, { port, host: '127.0.0.1' })
      throw new Error('expected startServer to throw')
    } catch (err) {
      expect((err as BreadError).code).toBe('AUTH_NOT_CONFIGURED')
    }
    const probe = Bun.serve({ port, hostname: '127.0.0.1', fetch: () => new Response('free') })
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe('free')
    probe.stop(true)
  })

  test('a loopback bind still serves after the warning', async () => {
    warnSpy = spyOn(console, 'warn')
    const { config, agents } = fixture()
    const port = freePort()
    ;({ stop } = await startServer(config, agents, { port, host: '127.0.0.1' }))

    const res = await fetch(`http://127.0.0.1:${port}/agents`)
    expect(res.status).toBe(200)
  })
})
