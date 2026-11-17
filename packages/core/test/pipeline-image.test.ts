import { describe, expect, test } from 'bun:test'
import { BreadError } from '@breadai/core'
import type { AgentErrorCrumb, AgentRunEndCrumb, AgentRunStartCrumb, BreadCrumb, FileGeneratedCrumb, ImageRegistry, PipelineStepEndCrumb, PipelineStepStartCrumb } from '@breadai/core'
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


function crumbHasBytes(crumb: unknown, bytes: Uint8Array): boolean {
  const asArray = JSON.stringify(Array.from(bytes))
  const asObject = JSON.stringify({ ...bytes })
  const json = JSON.stringify(crumb, (_key, value) => {
    if (value instanceof Uint8Array) return Array.from(value)
    if (value instanceof ArrayBuffer) return Array.from(new Uint8Array(value))
    return value
  })
  return json.includes(asArray) || JSON.stringify(crumb).includes(asObject)
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
      const runStart = crumbs.find(
        (c): c is AgentRunStartCrumb => c.type === 'agent:run:start' && c.runId === file.runId,
      )
      const runEnd = crumbs.find(
        (c): c is AgentRunEndCrumb => c.type === 'agent:run:end' && c.runId === file.runId,
      )
      expect(runStart).toMatchObject({ sessionId: file.sessionId, input: 'a red barn' })
      expect(runStart?.principal).toBeUndefined()
      expect(runEnd).toMatchObject({
        output: { kind: 'file', uri: file.uri, mimeType: 'image/png' },
        files: [{ kind: 'file', uri: file.uri, mimeType: 'image/png' }],
      })
      expect(typeof runEnd?.durationMs).toBe('number')
      const logged = await bread.store.getCrumbs!(file.runId)
      expect(logged.map((entry) => entry.type)).toEqual(['agent:run:start', 'file:generated', 'agent:run:end'])
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

  test("a source-image prompt's agent:run:start input has no image bytes", async () => {
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
      const crumbs = await collect(bread.runPipeline('cover', { text: 'sharpen', images: [source], mask }))
      const start = crumbs.find((c): c is AgentRunStartCrumb => c.type === 'agent:run:start')
      expect(start?.input).toBe('sharpen')
      expect(crumbHasBytes(start, source)).toBe(false)
      expect(crumbHasBytes(start, mask)).toBe(false)
      const logged = await bread.store.getCrumbs!(start!.runId)
      const loggedStart = logged.find((entry) => entry.type === 'agent:run:start')
      expect((loggedStart?.crumb as AgentRunStartCrumb).input).toBe('sharpen')
      expect(crumbHasBytes(loggedStart?.crumb, source)).toBe(false)
      expect(crumbHasBytes(loggedStart?.crumb, mask)).toBe(false)

      const bare = await collect(bread.runPipeline('cover', { images: [source], mask }))
      const bareStart = bare.find((c): c is AgentRunStartCrumb => c.type === 'agent:run:start')
      expect(bareStart).toBeDefined()
      expect('input' in bareStart!).toBe(false)
      expect(crumbHasBytes(bareStart, source)).toBe(false)
      expect(crumbHasBytes(bareStart, mask)).toBe(false)
      const bareLogged = await bread.store.getCrumbs!(bareStart!.runId)
      const bareLoggedStart = bareLogged.find((entry) => entry.type === 'agent:run:start')?.crumb as AgentRunStartCrumb
      expect('input' in bareLoggedStart).toBe(false)
      expect(crumbHasBytes(bareLoggedStart, source)).toBe(false)
      expect(seen.calls).toBe(2)
    } finally {
      await stop()
    }
  })

  test('rejects an image string before calling the model', async () => {
    const seen: Seen = { calls: 0 }
    const prompts = [
      { images: ['https://example.com/loaf.png'] },
      { images: ['http://example.com/loaf.png'] },
      { images: ['file:///tmp/loaf.png'] },
      { images: ['iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB'] },
      { text: 'sharpen', images: [new Uint8Array([1])], mask: 'https://example.com/mask.png' },
    ]
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
      for (const prompt of prompts) {
        seen.calls = 0
        const err = await collect(bread.runPipeline('cover', prompt)).then(
          () => undefined,
          (error) => error,
        )
        expect(err).toBeInstanceOf(BreadError)
        expect((err as BreadError).code).toBe('IMAGE_PROMPT')
        expect(seen.calls).toBe(0)
      }
    } finally {
      await stop()
    }
  })

  test('a text-only object is the text prompt', async () => {
    const seen: Seen = { calls: 0 }
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
      const crumbs = await collect(bread.runPipeline('cover', { text: 'a loaf' }))
      expect(seen.calls).toBe(1)
      expect(seen.prompt).toBe('a loaf')
      expect(seen.files).toBeUndefined()
      expect(crumbs.some((c) => c.type === 'file:generated')).toBe(true)
    } finally {
      await stop()
    }
  })

  test('an empty images array is IMAGE_PROMPT and does not call the model', async () => {
    const seen: Seen = { calls: 0 }
    const prompts = [
      { images: [] },
      { text: 'a loaf', images: [] },
      { mask: new Uint8Array([1]) },
      { text: 'a loaf', mask: new Uint8Array([1]) },
    ]
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
      for (const prompt of prompts) {
        seen.calls = 0
        const err = await collect(bread.runPipeline('cover', prompt)).then(
          () => undefined,
          (error) => error,
        )
        expect(err).toBeInstanceOf(BreadError)
        expect((err as BreadError).code).toBe('IMAGE_PROMPT')
        expect(seen.calls).toBe(0)
      }
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
    const principal = { iss: 'https://idp.example', sub: 'user', tenant: 'acme' }
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
      const starts = crumbs.filter(
        (c): c is AgentRunStartCrumb => c.type === 'agent:run:start' && c.agentId === 'image',
      )
      expect(starts).toHaveLength(2)
      expect(starts.every((c) => c.sessionId === files[0]!.sessionId)).toBe(true)
      expect(starts.map((c) => c.principal)).toEqual([
        { iss: principal.iss, sub: principal.sub },
        { iss: principal.iss, sub: principal.sub },
      ])
      expect((await bread.store.getCrumbs!(files[0]!.runId)).map((entry) => entry.type)).toEqual([
        'agent:run:start',
        'file:generated',
        'agent:run:end',
      ])
      expect((await bread.store.getCrumbs!(files[1]!.runId)).map((entry) => entry.type)).toEqual([
        'agent:run:start',
        'file:generated',
        'agent:run:end',
      ])
      await bread.store.deleteSession(files[0]!.sessionId!)
      expect(await bread.store.getCrumbs!(files[0]!.runId)).toEqual([])
      expect(await bread.store.getCrumbs!(files[1]!.runId)).toEqual([])
      expect(seen.calls).toBe(2)
    } finally {
      await stop()
    }
  })

  test('an abort that still returns image bytes does not store them', async () => {
    const controller = new AbortController()
    const blobs = memoryBlobStore()
    let puts = 0
    const put = blobs.put.bind(blobs)
    blobs.put = async (data, opts) => {
      puts++
      return put(data, opts)
    }
    const image = {
      openai: () =>
        ({
          specificationVersion: 'v4',
          provider: 'test',
          modelId: 'test-image',
          maxImagesPerCall: 1,
          async doGenerate() {
            controller.abort()
            return {
              images: [BYTES],
              warnings: [],
              isRetryable: true,
              response: { timestamp: new Date(), modelId: 'test-image', headers: {} },
            }
          },
        }) as ImageModel,
    }
    const { bread, stop } = await makeBread({
      agents: { writer: defineTestAgent({ model: 'writer' }) },
      models: { writer: mockTextModel('unused') },
      config: {
        blobStore: blobs,
        image,
        pipelines: { cover: [{ type: 'image', provider: 'openai', model: 'gpt-image-1' }] },
      },
    })
    try {
      const crumbs: BreadCrumb[] = []
      const err = await (async () => {
        try {
          for await (const crumb of bread.runPipeline('cover', 'a loaf', { signal: controller.signal })) {
            crumbs.push(crumb)
          }
        } catch (error) {
          return error
        }
      })()
      expect(err).toBeInstanceOf(BreadError)
      expect((err as BreadError).code).toBe('RUN_CANCELLED')
      expect(puts).toBe(0)
      expect(crumbs.some((c) => c.type === 'file:generated')).toBe(false)
      expect(crumbs.some((c) => c.type === 'agent:run:end')).toBe(false)
      expect(crumbs.filter((c) => c.type === 'agent:error')).toHaveLength(1)
    } finally {
      await stop()
    }
  })

  test('parallel image steps aborted together throw RUN_CANCELLED', async () => {
    const controller = new AbortController()
    let calls = 0
    const image = {
      openai: () =>
        ({
          specificationVersion: 'v4',
          provider: 'test',
          modelId: 'test-image',
          maxImagesPerCall: 1,
          async doGenerate(options: { abortSignal?: AbortSignal }) {
            calls++
            expect(options.abortSignal).toBe(controller.signal)
            controller.abort()
            throw new Error('aborted')
          },
        }) as ImageModel,
    }
    const { bread, stop } = await makeBread({
      agents: { writer: defineTestAgent({ model: 'writer' }) },
      models: { writer: mockTextModel('unused') },
      config: {
        blobStore: memoryBlobStore(),
        image,
        pipelines: {
          cover: [
            {
              type: 'parallel',
              steps: [
                { type: 'image', provider: 'openai', model: 'gpt-image-1' },
                { type: 'image', provider: 'openai', model: 'gpt-image-1' },
              ],
            },
          ],
        },
      },
    })
    try {
      const err = await (async () => {
        try {
          for await (const crumb of bread.runPipeline('cover', 'a loaf', { signal: controller.signal })) {
            if (crumb.type === 'agent:error' && crumb.error.code !== 'RUN_CANCELLED') {
              throw new Error(`unexpected agent:error ${crumb.error.code}`)
            }
          }
        } catch (error) {
          return error
        }
      })()
      expect(calls).toBe(2)
      expect(err).toBeInstanceOf(BreadError)
      expect(err).not.toBeInstanceOf(AggregateError)
      expect((err as BreadError).code).toBe('RUN_CANCELLED')
    } finally {
      await stop()
    }
  })

  test('aborting the signal during generateImage is RUN_CANCELLED', async () => {
    const controller = new AbortController()
    const image = {
      openai: () =>
        ({
          specificationVersion: 'v4',
          provider: 'test',
          modelId: 'test-image',
          maxImagesPerCall: 1,
          async doGenerate(options: { abortSignal?: AbortSignal }) {
            expect(options.abortSignal).toBe(controller.signal)
            controller.abort()
            throw new Error('aborted')
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
      const crumbs: BreadCrumb[] = []
      const err = await (async () => {
        try {
          for await (const crumb of bread.runPipeline('cover', 'a loaf', { signal: controller.signal })) {
            crumbs.push(crumb)
          }
        } catch (error) {
          return error
        }
      })()
      expect(err).toBeInstanceOf(BreadError)
      const breadErr = err as BreadError
      expect(breadErr.code).toBe('RUN_CANCELLED')
      expect(breadErr.message).toBe('run cancelled')
      expect(breadErr.context).toEqual({ pipelineId: 'cover', stepIndex: 0 })
      const errors = crumbs.filter((c): c is AgentErrorCrumb => c.type === 'agent:error')
      expect(errors).toHaveLength(1)
      expect(errors[0]!.error.code).toBe('RUN_CANCELLED')
      expect(crumbs.some((c) => c.type === 'agent:run:end')).toBe(false)
    } finally {
      await stop()
    }
  })

  test('a blob put error stays a BreadError with the underlying message', async () => {
    const seen = { calls: 0 }
    const blobs = memoryBlobStore()
    blobs.put = async () => {
      throw new Error('disk full')
    }
    const { bread, stop } = await makeBread({
      agents: { writer: defineTestAgent({ model: 'writer' }) },
      models: { writer: mockTextModel('unused') },
      config: {
        blobStore: blobs,
        image: registry(seen),
        pipelines: { cover: [{ type: 'image', provider: 'openai', model: 'gpt-image-1' }] },
      },
    })
    try {
      const crumbs: BreadCrumb[] = []
      const err = await (async () => {
        try {
          for await (const crumb of bread.runPipeline('cover', 'a loaf')) crumbs.push(crumb)
        } catch (error) {
          return error
        }
      })()
      expect(err).toBeInstanceOf(BreadError)
      const breadErr = err as BreadError
      expect(breadErr.code).toBe('AGENT_ERROR')
      expect(breadErr.message).toBe('disk full')
      expect(breadErr.context).toEqual({ pipelineId: 'cover', stepIndex: 0 })
      expect(crumbs.some((c) => c.type === 'file:generated')).toBe(false)
      expect(crumbs.some((c) => c.type === 'agent:run:end')).toBe(false)
      expect(crumbs.some((c) => c.type === 'agent:error')).toBe(true)
      expect(seen.calls).toBe(1)
    } finally {
      await stop()
    }
  })
})
