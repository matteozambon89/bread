import { defineConfig } from '@breadai/core'
import { providerLlm } from '@breadai/provider-llm'
import { providerTranscription } from '@breadai/provider-transcription'
import { store } from '@breadai/store-sqlite'
import { transport } from '@breadai/transport-http-chunked'

export default defineConfig({
  entrypoints: ['researcher', 'writer'],
  store: store({ path: './bread.db' }),
  transport: transport(),
  providers: providerLlm,
  transcription: providerTranscription,
  pipelines: {
    article: [
      { type: 'agent', agentId: 'researcher' },
      { type: 'map', agentId: 'writer' },
    ],
    transcript: [
      { type: 'transcription', provider: 'openai', model: 'whisper-1' },
      { type: 'agent', agentId: 'writer' },
    ],
  },
})
