import { defineConfig } from '@breadai/core'
import { providerLlm } from '@breadai/provider-llm'
import { store } from '@breadai/store-sqlite'
import { transport } from '@breadai/transport-http-chunked'

// `editor` is the host/judge; `drafter` and `critic` are its loop pool. All
// three must be registered, so all three are entrypoints.
export default defineConfig({
  entrypoints: ['editor', 'drafter', 'critic'],
  store: store({ path: './bread.db' }),
  transport: transport(),
  providers: providerLlm,
})
