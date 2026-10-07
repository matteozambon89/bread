import { defineConfig } from '@breadai/core'
import { a2aServer } from '@breadai/protocol-a2a-server'
import { providerLlm } from '@breadai/provider-llm'
import { store } from '@breadai/store-sqlite'
import { transport } from '@breadai/transport-http-chunked'

export default defineConfig({
  entrypoints: ['assistant'],
  store: store({ path: './.v1.db' }),
  transport: transport(),
  providers: providerLlm,
  plugins: [
    a2aServer({
      agentId: 'assistant',
      url: 'http://localhost:3001/a2a',
      specVersion: '1.0',
      cardPath: '/.well-known/agent-card.json',
    }),
  ],
})
