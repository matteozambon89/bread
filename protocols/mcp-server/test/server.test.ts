import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { z } from 'zod'
import { type BreadInstance, type BreadPlugin, defineTask, defineTool } from '@breadai/core'
import { defineTestAgent, makeBread, memoryBlobStore, mockObjectModel, mockTextModel } from '@breadai/test-utils'
import { buildMcpServer, handleHttpRequest } from '@breadai/protocol-mcp-server'

// Exposes a bread agent (and an agent+skill pair) as MCP tools, served over a
// real HTTP transport, and drives it with the official MCP client — exercising
// buildMcpServer + handleHttpRequest end to end.
describe('mcp server exposure over HTTP — agents/skills', () => {
  let bread: BreadInstance
  let stopBread: () => Promise<void>
  let server: ReturnType<typeof Bun.serve>
  let url: URL

  const expose = { agents: ['greeter'], skills: [{ agent: 'greeter', skill: 'wave' }] }

  beforeAll(async () => {
    ;({ bread, stop: stopBread } = await makeBread({
      agents: { greeter: defineTestAgent() },
      model: mockTextModel('agent ran'),
    }))
    // Stateless transport: a fresh server + transport per request.
    server = Bun.serve({
      port: 0,
      fetch: (req) => handleHttpRequest(buildMcpServer(bread, expose), req),
    })
    url = new URL(`http://localhost:${server.port}/mcp`)
  })

  afterAll(async () => {
    server.stop(true)
    await stopBread()
  })

  async function connect(): Promise<Client> {
    const client = new Client({ name: 'test-client', version: '0.0.0' })
    await client.connect(new StreamableHTTPClientTransport(url))
    return client
  }

  test('lists exposed agents and agent+skill pairs as tools', async () => {
    const client = await connect()
    const { tools } = await client.listTools()
    const names = tools.map((t) => t.name)
    expect(names).toContain('greeter')
    expect(names).toContain('greeter__wave')
    await client.close()
  })

  test('calling an agent tool runs the agent and returns its output', async () => {
    const client = await connect()
    const res = await client.callTool({ name: 'greeter', arguments: { input: 'hi' } })
    const content = res.content as { type: string; text: string }[]
    expect(content[0]!.text).toBe('agent ran')
    await client.close()
  })

  test('calling a skill-scoped tool runs the agent with that skill', async () => {
    const client = await connect()
    const res = await client.callTool({ name: 'greeter__wave', arguments: { input: 'hi' } })
    const content = res.content as { type: string; text: string }[]
    expect(content[0]!.text).toBe('agent ran')
    await client.close()
  })
})

describe('mcp server exposure — schema translation', () => {
  let bread: BreadInstance
  let stopBread: () => Promise<void>
  let server: ReturnType<typeof Bun.serve>
  let url: URL

  beforeAll(async () => {
    ;({ bread, stop: stopBread } = await makeBread({
      agents: {
        structured: defineTestAgent({
          config: {
            inputSchema: z.object({ city: z.string() }),
            outputSchema: z.object({ city: z.string(), pop: z.number() }),
            output: { format: 'json' },
          },
        }),
      },
      model: mockObjectModel({ city: 'Rome', pop: 3 }),
    }))
    server = Bun.serve({
      port: 0,
      fetch: (req) => handleHttpRequest(buildMcpServer(bread, { agents: ['structured'] }), req),
    })
    url = new URL(`http://localhost:${server.port}/mcp`)
  })

  afterAll(async () => {
    server.stop(true)
    await stopBread()
  })

  test('an object-schema agent gets its real schema, not the {input: string} wrapper', async () => {
    const client = new Client({ name: 'test-client', version: '0.0.0' })
    await client.connect(new StreamableHTTPClientTransport(url))
    const { tools } = await client.listTools()
    const tool = tools.find((t) => t.name === 'structured')!
    expect(Object.keys(tool.inputSchema.properties ?? {})).toEqual(['city'])

    const res = await client.callTool({ name: 'structured', arguments: { city: 'Rome' } })
    expect(res.structuredContent).toEqual({ city: 'Rome', pop: 3 })
    await client.close()
  })
})

describe('mcp server exposure — tasks', () => {
  let bread: BreadInstance
  let stopBread: () => Promise<void>
  let server: ReturnType<typeof Bun.serve>
  let url: URL

  beforeAll(async () => {
    const summarize = defineTask({
      name: 'summarize',
      description: 'Summarize text',
      model: { provider: 'mock', model: 'summarizer' },
      instructions: 'summarize',
      schema: z.object({ text: z.string() }),
      outputSchema: z.object({ summary: z.string() }),
    })
    ;({ bread, stop: stopBread } = await makeBread({
      agents: { a: defineTestAgent() },
      tasks: { summarize },
      models: {
        default: mockTextModel('unused'),
        summarizer: mockObjectModel({ summary: 'short' }),
      },
    }))
    server = Bun.serve({
      port: 0,
      fetch: (req) => handleHttpRequest(buildMcpServer(bread, { tasks: ['summarize'] }), req),
    })
    url = new URL(`http://localhost:${server.port}/mcp`)
  })

  afterAll(async () => {
    server.stop(true)
    await stopBread()
  })

  test('a task is invoked directly, bypassing the model, and returns structured output', async () => {
    const client = new Client({ name: 'test-client', version: '0.0.0' })
    await client.connect(new StreamableHTTPClientTransport(url))
    const res = await client.callTool({ name: 'summarize', arguments: { text: 'long text here' } })
    expect(res.structuredContent).toEqual({ summary: 'short' })
    await client.close()
  })
})

describe('mcp server exposure — direct tool invocation', () => {
  let bread: BreadInstance
  let stopBread: () => Promise<void>
  let server: ReturnType<typeof Bun.serve>
  let url: URL
  const agentToolCalls: unknown[] = []
  const pluginToolCalls: unknown[] = []

  beforeAll(async () => {
    const agentTool = defineTool({
      name: 'agent_owned',
      description: 'A tool owned by one agent',
      schema: z.object({ n: z.number() }),
      credentials: ['SECRET'],
      execute: async (args, ctx) => {
        agentToolCalls.push(args)
        const secret = await ctx.credentials.get('SECRET')
        return { doubled: (args as { n: number }).n * 2, secret }
      },
    })
    const pluginTool = defineTool({
      name: 'plugin_owned',
      description: 'A plugin-contributed tool',
      schema: z.object({ msg: z.string() }),
      execute: async (args) => {
        pluginToolCalls.push(args)
        return { echoed: (args as { msg: string }).msg }
      },
    })
    const toolPlugin: BreadPlugin = { name: 'tool_source', tools: [pluginTool] }

    process.env.SECRET = 'the-secret-value'
    ;({ bread, stop: stopBread } = await makeBread({
      agents: { owner: defineTestAgent({ tools: [agentTool] }) },
      plugins: [toolPlugin],
      model: mockTextModel('unused'),
    }))
    server = Bun.serve({
      port: 0,
      fetch: (req) =>
        handleHttpRequest(
          buildMcpServer(bread, { tools: [{ agent: 'owner', tool: 'agent_owned' }, 'plugin_owned'] }),
          req,
        ),
    })
    url = new URL(`http://localhost:${server.port}/mcp`)
  })

  afterAll(async () => {
    server.stop(true)
    await stopBread()
    delete process.env.SECRET
  })

  test('an {agent, tool} entry is invoked directly with declared-credential scoping', async () => {
    const client = new Client({ name: 'test-client', version: '0.0.0' })
    await client.connect(new StreamableHTTPClientTransport(url))
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).toContain('owner__agent_owned')

    const res = await client.callTool({ name: 'owner__agent_owned', arguments: { n: 4 } })
    expect(res.structuredContent).toEqual({ doubled: 8, secret: 'the-secret-value' })
    expect(agentToolCalls).toEqual([{ n: 4 }])
    await client.close()
  })

  test('a bare plugin-tool name is invoked directly', async () => {
    const client = new Client({ name: 'test-client', version: '0.0.0' })
    await client.connect(new StreamableHTTPClientTransport(url))
    const res = await client.callTool({ name: 'plugin_owned', arguments: { msg: 'hi' } })
    expect(res.structuredContent).toEqual({ echoed: 'hi' })
    expect(pluginToolCalls).toEqual([{ msg: 'hi' }])
    await client.close()
  })
})

describe('mcp server exposure — direct tool invocation with blobStore', () => {
  let bread: BreadInstance
  let stopBread: () => Promise<void>
  let server: ReturnType<typeof Bun.serve>
  let url: URL

  beforeAll(async () => {
    const saveFile = defineTool({
      name: 'save_file',
      description: 'Store a generated file',
      schema: z.object({}),
      execute: async (_args, ctx) => {
        const { url: fileUrl } = await ctx.blobStore!.put(new TextEncoder().encode('report bytes'), {
          mimeType: 'application/pdf',
        })
        return { uri: fileUrl }
      },
    })
    ;({ bread, stop: stopBread } = await makeBread({
      agents: { owner: defineTestAgent({ tools: [saveFile] }) },
      model: mockTextModel('unused'),
      config: { blobStore: memoryBlobStore() },
    }))
    server = Bun.serve({
      port: 0,
      fetch: (req) =>
        handleHttpRequest(buildMcpServer(bread, { tools: [{ agent: 'owner', tool: 'save_file' }] }), req),
    })
    url = new URL(`http://localhost:${server.port}/mcp`)
  })

  afterAll(async () => {
    server.stop(true)
    await stopBread()
  })

  test('a directly-invoked tool can reach ctx.blobStore when config.blobStore is set', async () => {
    const client = new Client({ name: 'test-client', version: '0.0.0' })
    await client.connect(new StreamableHTTPClientTransport(url))
    const res = await client.callTool({ name: 'owner__save_file', arguments: {} })
    expect((res.structuredContent as { uri: string }).uri).toStartWith('memory://')
    await client.close()
  })
})
