import { store } from '@bread/store-sqlite'
import { transport } from '@bread/transport-http-chunked'
import { defineConfig } from '@bread/core'
import { providerCatalog } from '@bread/provider-catalog'

// Self-contained: a local SQLite file, no external service. Swap for
// the Postgres store() (with DATABASE_URL) in production.
export default defineConfig({
  entrypoints: ['memory'],
  store: store({ path: './bread.db' }),
  transport: transport(),
  providers: providerCatalog,
})
