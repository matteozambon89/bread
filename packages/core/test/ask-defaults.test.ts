import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { gateAskDefaults, leafName, type ToolOrigin } from '../src/permissions.js'
import { assembleTools } from '../src/runner-tool-assembly.js'
import { buildAiSdkTools } from '../src/runner-tool-execution.js'
import type { RunnerContext } from '../src/runner-types.js'
import type { AgentConfig, ToolDefinition } from '../src/types.js'

const stripeEcho: ToolOrigin = { scope: 'plugin', sub: 'mcp_client', name: 'stripe__echo' }

function toolDef(ask?: boolean): ToolDefinition {
  return {
    name: 'stripe__echo',
    description: 'echo',
    schema: z.object({}),
    ...(ask ? { ask: true as const } : {}),
    execute: () => 'ok',
  }
}

function agentConfig(permissions?: AgentConfig<string, string>['permissions']): AgentConfig<string, string> {
  return {
    model: { provider: 'test', model: 'test' },
    inputSchema: z.string(),
    outputSchema: z.string(),
    output: { format: 'text' },
    ...(permissions ? { permissions } : {}),
  }
}

describe('leafName', () => {
  test('an mcp tool namespaced stripe__echo under plugin mcp_client uses that leaf', () => {
    expect(leafName(stripeEcho)).toBe('plugin_mcp_client_stripe__echo')
  })
})

describe('gateAskDefaults', () => {
  test('ask true gates the leaf', () => {
    const gated = gateAskDefaults(new Set(), [{ origin: stripeEcho, def: { ask: true } }])
    expect(gated.has(leafName(stripeEcho))).toBe(true)
  })

  test('an empty allow list is not an explicit allow, so the default still gates', () => {
    const gated = gateAskDefaults(new Set(), [{ origin: stripeEcho, def: { ask: true } }], { allow: [] })
    expect(gated.has(leafName(stripeEcho))).toBe(true)
  })

  test('an explicit allow that matches, with no ask selector, does not gate', () => {
    const gated = gateAskDefaults(new Set(), [{ origin: stripeEcho, def: { ask: true } }], {
      allow: ['plugin:mcp_client/stripe__echo'],
    })
    expect(gated.has(leafName(stripeEcho))).toBe(false)
  })

  test('an explicit allow and an ask selector that both match still gates', () => {
    const gated = gateAskDefaults(new Set(), [{ origin: stripeEcho, def: { ask: true } }], {
      allow: ['plugin:mcp_client/stripe__echo'],
      ask: ['plugin:mcp_client/stripe__echo'],
    })
    expect(gated.has(leafName(stripeEcho))).toBe(true)
  })

  test('a tool already dropped from entries is not gated', () => {
    const dropped: ToolOrigin = { scope: 'plugin', sub: 'mcp_client', name: 'stripe__delete' }
    const gated = gateAskDefaults(new Set(), [{ origin: stripeEcho, def: { ask: true } }], {
      deny: ['plugin:mcp_client/stripe__delete'],
    })
    expect(gated.has(leafName(dropped))).toBe(false)
  })

  test('a definition without ask does not gate', () => {
    const gated = gateAskDefaults(new Set(), [{ origin: stripeEcho, def: {} }])
    expect(gated.has(leafName(stripeEcho))).toBe(false)
  })
})

describe('assembleTools ask defaults', () => {
  function ctx(ask?: boolean): RunnerContext {
    return {
      store: {} as RunnerContext['store'],
      agents: new Map(),
      pluginTools: [{ plugin: 'mcp_client', def: toolDef(ask) }],
    }
  }

  test('ask true on a surviving plugin tool gates that leaf', async () => {
    const { gated } = await assembleTools('agent', agentConfig(), 'run', 'session', {}, ctx(true), () => {})
    expect(gated.has(leafName(stripeEcho))).toBe(true)
  })

  test('an explicit allow overrides the ask default', async () => {
    const { gated } = await assembleTools(
      'agent',
      agentConfig({ allow: ['plugin:mcp_client/stripe__echo'] }),
      'run',
      'session',
      {},
      ctx(true),
      () => {},
    )
    expect(gated.has(leafName(stripeEcho))).toBe(false)
  })

  test('a tool permissions.deny already dropped is not resurrected into gated', async () => {
    const { gated, executables } = await assembleTools(
      'agent',
      agentConfig({ deny: ['plugin:mcp_client/stripe__echo'] }),
      'run',
      'session',
      {},
      ctx(true),
      () => {},
    )
    expect(executables.has(leafName(stripeEcho))).toBe(false)
    expect(gated.has(leafName(stripeEcho))).toBe(false)
  })
})

describe('buildAiSdkTools', () => {
  test('the model tool does not receive ask', () => {
    const tools = buildAiSdkTools(
      new Map([[leafName(stripeEcho), { origin: stripeEcho, def: toolDef(true) }]]),
      new Set(),
      new Map(),
      'agent',
      'run',
      'session',
      () => {},
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    )
    expect(tools[leafName(stripeEcho)]).not.toHaveProperty('ask')
  })
})
