import { defineConfig } from '@bread/core'
import { providerCatalog } from '@bread/provider-catalog'
import { store } from '@bread/store-sqlite'
import { transport } from '@bread/transport-http-chunked'

export default defineConfig({
  entrypoints: ['echo'],
  store: store({ path: './bread.db' }),
  transport: transport(),
  providers: providerCatalog,
})
