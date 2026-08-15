import { describe, expect, test } from 'bun:test'
import { defineTestAgent, makeServer, memoryBlobStore, mockErrorModel, mockFileGeneratingModel, mockTextModel } from '@breadai/test-utils'
import { a2aServer } from '../src/index.js'
import { parseJsonRpcSse } from './sse-helpers.js'

async function setup(model: Parameters<typeof makeServer>[0]['model']) {
  return makeServer({
    agents: { greeter: defineTestAgent() },
    model,
    plugins: [a2aServer({ agentId: 'greeter', url: 'http://localhost/a2a', specVersion: '1.0', cardPath: '/.well-known/agent-card.json' })],
  })
}

function streamRequest() {
  return {
    method: 'POST' as const,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'SendStreamingMessage',
      params: { message: { role: 'ROLE_USER', parts: [{ text: 'hi' }], messageId: 'm1' } },
    }),
  }
}

describe('a2a_server — v1.0 SendStreamingMessage', () => {
  test('streams a Task, an artifact update, then a completed status', async () => {
    const { app, stop } = await setup(mockTextModel('hello there'))
    try {
      const res = await app.request('/a2a', streamRequest())
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('text/event-stream')

      const frames = parseJsonRpcSse(await res.text())
      expect(frames.every((f) => f.jsonrpc === '2.0' && f.id === 1)).toBe(true)

      const results = frames.map((f) => f.result) as Record<string, Record<string, unknown>>[]
      expect(results[0]?.task).toBeDefined()

      const artifactUpdates = results.filter((r) => r.artifactUpdate).map((r) => r.artifactUpdate!)
      expect(artifactUpdates.length).toBeGreaterThan(0)
      expect(artifactUpdates[0]?.append).toBe(false)
      const text = artifactUpdates
        .map((r) => (r.artifact as { parts: { text: string }[] }).parts[0]?.text)
        .join('')
      expect(text).toBe('hello there')

      const last = results.at(-1)?.statusUpdate as { status: { state: string }; final: boolean }
      expect(last).toBeDefined()
      expect(last.status.state).toBe('TASK_STATE_COMPLETED')
      expect(last.final).toBe(true)
    } finally {
      await stop()
    }
  })

  test('streams a failed status on a model error', async () => {
    const { app, stop } = await setup(mockErrorModel('boom'))
    try {
      const res = await app.request('/a2a', streamRequest())
      const frames = parseJsonRpcSse(await res.text())
      const results = frames.map((f) => f.result) as Record<string, Record<string, unknown>>[]

      const last = results.at(-1)?.statusUpdate as { status: { state: string; message: unknown }; final: boolean }
      expect(last).toBeDefined()
      expect(last.status.state).toBe('TASK_STATE_FAILED')
      expect(last.final).toBe(true)
      expect(JSON.stringify(last.status.message)).not.toContain('.ts:')
      expect(JSON.stringify(last.status.message)).toContain('AGENT_ERROR')
    } finally {
      await stop()
    }
  })

  test('streams a model-generated file as an artifact-update file part', async () => {
    const { app, stop } = await makeServer({
      agents: { greeter: defineTestAgent() },
      model: mockFileGeneratingModel('here you go', { mediaType: 'image/png', base64: 'ZmFrZQ==' }),
      plugins: [a2aServer({ agentId: 'greeter', url: 'http://localhost/a2a', specVersion: '1.0', cardPath: '/.well-known/agent-card.json' })],
      config: { blobStore: memoryBlobStore() },
    })
    try {
      const res = await app.request('/a2a', streamRequest())
      const frames = parseJsonRpcSse(await res.text())
      const results = frames.map((f) => f.result) as Record<string, Record<string, unknown>>[]

      const artifactUpdates = results.filter((r) => r.artifactUpdate).map((r) => r.artifactUpdate!)
      const fileUpdate = artifactUpdates.find(
        (r) => ((r.artifact as { parts: { url?: string }[] }).parts[0]?.url ?? undefined) !== undefined,
      )
      expect(fileUpdate).toBeDefined()
      const filePart = (fileUpdate!.artifact as { parts: { url: string; mediaType: string }[] }).parts[0]!
      expect(filePart.url).toStartWith('memory://')
      expect(filePart.mediaType).toBe('image/png')

      const last = results.at(-1)?.statusUpdate as { status: { state: string }; final: boolean }
      expect(last).toBeDefined()
      expect(last.status.state).toBe('TASK_STATE_COMPLETED')
    } finally {
      await stop()
    }
  })
})
