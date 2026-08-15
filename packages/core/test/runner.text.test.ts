import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { BreadInstance } from '@breadai/core'
import {
  defineTestAgent,
  makeBread,
  MOCK_PROVIDER,
  mockReasoningTextModel,
  mockRecordingTextModel,
  mockTextModel,
  runCollect,
} from '@breadai/test-utils'
import { z } from 'zod'

describe('runner — text streaming', () => {
  let bread: BreadInstance
  let stop: () => Promise<void>

  beforeEach(async () => {
    ;({ bread, stop } = await makeBread({
      agents: { writer: defineTestAgent() },
      model: mockTextModel('Hello world'),
    }))
  })

  afterEach(() => stop())

  test('emits run:start, then text deltas, then run:end in order', async () => {
    const crumbs = await runCollect(bread, 'writer', 'hi')
    const types = crumbs.map((c) => c.type)
    expect(types[0]).toBe('agent:run:start')
    expect(types.at(-1)).toBe('agent:run:end')
    expect(types).toContain('text:delta')
  })

  test('streams the model text through text:delta crumbs', async () => {
    const crumbs = await runCollect(bread, 'writer', 'hi')
    const text = crumbs
      .filter((c) => c.type === 'text:delta')
      .map((c) => (c as { delta: string }).delta)
      .join('')
    expect(text).toBe('Hello world')
  })

  test('persists the user message and assistant reply to the store', async () => {
    const crumbs = await runCollect(bread, 'writer', 'hi')
    const sessionId = crumbs[0]!.sessionId
    const messages = await bread.store.getMessages(sessionId)
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(messages[0]!.content).toBe('hi')
  })
})

describe('runner — reasoning streaming', () => {
  let bread: BreadInstance
  let stop: () => Promise<void>

  beforeEach(async () => {
    ;({ bread, stop } = await makeBread({
      agents: { writer: defineTestAgent() },
      model: mockReasoningTextModel('let me think...', 'Hello world'),
    }))
  })

  afterEach(() => stop())

  test('emits reasoning:delta before text:delta, and the answer excludes reasoning', async () => {
    const crumbs = await runCollect(bread, 'writer', 'hi')
    const types = crumbs.map((c) => c.type)
    expect(types.indexOf('reasoning:delta')).toBeGreaterThanOrEqual(0)
    expect(types.indexOf('reasoning:delta')).toBeLessThan(types.indexOf('text:delta'))

    const reasoning = crumbs
      .filter((c) => c.type === 'reasoning:delta')
      .map((c) => (c as { delta: string }).delta)
      .join('')
    expect(reasoning).toBe('let me think...')

    const end = crumbs.find((c) => c.type === 'agent:run:end') as { output: unknown }
    expect(end.output).toBe('Hello world')
  })
})

describe('runner — CustomFormat output', () => {
  test('streams text like the plain text format, then parses it into a non-string output', async () => {
    const { bread, stop } = await makeBread({
      agents: {
        writer: defineTestAgent({
          config: {
            outputSchema: z.array(z.string()),
            output: {
              format: {
                name: 'lines',
                parse: (raw) => raw.split('\n').map((s) => s.trim()).filter(Boolean),
              },
            },
          },
        }),
      },
      model: mockTextModel('a\nb\nc'),
    })
    try {
      const crumbs = await runCollect(bread, 'writer', 'hi')
      const text = crumbs
        .filter((c) => c.type === 'text:delta')
        .map((c) => (c as { delta: string }).delta)
        .join('')
      expect(text).toBe('a\nb\nc')
      const end = crumbs.find((c) => c.type === 'agent:run:end') as { output: unknown }
      expect(end.output).toEqual(['a', 'b', 'c'])
    } finally {
      await stop()
    }
  })
})

describe('runner — model settings and providerOptions passthrough', () => {
  test('forwards ModelRef.settings and namespaces providerOptions under the provider', async () => {
    const { model, calls } = mockRecordingTextModel('hi')
    const { bread, stop } = await makeBread({
      agents: {
        writer: defineTestAgent({
          config: {
            model: {
              provider: MOCK_PROVIDER,
              model: 'default',
              settings: { temperature: 0.2, maxOutputTokens: 123 },
              providerOptions: { think: true },
            },
          },
        }),
      },
      model,
    })
    try {
      await runCollect(bread, 'writer', 'hi')
      expect(calls).toHaveLength(1)
      expect(calls[0]!.temperature).toBe(0.2)
      expect(calls[0]!.maxOutputTokens).toBe(123)
      expect(calls[0]!.providerOptions).toEqual({ [MOCK_PROVIDER]: { think: true } })
    } finally {
      await stop()
    }
  })
})
