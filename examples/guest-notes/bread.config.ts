import { defineConfig } from '@breadai/core'
import { graph } from '@breadai/graph-neo4j'
import { memory } from '@breadai/memory'
import { providerLlm } from '@breadai/provider-llm'
import { store } from '@breadai/store-sqlite'
import { transport } from '@breadai/transport-http-chunked'

const username = process.env.NEO4J_USERNAME
const password = process.env.NEO4J_PASSWORD

const sessions = store({ path: './bread.db' })
const notes = graph({
  url: process.env.NEO4J_URL ?? 'bolt://127.0.0.1:7687',
  ...(username && password ? { auth: { username, password } } : {}),
})

function languageModel() {
  const provider = process.env.BREAD_PROVIDER ?? 'anthropic'
  const modelId = process.env.BREAD_MODEL ?? 'claude-opus-4-8'
  const factory = providerLlm[provider]
  if (!factory) throw new Error(`Unknown provider "${provider}".`)
  return factory(modelId)
}

export default defineConfig({
  entrypoints: ['host'],
  store: sessions,
  transport: transport(),
  providers: providerLlm,
  graph: notes,
  plugins: [
    memory({
      backend: { kind: 'graph', graph: notes, store: sessions },
      model: languageModel,
    }),
  ],
})
