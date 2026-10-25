import assert from 'node:assert/strict'
import type { AuthIdentity, BreadAuthStrategy, BreadTransport, PipelineStep } from '@breadai/core'
import { defineHumanTool } from '@breadai/core'
import { authPlugin } from '@breadai/server'
import { z } from 'zod'
import { defineTestAgent } from './agent.js'
import { makeServer } from './harness.js'
import { mockChunkedTextModel, mockToolCallModel } from './mock-model.js'

// Run stream and cancel scoping, shared by every HTTP transport so they
// cannot drift apart. `x-identity: <sub>` signs in with a principal and
// `x-identity: key` signs in like an API key, with no principal.

export interface RunOwnerCase {
  name: string
  fn: (makeTransport: () => BreadTransport) => Promise<void>
}

const strategy: BreadAuthStrategy = {
  name: 'header',
  authenticate(req: Request): AuthIdentity | null {
    const subject = req.headers.get('x-identity')
    if (!subject) return null
    if (subject === 'key') return { subject }
    return { subject, principal: { iss: 'https://bread.local/test', sub: subject } }
  },
}

const MADE_UP_RUN = '00000000-0000-7000-8000-000000000000'

type App = Awaited<ReturnType<typeof makeServer>>['app']

async function serve(makeTransport: () => BreadTransport, chunkDelayInMs: number, auth = true) {
  return makeServer({
    agents: { assistant: defineTestAgent() },
    model: mockChunkedTextModel(['a', 'b', 'c', 'd'], chunkDelayInMs),
    plugins: auth ? [authPlugin([strategy])] : [],
    config: { transport: makeTransport(), ...(auth ? { server: { authorize: () => true } } : {}) },
  })
}

// Step runIds are `${pipelineRunId}:${pipelineId}:${index}…`, unique per run.
const PIPELINES: Record<string, PipelineStep[]> = {
  chain: [
    { type: 'agent', agentId: 'assistant' },
    { type: 'agent', agentId: 'assistant' },
  ],
  fan: [
    {
      type: 'parallel',
      steps: [
        { type: 'agent', agentId: 'assistant' },
        { type: 'agent', agentId: 'assistant' },
      ],
    },
  ],
  fork: [
    {
      type: 'branch',
      on: 'route',
      cases: [{ eq: 'x', steps: [{ type: 'agent', agentId: 'assistant' }] }],
      default: [],
    },
  ],
  gated: [
    { type: 'agent', agentId: 'gate' },
    { type: 'agent', agentId: 'assistant' },
  ],
}

async function servePipelines(makeTransport: () => BreadTransport, chunkDelayInMs: number) {
  const approve = defineHumanTool('approve', z.object({ question: z.string() }))
  const gate = mockToolCallModel({ toolName: 'human_approve', args: { question: 'ok?' }, then: 'approved' })
  const server = await makeServer({
    agents: {
      assistant: defineTestAgent(),
      gate: defineTestAgent({ model: 'gate', humanTools: [approve] }),
    },
    models: { default: mockChunkedTextModel(['a', 'b', 'c', 'd'], chunkDelayInMs), gate },
    plugins: [authPlugin([strategy])],
    config: { transport: makeTransport(), server: { authorize: () => true }, pipelines: PIPELINES },
  })
  return { ...server, gate }
}

function as(subject: string | undefined, init: RequestInit = {}): RequestInit {
  return { ...init, headers: { 'content-type': 'application/json', ...(subject ? { 'x-identity': subject } : {}) } }
}

// Starts a run and reads until its runId shows up. finish() drains the rest
// and returns the whole body, so the run stays live until the case is ready.
async function start(app: App, subject: string | undefined, origin = 'http://localhost') {
  const res = await app.request(`${origin}/agents/assistant/run`, as(subject, { method: 'POST', body: '{}' }))
  assert.equal(res.status, 200)
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let text = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) throw new Error(`run body ended without a runId: ${text}`)
    text += decoder.decode(value, { stream: true })
    const match = /"runId":"([^"]+)"/.exec(text)
    if (!match) continue
    const finish = async () => {
      for (;;) {
        const next = await reader.read()
        if (next.done) return text
        text += decoder.decode(next.value, { stream: true })
      }
    }
    return { runId: match[1]!, finish }
  }
}

// Opens a streaming POST and reads until `ready` holds for the body so far.
// finish() drains the rest and returns the whole body.
async function open(app: App, path: string, subject: string | undefined, body: unknown, ready: (text: string) => boolean) {
  const res = await app.request(path, as(subject, { method: 'POST', body: JSON.stringify(body) }))
  assert.equal(res.status, 200)
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let text = ''
  while (!ready(text)) {
    const { value, done } = await reader.read()
    if (done) throw new Error(`stream ended before it was ready: ${text}`)
    text += decoder.decode(value, { stream: true })
  }
  return {
    text: () => text,
    finish: async () => {
      for (;;) {
        const next = await reader.read()
        if (next.done) return text
        text += decoder.decode(next.value, { stream: true })
      }
    },
  }
}

// Every distinct runId in a body that belongs to a run of `pipelineId`.
function stepIds(text: string, pipelineId: string): string[] {
  const ids = [...text.matchAll(/"runId":"([^"]+)"/g)].map((m) => m[1]!)
  return [...new Set(ids.filter((id) => id.includes(`:${pipelineId}:`)))]
}

const STEP_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}:/

const NOT_FOUND = { status: 404, body: { error: 'Run not found' } }
const NOT_CANCELABLE = { status: 404, body: { error: 'Run not found or not cancelable' } }

// Another principal gets the made-up-run 404 on stream and cancel of every id.
async function assertHidden(app: App, ids: string[], subject: string) {
  assert.ok(ids.length > 0)
  for (const id of ids) {
    assert.deepEqual(await snapshot(await stream(app, id, subject)), NOT_FOUND, `stream ${id}`)
    assert.deepEqual(await snapshot(await cancel(app, id, subject)), NOT_CANCELABLE, `cancel ${id}`)
  }
}

// Cases for one pipeline shape: live, then finished, then another user's run.
function pipelineCases(name: string, pipelineId: string, input: unknown, readyMarker: string): RunOwnerCase[] {
  const ready = (text: string) => stepIds(text, pipelineId).some((id) => id.includes(readyMarker))
  return [
    {
      name: `${name}: on a live pipeline another user gets 404 on every step stream and cancel`,
      fn: async (makeTransport) => {
        const { app, stop } = await servePipelines(makeTransport, 50)
        try {
          const run = await open(app, `/pipelines/${pipelineId}/run`, 'alice', { input }, ready)
          const ids = stepIds(run.text(), pipelineId)
          for (const id of ids) assert.match(id, STEP_ID)
          await assertHidden(app, ids, 'bob')
          const owned = await stream(app, ids[0]!, 'alice')
          assert.equal(owned.status, 200)
          await owned.body?.cancel()
          const body = await run.finish()
          assert.match(body, /pipeline:step:end/)
          assert.doesNotMatch(body, /RUN_CANCELLED/)
        } finally {
          await stop()
        }
      },
    },
    {
      name: `${name}: a finished pipeline leaves no step id behind and another user's run shares none`,
      fn: async (makeTransport) => {
        const { app, stop } = await servePipelines(makeTransport, 0)
        try {
          const first = await open(app, `/pipelines/${pipelineId}/run`, 'alice', { input }, () => true)
          const aliceIds = stepIds(await first.finish(), pipelineId)
          // Step crumbs are not logged, so once the stream ends nobody owns them.
          await assertHidden(app, aliceIds, 'bob')
          await assertHidden(app, aliceIds, 'alice')

          const second = await open(app, `/pipelines/${pipelineId}/run`, 'bob', { input }, () => true)
          const bobIds = stepIds(await second.finish(), pipelineId)
          assert.ok(bobIds.length > 0)
          assert.deepEqual(bobIds.filter((id) => aliceIds.includes(id)), [])
          await assertHidden(app, aliceIds, 'alice')
        } finally {
          await stop()
        }
      },
    },
  ]
}

async function snapshot(res: Response) {
  return { status: res.status, body: await res.json() }
}

const stream = (app: App, runId: string, subject?: string) => app.request(`/runs/${runId}/stream`, as(subject))
const cancel = (app: App, runId: string, subject?: string) =>
  app.request(`/runs/${runId}/cancel`, as(subject, { method: 'POST' }))

export function runOwnerContractCases(): RunOwnerCase[] {
  return [
    {
      name: 'the owner streams a finished run and another user gets the same 404 as a made-up run id',
      fn: async (makeTransport) => {
        const { app, stop } = await serve(makeTransport, 0)
        try {
          const run = await start(app, 'alice')
          await run.finish()
          const owned = await stream(app, run.runId, 'alice')
          assert.equal(owned.status, 200)
          assert.match(await owned.text(), /agent:run:end/)
          const other = await snapshot(await stream(app, run.runId, 'bob'))
          assert.deepEqual(other, { status: 404, body: { error: 'Run not found' } })
          assert.deepEqual(await snapshot(await stream(app, MADE_UP_RUN, 'bob')), other)
        } finally {
          await stop()
        }
      },
    },
    {
      name: 'on a live run another user gets 404 on stream and cancel, and the run still completes',
      fn: async (makeTransport) => {
        const { app, stop } = await serve(makeTransport, 50)
        try {
          const run = await start(app, 'alice')
          const owned = await stream(app, run.runId, 'alice')
          assert.equal(owned.status, 200)
          await owned.body?.cancel()
          assert.deepEqual(await snapshot(await stream(app, run.runId, 'bob')), {
            status: 404,
            body: { error: 'Run not found' },
          })
          const other = await snapshot(await cancel(app, run.runId, 'bob'))
          assert.deepEqual(other, { status: 404, body: { error: 'Run not found or not cancelable' } })
          assert.deepEqual(await snapshot(await cancel(app, MADE_UP_RUN, 'bob')), other)
          const body = await run.finish()
          assert.match(body, /agent:run:end/)
          assert.doesNotMatch(body, /RUN_CANCELLED/)
        } finally {
          await stop()
        }
      },
    },
    {
      name: 'the owner can cancel their live run',
      fn: async (makeTransport) => {
        const { app, stop } = await serve(makeTransport, 50)
        try {
          const run = await start(app, 'alice')
          assert.deepEqual(await snapshot(await cancel(app, run.runId, 'alice')), { status: 200, body: { ok: true } })
          assert.match(await run.finish(), /RUN_CANCELLED/)
        } finally {
          await stop()
        }
      },
    },
    {
      name: 'a signed-in caller with no principal is refused on stream and cancel',
      fn: async (makeTransport) => {
        const { app, stop } = await serve(makeTransport, 50)
        try {
          const run = await start(app, 'alice')
          assert.deepEqual(await snapshot(await stream(app, run.runId, 'key')), { status: 403, body: { error: 'Forbidden' } })
          assert.deepEqual(await snapshot(await cancel(app, run.runId, 'key')), { status: 403, body: { error: 'Forbidden' } })
          assert.match(await run.finish(), /agent:run:end/)
        } finally {
          await stop()
        }
      },
    },
    ...pipelineCases('chain', 'chain', {}, ':chain:'),
    ...pipelineCases('parallel', 'fan', {}, ':parallel:'),
    ...pipelineCases('branch', 'fork', { route: 'x' }, ':branch:'),
    {
      name: 'another user resuming a pipeline checkpoint gets 404 and nothing is registered',
      fn: async (makeTransport) => {
        const { app, bread, gate, stop } = await servePipelines(makeTransport, 50)
        try {
          const run = await open(app, '/pipelines/gated/run', 'alice', {}, () => true)
          const suspended = await run.finish()
          const checkpointId = /"checkpointId":"([^"]+)"/.exec(suspended)?.[1]
          assert.ok(checkpointId)
          const checkpoint = await bread.store.getCheckpoint(checkpointId)
          assert.ok(checkpoint)
          const [root] = stepIds(suspended, 'gated')
          assert.match(root!, /:gated:0$/)
          const pipelineRoot = root!.slice(0, -':0'.length)
          // What a resume would register: the gate run and both step ids.
          const wouldRegister = [checkpoint.runId, `${pipelineRoot}:0`, `${pipelineRoot}:1`]

          const denied = await app.request(`/resume/${checkpointId}`, as('bob', { method: 'POST', body: '{}' }))
          assert.deepEqual(await snapshot(denied), { status: 404, body: { error: 'Checkpoint not found' } })
          assert.deepEqual(
            await snapshot(await app.request('/resume/missing', as('bob', { method: 'POST', body: '{}' }))),
            { status: 404, body: { error: 'Checkpoint not found' } },
          )
          assert.ok(await bread.store.getCheckpoint(checkpointId))
          assert.equal(gate.doStreamCalls.length, 1)
          for (const id of wouldRegister) {
            assert.deepEqual(await snapshot(await cancel(app, id, 'alice')), NOT_CANCELABLE, `cancel ${id}`)
          }
          await assertHidden(app, wouldRegister, 'bob')

          // The owner's resume reuses the original root, and its live entries
          // carry the owner's principal.
          const resumed = await open(app, `/resume/${checkpointId}`, 'alice', { response: { approved: true } }, (text) =>
            text.includes(`"runId":"${pipelineRoot}:1"`),
          )
          await assertHidden(app, [`${pipelineRoot}:1`], 'bob')
          const owned = await stream(app, `${pipelineRoot}:1`, 'alice')
          assert.equal(owned.status, 200)
          await owned.body?.cancel()
          const body = await resumed.finish()
          assert.ok(body.includes(`"runId":"${pipelineRoot}:0"`))
          assert.deepEqual(stepIds(body, 'gated').filter((id) => !id.startsWith(`${pipelineRoot}:`)), [])
          assert.match(body, /pipeline:step:end/)
        } finally {
          await stop()
        }
      },
    },
    {
      name: 'without auth a loopback caller still streams and cancels any run',
      fn: async (makeTransport) => {
        const { app, stop } = await serve(makeTransport, 50, false)
        try {
          const run = await start(app, undefined, 'http://127.0.0.1')
          const live = await app.request(`http://127.0.0.1/runs/${run.runId}/stream`)
          assert.equal(live.status, 200)
          await live.body?.cancel()
          const res = await app.request(`http://127.0.0.1/runs/${run.runId}/cancel`, { method: 'POST' })
          assert.deepEqual(await snapshot(res), { status: 200, body: { ok: true } })
          await run.finish()
        } finally {
          await stop()
        }
      },
    },
  ]
}

/** Registers the run-owner contract with `bun:test` for one HTTP transport. */
export function runRunOwnerContract(name: string, makeTransport: () => BreadTransport): void {
  // Lazy require keeps this module importable under node:test.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { describe, test } = require('bun:test') as typeof import('bun:test')
  describe(`run owner contract — ${name}`, () => {
    for (const c of runOwnerContractCases()) test(c.name, () => c.fn(makeTransport))
  })
}
