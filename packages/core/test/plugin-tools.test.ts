import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { defineTool } from '@breadai/core'
import type { BreadInstance, BreadPlugin, ToolResultCrumb } from '@breadai/core'
import { defineTestAgent, makeBread, mockToolCallModel, runCollect } from '@breadai/test-utils'

describe('runner — global plugin tools', () => {
  let bread: BreadInstance
  let stop: () => Promise<void>
  let calls: number

  beforeEach(async () => {
    calls = 0
    const ping = defineTool({
      name: 'ping',
      description: 'Returns pong',
      schema: z.object({}),
      execute: async () => {
        calls++
        return { reply: 'pong' }
      },
    })
    const toolsPlugin: BreadPlugin = { name: 'tools_plugin', tools: [ping] }
    ;({ bread, stop } = await makeBread({
      // The agent declares no tools of its own — `ping` is contributed globally by the plugin.
      agents: { bare: defineTestAgent({}) },
      plugins: [toolsPlugin],
      model: mockToolCallModel({ toolName: 'plugin_tools_plugin_ping', args: {}, then: 'done' }),
    }))
  })

  afterEach(() => stop())

  test('an agent can call a tool contributed only by a plugin', async () => {
    await runCollect(bread, 'bare', 'go')
    expect(calls).toBe(1)
  })

  test('the plugin tool result surfaces as a tool:result crumb', async () => {
    const crumbs = await runCollect(bread, 'bare', 'go')
    const result = crumbs.find((c) => c.type === 'tool:result') as ToolResultCrumb | undefined
    expect(result?.toolName).toBe('plugin_tools_plugin_ping')
    expect(result?.result).toEqual({ reply: 'pong' })
  })
})
