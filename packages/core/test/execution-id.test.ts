import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { defineHumanTool } from '@breadai/core'
import type { BreadCrumb, HumanRequiredCrumb } from '@breadai/core'
import { collect, defineTestAgent, makeBread, mockScript, mockTextModel, mockToolCallModel, runCollect } from '@breadai/test-utils'

const approve = defineHumanTool('approve', z.object({ question: z.string() }))
const gateModel = () =>
  mockToolCallModel({ toolName: 'human_approve', args: { question: 'ok?' }, then: 'approved!' })

function checkpointIdOf(crumbs: BreadCrumb[]): string {
  const cp = crumbs.find((c) => c.type === 'human:required') as HumanRequiredCrumb | undefined
  if (!cp) throw new Error('expected a human:required crumb')
  return cp.checkpointId
}

describe('executionId — one id per execution', () => {
  test('two separate runs get different execution ids', async () => {
    const { bread, stop } = await makeBread({
      agents: {
        g1: defineTestAgent({ model: 'g1', humanTools: [approve] }),
        g2: defineTestAgent({ model: 'g2', humanTools: [approve] }),
      },
      models: { g1: gateModel(), g2: gateModel() },
    })
    try {
      await runCollect(bread, 'g1', 'one')
      await runCollect(bread, 'g2', 'two')
      const ids = (await bread.store.listCheckpoints()).map((c) => c.executionId)
      expect(ids).toHaveLength(2)
      expect(ids.every((id) => id.length > 0)).toBe(true)
      expect(ids[0]).not.toBe(ids[1])
      expect(await bread.store.listCheckpoints({ executionId: ids[0]! })).toHaveLength(1)
    } finally {
      await stop()
    }
  })

  test('a delegated suspension and its supervisor share one execution id', async () => {
    const { bread, stop } = await makeBread({
      agents: {
        boss: defineTestAgent({ model: 'boss', config: { supervisor: { agents: [{ agentId: 'gate' }] } } }),
        gate: defineTestAgent({ model: 'gate', humanTools: [approve] }),
      },
      models: {
        boss: mockScript([{ tool: 'core_delegate', args: { agentId: 'gate', input: 'x' } }, { text: 'done' }]),
        gate: gateModel(),
      },
    })
    try {
      await runCollect(bread, 'boss', 'go')
      const checkpoints = await bread.store.listCheckpoints()
      expect(checkpoints).toHaveLength(2)
      expect(new Set(checkpoints.map((c) => c.executionId)).size).toBe(1)
    } finally {
      await stop()
    }
  })

  test('a pipeline keeps its execution id across a resume into a later suspending step', async () => {
    const { bread, stop } = await makeBread({
      agents: {
        g1: defineTestAgent({ model: 'g1', humanTools: [approve] }),
        g2: defineTestAgent({ model: 'g2', humanTools: [approve] }),
      },
      models: { g1: gateModel(), g2: gateModel() },
      config: {
        pipelines: {
          gated: [
            { type: 'agent', agentId: 'g1' },
            { type: 'agent', agentId: 'g2' },
          ],
        },
      },
    })
    try {
      const first = await collect(bread.runPipeline('gated', 'go'))
      const [before] = await bread.store.listCheckpoints()
      const cont = await collect(bread.resume(checkpointIdOf(first), { approved: true }))
      const [after] = await bread.store.listCheckpoints()
      expect(after?.id).toBe(checkpointIdOf(cont))
      expect(after?.agentId).toBe('g2')
      expect(after?.executionId).toBe(before!.executionId)
    } finally {
      await stop()
    }
  })

  test('a suspended parallel branch and its bookkeeping share one execution id across the resume', async () => {
    const { bread, stop } = await makeBread({
      agents: {
        gate: defineTestAgent({ model: 'gate', humanTools: [approve] }),
        ok: defineTestAgent({ model: 'ok' }),
        last: defineTestAgent({ model: 'last', humanTools: [approve] }),
      },
      models: { gate: gateModel(), ok: mockTextModel('OK'), last: gateModel() },
      config: {
        pipelines: {
          par: [
            { type: 'parallel', steps: [{ type: 'agent', agentId: 'gate' }, { type: 'agent', agentId: 'ok' }] },
            { type: 'agent', agentId: 'last' },
          ],
        },
      },
    })
    try {
      const first = await collect(bread.runPipeline('par', 'go'))
      const before = await bread.store.listCheckpoints()
      expect(before.length).toBeGreaterThan(0)
      const [id] = new Set(before.map((c) => c.executionId))
      expect(new Set(before.map((c) => c.executionId)).size).toBe(1)
      await collect(bread.resume(checkpointIdOf(first), { approved: true }))
      const after = await bread.store.listCheckpoints()
      expect(after.map((c) => c.agentId)).toContain('last')
      expect(after.every((c) => c.executionId === id)).toBe(true)
    } finally {
      await stop()
    }
  })

  test('a checkpoint without an execution id is refused on resume', async () => {
    const { bread, stop } = await makeBread({
      agents: { g1: defineTestAgent({ model: 'g1', humanTools: [approve] }) },
      models: { g1: gateModel() },
    })
    try {
      const crumbs = await runCollect(bread, 'g1', 'one')
      const id = checkpointIdOf(crumbs)
      const stored = await bread.store.getCheckpoint(id)
      // Simulates a row backfilled before execution ids existed; stores refuse to write one.
      const original = bread.store.getCheckpoint.bind(bread.store)
      bread.store.getCheckpoint = async (cpId) =>
        cpId === id ? { ...stored!, executionId: '' } : original(cpId)
      await expect(collect(bread.resume(id, { approved: true }))).rejects.toMatchObject({
        code: 'CHECKPOINT_NOT_RESUMABLE',
      })
      expect(await original(id)).toBeDefined()
    } finally {
      await stop()
    }
  })
})
