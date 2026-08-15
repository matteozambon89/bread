import assert from 'node:assert/strict'
import type { BreadStore, CheckpointRecord, CrumbLogEntry, LoopRecord, TaskRunRecord } from '@bread/core'

// A behavioral contract every BreadStore implementation must satisfy, expressed
// as runner-agnostic cases (node:assert works fine under Bun). Stores register
// them via `runStoreContract`.
//
// Each case receives a store the runner created fresh for that case and tears
// down afterwards — so in-memory drivers isolate via a fresh instance, while a
// persistent backend (pglite) isolates by closing the store and TRUNCATE-ing
// between cases. pglite serves one connection at a time, hence the strict
// open → use → close → reset ordering the runner enforces.

interface StoreCase {
  name: string
  /**
   * Optional BreadStore methods the case exercises. Runners must register the
   * case as *skipped* (visibly, not silently passing) when the store lacks any
   * of them — see `runStoreContract`.
   */
  requires?: (keyof BreadStore)[]
  fn: (store: BreadStore) => Promise<void>
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function checkpoint(over: Partial<CheckpointRecord> = {}): CheckpointRecord {
  return {
    id: 'cp-1',
    agentId: 'a',
    runId: 'r',
    sessionId: 's',
    toolName: 'ask',
    toolCallId: 'tc-1',
    schema: { type: 'object' },
    createdAt: Date.now(),
    ...over,
  }
}

function loop(sessionId: string, over: Partial<LoopRecord> = {}): LoopRecord {
  return {
    id: 'loop-1',
    agentId: 'a',
    sessionId,
    runId: 'r',
    pool: ['a', 'b'],
    pipeline: ['a'],
    maxIterations: 3,
    status: 'running',
    iterations: 0,
    startedAt: Date.now(),
    ...over,
  }
}

function crumbEntry(runId: string, seq: number, over: Partial<CrumbLogEntry> = {}): CrumbLogEntry {
  return {
    runId,
    seq,
    sessionId: 's',
    agentId: 'a',
    type: 'text:delta',
    crumb: { type: 'text:delta', agentId: 'a', runId, sessionId: 's', timestamp: 1, delta: `d${seq}`, seq },
    createdAt: Date.now(),
    ...over,
  }
}

const CRUMB_METHODS: (keyof BreadStore)[] = ['appendCrumbs', 'getCrumbs', 'getMaxCrumbSeq']

function taskRun(over: Partial<TaskRunRecord> = {}): TaskRunRecord {
  return {
    id: 'tr-1',
    taskId: 'extract',
    agentId: 'a',
    sessionId: 's',
    runId: 'r',
    model: { provider: 'mock', model: 'm' },
    input: { content: 'hi' },
    status: 'running',
    createdAt: Date.now(),
    ...over,
  }
}

/** The full contract case list. Each case operates on a runner-provided store. */
export function storeContractCases(): StoreCase[] {
  return [
    // --- Sessions ------------------------------------------------------------
    {
      name: 'creates a session with a generated id and timestamps',
      fn: async (store) => {
        const s = await store.createSession()
        assert.ok(s.id)
        assert.ok(s.createdAt > 0)
        assert.deepEqual(s.tags, {})
      },
    },
    {
      name: 'honours a caller-supplied id and tags',
      fn: async (store) => {
        const s = await store.createSession({ id: 'fixed', tags: { env: 'test' } })
        assert.equal(s.id, 'fixed')
        assert.deepEqual(s.tags, { env: 'test' })
      },
    },
    {
      name: 'round-trips a session through getSession',
      fn: async (store) => {
        const s = await store.createSession()
        assert.equal((await store.getSession(s.id))?.id, s.id)
      },
    },
    {
      name: 'returns undefined for an unknown session',
      fn: async (store) => {
        assert.equal(await store.getSession('nope'), undefined)
      },
    },
    {
      name: 'filters listSessions by tag',
      fn: async (store) => {
        await store.createSession({ tags: { keep: 'yes' } })
        await store.createSession({ tags: { keep: 'no' } })
        assert.equal((await store.listSessions({ tags: { keep: 'yes' } })).length, 1)
      },
    },
    {
      name: 'deletes a session',
      fn: async (store) => {
        const s = await store.createSession()
        await store.deleteSession(s.id)
        assert.equal(await store.getSession(s.id), undefined)
      },
    },
    {
      name: 'lists every session when no filter is given',
      fn: async (store) => {
        await store.createSession()
        await store.createSession({ tags: { env: 'x' } })
        assert.equal((await store.listSessions()).length, 2)
      },
    },
    {
      name: 'cleanupSessions deletes only sessions older than the window',
      fn: async (store) => {
        const old = await store.createSession()
        await sleep(30)
        const fresh = await store.createSession()
        const deleted = await store.cleanupSessions({ olderThanMs: 20 })
        assert.equal(deleted, 1)
        assert.equal(await store.getSession(old.id), undefined)
        assert.ok(await store.getSession(fresh.id))
      },
    },
    {
      name: 'cleanupSessions without olderThanMs deletes nothing — tags alone never delete',
      fn: async (store) => {
        await store.createSession({ tags: { env: 'test' } })
        await sleep(5)
        assert.equal(await store.cleanupSessions({ tags: { env: 'test' } }), 0)
        assert.equal((await store.listSessions()).length, 1)
      },
    },
    {
      name: 'cleanupSessions applies the tags filter within the age window',
      fn: async (store) => {
        const doomed = await store.createSession({ tags: { env: 'a' } })
        const spared = await store.createSession({ tags: { env: 'b' } })
        await sleep(30)
        const deleted = await store.cleanupSessions({ olderThanMs: 20, tags: { env: 'a' } })
        assert.equal(deleted, 1)
        assert.equal(await store.getSession(doomed.id), undefined)
        assert.ok(await store.getSession(spared.id))
      },
    },
    // --- Messages ------------------------------------------------------------
    {
      name: 'appends and returns messages in order',
      fn: async (store) => {
        const s = await store.createSession()
        await store.addMessage(s.id, { role: 'user', content: 'hi', timestamp: 1 })
        await store.addMessage(s.id, { role: 'assistant', content: 'yo', timestamp: 2 })
        const msgs = await store.getMessages(s.id)
        assert.deepEqual(
          msgs.map((m) => m.role),
          ['user', 'assistant'],
        )
        assert.deepEqual(
          msgs.map((m) => m.content),
          ['hi', 'yo'],
        )
      },
    },
    {
      name: 'returns no messages for a fresh session',
      fn: async (store) => {
        const s = await store.createSession()
        assert.deepEqual(await store.getMessages(s.id), [])
      },
    },
    {
      // Structured tool-call / tool-result rows must round-trip intact, and an
      // assistant tool-call written in the same millisecond as its tool-result
      // must still read back before it (monotonic message id breaks the tie).
      name: 'round-trips structured tool messages and orders them within a tick',
      fn: async (store) => {
        const s = await store.createSession()
        const assistant = {
          role: 'assistant' as const,
          content: [
            { type: 'text', text: 'checking' },
            { type: 'tool-call', toolCallId: 'tc-1', toolName: 'lookup', input: { q: 'x' } },
          ],
          timestamp: 5,
        }
        const toolResult = {
          role: 'tool' as const,
          content: [
            {
              type: 'tool-result',
              toolCallId: 'tc-1',
              toolName: 'lookup',
              output: { type: 'json', value: { a: 1 } },
            },
          ],
          timestamp: 5,
        }
        await store.addMessage(s.id, assistant)
        await store.addMessage(s.id, toolResult)
        const msgs = await store.getMessages(s.id)
        assert.deepEqual(
          msgs.map((m) => m.role),
          ['assistant', 'tool'],
        )
        assert.deepEqual(msgs[0]?.content, assistant.content)
        assert.deepEqual(msgs[1]?.content, toolResult.content)
      },
    },
    // --- Checkpoints ---------------------------------------------------------
    {
      name: 'saves, gets, lists and atomically deletes a checkpoint',
      fn: async (store) => {
        await store.createSession({ id: 's' })
        await store.saveCheckpoint(checkpoint({ prompt: 'ok?', skill: 'triage' }))
        const got = await store.getCheckpoint('cp-1')
        assert.equal(got?.toolName, 'ask')
        assert.equal(got?.toolCallId, 'tc-1')
        assert.deepEqual(got?.schema, { type: 'object' })
        assert.equal(got?.prompt, 'ok?')
        assert.equal(got?.skill, 'triage')
        assert.equal((await store.listCheckpoints()).length, 1)

        // deleteCheckpoint is the atomic claim primitive resume() relies on: it
        // returns the deleted record once, then undefined for anyone else.
        const claimed = await store.deleteCheckpoint('cp-1')
        assert.equal(claimed?.id, 'cp-1')
        assert.equal(await store.deleteCheckpoint('cp-1'), undefined)
        assert.equal(await store.getCheckpoint('cp-1'), undefined)
        assert.equal((await store.listCheckpoints()).length, 0)
      },
    },
    {
      name: 'round-trips the composition parent linkage on a checkpoint',
      fn: async (store) => {
        await store.createSession({ id: 's' })
        const parent = {
          kind: 'pipeline' as const,
          pipelineId: 'p1',
          stepIndex: 1,
          stepAgentId: 'parallel',
          remainingSteps: [{ type: 'agent' as const, agentId: 'writer' }],
          parallel: { branchIndex: 0, settledOutputs: [null, 'B'], pendingCheckpointIds: ['cp-1'] },
        }
        await store.saveCheckpoint(checkpoint({ parent }))
        assert.deepEqual((await store.getCheckpoint('cp-1'))?.parent, parent)

        // A checkpoint without a parent stays parent-less (no null leaking in).
        await store.saveCheckpoint(checkpoint({ id: 'cp-2' }))
        assert.equal((await store.getCheckpoint('cp-2'))?.parent, undefined)

        // saveCheckpoint upserts the parent — runParallelSteps re-saves the
        // record after filling in sibling data.
        const updated = { ...parent, parallel: { ...parent.parallel, settledOutputs: ['A', 'B'] } }
        await store.saveCheckpoint(checkpoint({ parent: updated }))
        assert.deepEqual((await store.getCheckpoint('cp-1'))?.parent, updated)
      },
    },
    {
      name: 'round-trips a supervisor checkpoint\'s pending delegations',
      fn: async (store) => {
        await store.createSession({ id: 's' })
        const pending = [
          { toolCallId: 'call-1', childCheckpointId: 'cp-child-1', subAgentId: 'researcher' },
          { toolCallId: 'call-2', childCheckpointId: 'cp-child-2', subAgentId: 'writer' },
        ]
        await store.saveCheckpoint(checkpoint({ toolName: 'core_delegate', pending }))
        assert.deepEqual((await store.getCheckpoint('cp-1'))?.pending, pending)

        // Entries are removed as delegations resolve — the upsert must shrink
        // the list, and a checkpoint without pending stays pending-less.
        await store.saveCheckpoint(checkpoint({ toolName: 'core_delegate', pending: [pending[1]!] }))
        assert.deepEqual((await store.getCheckpoint('cp-1'))?.pending, [pending[1]])
        await store.saveCheckpoint(checkpoint({ id: 'cp-2' }))
        assert.equal((await store.getCheckpoint('cp-2'))?.pending, undefined)
      },
    },
    {
      name: 'lists checkpoints ordered by creation time',
      fn: async (store) => {
        await store.createSession({ id: 's' })
        await store.saveCheckpoint(checkpoint({ id: 'cp-old', createdAt: 1 }))
        await store.saveCheckpoint(checkpoint({ id: 'cp-new', createdAt: 2 }))
        const listed = await store.listCheckpoints()
        assert.deepEqual(
          listed.map((c) => c.id),
          ['cp-old', 'cp-new'],
        )
      },
    },
    {
      name: 'suspendRun persists the response messages and checkpoint together',
      fn: async (store) => {
        const s = await store.createSession({ id: 's' })
        await store.suspendRun(
          s.id,
          [{ role: 'assistant', content: 'thinking', timestamp: 1 }],
          checkpoint(),
        )
        const msgs = await store.getMessages(s.id)
        assert.equal(msgs.length, 1)
        assert.equal(msgs[0]?.role, 'assistant')
        assert.equal((await store.getCheckpoint('cp-1'))?.id, 'cp-1')
      },
    },
    {
      name: 'deleteSession cascades its checkpoints',
      fn: async (store) => {
        await store.createSession({ id: 's' })
        await store.createSession({ id: 'other' })
        await store.saveCheckpoint(checkpoint({ id: 'cp-s', sessionId: 's' }))
        await store.saveCheckpoint(checkpoint({ id: 'cp-other', sessionId: 'other' }))
        await store.deleteSession('s')
        assert.equal(await store.getCheckpoint('cp-s'), undefined)
        assert.equal((await store.getCheckpoint('cp-other'))?.id, 'cp-other')
      },
    },
    {
      name: 'cleanupSessions cascades checkpoints of the deleted sessions',
      fn: async (store) => {
        const old = await store.createSession()
        await store.saveCheckpoint(checkpoint({ id: 'cp-old', sessionId: old.id }))
        await sleep(30)
        const fresh = await store.createSession()
        await store.saveCheckpoint(checkpoint({ id: 'cp-fresh', sessionId: fresh.id }))
        const deleted = await store.cleanupSessions({ olderThanMs: 15 })
        assert.equal(deleted, 1)
        assert.equal(await store.getCheckpoint('cp-old'), undefined)
        assert.equal((await store.getCheckpoint('cp-fresh'))?.id, 'cp-fresh')
      },
    },
    // --- Loops ---------------------------------------------------------------
    {
      name: 'creates, patches and reads back a loop with its iterations',
      fn: async (store) => {
        const s = await store.createSession()
        await store.createLoop(loop(s.id))
        await store.addLoopIteration({
          id: 'it-1',
          loopId: 'loop-1',
          index: 1,
          input: { a: 1 },
          output: { b: 2 },
          startedAt: 1,
          completedAt: 2,
        })
        await store.updateLoop('loop-1', { status: 'completed', iterations: 1, result: 'done' })
        const got = await store.getLoop('loop-1')
        assert.equal(got?.loop.status, 'completed')
        assert.equal(got?.loop.iterations, 1)
        assert.equal(got?.iterations.length, 1)
      },
    },
    {
      name: 'filters listLoops by session and status',
      fn: async (store) => {
        const s = await store.createSession()
        await store.createLoop(loop(s.id, { id: 'loop-running' }))
        await store.createLoop(loop(s.id, { id: 'loop-done', status: 'completed' }))
        const running = await store.listLoops({ sessionId: s.id, status: 'running' })
        assert.deepEqual(
          running.map((l) => l.id),
          ['loop-running'],
        )
      },
    },
    // --- Optional features (runners skip these when the store lacks them) -----
    {
      name: 'knowledge graph: stores and queries nodes',
      requires: ['addKnowledgeNode', 'queryKnowledge'],
      fn: async (store) => {
        const node = await store.addKnowledgeNode!({
          agentId: 'a',
          sessionId: 's',
          label: 'Ada',
          data: { role: 'engineer' },
        })
        assert.ok(node.id)
        assert.ok((await store.queryKnowledge!({ agentId: 'a', query: 'Ada' })).length >= 1)
      },
    },
    {
      name: 'knowledge graph: links nodes with edges and forgets a node',
      requires: ['addKnowledgeNode', 'addKnowledgeEdge', 'queryKnowledge', 'forgetKnowledge'],
      fn: async (store) => {
        const ada = await store.addKnowledgeNode!({
          agentId: 'a',
          sessionId: 's',
          label: 'Ada',
          data: {},
        })
        const babbage = await store.addKnowledgeNode!({
          agentId: 'a',
          sessionId: 's',
          label: 'Babbage',
          data: {},
        })
        await store.addKnowledgeEdge!({ fromId: ada.id, toId: babbage.id, relation: 'knows' })

        assert.deepEqual(await store.forgetKnowledge!({ id: ada.id }), { deleted: true })
        assert.equal((await store.queryKnowledge!({ agentId: 'a', query: 'Ada' })).length, 0)
        // Forgetting an already-gone node reports it wasn't there.
        assert.deepEqual(await store.forgetKnowledge!({ id: ada.id }), { deleted: false })
        // The other endpoint survives.
        assert.equal((await store.queryKnowledge!({ agentId: 'a', query: 'Babbage' })).length, 1)
      },
    },
    {
      name: 'knowledge graph: knowledgeContext returns session-scoped nodes',
      requires: ['addKnowledgeNode', 'knowledgeContext'],
      fn: async (store) => {
        await store.addKnowledgeNode!({ agentId: 'a', sessionId: 's1', label: 'InS1', data: {} })
        await store.addKnowledgeNode!({ agentId: 'a', sessionId: 's2', label: 'InS2', data: {} })
        const ctx = await store.knowledgeContext!({ agentId: 'a', sessionId: 's1' })
        assert.deepEqual(
          ctx.map((n) => n.label),
          ['InS1'],
        )
      },
    },
    {
      name: 'documents: ingests and reads a document',
      requires: ['ingestDocument', 'readDocument'],
      fn: async (store) => {
        const doc = await store.ingestDocument!({
          agentId: 'a',
          title: 'Notes',
          content: 'hello world',
        })
        const read = await store.readDocument!({ agentId: 'a', id: doc.id })
        assert.ok(read?.content.includes('hello'))
      },
    },
    {
      name: 'documents: searchDocuments finds by content within the agent scope',
      requires: ['ingestDocument', 'searchDocuments'],
      fn: async (store) => {
        await store.ingestDocument!({ agentId: 'a', title: 'Alpha', content: 'hello world' })
        await store.ingestDocument!({ agentId: 'a', title: 'Beta', content: 'goodbye moon' })
        await store.ingestDocument!({ agentId: 'other', title: 'Gamma', content: 'hello world' })

        const hits = await store.searchDocuments!({ agentId: 'a', query: 'hello' })
        assert.deepEqual(
          hits.map((d) => d.title),
          ['Alpha'],
        )
        assert.ok(hits[0]?.id)
      },
    },
    // --- Task runs (audit; optional) -----------------------------------------
    {
      name: 'task runs: records, finishes and reads back a run',
      requires: ['createTaskRun', 'finishTaskRun', 'getTaskRun'],
      fn: async (store) => {
        await store.createTaskRun!(taskRun())
        await store.finishTaskRun!('tr-1', {
          status: 'completed',
          output: { entities: [{ name: 'Ada' }] },
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          durationMs: 42,
          completedAt: Date.now(),
        })
        const got = await store.getTaskRun!('tr-1')
        assert.equal(got?.status, 'completed')
        assert.equal(got?.taskId, 'extract')
        assert.deepEqual(got?.model, { provider: 'mock', model: 'm' })
        assert.deepEqual(got?.output, { entities: [{ name: 'Ada' }] })
        assert.equal(got?.usage?.totalTokens, 15)
        assert.equal(got?.durationMs, 42)
      },
    },
    {
      name: 'task runs: filters listTaskRuns by task and status',
      requires: ['createTaskRun', 'finishTaskRun', 'listTaskRuns'],
      fn: async (store) => {
        await store.createTaskRun!(taskRun({ id: 'tr-run', taskId: 'extract' }))
        await store.createTaskRun!(taskRun({ id: 'tr-done', taskId: 'extract' }))
        await store.createTaskRun!(taskRun({ id: 'tr-other', taskId: 'summarize' }))
        await store.finishTaskRun!('tr-done', { status: 'completed' })
        const completed = await store.listTaskRuns!({ taskId: 'extract', status: 'completed' })
        assert.deepEqual(
          completed.map((r) => r.id),
          ['tr-done'],
        )
        const summarize = await store.listTaskRuns!({ taskId: 'summarize' })
        assert.equal(summarize.length, 1)
      },
    },
    {
      name: 'task runs: listTaskRuns honours limit',
      requires: ['createTaskRun', 'listTaskRuns'],
      fn: async (store) => {
        await store.createTaskRun!(taskRun({ id: 'tr-1' }))
        await store.createTaskRun!(taskRun({ id: 'tr-2' }))
        await store.createTaskRun!(taskRun({ id: 'tr-3' }))
        const limited = await store.listTaskRuns!({ limit: 1 })
        assert.equal(limited.length, 1)
      },
    },
    // --- Crumb run-log (optional) ----------------------------------------------
    {
      name: 'crumb log: appends and reads back a run\'s entries in seq order',
      requires: CRUMB_METHODS,
      fn: async (store) => {
        await store.createSession({ id: 's' })
        await store.appendCrumbs!([crumbEntry('r1', 2), crumbEntry('r1', 1), crumbEntry('r1', 3)])
        const got = await store.getCrumbs!('r1')
        assert.deepEqual(
          got.map((e) => e.seq),
          [1, 2, 3],
        )
        const first = got[0]!
        assert.equal(first.runId, 'r1')
        assert.equal(first.sessionId, 's')
        assert.equal(first.agentId, 'a')
        assert.equal(first.type, 'text:delta')
        assert.deepEqual(first.crumb, crumbEntry('r1', 1).crumb)
        assert.ok(first.createdAt > 0)
      },
    },
    {
      name: 'crumb log: getCrumbs honours afterSeq and limit',
      requires: CRUMB_METHODS,
      fn: async (store) => {
        await store.createSession({ id: 's' })
        await store.appendCrumbs!([1, 2, 3, 4, 5].map((n) => crumbEntry('r1', n)))
        assert.deepEqual(
          (await store.getCrumbs!('r1', { afterSeq: 2 })).map((e) => e.seq),
          [3, 4, 5],
        )
        assert.deepEqual(
          (await store.getCrumbs!('r1', { afterSeq: 1, limit: 2 })).map((e) => e.seq),
          [2, 3],
        )
      },
    },
    {
      name: 'crumb log: isolates runs from each other',
      requires: CRUMB_METHODS,
      fn: async (store) => {
        await store.createSession({ id: 's' })
        await store.appendCrumbs!([crumbEntry('r1', 1), crumbEntry('r2', 1), crumbEntry('r2', 2)])
        assert.equal((await store.getCrumbs!('r1')).length, 1)
        assert.equal((await store.getCrumbs!('r2')).length, 2)
      },
    },
    {
      name: 'crumb log: getMaxCrumbSeq is 0 for an unknown run, the max otherwise',
      requires: CRUMB_METHODS,
      fn: async (store) => {
        assert.equal(await store.getMaxCrumbSeq!('nope'), 0)
        await store.createSession({ id: 's' })
        await store.appendCrumbs!([crumbEntry('r1', 1), crumbEntry('r1', 7)])
        assert.equal(await store.getMaxCrumbSeq!('r1'), 7)
      },
    },
    {
      name: 'crumb log: permits entries with no session anchor',
      requires: CRUMB_METHODS,
      fn: async (store) => {
        await store.appendCrumbs!([crumbEntry('r1', 1, { sessionId: undefined })])
        const got = await store.getCrumbs!('r1')
        assert.equal(got.length, 1)
        assert.equal(got[0]!.sessionId, undefined)
      },
    },
    {
      name: 'crumb log: deleteSession cascades the session\'s crumbs',
      requires: CRUMB_METHODS,
      fn: async (store) => {
        await store.createSession({ id: 's' })
        await store.createSession({ id: 'other' })
        await store.appendCrumbs!([
          crumbEntry('r1', 1),
          crumbEntry('r2', 1, { sessionId: 'other' }),
        ])
        await store.deleteSession('s')
        assert.equal((await store.getCrumbs!('r1')).length, 0)
        assert.equal((await store.getCrumbs!('r2')).length, 1)
      },
    },
    {
      name: 'crumb log: cleanupSessions cascades crumbs of the deleted sessions',
      requires: CRUMB_METHODS,
      fn: async (store) => {
        const old = await store.createSession()
        await store.addMessage(old.id, { role: 'user', content: 'x', timestamp: Date.now() })
        await store.appendCrumbs!([crumbEntry('r1', 1, { sessionId: old.id })])
        await sleep(30)
        const fresh = await store.createSession()
        await store.appendCrumbs!([crumbEntry('r2', 1, { sessionId: fresh.id })])
        const deleted = await store.cleanupSessions({ olderThanMs: 15 })
        assert.equal(deleted, 1)
        assert.equal((await store.getCrumbs!('r1')).length, 0)
        assert.equal((await store.getCrumbs!('r2')).length, 1)
      },
    },
  ]
}

/**
 * Registers the contract with `bun:test`. Per case: `makeStore()` (+ `migrate`)
 * builds a fresh store, the case runs, then the store is closed and `opts.reset`
 * (e.g. pglite TRUNCATE) clears a persistent backend. Fresh in-memory stores
 * need no reset.
 */
/** The `requires` methods a store instance is missing, empty when supported. */
export function missingStoreFeatures(store: BreadStore, c: StoreCase): string[] {
  return (c.requires ?? []).filter(
    (m) => typeof (store as unknown as Record<string, unknown>)[m] !== 'function',
  )
}

export function runStoreContract(
  name: string,
  makeStore: () => BreadStore,
  opts: { reset?: () => Promise<void> } = {},
): void {
  // Lazy require so importing this module under node:test (no bun:test) is safe.
  const { describe, test, beforeEach, afterEach } = require('bun:test') as typeof import('bun:test')

  // A throwaway instance answers "which optional methods exist" at registration
  // time, so unsupported cases register as *skipped* — visible in the run
  // output — rather than silently passing on their early-return.
  let probe: BreadStore | null = null
  try {
    probe = makeStore()
    Promise.resolve(probe.close?.()).catch(() => {})
  } catch {
    // Some stores can't construct at registration time (postgres: the pglite
    // URL only exists after the suite's beforeAll). Without a probe, skip
    // detection is unavailable and every case registers normally.
  }

  describe(`BreadStore contract: ${name}`, () => {
    let store: BreadStore
    beforeEach(async () => {
      store = makeStore()
      await store.migrate?.()
    })
    afterEach(async () => {
      await store.close?.()
      if (opts.reset) await opts.reset()
    })
    for (const c of storeContractCases()) {
      const missing = probe ? missingStoreFeatures(probe, c) : []
      if (missing.length > 0) {
        test.skip(`${c.name} (store lacks ${missing.join(', ')})`, () => {})
      } else {
        test(c.name, () => c.fn(store))
      }
    }
  })
}
