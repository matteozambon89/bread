import { describe, expect, mock, test } from 'bun:test'

const created: Array<{ apiKey?: unknown } | undefined> = []
let defaultTranscriptionCalls = 0

mock.module('@ai-sdk/google-vertex', () => ({
  vertex: {
    transcription() {
      defaultTranscriptionCalls += 1
      throw new Error('Google Vertex transcription models do not support Express Mode API keys')
    },
  },
  createVertex(options?: { apiKey?: unknown }) {
    created.push(options)
    const expressKey =
      typeof options?.apiKey === 'string' || options?.apiKey == null
        ? process.env.GOOGLE_VERTEX_API_KEY
        : undefined
    return {
      transcription(modelId: string) {
        if (expressKey) {
          throw new Error('Google Vertex transcription models do not support Express Mode API keys')
        }
        return { provider: 'google-vertex', modelId }
      },
    }
  },
}))

const { providerTranscription } = await import('@breadai/provider-transcription')

describe('google-vertex transcription', () => {
  test('does not construct from the default vertex export when GOOGLE_VERTEX_API_KEY is set', async () => {
    const previous = process.env.GOOGLE_VERTEX_API_KEY
    process.env.GOOGLE_VERTEX_API_KEY = 'express-key'
    defaultTranscriptionCalls = 0
    created.length = 0
    try {
      const model = await providerTranscription['google-vertex']!('chirp_2')
      expect(defaultTranscriptionCalls).toBe(0)
      expect(model).toMatchObject({ provider: 'google-vertex', modelId: 'chirp_2' })
      expect(typeof created[0]?.apiKey === 'string' ? created[0]?.apiKey : '').not.toBe('express-key')
    } finally {
      if (previous === undefined) delete process.env.GOOGLE_VERTEX_API_KEY
      else process.env.GOOGLE_VERTEX_API_KEY = previous
    }
  })
})
