import { store } from '@breadai/store-postgres'
import { transport } from '@breadai/transport-http-chunked'
import { defineConfig } from '@breadai/core'
import { providerEmbeddings } from '@breadai/provider-embeddings'
import { providerLlm } from '@breadai/provider-llm'

// Postgres (DATABASE_URL) stores the vectors. The ref is resolved from
// `config.embeddings` on document ingest, document search, knowledge-node
// write, and knowledge query, not when this module loads.
export default defineConfig({
  entrypoints: ['memory'],
  embeddings: providerEmbeddings,
  transport: transport(),
  providers: providerLlm,
  store: store({
    embed: { provider: 'ollama', model: 'nomic-embed-text' },
  }),
})
