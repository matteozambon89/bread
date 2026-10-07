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
  PipelineCheckpointParent,
  PipelineStep,
  PipelineStepEndCrumb,
  PipelineStepStartCrumb,
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

async function drain(gen: AsyncIterable<BreadCrumb>): Promise<{ crumbs: BreadCrumb[]; error?: unknown }> {
  const crumbs: BreadCrumb[] = []
  try {
    for await (const crumb of gen) crumbs.push(crumb)
    return { crumbs }
  } catch (error) {
    return { crumbs, error }
  }
}

function branchOn(steps: PipelineStep): PipelineStep[] {
  return [
    {
      type: 'branch',
      on: 'label',
      cases: [
        { eq: 'allow', steps },
        { eq: 'allow', steps: [{ type: 'agent', agentId: 'other' }] },
      ],
      default: [{ type: 'agent', agentId: 'fallback' }],
    },
  ]
}

describe('bread.runPipeline — exclusive branch', () => {
  test('runs only the first matching arm and does not call the untaken arm', async () => {
    const allow = mockTextModel('ALLOW') as MockLanguageModelV4
    const other = mockTextModel('OTHER') as MockLanguageModelV4
    const fallback = mockTextModel('FALLBACK') as MockLanguageModelV4
    const { bread, stop } = await makeBread({
      agents: {
        allow: defineTestAgent({ model: 'allow' }),
        other: defineTestAgent({ model: 'other' }),
        fallback: defineTestAgent({ model: 'fallback' }),
      },
      models: { allow, other, fallback },
      config: { pipelines: { route: branchOn([{ type: 'agent', agentId: 'allow' }]) } },
    })
    try {
      const crumbs = await collect(bread.runPipeline('route', { label: 'allow' }))
      const starts = crumbs.filter((c) => c.type === 'pipeline:step:start') as PipelineStepStartCrumb[]
      expect(starts.map((c) => c.agentId)).toEqual(['branch', 'allow'])
      const ends = crumbs.filter((c) => c.type === 'pipeline:step:end') as PipelineStepEndCrumb[]
      expect(ends.map((c) => c.agentId)).toEqual(['allow', 'branch'])
      expect(ends.find((c) => c.agentId === 'branch')?.output).toBe('ALLOW')
      expect(allow.doStreamCalls).toHaveLength(1)
      expect(JSON.stringify(allow.doStreamCalls[0]!.prompt)).toContain('allow')
      expect(other.doStreamCalls).toHaveLength(0)
      expect(fallback.doStreamCalls).toHaveLength(0)
      expect(crumbs.some((c) => 'agentId' in c && c.agentId === 'other')).toBe(false)
      expect(crumbs.some((c) => 'agentId' in c && c.agentId === 'fallback')).toBe(false)
    } finally {
      await stop()
    }
  })

  test('yields pipeline:branch:taken once and does not write it to the crumb log', async () => {
    const allow = mockTextModel('ALLOW') as MockLanguageModelV4
    const { bread, stop } = await makeBread({
      agents: { allow: defineTestAgent({ model: 'allow' }) },
      models: { allow },
      config: {
        decisions: { typesafe: fakeClient({ type: 'choice', choice: 'billing', confidence: 0.9 }, {}) },
        pipelines: {
          route: [
            { type: 'decision', provider: 'typesafe', model: 'jev-latest', question: choiceQuestion() },
            {
              type: 'branch',
              cases: [
                { eq: 'billing', steps: [{ type: 'agent', agentId: 'allow' }] },
                { eq: 'shipping', steps: [{ type: 'agent', agentId: 'allow' }] },
              ],
              default: [{ type: 'agent', agentId: 'allow' }],
            },
          ],
        },
      },
    })
    try {
      const crumbs = await collect(bread.runPipeline('route', TICKET))
      const taken = crumbs.filter((c) => c.type === 'pipeline:branch:taken') as PipelineBranchTakenCrumb[]
      expect(taken).toHaveLength(1)
      expect(taken[0]).toMatchObject({ eq: 'billing', caseIndex: 0 })
      expect(typeof taken[0]!.seq).toBe('number')
      const branchStart = crumbs.findIndex(
        (c) => c.type === 'pipeline:step:start' && (c as PipelineStepStartCrumb).agentId === 'branch',
      )
      const armStart = crumbs.findIndex(
        (c) => c.type === 'pipeline:step:start' && (c as PipelineStepStartCrumb).agentId === 'allow',
      )
      const takenAt = crumbs.findIndex((c) => c.type === 'pipeline:branch:taken')
      expect(branchStart).toBeLessThan(takenAt)
      expect(takenAt).toBeLessThan(armStart)
      expect(JSON.stringify(allow.doStreamCalls[0]!.prompt)).toContain(TICKET)
      expect(JSON.stringify(allow.doStreamCalls[0]!.prompt)).not.toContain('billing')

      const runIds = [...new Set(crumbs.flatMap((c) => ('runId' in c && c.runId ? [c.runId] : [])))]
      for (const runId of runIds) {
        const logged = await bread.store.getCrumbs!(runId)
        expect(logged.some((entry) => entry.type === 'pipeline:branch:taken')).toBe(false)
      }
      expect(await bread.store.getCrumbs!(taken[0]!.runId)).toEqual([])
    } finally {
      await stop()
    }
  })

  test('runs the default arm when the path is missing, not a string, or no eq matches', async () => {
    const allow = mockTextModel('ALLOW') as MockLanguageModelV4
    const fallback = mockTextModel('FALLBACK') as MockLanguageModelV4
    const { bread, stop } = await makeBread({
      agents: {
        allow: defineTestAgent({ model: 'allow' }),
        fallback: defineTestAgent({ model: 'fallback' }),
      },
      models: { allow, fallback },
      config: {
        pipelines: {
          route: [
            {
              type: 'branch',
              on: 'route.label',
              cases: [{ eq: 'allow', steps: [{ type: 'agent', agentId: 'allow' }] }],
              default: [{ type: 'agent', agentId: 'fallback' }],
            },
          ],
        },
      },
    })
    try {
      for (const input of [{ route: { label: 'nope' } }, { route: { label: 2 } }, { other: true }, 'allow']) {
        allow.doStreamCalls.length = 0
        fallback.doStreamCalls.length = 0
        const crumbs = await collect(bread.runPipeline('route', input))
        const taken = crumbs.find((c) => c.type === 'pipeline:branch:taken') as PipelineBranchTakenCrumb
        expect(taken).toMatchObject({ eq: null, caseIndex: -1 })
        expect(allow.doStreamCalls).toHaveLength(0)
        expect(fallback.doStreamCalls).toHaveLength(1)
        expect(crumbs.some((c) => 'agentId' in c && c.agentId === 'allow')).toBe(false)
      }
    } finally {
      await stop()
    }
  })

  test('throws PIPELINE_BRANCH_DEFAULT before any arm when default is missing', async () => {
    const allow = mockTextModel('ALLOW') as MockLanguageModelV4
    const { bread, stop } = await makeBread({
      agents: { allow: defineTestAgent({ model: 'allow' }) },
      models: { allow },
      config: {
        pipelines: {
          route: [
            {
              type: 'branch',
              on: 'label',
              cases: [{ eq: 'allow', steps: [{ type: 'agent', agentId: 'allow' }] }],
            } as PipelineStep,
          ],
        },
      },
    })
    try {
      const { crumbs, error } = await drain(bread.runPipeline('route', { label: 'allow' }))
      expect(error).toBeInstanceOf(BreadError)
      expect((error as BreadError).code).toBe('PIPELINE_BRANCH_DEFAULT')
      expect(crumbs.some((c) => c.type === 'pipeline:branch:taken')).toBe(false)
      expect(crumbs.some((c) => c.type === 'pipeline:step:end')).toBe(false)
      expect(allow.doStreamCalls).toHaveLength(0)
    } finally {
      await stop()
    }
  })

  test('throws PIPELINE_BRANCH_DEFAULT before PIPELINE_BRANCH_NO_LABEL', async () => {
    const fallback = mockTextModel('FALLBACK') as MockLanguageModelV4
    const { bread, stop } = await makeBread({
      agents: { fallback: defineTestAgent({ model: 'fallback' }) },
      models: { fallback },
      config: {
        pipelines: {
          route: [
            {
              type: 'branch',
              cases: [{ eq: 'allow', steps: [{ type: 'agent', agentId: 'fallback' }] }],
            } as PipelineStep,
          ],
        },
      },
    })
    try {
      const { error } = await drain(bread.runPipeline('route', 'x'))
      expect((error as BreadError).code).toBe('PIPELINE_BRANCH_DEFAULT')
      expect(fallback.doStreamCalls).toHaveLength(0)
    } finally {
      await stop()
    }
  })

  test('throws PIPELINE_BRANCH_NO_LABEL when on and lastDecision are both absent', async () => {
    const fallback = mockTextModel('FALLBACK') as MockLanguageModelV4
    const { bread, stop } = await makeBread({
      agents: { fallback: defineTestAgent({ model: 'fallback' }) },
      models: { fallback },
      config: {
        pipelines: {
          route: [
            {
              type: 'branch',
              cases: [{ eq: 'allow', steps: [{ type: 'agent', agentId: 'fallback' }] }],
              default: [{ type: 'agent', agentId: 'fallback' }],
            },
          ],
        },
      },
    })
    try {
      const { crumbs, error } = await drain(bread.runPipeline('route', 'x'))
      expect((error as BreadError).code).toBe('PIPELINE_BRANCH_NO_LABEL')
      expect(crumbs.some((c) => c.type === 'pipeline:branch:taken')).toBe(false)
      expect(fallback.doStreamCalls).toHaveLength(0)
    } finally {
      await stop()
    }
  })

  test('an empty arm passes the current value through and calls no agent', async () => {
    const reply = mockTextModel('NOTED') as MockLanguageModelV4
    const seen: { state?: unknown } = {}
    const { bread, stop } = await makeBread({
      agents: { reply: defineTestAgent({ model: 'reply' }) },
      models: { reply },
      config: {
        decisions: { typesafe: fakeClient({ type: 'choice', choice: 'billing' }, seen) },
        pipelines: {
          route: [
            { type: 'decision', provider: 'typesafe', model: 'jev-latest', question: choiceQuestion() },
            {
              type: 'branch',
              cases: [{ eq: 'billing', steps: [] }],
              default: [{ type: 'agent', agentId: 'reply' }],
            },
            { type: 'agent', agentId: 'reply' },
          ],
        },
      },
    })
    try {
      const crumbs = await collect(bread.runPipeline('route', TICKET))
      const takenAt = crumbs.findIndex((c) => c.type === 'pipeline:branch:taken')
      const branchEnd = crumbs.findIndex(
        (c) => c.type === 'pipeline:step:end' && (c as PipelineStepEndCrumb).agentId === 'branch',
      )
      expect(crumbs.slice(takenAt + 1, branchEnd).some((c) => c.type === 'agent:run:start')).toBe(false)
      expect((crumbs[branchEnd] as PipelineStepEndCrumb).output).toBe(TICKET)
      expect(reply.doStreamCalls).toHaveLength(1)
      expect(JSON.stringify(reply.doStreamCalls[0]!.prompt)).toContain(TICKET)
      expect(seen.state).toBe(TICKET)
    } finally {
      await stop()
    }
  })

  test('resume continues the stored arm and does not re-evaluate the predicate', async () => {
    const approve = defineHumanTool('approve', z.object({ question: z.string() }))
    const writer = mockTextModel('WROTE') as MockLanguageModelV4
    const other = mockTextModel('OTHER') as MockLanguageModelV4
    const fallback = mockTextModel('FALLBACK') as MockLanguageModelV4
    const closer = mockTextModel('CLOSED') as MockLanguageModelV4
    let decisions = 0
    const { bread, stop } = await makeBread({
      agents: {
        gate: defineTestAgent({ model: 'gate', humanTools: [approve] }),
        writer: defineTestAgent({ model: 'writer' }),
        other: defineTestAgent({ model: 'other' }),
        fallback: defineTestAgent({ model: 'fallback' }),
        closer: defineTestAgent({ model: 'closer' }),
      },
      models: {
        gate: mockToolCallModel({ toolName: 'human_approve', args: { question: 'ok?' }, then: 'approved!' }),
        writer,
        other,
        fallback,
        closer,
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
            { type: 'decision', provider: 'typesafe', model: 'jev-latest', question: choiceQuestion() },
            {
              type: 'branch',
              cases: [
                {
                  eq: 'billing',
                  steps: [
                    { type: 'agent', agentId: 'gate' },
                    { type: 'agent', agentId: 'writer' },
                  ],
                },
                { eq: 'shipping', steps: [{ type: 'agent', agentId: 'other' }] },
              ],
              default: [{ type: 'agent', agentId: 'fallback' }],
            },
            { type: 'agent', agentId: 'closer' },
          ],
        },
      },
    })
    try {
      const first = await collect(bread.runPipeline('route', TICKET))
      expect(first.map((c) => c.type)).toContain('human:required')
      expect(first.filter((c) => c.type === 'pipeline:branch:taken')).toHaveLength(1)
      expect(writer.doStreamCalls).toHaveLength(0)
      expect(other.doStreamCalls).toHaveLength(0)
      expect(fallback.doStreamCalls).toHaveLength(0)
      expect(closer.doStreamCalls).toHaveLength(0)

      const cp = first.find((c) => c.type === 'human:required') as HumanRequiredCrumb
      const record = await bread.store.getCheckpoint(cp.checkpointId)
      expect(record?.parent?.kind).toBe('pipeline')
      if (record?.parent?.kind !== 'pipeline') throw new Error('expected a pipeline parent')
      expect(record.parent.remainingSteps).toEqual([{ type: 'agent', agentId: 'writer' }])
      expect(record.parent.outer).toMatchObject({
        stepAgentId: 'branch',
        remainingSteps: [{ type: 'agent', agentId: 'closer' }],
      })

      const cont = await collect(bread.resume(cp.checkpointId, { approved: true }))
      expect(cont.some((c) => c.type === 'pipeline:branch:taken')).toBe(false)
      expect(decisions).toBe(1)
      expect(other.doStreamCalls).toHaveLength(0)
      expect(fallback.doStreamCalls).toHaveLength(0)
      expect(writer.doStreamCalls).toHaveLength(1)
      expect(JSON.stringify(writer.doStreamCalls[0]!.prompt)).toContain('approved!')
      expect(closer.doStreamCalls).toHaveLength(1)
      expect(JSON.stringify(closer.doStreamCalls[0]!.prompt)).toContain('WROTE')
      const ends = cont.filter((c) => c.type === 'pipeline:step:end') as PipelineStepEndCrumb[]
      expect(ends.map((c) => c.agentId)).toEqual(['gate', 'writer', 'branch', 'closer'])
    } finally {
      await stop()
    }
  })

  test('resume after a decision and a human pause branches on the stored label', async () => {
    const approve = defineHumanTool('approve', z.object({ question: z.string() }))
    const writer = mockTextModel('WROTE') as MockLanguageModelV4
    const fallback = mockTextModel('FALLBACK') as MockLanguageModelV4
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
        decisions: { typesafe: fakeClient({ type: 'choice', choice: 'billing', confidence: 0.95 }, {}) },
        pipelines: {
          route: [
            { type: 'decision', provider: 'typesafe', model: 'jev-latest', question: choiceQuestion() },
            { type: 'agent', agentId: 'gate' },
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
      const record = await bread.store.getCheckpoint(cp.checkpointId)
      expect(record?.parent?.kind).toBe('pipeline')
      if (record?.parent?.kind !== 'pipeline') throw new Error('expected a pipeline parent')
      expect(record.parent.decisionLabel).toBe('billing')
      expect(writer.doStreamCalls).toHaveLength(0)

      const cont = await collect(bread.resume(cp.checkpointId, { approved: true }))
      expect(cont.some((c) => c.type === 'pipeline:branch:taken')).toBe(true)
      const taken = cont.find((c) => c.type === 'pipeline:branch:taken') as PipelineBranchTakenCrumb
      expect(taken).toMatchObject({ eq: 'billing', caseIndex: 0 })
      expect(writer.doStreamCalls).toHaveLength(1)
      expect(JSON.stringify(writer.doStreamCalls[0]!.prompt)).toContain('approved!')
      expect(fallback.doStreamCalls).toHaveLength(0)
    } finally {
      await stop()
    }
  })

  test('a second branch after a paused arm still reads the stored label', async () => {
    const approve = defineHumanTool('approve', z.object({ question: z.string() }))
    const writer = mockTextModel('WROTE') as MockLanguageModelV4
    const closer = mockTextModel('CLOSED') as MockLanguageModelV4
    const other = mockTextModel('OTHER') as MockLanguageModelV4
    let decisions = 0
    const { bread, stop } = await makeBread({
      agents: {
        gate: defineTestAgent({ model: 'gate', humanTools: [approve] }),
        writer: defineTestAgent({ model: 'writer' }),
        closer: defineTestAgent({ model: 'closer' }),
        other: defineTestAgent({ model: 'other' }),
      },
      models: {
        gate: mockToolCallModel({ toolName: 'human_approve', args: { question: 'ok?' }, then: 'approved!' }),
        writer,
        closer,
        other,
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
            { type: 'decision', provider: 'typesafe', model: 'jev-latest', question: choiceQuestion() },
            {
              type: 'branch',
              cases: [
                {
                  eq: 'billing',
                  steps: [
                    { type: 'agent', agentId: 'gate' },
                    { type: 'agent', agentId: 'writer' },
                  ],
                },
              ],
              default: [{ type: 'agent', agentId: 'other' }],
            },
            {
              type: 'branch',
              cases: [{ eq: 'billing', steps: [{ type: 'agent', agentId: 'closer' }] }],
              default: [{ type: 'agent', agentId: 'other' }],
            },
          ],
        },
      },
    })
    try {
      const first = await collect(bread.runPipeline('route', TICKET))
      expect(first.map((c) => c.type)).toContain('human:required')
      expect(closer.doStreamCalls).toHaveLength(0)

      const cp = first.find((c) => c.type === 'human:required') as HumanRequiredCrumb
      const cont = await collect(bread.resume(cp.checkpointId, { approved: true }))
      const taken = cont.filter((c) => c.type === 'pipeline:branch:taken') as PipelineBranchTakenCrumb[]
      expect(taken).toHaveLength(1)
      expect(taken[0]).toMatchObject({ eq: 'billing', caseIndex: 0 })
      expect(decisions).toBe(1)
      expect(writer.doStreamCalls).toHaveLength(1)
      expect(closer.doStreamCalls).toHaveLength(1)
      expect(JSON.stringify(closer.doStreamCalls[0]!.prompt)).toContain('WROTE')
      expect(other.doStreamCalls).toHaveLength(0)
    } finally {
      await stop()
    }
  })

  test('a decision inside the taken arm updates the label the next branch reads', async () => {
    const ship = mockTextModel('SHIP') as MockLanguageModelV4
    const bill = mockTextModel('BILL') as MockLanguageModelV4
    const fallback = mockTextModel('FALLBACK') as MockLanguageModelV4
    const answers = ['billing', 'shipping']
    let decisions = 0
    const { bread, stop } = await makeBread({
      agents: {
        ship: defineTestAgent({ model: 'ship' }),
        bill: defineTestAgent({ model: 'bill' }),
        fallback: defineTestAgent({ model: 'fallback' }),
      },
      models: { ship, bill, fallback },
      config: {
        decisions: {
          typesafe: () => ({
            async systemOne() {
              const choice = answers[decisions] ?? 'billing'
              decisions += 1
              return { answers: [{ type: 'choice' as const, choice, confidence: 0.95 }] }
            },
          }),
        },
        pipelines: {
          route: [
            { type: 'decision', provider: 'typesafe', model: 'jev-latest', question: choiceQuestion() },
            {
              type: 'branch',
              cases: [
                {
                  eq: 'billing',
                  steps: [{ type: 'decision', provider: 'typesafe', model: 'jev-latest', question: choiceQuestion() }],
                },
              ],
              default: [{ type: 'agent', agentId: 'fallback' }],
            },
            {
              type: 'branch',
              cases: [
                { eq: 'shipping', steps: [{ type: 'agent', agentId: 'ship' }] },
                { eq: 'billing', steps: [{ type: 'agent', agentId: 'bill' }] },
              ],
              default: [{ type: 'agent', agentId: 'fallback' }],
            },
          ],
        },
      },
    })
    try {
      const crumbs = await collect(bread.runPipeline('route', TICKET))
      const taken = crumbs.filter((c) => c.type === 'pipeline:branch:taken') as PipelineBranchTakenCrumb[]
      expect(taken.map((c) => c.eq)).toEqual(['billing', 'shipping'])
      expect(decisions).toBe(2)
      expect(ship.doStreamCalls).toHaveLength(1)
      expect(JSON.stringify(ship.doStreamCalls[0]!.prompt)).toContain(TICKET)
      expect(bill.doStreamCalls).toHaveLength(0)
      expect(fallback.doStreamCalls).toHaveLength(0)
    } finally {
      await stop()
    }
  })

  test('resume keeps the label a paused arm decided, not the label from before the arm', async () => {
    const approve = defineHumanTool('approve', z.object({ question: z.string() }))
    const ship = mockTextModel('SHIP') as MockLanguageModelV4
    const bill = mockTextModel('BILL') as MockLanguageModelV4
    const answers = ['billing', 'shipping']
    let decisions = 0
    const { bread, stop } = await makeBread({
      agents: {
        gate: defineTestAgent({ model: 'gate', humanTools: [approve] }),
        ship: defineTestAgent({ model: 'ship' }),
        bill: defineTestAgent({ model: 'bill' }),
      },
      models: {
        gate: mockToolCallModel({ toolName: 'human_approve', args: { question: 'ok?' }, then: 'approved!' }),
        ship,
        bill,
      },
      config: {
        decisions: {
          typesafe: () => ({
            async systemOne() {
              const choice = answers[decisions] ?? 'billing'
              decisions += 1
              return { answers: [{ type: 'choice' as const, choice, confidence: 0.95 }] }
            },
          }),
        },
        pipelines: {
          route: [
            { type: 'decision', provider: 'typesafe', model: 'jev-latest', question: choiceQuestion() },
            {
              type: 'branch',
              cases: [
                {
                  eq: 'billing',
                  steps: [
                    { type: 'decision', provider: 'typesafe', model: 'jev-latest', question: choiceQuestion() },
                    { type: 'agent', agentId: 'gate' },
                  ],
                },
              ],
              default: [],
            },
            {
              type: 'branch',
              cases: [
                { eq: 'shipping', steps: [{ type: 'agent', agentId: 'ship' }] },
                { eq: 'billing', steps: [{ type: 'agent', agentId: 'bill' }] },
              ],
              default: [],
            },
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
      expect(record.parent.decisionLabel).toBe('shipping')
      expect(decisions).toBe(2)

      const cont = await collect(bread.resume(cp.checkpointId, { approved: true }))
      const taken = cont.find((c) => c.type === 'pipeline:branch:taken') as PipelineBranchTakenCrumb
      expect(taken).toMatchObject({ eq: 'shipping', caseIndex: 0 })
      expect(ship.doStreamCalls).toHaveLength(1)
      expect(JSON.stringify(ship.doStreamCalls[0]!.prompt)).toContain('approved!')
      expect(bill.doStreamCalls).toHaveLength(0)
    } finally {
      await stop()
    }
  })

  test('HITL inside a branch used as a parallel step merges siblings and continues', async () => {
    const approve = defineHumanTool('approve', z.object({ question: z.string() }))
    const writer = mockTextModel('WROTE') as MockLanguageModelV4
    const ok = mockTextModel('OK') as MockLanguageModelV4
    const closer = mockTextModel('DONE') as MockLanguageModelV4
    const fallback = mockTextModel('FALLBACK') as MockLanguageModelV4
    const { bread, stop } = await makeBread({
      agents: {
        gate: defineTestAgent({ model: 'gate', humanTools: [approve] }),
        writer: defineTestAgent({ model: 'writer' }),
        ok: defineTestAgent({ model: 'ok' }),
        closer: defineTestAgent({ model: 'closer' }),
        fallback: defineTestAgent({ model: 'fallback' }),
      },
      models: {
        gate: mockToolCallModel({ toolName: 'human_approve', args: { question: 'ok?' }, then: 'approved!' }),
        writer,
        ok,
        closer,
        fallback,
      },
      config: {
        pipelines: {
          par: [
            {
              type: 'parallel',
              steps: [
                {
                  type: 'branch',
                  on: 'side',
                  cases: [
                    {
                      eq: 'left',
                      steps: [
                        { type: 'agent', agentId: 'gate' },
                        { type: 'agent', agentId: 'writer' },
                      ],
                    },
                  ],
                  default: [{ type: 'agent', agentId: 'fallback' }],
                },
                { type: 'agent', agentId: 'ok' },
              ],
            },
            { type: 'agent', agentId: 'closer' },
          ],
        },
      },
    })
    try {
      const first = await collect(bread.runPipeline('par', { side: 'left' }))
      expect(first.map((c) => c.type)).toContain('human:required')
      expect(writer.doStreamCalls).toHaveLength(0)
      expect(closer.doStreamCalls).toHaveLength(0)
      expect(fallback.doStreamCalls).toHaveLength(0)
      expect(ok.doStreamCalls).toHaveLength(1)

      const cp = first.find((c) => c.type === 'human:required') as HumanRequiredCrumb
      const record = await bread.store.getCheckpoint(cp.checkpointId)
      expect(record?.parent?.kind).toBe('pipeline')
      if (record?.parent?.kind !== 'pipeline') throw new Error('expected a pipeline parent')
      expect(record.parent.remainingSteps).toEqual([{ type: 'agent', agentId: 'writer' }])
      expect(record.parent.outer?.outer?.parallel).toMatchObject({
        branchIndex: 0,
        settledOutputs: [null, 'OK'],
      })
      expect(record.parent.outer?.outer?.parallel?.pendingCheckpointIds).toEqual([cp.checkpointId])

      const cont = await collect(bread.resume(cp.checkpointId, { approved: true }))
      expect(writer.doStreamCalls).toHaveLength(1)
      expect(JSON.stringify(writer.doStreamCalls[0]!.prompt)).toContain('approved!')
      expect(fallback.doStreamCalls).toHaveLength(0)
      const ends = cont.filter((c) => c.type === 'pipeline:step:end') as PipelineStepEndCrumb[]
      const merged = ends.find((c) => c.pipelineId === 'par' && c.agentId === 'parallel')
      expect(merged?.output).toEqual(['WROTE', 'OK'])
      expect(closer.doStreamCalls).toHaveLength(1)
      const prompt = JSON.stringify(closer.doStreamCalls[0]!.prompt)
      expect(prompt).toContain('WROTE')
      expect(prompt).toContain('OK')
    } finally {
      await stop()
    }
  })

  test('parallel → branch → parallel → branch patches every parallel slot', async () => {
    const approve = defineHumanTool('approve', z.object({ question: z.string() }))
    const writer = mockTextModel('WROTE') as MockLanguageModelV4
    const ok = mockTextModel('OK') as MockLanguageModelV4
    const sibling = mockTextModel('SIB') as MockLanguageModelV4
    const closer = mockTextModel('DONE') as MockLanguageModelV4
    const fallback = mockTextModel('FALLBACK') as MockLanguageModelV4
    const { bread, stop } = await makeBread({
      agents: {
        gate: defineTestAgent({ model: 'gate', humanTools: [approve] }),
        writer: defineTestAgent({ model: 'writer' }),
        ok: defineTestAgent({ model: 'ok' }),
        sibling: defineTestAgent({ model: 'sibling' }),
        closer: defineTestAgent({ model: 'closer' }),
        fallback: defineTestAgent({ model: 'fallback' }),
      },
      models: {
        gate: mockToolCallModel({ toolName: 'human_approve', args: { question: 'ok?' }, then: 'approved!' }),
        writer,
        ok,
        sibling,
        closer,
        fallback,
      },
      config: {
        pipelines: {
          par: [
            {
              type: 'parallel',
              steps: [
                {
                  type: 'branch',
                  on: 'outer',
                  cases: [
                    {
                      eq: 'go',
                      steps: [
                        {
                          type: 'parallel',
                          steps: [
                            {
                              type: 'branch',
                              on: 'inner',
                              cases: [
                                {
                                  eq: 'go',
                                  steps: [
                                    { type: 'agent', agentId: 'gate' },
                                    { type: 'agent', agentId: 'writer' },
                                  ],
                                },
                              ],
                              default: [{ type: 'agent', agentId: 'fallback' }],
                            },
                            { type: 'agent', agentId: 'ok' },
                          ],
                        },
                      ],
                    },
                  ],
                  default: [{ type: 'agent', agentId: 'fallback' }],
                },
                { type: 'agent', agentId: 'sibling' },
              ],
            },
            { type: 'agent', agentId: 'closer' },
          ],
        },
      },
    })
    try {
      const first = await collect(bread.runPipeline('par', { outer: 'go', inner: 'go' }))
      expect(first.map((c) => c.type)).toContain('human:required')
      expect(writer.doStreamCalls).toHaveLength(0)
      expect(closer.doStreamCalls).toHaveLength(0)
      expect(fallback.doStreamCalls).toHaveLength(0)
      expect(ok.doStreamCalls).toHaveLength(1)
      expect(sibling.doStreamCalls).toHaveLength(1)

      const cp = first.find((c) => c.type === 'human:required') as HumanRequiredCrumb
      const record = await bread.store.getCheckpoint(cp.checkpointId)
      expect(record?.parent?.kind).toBe('pipeline')
      if (record?.parent?.kind !== 'pipeline') throw new Error('expected a pipeline parent')
      expect(record.parent.remainingSteps).toEqual([{ type: 'agent', agentId: 'writer' }])
      const slots: PipelineCheckpointParent[] = []
      let frame: PipelineCheckpointParent | undefined = record.parent
      while (frame) {
        if (frame.parallel) slots.push(frame)
        frame = frame.outer
      }
      expect(slots).toHaveLength(2)
      expect(slots[0]!.parallel).toMatchObject({
        branchIndex: 0,
        settledOutputs: [null, 'OK'],
        pendingCheckpointIds: [cp.checkpointId],
      })
      expect(slots[1]!.parallel).toMatchObject({
        branchIndex: 0,
        settledOutputs: [null, 'SIB'],
        pendingCheckpointIds: [cp.checkpointId],
      })

      const cont = await collect(bread.resume(cp.checkpointId, { approved: true }))
      expect(cont.some((c) => c.type === 'pipeline:branch:taken')).toBe(false)
      expect(writer.doStreamCalls).toHaveLength(1)
      expect(JSON.stringify(writer.doStreamCalls[0]!.prompt)).toContain('approved!')
      expect(fallback.doStreamCalls).toHaveLength(0)
      expect(closer.doStreamCalls).toHaveLength(1)
      const prompt = JSON.stringify(closer.doStreamCalls[0]!.prompt)
      expect(prompt).toContain('WROTE')
      expect(prompt).toContain('OK')
      expect(prompt).toContain('SIB')
      const merged = (cont.filter((c) => c.type === 'pipeline:step:end') as PipelineStepEndCrumb[]).find(
        (c) => c.pipelineId === 'par' && c.agentId === 'parallel',
      )
      expect(merged?.output).toEqual([['WROTE', 'OK'], 'SIB'])
    } finally {
      await stop()
    }
  })
})
