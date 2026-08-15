import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { defineHumanTool } from '@breadai/core'
import type { BreadInstance } from '@breadai/core'
import type { Hono } from 'hono'
import { defineTestAgent, makeServer, mockToolCallModel, readSse } from '@breadai/test-utils'

describe('server — HITL resume route', () => {
  let app: Hono
  let bread: BreadInstance
  let stop: () => Promise<void>

  const json = { 'content-type': 'application/json' }

  beforeEach(async () => {
    const approve = defineHumanTool('approve', z.object({ question: z.string() }))
    ;({ app, bread, stop } = await makeServer({
      agents: { gate: defineTestAgent({ humanTools: [approve] }) },
      model: mockToolCallModel({ toolName: 'human_approve', args: { question: 'ok?' }, then: 'approved' }),
    }))
  })

  afterEach(() => stop())

  test('POST /resume/:id streams the continuation to completion', async () => {
    // The run stream ends at human:required, with no final answer.
    const runRes = await app.request('/agents/gate/run', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ input: 'go' }),
    })
    const runEvents = await readSse(runRes)
    expect(runEvents.map((e) => e.type)).toContain('human:required')
    const human = runEvents.find((e) => e.type === 'human:required')
    const checkpointId = (human?.payload as { checkpointId: string }).checkpointId

    // Resume returns the continuation as its own SSE stream.
    const resumeRes = await app.request(`/resume/${checkpointId}`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ response: { approved: true } }),
    })
    const contEvents = await readSse(resumeRes)

    const text = contEvents
      .filter((e) => e.type === 'text:delta')
      .map((e) => (e.payload as { delta: string }).delta)
      .join('')
    expect(text).toBe('approved')
    expect(contEvents.map((e) => e.type)).toContain('agent:run:end')
    expect(await bread.store.listCheckpoints()).toHaveLength(0)
  })
})
