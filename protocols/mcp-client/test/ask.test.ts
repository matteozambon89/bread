import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { McpServer, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { connectServer, mcpToolNeedsAsk } from '@breadai/protocol-mcp-client'

describe('mcpToolNeedsAsk', () => {
  test('missing annotations ask', () => {
    expect(mcpToolNeedsAsk(undefined)).toBe(true)
    expect(mcpToolNeedsAsk(null)).toBe(true)
  })

  test('destructiveHint true asks', () => {
    expect(mcpToolNeedsAsk({ destructiveHint: true })).toBe(true)
  })

  test('destructiveHint true asks even when readOnlyHint is true', () => {
    expect(mcpToolNeedsAsk({ readOnlyHint: true, destructiveHint: true })).toBe(true)
  })

  test('readOnlyHint true does not ask when destructiveHint is not true', () => {
    expect(mcpToolNeedsAsk({ readOnlyHint: true })).toBe(false)
    expect(mcpToolNeedsAsk({ readOnlyHint: true, destructiveHint: false })).toBe(false)
  })

  test('annotations that are neither read-only nor destructive ask', () => {
    expect(mcpToolNeedsAsk({})).toBe(true)
    expect(mcpToolNeedsAsk({ readOnlyHint: false, destructiveHint: false })).toBe(true)
  })
})

describe('askWrites', () => {
  let httpServer: ReturnType<typeof Bun.serve>
  let url: string

  function fixture(): McpServer {
    const server = new McpServer({ name: 'ask-fixture', version: '0.0.0' })
    server.registerTool(
      'echo',
      { description: 'echo', inputSchema: z.object({}), annotations: { readOnlyHint: true } },
      async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    )
    server.registerTool(
      'remove',
      { description: 'remove', inputSchema: z.object({}), annotations: { destructiveHint: true } },
      async () => ({ content: [{ type: 'text', text: 'gone' }] }),
    )
    server.registerTool(
      'plain',
      { description: 'plain', inputSchema: z.object({}) },
      async () => ({ content: [{ type: 'text', text: 'plain' }] }),
    )
    return server
  }

  beforeAll(() => {
    httpServer = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const transport = new WebStandardStreamableHTTPServerTransport()
        await fixture().connect(transport)
        return transport.handleRequest(req)
      },
    })
    url = `http://localhost:${httpServer.port}/mcp`
  })

  afterAll(() => {
    httpServer.stop(true)
  })

  test('askWrites sets ask on a destructive tool', async () => {
    const connected = await connectServer({ name: 'ask_writes', url, askWrites: true })
    try {
      expect(connected.tools.find((tool) => tool.name === 'remove')?.ask).toBe(true)
    } finally {
      await connected.close()
    }
  })

  test('askWrites does not set ask on a read-only tool', async () => {
    const connected = await connectServer({ name: 'ask_writes', url, askWrites: true })
    try {
      expect(connected.tools.find((tool) => tool.name === 'echo')?.ask).toBeUndefined()
    } finally {
      await connected.close()
    }
  })

  test('askWrites sets ask when annotations are missing', async () => {
    const connected = await connectServer({ name: 'ask_writes', url, askWrites: true })
    try {
      expect(connected.tools.find((tool) => tool.name === 'plain')?.ask).toBe(true)
    } finally {
      await connected.close()
    }
  })

  test('a server without askWrites never sets ask', async () => {
    const connected = await connectServer({ name: 'no_ask', url })
    try {
      expect(connected.tools.every((tool) => tool.ask === undefined)).toBe(true)
    } finally {
      await connected.close()
    }
  })
})
