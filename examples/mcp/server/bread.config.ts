import { defineConfig } from '@breadai/core'
import { mcpServer } from '@breadai/protocol-mcp-server'
import { providerLlm } from '@breadai/provider-llm'
import { store } from '@breadai/store-sqlite'
import { transport } from '@breadai/transport-http-chunked'

// The MCP server side: exposes `echo` as an MCP tool over Streamable HTTP at
// /mcp — see ../client, which consumes it as an ordinary bread tool. `echo`
// is also a normal entrypoint, so it's directly runnable too, for contrast.
export default defineConfig({
  entrypoints: ['echo'],
  store: store({ path: './.server.db' }),
  transport: transport(),
  providers: providerLlm,
  plugins: [mcpServer({ transport: 'http', agents: ['echo'] })],
})
