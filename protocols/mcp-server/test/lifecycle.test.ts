import { describe, expect, test } from 'bun:test'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { defineTestAgent, makeServer, mockTextModel } from '@breadai/test-utils'
import { mcpServer } from '@breadai/protocol-mcp-server'

// mcpServer()'s HTTP handler is genuinely stateful now — unlike v1's disposable
// per-request transport, it can hold an open subscriptions/listen stream, and
// must be closed on bread.stop() or that stream leaks. This proves close()
// actually tears one down, not just that bread.stop() doesn't throw.
describe('mcp_server plugin — close() tears down an open subscriptions/listen stream', () => {
  test('a modern-era subscription closes when bread.stop() runs', async () => {
    const { app, stop } = await makeServer({
      agents: { greeter: defineTestAgent() },
      model: mockTextModel('ok'),
      plugins: [mcpServer({ transport: 'http', agents: ['greeter'] })],
    })
    const server = Bun.serve({ port: 0, fetch: app.fetch })
    const url = new URL(`http://localhost:${server.port}/mcp`)

    try {
      const client = new Client(
        { name: 'test-client', version: '0.0.0' },
        { versionNegotiation: { mode: { pin: '2026-07-28' } } },
      )
      await client.connect(new StreamableHTTPClientTransport(url))
      const subscription = await client.listen({ toolsListChanged: true })

      await stop() // → mcpServer plugin's close() → httpHandler.close()

      // The handler ends an open stream by sending the spec's graceful-close
      // response, not by dropping the connection — 'remote' would mean it
      // vanished unnoticed instead, 'local' would mean we closed it ourselves.
      expect(await subscription.closed).toBe('graceful')
    } finally {
      server.stop(true)
    }
  }, 5000)
})
