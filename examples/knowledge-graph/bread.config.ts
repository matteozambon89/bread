import { store } from '@breadai/store-postgres'
import { transport } from '@breadai/transport-http-chunked'
import { defineConfig } from '@breadai/core'
import { providerEmbeddings } from '@breadai/provider-embeddings'
import { providerLlm } from '@breadai/provider-llm'
import { memory } from '@breadai/memory'

// Postgres (DATABASE_URL) stores the vectors. The ref is resolved from
// `config.embeddings` on document ingest, document search, memory write, and
// memory search, not when this module loads.
const backend = store({
  embed: { provider: 'ollama', model: 'nomic-embed-text' },
})

export default defineConfig({
  entrypoints: ['memory'],
  embeddings: providerEmbeddings,
  transport: transport(),
  providers: providerLlm,
  store: backend,
  plugins: [
    memory({
      backend: { kind: 'store', store: backend },
      model: () => {
        const provider = process.env.BREAD_PROVIDER ?? 'anthropic'
        const modelId = process.env.BREAD_MODEL ?? 'claude-opus-4-8'
        const factory = providerLlm[provider]
        if (!factory) throw new Error(`Unknown provider "${provider}".`)
        return factory(modelId)
      },
    }),
  ],
})
