import { defineConfig } from '@breadai/core'
import { providerLlm } from '@breadai/provider-llm'
import { store } from '@breadai/store-sqlite'
import { transport } from '@breadai/transport-http-chunked'

export default defineConfig({
  entrypoints: ['editor', 'researcher', 'fact-checker', 'writer'],
  store: store({ path: './bread.db' }),
  transport: transport(),
  providers: providerLlm,
})
