import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { z } from 'zod'
import { defineHumanTool } from '@breadai/core'
import { defineTestAgent, makeBread, mockTextModel, mockToolCallModel } from '@breadai/test-utils'
import { remoteAgent, transport } from '@breadai/transport-http-chunked'

// mount() + remoteAgent() driven together over an in-process Hono app
// (app.request(...) — no port opened), per the plan's own test requirement.
describe('@breadai/transport-http-chunked — mount() + remoteAgent()', () => {
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

  test('mount() streams NDJSON lines, one CrumbFrame per line', async () => {
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
      expect(res.headers.get('content-type')).toContain('application/x-ndjson')
      const lines = (await res.text()).trim().split('\n')
      const frames = lines.map((l) => JSON.parse(l))
      expect(frames.every((f) => f.type === 'crumb' && f.v === 1)).toBe(true)
      expect(frames.at(-1).crumb.type).toBe('agent:run:end')
    } finally {
      await stop()
    }
  })

  test('an unknown pipeline id surfaces as an in-stream agent:error crumb, not a 404', async () => {
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
      const frame = JSON.parse((await res.text()).trim())
      expect(frame.crumb.type).toBe('agent:error')
      expect(frame.crumb.error.code).toBe('PIPELINE_NOT_FOUND')
    } finally {
      await stop()
    }
  })

  test('GET /runs/:runId/stream replays store history then tails live via mount()', async () => {
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
      const lines = (await res.text()).trim().split('\n').filter(Boolean)
      const frames = lines.map((l) => JSON.parse(l))
      expect(frames.at(-1).crumb.type).toBe('agent:run:end')
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
      const lines = (await res.text()).trim().split('\n').filter(Boolean)
      const frames = lines.map((l) => JSON.parse(l))
      expect(frames.map((f) => f.crumb.type)).not.toContain('text:delta')
      expect(frames.at(-1).crumb.type).toBe('agent:run:end')
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
      const runFrames = (await runRes.text())
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
      const humanRequired = runFrames.find((f) => f.crumb.type === 'human:required')
      expect(humanRequired).toBeDefined()
      const checkpointId = humanRequired.crumb.checkpointId

      const resumeRes = await app.request(`/resume/${checkpointId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ response: { approved: true } }),
      })
      const resumeFrames = (await resumeRes.text())
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
      expect(resumeFrames.at(-1).crumb.type).toBe('agent:run:end')
      const text = resumeFrames
        .filter((f) => f.crumb.type === 'text:delta')
        .map((f) => f.crumb.delta)
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
