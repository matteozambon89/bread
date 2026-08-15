import { defineConfig } from '@bread/core'
import { a2aServer } from '@bread/protocol-a2a-server'
import { providerCatalog } from '@bread/provider-catalog'
import { store } from '@bread/store-sqlite'
import { transport } from '@bread/transport-http-chunked'

export default defineConfig({
  entrypoints: ['assistant'],
  store: store({ path: './.v03.db' }),
  transport: transport(),
  providers: providerCatalog,
  plugins: [a2aServer({ agentId: 'assistant', url: 'http://localhost:3000/a2a', cardPath: '/.well-known/agent-card.json' })],
})
