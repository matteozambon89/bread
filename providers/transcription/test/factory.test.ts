import { describe, expect, mock, test } from 'bun:test'

const calls = new Map<string, unknown[]>()

function provider(name: string) {
  const fn = function providerFn(modelId: string) {
    calls.set(`${name}:fn`, [modelId])
    return { calledAsFunction: true }
  }
  return Object.assign(fn, {
    transcription(modelId?: string) {
      calls.set(name, [modelId])
      return { provider: name, modelId: modelId ?? 'default' }
    },
  })
}

const modules: Record<string, Record<string, unknown>> = {
  '@ai-sdk/openai': { openai: provider('openai') },
  '@ai-sdk/azure': { azure: provider('azure') },
  '@ai-sdk/google': { google: provider('google') },
  '@ai-sdk/google-vertex': { vertex: provider('google-vertex') },
  '@ai-sdk/mistral': { mistral: provider('mistral') },
  '@ai-sdk/groq': { groq: provider('groq') },
  '@ai-sdk/xai': { xai: provider('xai') },
  '@ai-sdk/elevenlabs': { elevenLabs: provider('elevenlabs') },
  '@ai-sdk/deepgram': { deepgram: provider('deepgram') },
  '@ai-sdk/cartesia': { cartesia: provider('cartesia') },
  '@ai-sdk/fish-audio': { fishAudio: provider('fish-audio') },
  '@ai-sdk/assemblyai': { assemblyai: provider('assemblyai') },
  '@ai-sdk/gladia': {
    gladia: Object.assign(
      function gladia() {
        calls.set('gladia:fn', [])
      },
      {
        transcription() {
          calls.set('gladia', [...arguments])
          return { provider: 'gladia', modelId: 'default' }
        },
      },
    ),
  },
  '@ai-sdk/revai': { revai: provider('revai') },
  '@ai-sdk/fal': { fal: provider('fal') },
}

for (const [specifier, exports] of Object.entries(modules)) {
  mock.module(specifier, () => exports)
}

const { providerTranscription } = await import('@breadai/provider-transcription')

describe('providerTranscription factories', () => {
  test('each factory returns provider.transcription(modelId) and does not call the provider', async () => {
    for (const name of Object.keys(providerTranscription)) {
      const model = await providerTranscription[name]!('whisper-1')
      expect(model).toMatchObject({ provider: name })
      expect(calls.get(`${name}:fn`)).toBeUndefined()
    }
    expect(calls.get('openai')).toEqual(['whisper-1'])
    expect(calls.get('google-vertex')).toEqual(['whisper-1'])
    expect(calls.get('elevenlabs')).toEqual(['whisper-1'])
    expect(calls.get('fish-audio')).toEqual(['whisper-1'])
    expect(calls.get('gladia')).toEqual(['whisper-1'])
    expect(calls.get('fal')).toEqual(['whisper-1'])
  })
})
