import { afterAll, describe, expect, test } from 'bun:test'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { InMemoryTransport } from '@modelcontextprotocol/server'
import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { defineTask, defineTool, type Principal } from '@breadai/core'
import { buildMcpHttpHandler, buildMcpServer } from '@breadai/protocol-mcp-server'
import { defineTestAgent, makeBread, mockScript } from '@breadai/test-utils'

const stdioPrincipal: Principal = { iss: 'https://bread.local/mcp', sub: 'stdio' }
const custom: Principal = { iss: 'https://idp.example', sub: 'user-1', tenant: 'acme' }
const spoof: Principal = { iss: 'https://evil.example', sub: 'spoof' }

function probe(seen: Array<Principal | undefined>) {
  return defineTool({
    name: 'probe',
    description: 'Record the tool principal',
    schema: z.object({
      principal: z.object({ iss: z.string(), sub: z.string() }).optional(),
    }),
    execute: async (_args, ctx) => {
      seen.push(ctx.principal)
      return { ok: true }
    },
  })
}

function noteTask(seen: Array<Principal | undefined>) {
  return defineTask({
    name: 'note',
    description: 'Record the task principal',
    model: { provider: 'mock', model: 'task' },
    instructions: 'note',
    schema: z.object({
      principal: z.object({ iss: z.string(), sub: z.string() }).optional(),
    }),
    outputSchema: z.object({ ok: z.boolean() }),
    hooks: {
      async beforeRun(ctx) {
        seen.push(ctx.principal)
        return { action: 'shortCircuit', output: { ok: true } }
      },
    },
  })
}

async function connectInMemory(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test-client', version: '0.0.0' })
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])
  return client
}

async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<void> {
  const result = await client.callTool({ name, arguments: args })
  expect(result.isError).not.toBe(true)
}

describe('mcp stdio principal', () => {
  test('stdio passes the given principal into runs, tasks, and direct tools', async () => {
    const seen: Array<Principal | undefined> = []
    const { bread, stop } = await makeBread({
      agents: { agent: defineTestAgent({ tools: [probe(seen)] }) },
      tasks: { note: noteTask(seen) },
      model: mockScript([
        { tool: 'tool_probe', args: { principal: spoof } },
        { text: 'done' },
        { tool: 'tool_probe', args: { principal: spoof } },
        { text: 'done' },
      ]),
    })
    const server = buildMcpServer(
      bread,
      {
        agents: ['agent'],
        skills: [{ agent: 'agent', skill: 'wave' }],
        tasks: ['note'],
        tools: [{ agent: 'agent', tool: 'probe' }],
      },
      custom,
    )
    const client = await connectInMemory(server)
    try {
      await callTool(client, 'agent', { input: 'go', principal: spoof })
      await callTool(client, 'agent__wave', { input: 'go', principal: spoof })
      await callTool(client, 'note', { principal: spoof })
      await callTool(client, 'agent__probe', { principal: spoof })
      expect(seen).toEqual([custom, custom, custom, custom])
    } finally {
      await client.close()
      await server.close()
      await stop()
    }
  })

  test('the stdio fallback principal reaches a direct tool and arguments do not', async () => {
    const seen: Array<Principal | undefined> = []
    const { bread, stop } = await makeBread({
      agents: { agent: defineTestAgent({ tools: [probe(seen)] }) },
      model: mockScript([{ tool: 'tool_probe', args: { principal: spoof } }, { text: 'done' }]),
    })
    const server = buildMcpServer(bread, { tools: [{ agent: 'agent', tool: 'probe' }] }, stdioPrincipal)
    const client = await connectInMemory(server)
    try {
      await callTool(client, 'agent__probe', { principal: spoof })
      expect(seen).toEqual([stdioPrincipal])
    } finally {
      await client.close()
      await server.close()
      await stop()
    }
  })

  test('omitting the principal argument leaves the tool unscoped even if expose.principal is set', async () => {
    const seen: Array<Principal | undefined> = []
    const { bread, stop } = await makeBread({
      agents: { agent: defineTestAgent({ tools: [probe(seen)] }) },
      model: mockScript([{ tool: 'tool_probe', args: { principal: spoof } }, { text: 'done' }]),
    })
    const server = buildMcpServer(bread, {
      principal: custom,
      tools: [{ agent: 'agent', tool: 'probe' }],
    })
    const client = await connectInMemory(server)
    try {
      await callTool(client, 'agent__probe', { principal: spoof })
      expect(seen).toEqual([undefined])
    } finally {
      await client.close()
      await server.close()
      await stop()
    }
  })
})

describe('mcp http principal', () => {
  let stopBread: () => Promise<void>
  let server: ReturnType<typeof Bun.serve>
  let url: URL
  const seen: Array<Principal | undefined> = []

  afterAll(async () => {
    server?.stop(true)
    await stopBread?.()
  })

  test('http ignores expose.principal and does not read tool arguments', async () => {
    const started = await makeBread({
      agents: { agent: defineTestAgent({ tools: [probe(seen)] }) },
      model: mockScript([{ tool: 'tool_probe', args: { principal: spoof } }, { text: 'done' }]),
    })
    stopBread = started.stop
    const handler = buildMcpHttpHandler(started.bread, {
      principal: custom,
      tools: [{ agent: 'agent', tool: 'probe' }],
    })
    server = Bun.serve({ port: 0, fetch: (req) => handler.fetch(req) })
    url = new URL(`http://localhost:${server.port}/mcp`)
    const client = new Client({ name: 'test-client', version: '0.0.0' })
    await client.connect(new StreamableHTTPClientTransport(url))
    try {
      const result = await client.callTool({ name: 'agent__probe', arguments: { principal: spoof } })
      expect(result.isError).not.toBe(true)
      expect(seen).toEqual([undefined])
    } finally {
      await client.close()
    }
  })
})
