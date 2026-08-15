import { store } from '@breadai/store-sqlite'
import { transport } from '@breadai/transport-http-sse'
import { defineConfig } from '@breadai/core'
import { providerCatalog } from '@breadai/provider-catalog'

// Self-contained: a local SQLite file, no external service. Swap for
// the Postgres store() (with DATABASE_URL) in production.
// SSE keeps this README's curl examples (and EventSource clients) working —
// a mount-capable transport is required for `bread dev`'s HTTP ingress. (A
// sink-only transport like @breadai/transport-stdout can't serve that role in
// the same config.transport slot — the same one-slot limitation documented
// for @breadai/transport-redis in docs/transports.md.)
export default defineConfig({
  entrypoints: ['publisher'],
  store: store({ path: './bread.db' }),
  transport: transport(),
  providers: providerCatalog,
})
