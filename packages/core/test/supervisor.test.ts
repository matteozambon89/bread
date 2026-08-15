import { describe, expect, test } from 'bun:test'
import { defineHumanTool } from '@bread/core'
import type { AgentRunEndCrumb, BreadCrumb, ToolErrorCrumb } from '@bread/core'
import { store as memoryStore } from '@bread/store-memory'
import { z } from 'zod'
import {
  defineTestAgent,
  makeBread,
  mockScript,
  mockTextModel,
  mockToolCallModel,
  runCollect,
} from '@bread/test-utils'
import type { MockLanguageModelV3 } from 'ai/test'

function textOf(crumbs: BreadCrumb[]): string {
  return crumbs
    .filter((c) => c.type === 'text:delta')
    .map((c) => (c as { delta: string }).delta)
    .join('')
}

function agentIds(crumbs: BreadCrumb[], type: 'agent:run:start' | 'agent:run:end'): string[] {
  return crumbs.filter((c) => c.type === type).map((c) => (c as { agentId: string }).agentId)
}

describe('supervisor — LLM-driven delegation via core_delegate', () => {
  test('the supervisor delegates with a model-chosen input and reads the output back', async () => {
    const w1 = mockTextModel('research notes') as MockLanguageModelV3
    const { bread, stop } = await makeBread({
      agents: {
        boss: defineTestAgent({
          model: 'boss',
          config: { supervisor: { agents: [{ agentId: 'w1' }] } },
        }),
        w1: defineTestAgent({ model: 'w1' }),
      },
      models: {
        boss: mockScript([
          { tool: 'core_delegate', args: { agentId: 'w1', input: 'dig into bread' } },
          { text: 'composed answer' },
        ]),
        w1,
      },
    })
    try {
      const crumbs = await runCollect(bread, 'boss', 'go')
      // The sub-agent ran with the input the model chose, not the run input.
      expect(JSON.stringify(w1.doStreamCalls[0]!.prompt)).toContain('dig into bread')
      expect(agentIds(crumbs, 'agent:run:end')).toContain('w1')
      // The delegation output came back as the tool result…
      const result = crumbs.find((c) => c.type === 'tool:result') as { result?: unknown } | undefined
      expect(result?.result).toBe('research notes')
      // …and the supervisor composed its own final answer.
      const bossEnd = crumbs.findLast((c) => c.type === 'agent:run:end') as AgentRunEndCrumb
      expect(bossEnd.output).toBe('composed answer')
    } finally {
      await stop()
    }
  })

  test('delegates to two sub-agents in parallel within one turn', async () => {
    const { bread, stop } = await makeBread({
      agents: {
        boss: defineTestAgent({
          model: 'boss',
          config: { supervisor: { max: 2, agents: [{ agentId: 'w1' }, { agentId: 'w2' }] } },
        }),
        w1: defineTestAgent({ model: 'w1' }),
        w2: defineTestAgent({ model: 'w2' }),
      },
      models: {
        boss: mockScript([
          {
            tools: [
              { tool: 'core_delegate', args: { agentId: 'w1', input: 'left' } },
              { tool: 'core_delegate', args: { agentId: 'w2', input: 'right' } },
            ],
          },
          { text: 'merged' },
        ]),
        w1: mockTextModel('one'),
        w2: mockTextModel('two'),
      },
    })
    try {
      const crumbs = await runCollect(bread, 'boss', 'go')
      const ended = agentIds(crumbs, 'agent:run:end')
      expect(ended).toContain('w1')
      expect(ended).toContain('w2')
      expect(crumbs.filter((c) => c.type === 'tool:result')).toHaveLength(2)
      expect(textOf(crumbs)).toContain('merged')
    } finally {
      await stop()
    }
  })

  test('delegates in series across turns, threading results through the model', async () => {
    const w2 = mockTextModel('two') as MockLanguageModelV3
    const { bread, stop } = await makeBread({
      agents: {
        boss: defineTestAgent({
          model: 'boss',
          config: { supervisor: { agents: [{ agentId: 'w1' }, { agentId: 'w2' }] } },
        }),
        w1: defineTestAgent({ model: 'w1' }),
        w2: defineTestAgent({ model: 'w2' }),
      },
      models: {
        boss: mockScript([
          { tool: 'core_delegate', args: { agentId: 'w1', input: 'first' } },
          { tool: 'core_delegate', args: { agentId: 'w2', input: 'refine: one' } },
          { text: 'done' },
        ]),
        w1: mockTextModel('one'),
        w2,
      },
    })
    try {
      const crumbs = await runCollect(bread, 'boss', 'go')
      expect(agentIds(crumbs, 'agent:run:end')).toEqual(expect.arrayContaining(['w1', 'w2', 'boss']))
      // The second delegation's input was the model's own composition over the
      // first result — proving the supervisor read output between delegations.
      expect(JSON.stringify(w2.doStreamCalls[0]!.prompt)).toContain('refine: one')
    } finally {
      await stop()
    }
  })

  test('delegating outside the roster surfaces a rich tool error the model can react to', async () => {
    const { bread, stop } = await makeBread({
      agents: {
        boss: defineTestAgent({
          model: 'boss',
          config: { supervisor: { agents: [{ agentId: 'w1' }] } },
        }),
        w1: defineTestAgent({ model: 'w1' }),
        intruder: defineTestAgent({ model: 'intruder' }),
      },
      models: {
        boss: mockScript([
          { tool: 'core_delegate', args: { agentId: 'intruder', input: 'x' } },
          { text: 'recovered' },
        ]),
        w1: mockTextModel('one'),
        intruder: mockTextModel('never'),
      },
    })
    try {
      const crumbs = await runCollect(bread, 'boss', 'go')
      const err = crumbs.find((c) => c.type === 'tool:error') as ToolErrorCrumb
      expect(err.error.code).toBe('DELEGATE_AGENT_NOT_CONFIGURED')
      expect(err.error.message).toContain('w1') // the roster is spelled out
      // The registered-but-unrosterd agent never ran; the run itself recovered.
      expect(agentIds(crumbs, 'agent:run:start')).not.toContain('intruder')
      expect(textOf(crumbs)).toContain('recovered')
    } finally {
      await stop()
    }
  })

  test('per-sub-agent max caps concurrent delegations within a turn', async () => {
    const { bread, stop } = await makeBread({
      agents: {
        boss: defineTestAgent({
          model: 'boss',
          config: { supervisor: { agents: [{ agentId: 'w1', max: 1 }] } },
        }),
        w1: defineTestAgent({ model: 'w1' }),
      },
      models: {
        boss: mockScript([
          {
            tools: [
              { tool: 'core_delegate', args: { agentId: 'w1', input: 'a' } },
              { tool: 'core_delegate', args: { agentId: 'w1', input: 'b' } },
            ],
          },
          { text: 'partial' },
        ]),
        w1: mockTextModel('one'),
      },
    })
    try {
      const crumbs = await runCollect(bread, 'boss', 'go')
      // One delegation ran, the second was rejected with the cap error.
      expect(crumbs.filter((c) => c.type === 'tool:result')).toHaveLength(1)
      const err = crumbs.find((c) => c.type === 'tool:error') as ToolErrorCrumb
      expect(err.error.code).toBe('DELEGATION_LIMIT')
      expect(textOf(crumbs)).toContain('partial')
    } finally {
      await stop()
    }
  })

  test('mediate visibility surfaces subagent:* framing instead of raw sub-agent crumbs', async () => {
    const { bread, stop } = await makeBread({
      agents: {
        boss: defineTestAgent({
          model: 'boss',
          config: { supervisor: { agents: [{ agentId: 'w1', visibility: 'mediate' }] } },
        }),
        w1: defineTestAgent({ model: 'w1' }),
      },
      models: {
        boss: mockScript([{ tool: 'core_delegate', args: { agentId: 'w1', input: 'x' } }, { text: 'done' }]),
        w1: mockTextModel('one'),
      },
    })
    try {
      const crumbs = await runCollect(bread, 'boss', 'go')
      const types = crumbs.map((c) => c.type)
      expect(types).toContain('subagent:run:start')
      expect(types).toContain('subagent:run:end')
      // The worker's own text never surfaces raw — only the boss's.
      expect(textOf(crumbs)).toBe('done')
    } finally {
      await stop()
    }
  })

  test('hidden visibility suppresses sub-agent crumbs but still returns the output', async () => {
    const { bread, stop } = await makeBread({
      agents: {
        boss: defineTestAgent({
          model: 'boss',
          config: { supervisor: { agents: [{ agentId: 'w1', visibility: 'hidden' }] } },
        }),
        w1: defineTestAgent({ model: 'w1' }),
      },
      models: {
        boss: mockScript([{ tool: 'core_delegate', args: { agentId: 'w1', input: 'x' } }, { text: 'done' }]),
        w1: mockTextModel('secret'),
      },
    })
    try {
      const crumbs = await runCollect(bread, 'boss', 'go')
      expect(agentIds(crumbs, 'agent:run:start')).not.toContain('w1')
      expect(textOf(crumbs)).toBe('done')
      // Hidden from the stream, not from the supervisor: the tool result
      // still carried the worker's output back to the model.
      const result = crumbs.find((c) => c.type === 'tool:result') as { result?: unknown }
      expect(result.result).toBe('secret')
    } finally {
      await stop()
    }
  })

  test('a delegated run suspending for HITL chain-suspends the supervisor, even under mediate', async () => {
    const approve = defineHumanTool('approve', z.object({ question: z.string() }))
    const { bread, stop } = await makeBread({
      agents: {
        boss: defineTestAgent({
          model: 'boss',
          config: { supervisor: { agents: [{ agentId: 'gate', visibility: 'mediate' }] } },
        }),
        gate: defineTestAgent({ model: 'gate', humanTools: [approve] }),
      },
      models: {
        boss: mockScript([{ tool: 'core_delegate', args: { agentId: 'gate', input: 'x' } }, { text: 'composed: yes' }]),
        gate: mockToolCallModel({ toolName: 'human_approve', args: { question: 'ok?' }, then: 'yes' }),
      },
    })
    try {
      const first = await runCollect(bread, 'boss', 'go')
      // The child's suspension surfaces (never swallowed by visibility), the
      // stream ends there — no tool error, no supervisor answer yet.
      expect(first.map((c) => c.type)).toContain('human:required')
      expect(first.map((c) => c.type)).not.toContain('tool:error')
      expect(first.map((c) => c.type)).not.toContain('agent:run:end')
      // Two checkpoints at rest: the child's and the supervisor's chained one.
      const checkpoints = await bread.store.listCheckpoints()
      expect(checkpoints).toHaveLength(2)
      const supervisorCp = checkpoints.find((c) => c.pending?.length)
      expect(supervisorCp?.agentId).toBe('boss')

      // The supervisor checkpoint is not directly resumable.
      await expect(
        (async () => {
          for await (const _ of bread.resume(supervisorCp!.id, { approved: true })) void _
        })(),
      ).rejects.toMatchObject({ code: 'SUPERVISOR_CHECKPOINT_NOT_RESUMABLE' })

      // Resuming the child cascades: child completes, supervisor continues
      // with the child's output as its tool result and composes its answer.
      const childCp = first.find((c) => c.type === 'human:required') as { checkpointId: string }
      const cont: BreadCrumb[] = []
      for await (const c of bread.resume(childCp.checkpointId, { approved: true })) cont.push(c)
      const bossEnd = cont.findLast(
        (c) => c.type === 'agent:run:end' && (c as { agentId: string }).agentId === 'boss',
      ) as AgentRunEndCrumb
      expect(bossEnd?.output).toBe('composed: yes')
      expect(await bread.store.listCheckpoints()).toHaveLength(0)
    } finally {
      await stop()
    }
  })

  test('chain-suspension survives a restart — fresh instance over the same store', async () => {
    const approve = defineHumanTool('approve', z.object({ question: z.string() }))
    const testStore = memoryStore()
    const bossModel = mockScript([
      { tool: 'core_delegate', args: { agentId: 'gate', input: 'x' } },
      { text: 'composed after restart' },
    ])
    const gateModel = mockToolCallModel({ toolName: 'human_approve', args: { question: 'ok?' }, then: 'yes' })
    const agents = () => ({
      boss: defineTestAgent({
        model: 'boss',
        config: { supervisor: { agents: [{ agentId: 'gate' }] } },
      }),
      gate: defineTestAgent({ model: 'gate', humanTools: [approve] }),
    })

    const a = await makeBread({
      agents: agents(),
      models: { boss: bossModel, gate: gateModel },
      config: { store: testStore },
    })
    const first = await runCollect(a.bread, 'boss', 'go')
    const childCp = first.find((c) => c.type === 'human:required') as { checkpointId: string }
    await a.stop()

    const b = await makeBread({
      agents: agents(),
      models: { boss: bossModel, gate: gateModel },
      config: { store: testStore },
    })
    try {
      const cont: BreadCrumb[] = []
      for await (const c of b.bread.resume(childCp.checkpointId, { approved: true })) cont.push(c)
      const bossEnd = cont.findLast(
        (c) => c.type === 'agent:run:end' && (c as { agentId: string }).agentId === 'boss',
      ) as AgentRunEndCrumb
      expect(bossEnd?.output).toBe('composed after restart')
      expect(await b.bread.store.listCheckpoints()).toHaveLength(0)
    } finally {
      await b.stop()
    }
  })

  test('a parallel turn with one suspension chain-suspends and keeps the settled sibling result', async () => {
    const approve = defineHumanTool('approve', z.object({ question: z.string() }))
    const boss = mockScript([
      {
        tools: [
          { tool: 'core_delegate', args: { agentId: 'ok', input: 'left' } },
          { tool: 'core_delegate', args: { agentId: 'gate', input: 'right' } },
        ],
      },
      { text: 'both in hand' },
    ]) as MockLanguageModelV3
    const { bread, stop } = await makeBread({
      agents: {
        boss: defineTestAgent({
          model: 'boss',
          config: { supervisor: { max: 2, agents: [{ agentId: 'ok' }, { agentId: 'gate' }] } },
        }),
        ok: defineTestAgent({ model: 'ok' }),
        gate: defineTestAgent({ model: 'gate', humanTools: [approve] }),
      },
      models: {
        boss,
        ok: mockTextModel('sibling done'),
        gate: mockToolCallModel({ toolName: 'human_approve', args: { question: 'ok?' }, then: 'gate done' }),
      },
    })
    try {
      const first = await runCollect(bread, 'boss', 'go')
      // The healthy sibling completed; the gate suspended; boss chained.
      expect(agentIds(first, 'agent:run:end')).toContain('ok')
      const childCp = first.find((c) => c.type === 'human:required') as { checkpointId: string }
      expect(childCp).toBeDefined()

      const cont: BreadCrumb[] = []
      for await (const c of bread.resume(childCp.checkpointId, { approved: true })) cont.push(c)
      expect(textOf(cont)).toContain('both in hand')
      // The supervisor's continuation prompt held BOTH tool results.
      const lastPrompt = JSON.stringify(boss.doStreamCalls.at(-1)!.prompt)
      expect(lastPrompt).toContain('sibling done')
      expect(lastPrompt).toContain('gate done')
    } finally {
      await stop()
    }
  })

  test('two suspended delegations resolve one at a time; the last resume continues the supervisor', async () => {
    const approve = defineHumanTool('approve', z.object({ question: z.string() }))
    const { bread, stop } = await makeBread({
      agents: {
        boss: defineTestAgent({
          model: 'boss',
          config: { supervisor: { max: 2, agents: [{ agentId: 'g1' }, { agentId: 'g2' }] } },
        }),
        g1: defineTestAgent({ model: 'g1', humanTools: [approve] }),
        g2: defineTestAgent({ model: 'g2', humanTools: [approve] }),
      },
      models: {
        boss: mockScript([
          {
            tools: [
              { tool: 'core_delegate', args: { agentId: 'g1', input: 'a' } },
              { tool: 'core_delegate', args: { agentId: 'g2', input: 'b' } },
            ],
          },
          { text: 'all resolved' },
        ]),
        g1: mockToolCallModel({ toolName: 'human_approve', args: { question: 'one?' }, then: 'first' }),
        g2: mockToolCallModel({ toolName: 'human_approve', args: { question: 'two?' }, then: 'second' }),
      },
    })
    try {
      const first = await runCollect(bread, 'boss', 'go')
      const required = first.filter((c) => c.type === 'human:required') as { checkpointId: string }[]
      expect(required).toHaveLength(2)

      // First resume: child completes, supervisor still suspended.
      const cont1: BreadCrumb[] = []
      for await (const c of bread.resume(required[0]!.checkpointId, { approved: true })) cont1.push(c)
      expect(textOf(cont1)).not.toContain('all resolved')
      expect((await bread.store.listCheckpoints()).some((c) => c.pending?.length === 1)).toBe(true)

      // Second resume: last delegation resolves and the supervisor finishes.
      const cont2: BreadCrumb[] = []
      for await (const c of bread.resume(required[1]!.checkpointId, { approved: true })) cont2.push(c)
      expect(textOf(cont2)).toContain('all resolved')
      expect(await bread.store.listCheckpoints()).toHaveLength(0)
    } finally {
      await stop()
    }
  })

  test("the supervisor's own human tool suspends and resumes like any agent", async () => {
    const approve = defineHumanTool('approve', z.object({ question: z.string() }))
    const { bread, stop } = await makeBread({
      agents: {
        boss: defineTestAgent({
          model: 'boss',
          humanTools: [approve],
          config: { supervisor: { agents: [{ agentId: 'w1' }] } },
        }),
        w1: defineTestAgent({ model: 'w1' }),
      },
      models: {
        boss: mockScript([
          { tool: 'human_approve', args: { question: 'may I delegate?' } },
          { tool: 'core_delegate', args: { agentId: 'w1', input: 'x' } },
          { text: 'done' },
        ]),
        w1: mockTextModel('one'),
      },
    })
    try {
      const first = await runCollect(bread, 'boss', 'go')
      const cp = first.find((c) => c.type === 'human:required') as { checkpointId: string }
      expect(cp).toBeDefined()

      const cont: BreadCrumb[] = []
      for await (const c of bread.resume(cp.checkpointId, { approved: true })) cont.push(c)
      // After approval the supervisor went on to delegate and finish.
      expect(agentIds(cont, 'agent:run:end')).toContain('w1')
      expect(textOf(cont)).toContain('done')
    } finally {
      await stop()
    }
  })
})
