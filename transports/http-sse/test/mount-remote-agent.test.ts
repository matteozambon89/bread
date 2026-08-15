import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { z } from 'zod'
import { defineTestAgent, makeBread, mockErrorModel, mockTextModel, mockToolCallModel, parseSse } from '@breadai/test-utils'
import { BreadError, defineHumanTool } from '@breadai/core'
import { remoteAgent, transport } from '@breadai/transport-http-sse'

// mount() + remoteAgent() driven together over an in-process Hono app
// (app.request(...) — no port opened), per the plan's own test requirement.
describe('@breadai/transport-http-sse — mount() + remoteAgent()', () => {
  test('remoteAgent().run relays a mounted agent run as real BreadCrumbs', async () => {
    const { bread, stop } = await makeBread({
      agents: { greeter: defineTestAgent() },
      model: mockTextModel('hello there'),
      config: { transport: transport() },
    })
    const app = new Hono()
    bread.transport.mount!(app, bread)

    try {
      const agent = remoteAgent({ url: 'http://test', fetch: (req, init) => app.request(req, init) })
      const crumbs = []
      for await (const crumb of agent.run('greeter', 'hi')) crumbs.push(crumb)

      expect(crumbs[0]!.type).toBe('agent:run:start')
      expect(crumbs.at(-1)!.type).toBe('agent:run:end')
      const text = crumbs
        .filter((c) => c.type === 'text:delta')
        .map((c) => (c as { delta: string }).delta)
        .join('')
      expect(text).toBe('hello there')
    } finally {
      await stop()
    }
  })

  test('mount() preserves the exact SSE wire format (data:/id: lines)', async () => {
    const { bread, stop } = await makeBread({
      agents: { greeter: defineTestAgent() },
      model: mockTextModel('hi'),
      config: { transport: transport() },
    })
    const app = new Hono()
    bread.transport.mount!(app, bread)

    try {
      const res = await app.request('/agents/greeter/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: 'hi' }),
      })
      expect(res.headers.get('content-type')).toContain('text/event-stream')
      const body = await res.text()
      expect(body).toMatch(/^id: \d+\ndata: \{"type":"agent:run:start"/m)

      const events = parseSse(body)
      expect(events.at(-1)!.type).toBe('agent:run:end')
    } finally {
      await stop()
    }
  })

  test('an unknown pipeline id surfaces as an SSE error event, not a torn-down connection', async () => {
    const { bread, stop } = await makeBread({
      agents: { greeter: defineTestAgent() },
      model: mockTextModel('hi'),
      config: { transport: transport() },
    })
    const app = new Hono()
    bread.transport.mount!(app, bread)

    try {
      const res = await app.request('/pipelines/ghost/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: {} }),
      })
      expect(res.status).toBe(200)
      const [event] = parseSse(await res.text())
      expect(event!.type).toBe('error')
      expect((event!.payload as { code: string }).code).toBe('PIPELINE_NOT_FOUND')
    } finally {
      await stop()
    }
  })

  test('GET /runs/:runId/stream replays store history via mount()', async () => {
    const { bread, stop } = await makeBread({
      agents: { greeter: defineTestAgent() },
      model: mockTextModel('hello there'),
      config: { transport: transport() },
    })
    const app = new Hono()
    bread.transport.mount!(app, bread)

    try {
      const crumbs = []
      for await (const crumb of bread.run('greeter', 'hi', { mode: 'stream' })) crumbs.push(crumb)
      const runId = crumbs[0]!.runId

      const res = await app.request(`/runs/${runId}/stream`)
      const events = parseSse(await res.text())
      expect(events.at(-1)!.type).toBe('agent:run:end')
    } finally {
      await stop()
    }
  })

  test('remoteAgent().run rebuilds a real BreadError, matching a local bread.on("crumb") listener', async () => {
    const { bread, stop } = await makeBread({
      agents: { greeter: defineTestAgent() },
      model: mockErrorModel('boom'),
      config: { transport: transport() },
    })
    const app = new Hono()
    bread.transport.mount!(app, bread)

    try {
      let localError: unknown
      bread.on('crumb', (crumb) => {
        if ('error' in crumb) localError = crumb.error
      })
      try {
        for await (const _ of bread.run('greeter', 'hi')) {
          /* drain */
        }
      } catch {
        // the run rethrows after emitting its error crumb — expected
      }
      expect(localError).toBeInstanceOf(BreadError)

      const agent = remoteAgent({ url: 'http://test', fetch: (req, init) => app.request(req, init) })
      let wireError: unknown
      for await (const crumb of agent.run('greeter', 'hi')) {
        if ('error' in crumb) wireError = crumb.error
      }
      expect(wireError).toBeInstanceOf(BreadError)
      expect((wireError as BreadError).message).toBe((localError as BreadError).message)
    } finally {
      await stop()
    }
  })

  test('GET /runs/:runId/stream catch-up replay respects config.crumbFilter', async () => {
    const { bread, stop } = await makeBread({
      agents: { greeter: defineTestAgent() },
      model: mockTextModel('hello there'),
      config: { transport: transport(), crumbFilter: (c) => c.type !== 'text:delta' },
    })
    const app = new Hono()
    bread.transport.mount!(app, bread)

    try {
      const crumbs = []
      for await (const crumb of bread.run('greeter', 'hi', { mode: 'stream' })) crumbs.push(crumb)
      const runId = crumbs[0]!.runId

      // Persisted regardless of the filter — filtering only gates transports.
      const stored = await bread.store.getCrumbs!(runId)
      expect(stored.map((e) => e.type)).toContain('text:delta')

      const res = await app.request(`/runs/${runId}/stream`)
      const events = parseSse(await res.text())
      expect(events.map((e) => e.type)).not.toContain('text:delta')
      expect(events.at(-1)!.type).toBe('agent:run:end')
    } finally {
      await stop()
    }
  })

  test('POST /resume/:checkpointId resumes a suspended run to completion', async () => {
    const approve = defineHumanTool('approve', z.object({ question: z.string() }))
    const { bread, stop } = await makeBread({
      agents: { gate: defineTestAgent({ humanTools: [approve] }) },
      model: mockToolCallModel({ toolName: 'human_approve', args: { question: 'ok?' }, then: 'approved!' }),
      config: { transport: transport() },
    })
    const app = new Hono()
    bread.transport.mount!(app, bread)

    try {
      const runRes = await app.request('/agents/gate/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: 'go' }),
      })
      const runEvents = parseSse(await runRes.text())
      const humanRequired = runEvents.find((e) => e.type === 'human:required')
      expect(humanRequired).toBeDefined()
      const checkpointId = (humanRequired!.payload as { checkpointId: string }).checkpointId

      const resumeRes = await app.request(`/resume/${checkpointId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ response: { approved: true } }),
      })
      const resumeEvents = parseSse(await resumeRes.text())
      expect(resumeEvents.at(-1)!.type).toBe('agent:run:end')
      const text = resumeEvents
        .filter((e) => e.type === 'text:delta')
        .map((e) => (e.payload as { delta: string }).delta)
        .join('')
      expect(text).toBe('approved!')
    } finally {
      await stop()
    }
  })

  test('GET /runs/:runId/stream rejects an invalid Last-Event-ID with 400', async () => {
    const { bread, stop } = await makeBread({
      agents: { greeter: defineTestAgent() },
      model: mockTextModel('hi'),
      config: { transport: transport() },
    })
    const app = new Hono()
    bread.transport.mount!(app, bread)

    try {
      const res = await app.request('/runs/some-run-id/stream', {
        headers: { 'Last-Event-ID': 'not-a-number' },
      })
      expect(res.status).toBe(400)
      const body = (await res.json()) as { error: string }
      expect(body.error).toContain('Invalid Last-Event-ID')
    } finally {
      await stop()
    }
  })
})
