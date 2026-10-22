import { describe, expect, test } from 'bun:test'
import type { AuthIdentity, BreadAuthStrategy, BreadInstance, Principal } from '@breadai/core'
import { authPlugin } from '@breadai/server'
import { defineTestAgent, makeServer, mockTextModel } from '@breadai/test-utils'
import type { AgUiEvent } from '@breadai/protocol-ag-ui'
import { agUi } from '@breadai/protocol-ag-ui'

const alice: Principal = { iss: 'https://idp.example', sub: 'alice', tenant: 'acme' }
const bob: Principal = { iss: 'https://idp.example', sub: 'bob', tenant: 'acme' }

const strategy: BreadAuthStrategy = {
  name: 'header',
  authenticate(req: Request): AuthIdentity | null {
    const raw = req.headers.get('x-principal')
    if (raw == null) return null
    if (raw === 'none') return { subject: 'anon' }
    return { subject: 'user', principal: JSON.parse(raw) as Principal }
  },
}

function runAgentInput(threadId: string, content: string, principal: Principal | 'none') {
  return {
    method: 'POST' as const,
    headers: {
      'content-type': 'application/json',
      'x-principal': principal === 'none' ? 'none' : JSON.stringify(principal),
    },
    body: JSON.stringify({
      threadId,
      messages: [{ id: 'm1', role: 'user', content }],
    }),
  }
}

function parseAgUiSse(body: string): AgUiEvent[] {
  return body
    .split('\n\n')
    .map((block) => block.split('\n').find((line) => line.startsWith('data: '))?.slice(6))
    .filter((data): data is string => !!data)
    .map((data) => JSON.parse(data) as AgUiEvent)
}

describe('agUi plugin — run principal', () => {
  test('auth without a principal is 403 before the run', async () => {
    const { app, bread, stop } = await makeServer({
      agents: { greeter: defineTestAgent() },
      model: mockTextModel('hi'),
      plugins: [authPlugin([strategy]), agUi({ agentId: 'greeter' })],
      config: { server: { authorize: () => true } },
    })
    let runs = 0
    const run = bread.run.bind(bread)
    bread.run = ((...args: Parameters<BreadInstance['run']>) => {
      runs += 1
      return run(...args)
    }) as BreadInstance['run']
    try {
      const res = await app.request('/ag-ui/run', runAgentInput('thread-1', 'hi', 'none'))
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: 'Forbidden' })
      expect(runs).toBe(0)
    } finally {
      await stop()
    }
  })

  test("a caller cannot read or write another principal's thread", async () => {
    const { app, bread, stop } = await makeServer({
      agents: { greeter: defineTestAgent() },
      model: mockTextModel('hello there'),
      plugins: [authPlugin([strategy]), agUi({ agentId: 'greeter' })],
      config: { server: { authorize: () => true } },
    })
    try {
      await bread.store.createSession({ id: 'bob-thread', principal: bob })
      await bread.store.addMessage('bob-thread', { role: 'user', content: 'bob secret', timestamp: 1 })

      const stolen = await app.request('/ag-ui/run', runAgentInput('bob-thread', 'steal', alice))
      expect(stolen.status).toBe(200)
      const events = parseAgUiSse(await stolen.text())
      expect(events.some((event) => event.type === 'RUN_STARTED')).toBe(false)
      const error = events.find((event) => event.type === 'RUN_ERROR')
      expect(error && 'message' in error ? error.message : '').toContain('Session not found')
      expect((await bread.store.getMessages('bob-thread')).map((message) => message.content)).toEqual(['bob secret'])
      expect((await bread.store.getSession('bob-thread'))?.principal).toEqual(bob)

      const own = await app.request('/ag-ui/run', runAgentInput('alice-thread', 'hi', alice))
      expect(own.status).toBe(200)
      const ownEvents = parseAgUiSse(await own.text())
      expect(ownEvents.at(-1)?.type).toBe('RUN_FINISHED')
      expect((await bread.store.getSession('alice-thread'))?.principal).toEqual(alice)
    } finally {
      await stop()
    }
  })
})
