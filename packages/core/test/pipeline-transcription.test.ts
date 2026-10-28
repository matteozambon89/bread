import { describe, expect, mock, test } from 'bun:test'

const transcribeCalls: Array<{ audio: unknown; model: { modelId?: string } }> = []

// The SDK downloader rejects loopback hosts, so the test records the URL
// instead of fetching it. The step still has to pass new URL(file.uri).
mock.module('ai', () => {
  const actual = require('ai') as Record<string, unknown>
  return {
    ...actual,
    transcribe: async (args: { audio: unknown; model: { modelId?: string } }) => {
      transcribeCalls.push({ audio: args.audio, model: args.model })
      return {
        text: 'the spoken words',
        segments: [{ text: 'SEGMENT_SHOULD_NOT_PASS', startSecond: 0, endSecond: 1.5 }],
        language: 'en',
        durationInSeconds: 1.5,
        warnings: [],
        responses: [],
        providerMetadata: { openai: { speaker: 'SPEAKER_SHOULD_NOT_PASS' } },
      }
    },
  }
})

import { BreadError } from '@breadai/core'
import type {
  BlobStore,
  FileOutput,
  PipelineStepEndCrumb,
  PipelineStepStartCrumb,
  TranscriptionRegistry,
} from '@breadai/core'
import { collect, defineTestAgent, makeBread, mockTextModel } from '@breadai/test-utils'
import type { TranscriptionModel } from 'ai'
import type { MockLanguageModelV4 } from 'ai/test'

const TRANSCRIPT = 'the spoken words'
const SEGMENT = 'SEGMENT_SHOULD_NOT_PASS'
const SPEAKER = 'SPEAKER_SHOULD_NOT_PASS'
const AUDIO_URL = 'https://cdn.example/clip.mp3'

interface Seen {
  models: string[]
}

function registry(seen: Seen): TranscriptionRegistry {
  return {
    openai: (modelId) => {
      seen.models.push(modelId)
      const model: TranscriptionModel = {
        specificationVersion: 'v4',
        provider: 'openai',
        modelId,
        async doGenerate() {
          throw new Error('transcribe should receive the model; doGenerate is not the pipeline call')
        },
      }
      return model
    },
  }
}

function countingBlobStore(): { blobStore: BlobStore; calls: { get: number; put: number } } {
  const calls = { get: 0, put: 0 }
  const blobStore: BlobStore = {
    async put() {
      calls.put++
      return { key: 'unused', url: 'https://example.invalid/unused' }
    },
    async get() {
      calls.get++
      return { data: new Uint8Array([9]), mimeType: 'audio/mpeg' }
    },
  }
  return { blobStore, calls }
}

function file(uri: string): FileOutput {
  return { kind: 'file', uri, mimeType: 'audio/mpeg', name: 'clip.mp3' }
}

async function drain(gen: AsyncIterable<unknown>): Promise<{ error?: unknown }> {
  try {
    for await (const _crumb of gen) {
      // drained
    }
    return {}
  } catch (error) {
    return { error }
  }
}

describe('bread.runPipeline — transcription step', () => {
  test('passes only the transcript text to the next step and does not read the blob', async () => {
    const seen: Seen = { models: [] }
    const { blobStore, calls } = countingBlobStore()
    const writer = mockTextModel('noted') as MockLanguageModelV4
    transcribeCalls.length = 0
    const { bread, stop } = await makeBread({
      agents: { writer: defineTestAgent({ model: 'writer' }) },
      models: { writer },
      config: {
        blobStore,
        transcription: registry(seen),
        pipelines: {
          transcript: [
            { type: 'transcription', provider: 'openai', model: 'whisper-1' },
            { type: 'agent', agentId: 'writer' },
          ],
        },
      },
    })
    try {
      const crumbs = await collect(bread.runPipeline('transcript', file(AUDIO_URL)))
      const start = crumbs.find((c) => c.type === 'pipeline:step:start') as PipelineStepStartCrumb
      expect(start.agentId).toBe('transcription')
      const end = crumbs.find(
        (c) => c.type === 'pipeline:step:end' && c.agentId === 'transcription',
      ) as PipelineStepEndCrumb
      expect(end.output).toBe(TRANSCRIPT)
      expect(seen.models).toEqual(['whisper-1'])
      expect(transcribeCalls).toHaveLength(1)
      const audio = transcribeCalls[0]!.audio
      expect(audio).toBeInstanceOf(URL)
      expect((audio as URL).href).toBe(AUDIO_URL)
      expect((audio as URL).protocol).toBe('https:')
      expect(transcribeCalls[0]!.model.modelId).toBe('whisper-1')
      expect(calls.get).toBe(0)
      expect(calls.put).toBe(0)
      const prompt = JSON.stringify(writer.doStreamCalls[0]!.prompt)
      expect(prompt).toContain(TRANSCRIPT)
      expect(prompt).not.toContain(SEGMENT)
      expect(prompt).not.toContain(SPEAKER)
    } finally {
      await stop()
    }
  })

  test('throws BLOB_STORE_NOT_CONFIGURED before transcribe when blobStore is unset', async () => {
    const seen: Seen = { models: [] }
    const writer = mockTextModel('noted') as MockLanguageModelV4
    transcribeCalls.length = 0
    const { bread, stop } = await makeBread({
      agents: { writer: defineTestAgent({ model: 'writer' }) },
      models: { writer },
      config: {
        transcription: registry(seen),
        pipelines: {
          transcript: [
            { type: 'transcription', provider: 'openai', model: 'whisper-1' },
            { type: 'agent', agentId: 'writer' },
          ],
        },
      },
    })
    try {
      const { error } = await drain(
        bread.runPipeline('transcript', file('https://example.invalid/clip.mp3')),
      )
      expect(error).toBeInstanceOf(BreadError)
      expect((error as BreadError).code).toBe('BLOB_STORE_NOT_CONFIGURED')
      expect(seen.models).toEqual([])
      expect(transcribeCalls).toHaveLength(0)
      expect(writer.doStreamCalls).toHaveLength(0)
    } finally {
      await stop()
    }
  })

  test('throws TRANSCRIPTION_INPUT before transcribe when the value is not a FileOutput', async () => {
    const seen: Seen = { models: [] }
    const { blobStore } = countingBlobStore()
    transcribeCalls.length = 0
    const { bread, stop } = await makeBread({
      agents: { writer: defineTestAgent({ model: 'writer' }) },
      models: { writer: mockTextModel('noted') },
      config: {
        blobStore,
        transcription: registry(seen),
        pipelines: {
          transcript: [{ type: 'transcription', provider: 'openai', model: 'whisper-1' }],
        },
      },
    })
    try {
      for (const input of ['https://example.invalid/clip.mp3', { kind: 'file' }, null]) {
        const { error } = await drain(bread.runPipeline('transcript', input))
        expect((error as BreadError).code).toBe('TRANSCRIPTION_INPUT')
        expect((error as BreadError).message).toContain('FileOutput')
      }
      expect(seen.models).toEqual([])
      expect(transcribeCalls).toHaveLength(0)
    } finally {
      await stop()
    }
  })

  test('throws TRANSCRIPTION_INPUT before transcribe when the uri is not http(s)', async () => {
    const seen: Seen = { models: [] }
    const { blobStore } = countingBlobStore()
    transcribeCalls.length = 0
    const { bread, stop } = await makeBread({
      agents: { writer: defineTestAgent({ model: 'writer' }) },
      models: { writer: mockTextModel('noted') },
      config: {
        blobStore,
        transcription: registry(seen),
        pipelines: {
          transcript: [{ type: 'transcription', provider: 'openai', model: 'whisper-1' }],
        },
      },
    })
    try {
      for (const uri of ['file:///tmp/clip.mp3', 'ftp://example.invalid/clip.mp3', 'not a url']) {
        const { error } = await drain(bread.runPipeline('transcript', file(uri)))
        expect((error as BreadError).code).toBe('TRANSCRIPTION_INPUT')
        expect((error as BreadError).message).toContain('http(s)')
      }
      expect(transcribeCalls).toHaveLength(0)
      expect(seen.models).toEqual([])
    } finally {
      await stop()
    }
  })

  test('throws TRANSCRIPTION_NOT_CONFIGURED when the registry is missing', async () => {
    const { blobStore } = countingBlobStore()
    const { bread, stop } = await makeBread({
      agents: { writer: defineTestAgent({ model: 'writer' }) },
      models: { writer: mockTextModel('noted') },
      config: {
        blobStore,
        pipelines: {
          transcript: [{ type: 'transcription', provider: 'openai', model: 'whisper-1' }],
        },
      },
    })
    try {
      const { error } = await drain(
        bread.runPipeline('transcript', file('https://example.invalid/clip.mp3')),
      )
      expect((error as BreadError).code).toBe('TRANSCRIPTION_NOT_CONFIGURED')
      expect((error as BreadError).message).toContain('@breadai/provider-transcription')
    } finally {
      await stop()
    }
  })

  test('throws UNKNOWN_TRANSCRIPTION_PROVIDER for an unknown name and an empty registry', async () => {
    const seen: Seen = { models: [] }
    const { blobStore } = countingBlobStore()
    transcribeCalls.length = 0
    const named = await makeBread({
      agents: { writer: defineTestAgent({ model: 'writer' }) },
      models: { writer: mockTextModel('noted') },
      config: {
        blobStore,
        transcription: registry(seen),
        pipelines: {
          transcript: [{ type: 'transcription', provider: 'missing', model: 'whisper-1' }],
        },
      },
    })
    const empty = await makeBread({
      agents: { writer: defineTestAgent({ model: 'writer' }) },
      models: { writer: mockTextModel('noted') },
      config: {
        blobStore,
        transcription: {},
        pipelines: {
          transcript: [{ type: 'transcription', provider: 'openai', model: 'whisper-1' }],
        },
      },
    })
    try {
      const unknown = await drain(
        named.bread.runPipeline('transcript', file('https://example.invalid/clip.mp3')),
      )
      expect((unknown.error as BreadError).code).toBe('UNKNOWN_TRANSCRIPTION_PROVIDER')
      expect((unknown.error as BreadError).message).toContain('openai')
      const blank = await drain(
        empty.bread.runPipeline('transcript', file('https://example.invalid/clip.mp3')),
      )
      expect((blank.error as BreadError).code).toBe('UNKNOWN_TRANSCRIPTION_PROVIDER')
      expect(transcribeCalls).toHaveLength(0)
    } finally {
      await named.stop()
      await empty.stop()
    }
  })

  test('passes an http uri to transcribe the same way as https', async () => {
    const seen: Seen = { models: [] }
    const { blobStore, calls } = countingBlobStore()
    transcribeCalls.length = 0
    const { bread, stop } = await makeBread({
      agents: { writer: defineTestAgent({ model: 'writer' }) },
      models: { writer: mockTextModel('noted') },
      config: {
        blobStore,
        transcription: registry(seen),
        pipelines: {
          transcript: [{ type: 'transcription', provider: 'openai', model: 'whisper-1' }],
        },
      },
    })
    try {
      const uri = 'http://cdn.example/clip.mp3'
      const crumbs = await collect(bread.runPipeline('transcript', file(uri)))
      const end = crumbs.find((c) => c.type === 'pipeline:step:end') as PipelineStepEndCrumb
      expect(end.output).toBe(TRANSCRIPT)
      expect(transcribeCalls[0]!.audio).toBeInstanceOf(URL)
      expect((transcribeCalls[0]!.audio as URL).href).toBe(uri)
      expect(calls.get).toBe(0)
    } finally {
      await stop()
    }
  })
})
