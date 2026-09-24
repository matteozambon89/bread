import { afterEach, describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AgentRegistry, BreadConfig } from '@breadai/core'
import { startServerNode } from '@breadai/runtime-node'
import { store } from '@breadai/store-memory'
import { transport } from '@breadai/transport-http-sse'
import { defineTestAgent, mockProvider, mockTextModel } from '@breadai/test-utils'

// Smoke tests for the Node listen path. Production src has zero bun:* imports;
// bun:test here is fine for the monorepo runner.

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address()
      if (!addr || typeof addr === 'string') {
        probe.close()
        reject(new Error('expected TCP address'))
        return
      }
      const { port } = addr
      probe.close((err) => (err ? reject(err) : resolve(port)))
    })
  })
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

describe('startServerNode', () => {
  test('src has no bun: imports (Node publish graph)', () => {
    const srcDir = join(dirname(fileURLToPath(import.meta.url)), '../src')
    for (const name of readdirSync(srcDir)) {
      if (!name.endsWith('.ts')) continue
      const text = readFileSync(join(srcDir, name), 'utf8')
      expect(text).not.toMatch(/from ['"]bun:|import\(['"]bun:/)
    }
  })

  let stop: (() => Promise<void>) | undefined

  afterEach(async () => {
    await stop?.()
    stop = undefined
  })

  test('binds a real port and serves the HTTP API', async () => {
    const { config, agents } = fixture()
    const port = await freePort()
    ;({ stop } = await startServerNode(config, agents, { port, host: '127.0.0.1' }))

    const res = await fetch(`http://127.0.0.1:${port}/agents`)
    expect(res.status).toBe(200)
    expect(((await res.json()) as Array<{ id: string }>).map((a) => a.id)).toEqual(['greeter'])
  })

  test('config.server.port is honoured when no port override is passed', async () => {
    const { config, agents } = fixture()
    const port = await freePort()
    config.server = { port, host: '127.0.0.1' }
    ;({ stop } = await startServerNode(config, agents))

    const res = await fetch(`http://127.0.0.1:${port}/agents`)
    expect(res.status).toBe(200)
  })

  test('an explicit port override beats config.server.port', async () => {
    const { config, agents } = fixture()
    const configPort = await freePort()
    const flagPort = await freePort()
    config.server = { port: configPort, host: '127.0.0.1' }
    ;({ stop } = await startServerNode(config, agents, { port: flagPort, host: '127.0.0.1' }))

    const res = await fetch(`http://127.0.0.1:${flagPort}/agents`)
    expect(res.status).toBe(200)
  })

  test('stop() releases the port for reuse', async () => {
    const { config, agents } = fixture()
    const port = await freePort()
    const first = await startServerNode(config, agents, { port, host: '127.0.0.1' })
    await first.stop()

    ;({ stop } = await startServerNode(fixture().config, fixture().agents, {
      port,
      host: '127.0.0.1',
    }))
    const res = await fetch(`http://127.0.0.1:${port}/agents`)
    expect(res.status).toBe(200)
  })

  test('bind failure stops bread and throws', async () => {
    const { config, agents } = fixture()
    const port = await freePort()
    const first = await startServerNode(config, agents, { port, host: '127.0.0.1' })
    stop = first.stop

    await expect(
      startServerNode(fixture().config, fixture().agents, { port, host: '127.0.0.1' }),
    ).rejects.toMatchObject({ code: 'EADDRINUSE' })
  })

  test('stop() closes an open run stream and the port can be rebound', async () => {
    const { config, agents } = fixture()
    const port = await freePort()
    const first = await startServerNode(config, agents, { port, host: '127.0.0.1' })

    const res = await fetch(`http://127.0.0.1:${port}/runs/not-a-run/stream`)
    expect(res.status).toBe(200)
    const pendingRead = res.body?.getReader().read().catch(() => undefined)

    const stopResult = await Promise.race([
      first.stop().then(() => 'stopped' as const),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 1000)),
    ])
    expect(stopResult).toBe('stopped')
    await pendingRead

    ;({ stop } = await startServerNode(fixture().config, fixture().agents, {
      port,
      host: '127.0.0.1',
    }))
    const again = await fetch(`http://127.0.0.1:${port}/agents`)
    expect(again.status).toBe(200)
  })

  // Guards the bun-test monorepo: @hono/node-server must not replace
  // globalThis.Response, or later Bun.serve / MCP / transport files fail with
  // CLIENT_HTTP_UNEXPECTED_CONTENT (text/plain lightweight Response).
  test('does not replace globalThis.Response after listen', async () => {
    const Original = globalThis.Response
    const { config, agents } = fixture()
    const port = await freePort()
    ;({ stop } = await startServerNode(config, agents, { port, host: '127.0.0.1' }))
    expect(globalThis.Response).toBe(Original)
    const res = await fetch(`http://127.0.0.1:${port}/agents`)
    expect(res).toBeInstanceOf(Original)
    expect(res.status).toBe(200)
  })
})
