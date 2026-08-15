import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { defineTestAgent, makeBread, mockScript, runCollect } from '@breadai/test-utils'
import { mcpClient } from '@breadai/protocol-mcp-client'

// A fixture MCP HTTP server that counts how many times a fresh session was
// established (one per `initialize` request), so cache-dedup can be asserted
// on real network traffic rather than inferred.
function newFixture(): McpServer {
  const fixture = new McpServer({ name: 'fixture', version: '0.0.0' })
  fixture.registerTool(
    'ping',
    { description: 'ping', inputSchema: {} },
    async () => ({ content: [{ type: 'text', text: 'pong' }] }),
  )
  return fixture
}

function fixtureHttpServer(): { url: () => string; initializeCount: () => number; stop: () => void } {
  let initializeCount = 0
  const httpServer = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const body = req.method === 'POST' ? await req.clone().json().catch(() => null) : null
      if (body?.method === 'initialize') initializeCount++
      // Stateless: a fresh McpServer + transport per request — an McpServer
      // can only ever be connect()ed once.
      const transport = new WebStandardStreamableHTTPServerTransport()
      await newFixture().connect(transport)
      return transport.handleRequest(req, body !== null ? { parsedBody: body } : undefined)
    },
  })
  return {
    url: () => `http://localhost:${httpServer.port}/mcp`,
    initializeCount: () => initializeCount,
    stop: () => httpServer.stop(true),
  }
}

describe('mcp_client — config-level named servers', () => {
  let fixture: ReturnType<typeof fixtureHttpServer>

  beforeAll(() => {
    fixture = fixtureHttpServer()
  })

  afterAll(() => {
    fixture.stop()
  })

  test('an agent naming a configured server gets its tools', async () => {
    const { bread, stop } = await makeBread({
      agents: {
        a: defineTestAgent({
          config: { plugins: { mcp_client: { servers: ['fixture'] } } },
        }),
      },
      plugins: [mcpClient({ servers: [{ name: 'fixture', url: fixture.url() }] })],
      model: mockScript([{ tool: 'plugin_mcp_client_fixture__ping', args: {} }, { text: 'done' }]),
    })
    try {
      const crumbs = await runCollect(bread, 'a', 'go')
      const result = crumbs.find((c) => c.type === 'tool:result')
      expect(result).toBeDefined()
      expect((result as { result?: unknown }).result).toBe('pong')
    } finally {
      await stop()
    }
  })

  test('naming an unconfigured server fails with an actionable error', async () => {
    const plugin = mcpClient() // no servers configured at all
    await plugin.init?.({ on: () => {}, off: () => {} } as never)
    expect(
      plugin.resolveAgentTools!('a', {
        plugins: { mcp_client: { servers: ['ghost'] } },
      } as never),
    ).rejects.toThrow(/server "ghost" is not configured/)
    await plugin.close?.()
  })
})

describe('mcp_client — cfg.plugins.mcp_client.external', () => {
  let fixture: ReturnType<typeof fixtureHttpServer>

  beforeAll(() => {
    fixture = fixtureHttpServer()
  })

  afterAll(() => {
    fixture.stop()
  })

  test('an agent can call a tool from an inline external server', async () => {
    const { bread, stop } = await makeBread({
      agents: {
        a: defineTestAgent({
          config: { plugins: { mcp_client: { external: [{ name: 'srv', url: fixture.url() }] } } },
        }),
      },
      plugins: [mcpClient()],
      model: mockScript([{ tool: 'plugin_mcp_client_srv__ping', args: {} }, { text: 'done' }]),
    })
    try {
      const crumbs = await runCollect(bread, 'a', 'go')
      const result = crumbs.find((c) => c.type === 'tool:result')
      expect(result).toBeDefined()
    } finally {
      await stop()
    }
  })

  test('external server headers are forwarded to every request against the fixture', async () => {
    let seenHeader: string | null = null
    const httpServer = Bun.serve({
      port: 0,
      fetch: async (req) => {
        seenHeader ??= req.headers.get('x-api-key')
        const transport = new WebStandardStreamableHTTPServerTransport()
        await newFixture().connect(transport)
        return transport.handleRequest(req)
      },
    })
    try {
      const { bread, stop } = await makeBread({
        agents: {
          a: defineTestAgent({
            config: {
              plugins: {
                mcp_client: {
                  external: [
                    {
                      name: 'headered',
                      url: `http://localhost:${httpServer.port}/mcp`,
                      headers: { 'x-api-key': 'secret' },
                    },
                  ],
                },
              },
            },
          }),
        },
        plugins: [mcpClient()],
        model: mockScript([{ tool: 'plugin_mcp_client_headered__ping', args: {} }, { text: 'done' }]),
      })
      try {
        const crumbs = await runCollect(bread, 'a', 'go')
        expect(crumbs.map((c) => c.type)).toContain('tool:result')
        expect(seenHeader).toBe('secret')
      } finally {
        await stop()
      }
    } finally {
      httpServer.stop(true)
    }
  })

  test('two agents referencing the identical {name,url} share one connection', async () => {
    const before = fixture.initializeCount()
    const { bread, stop } = await makeBread({
      agents: {
        a: defineTestAgent({
          config: { plugins: { mcp_client: { external: [{ name: 'shared', url: fixture.url() }] } } },
        }),
        b: defineTestAgent({
          config: { plugins: { mcp_client: { external: [{ name: 'shared', url: fixture.url() }] } } },
        }),
      },
      plugins: [mcpClient()],
      model: mockScript([{ tool: 'plugin_mcp_client_shared__ping', args: {} }, { text: 'done' }]),
    })
    try {
      await runCollect(bread, 'a', 'go')
      const afterFirst = fixture.initializeCount()
      expect(afterFirst).toBe(before + 1)

      await runCollect(bread, 'b', 'go')
      const afterSecond = fixture.initializeCount()
      expect(afterSecond).toBe(afterFirst) // no new initialize — cache hit
    } finally {
      await stop()
    }
  })

  test('a failed connect does not permanently poison the cache — a later retry can succeed', async () => {
    // Grab a free port, then release it immediately so nothing is listening.
    const probe = Bun.serve({ port: 0, fetch: () => new Response('') })
    const port = probe.port
    probe.stop(true)

    const url = `http://localhost:${port}/mcp`
    const { bread, stop } = await makeBread({
      agents: {
        a: defineTestAgent({
          config: { plugins: { mcp_client: { external: [{ name: 'flaky', url }] } } },
        }),
      },
      plugins: [mcpClient()],
      model: mockScript([{ tool: 'plugin_mcp_client_flaky__ping', args: {} }, { text: 'done' }]),
    })
    try {
      await expect(runCollect(bread, 'a', 'go')).rejects.toThrow()

      // Now actually serve on that exact port and retry the same agent.
      const server2 = Bun.serve({
        port,
        fetch: async (req) => {
          const transport = new WebStandardStreamableHTTPServerTransport()
          await newFixture().connect(transport)
          return transport.handleRequest(req)
        },
      })
      try {
        const crumbs = await runCollect(bread, 'a', 'go')
        expect(crumbs.map((c) => c.type)).toContain('tool:result')
      } finally {
        server2.stop(true)
      }
    } finally {
      await stop()
    }
  })
})
