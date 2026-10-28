import { describe, expect, test } from 'bun:test'
import type { PipelineStepEndCrumb, PipelineStepStartCrumb, VideoModel } from '@breadai/core'
import { collect, defineTestAgent, makeBread, memoryBlobStore, mockTextModel } from '@breadai/test-utils'
import type { MockLanguageModelV4 } from 'ai/test'

const PROMPT = 'a cat on a skateboard'

function videoModel(provider: string, modelId: string): VideoModel {
  return {
    specificationVersion: 'v4',
    provider,
    modelId,
    async doGenerate() {
      throw new Error('doGenerate should not run')
    },
    async doStart() {
      throw new Error('doStart should not run')
    },
  } as VideoModel
}

describe('bread.runPipeline — video step', () => {
  test('passes a string prompt through after resolving the model', async () => {
    let seen = ''
    const calls = { generate: 0, start: 0 }
    const reply = mockTextModel('noted') as MockLanguageModelV4
    const { bread, stop } = await makeBread({
      agents: { reply: defineTestAgent({ model: 'reply' }) },
      models: { reply },
      config: {
        blobStore: memoryBlobStore(),
        video: {
          fal: (modelId) => {
            seen = modelId
            return {
              ...videoModel('fal', modelId),
              async doGenerate() {
                calls.generate += 1
                throw new Error('doGenerate should not run')
              },
              async doStart() {
                calls.start += 1
                throw new Error('doStart should not run')
              },
            } as VideoModel
          },
        },
        pipelines: {
          clip: [
            { type: 'video', provider: 'fal', model: 'luma-dream-machine/ray-2' },
            { type: 'agent', agentId: 'reply' },
          ],
        },
      },
    })
    try {
      const crumbs = await collect(bread.runPipeline('clip', PROMPT))
      const start = crumbs.find((crumb) => crumb.type === 'pipeline:step:start') as PipelineStepStartCrumb
      expect(start.agentId).toBe('video')
      const end = crumbs.find(
        (crumb) => crumb.type === 'pipeline:step:end' && crumb.agentId === 'video',
      ) as PipelineStepEndCrumb
      expect(end.output).toBe(PROMPT)
      expect(seen).toBe('luma-dream-machine/ray-2')
      expect(calls).toEqual({ generate: 0, start: 0 })
      expect(crumbs.some((crumb) => crumb.type === 'file:generated')).toBe(false)
      expect(crumbs.some((crumb) => crumb.type === 'human:required')).toBe(false)
      const prompt = JSON.stringify(reply.doStreamCalls[0]!.prompt)
      expect(prompt).toContain(PROMPT)
    } finally {
      await stop()
    }
  })

  test('throws VIDEO_PROMPT for a non-string before resolving the model', async () => {
    let resolved = 0
    const { bread, stop } = await makeBread({
      agents: { reply: defineTestAgent({ model: 'reply' }) },
      models: { reply: mockTextModel('noted') },
      config: {
        blobStore: memoryBlobStore(),
        video: {
          fal: () => {
            resolved += 1
            return videoModel('fal', 'ray-2')
          },
        },
        pipelines: {
          clip: [{ type: 'video', provider: 'fal', model: 'ray-2' }],
        },
      },
    })
    try {
      const error = await collect(bread.runPipeline('clip', { prompt: PROMPT })).catch((caught) => caught)
      expect(error).toMatchObject({ code: 'VIDEO_PROMPT' })
      expect(resolved).toBe(0)
    } finally {
      await stop()
    }
  })

  test('throws BLOB_STORE_NOT_CONFIGURED when blobStore is unset, before the prompt check', async () => {
    let resolved = 0
    const { bread, stop } = await makeBread({
      agents: { reply: defineTestAgent({ model: 'reply' }) },
      models: { reply: mockTextModel('noted') },
      config: {
        video: {
          fal: () => {
            resolved += 1
            return videoModel('fal', 'ray-2')
          },
        },
        pipelines: {
          clip: [{ type: 'video', provider: 'fal', model: 'ray-2' }],
        },
      },
    })
    try {
      const stringError = await collect(bread.runPipeline('clip', PROMPT)).catch((caught) => caught)
      expect(stringError).toMatchObject({ code: 'BLOB_STORE_NOT_CONFIGURED' })
      const objectError = await collect(bread.runPipeline('clip', { prompt: PROMPT })).catch((caught) => caught)
      expect(objectError).toMatchObject({ code: 'BLOB_STORE_NOT_CONFIGURED' })
      expect(resolved).toBe(0)
    } finally {
      await stop()
    }
  })

  test('throws VIDEO_NOT_CONFIGURED when the registry is unset', async () => {
    const { bread, stop } = await makeBread({
      agents: { reply: defineTestAgent({ model: 'reply' }) },
      models: { reply: mockTextModel('noted') },
      config: {
        blobStore: memoryBlobStore(),
        pipelines: {
          clip: [{ type: 'video', provider: 'fal', model: 'ray-2' }],
        },
      },
    })
    try {
      const error = await collect(bread.runPipeline('clip', PROMPT)).catch((caught) => caught)
      expect(error).toMatchObject({ code: 'VIDEO_NOT_CONFIGURED' })
    } finally {
      await stop()
    }
  })

  test('throws UNKNOWN_VIDEO_PROVIDER when the provider is not registered', async () => {
    const { bread, stop } = await makeBread({
      agents: { reply: defineTestAgent({ model: 'reply' }) },
      models: { reply: mockTextModel('noted') },
      config: {
        blobStore: memoryBlobStore(),
        video: {},
        pipelines: {
          clip: [{ type: 'video', provider: 'fal', model: 'ray-2' }],
        },
      },
    })
    try {
      const error = await collect(bread.runPipeline('clip', PROMPT)).catch((caught) => caught)
      expect(error).toMatchObject({ code: 'UNKNOWN_VIDEO_PROVIDER' })
      expect((error as Error).message).toContain('fal')
    } finally {
      await stop()
    }
  })
})
