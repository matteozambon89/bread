import { store } from '@breadai/store-sqlite'
import { transport } from '@breadai/transport-http-chunked'
import { defineConfig } from '@breadai/core'
import { providerCatalog } from '@breadai/provider-catalog'

// Self-contained: a local SQLite file, no external service. Swap for
// the Postgres store() (with DATABASE_URL) in production.
export default defineConfig({
  entrypoints: ['memory'],
  store: store({ path: './bread.db' }),
  transport: transport(),
  providers: providerCatalog,
})
