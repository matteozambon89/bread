import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { defineHumanTool, defineTool } from '@bread/core'
import type { BreadCrumb, HumanRequiredCrumb } from '@bread/core'
import { store } from '@bread/store-memory'
import { collect, defineTestAgent, makeBread, mockToolCallModel, runCollect } from '@bread/test-utils'

const approve = defineHumanTool('approve', z.object({ question: z.string() }))
const gateAgents = { gate: defineTestAgent({ humanTools: [approve] }) }
const gateModel = () =>
  mockToolCallModel({ toolName: 'human_approve', args: { question: 'ok?' }, then: 'approved!' })

function textOf(crumbs: BreadCrumb[]): string {
  return crumbs
    .filter((c) => c.type === 'text:delta')
    .map((c) => (c as { delta: string }).delta)
    .join('')
}

function humanRequired(crumbs: BreadCrumb[]): HumanRequiredCrumb {
  const cp = crumbs.find((c) => c.type === 'human:required') as HumanRequiredCrumb | undefined
  if (!cp) throw new Error('expected a human:required crumb')
  return cp
}

describe('runner — durable HITL resume', () => {
  test('suspends on a human tool, then resumes from the store to completion', async () => {
    const { bread, stop } = await makeBread({ agents: gateAgents, model: gateModel() })
    try {
      // The run stream ends at human:required — no final answer yet.
      const first = await runCollect(bread, 'gate', 'go')
      expect(first.map((c) => c.type)).toContain('human:required')
      expect(textOf(first)).toBe('')
      const cp = humanRequired(first)
      expect(cp.toolName).toBe('human_approve')
      expect(await bread.store.listCheckpoints()).toHaveLength(1)

      // resume returns the continuation stream; the checkpoint is cleared.
      const cont = await collect(bread.resume(cp.checkpointId, { approved: true }))
      expect(cont.map((c) => c.type)).toContain('human:resumed')
      expect(cont.map((c) => c.type)).toContain('agent:run:end')
      expect(textOf(cont)).toBe('approved!')
      expect(await bread.store.listCheckpoints()).toHaveLength(0)
    } finally {
      await stop()
    }
  })

  test('resumes after a restart — a fresh instance over the same store continues', async () => {
    // Sharing one model instance preserves its scripted-step counter across the
    // two "processes": step 0 (tool call) ran in the first, step 1 (text) runs
    // on resume in the second.
    const testStore = store()
    const model = gateModel()

    const a = await makeBread({ agents: gateAgents, model, config: { store: testStore } })
    const first = await runCollect(a.bread, 'gate', 'go')
    const cp = humanRequired(first)
    await a.stop() // simulate shutdown — the in-memory run is gone

    const b = await makeBread({ agents: gateAgents, model, config: { store: testStore } })
    try {
      // The pending checkpoint is visible straight from the shared store.
      expect(await b.bread.store.listCheckpoints()).toHaveLength(1)
      const cont = await collect(b.bread.resume(cp.checkpointId, { approved: true }))
      expect(textOf(cont)).toBe('approved!')
      expect(await b.bread.store.listCheckpoints()).toHaveLength(0)
    } finally {
      await b.stop()
    }
  })

  test('persists tool-call and tool-result messages for multi-turn context', async () => {
    const add = defineTool({
      name: 'add',
      description: 'Add two numbers',
      schema: z.object({ a: z.number(), b: z.number() }),
      execute: async ({ a, b }) => ({ sum: a + b }),
    })
    const { bread, stop } = await makeBread({
      agents: { calc: defineTestAgent({ tools: [add] }) },
      model: mockToolCallModel({ toolName: 'tool_add', args: { a: 2, b: 3 }, then: '5' }),
    })
    try {
      const sessionId = 'multi-turn-1'
      await runCollect(bread, 'calc', 'add 2 and 3', { session: { id: sessionId } })

      const msgs = await bread.store.getMessages(sessionId)
      // The tool result is now persisted (it used to be dropped), and the
      // assistant message carries the structured tool-call — so a second turn
      // would replay full tool context, not just flattened text.
      expect(msgs.map((m) => m.role)).toContain('tool')
      const assistantToolCall = msgs.find(
        (m) =>
          m.role === 'assistant' &&
          Array.isArray(m.content) &&
          (m.content as Array<{ type: string }>).some((p) => p.type === 'tool-call'),
      )
      expect(assistantToolCall).toBeDefined()
    } finally {
      await stop()
    }
  })

  test('resuming an already-resumed checkpoint throws CHECKPOINT_NOT_FOUND', async () => {
    const { bread, stop } = await makeBread({ agents: gateAgents, model: gateModel() })
    try {
      const first = await runCollect(bread, 'gate', 'go')
      const cp = humanRequired(first)
      await collect(bread.resume(cp.checkpointId, { approved: true }))

      // The checkpoint was atomically claimed and deleted by the first resume —
      // a second resume (e.g. a retried request) must not re-run anything.
      await expect(collect(bread.resume(cp.checkpointId, { approved: true }))).rejects.toMatchObject(
        { code: 'CHECKPOINT_NOT_FOUND' },
      )
    } finally {
      await stop()
    }
  })

  test('carries the run\'s skill onto the checkpoint and back through resume', async () => {
    const { bread, stop } = await makeBread({ agents: gateAgents, model: gateModel() })
    try {
      const first = await runCollect(bread, 'gate', 'go', { skill: 'triage' })
      const cp = humanRequired(first)
      expect((await bread.store.listCheckpoints())[0]?.skill).toBe('triage')

      // No agentDir in this in-process harness, so skill *loading* is a no-op
      // (see assembleTools) — this only proves resume doesn't lose/choke on it.
      const cont = await collect(bread.resume(cp.checkpointId, { approved: true }))
      expect(textOf(cont)).toBe('approved!')
    } finally {
      await stop()
    }
  })
})
