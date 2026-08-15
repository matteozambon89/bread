import { describe, expect, test } from 'bun:test'
import { defineEval, runEvals } from '@bread/core'
import { MockLanguageModelV3 } from 'ai/test'

// llmJudge drives `generateText` (non-streaming, `doGenerate`) — unlike the
// streaming `mockTextModel`/`mockToolCallModel` helpers, which only implement
// `doStream`.
function mockJudgeModel(verdict: 'PASS' | 'FAIL'): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: {
      content: [{ type: 'text', text: verdict }],
      finishReason: { unified: 'stop', raw: undefined },
      usage: {
        inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 0, text: 0, reasoning: 0 },
      },
      warnings: [],
    },
  })
}

describe('runEvals', () => {
  test('passes a case only when every scorer passes', async () => {
    const def = defineEval({
      agentId: 'a',
      cases: [
        {
          name: 'greeting',
          input: 'hi',
          scorers: [
            { type: 'contains', expected: 'hello' },
            { type: 'regex', pattern: '^hello' },
          ],
        },
      ],
    })
    const result = await runEvals(def, async () => 'hello world')
    expect(result.passed).toBe(1)
    expect(result.failed).toBe(0)
    expect(result.results[0]!.score).toBe(1)
  })

  test('fails a case when a scorer does not match', async () => {
    const def = defineEval({
      agentId: 'a',
      cases: [{ name: 'exact', input: 'x', scorers: [{ type: 'exact', expected: 'yes' }] }],
    })
    const result = await runEvals(def, async () => 'no')
    expect(result.passed).toBe(0)
    expect(result.results[0]!.passed).toBe(false)
  })

  test('records an error case when the run function throws', async () => {
    const def = defineEval({
      agentId: 'a',
      cases: [{ name: 'boom', input: 'x', scorers: [{ type: 'exact', expected: 'x' }] }],
    })
    const result = await runEvals(def, async () => {
      throw new Error('run failed')
    })
    expect(result.failed).toBe(1)
    expect(result.results[0]!.details).toContain('run failed')
  })

  test('supports a custom scorer function', async () => {
    const def = defineEval({
      agentId: 'a',
      cases: [
        {
          name: 'custom',
          input: 'x',
          scorers: [{ type: 'custom', fn: (out) => out === 42 }],
        },
      ],
    })
    const result = await runEvals(def, async () => 42)
    expect(result.passed).toBe(1)
  })

  test('llmJudge scorer passes when the judge model responds PASS', async () => {
    const def = defineEval({
      agentId: 'a',
      cases: [
        {
          name: 'judged',
          input: 'x',
          scorers: [{ type: 'llmJudge', prompt: 'Is this a friendly greeting?', model: 'mock/judge' }],
        },
      ],
    })
    const providers = { mock: () => mockJudgeModel('PASS') }
    const result = await runEvals(def, async () => 'hello!', providers)
    expect(result.passed).toBe(1)
    expect(result.results[0]!.details).toContain('llmJudge: PASS')
  })

  test('llmJudge scorer fails when the judge model responds FAIL', async () => {
    const def = defineEval({
      agentId: 'a',
      cases: [
        {
          name: 'judged',
          input: 'x',
          scorers: [{ type: 'llmJudge', prompt: 'Is this a friendly greeting?', model: 'mock/judge' }],
        },
      ],
    })
    const providers = { mock: () => mockJudgeModel('FAIL') }
    const result = await runEvals(def, async () => 'get lost', providers)
    expect(result.passed).toBe(0)
    expect(result.results[0]!.details).toContain('llmJudge: FAIL')
  })
})
