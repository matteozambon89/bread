import { defineConfig, type BlobStore } from '@breadai/core'
import { providerLlm } from '@breadai/provider-llm'
import { providerTranscription } from '@breadai/provider-transcription'
import { store } from '@breadai/store-sqlite'
import { transport } from '@breadai/transport-http-chunked'

// The transcription step requires blobStore but fetches the FileOutput url.
// It does not call get or put. A real app uses @breadai/store-s3 to store bytes.
const blobStore: BlobStore = {
  async put() {
    throw new Error('examples/pipeline does not store bytes')
  },
  async get() {
    throw new Error('examples/pipeline does not read bytes')
  },
}

export default defineConfig({
  entrypoints: ['researcher', 'writer'],
  store: store({ path: './bread.db' }),
  transport: transport(),
  providers: providerLlm,
  transcription: providerTranscription,
  blobStore,
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
