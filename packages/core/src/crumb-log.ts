import { toWireCrumb } from './transport.js'
import type { BreadStore, CrumbLogEntry } from './storage/store.js'
import type { BreadCrumb } from './types.js'

// The crumb types that stream as many small deltas and get buffered into one
// aggregated log entry instead of one store write per chunk (text:delta and
// reasoning:delta are structurally identical — separate content channels, not
// separate shapes — so they share the same windowing, one window each).
//
// ponytail: tool:input:delta is deliberately NOT included, even though it's
// also a streamed-delta crumb — DeltaWindow below is keyed per crumb type
// only (one window per run), which is safe for text/reasoning because a run
// never has two messages open at once, but a model making parallel tool
// calls streams multiple tool:input:delta sequences concurrently (one per
// toolCallId); naively sharing one window would interleave and corrupt
// different tool calls' JSON fragments. It falls through to the existing
// non-delta path instead (one store write per chunk — safe, just less
// batched). Upgrade path if that write volume ever matters: key windows by
// `${type}:${toolCallId}` instead of bare type.
type DeltaCrumbType = 'text:delta' | 'reasoning:delta'
type DeltaCrumb = Extract<BreadCrumb, { type: DeltaCrumbType }>

function isDeltaCrumb(crumb: BreadCrumb): crumb is DeltaCrumb {
  return crumb.type === 'text:delta' || crumb.type === 'reasoning:delta'
}

// Per-stream crumb sequencer + durable-log writer, owned by the instance choke
// point (bread.ts `instrument`). One writer instruments one public stream; a
// stream can interleave several runs (supervisor children, pipeline steps), so
// all state is per runId.
//
// Sequencing: non-delta crumbs take `++counter`; delta crumbs (text:delta,
// reasoning:delta) carry the watermark (the current counter) and are buffered
// into a per-type window that flushes as ONE aggregated entry of that type —
// consuming its own `++counter` — on a non-delta boundary, `maxBufferBytes` of
// text, `maxBufferMs` of age, or stream end. Replayed aggregates are ordinary
// (larger) delta crumbs.
//
// Persistence is best-effort: writes go through an ordered per-run chain, and
// the first failure disables logging for that run with a single warning — a
// store write must never fail a run. `pipeline:step:*` crumbs are sequenced
// but never persisted (no session anchor to cascade deletion from).

export interface CrumbLogWriterOptions {
  store: BreadStore | null
  maxBufferBytes?: number
  maxBufferMs?: number
}

// Tags a crumb relayed from a remote agent (runner.ts's `runAgent`) so this
// writer skips persistence for it — the remote replica owns that run's
// storage, and its runId/sessionId don't exist in the local store (would
// otherwise hit the crumbs->sessions FK and get silently disabled).
export const RELAYED = Symbol('bread.relayed')

export interface CrumbLogWriter {
  // Assigns the crumb's seq (a copy is returned; crumbs without a runId pass
  // through untouched) and enqueues durable-log writes.
  process(crumb: BreadCrumb): Promise<BreadCrumb>
  // Flushes open delta windows and awaits pending writes. Call at stream end.
  finalize(): Promise<void>
}

interface DeltaWindow {
  agentId: string
  sessionId: string
  delta: string
  bytes: number
  timestamp: number
  timer: ReturnType<typeof setTimeout> | null
}

interface RunState {
  counter: number
  windows: Map<DeltaCrumbType, DeltaWindow>
  chain: Promise<void>
  disabled: boolean
  relayed: boolean
}

function isLogged(type: string): boolean {
  return type !== 'pipeline:step:start' && type !== 'pipeline:step:end'
}

export function createCrumbLogWriter(opts: CrumbLogWriterOptions): CrumbLogWriter {
  const { store } = opts
  const maxBufferBytes = opts.maxBufferBytes ?? 4096
  const maxBufferMs = opts.maxBufferMs ?? 1000
  const supported = Boolean(store?.appendCrumbs && store.getCrumbs && store.getMaxCrumbSeq)
  const runs = new Map<string, RunState>()

  function disable(run: RunState, runId: string, err: unknown): void {
    if (run.disabled) return
    run.disabled = true
    console.warn(`[bread] crumb log disabled for run ${runId} (store write failed):`, err)
  }

  function enqueue(run: RunState, runId: string, entry: CrumbLogEntry): void {
    if (!supported || run.disabled || run.relayed) return
    run.chain = run.chain
      .then(() => store!.appendCrumbs!([entry]))
      .catch((err) => disable(run, runId, err))
  }

  async function getRun(runId: string, relayed: boolean): Promise<RunState> {
    const existing = runs.get(runId)
    if (existing) return existing
    const run: RunState = {
      counter: 0,
      windows: new Map(),
      chain: Promise.resolve(),
      disabled: false,
      relayed,
    }
    runs.set(runId, run)
    if (supported && !relayed) {
      // Seed from the durable log so a resumed run's continuation extends the
      // original numbering (fresh runIds are UUIDs — this returns 0 for them).
      // Skipped for relayed runs: the runId is foreign, nothing local to seed.
      try {
        run.counter = await store!.getMaxCrumbSeq!(runId)
      } catch (err) {
        disable(run, runId, err)
      }
    }
    return run
  }

  function flushWindow(run: RunState, runId: string, type: DeltaCrumbType): void {
    const w = run.windows.get(type)
    if (!w) return
    if (w.timer) clearTimeout(w.timer)
    run.windows.delete(type)
    const seq = ++run.counter
    const aggregate: BreadCrumb = {
      type,
      agentId: w.agentId,
      runId,
      sessionId: w.sessionId,
      timestamp: w.timestamp,
      delta: w.delta,
      seq,
    } as BreadCrumb
    enqueue(run, runId, {
      runId,
      seq,
      sessionId: w.sessionId,
      agentId: w.agentId,
      type,
      crumb: aggregate,
      createdAt: Date.now(),
    })
  }

  function flushAllWindows(run: RunState, runId: string): void {
    for (const type of [...run.windows.keys()]) flushWindow(run, runId, type)
  }

  return {
    async process(crumb: BreadCrumb): Promise<BreadCrumb> {
      const runId = (crumb as { runId?: string }).runId
      if (runId === undefined) return crumb
      const relayed = (crumb as { [RELAYED]?: boolean })[RELAYED] === true
      const run = await getRun(runId, relayed)

      if (isDeltaCrumb(crumb)) {
        const type = crumb.type
        const withSeq: BreadCrumb = { ...crumb, seq: run.counter }
        if (supported && !run.disabled) {
          let w = run.windows.get(type)
          if (!w) {
            w = {
              agentId: crumb.agentId,
              sessionId: crumb.sessionId,
              delta: '',
              bytes: 0,
              timestamp: crumb.timestamp,
              timer: null,
            }
            w.timer = setTimeout(() => flushWindow(run, runId, type), maxBufferMs)
            w.timer.unref?.()
            run.windows.set(type, w)
          }
          w.delta += crumb.delta
          w.bytes += crumb.delta.length
          if (w.bytes >= maxBufferBytes) flushWindow(run, runId, type)
        }
        return withSeq
      }

      // Non-delta: close any open windows first, then the crumb takes its own seq.
      flushAllWindows(run, runId)
      const seq = ++run.counter
      const withSeq: BreadCrumb = { ...crumb, seq }
      if (isLogged(crumb.type)) {
        const sessionId = (crumb as { sessionId?: string }).sessionId
        const agentId = (crumb as { agentId?: string }).agentId
        enqueue(run, runId, {
          runId,
          seq,
          sessionId,
          agentId,
          type: crumb.type,
          crumb: toWireCrumb(withSeq),
          createdAt: Date.now(),
        })
      }
      return withSeq
    },

    async finalize(): Promise<void> {
      for (const [runId, run] of runs) flushAllWindows(run, runId)
      await Promise.all([...runs.values()].map((run) => run.chain))
    },
  }
}
