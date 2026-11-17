import { defineConfig } from '@breadai/core'
import { graph } from '@breadai/graph-neo4j'
import { memory } from '@breadai/memory'
import { providerLlm } from '@breadai/provider-llm'
import { store } from '@breadai/store-sqlite'
import { transport } from '@breadai/transport-http-chunked'
import { z } from 'zod'

const username = process.env.NEO4J_USERNAME
const password = process.env.NEO4J_PASSWORD

const sessions = store({ path: './bread.db' })
const notes = graph({
  url: process.env.NEO4J_URL ?? 'bolt://127.0.0.1:7687',
  ...(username && password ? { auth: { username, password } } : {}),
})

// Catalog tools bind subject, not iss. This app has no auth plugin, so every
// run is the local CLI principal. Pin that issuer here.
const matchingNotes = `MATCH (m:BreadMemory)
WHERE m.agentId = $agentId
  AND m.principalIss = 'https://bread.local/cli'
  AND m.principalSub = $subject
RETURN m.id AS id, m.content AS content
LIMIT 20`

function languageModel() {
  const provider = process.env.BREAD_PROVIDER ?? 'anthropic'
  const modelId = process.env.BREAD_MODEL ?? 'claude-opus-4-8'
  const factory = providerLlm[provider]
  if (!factory) throw new Error(`Unknown provider "${provider}".`)
  return factory(modelId)
}

export default defineConfig({
  entrypoints: ['scribe'],
  store: sessions,
  transport: transport(),
  providers: providerLlm,
  graph: notes,
  graphCatalog: {
    matching_notes: {
      description: 'Read this run’s mirrored notes from the graph copy',
      statement: matchingNotes,
      mode: 'read',
      schema: z.object({}),
    },
  },
  plugins: [
    memory({
      backend: { kind: 'combined', store: sessions, graph: notes },
      model: languageModel,
    }),
  ],
})
