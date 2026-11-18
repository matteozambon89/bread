import { type BreadStore, defineConfig } from '@breadai/core'
import { providerLlm } from '@breadai/provider-llm'
import { transport } from '@breadai/transport-http-chunked'

// Pick a store from the STORE env var so this one example demonstrates every
// backend. Stores are imported lazily so only the selected package loads (and
// only it needs a working driver). STORE is required — core has no auto-wired
// or interactive store fallback.
//
//   STORE=memory       bread dev   # ephemeral, no setup
//   STORE=sqlite-bun   bread dev   # ./bread.db via bun:sqlite
//   STORE=postgres     bread dev   # reads DATABASE_URL
//   STORE=mysql        bread dev   # reads MYSQL_URL
async function pickStore(): Promise<BreadStore> {
  switch (process.env.STORE) {
    case 'memory':
      return (await import('@breadai/store-memory')).store()
    case 'sqlite-bun':
      return (await import('@breadai/store-sqlite')).store({ path: './bread.db' })
    case 'postgres':
      return (await import('@breadai/store-postgres')).store()
    case 'mysql':
      // loopback permits cleartext only when MYSQL_URL's host is loopback.
      return (await import('@breadai/store-mysql')).store({ loopback: true })
    default:
      throw new Error(
        `store-showcase: set STORE to one of memory | sqlite-bun | postgres | mysql (got ${
          process.env.STORE === undefined ? 'unset' : `"${process.env.STORE}"`
        })`,
      )
  }
}

export default defineConfig({
  entrypoints: ['echo'],
  transport: transport(),
  providers: providerLlm,
  store: await pickStore(),
})
