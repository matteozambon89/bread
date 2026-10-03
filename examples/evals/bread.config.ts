import { defineConfig } from '@breadai/core'
import { providerLlm } from '@breadai/provider-llm'
import { store } from '@breadai/store-sqlite'
import { transport } from '@breadai/transport-http-chunked'

export default defineConfig({
  entrypoints: ['writer'],
  store: store({ path: './bread.db' }),
  transport: transport(),
  providers: providerLlm,
})
