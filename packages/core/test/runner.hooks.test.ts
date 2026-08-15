import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { BreadError } from '@breadai/core'
import type { AgentRunEndCrumb, BreadPlugin, HumanRequiredCrumb } from '@breadai/core'
import {
  collect,
  defineTestAgent,
  makeBread,
  mockErrorModel,
  mockFlakyObjectModel,
  mockObjectModel,
  mockScript,
  mockTextModel,
  runCollect,
} from '@breadai/test-utils'

// The full beforeRun/afterRun/onError/onSuspend contract at Agent+Bread scope:
// chain ordering (agent -> plugin -> global), short-circuit, retry/recover/fail,
// and the onSuspend/onHumanRequired coexistence. See docs/agents.md#hooks.

describe('hooks — beforeRun (agent scope)', () => {
  test('a no-op beforeRun leaves the input unchanged', async () => {
    const { bread, stop } = await makeBread({
      agents: { a: defineTestAgent({ config: { hooks: { beforeRun: () => undefined } } }) },
      model: mockTextModel('done'),
    })
    const sessionId = 'before-noop'
    await runCollect(bread, 'a', 'hello', { session: { id: sessionId } })
    const messages = await bread.store.getMessages(sessionId)
    expect(messages[0]?.content).toBe('hello')
    await stop()
  })

  test('beforeRun can override the input', async () => {
    const { bread, stop } = await makeBread({
      agents: {
        a: defineTestAgent({
          config: { hooks: { beforeRun: () => ({ action: 'continue', input: 'overridden' }) } },
        }),
      },
      model: mockTextModel('done'),
    })
    const sessionId = 'before-override'
    await runCollect(bread, 'a', 'hello', { session: { id: sessionId } })
    const messages = await bread.store.getMessages(sessionId)
    expect(messages[0]?.content).toBe('overridden')
    await stop()
  })

  test('a short-circuit skips the model entirely and still runs afterRun', async () => {
    let afterRunOutput: unknown
    const { bread, stop } = await makeBread({
      agents: {
        a: defineTestAgent({
          config: {
            hooks: {
              beforeRun: () => ({ action: 'shortCircuit', output: 'cached-answer' }),
              afterRun: (ctx) => {
                afterRunOutput = ctx.output
              },
            },
          },
        }),
      },
      // Would throw if ever called — proves the short-circuit really skips it.
      model: mockScript([{ text: 'should never stream' }]),
    })
    const crumbs = await runCollect(bread, 'a', 'hello')
    expect(crumbs.map((c) => c.type)).not.toContain('text:delta')
    const end = crumbs.find((c) => c.type === 'agent:run:end') as AgentRunEndCrumb
    expect(end.output).toBe('cached-answer')
    expect(afterRunOutput).toBe('cached-answer')
    await stop()
  })

  test('chains: an agent-level override feeds into the global hook, which can override again', async () => {
    const seen: unknown[] = []
    const { bread, stop } = await makeBread({
      agents: {
        a: defineTestAgent({
          config: {
            hooks: {
              beforeRun: (ctx) => {
                seen.push(ctx.input)
                return { action: 'continue', input: 'agent-override' }
              },
            },
          },
        }),
      },
      model: mockTextModel('done'),
      config: {
        hooks: {
          beforeRun: (ctx) => {
            seen.push(ctx.input)
            return { action: 'continue', input: 'global-override' }
          },
        },
      },
    })
    const sessionId = 'chain-override'
    await runCollect(bread, 'a', 'hello', { session: { id: sessionId } })
    expect(seen).toEqual(['hello', 'agent-override'])
    const messages = await bread.store.getMessages(sessionId)
    expect(messages[0]?.content).toBe('global-override')
    await stop()
  })

  test('an agent-level short-circuit skips the global hook entirely', async () => {
    let globalCalled = false
    const { bread, stop } = await makeBread({
      agents: {
        a: defineTestAgent({
          config: { hooks: { beforeRun: () => ({ action: 'shortCircuit', output: 'x' }) } },
        }),
      },
      model: mockTextModel('unused'),
      config: { hooks: { beforeRun: () => void (globalCalled = true) } },
    })
    await runCollect(bread, 'a', 'hello')
    expect(globalCalled).toBe(false)
    await stop()
  })
})

describe('hooks — afterRun (agent scope)', () => {
  test('fires on the JSON branch and can replace the output', async () => {
    const { bread, stop } = await makeBread({
      agents: {
        a: defineTestAgent({
          config: {
            output: { format: 'json' },
            outputSchema: z.object({ ok: z.boolean() }),
            hooks: {
              afterRun: (ctx) => {
                expect((ctx.output as { ok: boolean }).ok).toBe(true)
                return { output: { ok: true, wrapped: true } }
              },
            },
          },
        }),
      },
      model: mockObjectModel({ ok: true }),
    })
    const sessionId = 'after-json'
    const crumbs = await runCollect(bread, 'a', 'go', { session: { id: sessionId } })
    const end = crumbs.find((c) => c.type === 'agent:run:end') as AgentRunEndCrumb
    expect(end.output).toEqual({ ok: true, wrapped: true })
    const messages = await bread.store.getMessages(sessionId)
    const assistant = messages.find((m) => m.role === 'assistant')
    expect(JSON.parse(assistant!.content as string)).toEqual({ ok: true, wrapped: true })
    await stop()
  })

  test('fires on the streaming (text) branch and can replace the output', async () => {
    const { bread, stop } = await makeBread({
      agents: {
        a: defineTestAgent({
          config: { hooks: { afterRun: () => ({ output: 'replaced-text' }) } },
        }),
      },
      model: mockTextModel('original-text'),
    })
    const crumbs = await runCollect(bread, 'a', 'go')
    const end = crumbs.find((c) => c.type === 'agent:run:end') as AgentRunEndCrumb
    expect(end.output).toBe('replaced-text')
    await stop()
  })

  test('does not fire on HITL suspend, but fires once resume() completes the run', async () => {
    const calls: unknown[] = []
    const { bread, stop } = await makeBread({
      agents: {
        a: defineTestAgent({
          humanTools: [{ name: 'ask_human', schema: z.object({ q: z.string() }), _human: true }],
          config: { hooks: { afterRun: (ctx) => void calls.push(ctx.output) } },
        }),
      },
      model: mockScript([{ tool: 'human_ask_human', args: { q: 'ok?' } }, { text: 'thanks' }]),
    })
    const first = await runCollect(bread, 'a', 'go')
    expect(calls).toEqual([])
    const required = first.find((c) => c.type === 'human:required') as HumanRequiredCrumb
    await collect(bread.resume(required.checkpointId, 'yes'))
    expect(calls).toEqual(['thanks'])
    await stop()
  })

  test('plugin-contributed afterRun runs between the agent hook and the global hook', async () => {
    const order: string[] = []
    const plugin: BreadPlugin = {
      name: 'order_plugin',
      hooks: { afterRun: () => void order.push('plugin') },
    }
    const { bread, stop } = await makeBread({
      agents: {
        a: defineTestAgent({ config: { hooks: { afterRun: () => void order.push('agent') } } }),
      },
      model: mockTextModel('done'),
      plugins: [plugin],
      config: { hooks: { afterRun: () => void order.push('global') } },
    })
    await runCollect(bread, 'a', 'go')
    expect(order).toEqual(['agent', 'plugin', 'global'])
    await stop()
  })
})

describe('hooks — onError (agent scope)', () => {
  test('recover resolves the run with a replacement output and still runs afterRun', async () => {
    let afterRunOutput: unknown
    const { bread, stop } = await makeBread({
      agents: {
        a: defineTestAgent({
          config: {
            output: { format: 'json' },
            outputSchema: z.object({ ok: z.boolean() }),
            hooks: {
              onError: () => ({ action: 'recover', output: { ok: false, recovered: true } }),
              afterRun: (ctx) => {
                afterRunOutput = ctx.output
              },
            },
          },
        }),
      },
      model: mockFlakyObjectModel(999, { ok: true }), // always fails
    })
    const crumbs = await runCollect(bread, 'a', 'go')
    const end = crumbs.find((c) => c.type === 'agent:run:end') as AgentRunEndCrumb
    expect(end.output).toEqual({ ok: false, recovered: true })
    expect(crumbs.map((c) => c.type)).not.toContain('agent:error')
    expect(afterRunOutput).toEqual({ ok: false, recovered: true })
    await stop()
  })

  test('a hook returning retry, backed by errorHandling.retry, re-invokes until it succeeds', async () => {
    const { bread, stop } = await makeBread({
      agents: {
        a: defineTestAgent({
          config: {
            output: { format: 'json' },
            outputSchema: z.object({ ok: z.boolean() }),
            errorHandling: { retry: { attempts: 5, backoffMs: 1 } },
          },
        }),
      },
      // Fails twice, succeeds on the 3rd attempt — the default retry policy
      // (every hook void, errorHandling.retry configured) should reach it.
      model: mockFlakyObjectModel(2, { ok: true }),
    })
    const crumbs = await runCollect(bread, 'a', 'go')
    const end = crumbs.find((c) => c.type === 'agent:run:end') as AgentRunEndCrumb
    expect(end.output).toEqual({ ok: true })
    expect(crumbs.map((c) => c.type)).not.toContain('agent:error')
    await stop()
  })

  test('retry exhausts errorHandling.retry.attempts and the original error propagates', async () => {
    const { bread, stop } = await makeBread({
      agents: {
        a: defineTestAgent({
          config: {
            output: { format: 'json' },
            outputSchema: z.object({ ok: z.boolean() }),
            errorHandling: { retry: { attempts: 2, backoffMs: 1 } },
          },
        }),
      },
      model: mockFlakyObjectModel(999, { ok: true }), // never recovers within 2 attempts
    })
    await expect(runCollect(bread, 'a', 'go')).rejects.toThrow()
    await stop()
  })

  test('fail replaces the propagated error', async () => {
    const { bread, stop } = await makeBread({
      agents: {
        a: defineTestAgent({
          config: {
            output: { format: 'json' },
            outputSchema: z.object({ ok: z.boolean() }),
            hooks: {
              onError: () => ({
                action: 'fail',
                error: new BreadError('replacement message', 'REPLACED'),
              }),
            },
          },
        }),
      },
      model: mockErrorModel('original failure'),
    })
    await expect(runCollect(bread, 'a', 'go')).rejects.toThrow(/replacement message/)
    await stop()
  })

  test('fires on a resolveModel failure too, agent hook then global hook, in order', async () => {
    const order: string[] = []
    const { bread, stop } = await makeBread({
      agents: {
        broken: defineTestAgent({
          config: {
            model: { provider: 'ghost', model: 'x' },
            hooks: { onError: () => void order.push('agent') },
          },
        }),
      },
      model: mockTextModel('unused'),
      config: { hooks: { onError: () => void order.push('global') } },
    })
    await expect(runCollect(bread, 'broken', 'go')).rejects.toThrow(/Unknown model provider/)
    expect(order).toEqual(['agent', 'global'])
    await stop()
  })

  test('the first hook to resolve stops the chain — a recovering agent hook skips the global hook', async () => {
    let globalCalled = false
    const { bread, stop } = await makeBread({
      agents: {
        a: defineTestAgent({
          config: {
            output: { format: 'json' },
            outputSchema: z.object({ ok: z.boolean() }),
            hooks: { onError: () => ({ action: 'recover', output: { ok: false } }) },
          },
        }),
      },
      model: mockFlakyObjectModel(999, { ok: true }),
      config: { hooks: { onError: () => void (globalCalled = true) } },
    })
    await runCollect(bread, 'a', 'go')
    expect(globalCalled).toBe(false)
    await stop()
  })

  test('a hook throwing propagates immediately and the global hook never runs', async () => {
    let globalCalled = false
    const { bread, stop } = await makeBread({
      agents: {
        a: defineTestAgent({
          config: {
            output: { format: 'json' },
            outputSchema: z.object({ ok: z.boolean() }),
            hooks: {
              onError: () => {
                throw new Error('hook bug')
              },
            },
          },
        }),
      },
      model: mockFlakyObjectModel(999, { ok: true }),
      config: { hooks: { onError: () => void (globalCalled = true) } },
    })
    await expect(runCollect(bread, 'a', 'go')).rejects.toThrow(/hook bug/)
    expect(globalCalled).toBe(false)
    await stop()
  })
})

describe('hooks — onSuspend', () => {
  test('fires (agent then global) alongside the existing onHumanRequired callback', async () => {
    const order: string[] = []
    const { bread, stop } = await makeBread({
      agents: {
        a: defineTestAgent({
          humanTools: [{ name: 'ask_human', schema: z.object({ q: z.string() }), _human: true }],
          config: {
            hooks: {
              onSuspend: (ctx) => {
                expect(ctx.toolName).toBe('human_ask_human')
                order.push('agent')
              },
            },
          },
        }),
      },
      model: mockScript([{ tool: 'human_ask_human', args: { q: 'ok?' } }, { text: 'thanks' }]),
      config: { hooks: { onSuspend: () => void order.push('global') } },
    })
    let onHumanRequiredCalled = false
    const crumbs = await runCollect(bread, 'a', 'go', {
      onHumanRequired: () => {
        onHumanRequiredCalled = true
      },
    })
    expect(crumbs.map((c) => c.type)).toContain('human:required')
    expect(order).toEqual(['agent', 'global'])
    expect(onHumanRequiredCalled).toBe(true)
    await stop()
  })
})

describe('hooks — global-only (no agent-level hooks)', () => {
  test('BreadConfig.hooks alone still fires', async () => {
    let called = false
    const { bread, stop } = await makeBread({
      agents: { a: defineTestAgent() },
      model: mockTextModel('done'),
      config: { hooks: { afterRun: () => void (called = true) } },
    })
    await runCollect(bread, 'a', 'go')
    expect(called).toBe(true)
    await stop()
  })
})
