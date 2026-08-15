import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { defineHumanTool } from '@breadai/core'
import {
  collect,
  defineTestAgent,
  makeServer,
  mockChunkedTextModel,
  mockTextModel,
  mockToolCallModel,
  runCollect,
} from '@breadai/test-utils'
import { a2aServer } from '../src/index.js'
import { parseJsonRpcSse, readBodyToEnd, readBodyUntil } from './sse-helpers.js'

const json = { 'content-type': 'application/json' }

const gateAgent = () => {
  const approve = defineHumanTool('approve', z.object({ question: z.string() }))
  return defineTestAgent({ humanTools: [approve] })
}
const gateModel = () => mockToolCallModel({ toolName: 'human_approve', args: { question: 'ok?' }, then: 'approved' })

function rpc(method: string, params: unknown, id: unknown = 1) {
  return { method: 'POST' as const, headers: json, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) }
}

describe('a2a_server — v0.3 tasks/get', () => {
  test('returns completed status for a finished run', async () => {
    const { app, bread, stop } = await makeServer({
      agents: { greeter: defineTestAgent() },
      model: mockTextModel('hi'),
      plugins: [a2aServer({ agentId: 'greeter', url: 'http://localhost/a2a', cardPath: '/.well-known/agent-card.json' })],
    })
    try {
      const events = await runCollect(bread, 'greeter', 'go')
      const runId = (events.find((e) => e.type === 'agent:run:start') as { runId: string }).runId

      const res = await app.request('/a2a', rpc('tasks/get', { id: runId }))
      const body = (await res.json()) as { result: { id: string; status: { state: string } } }
      expect(body.result.id).toBe(runId)
      expect(body.result.status.state).toBe('completed')
    } finally {
      await stop()
    }
  })

  test('returns TaskNotFoundError for an unknown id', async () => {
    const { app, stop } = await makeServer({
      agents: { greeter: defineTestAgent() },
      model: mockTextModel('hi'),
      plugins: [a2aServer({ agentId: 'greeter', url: 'http://localhost/a2a', cardPath: '/.well-known/agent-card.json' })],
    })
    try {
      const res = await app.request('/a2a', rpc('tasks/get', { id: 'nonexistent' }))
      const body = (await res.json()) as { error: { code: number } }
      expect(body.error.code).toBe(-32001)
    } finally {
      await stop()
    }
  })

  test('returns input-required status for a suspended run', async () => {
    const { app, bread, stop } = await makeServer({
      agents: { gate: gateAgent() },
      model: gateModel(),
      plugins: [a2aServer({ agentId: 'gate', url: 'http://localhost/a2a', cardPath: '/.well-known/agent-card.json' })],
    })
    try {
      const events = await runCollect(bread, 'gate', 'go')
      const runId = (events.find((e) => e.type === 'agent:run:start') as { runId: string }).runId

      const res = await app.request('/a2a', rpc('tasks/get', { id: runId }))
      const body = (await res.json()) as { result: { status: { state: string } } }
      expect(body.result.status.state).toBe('input-required')
    } finally {
      await stop()
    }
  })
})

describe('a2a_server — v0.3 tasks/resubscribe', () => {
  test('returns TaskNotFoundError for an unknown id', async () => {
    const { app, stop } = await makeServer({
      agents: { greeter: defineTestAgent() },
      model: mockTextModel('hi'),
      plugins: [a2aServer({ agentId: 'greeter', url: 'http://localhost/a2a', cardPath: '/.well-known/agent-card.json' })],
    })
    try {
      const res = await app.request('/a2a', rpc('tasks/resubscribe', { id: 'nonexistent' }))
      const body = (await res.json()) as { error: { code: number } }
      expect(body.error.code).toBe(-32001)
    } finally {
      await stop()
    }
  })

  test('returns UnsupportedOperationError for an already-completed task', async () => {
    const { app, bread, stop } = await makeServer({
      agents: { greeter: defineTestAgent() },
      model: mockTextModel('hi'),
      plugins: [a2aServer({ agentId: 'greeter', url: 'http://localhost/a2a', cardPath: '/.well-known/agent-card.json' })],
    })
    try {
      const events = await runCollect(bread, 'greeter', 'go')
      const runId = (events.find((e) => e.type === 'agent:run:start') as { runId: string }).runId

      const res = await app.request('/a2a', rpc('tasks/resubscribe', { id: runId }))
      const body = (await res.json()) as { error: { code: number } }
      expect(body.error.code).toBe(-32004)
    } finally {
      await stop()
    }
  })

  test('reattaches mid-stream: replays the suspended task then tails the continuation', async () => {
    const { app, bread, stop } = await makeServer({
      agents: { gate: gateAgent() },
      model: gateModel(),
      plugins: [a2aServer({ agentId: 'gate', url: 'http://localhost/a2a', cardPath: '/.well-known/agent-card.json' })],
    })
    try {
      const events = await runCollect(bread, 'gate', 'go')
      const runId = (events.find((e) => e.type === 'agent:run:start') as { runId: string }).runId
      const checkpointId = (events.find((e) => e.type === 'human:required') as { checkpointId: string }).checkpointId

      const res = await app.request('/a2a', rpc('tasks/resubscribe', { id: runId }))
      expect(res.status).toBe(200)
      const reader = res.body!.getReader()
      const acc = { text: '' }
      // The replay yields the initial Task event (agent:run:start) then goes
      // quiet — human:required isn't mapped to any A2A event, same gap the
      // live message/stream path already has.
      await readBodyUntil(reader, acc, '"kind":"task"')

      const contEvents = await collect(bread.resume(checkpointId, { approved: true }))
      expect(contEvents.map((e) => e.type)).toContain('agent:run:end')

      await readBodyToEnd(reader, acc)
      const results = parseJsonRpcSse(acc.text).map((f) => f.result) as Record<string, unknown>[]

      expect(results[0]?.kind).toBe('task')
      const last = results.at(-1) as { kind: string; status: { state: string }; final: boolean }
      expect(last.kind).toBe('status-update')
      expect(last.status.state).toBe('completed')
      expect(last.final).toBe(true)
    } finally {
      await stop()
    }
  })
})

describe('a2a_server — v0.3 tasks/cancel', () => {
  test('returns TaskNotFoundError for an unknown id', async () => {
    const { app, stop } = await makeServer({
      agents: { greeter: defineTestAgent() },
      model: mockTextModel('hi'),
      plugins: [a2aServer({ agentId: 'greeter', url: 'http://localhost/a2a', cardPath: '/.well-known/agent-card.json' })],
    })
    try {
      const res = await app.request('/a2a', rpc('tasks/cancel', { id: 'nonexistent' }))
      const body = (await res.json()) as { error: { code: number } }
      expect(body.error.code).toBe(-32001)
    } finally {
      await stop()
    }
  })

  test('returns TaskNotCancelableError for an already-completed task', async () => {
    const { app, bread, stop } = await makeServer({
      agents: { greeter: defineTestAgent() },
      model: mockTextModel('hi'),
      plugins: [a2aServer({ agentId: 'greeter', url: 'http://localhost/a2a', cardPath: '/.well-known/agent-card.json' })],
    })
    try {
      const events = await runCollect(bread, 'greeter', 'go')
      const runId = (events.find((e) => e.type === 'agent:run:start') as { runId: string }).runId

      const res = await app.request('/a2a', rpc('tasks/cancel', { id: runId }))
      const body = (await res.json()) as { error: { code: number } }
      expect(body.error.code).toBe(-32002)
    } finally {
      await stop()
    }
  })

  test('returns TaskNotCancelableError for a still-active task this instance never registered', async () => {
    // A run driven directly via bread.run() (not through this a2aServer's own
    // message/stream) — its crumb log shows it suspended (still cancelable in
    // principle), but no AbortController was ever registered for it, since
    // registration only happens inside runToA2AEventsV03.
    const approve = defineHumanTool('approve', z.object({ question: z.string() }))
    const { app, bread, stop } = await makeServer({
      agents: { gate: defineTestAgent({ humanTools: [approve] }) },
      model: mockToolCallModel({ toolName: 'human_approve', args: { question: 'ok?' }, then: 'done' }),
      plugins: [a2aServer({ agentId: 'gate', url: 'http://localhost/a2a', cardPath: '/.well-known/agent-card.json' })],
    })
    try {
      const events = await runCollect(bread, 'gate', 'go')
      const runId = (events.find((e) => e.type === 'agent:run:start') as { runId: string }).runId

      const res = await app.request('/a2a', rpc('tasks/cancel', { id: runId }))
      const body = (await res.json()) as { error: { code: number } }
      expect(body.error.code).toBe(-32002)
    } finally {
      await stop()
    }
  })

  test('cancels a live message/stream task: the cancel response, the stream itself, and a follow-up tasks/get all agree', async () => {
    const { app, stop } = await makeServer({
      agents: { greeter: defineTestAgent() },
      model: mockChunkedTextModel(['a', 'b', 'c', 'd'], 20),
      plugins: [a2aServer({ agentId: 'greeter', url: 'http://localhost/a2a', cardPath: '/.well-known/agent-card.json' })],
    })
    try {
      const streamRes = await app.request('/a2a', {
        method: 'POST',
        headers: json,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'message/stream',
          params: { message: { role: 'user', parts: [{ kind: 'text', text: 'hi' }], messageId: 'm1', kind: 'message' } },
        }),
      })
      const reader = streamRes.body!.getReader()
      const acc = { text: '' }
      await readBodyUntil(reader, acc, '"kind":"task"')
      const taskId = (parseJsonRpcSse(acc.text)[0]!.result as { id: string }).id

      const cancelRes = await app.request('/a2a', rpc('tasks/cancel', { id: taskId }, 2))
      const cancelBody = (await cancelRes.json()) as { result: { status: { state: string } } }
      expect(cancelBody.result.status.state).toBe('canceled')

      await readBodyToEnd(reader, acc)
      const streamResults = parseJsonRpcSse(acc.text).map((f) => f.result) as Record<string, unknown>[]
      const last = streamResults.at(-1) as { kind: string; status: { state: string }; final: boolean }
      expect(last.kind).toBe('status-update')
      expect(last.status.state).toBe('canceled')
      expect(last.final).toBe(true)

      const getRes = await app.request('/a2a', rpc('tasks/get', { id: taskId }, 3))
      const getBody = (await getRes.json()) as { result: { status: { state: string } } }
      expect(getBody.result.status.state).toBe('canceled')
    } finally {
      await stop()
    }
  })
})
