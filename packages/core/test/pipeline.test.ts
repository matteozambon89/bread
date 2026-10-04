import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { BreadError, defineHumanTool } from '@breadai/core'
import type {
  BreadCrumb,
  BreadInstance,
  DecisionClient,
  DecisionHostAnswer,
  DecisionHostQuestion,
  DecisionQuestion,
  HumanRequiredCrumb,
  PipelineStep,
  PipelineStepEndCrumb,
  PipelineStepStartCrumb,
} from '@breadai/core'
import { store as memoryStore } from '@breadai/store-memory'
import {
  collect,
  defineTestAgent,
  makeBread,
  mockErrorModel,
  mockTextModel,
  mockToolCallModel,
} from '@breadai/test-utils'
import type { MockLanguageModelV4 } from 'ai/test'
import { z } from 'zod'

const PIPELINES: Record<string, PipelineStep[]> = {
  p1: [
    { type: 'agent', agentId: 'first' },
    { type: 'agent', agentId: 'second' },
  ],
  par: [
    {
      type: 'parallel',
      steps: [
        { type: 'agent', agentId: 'first' },
        { type: 'agent', agentId: 'second' },
      ],
    },
  ],
  m: [{ type: 'map', agentId: 'first' }],
}

describe('bread.runPipeline — sequential steps', () => {
  let bread: BreadInstance
  let stop: () => Promise<void>
  let second: MockLanguageModelV4

  beforeEach(async () => {
    second = mockTextModel('STEP2') as MockLanguageModelV4
    ;({ bread, stop } = await makeBread({
      agents: { first: defineTestAgent({ model: 'first' }), second: defineTestAgent({ model: 'second' }) },
      models: { first: mockTextModel('STEP1'), second },
      config: { pipelines: PIPELINES },
    }))
  })

  afterEach(() => stop())

  test('threads each step output into the next step input', async () => {
    const crumbs = await collect(bread.runPipeline('p1', 'start'))

    const ends = crumbs.filter((c) => c.type === 'pipeline:step:end') as PipelineStepEndCrumb[]
    expect(ends.map((c) => c.output)).toEqual(['STEP1', 'STEP2'])

    // The second agent must have been prompted with the first agent's output.
    expect(JSON.stringify(second.doStreamCalls[0]!.prompt)).toContain('STEP1')
  })

  test('emits step:start/step:end for every step with correct indices', async () => {
    const crumbs = await collect(bread.runPipeline('p1', 'x'))
    const starts = crumbs.filter((c) => c.type === 'pipeline:step:start')
    expect(starts.map((c) => (c as { stepIndex: number }).stepIndex)).toEqual([0, 1])
  })

  test('throws PIPELINE_NOT_FOUND for an id missing from config.pipelines', () => {
    expect(() => bread.runPipeline('missing', 'x')).toThrow('Pipeline not found: "missing"')
  })

  test('runs a parallel step, completing every branch', async () => {
    const ended = (await collect(bread.runPipeline('par', 'x')))
      .filter((c) => c.type === 'agent:run:end')
      .map((c) => (c as { agentId: string }).agentId)
    expect(ended).toContain('first')
    expect(ended).toContain('second')
  })

  test('a failing parallel branch fails the step after siblings settle', async () => {
    const broken = mockErrorModel('branch down')
    const { bread: b2, stop: stop2 } = await makeBread({
      agents: { ok: defineTestAgent({ model: 'ok' }), bad: defineTestAgent({ model: 'bad' }) },
      models: { ok: mockTextModel('fine'), bad: broken },
      config: {
        pipelines: {
          pf: [
            {
              type: 'parallel',
              steps: [
                { type: 'agent', agentId: 'ok' },
                { type: 'agent', agentId: 'bad' },
              ],
            },
          ],
        },
      },
    })

    const crumbs: BreadCrumb[] = []
    await expect(
      (async () => {
        for await (const c of b2.runPipeline('pf', 'x')) {
          crumbs.push(c)
        }
      })(),
    ).rejects.toThrow('branch down')

    // The healthy sibling's crumbs surfaced before the throw; the failure
    // itself surfaced as the bad branch's agent:error crumb.
    const ended = crumbs
      .filter((c) => c.type === 'agent:run:end')
      .map((c) => (c as { agentId: string }).agentId)
    expect(ended).toContain('ok')
    expect(crumbs.map((c) => c.type)).toContain('agent:error')

    await stop2()
  })

  test('fans a map step out over array items', async () => {
    const crumbs = await collect(bread.runPipeline('m', ['a', 'b', 'c']))
    // One agent run per item; the step output collects each run's output.
    const runs = crumbs.filter((c) => c.type === 'agent:run:end')
    expect(runs).toHaveLength(3)
    const end = crumbs.find((c) => c.type === 'pipeline:step:end') as PipelineStepEndCrumb
    expect(end.output).toEqual(['STEP1', 'STEP1', 'STEP1'])
  })
})

describe('bread.runPipeline — parallel step output threading', () => {
  test('a parallel step outputs the ordered array of branch outputs into the next step', async () => {
    const writer = mockTextModel('DONE') as MockLanguageModelV4
    const { bread, stop } = await makeBread({
      agents: {
        a: defineTestAgent({ model: 'a' }),
        b: defineTestAgent({ model: 'b' }),
        writer: defineTestAgent({ model: 'writer' }),
      },
      models: { a: mockTextModel('A'), b: mockTextModel('B'), writer },
      config: {
        pipelines: {
          fanout: [
            {
              type: 'parallel',
              steps: [
                { type: 'agent', agentId: 'a' },
                { type: 'agent', agentId: 'b' },
              ],
            },
            { type: 'agent', agentId: 'writer' },
          ],
        },
      },
    })
    try {
      const crumbs = await collect(bread.runPipeline('fanout', 'topic'))
      // Branch sub-pipelines emit their own step:end crumbs — the outer
      // pipeline's are the ones keyed by its own pipelineId.
      const ends = (crumbs.filter((c) => c.type === 'pipeline:step:end') as PipelineStepEndCrumb[]).filter(
        (c) => c.pipelineId === 'fanout',
      )
      // Branch order, not completion order.
      expect(ends.find((c) => c.stepIndex === 0)?.output).toEqual(['A', 'B'])
      expect(ends.find((c) => c.stepIndex === 1)?.output).toBe('DONE')
      // The writer was actually prompted with both branch outputs.
      const prompt = JSON.stringify(writer.doStreamCalls[0]!.prompt)
      expect(prompt).toContain('A')
      expect(prompt).toContain('B')
    } finally {
      await stop()
    }
  })
})

describe('bread.runPipeline — durable HITL', () => {
  const approve = defineHumanTool('approve', z.object({ question: z.string() }))
  const gateModel = () =>
    mockToolCallModel({ toolName: 'human_approve', args: { question: 'ok?' }, then: 'approved!' })

  function humanRequired(crumbs: BreadCrumb[]): HumanRequiredCrumb {
    const cp = crumbs.find((c) => c.type === 'human:required') as HumanRequiredCrumb | undefined
    if (!cp) throw new Error('expected a human:required crumb')
    return cp
  }

  test('a suspending step stops the pipeline; resume runs the remaining steps', async () => {
    const second = mockTextModel('SECOND') as MockLanguageModelV4
    const { bread, stop } = await makeBread({
      agents: {
        gate: defineTestAgent({ model: 'gate', humanTools: [approve] }),
        second: defineTestAgent({ model: 'second' }),
      },
      models: { gate: gateModel(), second },
      config: {
        pipelines: {
          gated: [
            { type: 'agent', agentId: 'gate' },
            { type: 'agent', agentId: 'second' },
          ],
        },
      },
    })
    try {
      const first = await collect(bread.runPipeline('gated', 'go'))
      // The stream ends at human:required — no step:end, no second step.
      expect(first.map((c) => c.type)).toContain('human:required')
      expect(first.filter((c) => c.type === 'pipeline:step:end')).toHaveLength(0)
      expect(second.doStreamCalls).toHaveLength(0)

      const cont = await collect(bread.resume(humanRequired(first).checkpointId, { approved: true }))
      const ends = cont.filter((c) => c.type === 'pipeline:step:end') as PipelineStepEndCrumb[]
      // The suspended step closes with the resumed output, then the rest runs.
      expect(ends.map((c) => [c.stepIndex, c.output])).toEqual([
        [0, 'approved!'],
        [1, 'SECOND'],
      ])
      // The second agent was prompted with the resumed first-step output.
      expect(JSON.stringify(second.doStreamCalls[0]!.prompt)).toContain('approved!')
      expect(await bread.store.listCheckpoints()).toHaveLength(0)
    } finally {
      await stop()
    }
  })

  test('resume continues the pipeline across a restart (fresh instance, same store)', async () => {
    const testStore = memoryStore()
    const gate = gateModel()
    const agents = () => ({
      gate: defineTestAgent({ model: 'gate', humanTools: [approve] }),
      second: defineTestAgent({ model: 'second' }),
    })
    const pipelines: Record<string, PipelineStep[]> = {
      gated: [
        { type: 'agent', agentId: 'gate' },
        { type: 'agent', agentId: 'second' },
      ],
    }

    const a = await makeBread({
      agents: agents(),
      models: { gate, second: mockTextModel('SECOND') },
      config: { pipelines, store: testStore },
    })
    const first = await collect(a.bread.runPipeline('gated', 'go'))
    const cp = humanRequired(first)
    await a.stop() // simulate shutdown — the in-memory pipeline walk is gone

    const b = await makeBread({
      agents: agents(),
      models: { gate, second: mockTextModel('SECOND') },
      config: { pipelines, store: testStore },
    })
    try {
      const cont = await collect(b.bread.resume(cp.checkpointId, { approved: true }))
      const ends = cont.filter((c) => c.type === 'pipeline:step:end') as PipelineStepEndCrumb[]
      expect(ends.map((c) => [c.stepIndex, c.output])).toEqual([
        [0, 'approved!'],
        [1, 'SECOND'],
      ])
    } finally {
      await b.stop()
    }
  })

  test('a suspended parallel branch resumes into the merged branch outputs', async () => {
    const { bread, stop } = await makeBread({
      agents: {
        gate: defineTestAgent({ model: 'gate', humanTools: [approve] }),
        ok: defineTestAgent({ model: 'ok' }),
        writer: defineTestAgent({ model: 'writer' }),
      },
      models: { gate: gateModel(), ok: mockTextModel('OK'), writer: mockTextModel('DONE') },
      config: {
        pipelines: {
          par: [
            {
              type: 'parallel',
              steps: [
                { type: 'agent', agentId: 'gate' },
                { type: 'agent', agentId: 'ok' },
              ],
            },
            { type: 'agent', agentId: 'writer' },
          ],
        },
      },
    })
    try {
      const first = await collect(bread.runPipeline('par', 'go'))
      // The healthy sibling settled before the stream ended; nothing merged yet.
      expect(first.filter((c) => c.type === 'pipeline:step:end' && (c as PipelineStepEndCrumb).stepIndex === 0)).toHaveLength(1) // ok's branch sub-step only
      expect(first.map((c) => c.type)).toContain('human:required')

      const cont = await collect(bread.resume(humanRequired(first).checkpointId, { approved: true }))
      const merged = (cont.filter((c) => c.type === 'pipeline:step:end') as PipelineStepEndCrumb[]).find(
        (c) => c.pipelineId === 'par' && c.stepIndex === 0,
      )
      expect(merged?.output).toEqual(['approved!', 'OK'])
      const writerEnd = (cont.filter((c) => c.type === 'pipeline:step:end') as PipelineStepEndCrumb[]).find(
        (c) => c.stepIndex === 1,
      )
      expect(writerEnd?.output).toBe('DONE')
    } finally {
      await stop()
    }
  })
})

describe('bread.runPipeline — an agent step that splits text into an array feeds a map step', () => {
  test('a CustomFormat agent output actually fans the following map step out', async () => {
    const { bread, stop } = await makeBread({
      agents: {
        researcher: defineTestAgent({
          model: 'researcher',
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
        writer: defineTestAgent({ model: 'writer' }),
      },
      models: { researcher: mockTextModel('a\nb\nc'), writer: mockTextModel('done') },
      config: {
        pipelines: {
          article: [
            { type: 'agent', agentId: 'researcher' },
            { type: 'map', agentId: 'writer' },
          ],
        },
      },
    })
    try {
      const crumbs = await collect(bread.runPipeline('article', 'bread'))
      const researcherEnd = crumbs.find(
        (c) => c.type === 'agent:run:end' && (c as { agentId: string }).agentId === 'researcher',
      ) as { output: unknown }
      expect(researcherEnd.output).toEqual(['a', 'b', 'c'])

      const writerRuns = crumbs.filter(
        (c) => c.type === 'agent:run:end' && (c as { agentId: string }).agentId === 'writer',
      )
      expect(writerRuns).toHaveLength(3)
    } finally {
      await stop()
    }
  })
})

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

describe('bread.runPipeline — decision step', () => {
  test('keeps the label off the following agent input and records it on step end', async () => {
    const seen: { state?: unknown; questions?: DecisionHostQuestion[]; model?: string } = {}
    const reply = mockTextModel('noted') as MockLanguageModelV4
    const { bread, stop } = await makeBread({
      agents: { reply: defineTestAgent({ model: 'reply' }) },
      models: { reply },
      config: {
        decisions: { typesafe: fakeClient({ type: 'choice', choice: 'billing', confidence: 0.91 }, seen) },
        pipelines: {
          classify: [
            {
              type: 'decision',
              provider: 'typesafe',
              model: 'jev-latest',
              question: choiceQuestion(),
            },
            { type: 'agent', agentId: 'reply' },
          ],
        },
      },
    })
    try {
      const crumbs = await collect(bread.runPipeline('classify', TICKET))
      const start = crumbs.find((c) => c.type === 'pipeline:step:start') as PipelineStepStartCrumb
      expect(start.agentId).toBe('decision')
      const end = crumbs.find((c) => c.type === 'pipeline:step:end' && c.agentId === 'decision') as PipelineStepEndCrumb
      expect(end.output).toEqual({
        label: 'billing',
        answer: { type: 'choice', choice: 'billing', confidence: 0.91 },
      })
      expect(seen.model).toBe('jev-latest')
      expect(seen.state).toBe(TICKET)
      expect(seen.questions).toEqual([
        { type: 'choice', text: 'Which desk owns this ticket?', options: ['billing', 'shipping'] },
      ])
      const prompt = JSON.stringify(reply.doStreamCalls[0]!.prompt)
      expect(prompt).toContain(TICKET)
      expect(prompt).not.toContain('billing')
      expect(prompt).not.toContain('needs_review')
    } finally {
      await stop()
    }
  })

  test('writes otherwise when confidence is below minConfidence', async () => {
    const reply = mockTextModel('noted') as MockLanguageModelV4
    const { bread, stop } = await makeBread({
      agents: { reply: defineTestAgent({ model: 'reply' }) },
      models: { reply },
      config: {
        decisions: {
          typesafe: fakeClient({ type: 'choice', choice: 'billing', confidence: 0.2 }, {}),
        },
        pipelines: {
          classify: [
            { type: 'decision', provider: 'typesafe', model: 'jev-latest', question: choiceQuestion(0.8) },
            { type: 'agent', agentId: 'reply' },
          ],
        },
      },
    })
    try {
      const crumbs = await collect(bread.runPipeline('classify', TICKET))
      const end = crumbs.find((c) => c.type === 'pipeline:step:end' && c.agentId === 'decision') as PipelineStepEndCrumb
      expect((end.output as { label: string }).label).toBe('needs_review')
      expect(JSON.stringify(reply.doStreamCalls[0]!.prompt)).toContain(TICKET)
    } finally {
      await stop()
    }
  })

  test('accepts confidence equal to minConfidence', async () => {
    const { bread, stop } = await makeBread({
      agents: { reply: defineTestAgent({ model: 'reply' }) },
      models: { reply: mockTextModel('noted') },
      config: {
        decisions: { typesafe: fakeClient({ type: 'choice', choice: 'billing', confidence: 0.8 }, {}) },
        pipelines: {
          classify: [
            { type: 'decision', provider: 'typesafe', model: 'jev-latest', question: choiceQuestion(0.8) },
          ],
        },
      },
    })
    try {
      const crumbs = await collect(bread.runPipeline('classify', TICKET))
      const end = crumbs.find((c) => c.type === 'pipeline:step:end') as PipelineStepEndCrumb
      expect((end.output as { label: string }).label).toBe('billing')
    } finally {
      await stop()
    }
  })

  test('writes otherwise when the choice is outside options', async () => {
    const { bread, stop } = await makeBread({
      agents: { reply: defineTestAgent({ model: 'reply' }) },
      models: { reply: mockTextModel('noted') },
      config: {
        decisions: { typesafe: fakeClient({ type: 'choice', choice: 'legal', confidence: 0.99 }, {}) },
        pipelines: {
          classify: [
            { type: 'decision', provider: 'typesafe', model: 'jev-latest', question: choiceQuestion() },
          ],
        },
      },
    })
    try {
      const crumbs = await collect(bread.runPipeline('classify', TICKET))
      const end = crumbs.find((c) => c.type === 'pipeline:step:end') as PipelineStepEndCrumb
      expect((end.output as { label: string }).label).toBe('needs_review')
    } finally {
      await stop()
    }
  })

  test('keeps a choice when confidence is absent and minConfidence is unset', async () => {
    const { bread, stop } = await makeBread({
      agents: { reply: defineTestAgent({ model: 'reply' }) },
      models: { reply: mockTextModel('noted') },
      config: {
        decisions: { typesafe: fakeClient({ type: 'choice', choice: 'shipping' }, {}) },
        pipelines: {
          classify: [
            { type: 'decision', provider: 'typesafe', model: 'jev-latest', question: choiceQuestion() },
          ],
        },
      },
    })
    try {
      const crumbs = await collect(bread.runPipeline('classify', TICKET))
      const end = crumbs.find((c) => c.type === 'pipeline:step:end') as PipelineStepEndCrumb
      expect((end.output as { label: string }).label).toBe('shipping')
    } finally {
      await stop()
    }
  })

  test('writes otherwise when confidence is missing and minConfidence is set', async () => {
    const { bread, stop } = await makeBread({
      agents: { reply: defineTestAgent({ model: 'reply' }) },
      models: { reply: mockTextModel('noted') },
      config: {
        decisions: { typesafe: fakeClient({ type: 'choice', choice: 'billing' }, {}) },
        pipelines: {
          classify: [
            { type: 'decision', provider: 'typesafe', model: 'jev-latest', question: choiceQuestion(0.5) },
          ],
        },
      },
    })
    try {
      const crumbs = await collect(bread.runPipeline('classify', TICKET))
      const end = crumbs.find((c) => c.type === 'pipeline:step:end') as PipelineStepEndCrumb
      expect((end.output as { label: string }).label).toBe('needs_review')
    } finally {
      await stop()
    }
  })

  test('labels a score from the one inclusive bucket and does not send ranges', async () => {
    const seen: { questions?: DecisionHostQuestion[] } = {}
    const { bread, stop } = await makeBread({
      agents: { reply: defineTestAgent({ model: 'reply' }) },
      models: { reply: mockTextModel('noted') },
      config: {
        decisions: { typesafe: fakeClient({ type: 'score', score: 4 }, seen) },
        pipelines: {
          classify: [
            {
              type: 'decision',
              provider: 'typesafe',
              model: 'jev-latest',
              question: {
                type: 'score',
                text: 'How urgent is this?',
                buckets: [
                  { label: 'low', min: 0, max: 3 },
                  { label: 'high', min: 4, max: 9 },
                ],
              },
            },
          ],
        },
      },
    })
    try {
      const crumbs = await collect(bread.runPipeline('classify', TICKET))
      const end = crumbs.find((c) => c.type === 'pipeline:step:end') as PipelineStepEndCrumb
      expect(end.output).toEqual({
        label: 'high',
        answer: { type: 'score', score: 4 },
      })
      expect(seen.questions).toEqual([{ type: 'score', text: 'How urgent is this?' }])
    } finally {
      await stop()
    }
  })

  test('labels a noul probability from the one inclusive bucket', async () => {
    const { bread, stop } = await makeBread({
      agents: { reply: defineTestAgent({ model: 'reply' }) },
      models: { reply: mockTextModel('noted') },
      config: {
        decisions: { typesafe: fakeClient({ type: 'noul', probability: 0 }, {}) },
        pipelines: {
          classify: [
            {
              type: 'decision',
              provider: 'typesafe',
              model: 'jev-latest',
              question: {
                type: 'noul',
                text: 'Is this a billing issue?',
                buckets: [
                  { label: 'no', min: 0, max: 0.5 },
                  { label: 'yes', min: 0.51, max: 1 },
                ],
              },
            },
          ],
        },
      },
    })
    try {
      const crumbs = await collect(bread.runPipeline('classify', TICKET))
      const end = crumbs.find((c) => c.type === 'pipeline:step:end') as PipelineStepEndCrumb
      expect((end.output as { label: string }).label).toBe('no')
    } finally {
      await stop()
    }
  })

  test('throws DECISION_BUCKET when zero buckets match', async () => {
    const reply = mockTextModel('noted') as MockLanguageModelV4
    const { bread, stop } = await makeBread({
      agents: { reply: defineTestAgent({ model: 'reply' }) },
      models: { reply },
      config: {
        decisions: { typesafe: fakeClient({ type: 'score', score: 5 }, {}) },
        pipelines: {
          classify: [
            {
              type: 'decision',
              provider: 'typesafe',
              model: 'jev-latest',
              question: {
                type: 'score',
                text: 'How urgent is this?',
                buckets: [{ label: 'low', min: 0, max: 3 }],
              },
            },
            { type: 'agent', agentId: 'reply' },
          ],
        },
      },
    })
    try {
      const { crumbs, error } = await drain(bread.runPipeline('classify', TICKET))
      expect(error).toBeInstanceOf(BreadError)
      expect((error as BreadError).code).toBe('DECISION_BUCKET')
      expect(crumbs.some((c) => c.type === 'pipeline:step:end')).toBe(false)
      expect(reply.doStreamCalls).toHaveLength(0)
    } finally {
      await stop()
    }
  })

  test('throws DECISION_BUCKET when two inclusive buckets match', async () => {
    const { bread, stop } = await makeBread({
      agents: { reply: defineTestAgent({ model: 'reply' }) },
      models: { reply: mockTextModel('noted') },
      config: {
        decisions: { typesafe: fakeClient({ type: 'noul', probability: 0.5 }, {}) },
        pipelines: {
          classify: [
            {
              type: 'decision',
              provider: 'typesafe',
              model: 'jev-latest',
              question: {
                type: 'noul',
                text: 'Is this a billing issue?',
                buckets: [
                  { label: 'no', min: 0, max: 0.5 },
                  { label: 'yes', min: 0.5, max: 1 },
                ],
              },
            },
          ],
        },
      },
    })
    try {
      const { error } = await drain(bread.runPipeline('classify', TICKET))
      expect((error as BreadError).code).toBe('DECISION_BUCKET')
      expect((error as BreadError).context).toMatchObject({ value: 0.5, matches: ['no', 'yes'] })
    } finally {
      await stop()
    }
  })

  test('throws DECISION_ANSWER when the number is missing', async () => {
    const { bread, stop } = await makeBread({
      agents: { reply: defineTestAgent({ model: 'reply' }) },
      models: { reply: mockTextModel('noted') },
      config: {
        decisions: { typesafe: fakeClient({ type: 'score' }, {}) },
        pipelines: {
          classify: [
            {
              type: 'decision',
              provider: 'typesafe',
              model: 'jev-latest',
              question: {
                type: 'score',
                text: 'How urgent is this?',
                buckets: [{ label: 'low', min: 0, max: 9 }],
              },
            },
          ],
        },
      },
    })
    try {
      const { error } = await drain(bread.runPipeline('classify', TICKET))
      expect((error as BreadError).code).toBe('DECISION_ANSWER')
    } finally {
      await stop()
    }
  })

  test('throws DECISION_ANSWER when the host answer is missing or the wrong type', async () => {
    const missing = await makeBread({
      agents: { reply: defineTestAgent({ model: 'reply' }) },
      models: { reply: mockTextModel('noted') },
      config: {
        decisions: { typesafe: fakeClient(undefined, {}) },
        pipelines: {
          classify: [
            { type: 'decision', provider: 'typesafe', model: 'jev-latest', question: choiceQuestion() },
          ],
        },
      },
    })
    const mismatch = await makeBread({
      agents: { reply: defineTestAgent({ model: 'reply' }) },
      models: { reply: mockTextModel('noted') },
      config: {
        decisions: { typesafe: fakeClient({ type: 'score', score: 1 }, {}) },
        pipelines: {
          classify: [
            { type: 'decision', provider: 'typesafe', model: 'jev-latest', question: choiceQuestion() },
          ],
        },
      },
    })
    try {
      const missingResult = await drain(missing.bread.runPipeline('classify', TICKET))
      expect((missingResult.error as BreadError).code).toBe('DECISION_ANSWER')
      const mismatchResult = await drain(mismatch.bread.runPipeline('classify', TICKET))
      expect((mismatchResult.error as BreadError).code).toBe('DECISION_ANSWER')
    } finally {
      await missing.stop()
      await mismatch.stop()
    }
  })

  test('throws UNKNOWN_DECISION_PROVIDER before the next step runs', async () => {
    const reply = mockTextModel('noted') as MockLanguageModelV4
    const { bread, stop } = await makeBread({
      agents: { reply: defineTestAgent({ model: 'reply' }) },
      models: { reply },
      config: {
        decisions: { typesafe: fakeClient({ type: 'choice', choice: 'billing' }, {}) },
        pipelines: {
          classify: [
            { type: 'decision', provider: 'missing', model: 'jev-latest', question: choiceQuestion() },
            { type: 'agent', agentId: 'reply' },
          ],
        },
      },
    })
    try {
      const { crumbs, error } = await drain(bread.runPipeline('classify', TICKET))
      expect(error).toBeInstanceOf(BreadError)
      const breadError = error as BreadError
      expect(breadError.code).toBe('UNKNOWN_DECISION_PROVIDER')
      expect(breadError.message).toContain('typesafe')
      const starts = crumbs.filter((c) => c.type === 'pipeline:step:start') as PipelineStepStartCrumb[]
      expect(starts.map((c) => c.agentId)).toEqual(['decision'])
      expect(reply.doStreamCalls).toHaveLength(0)
    } finally {
      await stop()
    }
  })

  test('throws UNKNOWN_DECISION_PROVIDER for an empty registry', async () => {
    const { bread, stop } = await makeBread({
      agents: { reply: defineTestAgent({ model: 'reply' }) },
      models: { reply: mockTextModel('noted') },
      config: {
        decisions: {},
        pipelines: {
          classify: [
            { type: 'decision', provider: 'typesafe', model: 'jev-latest', question: choiceQuestion() },
          ],
        },
      },
    })
    try {
      const { error } = await drain(bread.runPipeline('classify', TICKET))
      expect((error as BreadError).code).toBe('UNKNOWN_DECISION_PROVIDER')
    } finally {
      await stop()
    }
  })

  test('throws DECISION_NOT_CONFIGURED when the registry is missing', async () => {
    const reply = mockTextModel('noted') as MockLanguageModelV4
    const { bread, stop } = await makeBread({
      agents: { reply: defineTestAgent({ model: 'reply' }) },
      models: { reply },
      config: {
        pipelines: {
          classify: [
            { type: 'decision', provider: 'typesafe', model: 'jev-latest', question: choiceQuestion() },
            { type: 'agent', agentId: 'reply' },
          ],
        },
      },
    })
    try {
      const { crumbs, error } = await drain(bread.runPipeline('classify', TICKET))
      expect((error as BreadError).code).toBe('DECISION_NOT_CONFIGURED')
      expect(crumbs.filter((c) => c.type === 'pipeline:step:start')).toHaveLength(1)
      expect(reply.doStreamCalls).toHaveLength(0)
    } finally {
      await stop()
    }
  })
})
