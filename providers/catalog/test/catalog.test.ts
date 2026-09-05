import { describe, expect, test } from 'bun:test'
import { resolveModel } from '@breadai/core'
import { providerCatalog, providerEntries } from '@breadai/provider-catalog'

describe('providerCatalog', () => {
  test('exposes all 21 built-in provider names', () => {
    expect(Object.keys(providerCatalog).sort()).toEqual(
      [
        'amazon-bedrock',
        'anthropic',
        'azure',
        'baseten',
        'cerebras',
        'cohere',
        'deepinfra',
        'deepseek',
        'fireworks',
        'google',
        'google-vertex',
        'groq',
        'mistral',
        'ollama',
        'openai',
        'openai-compatible',
        'openrouter',
        'perplexity',
        'togetherai',
        'workers-ai',
        'xai',
      ].sort(),
    )
  })

  test('spreading providerCatalog does not throw', () => {
    expect(() => ({ ...providerCatalog })).not.toThrow()
  })

  test('throws MISSING_PROVIDER when the @ai-sdk package is not installed', async () => {
    // None of the @ai-sdk/* peer deps are installed in this workspace.
    await expect(
      resolveModel({ provider: 'anthropic', model: 'x' }, [providerCatalog]),
    ).rejects.toMatchObject({ code: 'MISSING_PROVIDER' })
  })

  test('the missing-provider error names the provider and the package to install', async () => {
    const err = await resolveModel({ provider: 'baseten', model: 'x' }, [providerCatalog]).catch(
      (e) => e,
    )
    expect(err.code).toBe('MISSING_PROVIDER')
    expect(err.message).toContain('@ai-sdk/baseten')
    expect(err.message).toContain('bun add @ai-sdk/baseten')
  })

  test('uninstalled workers-ai still throws MISSING_PROVIDER', async () => {
    await expect(
      resolveModel({ provider: 'workers-ai', model: 'x' }, [providerCatalog]),
    ).rejects.toMatchObject({ code: 'MISSING_PROVIDER' })
  })

  test('uninstalled openai-compatible still throws MISSING_PROVIDER', async () => {
    await expect(
      resolveModel({ provider: 'openai-compatible', model: 'x' }, [providerCatalog]),
    ).rejects.toMatchObject({ code: 'MISSING_PROVIDER' })
  })

  test('workers-ai fromEnv throws PROVIDER_NOT_CONFIGURED when Cloudflare env vars are unset', () => {
    const prevId = process.env.CLOUDFLARE_ACCOUNT_ID
    const prevToken = process.env.CLOUDFLARE_API_TOKEN
    delete process.env.CLOUDFLARE_ACCOUNT_ID
    delete process.env.CLOUDFLARE_API_TOKEN
    try {
      let err: unknown
      try {
        providerEntries['workers-ai']?.create?.fromEnv()
      } catch (e) {
        err = e
      }
      expect(err).toMatchObject({ code: 'PROVIDER_NOT_CONFIGURED' })
      expect((err as Error).message).toContain('workers-ai')
      expect((err as Error).message).toContain('CLOUDFLARE_ACCOUNT_ID')
      expect((err as Error).message).toContain('CLOUDFLARE_API_TOKEN')
    } finally {
      if (prevId === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID
      else process.env.CLOUDFLARE_ACCOUNT_ID = prevId
      if (prevToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN
      else process.env.CLOUDFLARE_API_TOKEN = prevToken
    }
  })

  test('openai-compatible fromEnv throws PROVIDER_NOT_CONFIGURED when OPENAI_COMPATIBLE_BASE_URL is unset', () => {
    const prevUrl = process.env.OPENAI_COMPATIBLE_BASE_URL
    delete process.env.OPENAI_COMPATIBLE_BASE_URL
    try {
      let err: unknown
      try {
        providerEntries['openai-compatible']?.create?.fromEnv()
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
      expect(providerEntries['openai-compatible']?.create?.fromEnv()).toEqual({
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
      expect(providerEntries['openai-compatible']?.create?.fromEnv()).toEqual({
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
