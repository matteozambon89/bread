import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import type { BreadSigner, ToolDefinition } from '@bread/core'
import { BreadError } from '@bread/core'
import { connectServer, mcpClient, sanitizeMcpToolName } from '@bread/protocol-mcp-client'

const here = dirname(fileURLToPath(import.meta.url))
const fixtureServer = join(here, 'fixtures', 'mcp-server.ts')

describe('connectServer — transport validation', () => {
  test('throws when an http transport is configured without a url', () => {
    expect(connectServer({ name: 'x', transport: 'http' })).rejects.toThrow(/requires a url/)
  })

  test('throws when a stdio transport is configured without a command', () => {
    expect(connectServer({ name: 'x' })).rejects.toThrow(/requires a command/)
  })
})

describe('connectServer — stdio transport', () => {
  let server: Awaited<ReturnType<typeof connectServer>>

  beforeAll(async () => {
    server = await connectServer({
      name: 'fixture',
      command: 'bun',
      args: ['--conditions', 'bread-source', fixtureServer],
    })
  })

  afterAll(() => server.close())

  function tool(name: string): ToolDefinition {
    const t = server.tools.find((t) => t.name === name)
    if (!t) throw new Error(`fixture tool "${name}" not found among ${server.tools.map((t) => t.name)}`)
    return t
  }

  test('translates the remote tools into bread tool definitions', () => {
    expect(server.tools.map((t) => t.name).sort()).toEqual([
      'add_bonus_tool',
      'boom',
      'echo',
      'list_files',
      'multi',
      'read_file',
    ])
  })

  test('a sanitized tool still calls the server under its original name', async () => {
    expect(await tool('list_files').execute({})).toBe('a.txt')
    expect(await tool('read_file').execute({})).toBe('contents')
  })

  test('a renamed tool notes the original server name in its description', () => {
    expect(tool('list_files').description).toContain('server tool "list-files"')
    expect(tool('echo').description).not.toContain('server tool')
  })

  test('a single text result is flattened to the string', async () => {
    expect(await tool('echo').execute({ msg: 'pong' })).toBe('pong')
  })

  test('multiple text results are joined with newlines', async () => {
    expect(await tool('multi').execute({})).toBe('line one\nline two')
  })

  test('an error result is surfaced as an { error } object', async () => {
    expect(await tool('boom').execute({})).toEqual({ error: 'it failed' })
  })

  // Last in this describe block — it mutates the fixture's live tool set, so
  // every read-only assertion above must run against the original five tools.
  test('a real tools/list_changed notification refreshes server.tools live', async () => {
    expect(server.tools.map((t) => t.name)).not.toContain('bonus')

    await tool('add_bonus_tool').execute({})

    const deadline = Date.now() + 2000
    while (!server.tools.some((t) => t.name === 'bonus') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }

    expect(server.tools.map((t) => t.name)).toContain('bonus')
    expect(await tool('bonus').execute({})).toBe('surprise')
  })
})

describe('sanitizeMcpToolName', () => {
  test.each([
    ['list-files', 'list_files'],
    ['readFile', 'read_file'],
    ['fs.read', 'fs_read'],
    ['Do It Now!', 'do_it_now'],
    ['9lives', 't_9lives'],
    ['already_fine', 'already_fine'],
  ])('%s → %s', (original, expected) => {
    expect(sanitizeMcpToolName(original)).toBe(expected)
  })
})

describe('connectServer — colliding sanitized names fail loudly', () => {
  let httpServer: ReturnType<typeof Bun.serve>
  let url: string

  beforeAll(() => {
    httpServer = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const fixture = new McpServer({ name: 'clashing', version: '0.0.0' })
        // Distinct on the server, identical once sanitized.
        for (const name of ['list-files', 'list_files']) {
          fixture.registerTool(
            name,
            { description: name, inputSchema: {} },
            async () => ({ content: [{ type: 'text', text: name }] }),
          )
        }
        const transport = new WebStandardStreamableHTTPServerTransport()
        await fixture.connect(transport)
        return transport.handleRequest(req)
      },
    })
    url = `http://localhost:${httpServer.port}/mcp`
  })

  afterAll(() => {
    httpServer.stop(true)
  })

  test('rejects with TOOL_NAME_COLLISION naming both originals', async () => {
    try {
      await connectServer({ name: 'clashing', url })
      throw new Error('expected connectServer to reject')
    } catch (err) {
      expect(err).toBeInstanceOf(BreadError)
      expect((err as BreadError).code).toBe('TOOL_NAME_COLLISION')
      expect((err as BreadError).message).toContain('list-files')
      expect((err as BreadError).message).toContain('list_files')
    }
  })
})

describe('connectServer — http transport signs outgoing requests', () => {
  let httpServer: ReturnType<typeof Bun.serve>
  let url: string
  let seenHeader: string | null = null

  const signing: BreadSigner = {
    name: 'stub',
    sign(headers) {
      headers.set('x-signed', 'signed-value')
    },
  }

  function newFixture(): McpServer {
    // Hand-rolled fixture MCP server (not @bread/protocol-mcp-server) — this test
    // exercises the client package, which must not depend on the server one.
    const fixture = new McpServer({ name: 'fixture', version: '0.0.0' })
    fixture.registerTool(
      'ping',
      { description: 'ping', inputSchema: {} },
      async () => ({ content: [{ type: 'text', text: 'pong' }] }),
    )
    return fixture
  }

  beforeAll(() => {
    httpServer = Bun.serve({
      port: 0,
      fetch: async (req) => {
        seenHeader ??= req.headers.get('x-signed')
        // Stateless: a fresh McpServer + transport per request — an McpServer
        // can only ever be connect()ed once.
        const transport = new WebStandardStreamableHTTPServerTransport()
        await newFixture().connect(transport)
        return transport.handleRequest(req)
      },
    })
    url = `http://localhost:${httpServer.port}/mcp`
  })

  afterAll(() => {
    httpServer.stop(true)
  })

  test('forwards the signer headers to the MCP server', async () => {
    const connected = await connectServer({ name: 'remote', url, signer: signing })
    await connected.close()
    expect(seenHeader).toBe('signed-value')
    expect(connected.tools.map((t) => t.name)).toContain('ping')
  })
})

describe('connectServer — signs per request, not once at connect', () => {
  let httpServer: ReturnType<typeof Bun.serve>
  let url: string
  const seenSignatures: string[] = []

  // A strategy whose signature changes every call — a stand-in for oauth2's
  // expiring token. If signing were frozen at connect, every request after the
  // first would carry the same (stale) value.
  let signCount = 0
  const rotating: BreadSigner = {
    name: 'rotating',
    sign(headers) {
      headers.set('x-signed', `sig-${++signCount}`)
    },
  }

  beforeAll(() => {
    httpServer = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const sig = req.headers.get('x-signed')
        if (sig) seenSignatures.push(sig)
        const transport = new WebStandardStreamableHTTPServerTransport()
        await newFixtureLike().connect(transport)
        return transport.handleRequest(req)
      },
    })
    url = `http://localhost:${httpServer.port}/mcp`
  })

  afterAll(() => {
    httpServer.stop(true)
  })

  function newFixtureLike(): McpServer {
    const fixture = new McpServer({ name: 'rotating-fixture', version: '0.0.0' })
    fixture.registerTool(
      'ping',
      { description: 'ping', inputSchema: {} },
      async () => ({ content: [{ type: 'text', text: 'pong' }] }),
    )
    return fixture
  }

  test('a tool call after connect carries a fresh signature', async () => {
    const connected = await connectServer({ name: 'rotating', url, signer: rotating })
    const ping = connected.tools.find((t) => t.name === 'ping')!
    expect(await ping.execute({})).toBe('pong')
    await connected.close()

    // connect (initialize + tools/list) and the tool call each re-signed.
    expect(seenSignatures.length).toBeGreaterThanOrEqual(3)
    expect(new Set(seenSignatures).size).toBe(seenSignatures.length)
    expect(seenSignatures.at(-1)).not.toBe(seenSignatures[0])
  })
})

describe('connectServer — falls back to legacy SSE when Streamable HTTP is unsupported', () => {
  let httpServer: Server
  let url: string

  beforeAll(async () => {
    const fixture = new McpServer({ name: 'legacy-fixture', version: '0.0.0' })
    fixture.registerTool(
      'ping',
      { description: 'ping', inputSchema: {} },
      async () => ({ content: [{ type: 'text', text: 'pong' }] }),
    )

    let transport: SSEServerTransport | null = null

    httpServer = createServer(async (req, res) => {
      if (req.method === 'GET' && req.url === '/mcp') {
        transport = new SSEServerTransport('/mcp/messages', res)
        await fixture.connect(transport)
        return
      }
      if (req.method === 'POST' && req.url?.startsWith('/mcp/messages')) {
        if (!transport) {
          res.writeHead(400)
          res.end()
          return
        }
        await transport.handlePostMessage(req, res)
        return
      }
      // Anything else — notably a bare POST /mcp, which is what
      // StreamableHTTPClientTransport tries first — looks unsupported.
      res.writeHead(404)
      res.end()
    })

    await new Promise<void>((resolve) => httpServer.listen(0, resolve))
    const address = httpServer.address()
    const port = typeof address === 'object' && address ? address.port : 0
    url = `http://localhost:${port}/mcp`
  })

  afterAll(() => {
    httpServer.close()
  })

  test('connects via SSE after Streamable HTTP is rejected, and lists tools', async () => {
    const connected = await connectServer({ name: 'legacy', url })
    expect(connected.tools.map((t) => t.name)).toContain('ping')
    expect(await connected.tools[0]!.execute({})).toBe('pong')
    await connected.close()
  })
})

describe('mcpClient plugin — close()', () => {
  test('closes every config-level server started at init(), cleanly', async () => {
    const httpServer = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const fixture = new McpServer({ name: 'closing-fixture', version: '0.0.0' })
        fixture.registerTool(
          'ping',
          { description: 'ping', inputSchema: {} },
          async () => ({ content: [{ type: 'text', text: 'pong' }] }),
        )
        const transport = new WebStandardStreamableHTTPServerTransport()
        await fixture.connect(transport)
        return transport.handleRequest(req)
      },
    })
    try {
      const url = `http://localhost:${httpServer.port}/mcp`
      const plugin = mcpClient({ servers: [{ name: 'closing', url }] })
      await plugin.init?.({ on: () => {}, off: () => {} } as never)
      await expect(plugin.close?.()).resolves.toBeUndefined()
    } finally {
      httpServer.stop(true)
    }
  })
})
