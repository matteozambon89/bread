import { describe, expect, test } from 'bun:test'
import { providerSpeech, speechEntries } from '@breadai/provider-speech'

const CATALOG = [
  'azure',
  'cartesia',
  'deepgram',
  'elevenlabs',
  'fal',
  'fish-audio',
  'google',
  'google-vertex',
  'hume',
  'mistral',
  'openai',
  'xai',
]

describe('providerSpeech', () => {
  test('catalog is exactly the twelve speech providers', () => {
    expect(Object.keys(providerSpeech).sort()).toEqual(CATALOG)
    expect(Object.keys(speechEntries).sort()).toEqual(CATALOG)
    expect(providerSpeech).not.toHaveProperty('openai-compatible')
  })

  test('spreading providerSpeech does not throw', () => {
    expect(() => ({ ...providerSpeech })).not.toThrow()
  })

  test('each factory lazy-loads its optional peer and names the package to install', async () => {
    for (const name of CATALOG) {
      const err = await providerSpeech[name]!('tts-1').catch((error) => error)
      expect(err).toMatchObject({ code: 'MISSING_PROVIDER' })
      expect((err as Error).message).toContain(speechEntries[name]!.pkg)
      expect((err as Error).message).toContain(`bun add ${speechEntries[name]!.pkg}`)
    }
  })

  test('records the auth env vars each zero-config instance reads', () => {
    expect(speechEntries.openai?.envVars).toEqual(['OPENAI_API_KEY'])
    expect(speechEntries.azure?.envVars).toEqual(['AZURE_API_KEY', 'AZURE_RESOURCE_NAME'])
    expect(speechEntries['google-vertex']?.envVars).toEqual([
      'GOOGLE_VERTEX_API_KEY',
      'GOOGLE_VERTEX_PROJECT',
      'GOOGLE_VERTEX_LOCATION',
    ])
    expect(speechEntries.xai?.envVars).toEqual(['XAI_API_KEY'])
    expect(speechEntries.hume?.envVars).toEqual(['HUME_API_KEY'])
    expect(speechEntries.fal?.envVars).toEqual(['FAL_API_KEY', 'FAL_KEY'])
    expect(speechEntries['fish-audio']?.export).toBe('fishAudio')
    expect(speechEntries.elevenlabs?.export).toBe('elevenLabs')
    expect(speechEntries['google-vertex']?.export).toBe('vertex')
  })
})
