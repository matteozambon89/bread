import { describe, expect, test } from 'bun:test'
import { BreadError } from '@breadai/core'
import type { FileGeneratedCrumb, ImageRegistry, PipelineStepEndCrumb, PipelineStepStartCrumb } from '@breadai/core'
import type { ImageModel } from 'ai'
import { collect, defineTestAgent, makeBread, memoryBlobStore, mockTextModel } from '@breadai/test-utils'
import type { MockLanguageModelV4 } from 'ai/test'

const BYTES = new Uint8Array([1, 2, 3, 4])

type Seen = {
  calls: number
  prompt?: string
  n?: number
  files?: unknown
  mask?: unknown
}

function imageModel(opts: { bytes?: Uint8Array; empty?: boolean; seen: Seen }): ImageModel {
  return {
    specificationVersion: 'v4',
    provider: 'test',
    modelId: 'test-image',
    maxImagesPerCall: 1,
    async doGenerate(options: { prompt: string | undefined; n: number; files?: unknown; mask?: unknown }) {
      opts.seen.calls++
      opts.seen.prompt = options.prompt
      opts.seen.n = options.n
      opts.seen.files = options.files
      opts.seen.mask = options.mask
      return {
        images: opts.empty ? [] : [opts.bytes ?? BYTES],
        warnings: [],
        isRetryable: true,
        response: { timestamp: new Date(), modelId: 'test-image', headers: {} },
      }
    },
  } as ImageModel
}

function registry(seen: Seen, empty = false): ImageRegistry {
  return {
    openai: (modelId) => {
      expect(modelId).toBe('gpt-image-1')
      return imageModel({ seen, empty })
    },
  }
}

describe('bread.runPipeline — image step', () => {
  test('stores one image, emits file:generated, and passes the FileOutput on', async () => {
    const seen = { calls: 0 }
    const blobs = memoryBlobStore()
    const next = mockTextModel('ok') as MockLanguageModelV4
    const { bread, stop } = await makeBread({
      agents: { writer: defineTestAgent({ model: 'writer' }), next: defineTestAgent({ model: 'next' }) },
      models: { writer: mockTextModel('a red barn'), next },
      config: {
        blobStore: blobs,
        image: registry(seen),
        pipelines: {
          cover: [
            { type: 'agent', agentId: 'writer' },
            { type: 'image', provider: 'openai', model: 'gpt-image-1' },
            { type: 'agent', agentId: 'next' },
          ],
        },
      },
    })
    try {
      const crumbs = await collect(bread.runPipeline('cover', 'outline'))
      const start = crumbs.find((c) => c.type === 'pipeline:step:start' && c.agentId === 'image') as PipelineStepStartCrumb
      const file = crumbs.find((c) => c.type === 'file:generated') as FileGeneratedCrumb
      const end = crumbs.find((c) => c.type === 'pipeline:step:end' && c.agentId === 'image') as PipelineStepEndCrumb
      expect(start).toBeDefined()
      expect(file.uri).toStartWith('memory://')
      expect(file.mimeType).toBe('image/png')
      expect(file.runId).toBe(start.runId)
      expect(typeof file.sessionId).toBe('string')
      expect(await bread.store.getSession(file.sessionId!)).toBeDefined()
      expect(end.output).toEqual({ kind: 'file', uri: file.uri, mimeType: 'image/png' })
      expect(seen.calls).toBe(1)
      expect(seen.prompt).toBe('a red barn')
      expect(seen.files).toBeUndefined()
      expect(seen.n).toBe(1)
      const key = file.uri.slice('memory://'.length)
      expect((await blobs.get(key))?.data).toEqual(BYTES)
      const logged = await bread.store.getCrumbs!(file.runId)
      expect(logged.some((entry) => entry.type === 'file:generated')).toBe(true)
      await bread.store.deleteSession(file.sessionId!)
      expect(await bread.store.getCrumbs!(file.runId)).toEqual([])
      expect(JSON.stringify(next.doStreamCalls[0]!.prompt)).toContain(file.uri)
    } finally {
      await stop()
    }
  })

  test('forwards a source image to generateImage', async () => {
    const seen: Seen = { calls: 0 }
    const source = new Uint8Array([9, 8, 7])
    const mask = new Uint8Array([4, 5])
    const { bread, stop } = await makeBread({
      agents: { writer: defineTestAgent({ model: 'writer' }) },
      models: { writer: mockTextModel('unused') },
      config: {
        blobStore: memoryBlobStore(),
        image: registry(seen),
        pipelines: { cover: [{ type: 'image', provider: 'openai', model: 'gpt-image-1' }] },
      },
    })
    try {
      await collect(bread.runPipeline('cover', { text: 'sharpen', images: [source], mask }))
      expect(seen.calls).toBe(1)
      expect(seen.prompt).toBe('sharpen')
      expect(seen.n).toBe(1)
      expect(seen.files).toEqual([expect.objectContaining({ type: 'file', data: source })])
      expect(seen.mask).toEqual(expect.objectContaining({ type: 'file', data: mask }))
    } finally {
      await stop()
    }
  })

  test('forwards an image URL so an editor can fetch the source', async () => {
    const seen: Seen = { calls: 0 }
    const source = 'https://example.com/loaf.png'
    const { bread, stop } = await makeBread({
      agents: { writer: defineTestAgent({ model: 'writer' }) },
      models: { writer: mockTextModel('unused') },
      config: {
        blobStore: memoryBlobStore(),
        image: registry(seen),
        pipelines: { cover: [{ type: 'image', provider: 'openai', model: 'gpt-image-1' }] },
      },
    })
    try {
      await collect(bread.runPipeline('cover', { images: [source] }))
      expect(seen.calls).toBe(1)
      expect(seen.prompt).toBeUndefined()
      expect(seen.files).toEqual([{ type: 'url', url: source }])
    } finally {
      await stop()
    }
  })

  test('rejects a value that is not an image prompt before calling the model', async () => {
    const seen = { calls: 0 }
    const { bread, stop } = await makeBread({
      agents: { writer: defineTestAgent({ model: 'writer' }) },
      models: { writer: mockTextModel('unused') },
      config: {
        blobStore: memoryBlobStore(),
        image: registry(seen),
        pipelines: { cover: [{ type: 'image', provider: 'openai', model: 'gpt-image-1' }] },
      },
    })
    try {
      const err = await collect(bread.runPipeline('cover', { topic: 'bread' })).then(
        () => undefined,
        (error) => error,
      )
      expect(err).toBeInstanceOf(BreadError)
      expect((err as BreadError).code).toBe('IMAGE_PROMPT')
      expect(seen.calls).toBe(0)
    } finally {
      await stop()
    }
  })

  test('throws BLOB_STORE_NOT_CONFIGURED when blobStore is unset', async () => {
    const seen = { calls: 0 }
    const { bread, stop } = await makeBread({
      agents: { writer: defineTestAgent({ model: 'writer' }) },
      models: { writer: mockTextModel('unused') },
      config: {
        image: registry(seen),
        pipelines: { cover: [{ type: 'image', provider: 'openai', model: 'gpt-image-1' }] },
      },
    })
    try {
      const err = await collect(bread.runPipeline('cover', 'a loaf')).then(
        () => undefined,
        (error) => error,
      )
      expect(err).toBeInstanceOf(BreadError)
      expect((err as BreadError).code).toBe('BLOB_STORE_NOT_CONFIGURED')
      expect(seen.calls).toBe(0)
    } finally {
      await stop()
    }
  })

  test('throws IMAGE_NOT_CONFIGURED when no image registry is set', async () => {
    const { bread, stop } = await makeBread({
      agents: { writer: defineTestAgent({ model: 'writer' }) },
      models: { writer: mockTextModel('unused') },
      config: {
        blobStore: memoryBlobStore(),
        pipelines: { cover: [{ type: 'image', provider: 'openai', model: 'gpt-image-1' }] },
      },
    })
    try {
      const err = await collect(bread.runPipeline('cover', 'a loaf')).then(
        () => undefined,
        (error) => error,
      )
      expect((err as BreadError).code).toBe('IMAGE_NOT_CONFIGURED')
    } finally {
      await stop()
    }
  })

  test('throws UNKNOWN_IMAGE_PROVIDER for a name that is not registered', async () => {
    const { bread, stop } = await makeBread({
      agents: { writer: defineTestAgent({ model: 'writer' }) },
      models: { writer: mockTextModel('unused') },
      config: {
        blobStore: memoryBlobStore(),
        image: {},
        pipelines: { cover: [{ type: 'image', provider: 'fal', model: 'flux' }] },
      },
    })
    try {
      const err = await collect(bread.runPipeline('cover', 'a loaf')).then(
        () => undefined,
        (error) => error,
      )
      expect((err as BreadError).code).toBe('UNKNOWN_IMAGE_PROVIDER')
    } finally {
      await stop()
    }
  })

  test('does not retry an empty image result', async () => {
    const seen = { calls: 0 }
    const { bread, stop } = await makeBread({
      agents: { writer: defineTestAgent({ model: 'writer' }) },
      models: { writer: mockTextModel('unused') },
      config: {
        blobStore: memoryBlobStore(),
        image: registry(seen, true),
        pipelines: { cover: [{ type: 'image', provider: 'openai', model: 'gpt-image-1' }] },
      },
    })
    try {
      const err = await collect(bread.runPipeline('cover', 'a loaf')).then(
        () => undefined,
        (error) => error,
      )
      expect(err).toBeInstanceOf(BreadError)
      expect((err as BreadError).code).toBe('AGENT_ERROR')
      expect((err as BreadError).context).toEqual({ pipelineId: 'cover', stepIndex: 0 })
      expect((err as BreadError).message.length).toBeGreaterThan(0)
      expect(seen.calls).toBe(1)
    } finally {
      await stop()
    }
  })

  test('keeps the provider message when generateImage rejects', async () => {
    const image = {
      openai: () =>
        ({
          specificationVersion: 'v4',
          provider: 'test',
          modelId: 'test-image',
          maxImagesPerCall: 1,
          async doGenerate() {
            throw new Error('content policy rejected the prompt')
          },
        }) as ImageModel,
    }
    const { bread, stop } = await makeBread({
      agents: { writer: defineTestAgent({ model: 'writer' }) },
      models: { writer: mockTextModel('unused') },
      config: {
        blobStore: memoryBlobStore(),
        image,
        pipelines: { cover: [{ type: 'image', provider: 'openai', model: 'gpt-image-1' }] },
      },
    })
    try {
      const err = await collect(bread.runPipeline('cover', 'a loaf')).then(
        () => undefined,
        (error) => error,
      )
      expect(err).toBeInstanceOf(BreadError)
      const breadErr = err as BreadError
      expect(breadErr.code).toBe('AGENT_ERROR')
      expect(breadErr.message).toBe('content policy rejected the prompt')
      expect(breadErr.context).toEqual({ pipelineId: 'cover', stepIndex: 0 })
      expect(breadErr.cause).toBeInstanceOf(Error)
    } finally {
      await stop()
    }
  })

  test('shares one session across image steps and a branch arm', async () => {
    const seen = { calls: 0 }
    const principal = { iss: 'https://idp.example', sub: 'user' }
    const { bread, stop } = await makeBread({
      agents: { writer: defineTestAgent({ model: 'writer' }) },
      models: { writer: mockTextModel('unused') },
      config: {
        blobStore: memoryBlobStore(),
        image: registry(seen),
        pipelines: {
          cover: [
            {
              type: 'branch',
              on: 'kind',
              cases: [],
              default: [
                {
                  type: 'parallel',
                  steps: [
                    { type: 'image', provider: 'openai', model: 'gpt-image-1' },
                    { type: 'image', provider: 'openai', model: 'gpt-image-1' },
                  ],
                },
              ],
            },
          ],
        },
      },
    })
    try {
      const crumbs = await collect(bread.runPipeline('cover', 'a loaf', { principal }))
      const files = crumbs.filter((c) => c.type === 'file:generated') as FileGeneratedCrumb[]
      expect(files).toHaveLength(2)
      expect(files[0]!.sessionId).toBe(files[1]!.sessionId)
      expect((await bread.store.getSession(files[0]!.sessionId!))?.principal).toEqual(principal)
      expect((await bread.store.getCrumbs!(files[0]!.runId)).map((entry) => entry.type)).toEqual(['file:generated'])
      expect((await bread.store.getCrumbs!(files[1]!.runId)).map((entry) => entry.type)).toEqual(['file:generated'])
      await bread.store.deleteSession(files[0]!.sessionId!)
      expect(await bread.store.getCrumbs!(files[0]!.runId)).toEqual([])
      expect(await bread.store.getCrumbs!(files[1]!.runId)).toEqual([])
      expect(seen.calls).toBe(2)
    } finally {
      await stop()
    }
  })
})
