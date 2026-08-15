import { describe, expect, test } from 'bun:test'
import {
  defineTestAgent,
  makeServer,
  memoryBlobStore,
  mockFileGeneratingModel,
  mockObjectModel,
  mockRecordingTextModel,
  mockTextModel,
} from '@bread/test-utils'
import { a2aServer } from '../src/index.js'

async function setup() {
  return makeServer({
    agents: { greeter: defineTestAgent() },
    model: mockTextModel('hello there'),
    plugins: [a2aServer({ agentId: 'greeter', url: 'http://localhost/a2a', specVersion: '1.0', cardPath: '/.well-known/agent-card.json' })],
  })
}

// AI SDK v3 prompt messages carry `content` as an array of typed parts, not a
// raw string — find the text part carrying the JSON-serialized `input`.
function userInputJson(prompt: { role: string; content: unknown }[]): unknown {
  const content = prompt.find((m) => m.role === 'user')?.content as { type: string; text: string }[]
  return JSON.parse(content.find((p) => p.type === 'text')!.text)
}

// Version nibble '7' confirms server-generated ids are uuidv7(), not crypto.randomUUID() (v4).
const UUIDV7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

describe('a2a_server — v1.0 Agent Card', () => {
  test('serves a spec-shaped card with supportedInterfaces', async () => {
    const { app, stop } = await setup()
    try {
      const res = await app.request('/.well-known/agent-card.json')
      expect(res.status).toBe(200)
      const card = (await res.json()) as {
        supportedInterfaces: { url: string; protocolBinding: string; protocolVersion: string }[]
        capabilities: Record<string, boolean>
      }
      expect(card.supportedInterfaces).toEqual([
        { url: 'http://localhost/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
      ])
      expect(card.capabilities).toEqual({
        streaming: true,
        pushNotifications: false,
        extendedAgentCard: false,
      })
    } finally {
      await stop()
    }
  })
})

describe('a2a_server — v1.0 SendMessage', () => {
  test('invokes the agent synchronously and returns a Message', async () => {
    const { app, stop } = await setup()
    try {
      const res = await app.request('/a2a', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'SendMessage',
          params: { message: { role: 'ROLE_USER', parts: [{ text: 'hi' }], messageId: 'm1' } },
        }),
      })
      const body = (await res.json()) as {
        result: { message: { role: string; parts: { text: string }[]; messageId: string } }
      }
      expect(body.result.message.role).toBe('ROLE_AGENT')
      expect(body.result.message.parts).toEqual([{ text: 'hello there' }])
      expect(body.result.message.messageId).toMatch(UUIDV7_RE)
    } finally {
      await stop()
    }
  })

  test('rejects an unknown method with -32601', async () => {
    const { app, stop } = await setup()
    try {
      const res = await app.request('/a2a', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'message/send', params: {} }),
      })
      const body = (await res.json()) as { error: { code: number } }
      expect(body.error.code).toBe(-32601)
    } finally {
      await stop()
    }
  })

  test('rejects a part with none of text/data/url/raw with -32602', async () => {
    const { app, stop } = await setup()
    try {
      const res = await app.request('/a2a', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'SendMessage',
          params: { message: { role: 'ROLE_USER', parts: [{ bogus: true }], messageId: 'm1' } },
        }),
      })
      const body = (await res.json()) as { error: { code: number } }
      expect(body.error.code).toBe(-32602)
    } finally {
      await stop()
    }
  })

  test('rejects inline file bytes ("raw") with -32602 when no blob store is configured', async () => {
    const { app, stop } = await setup()
    try {
      const res = await app.request('/a2a', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'SendMessage',
          params: {
            message: { role: 'ROLE_USER', parts: [{ raw: 'iVBORw0KGgo=', mediaType: 'image/png' }], messageId: 'm1' },
          },
        }),
      })
      const body = (await res.json()) as { error: { code: number; message: string } }
      expect(body.error.code).toBe(-32602)
      expect(body.error.message).toContain('blob store')
    } finally {
      await stop()
    }
  })

  test('rejects inline file bytes over the size limit with -32602, even with a blob store configured', async () => {
    const { app, stop } = await makeServer({
      agents: { greeter: defineTestAgent() },
      model: mockTextModel('hello there'),
      plugins: [a2aServer({ agentId: 'greeter', url: 'http://localhost/a2a', specVersion: '1.0', cardPath: '/.well-known/agent-card.json' })],
      // Raise the server's own default 1MB body cap so this request reaches
      // the FilePart-specific size check instead of tripping BODY_TOO_LARGE
      // first — the two limits are independent, checked at different layers.
      config: { blobStore: memoryBlobStore(), server: { maxBodyBytes: 20 * 1024 * 1024 } },
    })
    try {
      const res = await app.request('/a2a', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'SendMessage',
          params: {
            message: {
              role: 'ROLE_USER',
              // Comfortably over MAX_INLINE_FILE_BYTES (10MB) as a base64 string.
              parts: [{ raw: 'A'.repeat(15 * 1024 * 1024), mediaType: 'image/png' }],
              messageId: 'm1',
            },
          },
        }),
      })
      const body = (await res.json()) as { error: { code: number; message: string } }
      expect(body.error.code).toBe(-32602)
      expect(body.error.message).toContain('limit')
    } finally {
      await stop()
    }
  })

  test('passes a single URL-referenced file part\'s reference directly as input', async () => {
    const { model, calls } = mockRecordingTextModel('hello there')
    const { app, stop } = await makeServer({
      agents: { greeter: defineTestAgent() },
      model,
      plugins: [a2aServer({ agentId: 'greeter', url: 'http://localhost/a2a', specVersion: '1.0', cardPath: '/.well-known/agent-card.json' })],
    })
    try {
      await app.request('/a2a', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'SendMessage',
          params: {
            message: {
              role: 'ROLE_USER',
              parts: [{ url: 'https://example.com/x.png', mediaType: 'image/png', filename: 'x.png' }],
              messageId: 'm1',
            },
          },
        }),
      })
      expect(userInputJson(calls[0]!.prompt as { role: string; content: unknown }[])).toEqual({
        uri: 'https://example.com/x.png',
        mimeType: 'image/png',
        name: 'x.png',
      })
    } finally {
      await stop()
    }
  })

  test('joins a text part and a URL-referenced file part into a tagged-parts array', async () => {
    const { model, calls } = mockRecordingTextModel('hello there')
    const { app, stop } = await makeServer({
      agents: { greeter: defineTestAgent() },
      model,
      plugins: [a2aServer({ agentId: 'greeter', url: 'http://localhost/a2a', specVersion: '1.0', cardPath: '/.well-known/agent-card.json' })],
    })
    try {
      await app.request('/a2a', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'SendMessage',
          params: {
            message: {
              role: 'ROLE_USER',
              parts: [{ text: 'hi' }, { url: 'https://example.com/x.png' }],
              messageId: 'm1',
            },
          },
        }),
      })
      expect(userInputJson(calls[0]!.prompt as { role: string; content: unknown }[])).toEqual([
        { text: 'hi' },
        { file: { uri: 'https://example.com/x.png' } },
      ])
    } finally {
      await stop()
    }
  })

  test('accepts and stores inline file bytes when a blob store is configured', async () => {
    const { model, calls } = mockRecordingTextModel('hello there')
    const blobStore = memoryBlobStore()
    const { app, stop } = await makeServer({
      agents: { greeter: defineTestAgent() },
      model,
      plugins: [a2aServer({ agentId: 'greeter', url: 'http://localhost/a2a', specVersion: '1.0', cardPath: '/.well-known/agent-card.json' })],
      config: { blobStore },
    })
    try {
      const bytes = Buffer.from('hello file').toString('base64')
      await app.request('/a2a', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'SendMessage',
          params: {
            message: {
              role: 'ROLE_USER',
              parts: [{ raw: bytes, mediaType: 'text/plain', filename: 'hi.txt' }],
              messageId: 'm1',
            },
          },
        }),
      })
      const input = userInputJson(calls[0]!.prompt as { role: string; content: unknown }[]) as {
        uri: string
        mimeType: string
        name: string
      }
      expect(input.mimeType).toBe('text/plain')
      expect(input.name).toBe('hi.txt')
      expect(input.uri).toStartWith('memory://')
      const key = input.uri.slice('memory://'.length)
      const stored = await blobStore.get(key)
      expect(stored?.mimeType).toBe('text/plain')
      expect(Buffer.from(stored!.data).toString()).toBe('hello file')
    } finally {
      await stop()
    }
  })

  test('rejects a data part whose data field is not a JSON object with -32602', async () => {
    const { app, stop } = await setup()
    try {
      const res = await app.request('/a2a', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'SendMessage',
          params: { message: { role: 'ROLE_USER', parts: [{ data: 'not an object' }], messageId: 'm1' } },
        }),
      })
      const body = (await res.json()) as { error: { code: number } }
      expect(body.error.code).toBe(-32602)
    } finally {
      await stop()
    }
  })

  test('passes a single data part\'s object directly as input', async () => {
    const { model, calls } = mockRecordingTextModel('hello there')
    const { app, stop } = await makeServer({
      agents: { greeter: defineTestAgent() },
      model,
      plugins: [a2aServer({ agentId: 'greeter', url: 'http://localhost/a2a', specVersion: '1.0', cardPath: '/.well-known/agent-card.json' })],
    })
    try {
      await app.request('/a2a', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'SendMessage',
          params: { message: { role: 'ROLE_USER', parts: [{ data: { foo: 'bar' }, mediaType: 'application/json' }], messageId: 'm1' } },
        }),
      })
      expect(userInputJson(calls[0]!.prompt as { role: string; content: unknown }[])).toEqual({ foo: 'bar' })
    } finally {
      await stop()
    }
  })

  test('joins mixed text and data parts into a tagged-parts array', async () => {
    const { model, calls } = mockRecordingTextModel('hello there')
    const { app, stop } = await makeServer({
      agents: { greeter: defineTestAgent() },
      model,
      plugins: [a2aServer({ agentId: 'greeter', url: 'http://localhost/a2a', specVersion: '1.0', cardPath: '/.well-known/agent-card.json' })],
    })
    try {
      await app.request('/a2a', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'SendMessage',
          params: {
            message: { role: 'ROLE_USER', parts: [{ text: 'hi' }, { data: { a: 1 }, mediaType: 'application/json' }], messageId: 'm1' },
          },
        }),
      })
      expect(userInputJson(calls[0]!.prompt as { role: string; content: unknown }[])).toEqual([{ text: 'hi' }, { data: { a: 1 } }])
    } finally {
      await stop()
    }
  })

  test('wraps non-string agent output in a data Part', async () => {
    const { app, stop } = await makeServer({
      agents: { greeter: defineTestAgent({ config: { output: { format: 'json' } } }) },
      model: mockObjectModel({ foo: 'bar' }),
      plugins: [a2aServer({ agentId: 'greeter', url: 'http://localhost/a2a', specVersion: '1.0', cardPath: '/.well-known/agent-card.json' })],
    })
    try {
      const res = await app.request('/a2a', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'SendMessage',
          params: { message: { role: 'ROLE_USER', parts: [{ text: 'hi' }], messageId: 'm1' } },
        }),
      })
      const body = (await res.json()) as { result: { message: { parts: unknown[] } } }
      expect(body.result.message.parts).toEqual([{ data: { foo: 'bar' }, mediaType: 'application/json' }])
    } finally {
      await stop()
    }
  })

  test('wraps a model-generated file in a response FilePart', async () => {
    const { app, stop } = await makeServer({
      agents: { greeter: defineTestAgent() },
      model: mockFileGeneratingModel('here you go', { mediaType: 'image/png', base64: 'ZmFrZQ==' }),
      plugins: [a2aServer({ agentId: 'greeter', url: 'http://localhost/a2a', specVersion: '1.0', cardPath: '/.well-known/agent-card.json' })],
      config: { blobStore: memoryBlobStore() },
    })
    try {
      const res = await app.request('/a2a', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'SendMessage',
          params: { message: { role: 'ROLE_USER', parts: [{ text: 'draw a cat' }], messageId: 'm1' } },
        }),
      })
      const body = (await res.json()) as { result: { message: { parts: { url?: string; mediaType?: string }[] } } }
      const filePart = body.result.message.parts.find((p) => typeof p.url === 'string')
      expect(filePart?.url).toStartWith('memory://')
      expect(filePart?.mediaType).toBe('image/png')
      expect(body.result.message.parts).toContainEqual({ text: 'here you go' })
    } finally {
      await stop()
    }
  })

  test('wraps a tool-echoed FileOutput agent output in a response FilePart', async () => {
    const { app, stop } = await makeServer({
      agents: {
        greeter: defineTestAgent({
          config: { output: { format: { name: 'file-json', parse: (raw: string) => JSON.parse(raw) } } },
        }),
      },
      model: mockTextModel(JSON.stringify({ kind: 'file', uri: 'https://blob.example/report.pdf', mimeType: 'application/pdf' })),
      plugins: [a2aServer({ agentId: 'greeter', url: 'http://localhost/a2a', specVersion: '1.0', cardPath: '/.well-known/agent-card.json' })],
    })
    try {
      const res = await app.request('/a2a', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'SendMessage',
          params: { message: { role: 'ROLE_USER', parts: [{ text: 'hi' }], messageId: 'm1' } },
        }),
      })
      const body = (await res.json()) as { result: { message: { parts: unknown[] } } }
      expect(body.result.message.parts).toEqual([
        { url: 'https://blob.example/report.pdf', mediaType: 'application/pdf' },
      ])
    } finally {
      await stop()
    }
  })

  test('rejects malformed JSON with -32700', async () => {
    const { app, stop } = await setup()
    try {
      const res = await app.request('/a2a', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{not json',
      })
      const body = (await res.json()) as { error: { code: number } }
      expect(body.error.code).toBe(-32700)
    } finally {
      await stop()
    }
  })
})
