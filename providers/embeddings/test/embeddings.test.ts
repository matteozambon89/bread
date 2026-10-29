import { describe, expect, test } from 'bun:test'
import { embeddingEntries, providerEmbeddings } from '@breadai/provider-embeddings'

const PROVIDERS = [
  'alibaba',
  'amazon-bedrock',
  'azure',
  'baseten',
  'cohere',
  'deepinfra',
  'fireworks',
  'google',
  'google-vertex',
  'mistral',
  'ollama',
  'openai',
  'openai-compatible',
  'perplexity',
  'togetherai',
  'voyage',
]

describe('providerEmbeddings', () => {
  test('exposes the 16 embedding provider names', () => {
    expect(Object.keys(providerEmbeddings).sort()).toEqual([...PROVIDERS].sort())
  })

  test('does not register language-model-only catalog keys', () => {
    for (const name of [
      'anthropic',
      'cerebras',
      'deepseek',
      'groq',
      'openrouter',
      'workers-ai',
      'xai',
    ]) {
      expect(providerEmbeddings[name]).toBeUndefined()
    }
  })

  test('spreading providerEmbeddings does not throw', () => {
    expect(() => ({ ...providerEmbeddings })).not.toThrow()
  })

  test('throws MISSING_PROVIDER when the @ai-sdk package is not installed', async () => {
    await expect(providerEmbeddings.voyage?.('voyage-3')).rejects.toMatchObject({
      code: 'MISSING_PROVIDER',
    })
  })

  test('the missing-provider error names the provider and the package to install', async () => {
    const err = await providerEmbeddings.alibaba?.('text-embedding-v4').catch((e) => e)
    expect(err.code).toBe('MISSING_PROVIDER')
    expect(err.message).toContain('@ai-sdk/alibaba')
    expect(err.message).toContain('bun add @ai-sdk/alibaba')
  })

  test('uninstalled openai-compatible still throws MISSING_PROVIDER', async () => {
    await expect(providerEmbeddings['openai-compatible']?.('text-embedding-3-small')).rejects.toMatchObject({
      code: 'MISSING_PROVIDER',
    })
  })

  test('ollama returns an embedding model', async () => {
    const model = await providerEmbeddings.ollama?.('nomic-embed-text')
    expect(model?.modelId).toBe('nomic-embed-text')
    expect(typeof model?.doEmbed).toBe('function')
  })

  test('openai-compatible fromEnv throws PROVIDER_NOT_CONFIGURED when OPENAI_COMPATIBLE_BASE_URL is unset', () => {
    const prevUrl = process.env.OPENAI_COMPATIBLE_BASE_URL
    delete process.env.OPENAI_COMPATIBLE_BASE_URL
    try {
      let err: unknown
      try {
        embeddingEntries['openai-compatible']?.create?.fromEnv()
      } catch (e) {
        err = e
      }
      expect(err).toMatchObject({ code: 'PROVIDER_NOT_CONFIGURED' })
      expect((err as Error).message).toContain('openai-compatible')
      expect((err as Error).message).toContain('OPENAI_COMPATIBLE_BASE_URL')
    } finally {
      if (prevUrl === undefined) delete process.env.OPENAI_COMPATIBLE_BASE_URL
      else process.env.OPENAI_COMPATIBLE_BASE_URL = prevUrl
    }
  })

  test('openai-compatible fromEnv returns name+baseURL without apiKey when only the base URL is set', () => {
    const prevUrl = process.env.OPENAI_COMPATIBLE_BASE_URL
    const prevKey = process.env.OPENAI_COMPATIBLE_API_KEY
    process.env.OPENAI_COMPATIBLE_BASE_URL = 'http://localhost:11434/v1'
    delete process.env.OPENAI_COMPATIBLE_API_KEY
    try {
      expect(embeddingEntries['openai-compatible']?.create?.fromEnv()).toEqual({
        name: 'openai-compatible',
        baseURL: 'http://localhost:11434/v1',
      })
    } finally {
      if (prevUrl === undefined) delete process.env.OPENAI_COMPATIBLE_BASE_URL
      else process.env.OPENAI_COMPATIBLE_BASE_URL = prevUrl
      if (prevKey === undefined) delete process.env.OPENAI_COMPATIBLE_API_KEY
      else process.env.OPENAI_COMPATIBLE_API_KEY = prevKey
    }
  })

  test('openai-compatible fromEnv forwards apiKey when OPENAI_COMPATIBLE_API_KEY is set', () => {
    const prevUrl = process.env.OPENAI_COMPATIBLE_BASE_URL
    const prevKey = process.env.OPENAI_COMPATIBLE_API_KEY
    process.env.OPENAI_COMPATIBLE_BASE_URL = 'http://localhost:11434/v1'
    process.env.OPENAI_COMPATIBLE_API_KEY = 'sk-test'
    try {
      expect(embeddingEntries['openai-compatible']?.create?.fromEnv()).toEqual({
        name: 'openai-compatible',
        baseURL: 'http://localhost:11434/v1',
        apiKey: 'sk-test',
      })
    } finally {
      if (prevUrl === undefined) delete process.env.OPENAI_COMPATIBLE_BASE_URL
      else process.env.OPENAI_COMPATIBLE_BASE_URL = prevUrl
      if (prevKey === undefined) delete process.env.OPENAI_COMPATIBLE_API_KEY
      else process.env.OPENAI_COMPATIBLE_API_KEY = prevKey
    }
  })
})
