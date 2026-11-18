import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { LanguageModelV4CallOptions } from '@ai-sdk/provider'
import type { BlobStore } from '@breadai/core'
import {
  defineTestAgent,
  makeBread,
  memoryBlobStore,
  mockRecordingTextModel,
  runCollect,
} from '@breadai/test-utils'

type PromptPart = {
  type: string
  text?: string
  mediaType?: string
  data?: { type?: string; data?: unknown; url?: URL | string }
  image?: unknown
}

function userParts(call: LanguageModelV4CallOptions): PromptPart[] {
  const message = call.prompt.find((entry) => entry.role === 'user')
  if (!message || message.role !== 'user') throw new Error('model prompt has no user message')
  return message.content as PromptPart[]
}

function imageBytes(part: PromptPart | undefined): Uint8Array | undefined {
  if (!part?.mediaType?.startsWith('image/')) return undefined
  const raw = part.type === 'file' ? part.data?.data : part.type === 'image' ? part.image : undefined
  if (raw instanceof Uint8Array) return raw
  if (typeof raw === 'string' && !/^[a-z][a-z0-9+.-]*:/i.test(raw)) return Buffer.from(raw, 'base64')
  return undefined
}

describe('runner — image input', () => {
  test('an image mime input arrives as an image part and a plain object stays JSON text', async () => {
    const blobs = memoryBlobStore()
    const bytes = new Uint8Array([1, 2, 3, 4])
    const { url } = await blobs.put(bytes, { mimeType: 'image/png' })
    const plain = { recipe: 'pasta' }
    const { model, calls } = mockRecordingTextModel('seen')
    const { bread, stop } = await makeBread({
      agents: { chef: defineTestAgent() },
      model,
      config: { blobStore: blobs },
    })
    try {
      await runCollect(bread, 'chef', { uri: url, mimeType: 'image/png' })
      const image = userParts(calls[0]!)
      expect(image).toHaveLength(1)
      expect(imageBytes(image[0])).toEqual(bytes)
      expect(image[0]?.type).not.toBe('text')

      await runCollect(bread, 'chef', plain)
      expect(userParts(calls[1]!)).toEqual([{ type: 'text', text: JSON.stringify(plain) }])

      await runCollect(bread, 'chef', { kind: 'file', uri: url, mimeType: 'image/png', name: 'recipe.png' })
      expect(imageBytes(userParts(calls[2]!)[0])).toEqual(bytes)
    } finally {
      await stop()
    }
  })

  test('a parts array keeps text, sends image bytes, and leaves a non-image file as JSON', async () => {
    const blobs = memoryBlobStore()
    const bytes = new Uint8Array([9, 8, 7])
    const { url } = await blobs.put(bytes, { mimeType: 'image/png' })
    const pdf = { file: { uri: 'https://example.com/notes.pdf', mimeType: 'application/pdf' } }
    const { model, calls } = mockRecordingTextModel('seen')
    const { bread, stop } = await makeBread({
      agents: { chef: defineTestAgent() },
      model,
      config: { blobStore: blobs },
    })
    try {
      await runCollect(bread, 'chef', [
        { text: 'what dish is this' },
        { file: { uri: url, mimeType: 'image/png' } },
        pdf,
      ])
      const parts = userParts(calls[0]!)
      expect(parts[0]).toEqual({ type: 'text', text: 'what dish is this' })
      expect(imageBytes(parts[1])).toEqual(bytes)
      expect(parts[2]).toEqual({ type: 'text', text: JSON.stringify(pdf) })
    } finally {
      await stop()
    }
  })

  test('an https image is passed as a url and not fetched', async () => {
    const input = { uri: 'https://images.example/cat.png', mimeType: 'image/png' }
    const { model, calls } = mockRecordingTextModel('seen')
    const fetches: string[] = []
    const original = globalThis.fetch
    globalThis.fetch = (async (resource: unknown) => {
      fetches.push(String(resource))
      throw new Error('bread fetched a url')
    }) as typeof fetch
    const { bread, stop } = await makeBread({
      agents: { chef: defineTestAgent() },
      model,
      config: { blobStore: memoryBlobStore() },
    })
    try {
      await runCollect(bread, 'chef', input)
      expect(fetches).toEqual([])
      const parts = userParts(calls[0]!)
      expect(parts).toEqual([{ type: 'text', text: JSON.stringify(input) }])
      expect(parts.some((part) => part.type === 'image' || part.mediaType?.startsWith('image/'))).toBe(false)
    } finally {
      globalThis.fetch = original
      await stop()
    }
  })

  test('an http image url stays JSON text', async () => {
    const input = { uri: 'http://images.example/cat.png', mimeType: 'image/png' }
    const { model, calls } = mockRecordingTextModel('seen')
    const fetches: string[] = []
    const original = globalThis.fetch
    globalThis.fetch = (async (resource: unknown) => {
      fetches.push(String(resource))
      throw new Error('bread fetched a url')
    }) as typeof fetch
    const { bread, stop } = await makeBread({
      agents: { chef: defineTestAgent() },
      model,
      config: { blobStore: memoryBlobStore() },
    })
    try {
      await runCollect(bread, 'chef', input)
      expect(fetches).toEqual([])
      expect(userParts(calls[0]!)).toEqual([{ type: 'text', text: JSON.stringify(input) }])
    } finally {
      globalThis.fetch = original
      await stop()
    }
  })

  test('a file url that is not our blob is not read', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bread-image-'))
    const path = join(dir, 'recipe.png')
    const secret = 'bread-secret-pixels-9f3a'
    await writeFile(path, secret)
    const input = { uri: pathToFileURL(path).href, mimeType: 'image/png' }
    const { model, calls } = mockRecordingTextModel('seen')
    const { bread, stop } = await makeBread({
      agents: { chef: defineTestAgent() },
      model,
      config: { blobStore: memoryBlobStore() },
    })
    try {
      await runCollect(bread, 'chef', input)
      const parts = userParts(calls[0]!)
      expect(parts).toEqual([{ type: 'text', text: JSON.stringify(input) }])
      expect(JSON.stringify(calls[0]!.prompt)).not.toContain(secret)
    } finally {
      await stop()
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('a file url this blob store issued is loaded with get', async () => {
    const bytes = new Uint8Array([7, 7, 7])
    const key = 'owned-key'
    const seen: string[] = []
    const blobs: BlobStore = {
      async put() {
        return { key, url: `file:///tmp/blobs/${key}` }
      },
      async get(id) {
        seen.push(id)
        return id === key ? { data: bytes, mimeType: 'image/png' } : undefined
      },
    }
    const { model, calls } = mockRecordingTextModel('seen')
    const { bread, stop } = await makeBread({
      agents: { chef: defineTestAgent() },
      model,
      config: { blobStore: blobs },
    })
    try {
      await runCollect(bread, 'chef', { uri: `file:///tmp/blobs/${key}`, mimeType: 'image/png' })
      expect(seen).toEqual([key])
      expect(imageBytes(userParts(calls[0]!)[0])).toEqual(bytes)
    } finally {
      await stop()
    }
  })

  test('the next turn still shows the image', async () => {
    const blobs = memoryBlobStore()
    const bytes = new Uint8Array([4, 5, 6])
    const { url } = await blobs.put(bytes, { mimeType: 'image/jpeg' })
    const { model, calls } = mockRecordingTextModel('seen')
    const { bread, stop } = await makeBread({
      agents: { chef: defineTestAgent() },
      model,
      config: { blobStore: blobs },
    })
    try {
      const first = await runCollect(bread, 'chef', { uri: url, mimeType: 'image/jpeg' }, { session: { id: 'chef' } })
      await runCollect(bread, 'chef', 'what is it', { session: { id: first[0]!.sessionId } })
      const users = calls[1]!.prompt.filter((message) => message.role === 'user')
      expect(imageBytes((users[0]!.content as PromptPart[])[0])).toEqual(bytes)
      expect(users[1]!.content).toEqual([{ type: 'text', text: 'what is it' }])
      const stored = await bread.store.getMessages(first[0]!.sessionId)
      const user = stored.find((message) => message.role === 'user')
      const storedPart = (user?.content as PromptPart[])[0]
      expect(storedPart?.type).toBe('image')
      expect(storedPart?.mediaType).toBe('image/jpeg')
    } finally {
      await stop()
    }
  })
})
