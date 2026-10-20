import { describe, expect, test } from 'bun:test'
import { defineHumanTool, defineTool, LOCAL_CLI_PRINCIPAL } from '@breadai/core'
import type { BreadAuthStrategy, BreadCrumb, HumanRequiredCrumb, Principal } from '@breadai/core'
import { authPlugin } from '@breadai/server'
import { defineTestAgent, makeServer, mockScript, mockToolCallModel } from '@breadai/test-utils'
import { transport } from '@breadai/transport-http-chunked'
import { z } from 'zod'

const host: Principal = { iss: 'https://idp.example', sub: 'user-1', tenant: 'acme' }
const spoof: Principal = { iss: 'https://evil.example', sub: 'spoof' }

const strategy: BreadAuthStrategy = {
  name: 'header',
  authenticate(req) {
    const raw = req.headers.get('x-principal')
    if (raw == null) return null
    if (raw === 'none') return { subject: 'anon' }
    return { subject: 'user', principal: JSON.parse(raw) as Principal }
  },
}

function headers(principal: Principal | 'none') {
  return {
    'content-type': 'application/json',
    'x-principal': principal === 'none' ? 'none' : JSON.stringify(principal),
  }
}

function crumbs(body: string): BreadCrumb[] {
  return body
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { crumb: BreadCrumb }).crumb)
}

function probe(seen: Array<Principal | undefined>) {
  return defineTool({
    name: 'probe',
    description: 'Record the run principal',
    schema: z.object({
      principal: z.object({ iss: z.string(), sub: z.string() }).optional(),
    }),
    execute: async (_args, ctx) => {
      seen.push(ctx.principal)
      return { ok: true }
    },
  })
}

describe('http chunked principal', () => {
  test('a strategy principal reaches the tool and a different principal in the body does not', async () => {
    const seen: Array<Principal | undefined> = []
    const { app, stop } = await makeServer({
      agents: { agent: defineTestAgent({ tools: [probe(seen)] }) },
      model: mockToolCallModel({ toolName: 'tool_probe', args: { principal: spoof }, then: 'done' }),
      plugins: [authPlugin([strategy])],
      config: { transport: transport(), server: { authorize: () => true } },
    })
    try {
      const res = await app.request('/agents/agent/run', {
        method: 'POST',
        headers: headers(host),
        body: JSON.stringify({ input: 'go', principal: spoof }),
      })
      expect(res.status).toBe(200)
      await res.text()
      expect(seen).toEqual([host])
    } finally {
      await stop()
    }
  })

  test('an authenticated run with no principal is 403 and does not reach the tool', async () => {
    const seen: Array<Principal | undefined> = []
    const { app, stop } = await makeServer({
      agents: { agent: defineTestAgent({ tools: [probe(seen)] }) },
      model: mockToolCallModel({ toolName: 'tool_probe', args: { principal: spoof }, then: 'done' }),
      plugins: [authPlugin([strategy])],
      config: { transport: transport(), server: { authorize: () => true } },
    })
    try {
      const res = await app.request('/agents/agent/run', {
        method: 'POST',
        headers: headers('none'),
        body: JSON.stringify({ input: 'go', principal: spoof }),
      })
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: 'Forbidden' })
      expect(seen).toEqual([])
    } finally {
      await stop()
    }
  })

  test('resume uses the checkpoint principal and ignores a body principal', async () => {
    const seen: Array<Principal | undefined> = []
    const approve = defineHumanTool('approve', z.object({ question: z.string() }))
    const { app, stop } = await makeServer({
      agents: { gate: defineTestAgent({ tools: [probe(seen)], humanTools: [approve] }) },
      model: mockScript([
        { tool: 'human_approve', args: { question: 'ok?' } },
        { tool: 'tool_probe', args: { principal: spoof } },
        { text: 'done' },
      ]),
      plugins: [authPlugin([strategy])],
      config: { transport: transport(), server: { authorize: () => true } },
    })
    try {
      const run = await app.request('/agents/gate/run', {
        method: 'POST',
        headers: headers(host),
        body: JSON.stringify({ input: 'go', principal: spoof }),
      })
      const suspended = crumbs(await run.text())
      const cp = suspended.find((c) => c.type === 'human:required') as HumanRequiredCrumb
      const sameCaller = { iss: host.iss, sub: host.sub }
      const resume = await app.request(`/resume/${cp.checkpointId}`, {
        method: 'POST',
        headers: headers(sameCaller),
        body: JSON.stringify({ response: { ok: true }, principal: spoof }),
      })
      expect(resume.status).toBe(200)
      await resume.text()
      expect(seen).toEqual([host])
    } finally {
      await stop()
    }
  })

  test('resume is 403 when the caller principal does not match the checkpoint', async () => {
    const seen: Array<Principal | undefined> = []
    const approve = defineHumanTool('approve', z.object({ question: z.string() }))
    const { app, bread, stop } = await makeServer({
      agents: { gate: defineTestAgent({ tools: [probe(seen)], humanTools: [approve] }) },
      model: mockScript([
        { tool: 'human_approve', args: { question: 'ok?' } },
        { tool: 'tool_probe', args: { principal: spoof } },
        { text: 'done' },
      ]),
      plugins: [authPlugin([strategy])],
      config: { transport: transport(), server: { authorize: () => true } },
    })
    try {
      const run = await app.request('/agents/gate/run', {
        method: 'POST',
        headers: headers(host),
        body: JSON.stringify({ input: 'go' }),
      })
      const suspended = crumbs(await run.text())
      const cp = suspended.find((c) => c.type === 'human:required') as HumanRequiredCrumb
      const denied = await app.request(`/resume/${cp.checkpointId}`, {
        method: 'POST',
        headers: headers(spoof),
        body: JSON.stringify({ response: { ok: true }, principal: host }),
      })
      expect(denied.status).toBe(403)
      expect(await denied.json()).toEqual({ error: 'Forbidden' })
      expect(await bread.store.getCheckpoint(cp.checkpointId)).toBeDefined()
      expect(seen).toEqual([])
    } finally {
      await stop()
    }
  })

  test('an unauthenticated loopback run stamps the local cli principal and ignores a body principal', async () => {
    const seen: Array<Principal | undefined> = []
    const { app, bread, stop } = await makeServer({
      agents: { agent: defineTestAgent({ tools: [probe(seen)] }) },
      model: mockToolCallModel({ toolName: 'tool_probe', args: { principal: spoof }, then: 'done' }),
      config: { transport: transport() },
    })
    try {
      const res = await app.request('http://127.0.0.1/agents/agent/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: 'go', session: { id: 'loop' }, principal: spoof }),
      })
      expect(res.status).toBe(200)
      await res.text()
      expect(seen).toEqual([LOCAL_CLI_PRINCIPAL])
      expect((await bread.store.getSession('loop'))?.principal).toEqual(LOCAL_CLI_PRINCIPAL)
    } finally {
      await stop()
    }
  })
})
