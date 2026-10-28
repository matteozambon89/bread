import { embed } from 'ai'
import { store } from '@breadai/store-postgres'
import { transport } from '@breadai/transport-http-chunked'
import { defineConfig, resolveEmbeddingModel, type BreadConfig } from '@breadai/core'
import { providerEmbeddings } from '@breadai/provider-embeddings'
import { providerLlm } from '@breadai/provider-llm'

// Each write reads this object. Replacing `config.embeddings` changes the
// model; the factory is not called when the module loads. Postgres
// (DATABASE_URL) stores the vectors — SQLite cannot.
const live: { config?: BreadConfig } = {}

const config = defineConfig({
  entrypoints: ['memory'],
  embeddings: providerEmbeddings,
  transport: transport(),
  providers: providerLlm,
  store: store({
    embed: async (text) => {
      const model = await resolveEmbeddingModel(live.config?.embeddings, 'ollama', 'nomic-embed-text')
      const { embedding } = await embed({ model, value: text, maxRetries: 0 })
      return embedding
    },
  }),
})

live.config = config

export default config
