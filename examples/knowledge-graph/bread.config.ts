import { store } from '@breadai/store-sqlite'
import { transport } from '@breadai/transport-http-chunked'
import { defineConfig } from '@breadai/core'
import { providerEmbeddings } from '@breadai/provider-embeddings'
import { providerLlm } from '@breadai/provider-llm'

// Self-contained: a local SQLite file, no external service. Swap for
// the Postgres store() (with DATABASE_URL) in production. SQLite stays
// keyword-only — embeddings is registered, not passed to store().
export default defineConfig({
  entrypoints: ['memory'],
  store: store({ path: './bread.db' }),
  transport: transport(),
  providers: providerLlm,
  embeddings: providerEmbeddings,
})
