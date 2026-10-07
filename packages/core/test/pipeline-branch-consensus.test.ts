import { describe, expect, test } from 'bun:test'
import { BreadError, defineHumanTool } from '@breadai/core'
import type {
  BreadCrumb,
  DecisionClient,
  DecisionHostAnswer,
  DecisionHostQuestion,
  DecisionQuestion,
  HumanRequiredCrumb,
  PipelineBranchTakenCrumb,
  PipelineStep,
} from '@breadai/core'
import {
  collect,
  defineTestAgent,
  makeBread,
  mockTextModel,
  mockToolCallModel,
} from '@breadai/test-utils'
import type { MockLanguageModelV4 } from 'ai/test'
import { z } from 'zod'

const TICKET = 'TICKET-8841 refund the duplicate charge'

function choiceQuestion(minConfidence?: number): DecisionQuestion {
  return {
    type: 'choice',
    text: 'Which desk owns this ticket?',
    options: ['billing', 'shipping'],
    otherwise: 'needs_review',
    ...(minConfidence !== undefined ? { minConfidence } : {}),
  }
}

function fakeClient(
  answer: DecisionHostAnswer | undefined,
  seen: { state?: unknown; questions?: DecisionHostQuestion[]; model?: string },
): (modelId: string) => DecisionClient {
  return (modelId) => {
    seen.model = modelId
    return {
      async systemOne(request) {
        seen.state = request.state
        seen.questions = request.questions
        return { answers: answer ? [answer] : [] }
      },
    }
  }
}

function scriptedChoices(choices: string[]): (modelId: string) => DecisionClient {
  let cursor = 0
  return () => ({
    async systemOne() {
      const choice = choices[cursor] ?? choices[choices.length - 1] ?? 'billing'
      cursor += 1
      return { answers: [{ type: 'choice', choice, confidence: 0.95 }] }
    },
  })
}

function routeBranch(): PipelineStep {
  return {
    type: 'branch',
    cases: [
      { eq: 'billing', steps: [{ type: 'agent', agentId: 'bill' }] },
      { eq: 'shipping', steps: [{ type: 'agent', agentId: 'ship' }] },
      { eq: 'refund', steps: [{ type: 'agent', agentId: 'other' }] },
    ],
    default: [{ type: 'agent', agentId: 'fallback' }],
  }
}

async function drain(gen: AsyncIterable<BreadCrumb>): Promise<{ crumbs: BreadCrumb[]; error?: unknown }> {
  const crumbs: BreadCrumb[] = []
  try {
    for await (const crumb of gen) crumbs.push(crumb)
    return { crumbs }
  } catch (error) {
    return { crumbs, error }
  }
}

describe('bread.runPipeline — parallel decision consensus', () => {
  test('a decision inside a parallel slot feeds a following branch with no on', async () => {
    const writer = mockTextModel('WROTE') as MockLanguageModelV4
    const fallback = mockTextModel('FALLBACK') as MockLanguageModelV4
    const ok = mockTextModel('OK') as MockLanguageModelV4
    const { bread, stop } = await makeBread({
      agents: {
        writer: defineTestAgent({ model: 'writer' }),
        fallback: defineTestAgent({ model: 'fallback' }),
        ok: defineTestAgent({ model: 'ok' }),
      },
      models: { writer, fallback, ok },
      config: {
        decisions: { typesafe: fakeClient({ type: 'choice', choice: 'billing', confidence: 0.95 }, {}) },
        pipelines: {
          route: [
            {
              type: 'parallel',
              steps: [
                { type: 'decision', provider: 'typesafe', model: 'jev-latest', question: choiceQuestion() },
                { type: 'agent', agentId: 'ok' },
              ],
            },
            {
              type: 'branch',
              cases: [
                { eq: 'billing', steps: [{ type: 'agent', agentId: 'writer' }] },
                { eq: 'shipping', steps: [{ type: 'agent', agentId: 'fallback' }] },
              ],
              default: [{ type: 'agent', agentId: 'fallback' }],
            },
          ],
        },
      },
    })
    try {
      const crumbs = await collect(bread.runPipeline('route', TICKET))
      const taken = crumbs.find((c) => c.type === 'pipeline:branch:taken') as PipelineBranchTakenCrumb
      expect(taken).toMatchObject({ eq: 'billing', caseIndex: 0 })
      expect(writer.doStreamCalls).toHaveLength(1)
      expect(ok.doStreamCalls).toHaveLength(1)
      expect(fallback.doStreamCalls).toHaveLength(0)
    } finally {
      await stop()
    }
  })

  test('resume after a decision inside a parallel slot feeds a following branch with no on', async () => {
    const approve = defineHumanTool('approve', z.object({ question: z.string() }))
    const writer = mockTextModel('WROTE') as MockLanguageModelV4
    const fallback = mockTextModel('FALLBACK') as MockLanguageModelV4
    let decisions = 0
    const { bread, stop } = await makeBread({
      agents: {
        gate: defineTestAgent({ model: 'gate', humanTools: [approve] }),
        writer: defineTestAgent({ model: 'writer' }),
        fallback: defineTestAgent({ model: 'fallback' }),
      },
      models: {
        gate: mockToolCallModel({ toolName: 'human_approve', args: { question: 'ok?' }, then: 'approved!' }),
        writer,
        fallback,
      },
      config: {
        decisions: {
          typesafe: () => ({
            async systemOne() {
              decisions += 1
              return { answers: [{ type: 'choice' as const, choice: 'billing', confidence: 0.95 }] }
            },
          }),
        },
        pipelines: {
          route: [
            {
              type: 'parallel',
              steps: [
                { type: 'decision', provider: 'typesafe', model: 'jev-latest', question: choiceQuestion() },
                { type: 'agent', agentId: 'gate' },
              ],
            },
            {
              type: 'branch',
              cases: [
                { eq: 'billing', steps: [{ type: 'agent', agentId: 'writer' }] },
                { eq: 'shipping', steps: [{ type: 'agent', agentId: 'fallback' }] },
              ],
              default: [{ type: 'agent', agentId: 'fallback' }],
            },
          ],
        },
      },
    })
    try {
      const first = await collect(bread.runPipeline('route', TICKET))
      const cp = first.find((c) => c.type === 'human:required') as HumanRequiredCrumb
      expect(cp).toBeDefined()
      expect(decisions).toBe(1)
      const record = await bread.store.getCheckpoint(cp.checkpointId)
      expect(record?.parent?.kind).toBe('pipeline')
      if (record?.parent?.kind !== 'pipeline') throw new Error('expected a pipeline parent')
      expect(record.parent.outer?.decisionLabel).toBe('billing')
      expect(record.parent.outer?.parallel).not.toHaveProperty('slotDecisionLabels')
      expect(writer.doStreamCalls).toHaveLength(0)
      expect(fallback.doStreamCalls).toHaveLength(0)

      const cont = await collect(bread.resume(cp.checkpointId, { approved: true }))
      const taken = cont.find((c) => c.type === 'pipeline:branch:taken') as PipelineBranchTakenCrumb
      expect(taken).toMatchObject({ eq: 'billing', caseIndex: 0 })
      expect(decisions).toBe(1)
      expect(writer.doStreamCalls).toHaveLength(1)
      expect(JSON.stringify(writer.doStreamCalls[0]!.prompt)).toContain('approved!')
      expect(fallback.doStreamCalls).toHaveLength(0)
    } finally {
      await stop()
    }
  })

  test('two parallel slots that decide different labels throw before the next step', async () => {
    const bill = mockTextModel('BILL') as MockLanguageModelV4
    const ship = mockTextModel('SHIP') as MockLanguageModelV4
    const other = mockTextModel('OTHER') as MockLanguageModelV4
    const fallback = mockTextModel('FALLBACK') as MockLanguageModelV4
    const { bread, stop } = await makeBread({
      agents: {
        bill: defineTestAgent({ model: 'bill' }),
        ship: defineTestAgent({ model: 'ship' }),
        other: defineTestAgent({ model: 'other' }),
        fallback: defineTestAgent({ model: 'fallback' }),
      },
      models: { bill, ship, other, fallback },
      config: {
        decisions: { typesafe: scriptedChoices(['billing', 'shipping']) },
        pipelines: {
          route: [
            {
              type: 'parallel',
              steps: [
                { type: 'decision', provider: 'typesafe', model: 'jev-latest', question: choiceQuestion() },
                { type: 'decision', provider: 'typesafe', model: 'jev-latest', question: choiceQuestion() },
              ],
            },
            routeBranch(),
          ],
        },
      },
    })
    try {
      const { crumbs, error } = await drain(bread.runPipeline('route', TICKET))
      expect(error).toBeInstanceOf(BreadError)
      expect((error as BreadError).code).toBe('PIPELINE_DECISION_CONFLICT')
      expect(crumbs.some((c) => c.type === 'pipeline:branch:taken')).toBe(false)
      expect(bill.doStreamCalls).toHaveLength(0)
      expect(ship.doStreamCalls).toHaveLength(0)
      expect(other.doStreamCalls).toHaveLength(0)
      expect(fallback.doStreamCalls).toHaveLength(0)
    } finally {
      await stop()
    }
  })

  test('two different new labels do not keep the incoming label for a following branch', async () => {
    const bill = mockTextModel('BILL') as MockLanguageModelV4
    const ship = mockTextModel('SHIP') as MockLanguageModelV4
    const other = mockTextModel('OTHER') as MockLanguageModelV4
    const fallback = mockTextModel('FALLBACK') as MockLanguageModelV4
    const { bread, stop } = await makeBread({
      agents: {
        bill: defineTestAgent({ model: 'bill' }),
        ship: defineTestAgent({ model: 'ship' }),
        other: defineTestAgent({ model: 'other' }),
        fallback: defineTestAgent({ model: 'fallback' }),
      },
      models: { bill, ship, other, fallback },
      config: {
        decisions: { typesafe: scriptedChoices(['billing', 'shipping', 'refund']) },
        pipelines: {
          route: [
            { type: 'decision', provider: 'typesafe', model: 'jev-latest', question: choiceQuestion() },
            {
              type: 'parallel',
              steps: [
                { type: 'decision', provider: 'typesafe', model: 'jev-latest', question: choiceQuestion() },
                { type: 'decision', provider: 'typesafe', model: 'jev-latest', question: choiceQuestion() },
              ],
            },
            routeBranch(),
          ],
        },
      },
    })
    try {
      const { crumbs, error } = await drain(bread.runPipeline('route', TICKET))
      expect(error).toBeInstanceOf(BreadError)
      expect((error as BreadError).code).toBe('PIPELINE_DECISION_CONFLICT')
      expect(crumbs.some((c) => c.type === 'pipeline:branch:taken')).toBe(false)
      expect(bill.doStreamCalls).toHaveLength(0)
      expect(ship.doStreamCalls).toHaveLength(0)
      expect(other.doStreamCalls).toHaveLength(0)
      expect(fallback.doStreamCalls).toHaveLength(0)
    } finally {
      await stop()
    }
  })

  test('one new parallel label replaces the incoming label across a sibling pause', async () => {
    const approve = defineHumanTool('approve', z.object({ question: z.string() }))
    const bill = mockTextModel('BILL') as MockLanguageModelV4
    const ship = mockTextModel('SHIP') as MockLanguageModelV4
    const fallback = mockTextModel('FALLBACK') as MockLanguageModelV4
    const { bread, stop } = await makeBread({
      agents: {
        gate: defineTestAgent({ model: 'gate', humanTools: [approve] }),
        bill: defineTestAgent({ model: 'bill' }),
        ship: defineTestAgent({ model: 'ship' }),
        fallback: defineTestAgent({ model: 'fallback' }),
      },
      models: {
        gate: mockToolCallModel({ toolName: 'human_approve', args: { question: 'ok?' }, then: 'approved!' }),
        bill,
        ship,
        fallback,
      },
      config: {
        decisions: { typesafe: scriptedChoices(['billing', 'shipping']) },
        pipelines: {
          route: [
            { type: 'decision', provider: 'typesafe', model: 'jev-latest', question: choiceQuestion() },
            {
              type: 'parallel',
              steps: [
                { type: 'decision', provider: 'typesafe', model: 'jev-latest', question: choiceQuestion() },
                { type: 'agent', agentId: 'gate' },
              ],
            },
            routeBranch(),
          ],
        },
      },
    })
    try {
      const first = await collect(bread.runPipeline('route', TICKET))
      const cp = first.find((c) => c.type === 'human:required') as HumanRequiredCrumb
      const record = await bread.store.getCheckpoint(cp.checkpointId)
      expect(record?.parent?.kind).toBe('pipeline')
      if (record?.parent?.kind !== 'pipeline') throw new Error('expected a pipeline parent')
      expect(record.parent.decisionLabel).toBe('billing')
      expect(record.parent.outer?.decisionLabel).toBe('shipping')
      expect(record.parent.outer?.parallel?.incomingLabel).toBe('billing')
      expect(record.parent.outer?.parallel).not.toHaveProperty('slotDecisionLabels')
      expect(ship.doStreamCalls).toHaveLength(0)
      expect(bill.doStreamCalls).toHaveLength(0)

      const cont = await collect(bread.resume(cp.checkpointId, { approved: true }))
      const taken = cont.find((c) => c.type === 'pipeline:branch:taken') as PipelineBranchTakenCrumb
      expect(taken).toMatchObject({ eq: 'shipping', caseIndex: 1 })
      expect(ship.doStreamCalls).toHaveLength(1)
      expect(bill.doStreamCalls).toHaveLength(0)
      expect(fallback.doStreamCalls).toHaveLength(0)
    } finally {
      await stop()
    }
  })

  test('resume of a second parallel label throws instead of taking a stale arm', async () => {
    const approve = defineHumanTool('approve', z.object({ question: z.string() }))
    const bill = mockTextModel('BILL') as MockLanguageModelV4
    const ship = mockTextModel('SHIP') as MockLanguageModelV4
    const other = mockTextModel('OTHER') as MockLanguageModelV4
    const fallback = mockTextModel('FALLBACK') as MockLanguageModelV4
    const pauseAfterDecision = (agentId: string): PipelineStep => ({
      type: 'branch',
      on: 'absent',
      cases: [],
      default: [
        { type: 'decision', provider: 'typesafe', model: 'jev-latest', question: choiceQuestion() },
        { type: 'agent', agentId },
      ],
    })
    const { bread, stop } = await makeBread({
      agents: {
        gate: defineTestAgent({ model: 'gate', humanTools: [approve] }),
        otherGate: defineTestAgent({ model: 'otherGate', humanTools: [approve] }),
        bill: defineTestAgent({ model: 'bill' }),
        ship: defineTestAgent({ model: 'ship' }),
        other: defineTestAgent({ model: 'other' }),
        fallback: defineTestAgent({ model: 'fallback' }),
      },
      models: {
        gate: mockToolCallModel({ toolName: 'human_approve', args: { question: 'ok?' }, then: 'approved!' }),
        otherGate: mockToolCallModel({ toolName: 'human_approve', args: { question: 'ok?' }, then: 'approved!' }),
        bill,
        ship,
        other,
        fallback,
      },
      config: {
        decisions: { typesafe: scriptedChoices(['billing', 'shipping']) },
        pipelines: {
          route: [
            {
              type: 'parallel',
              steps: [pauseAfterDecision('gate'), pauseAfterDecision('otherGate')],
            },
            routeBranch(),
          ],
        },
      },
    })
    try {
      const first = await collect(bread.runPipeline('route', TICKET))
      const paused = first.filter((c) => c.type === 'human:required') as HumanRequiredCrumb[]
      expect(paused).toHaveLength(2)
      expect(bill.doStreamCalls).toHaveLength(0)

      const firstResume = await drain(bread.resume(paused[0]!.checkpointId, { approved: true }))
      expect(firstResume.error).toBeUndefined()
      expect(firstResume.crumbs.some((c) => c.type === 'pipeline:branch:taken')).toBe(false)

      const secondResume = await drain(bread.resume(paused[1]!.checkpointId, { approved: true }))
      expect(secondResume.error).toBeInstanceOf(BreadError)
      expect((secondResume.error as BreadError).code).toBe('PIPELINE_DECISION_CONFLICT')
      expect(secondResume.crumbs.some((c) => c.type === 'pipeline:branch:taken')).toBe(false)
      expect(bill.doStreamCalls).toHaveLength(0)
      expect(ship.doStreamCalls).toHaveLength(0)
      expect(other.doStreamCalls).toHaveLength(0)
      expect(fallback.doStreamCalls).toHaveLength(0)
    } finally {
      await stop()
    }
  })

  test('parallel slots that decide the same label agree', async () => {
    const bill = mockTextModel('BILL') as MockLanguageModelV4
    const ship = mockTextModel('SHIP') as MockLanguageModelV4
    const fallback = mockTextModel('FALLBACK') as MockLanguageModelV4
    const { bread, stop } = await makeBread({
      agents: {
        bill: defineTestAgent({ model: 'bill' }),
        ship: defineTestAgent({ model: 'ship' }),
        fallback: defineTestAgent({ model: 'fallback' }),
      },
      models: { bill, ship, fallback },
      config: {
        decisions: { typesafe: scriptedChoices(['billing', 'billing']) },
        pipelines: {
          route: [
            {
              type: 'parallel',
              steps: [
                { type: 'decision', provider: 'typesafe', model: 'jev-latest', question: choiceQuestion() },
                { type: 'decision', provider: 'typesafe', model: 'jev-latest', question: choiceQuestion() },
              ],
            },
            routeBranch(),
          ],
        },
      },
    })
    try {
      const crumbs = await collect(bread.runPipeline('route', TICKET))
      const taken = crumbs.find((c) => c.type === 'pipeline:branch:taken') as PipelineBranchTakenCrumb
      expect(taken).toMatchObject({ eq: 'billing', caseIndex: 0 })
      expect(bill.doStreamCalls).toHaveLength(1)
      expect(ship.doStreamCalls).toHaveLength(0)
      expect(fallback.doStreamCalls).toHaveLength(0)
    } finally {
      await stop()
    }
  })
})
