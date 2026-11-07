import { describe, expect, mock, test } from 'bun:test'

mock.module('@ai-sdk/cohere', () => ({
  cohere: {
    embeddingModel(modelId: string) {
      return {
        modelId,
        specificationVersion: 'v4' as const,
        provider: 'cohere.embedding',
        doEmbed: async () => ({ embeddings: [] as number[][] }),
      }
    },
  },
}))

mock.module('@ai-sdk/mistral', () => ({
  mistral: {
    embedding(modelId: string) {
      return { modelId }
    },
  },
}))

mock.module('@ai-sdk/fireworks', () => {
  throw new Error("bad transitive import: Cannot find module 'left-pad'")
})

mock.module('@ai-sdk/baseten', () => {
  function createBaseten(options: { modelURL?: string; apiKey?: string } = {}) {
    return {
      embeddingModel(modelId?: string) {
        if (!options.modelURL) {
          throw new Error(
            'No model URL provided for embeddings. Please set modelURL option for embeddings.',
          )
        }
        const modelURL = options.modelURL
        return {
          modelId: modelId ?? 'embeddings',
          specificationVersion: 'v4' as const,
          provider: 'baseten.embedding',
          doEmbed: async () => ({ embeddings: [] as number[][] }),
          config: {
            apiKey: options.apiKey,
            url: ({ path }: { path: string }) =>
              modelURL.includes('/sync/v1') ? `${modelURL}${path}` : `${modelURL}/v1${path}`,
          },
        }
      },
    }
  }
  return { baseten: createBaseten(), createBaseten }
})

mock.module('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible(settings: { name: string; baseURL: string; apiKey?: string }) {
    return {
      embeddingModel(modelId: string) {
        return {
          modelId,
          specificationVersion: 'v4' as const,
          provider: 'openai-compatible.embedding',
          doEmbed: async () => ({ embeddings: [] as number[][] }),
          config: {
            baseURL: settings.baseURL,
            apiKey: settings.apiKey,
            url: ({ path }: { path: string }) => `${settings.baseURL}${path}`,
          },
        }
      },
    }
  },
}))

import { providerEmbeddings } from '@breadai/provider-embeddings'

function restore(name: string, prev: string | undefined) {
  if (prev === undefined) delete process.env[name]
  else process.env[name] = prev
}

describe('providerEmbeddings resolve', () => {
  test('resolves a non-function export that exposes embeddingModel', async () => {
    const model = await providerEmbeddings.cohere?.('embed-english-v3.0')
    expect(model?.modelId).toBe('embed-english-v3.0')
    expect(typeof model?.doEmbed).toBe('function')
  })

  test('a non-function export without embeddingModel throws PROVIDER_EXPORT_MISSING', async () => {
    const err = await providerEmbeddings.mistral?.('mistral-embed').catch((error: unknown) => error)
    expect(err).toMatchObject({ code: 'PROVIDER_EXPORT_MISSING' })
  })

  test('a non-function export without embeddingModel names the package', async () => {
    const err = await providerEmbeddings.mistral?.('mistral-embed').catch((error: unknown) => error)
    expect(err).toMatchObject({
      code: 'PROVIDER_EXPORT_MISSING',
      context: { pkg: '@ai-sdk/mistral' },
    })
    expect((err as Error).message).toContain('@ai-sdk/mistral')
    expect((err as Error).message).toContain('embeddingModel')
    expect((err as Error).message).not.toContain('has no "mistral" export')
  })

  test('a peer that fails while evaluating is not reported as MISSING_PROVIDER', async () => {
    const err = await providerEmbeddings.fireworks?.('nomic-ai/nomic-embed-text-v1.5').catch(
      (error: unknown) => error,
    )
    expect((err as { code?: string }).code).not.toBe('MISSING_PROVIDER')
    expect((err as Error).message).toContain('bad transitive import')
    expect((err as Error).message).not.toContain('bun add @ai-sdk/fireworks')
  })

  test('baseten builds an embedding model for a /sync model URL', async () => {
    const prevKey = process.env.BASETEN_API_KEY
    const prevUrl = process.env.BASETEN_MODEL_URL
    process.env.BASETEN_API_KEY = 'test-key'
    process.env.BASETEN_MODEL_URL = 'https://model-abc.api.baseten.co/sync'
    try {
      const model = await providerEmbeddings.baseten?.('my-embed')
      expect(model?.modelId).toBe('my-embed')
      const config = (
        model as { config?: { apiKey?: string; url?: (options: { path: string }) => string } }
      ).config
      expect(config?.apiKey).toBe('test-key')
      expect(config?.url?.({ path: '/embeddings' })).toBe(
        'https://model-abc.api.baseten.co/sync/v1/embeddings',
      )
    } finally {
      restore('BASETEN_API_KEY', prevKey)
      restore('BASETEN_MODEL_URL', prevUrl)
    }
  })

  test('baseten with only BASETEN_API_KEY does not call the default embedding model', async () => {
    const prevKey = process.env.BASETEN_API_KEY
    const prevUrl = process.env.BASETEN_MODEL_URL
    process.env.BASETEN_API_KEY = 'test-key'
    delete process.env.BASETEN_MODEL_URL
    try {
      const err = await providerEmbeddings.baseten?.('my-embed').catch((error: unknown) => error)
      expect(err).toMatchObject({ code: 'PROVIDER_NOT_CONFIGURED' })
      expect((err as Error).message).toContain('BASETEN_MODEL_URL')
      expect((err as Error).message).not.toContain('No model URL provided for embeddings')
    } finally {
      restore('BASETEN_API_KEY', prevKey)
      restore('BASETEN_MODEL_URL', prevUrl)
    }
  })

  test('openai-compatible rereads the base URL and API key after the first resolve', async () => {
    const prevUrl = process.env.OPENAI_COMPATIBLE_BASE_URL
    const prevKey = process.env.OPENAI_COMPATIBLE_API_KEY
    process.env.OPENAI_COMPATIBLE_BASE_URL = 'http://one.example/v1'
    delete process.env.OPENAI_COMPATIBLE_API_KEY
    try {
      const first = await providerEmbeddings['openai-compatible']?.('text-embedding-3-small')
      const firstUrl = (
        first as { config?: { url?: (options: { path: string }) => string; apiKey?: string } }
      ).config
      expect(firstUrl?.url?.({ path: '/embeddings' })).toBe('http://one.example/v1/embeddings')
      expect(firstUrl?.apiKey).toBeUndefined()

      process.env.OPENAI_COMPATIBLE_BASE_URL = 'http://two.example/v1'
      process.env.OPENAI_COMPATIBLE_API_KEY = 'sk-next'
      const second = await providerEmbeddings['openai-compatible']?.('text-embedding-3-small')
      const secondUrl = (
        second as { config?: { url?: (options: { path: string }) => string; apiKey?: string } }
      ).config
      expect(secondUrl?.url?.({ path: '/embeddings' })).toBe('http://two.example/v1/embeddings')
      expect(secondUrl?.apiKey).toBe('sk-next')
    } finally {
      restore('OPENAI_COMPATIBLE_BASE_URL', prevUrl)
      restore('OPENAI_COMPATIBLE_API_KEY', prevKey)
    }
  })
})
