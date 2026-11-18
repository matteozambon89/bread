import { describe, expect, test } from 'bun:test'
import { defineImageTask } from '@breadai/core'
import type { ImageRegistry, ToolErrorCrumb, ToolResultCrumb } from '@breadai/core'
import type { ImageModel } from 'ai'
import { defineTestAgent, makeBread, memoryBlobStore, mockToolCallModel, runCollect } from '@breadai/test-utils'

const BYTES = new Uint8Array([1, 2, 3, 4])

type Seen = { calls: number; prompt?: string; n?: number }

function imageModel(seen: Seen): ImageModel {
  return {
    specificationVersion: 'v4',
    provider: 'test',
    modelId: 'test-image',
    maxImagesPerCall: 1,
    async doGenerate(options: { prompt: string | undefined; n: number }) {
      seen.calls++
      seen.prompt = options.prompt
      seen.n = options.n
      return {
        images: [BYTES],
        warnings: [],
        isRetryable: true,
        response: { timestamp: new Date(), modelId: 'test-image', headers: {} },
      }
    },
  } as ImageModel
}

function registry(seen: Seen): ImageRegistry {
  return {
    openai: (modelId) => {
      expect(modelId).toBe('gpt-image-1')
      return imageModel(seen)
    },
  }
}

function drawTask() {
  return defineImageTask({
    name: 'draw',
    description: 'Draw an image from a text prompt',
    provider: 'openai',
    model: 'gpt-image-1',
  })
}

async function runDraw(options: { supervisor?: boolean; prompt: string; blob?: boolean; seen: Seen }) {
  const blobs = options.blob === false ? undefined : memoryBlobStore()
  const { bread, stop } = await makeBread({
    agents: {
      lead: defineTestAgent({
        config: {
          tasks: ['draw'],
          ...(options.supervisor ? { supervisor: { agents: [{ agentId: 'writer' }] } } : {}),
        },
      }),
      ...(options.supervisor ? { writer: defineTestAgent() } : {}),
    },
    model: mockToolCallModel({
      toolName: 'task_draw',
      args: { prompt: options.prompt },
      then: 'done',
    }),
    tasks: { draw: drawTask() },
    config: {
      ...(blobs ? { blobStore: blobs } : {}),
      image: registry(options.seen),
    },
  })
  try {
    return { crumbs: await runCollect(bread, 'lead', 'go'), blobs }
  } finally {
    await stop()
  }
}

describe('defineImageTask', () => {
  test('an agent with the task returns the file reference', async () => {
    const seen = { calls: 0 }
    const { crumbs, blobs } = await runDraw({ prompt: 'a red barn', seen })
    const result = crumbs.find((crumb) => crumb.type === 'tool:result' && crumb.toolName === 'task_draw') as ToolResultCrumb
    expect(result.result).toMatchObject({ kind: 'file', mimeType: 'image/png' })
    const file = result.result as { uri: string }
    expect(file.uri).toStartWith('memory://')
    expect(seen).toMatchObject({ calls: 1, prompt: 'a red barn', n: 1 })
    const key = file.uri.slice('memory://'.length)
    expect((await blobs!.get(key))?.data).toEqual(BYTES)
  })

  test('a supervisor with the task returns the file reference', async () => {
    const seen = { calls: 0 }
    const { crumbs } = await runDraw({ supervisor: true, prompt: 'a red barn', seen })
    const result = crumbs.find((crumb) => crumb.type === 'tool:result' && crumb.toolName === 'task_draw') as ToolResultCrumb
    expect(result.result).toMatchObject({ kind: 'file', mimeType: 'image/png' })
    expect((result.result as { uri: string }).uri).toStartWith('memory://')
    expect(seen.calls).toBe(1)
  })

  test('a missing blobStore fails before generateImage', async () => {
    const seen = { calls: 0 }
    const { crumbs } = await runDraw({ prompt: 'a red barn', blob: false, seen })
    const error = crumbs.find((crumb) => crumb.type === 'tool:error') as ToolErrorCrumb
    expect(error.toolName).toBe('task_draw')
    expect(error.error.code).toBe('BLOB_STORE_NOT_CONFIGURED')
    expect(seen.calls).toBe(0)
  })

  test('an empty prompt fails before generateImage', async () => {
    const seen = { calls: 0 }
    const { crumbs } = await runDraw({ prompt: '', seen })
    const error = crumbs.find((crumb) => crumb.type === 'tool:error') as ToolErrorCrumb
    expect(error.error.code).toBe('IMAGE_PROMPT')
    expect(seen.calls).toBe(0)
  })
})
