import { describe, expect, test } from 'bun:test'
import type { AuthIdentity, BreadAuthStrategy, BreadInstance } from '@breadai/core'
import { authPlugin } from '@breadai/server'
import { defineTestAgent, makeServer, mockTextModel } from '@breadai/test-utils'
import { transport } from '@breadai/transport-http-chunked'

const headerStrategy: BreadAuthStrategy = {
  name: 'header',
  authenticate(req: Request): AuthIdentity | null {
    const subject = req.headers.get('x-identity')
    return subject ? { subject } : null
  },
}

async function ndjsonRunId(res: Response): Promise<string> {
  const line = (await res.text()).split('\n').find((entry) => entry.trim())
  return (JSON.parse(line ?? '{}') as { runId?: string }).runId ?? ''
}

function spyCrumbs(bread: BreadInstance): { reads: () => number } {
  const original = bread.store.getCrumbs?.bind(bread.store)
  if (!original) throw new Error('expected a crumb log')
  let reads = 0
  bread.store.getCrumbs = async (...args) => {
    reads += 1
    return original(...args)
  }
  return { reads: () => reads }
}

describe('@breadai/transport-http-chunked — store route gate', () => {
  test('resume and the run stream are 403 on a public Host before any crumb read', async () => {
    const { app, bread, stop } = await makeServer({
      agents: { assistant: defineTestAgent() },
      model: mockTextModel('hi'),
      config: { transport: transport() },
    })
    try {
      const runRes = await app.request('/agents/assistant/run', { method: 'POST', body: '{}' })
      const runId = await ndjsonRunId(runRes)
      expect(runId).not.toBe('')
      const crumbs = spyCrumbs(bread)
      let resumed = 0
      const resume = bread.resume.bind(bread)
      bread.resume = ((...args: Parameters<BreadInstance['resume']>) => {
        resumed += 1
        return resume(...args)
      }) as BreadInstance['resume']

      const stream = await app.request(`http://example.com/runs/${runId}/stream`, {
        headers: { 'x-forwarded-host': 'localhost' },
      })
      expect(stream.status).toBe(403)
      expect(await stream.json()).toEqual({ error: 'Forbidden' })
      expect(crumbs.reads()).toBe(0)

      const deniedResume = await app.request('http://example.com/resume/missing', { method: 'POST', body: '{}' })
      expect(deniedResume.status).toBe(403)
      expect(resumed).toBe(0)

      const allowed = await app.request(`/runs/${runId}/stream`)
      expect(allowed.status).toBe(200)
      expect(await allowed.text()).toContain('agent:run:end')
      expect(crumbs.reads()).toBeGreaterThan(0)

      const resumeRes = await app.request('/resume/missing', { method: 'POST', body: '{}' })
      expect(resumeRes.status).not.toBe(403)
      await resumeRes.text()
      expect(resumed).toBe(1)

      const cancel = await app.request('http://example.com/runs/missing/cancel', { method: 'POST' })
      expect(cancel.status).toBe(403)
      expect(await cancel.json()).toEqual({ error: 'Forbidden' })

      const loopbackCancel = await app.request('/runs/missing/cancel', { method: 'POST' })
      expect(loopbackCancel.status).toBe(404)
    } finally {
      await stop()
    }
  })

  test('a denied grant is 403 and authorizeStream still runs after an allow', async () => {
    const { app, bread, stop } = await makeServer({
      agents: { assistant: defineTestAgent() },
      model: mockTextModel('hi'),
      plugins: [authPlugin([headerStrategy])],
      config: {
        transport: transport({ authorizeStream: (identity) => identity?.subject !== 'hook-deny' }),
        server: { authorize: (identity) => identity.subject !== 'bob' },
      },
    })
    try {
      const runRes = await app.request('/agents/assistant/run', {
        method: 'POST',
        headers: { 'x-identity': 'admin' },
        body: '{}',
      })
      const runId = await ndjsonRunId(runRes)
      const crumbs = spyCrumbs(bread)
      let resumed = 0
      const resume = bread.resume.bind(bread)
      bread.resume = ((...args: Parameters<BreadInstance['resume']>) => {
        resumed += 1
        return resume(...args)
      }) as BreadInstance['resume']

      const member = await app.request(`/runs/${runId}/stream`, { headers: { 'x-identity': 'bob' } })
      expect(member.status).toBe(403)
      expect(crumbs.reads()).toBe(0)
      const memberResume = await app.request('/resume/missing', {
        method: 'POST',
        headers: { 'x-identity': 'bob' },
        body: '{}',
      })
      expect(memberResume.status).toBe(403)
      expect(resumed).toBe(0)

      const hooked = await app.request(`/runs/${runId}/stream`, { headers: { 'x-identity': 'hook-deny' } })
      expect(hooked.status).toBe(403)
      expect(await hooked.json()).toEqual({ error: 'Forbidden' })
      expect(crumbs.reads()).toBe(0)

      const admin = await app.request(`http://example.com/runs/${runId}/stream`, {
        headers: { 'x-identity': 'admin' },
      })
      expect(admin.status).toBe(200)
      expect(await admin.text()).toContain('agent:run:end')
      expect(crumbs.reads()).toBeGreaterThan(0)

      const adminResume = await app.request('http://example.com/resume/missing', {
        method: 'POST',
        headers: { 'x-identity': 'admin' },
        body: '{}',
      })
      expect(adminResume.status).not.toBe(403)
      await adminResume.text()
      expect(resumed).toBe(1)
    } finally {
      await stop()
    }
  })
})
