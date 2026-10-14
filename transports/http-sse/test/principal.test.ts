import { describe, expect, test } from 'bun:test'
import { defineHumanTool, defineTool } from '@breadai/core'
import type { BreadAuthStrategy, HumanRequiredCrumb, Principal } from '@breadai/core'
import { authPlugin } from '@breadai/server'
import { defineTestAgent, makeServer, mockScript, mockToolCallModel, parseSse } from '@breadai/test-utils'
import { transport } from '@breadai/transport-http-sse'
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

describe('http sse principal', () => {
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

  test('a body principal with no verified principal does not reach the tool', async () => {
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
      expect(res.status).toBe(200)
      await res.text()
      expect(seen).toEqual([undefined])
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
      const events = parseSse(await run.text())
      const human = events.find((event) => event.type === 'human:required')
      const cp = human?.payload as HumanRequiredCrumb
      const resume = await app.request(`/resume/${cp.checkpointId}`, {
        method: 'POST',
        headers: headers(spoof),
        body: JSON.stringify({ response: { ok: true }, principal: spoof }),
      })
      expect(resume.status).toBe(200)
      await resume.text()
      expect(seen).toEqual([host])
    } finally {
      await stop()
    }
  })
})
