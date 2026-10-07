import { defineConfig } from '@breadai/core'
import { mcpClient } from '@breadai/protocol-mcp-client'
import { providerLlm } from '@breadai/provider-llm'
import { store } from '@breadai/store-sqlite'
import { transport } from '@breadai/transport-http-chunked'

// The MCP client side: `assistant` gets the server's `echo` agent as the
// `bridge__echo` tool — see ../server, which exposes it. `transport` here is
// this app's own ingress (bread dev serves `assistant` locally); it's
// unrelated to mcpClient's outgoing connection to the server.
export default defineConfig({
  entrypoints: ['assistant'],
  store: store({ path: './.client.db' }),
  transport: transport(),
  providers: providerLlm,
  plugins: [
    mcpClient({
      servers: [{ name: 'bridge', url: process.env.MCP_URL ?? 'http://localhost:4101/mcp' }],
    }),
  ],
})
