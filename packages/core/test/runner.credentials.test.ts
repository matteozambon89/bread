import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { defineTool } from '@bread/core'
import type { CredentialProvider, HumanRequiredCrumb } from '@bread/core'
import { collect, defineTestAgent, makeBread, mockScript, runCollect } from '@bread/test-utils'

function makeCredentialTool(
  captured: Array<string | undefined>,
  extra?: { credentialProvider?: CredentialProvider; credentials?: string[] },
) {
  return defineTool({
    name: 'read_secret',
    description: 'Reads TEST_SECRET via ctx.credentials',
    schema: z.object({}),
    // Defaults to declaring TEST_SECRET so the pre-existing resolution-priority
    // tests below keep exercising the "declared name resolves" path; pass
    // `credentials` explicitly (including `[]`) to test the allowlist itself.
    credentials: extra && 'credentials' in extra ? extra.credentials : ['TEST_SECRET'],
    ...(extra?.credentialProvider ? { credentialProvider: extra.credentialProvider } : {}),
    execute: async (_args, ctx) => {
      captured.push(await ctx.credentials.get('TEST_SECRET'))
      return { ok: true }
    },
  })
}

// Unlike makeCredentialTool, this catches the rejection and records the thrown
// BreadError's code. The AI-SDK tool-call path doesn't currently propagate a
// thrown tool error up through streamText's fullStream as a rejection (a
// pre-existing gap distinct from this change — see runner.error.test.ts), so
// asserting on the captured code is what actually proves the allowlist fired,
// uniformly across both the live-run and resume paths.
function makeCatchingCredentialTool(captured: string[], extra?: { credentials?: string[] }) {
  return defineTool({
    name: 'read_secret',
    description: 'Reads TEST_SECRET via ctx.credentials, catching a denial',
    schema: z.object({}),
    credentials: extra && 'credentials' in extra ? extra.credentials : ['TEST_SECRET'],
    execute: async (_args, ctx) => {
      try {
        captured.push((await ctx.credentials.get('TEST_SECRET')) ?? 'undefined')
      } catch (err) {
        captured.push(`ERROR:${(err as { code?: string }).code ?? 'unknown'}`)
      }
      return { ok: true }
    },
  })
}

describe('runner — credential provider resolution', () => {
  beforeEach(() => {
    delete process.env.TEST_SECRET
  })
  afterEach(() => {
    delete process.env.TEST_SECRET
  })

  test('defaults to process.env when neither BreadConfig.credentials nor a tool credentialProvider is set', async () => {
    process.env.TEST_SECRET = 'from-env'
    const captured: Array<string | undefined> = []
    const tool = makeCredentialTool(captured)
    const { bread, stop } = await makeBread({
      agents: { calc: defineTestAgent({ tools: [tool] }) },
      model: mockScript([{ tool: 'tool_read_secret', args: {} }, { text: 'done' }]),
    })
    try {
      await runCollect(bread, 'calc', 'go')
      expect(captured).toEqual(['from-env'])
    } finally {
      await stop()
    }
  })

  test('a BreadConfig.credentials default is consulted when a tool has no credentialProvider of its own', async () => {
    const captured: Array<string | undefined> = []
    const tool = makeCredentialTool(captured)
    const configProvider: CredentialProvider = {
      get: async (name) => (name === 'TEST_SECRET' ? 'from-config-default' : undefined),
    }
    const { bread, stop } = await makeBread({
      agents: { calc: defineTestAgent({ tools: [tool] }) },
      model: mockScript([{ tool: 'tool_read_secret', args: {} }, { text: 'done' }]),
      config: { credentials: configProvider },
    })
    try {
      await runCollect(bread, 'calc', 'go')
      expect(captured).toEqual(['from-config-default'])
    } finally {
      await stop()
    }
  })

  test("a tool's own credentialProvider takes priority over the BreadConfig default", async () => {
    const captured: Array<string | undefined> = []
    const toolProvider: CredentialProvider = { get: async () => 'from-tool' }
    const tool = makeCredentialTool(captured, { credentialProvider: toolProvider })
    const configProvider: CredentialProvider = { get: async () => 'from-config' }
    const { bread, stop } = await makeBread({
      agents: { calc: defineTestAgent({ tools: [tool] }) },
      model: mockScript([{ tool: 'tool_read_secret', args: {} }, { text: 'done' }]),
      config: { credentials: configProvider },
    })
    try {
      await runCollect(bread, 'calc', 'go')
      expect(captured).toEqual(['from-tool'])
    } finally {
      await stop()
    }
  })

  test('the resume (HITL approval) path resolves credentials with the same priority as the live path', async () => {
    const captured: Array<string | undefined> = []
    const tool = makeCredentialTool(captured)
    const configProvider: CredentialProvider = {
      get: async (name) => (name === 'TEST_SECRET' ? 'from-config-default' : undefined),
    }
    const { bread, stop } = await makeBread({
      agents: {
        calc: defineTestAgent({ tools: [tool], config: { permissions: { ask: ['tool:read_secret'] } } }),
      },
      model: mockScript([{ tool: 'tool_read_secret', args: {} }, { text: 'done' }]),
      config: { credentials: configProvider },
    })
    try {
      const first = await runCollect(bread, 'calc', 'go')
      expect(captured).toEqual([])
      const required = first.find((c) => c.type === 'human:required') as HumanRequiredCrumb
      await collect(bread.resume(required.checkpointId, { approved: true }))
      expect(captured).toEqual(['from-config-default'])
    } finally {
      await stop()
    }
  })
})

describe('runner — credential allowlist enforcement', () => {
  beforeEach(() => {
    process.env.TEST_SECRET = 'from-env'
  })
  afterEach(() => {
    delete process.env.TEST_SECRET
  })

  test('a name outside the declared allowlist is rejected, even if the base provider would resolve it', async () => {
    const captured: string[] = []
    const tool = makeCatchingCredentialTool(captured, { credentials: ['OTHER_SECRET'] })
    const { bread, stop } = await makeBread({
      agents: { calc: defineTestAgent({ tools: [tool] }) },
      model: mockScript([{ tool: 'tool_read_secret', args: {} }, { text: 'done' }]),
    })
    try {
      await runCollect(bread, 'calc', 'go')
      expect(captured).toEqual(['ERROR:CREDENTIAL_NOT_DECLARED'])
    } finally {
      await stop()
    }
  })

  test('a tool with no `credentials` array at all gets no credentials', async () => {
    const captured: string[] = []
    const tool = makeCatchingCredentialTool(captured, { credentials: undefined })
    const { bread, stop } = await makeBread({
      agents: { calc: defineTestAgent({ tools: [tool] }) },
      model: mockScript([{ tool: 'tool_read_secret', args: {} }, { text: 'done' }]),
    })
    try {
      await runCollect(bread, 'calc', 'go')
      expect(captured).toEqual(['ERROR:CREDENTIAL_NOT_DECLARED'])
    } finally {
      await stop()
    }
  })

  test('a tool with an explicit empty `credentials: []` gets no credentials', async () => {
    const captured: string[] = []
    const tool = makeCatchingCredentialTool(captured, { credentials: [] })
    const { bread, stop } = await makeBread({
      agents: { calc: defineTestAgent({ tools: [tool] }) },
      model: mockScript([{ tool: 'tool_read_secret', args: {} }, { text: 'done' }]),
    })
    try {
      await runCollect(bread, 'calc', 'go')
      expect(captured).toEqual(['ERROR:CREDENTIAL_NOT_DECLARED'])
    } finally {
      await stop()
    }
  })

  test('the resume (HITL approval) path enforces the same allowlist as the live path', async () => {
    const captured: string[] = []
    const tool = makeCatchingCredentialTool(captured, { credentials: ['OTHER_SECRET'] })
    const { bread, stop } = await makeBread({
      agents: {
        calc: defineTestAgent({ tools: [tool], config: { permissions: { ask: ['tool:read_secret'] } } }),
      },
      model: mockScript([{ tool: 'tool_read_secret', args: {} }, { text: 'done' }]),
    })
    try {
      const first = await runCollect(bread, 'calc', 'go')
      const required = first.find((c) => c.type === 'human:required') as HumanRequiredCrumb
      await collect(bread.resume(required.checkpointId, { approved: true }))
      expect(captured).toEqual(['ERROR:CREDENTIAL_NOT_DECLARED'])
    } finally {
      await stop()
    }
  })
})
