import { describe, expect, test } from 'bun:test'
import { providerTranscription } from '@breadai/provider-transcription'

const PACKAGES: Record<string, string> = {
  openai: '@ai-sdk/openai',
  azure: '@ai-sdk/azure',
  google: '@ai-sdk/google',
  'google-vertex': '@ai-sdk/google-vertex',
  mistral: '@ai-sdk/mistral',
  groq: '@ai-sdk/groq',
  xai: '@ai-sdk/xai',
  elevenlabs: '@ai-sdk/elevenlabs',
  deepgram: '@ai-sdk/deepgram',
  cartesia: '@ai-sdk/cartesia',
  'fish-audio': '@ai-sdk/fish-audio',
  assemblyai: '@ai-sdk/assemblyai',
  gladia: '@ai-sdk/gladia',
  revai: '@ai-sdk/revai',
  fal: '@ai-sdk/fal',
}

describe('providerTranscription', () => {
  test('exposes exactly the 15 transcription providers', () => {
    expect(Object.keys(providerTranscription).sort()).toEqual(Object.keys(PACKAGES).sort())
    expect(providerTranscription).not.toHaveProperty('openai-compatible')
    expect(providerTranscription).not.toHaveProperty('livekit')
    expect(providerTranscription).not.toHaveProperty('gateway')
  })

  test('spreading providerTranscription does not throw', () => {
    expect(() => ({ ...providerTranscription })).not.toThrow()
  })

  test('throws MISSING_PROVIDER naming the package to install', async () => {
    for (const [provider, pkg] of Object.entries(PACKAGES)) {
      const err = await providerTranscription[provider]!('model').catch((error: unknown) => error)
      expect(err).toMatchObject({ code: 'MISSING_PROVIDER' })
      expect((err as Error).message).toContain(pkg)
      expect((err as Error).message).toContain(`bun add ${pkg}`)
    }
  })
})
