import { describe, expect, test } from 'bun:test'
import { resolveModel } from '@breadai/core'
import { providerCatalog, providerEntries } from '@breadai/provider-catalog'

describe('providerCatalog', () => {
  test('exposes all 20 built-in provider names', () => {
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

  test('omits openai-compatible — it needs a baseURL and has no zero-config default', () => {
    expect(providerCatalog['openai-compatible']).toBeUndefined()
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
})
