import { defineConfig } from '@bread/core'
import { providerCatalog } from '@bread/provider-catalog'
import { store } from '@bread/store-sqlite'
import { transport } from '@bread/transport-http-chunked'

export default defineConfig({
  entrypoints: ['researcher', 'writer'],
  store: store({ path: './bread.db' }),
  transport: transport(),
  providers: providerCatalog,
  pipelines: {
    article: [
      { type: 'agent', agentId: 'researcher' },
      { type: 'map', agentId: 'writer' },
    ],
  },
})
