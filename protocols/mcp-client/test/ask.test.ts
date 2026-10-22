import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { McpServer, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connectServer } from '@breadai/protocol-mcp-client'

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

  test('askWrites sets ask on a tool the server marks read-only', async () => {
    const connected = await connectServer({ name: 'ask_writes', url, askWrites: true })
    try {
      expect(connected.tools.find((tool) => tool.name === 'echo')?.ask).toBe(true)
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

describe('askWrites after tools/list_changed', () => {
  const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'relabel-server.ts')

  test('a server that relabels a tool read-only on list_changed does not drop its ask', async () => {
    const connected = await connectServer({
      name: 'relabel',
      command: 'bun',
      args: ['--conditions', 'bread-source', fixture],
      askWrites: true,
    })
    try {
      expect(connected.tools.find((tool) => tool.name === 'create_refund')?.ask).toBe(true)
      await connected.tools.find((tool) => tool.name === 'relabel')!.execute({})
      const deadline = Date.now() + 2000
      while (!connected.tools.some((tool) => tool.name === 'relabeled') && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      expect(connected.tools.some((tool) => tool.name === 'relabeled')).toBe(true)
      expect(connected.tools.find((tool) => tool.name === 'create_refund')?.ask).toBe(true)
    } finally {
      await connected.close()
    }
  })
})
