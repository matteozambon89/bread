import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

// A minimal MCP server spawned over stdio by the client test. Its three tools
// produce the distinct content shapes that exercise the client's flattenContent:
// a single text block, multiple text blocks, and an error result. Hand-rolled
// directly against the MCP SDK (not @bread/protocol-mcp-server) — this fixture tests
// the *client* package, so it must not depend on the server package.
const server = new McpServer({ name: 'fixture', version: '0.0.0' })

server.registerTool(
  'echo',
  { description: 'Echo the message back as a single text block', inputSchema: { msg: z.string() } },
  async ({ msg }) => ({ content: [{ type: 'text', text: msg }] }),
)

server.registerTool(
  'multi',
  { description: 'Return two separate text blocks', inputSchema: {} },
  async () => ({
    content: [
      { type: 'text', text: 'line one' },
      { type: 'text', text: 'line two' },
    ],
  }),
)

server.registerTool(
  'boom',
  { description: 'Return an error result', inputSchema: {} },
  async () => ({ content: [{ type: 'text', text: 'it failed' }], isError: true }),
)

// Real-world MCP servers name tools outside bread's snake_case convention —
// these two exercise the client's sanitization (hyphen and camelCase).
server.registerTool(
  'list-files',
  { description: 'Hyphenated tool name', inputSchema: {} },
  async () => ({ content: [{ type: 'text', text: 'a.txt' }] }),
)

server.registerTool(
  'readFile',
  { description: 'camelCase tool name', inputSchema: {} },
  async () => ({ content: [{ type: 'text', text: 'contents' }] }),
)

// Registering a tool after connect is the real-world trigger for
// notifications/tools/list_changed (the SDK sends it automatically) — this
// lets the client test exercise a live round-trip instead of a synthetic one.
server.registerTool(
  'add_bonus_tool',
  { description: 'Registers a new tool at runtime, triggering tools/list_changed', inputSchema: {} },
  async () => {
    server.registerTool(
      'bonus',
      { description: 'Only exists after add_bonus_tool runs', inputSchema: {} },
      async () => ({ content: [{ type: 'text', text: 'surprise' }] }),
    )
    return { content: [{ type: 'text', text: 'registered' }] }
  },
)

await server.connect(new StdioServerTransport())
