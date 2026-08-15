import { describe, expect, test } from 'bun:test'
import { resolveModel } from '@breadai/core'
import { providerCatalog } from '@breadai/provider-catalog'

describe('providerCatalog', () => {
  test('exposes all 18 built-in provider names', () => {
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
        'perplexity',
        'togetherai',
        'xai',
      ].sort(),
    )
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

  test('omits openai-compatible — it needs a baseURL and has no zero-config default', () => {
    expect(providerCatalog['openai-compatible']).toBeUndefined()
  })
})
