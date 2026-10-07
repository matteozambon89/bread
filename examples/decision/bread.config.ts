import { defineConfig } from '@breadai/core'
import { providerDecisions } from '@breadai/provider-decisions'
import { providerLlm } from '@breadai/provider-llm'
import { store } from '@breadai/store-sqlite'
import { transport } from '@breadai/transport-http-chunked'

export default defineConfig({
  entrypoints: ['reply'],
  store: store({ path: './bread.db' }),
  transport: transport(),
  providers: providerLlm,
  decisions: providerDecisions,
  pipelines: {
    classify: [
      {
        type: 'decision',
        provider: 'typesafe',
        model: 'jev-latest',
        question: {
          type: 'choice',
          text: 'Which desk owns this message?',
          options: ['billing', 'shipping'],
          otherwise: 'needs_review',
        },
      },
      { type: 'agent', agentId: 'reply' },
    ],
  },
})
