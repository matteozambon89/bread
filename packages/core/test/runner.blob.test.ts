import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { BreadError, defineTool } from '@breadai/core'
import type { FileGeneratedCrumb, ToolResultCrumb } from '@breadai/core'
import {
  defineTestAgent,
  makeBread,
  memoryBlobStore,
  mockFileGeneratingModel,
  mockToolCallModel,
  runCollect,
  stream,
} from '@breadai/test-utils'

const PNG_BASE64 = Buffer.from('fake-png-bytes').toString('base64')

// Proves ToolContext.blobStore wiring end to end — a tool that calls
// ctx.blobStore.put() itself and echoes the resulting reference as its result.
describe('runner — ToolContext.blobStore', () => {
  test('a tool can store bytes via ctx.blobStore and return a reference', async () => {
    const saveFile = defineTool({
      name: 'save_file',
      description: 'Store a generated file',
      schema: z.object({}),
      execute: async (_args, ctx) => {
        const { url } = await ctx.blobStore!.put(new TextEncoder().encode('report bytes'), { mimeType: 'application/pdf' })
        return { uri: url }
      },
    })
    const { bread, stop } = await makeBread({
      agents: { reporter: defineTestAgent({ tools: [saveFile] }) },
      model: mockToolCallModel({ toolName: 'tool_save_file', args: {}, then: 'saved it' }),
      config: { blobStore: memoryBlobStore() },
    })
    try {
      const crumbs = await runCollect(bread, 'reporter', 'save a file')
      const result = crumbs.find((c) => c.type === 'tool:result') as ToolResultCrumb | undefined
      expect(result).toBeDefined()
      expect((result!.result as { uri: string }).uri).toStartWith('memory://')
    } finally {
      await stop()
    }
  })
})

describe('runner — model-generated files', () => {
  test('a model-generated file is stored via blobStore and emitted as a file:generated crumb', async () => {
    const { bread, stop } = await makeBread({
      agents: { artist: defineTestAgent() },
      model: mockFileGeneratingModel('here is your image', { mediaType: 'image/png', base64: PNG_BASE64 }),
      config: { blobStore: memoryBlobStore() },
    })
    try {
      const crumbs = await runCollect(bread, 'artist', 'draw a cat')
      const fileCrumb = crumbs.find((c) => c.type === 'file:generated') as FileGeneratedCrumb | undefined
      expect(fileCrumb).toBeDefined()
      expect(fileCrumb!.mimeType).toBe('image/png')
      expect(fileCrumb!.uri).toStartWith('memory://')

      const endCrumb = crumbs.find((c) => c.type === 'agent:run:end') as { files?: { uri: string }[] } | undefined
      expect(endCrumb?.files).toHaveLength(1)
      expect(endCrumb!.files![0]!.uri).toBe(fileCrumb!.uri)
    } finally {
      await stop()
    }
  })

  test('throws BLOB_STORE_NOT_CONFIGURED when a model generates a file with no blobStore configured', async () => {
    const { bread, stop } = await makeBread({
      agents: { artist: defineTestAgent() },
      model: mockFileGeneratingModel('here is your image', { mediaType: 'image/png', base64: PNG_BASE64 }),
    })
    try {
      let caught: BreadError | undefined
      try {
        for await (const _c of stream(bread, 'artist', 'draw a cat')) {
          // drain until the throw
        }
      } catch (err) {
        caught = err as BreadError
      }
      expect(caught).toBeInstanceOf(BreadError)
      expect(caught!.code).toBe('BLOB_STORE_NOT_CONFIGURED')
    } finally {
      await stop()
    }
  })

  test('sync mode resolves { output, files } when the model generated a file', async () => {
    const { bread, stop } = await makeBread({
      agents: { artist: defineTestAgent() },
      model: mockFileGeneratingModel('here is your image', { mediaType: 'image/png', base64: PNG_BASE64 }),
      config: { blobStore: memoryBlobStore() },
    })
    try {
      const { output, files } = await bread.run('artist', 'draw a cat', { mode: 'sync' })
      expect(output).toBe('here is your image')
      expect(files).toHaveLength(1)
      expect(files![0]!.mimeType).toBe('image/png')
    } finally {
      await stop()
    }
  })
})
