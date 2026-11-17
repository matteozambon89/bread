import { defineConfig } from '@breadai/core'
import { providerImage } from '@breadai/provider-image'
import { providerLlm } from '@breadai/provider-llm'
import { store } from '@breadai/store-sqlite'
import { transport } from '@breadai/transport-http-chunked'
import { localBlobStore } from './blob.js'

export default defineConfig({
  entrypoints: ['researcher', 'writer'],
  store: store({ path: './bread.db' }),
  blobStore: localBlobStore('./blobs'),
  transport: transport(),
  providers: providerLlm,
  image: providerImage,
  pipelines: {
    article: [
      { type: 'agent', agentId: 'researcher' },
      { type: 'map', agentId: 'writer' },
    ],
    cover: [
      { type: 'agent', agentId: 'writer' },
      {
        type: 'image',
        provider: process.env.BREAD_IMAGE_PROVIDER ?? 'openai',
        model: process.env.BREAD_IMAGE_MODEL ?? 'gpt-image-1',
      },
    ],
  },
})
