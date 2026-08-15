import { defineConfig } from '@breadai/core'
import { providerCatalog } from '@breadai/provider-catalog'
import { store } from '@breadai/store-sqlite'
import { transport } from '@breadai/transport-http-chunked'

export default defineConfig({
  entrypoints: ['editor', 'researcher', 'fact-checker', 'writer'],
  store: store({ path: './bread.db' }),
  transport: transport(),
  providers: providerCatalog,
})
