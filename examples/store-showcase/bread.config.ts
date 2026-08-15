import { type BreadStore, defineConfig } from '@bread/core'
import { providerCatalog } from '@bread/provider-catalog'
import { transport } from '@bread/transport-http-chunked'

// Pick a store from the STORE env var so this one example demonstrates every
// backend. Stores are imported lazily so only the selected package loads (and
// only it needs a working driver). STORE is required — core has no auto-wired
// or interactive store fallback.
//
//   STORE=memory       bread dev   # ephemeral, no setup
//   STORE=sqlite-bun   bread dev   # ./bread.db via bun:sqlite
//   STORE=postgres     bread dev   # reads DATABASE_URL
async function pickStore(): Promise<BreadStore> {
  switch (process.env.STORE) {
    case 'memory':
      return (await import('@bread/store-memory')).store()
    case 'sqlite-bun':
      return (await import('@bread/store-sqlite')).store({ path: './bread.db' })
    case 'postgres':
      return (await import('@bread/store-postgres')).store()
    default:
      throw new Error(
        `store-showcase: set STORE to one of memory | sqlite-bun | postgres (got ${
          process.env.STORE === undefined ? 'unset' : `"${process.env.STORE}"`
        })`,
      )
  }
}

export default defineConfig({
  entrypoints: ['echo'],
  transport: transport(),
  providers: providerCatalog,
  store: await pickStore(),
})
