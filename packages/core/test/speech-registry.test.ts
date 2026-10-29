import { describe, expect, test } from 'bun:test'
import type { SpeechModel } from 'ai'
import { BreadError, defineConfig, type SpeechRegistry } from '@breadai/core'
import { resolveSpeechModel } from '../src/speech.js'

const speechModel = {
  specificationVersion: 'v4',
  provider: 'fake.speech',
  modelId: 'tts-1',
  async doGenerate() {
    throw new Error('unused')
  },
} as SpeechModel

describe('resolveSpeechModel', () => {
  test('returns the model from the speech registry, not a language-model registry', async () => {
    const seen: { modelId?: string } = {}
    const registry: SpeechRegistry = {
      openai: (modelId) => {
        seen.modelId = modelId
        return speechModel
      },
    }
    const config = defineConfig({
      entrypoints: [],
      speech: registry,
    })
    expect(await resolveSpeechModel(config.speech, 'openai', 'tts-1')).toBe(speechModel)
    expect(seen.modelId).toBe('tts-1')
  })

  test('throws SPEECH_NOT_CONFIGURED when the registry is unset', async () => {
    await expect(resolveSpeechModel(undefined, 'openai', 'tts-1')).rejects.toMatchObject({
      code: 'SPEECH_NOT_CONFIGURED',
    })
  })

  test('throws UNKNOWN_SPEECH_PROVIDER and names the registered keys', async () => {
    const err = await resolveSpeechModel({ openai: () => speechModel }, 'elevenlabs', 'm').catch(
      (error) => error,
    )
    expect(err).toBeInstanceOf(BreadError)
    expect(err).toMatchObject({ code: 'UNKNOWN_SPEECH_PROVIDER' })
    expect((err as Error).message).toContain('elevenlabs')
    expect((err as Error).message).toContain('openai')
  })

  test('throws UNKNOWN_SPEECH_PROVIDER for an empty registry', async () => {
    await expect(resolveSpeechModel({}, 'openai', 'tts-1')).rejects.toMatchObject({
      code: 'UNKNOWN_SPEECH_PROVIDER',
    })
  })
})
