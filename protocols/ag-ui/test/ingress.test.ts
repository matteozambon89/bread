import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { defineTool } from '@bread/core'
import { defineTestAgent, makeServer, mockErrorModel, mockStreamingToolCallModel, mockTextModel } from '@bread/test-utils'
import { agUi } from '@bread/protocol-ag-ui'
import type { AgUiEvent } from '@bread/protocol-ag-ui'

// AG-UI's ingress frames are bare `data: {event json}\n\n` — no JSON-RPC
// envelope, unlike a2a-server's wire format.
function parseAgUiSse(body: string): AgUiEvent[] {
  return body
    .split('\n\n')
    .map((block) => block.split('\n').find((l) => l.startsWith('data: '))?.slice(6))
    .filter((data): data is string => !!data)
    .map((data) => JSON.parse(data))
}

function runAgentInput(threadId: string, content: string) {
  return {
    method: 'POST' as const,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      threadId,
      runId: 'run-ignored-by-bread',
      state: null,
      messages: [{ id: 'm1', role: 'user', content }],
      tools: [],
      context: [],
      forwardedProps: null,
    }),
  }
}

describe('agUi plugin — HTTP ingress (RunAgentInput)', () => {
  test('a real app.request() round-trip streams RUN_STARTED → TEXT_MESSAGE_* → RUN_FINISHED', async () => {
    const { app, stop } = await makeServer({
      agents: { greeter: defineTestAgent() },
      model: mockTextModel('hello there'),
      plugins: [agUi({ agentId: 'greeter' })],
    })
    try {
      const res = await app.request('/ag-ui/run', runAgentInput('thread-1', 'hi'))
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('text/event-stream')

      const events = parseAgUiSse(await res.text())
      const types = events.map((e) => e.type)

      expect(types[0]).toBe('RUN_STARTED')
      expect(types.at(-1)).toBe('RUN_FINISHED')
      expect(types).toContain('TEXT_MESSAGE_START')
      expect(types).toContain('TEXT_MESSAGE_CONTENT')
      expect(types).toContain('TEXT_MESSAGE_END')
      // Exactly one terminal event — no double RUN_FINISHED/RUN_ERROR.
      expect(types.filter((t) => t === 'RUN_FINISHED' || t === 'RUN_ERROR')).toHaveLength(1)

      const started = events[0] as Extract<AgUiEvent, { type: 'RUN_STARTED' }>
      expect(started.threadId).toBe('thread-1')

      const text = events
        .filter((e): e is Extract<AgUiEvent, { type: 'TEXT_MESSAGE_CONTENT' }> => e.type === 'TEXT_MESSAGE_CONTENT')
        .map((e) => e.delta)
        .join('')
      expect(text).toBe('hello there')
    } finally {
      await stop()
    }
  })

  test('a real streaming tool call over the HTTP route streams real per-chunk TOOL_CALL_ARGS deltas', async () => {
    const add = defineTool({
      name: 'add',
      description: 'Add two numbers',
      schema: z.object({ a: z.number(), b: z.number() }),
      execute: async ({ a, b }) => ({ sum: a + b }),
    })
    const args = JSON.stringify({ a: 2, b: 3 })
    const argChunks = [args.slice(0, 5), args.slice(5, 10), args.slice(10)]
    const { app, stop } = await makeServer({
      agents: { calc: defineTestAgent({ tools: [add] }) },
      model: mockStreamingToolCallModel({ toolName: 'tool_add', argChunks, then: 'It is 5' }),
      plugins: [agUi({ agentId: 'calc' })],
    })
    try {
      const res = await app.request('/ag-ui/run', runAgentInput('thread-tool', 'add 2 and 3'))
      expect(res.status).toBe(200)

      const events = parseAgUiSse(await res.text())
      const types = events.map((e) => e.type)
      const argsEvents = events.filter((e) => e.type === 'TOOL_CALL_ARGS') as Extract<
        AgUiEvent,
        { type: 'TOOL_CALL_ARGS' }
      >[]

      expect(argsEvents.map((e) => e.delta)).toEqual(argChunks)
      expect(types.filter((t) => t === 'TOOL_CALL_START')).toHaveLength(1)
      expect(types.filter((t) => t === 'TOOL_CALL_END')).toHaveLength(1)
      expect(types).toContain('TOOL_CALL_RESULT')
      expect(types.at(-1)).toBe('RUN_FINISHED')
    } finally {
      await stop()
    }
  })

  test('a model failure streams exactly one RUN_ERROR, not a double-emit', async () => {
    const { app, stop } = await makeServer({
      agents: { greeter: defineTestAgent() },
      model: mockErrorModel('boom'),
      plugins: [agUi({ agentId: 'greeter' })],
    })
    try {
      const res = await app.request('/ag-ui/run', runAgentInput('thread-2', 'hi'))
      expect(res.status).toBe(200)

      const events = parseAgUiSse(await res.text())
      const types = events.map((e) => e.type)

      expect(types).toContain('RUN_ERROR')
      expect(types.filter((t) => t === 'RUN_ERROR')).toHaveLength(1)
      // The catch-block fallback must not have fired alongside the crumb-mapped one.
      expect(types.at(-1)).toBe('RUN_ERROR')
    } finally {
      await stop()
    }
  })

  test('a malformed RunAgentInput is rejected before any run starts', async () => {
    const { app, stop } = await makeServer({
      agents: { greeter: defineTestAgent() },
      model: mockTextModel('unused'),
      plugins: [agUi({ agentId: 'greeter' })],
    })
    try {
      const res = await app.request('/ag-ui/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [] }), // no threadId, empty messages
      })
      expect(res.status).toBe(400)
      const body = (await res.json()) as { error: string }
      expect(body.error).toContain('threadId')
    } finally {
      await stop()
    }
  })

  test('an empty messages array is rejected even with a valid threadId', async () => {
    const { app, stop } = await makeServer({
      agents: { greeter: defineTestAgent() },
      model: mockTextModel('unused'),
      plugins: [agUi({ agentId: 'greeter' })],
    })
    try {
      const res = await app.request('/ag-ui/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ threadId: 'thread-4', messages: [] }),
      })
      expect(res.status).toBe(400)
      const body = (await res.json()) as { error: string }
      expect(body.error).toContain('messages')
    } finally {
      await stop()
    }
  })

  test('a non-text last message is rejected', async () => {
    const { app, stop } = await makeServer({
      agents: { greeter: defineTestAgent() },
      model: mockTextModel('unused'),
      plugins: [agUi({ agentId: 'greeter' })],
    })
    try {
      const res = await app.request('/ag-ui/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ threadId: 'thread-5', messages: [{ id: 'm1', role: 'user', content: 123 }] }),
      })
      expect(res.status).toBe(400)
      const body = (await res.json()) as { error: string }
      expect(body.error).toContain('content')
    } finally {
      await stop()
    }
  })

  test('a body that is not valid JSON is rejected', async () => {
    const { app, stop } = await makeServer({
      agents: { greeter: defineTestAgent() },
      model: mockTextModel('unused'),
      plugins: [agUi({ agentId: 'greeter' })],
    })
    try {
      const res = await app.request('/ag-ui/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{not json',
      })
      expect(res.status).toBe(400)
      const body = (await res.json()) as { error: string }
      expect(body.error).toContain('JSON')
    } finally {
      await stop()
    }
  })

  test('a misconfigured agentId (no matching agent) synthesizes RUN_ERROR — no crumb is ever emitted to map', async () => {
    const { app, stop } = await makeServer({
      agents: { greeter: defineTestAgent() },
      model: mockTextModel('unused'),
      plugins: [agUi({ agentId: 'ghost' })], // 'ghost' isn't a registered agent
    })
    try {
      const res = await app.request('/ag-ui/run', runAgentInput('thread-6', 'hi'))
      expect(res.status).toBe(200)

      const events = parseAgUiSse(await res.text())
      const types = events.map((e) => e.type)
      // No agent:run:start ever fires, so this exercises the catch block's own
      // synthesized RUN_ERROR (the terminalCrumbSeen=false path), not the
      // crumb-mapped one the other failure test covers.
      expect(types).toEqual(['RUN_ERROR'])
      const error = events[0] as Extract<AgUiEvent, { type: 'RUN_ERROR' }>
      expect(error.message).toContain('ghost')
    } finally {
      await stop()
    }
  })

  test('agUi() without agentId registers no route (output-mapper-only, backward compatible)', async () => {
    const { app, stop } = await makeServer({
      agents: { greeter: defineTestAgent() },
      model: mockTextModel('hi'),
      plugins: [agUi({ onEvent: () => {} })],
    })
    try {
      const res = await app.request('/ag-ui/run', runAgentInput('thread-3', 'hi'))
      expect(res.status).toBe(404)
    } finally {
      await stop()
    }
  })
})
