import { describe, expect, test } from 'bun:test'
import { defineHumanTool, defineTask, defineTool, LOCAL_CLI_PRINCIPAL, principalVisible, runVisible } from '@breadai/core'
import type { CancellableOptions, HumanRequiredCrumb, Principal } from '@breadai/core'
import {
  collect,
  defineTestAgent,
  makeBread,
  mockObjectModel,
  mockScript,
  mockTextModel,
  mockToolCallModel,
  runCollect,
} from '@breadai/test-utils'
import { z } from 'zod'

const host: Principal = { iss: 'https://idp.example', sub: 'user-1', tenant: 'acme', roles: [' b ', 'a', 'a'] }
const spoof: Principal = { iss: 'https://evil.example', sub: 'spoof' }

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

function noteTask(seen: Array<Principal | undefined>) {
  return defineTask({
    name: 'note',
    description: 'Record the task principal',
    model: { provider: 'mock', model: 'task' },
    instructions: 'note',
    schema: z.object({
      principal: z.object({ iss: z.string(), sub: z.string() }).optional(),
    }),
    outputSchema: z.object({ ok: z.boolean() }),
    hooks: {
      async beforeRun(c) {
        seen.push(c.principal)
        return { action: 'shortCircuit', output: { ok: true } }
      },
    },
  })
}

describe('principal', () => {
  test('a run started with a principal exposes that principal on the tool context', async () => {
    const seen: Array<Principal | undefined> = []
    const { bread, stop } = await makeBread({
      agents: { agent: defineTestAgent({ tools: [probe(seen)] }) },
      model: mockToolCallModel({ toolName: 'tool_probe', args: { principal: spoof }, then: 'done' }),
    })
    try {
      await runCollect(bread, 'agent', 'go', { principal: host })
      expect(seen).toEqual([host])
    } finally {
      await stop()
    }
  })

  test('agent:run:start carries iss and sub and drops tenant', async () => {
    const { bread, stop } = await makeBread({
      agents: { agent: defineTestAgent() },
      model: mockTextModel('hi'),
    })
    try {
      const stamped = await runCollect(bread, 'agent', 'go', { principal: host })
      const start = stamped.find((crumb) => crumb.type === 'agent:run:start')
      expect(start?.type === 'agent:run:start' ? start.principal : undefined).toEqual({
        iss: host.iss,
        sub: host.sub,
      })
      const plain = await runCollect(bread, 'agent', 'again')
      const plainStart = plain.find((crumb) => crumb.type === 'agent:run:start')
      expect(plainStart?.type === 'agent:run:start' ? plainStart.principal : undefined).toBeUndefined()
    } finally {
      await stop()
    }
  })

  test('a run started without a principal leaves principal undefined', async () => {
    const seen: Array<Principal | undefined> = []
    const { bread, stop } = await makeBread({
      agents: { agent: defineTestAgent({ tools: [probe(seen)] }) },
      model: mockToolCallModel({ toolName: 'tool_probe', args: { principal: spoof }, then: 'done' }),
    })
    try {
      await runCollect(bread, 'agent', 'go')
      expect(seen).toEqual([undefined])
    } finally {
      await stop()
    }
  })

  test("a delegated sub-agent sees the supervisor's principal, not a value from the delegate arguments", async () => {
    const seen: Array<Principal | undefined> = []
    const { bread, stop } = await makeBread({
      agents: {
        boss: defineTestAgent({
          model: 'boss',
          config: { supervisor: { agents: [{ agentId: 'worker' }] } },
        }),
        worker: defineTestAgent({ model: 'worker', tools: [probe(seen)] }),
      },
      models: {
        boss: mockScript([
          { tool: 'core_delegate', args: { agentId: 'worker', input: { principal: spoof } } },
          { text: 'done' },
        ]),
        worker: mockToolCallModel({ toolName: 'tool_probe', args: { principal: spoof }, then: 'ok' }),
      },
    })
    try {
      await runCollect(bread, 'boss', 'go', { principal: host })
      expect(seen).toEqual([host])
    } finally {
      await stop()
    }
  })

  test("a pipeline step sees the pipeline's principal", async () => {
    const seen: Array<Principal | undefined> = []
    const { bread, stop } = await makeBread({
      agents: { step: defineTestAgent({ tools: [probe(seen)] }) },
      model: mockToolCallModel({ toolName: 'tool_probe', args: { principal: spoof }, then: 'done' }),
      config: { pipelines: { p: [{ type: 'agent', agentId: 'step' }] } },
    })
    try {
      await collect(bread.runPipeline('p', { principal: spoof }, { principal: host }))
      expect(seen).toEqual([host])
    } finally {
      await stop()
    }
  })

  test("a loop iteration's inner agent sees the host run's principal", async () => {
    const seen: Array<Principal | undefined> = []
    const { bread, stop } = await makeBread({
      agents: {
        host: defineTestAgent({
          model: 'host',
          config: { loop: { pool: ['worker'], maxIterations: 1 } },
        }),
        worker: defineTestAgent({ model: 'worker', tools: [probe(seen)] }),
      },
      models: {
        host: mockScript([
          { tool: 'core_start_loop', args: { pipeline: ['worker'], input: { principal: spoof } } },
          { text: 'done' },
        ]),
        worker: mockToolCallModel({ toolName: 'tool_probe', args: { principal: spoof }, then: 'ok' }),
      },
    })
    try {
      await runCollect(bread, 'host', 'go', { principal: host })
      expect(seen).toEqual([host])
    } finally {
      await stop()
    }
  })

  test("a task tool sees the host tool context's principal", async () => {
    const seen: Array<Principal | undefined> = []
    const { bread, stop } = await makeBread({
      agents: { agent: defineTestAgent({ config: { tasks: ['note'] } }) },
      tasks: { note: noteTask(seen) },
      models: {
        default: mockScript([
          { tool: 'task_note', args: { principal: spoof } },
          { text: 'done' },
        ]),
        task: mockObjectModel({ ok: true }),
      },
    })
    try {
      await runCollect(bread, 'agent', 'go', { principal: host })
      expect(seen).toEqual([host])
    } finally {
      await stop()
    }
  })

  test('runTask with a principal exposes it on the task tool context', async () => {
    const seen: Array<Principal | undefined> = []
    const { bread, stop } = await makeBread({
      agents: { agent: defineTestAgent() },
      tasks: { note: noteTask(seen) },
      model: mockTextModel('unused'),
    })
    try {
      await bread.runTask('note', { principal: spoof }, { principal: host })
      expect(seen).toEqual([host])
    } finally {
      await stop()
    }
  })

  test('a suspended run restores the same principal on resume', async () => {
    const seen: Array<Principal | undefined> = []
    const approve = defineHumanTool('approve', z.object({ question: z.string() }))
    const { bread, stop } = await makeBread({
      agents: {
        gate: defineTestAgent({ tools: [probe(seen)], humanTools: [approve] }),
      },
      model: mockScript([
        { tool: 'human_approve', args: { question: 'ok?' } },
        { tool: 'tool_probe', args: { principal: spoof } },
        { text: 'done' },
      ]),
    })
    try {
      const first = await runCollect(bread, 'gate', 'go', { principal: host })
      const cp = first.find((c) => c.type === 'human:required') as HumanRequiredCrumb
      await collect(bread.resume(cp.checkpointId, { ok: true }))
      expect(seen).toEqual([host])
    } finally {
      await stop()
    }
  })

  test('a resume caller cannot replace the stored principal', async () => {
    const seen: Array<Principal | undefined> = []
    const approve = defineHumanTool('approve', z.object({ question: z.string() }))
    const { bread, stop } = await makeBread({
      agents: {
        gate: defineTestAgent({ tools: [probe(seen)], humanTools: [approve] }),
      },
      model: mockScript([
        { tool: 'human_approve', args: { question: 'ok?' } },
        { tool: 'tool_probe', args: { principal: spoof } },
        { text: 'done' },
      ]),
    })
    try {
      const first = await runCollect(bread, 'gate', 'go', { principal: host })
      const cp = first.find((c) => c.type === 'human:required') as HumanRequiredCrumb
      await collect(bread.resume(cp.checkpointId, { ok: true }, { principal: spoof } as CancellableOptions))
      expect(seen).toEqual([host])
    } finally {
      await stop()
    }
  })

  test('principalVisible matches iss and sub, ignores tenant, and hides an unstamped row from a caller', () => {
    expect(principalVisible(undefined, undefined)).toBe(true)
    expect(principalVisible(host, undefined)).toBe(true)
    expect(principalVisible(undefined, host)).toBe(false)
    expect(principalVisible(host, { iss: host.iss, sub: host.sub })).toBe(true)
    expect(principalVisible(host, { iss: host.iss, sub: host.sub, tenant: 'other' })).toBe(true)
    expect(principalVisible({ iss: host.iss, sub: host.sub }, host)).toBe(true)
    expect(principalVisible(host, spoof)).toBe(false)
  })

  test('a requested session the caller cannot see throws SESSION_NOT_FOUND before agent:run:start', async () => {
    let hooked = false
    const { bread, stop } = await makeBread({
      agents: {
        agent: defineTestAgent({
          config: {
            hooks: {
              beforeRun() {
                hooked = true
              },
            },
          },
        }),
      },
      model: mockTextModel('hi'),
    })
    const started: string[] = []
    bread.on('crumb', (crumb) => {
      if (crumb.type === 'agent:run:start') started.push(crumb.sessionId)
    })
    try {
      const first = await runCollect(bread, 'agent', 'go', { principal: host, session: { id: 'owned', tags: { user: 'spoof' } } })
      expect(first.some((crumb) => crumb.type === 'agent:run:start')).toBe(true)
      expect((await bread.store.getSession('owned'))?.principal).toEqual(host)
      expect(hooked).toBe(true)
      hooked = false

      await expect(
        runCollect(bread, 'agent', 'again', {
          principal: spoof,
          session: { id: 'owned', tags: { user: spoof.sub } },
        }),
      ).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' })
      expect(hooked).toBe(false)
      expect(started).toEqual(['owned'])
      expect(await bread.store.getSession('owned')).toBeDefined()

      const continued = await runCollect(bread, 'agent', 'again', {
        principal: { iss: host.iss, sub: host.sub },
        session: { id: 'owned' },
      })
      expect(continued.some((crumb) => crumb.type === 'agent:run:start')).toBe(true)
      expect((await bread.store.getSession('owned'))?.principal).toEqual(host)

      await bread.store.createSession({ id: 'plain' })
      await expect(
        runCollect(bread, 'agent', 'nope', { principal: host, session: { id: 'plain' } }),
      ).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' })
      const unscoped = await runCollect(bread, 'agent', 'open', { session: { id: 'plain' } })
      expect(unscoped.some((crumb) => crumb.type === 'agent:run:start')).toBe(true)
      expect((await bread.store.getSession('plain'))?.principal).toBeUndefined()
    } finally {
      await stop()
    }
  })

  test('the local cli principal claims a null session and another iss or sub does not', async () => {
    const { bread, stop } = await makeBread({
      agents: { agent: defineTestAgent() },
      model: mockTextModel('hi'),
    })
    try {
      await bread.store.createSession({ id: 'legacy' })
      await expect(
        runCollect(bread, 'agent', 'nope', {
          principal: { iss: LOCAL_CLI_PRINCIPAL.iss, sub: 'other' },
          session: { id: 'legacy' },
        }),
      ).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' })
      await expect(
        runCollect(bread, 'agent', 'nope', {
          principal: { iss: 'https://other.example', sub: LOCAL_CLI_PRINCIPAL.sub },
          session: { id: 'legacy' },
        }),
      ).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' })
      expect((await bread.store.getSession('legacy'))?.principal).toBeUndefined()

      const opened = await runCollect(bread, 'agent', 'go', {
        principal: LOCAL_CLI_PRINCIPAL,
        session: { id: 'legacy' },
      })
      expect(opened.some((crumb) => crumb.type === 'agent:run:start')).toBe(true)
      expect((await bread.store.getSession('legacy'))?.principal).toEqual(LOCAL_CLI_PRINCIPAL)

      const again = await runCollect(bread, 'agent', 'go', {
        principal: { ...LOCAL_CLI_PRINCIPAL, tenant: 'ignored' },
        session: { id: 'legacy' },
      })
      expect(again.some((crumb) => crumb.type === 'agent:run:start')).toBe(true)
      expect((await bread.store.getSession('legacy'))?.principal).toEqual(LOCAL_CLI_PRINCIPAL)
    } finally {
      await stop()
    }
  })
})

describe('runVisible', () => {
  const owner = { iss: 'https://idp.example', sub: 'user-1' }
  const other = { iss: 'https://idp.example', sub: 'user-2' }
  const logged = (principal?: typeof owner) => ({
    getCrumbs: async () => [
      {
        runId: 'r1',
        seq: 1,
        type: 'agent:run:start',
        sessionId: 's1',
        crumb: { type: 'agent:run:start', ...(principal ? { principal } : {}) },
      },
    ],
  })
  const noLog = { getCrumbs: async () => [] }

  test('an unscoped caller sees every run', async () => {
    expect(await runVisible({}, 'r1', undefined)).toBe(true)
  })

  test('a live owner decides before the crumb log is read', async () => {
    expect(await runVisible(noLog, 'r1', owner, { principal: owner })).toBe(true)
    expect(await runVisible(logged(owner), 'r1', other, { principal: owner })).toBe(false)
  })

  test('a finished run is visible to the principal on its start crumb only', async () => {
    expect(await runVisible(logged(owner), 'r1', { ...owner, tenant: 'acme' })).toBe(true)
    expect(await runVisible(logged(owner), 'r1', other)).toBe(false)
  })

  test('a run with no owner is visible to the local cli principal only', async () => {
    expect(await runVisible(logged(), 'r1', LOCAL_CLI_PRINCIPAL)).toBe(true)
    expect(await runVisible(logged(), 'r1', owner)).toBe(false)
    expect(await runVisible(noLog, 'r1', LOCAL_CLI_PRINCIPAL, { principal: undefined })).toBe(true)
  })

  test('a scoped caller is refused with no live owner and no logged start crumb', async () => {
    expect(await runVisible({}, 'r1', owner)).toBe(false)
    expect(await runVisible(noLog, 'r1', owner)).toBe(false)
  })
})
