import { describe, expect, test } from 'bun:test'
import type { AuthIdentity, BreadAuthStrategy } from '@breadai/core'
import { authPlugin } from '@breadai/server'
import { defineTestAgent, makeServer, mockTextModel } from '@breadai/test-utils'
import { agUi } from '@breadai/protocol-ag-ui'

// A client-supplied threadId is used directly as bread's sessionId with no
// ownership check unless authorizeThread is wired — this proves the opt-in
// hook actually gates the route, same shape as transport-http-chunked's
// authorize-stream.test.ts (SEC-03).

const headerStrategy: BreadAuthStrategy = {
  name: 'header',
  authenticate(req: Request): AuthIdentity | null {
    const subject = req.headers.get('x-identity')
    return subject ? { subject } : null
  },
}

function runAgentInput(threadId: string, content: string, identity?: string) {
  return {
    method: 'POST' as const,
    headers: {
      'content-type': 'application/json',
      ...(identity ? { 'x-identity': identity } : {}),
    },
    body: JSON.stringify({
      threadId,
      messages: [{ id: 'm1', role: 'user', content }],
    }),
  }
}

describe('agUi plugin — authorizeThread', () => {
  test('a threadId the hook denies gets 403 before any run starts', async () => {
    const { app, stop } = await makeServer({
      agents: { greeter: defineTestAgent() },
      model: mockTextModel('hi'),
      plugins: [
        authPlugin([headerStrategy]),
        agUi({ agentId: 'greeter', authorizeThread: (identity, threadId) => `${identity?.subject}-thread` === threadId }),
      ],
    })
    try {
      const res = await app.request('/ag-ui/run', runAgentInput('someone-elses-thread', 'hi', 'alice'))
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: 'Forbidden' })
    } finally {
      await stop()
    }
  })

  test('the owning caller still streams normally', async () => {
    const { app, stop } = await makeServer({
      agents: { greeter: defineTestAgent() },
      model: mockTextModel('hi'),
      plugins: [
        authPlugin([headerStrategy]),
        agUi({ agentId: 'greeter', authorizeThread: (identity, threadId) => `${identity?.subject}-thread` === threadId }),
      ],
    })
    try {
      const res = await app.request('/ag-ui/run', runAgentInput('alice-thread', 'hi', 'alice'))
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('text/event-stream')
    } finally {
      await stop()
    }
  })

  test('without authorizeThread configured, any threadId is accepted (documented default, not silently changed)', async () => {
    const { app, stop } = await makeServer({
      agents: { greeter: defineTestAgent() },
      model: mockTextModel('hi'),
      plugins: [agUi({ agentId: 'greeter' })],
    })
    try {
      const res = await app.request('/ag-ui/run', runAgentInput('anyone-can-pick-this', 'hi'))
      expect(res.status).toBe(200)
    } finally {
      await stop()
    }
  })
})
