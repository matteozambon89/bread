import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { defineTool } from '@breadai/core'
import type { BreadCrumb, BreadPlugin, HumanRequiredCrumb, HumanResumedCrumb, ToolResultCrumb } from '@breadai/core'
import { collect, defineTestAgent, makeBread, mockScript, mockTextModel, runCollect } from '@breadai/test-utils'

function makeAddTool(calls: Array<{ a: number; b: number }>) {
  return defineTool({
    name: 'add',
    description: 'Add two numbers',
    schema: z.object({ a: z.number(), b: z.number() }),
    execute: async ({ a, b }) => {
      calls.push({ a, b })
      return { sum: a + b }
    },
  })
}

describe('runner — permissions: allow/deny', () => {
  test('a denied tool never executes, even if the model calls it anyway', async () => {
    const calls: Array<{ a: number; b: number }> = []
    const add = makeAddTool(calls)
    const { bread, stop } = await makeBread({
      agents: {
        calc: defineTestAgent({ tools: [add], config: { permissions: { deny: ['tool:add'] } } }),
      },
      model: mockScript([{ tool: 'tool_add', args: { a: 2, b: 3 } }, { text: 'done' }]),
    })
    try {
      const crumbs = await runCollect(bread, 'calc', 'go')
      expect(calls).toEqual([])
      expect(crumbs.map((c) => c.type)).not.toContain('tool:result')
    } finally {
      await stop()
    }
  })

  test('a non-empty allow list excludes everything not listed', async () => {
    const calls: Array<{ a: number; b: number }> = []
    const add = makeAddTool(calls)
    const { bread, stop } = await makeBread({
      agents: {
        calc: defineTestAgent({
          tools: [add],
          config: { permissions: { allow: ['tool:nonexistent'] } },
        }),
      },
      model: mockScript([{ tool: 'tool_add', args: { a: 2, b: 3 } }, { text: 'done' }]),
    })
    try {
      const crumbs = await runCollect(bread, 'calc', 'go')
      expect(calls).toEqual([])
      expect(crumbs.map((c) => c.type)).not.toContain('tool:result')
    } finally {
      await stop()
    }
  })

  test('an allowed tool still executes normally', async () => {
    const calls: Array<{ a: number; b: number }> = []
    const add = makeAddTool(calls)
    const { bread, stop } = await makeBread({
      agents: {
        calc: defineTestAgent({ tools: [add], config: { permissions: { allow: ['tool:add'] } } }),
      },
      model: mockScript([{ tool: 'tool_add', args: { a: 2, b: 3 } }, { text: 'done' }]),
    })
    try {
      const crumbs = await runCollect(bread, 'calc', 'go')
      expect(calls).toEqual([{ a: 2, b: 3 }])
      expect(crumbs.map((c) => c.type)).toContain('tool:result')
    } finally {
      await stop()
    }
  })

  test('a partial glob deny blocks a matching tool but not a sibling', async () => {
    const readCalls: unknown[] = []
    const writeCalls: unknown[] = []
    const readFile = defineTool({
      name: 'read_file',
      description: 'Read a file',
      schema: z.object({}),
      execute: async () => {
        readCalls.push(true)
        return 'contents'
      },
    })
    const writeFile = defineTool({
      name: 'write_file',
      description: 'Write a file',
      schema: z.object({}),
      execute: async () => {
        writeCalls.push(true)
        return 'ok'
      },
    })
    const agentConfig = { permissions: { deny: ['tool:read_*'] } }

    const denied = await makeBread({
      agents: { fs: defineTestAgent({ tools: [readFile, writeFile], config: agentConfig }) },
      model: mockScript([{ tool: 'tool_read_file', args: {} }, { text: 'done' }]),
    })
    try {
      const crumbs = await runCollect(denied.bread, 'fs', 'go')
      expect(readCalls).toEqual([])
      expect(crumbs.map((c) => c.type)).not.toContain('tool:result')
    } finally {
      await denied.stop()
    }

    const allowed = await makeBread({
      agents: { fs: defineTestAgent({ tools: [readFile, writeFile], config: agentConfig }) },
      model: mockScript([{ tool: 'tool_write_file', args: {} }, { text: 'done' }]),
    })
    try {
      const crumbs = await runCollect(allowed.bread, 'fs', 'go')
      expect(writeCalls).toEqual([true])
      expect(crumbs.map((c) => c.type)).toContain('tool:result')
    } finally {
      await allowed.stop()
    }
  })

  test('throws TOOL_NAME_COLLISION when two tools resolve to the same leaf', async () => {
    const calls: Array<{ a: number; b: number }> = []
    const addV1 = makeAddTool(calls)
    const addV2 = makeAddTool(calls)
    const { bread, stop } = await makeBread({
      agents: { calc: defineTestAgent({ tools: [addV1, addV2] }) },
      model: mockTextModel('unused'),
    })
    try {
      await expect(runCollect(bread, 'calc', 'go')).rejects.toThrow(/TOOL_NAME_COLLISION|same name/i)
    } finally {
      await stop()
    }
  })
})

describe('runner — plugin.resolveAgentTools', () => {
  test('a dynamically-resolved tool gets the same plugin:<name>/<tool> treatment as a static plugin tool', async () => {
    const calls: string[] = []
    const dynamicPlugin: BreadPlugin = {
      name: 'dynamic_source',
      async resolveAgentTools(agentId, cfg) {
        if (!(cfg.plugins?.dynamic_source as { enabled?: boolean } | undefined)?.enabled) return []
        return [
          defineTool({
            name: 'ping',
            description: 'ping',
            schema: z.object({}),
            execute: async () => {
              calls.push(agentId)
              return 'pong'
            },
          }),
        ]
      },
    }
    const { bread, stop } = await makeBread({
      agents: {
        a: defineTestAgent({ config: { plugins: { dynamic_source: { enabled: true } } } }),
      },
      plugins: [dynamicPlugin],
      model: mockScript([{ tool: 'plugin_dynamic_source_ping', args: {} }, { text: 'done' }]),
    })
    try {
      const crumbs = await runCollect(bread, 'a', 'go')
      expect(calls).toEqual(['a'])
      expect(crumbs.map((c) => c.type)).toContain('tool:result')
    } finally {
      await stop()
    }
  })

  test('a static plugin tool and a same-named dynamically-resolved one collide, same as any other duplicate', async () => {
    const collidingPlugin: BreadPlugin = {
      name: 'colliding',
      tools: [
        defineTool({ name: 'dup', description: 'static', schema: z.object({}), execute: async () => 'static' }),
      ],
      async resolveAgentTools() {
        return [
          defineTool({ name: 'dup', description: 'dynamic', schema: z.object({}), execute: async () => 'dynamic' }),
        ]
      },
    }
    const { bread, stop } = await makeBread({
      agents: { a: defineTestAgent() },
      plugins: [collidingPlugin],
      model: mockTextModel('unused'),
    })
    try {
      await expect(runCollect(bread, 'a', 'go')).rejects.toThrow(/TOOL_NAME_COLLISION|same name/i)
    } finally {
      await stop()
    }
  })

  test('resolveAgentTools not returning anything (no cfg.plugins entry) is a no-op', async () => {
    const passivePlugin: BreadPlugin = {
      name: 'passive',
      async resolveAgentTools(_agentId, cfg) {
        return (cfg.plugins?.passive as { tools?: never[] } | undefined) ? [] : []
      },
    }
    const { bread, stop } = await makeBread({
      agents: { a: defineTestAgent() },
      plugins: [passivePlugin],
      model: mockTextModel('ok'),
    })
    try {
      const crumbs = await runCollect(bread, 'a', 'go')
      expect(crumbs.map((c) => c.type)).not.toContain('tool:result')
    } finally {
      await stop()
    }
  })
})

describe('runner — permissions: ask gate', () => {
  function gatedHarness(calls: Array<{ a: number; b: number }>) {
    const add = makeAddTool(calls)
    return makeBread({
      agents: {
        calc: defineTestAgent({ tools: [add], config: { permissions: { ask: ['tool:add'] } } }),
      },
      model: mockScript([{ tool: 'tool_add', args: { a: 2, b: 3 } }, { text: 'the sum is 5' }]),
    })
  }

  test('suspends with kind:approval and does not execute the tool', async () => {
    const calls: Array<{ a: number; b: number }> = []
    const { bread, stop } = await gatedHarness(calls)
    try {
      const crumbs = await runCollect(bread, 'calc', 'go')
      expect(calls).toEqual([])
      expect(crumbs.map((c) => c.type)).not.toContain('tool:result')
      const required = crumbs.find((c) => c.type === 'human:required') as HumanRequiredCrumb | undefined
      expect(required?.kind).toBe('approval')
      expect(required?.toolName).toBe('tool_add')
    } finally {
      await stop()
    }
  })

  test('resume({approved:true}) runs the real tool and continues the run', async () => {
    const calls: Array<{ a: number; b: number }> = []
    const { bread, stop } = await gatedHarness(calls)
    try {
      const first = await runCollect(bread, 'calc', 'go')
      const required = first.find((c) => c.type === 'human:required') as HumanRequiredCrumb

      const cont = await collect(bread.resume(required.checkpointId, { approved: true }))
      expect(calls).toEqual([{ a: 2, b: 3 }])

      const resumed = cont.find((c) => c.type === 'human:resumed') as HumanResumedCrumb | undefined
      expect(resumed?.kind).toBe('approval')

      const result = cont.find((c) => c.type === 'tool:result') as ToolResultCrumb | undefined
      expect(result?.toolName).toBe('tool_add')
      expect(result?.result).toEqual({ sum: 5 })

      expect(cont.map((c) => c.type)).toContain('agent:run:end')
    } finally {
      await stop()
    }
  })

  test('resume({approved:false}) denies the tool without executing it', async () => {
    const calls: Array<{ a: number; b: number }> = []
    const { bread, stop } = await gatedHarness(calls)
    try {
      const sessionId = 'ask-gate-denial-1'
      const first = await runCollect(bread, 'calc', 'go', { session: { id: sessionId } })
      const required = first.find((c) => c.type === 'human:required') as HumanRequiredCrumb

      const cont = await collect(bread.resume(required.checkpointId, { approved: false }))
      expect(calls).toEqual([])
      expect(cont.map((c) => c.type)).not.toContain('tool:result')

      const resumed = cont.find((c) => c.type === 'human:resumed') as HumanResumedCrumb | undefined
      expect(resumed?.kind).toBe('approval')

      const persisted = await bread.store.getMessages(sessionId)
      const toolResult = persisted.find((m) => m.role === 'tool') as
        | { content: Array<{ output: { value: unknown } }> }
        | undefined
      expect(toolResult?.content[0]?.output.value).toEqual({ denied: true, reason: 'rejected by human' })
    } finally {
      await stop()
    }
  })
})
