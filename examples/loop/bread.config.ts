import { defineConfig } from '@bread/core'
import { providerCatalog } from '@bread/provider-catalog'
import { store } from '@bread/store-sqlite'
import { transport } from '@bread/transport-http-chunked'

// `editor` is the host/judge; `drafter` and `critic` are its loop pool. All
// three must be registered, so all three are entrypoints.
export default defineConfig({
  entrypoints: ['editor', 'drafter', 'critic'],
  store: store({ path: './bread.db' }),
  transport: transport(),
  providers: providerCatalog,
})
