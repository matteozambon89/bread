import { describe, expect, test } from 'bun:test'
import {
  defineTestAgent,
  makeServer,
  memoryBlobStore,
  mockFileGeneratingModel,
  mockObjectModel,
  mockRecordingTextModel,
  mockTextModel,
} from '@breadai/test-utils'
import { a2aServer } from '../src/index.js'

async function setup() {
  return makeServer({
    agents: { greeter: defineTestAgent() },
    model: mockTextModel('hello there'),
    plugins: [a2aServer({ agentId: 'greeter', url: 'http://localhost/a2a', cardPath: '/.well-known/agent-card.json' })],
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

describe('a2a_server — v0.3 Agent Card', () => {
  test('serves a spec-shaped card at the well-known path', async () => {
    const { app, stop } = await setup()
    try {
      const res = await app.request('/.well-known/agent-card.json')
      expect(res.status).toBe(200)
      const card = (await res.json()) as Record<string, unknown>
      expect(card.protocolVersion).toBe('0.3.0')
      expect(card.name).toBe('greeter')
      expect(card.url).toBe('http://localhost/a2a')
      expect(card.capabilities).toEqual({
        streaming: true,
        pushNotifications: false,
        stateTransitionHistory: false,
      })
      expect(card.defaultInputModes).toEqual(['text/plain'])
      expect(card.skills).toEqual([
        { id: 'greeter', name: 'greeter', description: 'Agent "greeter"', tags: [] },
      ])
    } finally {
      await stop()
    }
  })

  test('maps loader-injected cfg._skills onto the card, one AgentSkill per skill', async () => {
    const agent = defineTestAgent()
    // Loader-injected private field (see CLAUDE.md's "Loader-injected config
    // internals" table) — manually set here the same way
    // transports/http-chunked/test/skill-traversal.test.ts injects `_agentDir`.
    ;(agent.config as unknown as Record<string, unknown>)._skills = [
      { id: 'greet', meta: { name: 'Greet', description: 'Say hello' } },
      { id: 'farewell', meta: { name: 'Farewell', description: 'Say goodbye' } },
    ]
    const { app, stop } = await makeServer({
      agents: { greeter: agent },
      model: mockTextModel('hello there'),
      plugins: [a2aServer({ agentId: 'greeter', url: 'http://localhost/a2a', cardPath: '/.well-known/agent-card.json' })],
    })
    try {
      const res = await app.request('/.well-known/agent-card.json')
      const card = (await res.json()) as Record<string, unknown>
      expect(card.skills).toEqual([
        { id: 'greet', name: 'Greet', description: 'Say hello', tags: [] },
        { id: 'farewell', name: 'Farewell', description: 'Say goodbye', tags: [] },
      ])
    } finally {
      await stop()
    }
  })
})

describe('a2a_server — v0.3 message/send', () => {
  test('invokes the agent synchronously and returns a Message', async () => {
    const { app, stop } = await setup()
    try {
      const res = await app.request('/a2a', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'message/send',
          params: {
            message: { role: 'user', parts: [{ kind: 'text', text: 'hi' }], messageId: 'm1', kind: 'message' },
          },
        }),
      })
      const body = (await res.json()) as {
        result: { kind: string; parts: { kind: string; text: string }[]; messageId: string }
      }
      expect(body.result.kind).toBe('message')
      expect(body.result.parts).toEqual([{ kind: 'text', text: 'hello there' }])
      expect(body.result.messageId).toMatch(UUIDV7_RE)
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
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tasks/bogus', params: {} }),
      })
      const body = (await res.json()) as { error: { code: number } }
      expect(body.error.code).toBe(-32601)
    } finally {
      await stop()
    }
  })

  test('rejects a malformed envelope (missing jsonrpc/method) with -32600 Invalid Request', async () => {
    const { app, stop } = await setup()
    try {
      const res = await app.request('/a2a', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 1, params: {} }), // no jsonrpc, no method
      })
      const body = (await res.json()) as { error: { code: number; message: string }; id: unknown }
      expect(body.error.code).toBe(-32600)
      expect(body.error.message).toBe('Invalid Request')
      expect(body.id).toBe(1)
    } finally {
      await stop()
    }
  })

  test('rejects a message with no text parts with -32602', async () => {
    const { app, stop } = await setup()
    try {
      const res = await app.request('/a2a', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'message/send',
          params: { message: { role: 'user', parts: [], messageId: 'm1', kind: 'message' } },
        }),
      })
      const body = (await res.json()) as { error: { code: number } }
      expect(body.error.code).toBe(-32602)
    } finally {
      await stop()
    }
  })

  test('rejects inline file bytes with -32602 when no blob store is configured', async () => {
    const { app, stop } = await setup()
    try {
      const res = await app.request('/a2a', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'message/send',
          params: {
            message: {
              role: 'user',
              parts: [{ kind: 'file', file: { fileWithBytes: 'iVBORw0KGgo=', mimeType: 'image/png' } }],
              messageId: 'm1',
              kind: 'message',
            },
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
      plugins: [a2aServer({ agentId: 'greeter', url: 'http://localhost/a2a', cardPath: '/.well-known/agent-card.json' })],
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
          method: 'message/send',
          params: {
            message: {
              role: 'user',
              // Comfortably over MAX_INLINE_FILE_BYTES (10MB) as a base64 string.
              parts: [{ kind: 'file', file: { fileWithBytes: 'A'.repeat(15 * 1024 * 1024), mimeType: 'image/png' } }],
              messageId: 'm1',
              kind: 'message',
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

  test('passes a single URI-referenced file part\'s reference directly as input', async () => {
    const { model, calls } = mockRecordingTextModel('hello there')
    const { app, stop } = await makeServer({
      agents: { greeter: defineTestAgent() },
      model,
      plugins: [a2aServer({ agentId: 'greeter', url: 'http://localhost/a2a', cardPath: '/.well-known/agent-card.json' })],
    })
    try {
      await app.request('/a2a', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'message/send',
          params: {
            message: {
              role: 'user',
              parts: [{ kind: 'file', file: { fileWithUri: 'https://example.com/x.png', mimeType: 'image/png', name: 'x.png' } }],
              messageId: 'm1',
              kind: 'message',
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

  test('joins a text part and a URI-referenced file part into a tagged-parts array', async () => {
    const { model, calls } = mockRecordingTextModel('hello there')
    const { app, stop } = await makeServer({
      agents: { greeter: defineTestAgent() },
      model,
      plugins: [a2aServer({ agentId: 'greeter', url: 'http://localhost/a2a', cardPath: '/.well-known/agent-card.json' })],
    })
    try {
      await app.request('/a2a', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'message/send',
          params: {
            message: {
              role: 'user',
              parts: [
                { kind: 'text', text: 'hi' },
                { kind: 'file', file: { fileWithUri: 'https://example.com/x.png' } },
              ],
              messageId: 'm1',
              kind: 'message',
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
      plugins: [a2aServer({ agentId: 'greeter', url: 'http://localhost/a2a', cardPath: '/.well-known/agent-card.json' })],
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
          method: 'message/send',
          params: {
            message: {
              role: 'user',
              parts: [{ kind: 'file', file: { fileWithBytes: bytes, mimeType: 'text/plain', name: 'hi.txt' } }],
              messageId: 'm1',
              kind: 'message',
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
          method: 'message/send',
          params: {
            message: { role: 'user', parts: [{ kind: 'data', data: 'not an object' }], messageId: 'm1', kind: 'message' },
          },
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
      plugins: [a2aServer({ agentId: 'greeter', url: 'http://localhost/a2a', cardPath: '/.well-known/agent-card.json' })],
    })
    try {
      await app.request('/a2a', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'message/send',
          params: {
            message: { role: 'user', parts: [{ kind: 'data', data: { foo: 'bar' } }], messageId: 'm1', kind: 'message' },
          },
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
      plugins: [a2aServer({ agentId: 'greeter', url: 'http://localhost/a2a', cardPath: '/.well-known/agent-card.json' })],
    })
    try {
      await app.request('/a2a', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'message/send',
          params: {
            message: {
              role: 'user',
              parts: [{ kind: 'text', text: 'hi' }, { kind: 'data', data: { a: 1 } }],
              messageId: 'm1',
              kind: 'message',
            },
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
      plugins: [a2aServer({ agentId: 'greeter', url: 'http://localhost/a2a', cardPath: '/.well-known/agent-card.json' })],
    })
    try {
      const res = await app.request('/a2a', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'message/send',
          params: {
            message: { role: 'user', parts: [{ kind: 'text', text: 'hi' }], messageId: 'm1', kind: 'message' },
          },
        }),
      })
      const body = (await res.json()) as { result: { parts: unknown[] } }
      expect(body.result.parts).toEqual([{ kind: 'data', data: { foo: 'bar' } }])
    } finally {
      await stop()
    }
  })

  test('wraps a model-generated file in a response FilePart', async () => {
    const { app, stop } = await makeServer({
      agents: { greeter: defineTestAgent() },
      model: mockFileGeneratingModel('here you go', { mediaType: 'image/png', base64: 'ZmFrZQ==' }),
      plugins: [a2aServer({ agentId: 'greeter', url: 'http://localhost/a2a', cardPath: '/.well-known/agent-card.json' })],
      config: { blobStore: memoryBlobStore() },
    })
    try {
      const res = await app.request('/a2a', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'message/send',
          params: {
            message: { role: 'user', parts: [{ kind: 'text', text: 'draw a cat' }], messageId: 'm1', kind: 'message' },
          },
        }),
      })
      const body = (await res.json()) as { result: { parts: { kind: string; file?: { fileWithUri: string; mimeType: string } }[] } }
      const filePart = body.result.parts.find((p) => p.kind === 'file')
      expect(filePart?.file?.fileWithUri).toStartWith('memory://')
      expect(filePart?.file?.mimeType).toBe('image/png')
      expect(body.result.parts).toContainEqual({ kind: 'text', text: 'here you go' })
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
      plugins: [a2aServer({ agentId: 'greeter', url: 'http://localhost/a2a', cardPath: '/.well-known/agent-card.json' })],
    })
    try {
      const res = await app.request('/a2a', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'message/send',
          params: {
            message: { role: 'user', parts: [{ kind: 'text', text: 'hi' }], messageId: 'm1', kind: 'message' },
          },
        }),
      })
      const body = (await res.json()) as { result: { parts: unknown[] } }
      expect(body.result.parts).toEqual([
        { kind: 'file', file: { fileWithUri: 'https://blob.example/report.pdf', mimeType: 'application/pdf' } },
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
