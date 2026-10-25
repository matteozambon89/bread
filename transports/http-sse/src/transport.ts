import type { Hono } from 'hono'
import { stream as honoStream } from 'hono/streaming'
import type { AuthIdentity, BreadCrumb, BreadInstance, BreadTransport, BusFrame, Principal } from '@breadai/core'
import { fromWireCrumb, HTTP_ACTIONS, principalOrLocalCli, registerHttpRoute, resumeVisible, runVisible, streamTransport } from '@breadai/core'
import { type SseEvent, toClientError, toSseEvent, writeSseEvent } from './sse.js'

// The live owner: the principal the run was started or resumed under.
type CancelRegistry = Map<string, { controller: AbortController; principal: Principal | undefined }>

export interface TransportOptions {
  // Extra check on the run stream and on cancel, after the HTTP grant and
  // the run-owner check. Identity is whatever auth stored.
  authorizeStream?(identity: AuthIdentity | undefined, runId: string): Promise<boolean> | boolean
}

// Keep-alive comment interval for passive run streams — comfortably under
// common LB/proxy idle timeouts (30-60s). Relocated verbatim from server.ts.
const HEARTBEAT_MS = 15_000

// `makeGen` is called *inside* the try block (generator functions don't run
// their body until iterated, so this stays lazy): some BreadInstance calls
// (e.g. runPipeline's PIPELINE_NOT_FOUND) throw synchronously rather than
// lazily on first iteration, and mount() has no private config access to
// pre-validate like server.ts's original routes did (no `bread.pipelines`
// getter) — so both eager and lazy failures land the same way: an SSE
// `error` event, never a torn-down connection.
async function* runToSseEvents(makeGen: () => AsyncIterable<BreadCrumb>): AsyncIterable<SseEvent> {
  try {
    for await (const crumb of makeGen()) {
      yield toSseEvent(crumb)
    }
  } catch (err) {
    console.error('[bread] transport-http-sse: run failed:', err)
    yield { type: 'error', payload: toClientError(err) }
  }
}

// A client disconnect does NOT cancel the run — a dropped connection and a
// deliberate cancel are indistinguishable at the HTTP layer, and conflating
// them defeats remote-agent.ts's own reconnect logic. Only an explicit
// POST /runs/:runId/cancel (see cancelRegistry below) aborts the signal; a
// disconnect just stops writing into a pipe nobody's reading, while the run
// keeps being pulled forward and persisted through bread.ts's choke point
// regardless.
function streamRun(
  c: { header(k: string, v: string): void },
  makeGen: (signal: AbortSignal) => AsyncIterable<BreadCrumb>,
  cancelRegistry: CancelRegistry,
  principal: Principal | undefined,
) {
  return honoStream(c as never, async (s) => {
    const controller = new AbortController()
    let disconnected = false
    s.onAbort(() => {
      disconnected = true
    })
    // Every runId this stream carried: a pipeline or supervisor stream
    // interleaves many. All of them leave the registry when the stream ends,
    // or a stale entry would keep deciding who owns that id.
    const registered = new Set<string>()
    try {
      for await (const event of runToSseEvents(() => makeGen(controller.signal))) {
        const eventRunId = (event.payload as { runId?: string } | undefined)?.runId
        if (eventRunId && !registered.has(eventRunId)) {
          registered.add(eventRunId)
          cancelRegistry.set(eventRunId, { controller, principal })
        }
        if (!disconnected) await writeSseEvent(s, event)
      }
    } finally {
      for (const runId of registered) {
        if (cancelRegistry.get(runId)?.controller === controller) cancelRegistry.delete(runId)
      }
    }
  })
}

// In-memory pub/sub + bounded replay (same shape as the embedded
// streamTransport()) plus mount(): the four routes server.ts used to
// hand-roll, reimplemented generically against the public BreadInstance
// surface (run/resume/runPipeline/store.getCrumbs/transport.subscribe).
// Wire-compatible relocation of today's SSE format — not a redesign.
export function transport(opts: TransportOptions = {}): BreadTransport {
  const base = streamTransport()

  return {
    ...base,

    mount(app: unknown, bread: BreadInstance): void {
      const honoApp = app as Hono<{ Variables: { identity: AuthIdentity } }>
      // Scoped to this mount()/replica — same in-process-only precedent as
      // @breadai/protocol-a2a-server's tasks/cancel registry (docs/a2a.md).
      // A cancel routed to a different replica than the one running it 404s;
      // see docs/transports.md's known-gap note.
      const cancelRegistry: CancelRegistry = new Map()

      registerHttpRoute(honoApp, { method: 'POST', path: '/agents/:id/run', action: HTTP_ACTIONS.runStart })
      registerHttpRoute(honoApp, { method: 'POST', path: '/pipelines/:id/run', action: HTTP_ACTIONS.pipelineStart })
      registerHttpRoute(honoApp, { method: 'POST', path: '/resume/:checkpointId', action: HTTP_ACTIONS.runResume })
      registerHttpRoute(honoApp, { method: 'POST', path: '/runs/:runId/cancel', action: HTTP_ACTIONS.runCancel })
      registerHttpRoute(honoApp, { method: 'GET', path: '/runs/:runId/stream', action: HTTP_ACTIONS.runStream })

      honoApp.post('/agents/:id/run', async (c) => {
        const id = c.req.param('id')
        let body: Record<string, unknown> = {}
        try {
          body = await c.req.json()
        } catch {
          // no body — run with no input
        }
        const { input, session, skill } = body as {
          input?: unknown
          session?: { id?: string; tags?: Record<string, string> }
          skill?: string
        }
        const principal = principalOrLocalCli(c.get('identity')?.principal)

        c.header('Content-Type', 'text/event-stream')
        c.header('Cache-Control', 'no-cache')
        c.header('Connection', 'keep-alive')

        return streamRun(
          c,
          (signal) =>
            bread.run(id, input ?? {}, {
              ...(session ? { session } : {}),
              ...(skill ? { skill } : {}),
              principal,
              signal,
            }) as AsyncIterable<BreadCrumb>,
          cancelRegistry,
          principal,
        )
      })

      honoApp.post('/pipelines/:id/run', async (c) => {
        const pipelineId = c.req.param('id')
        let body: Record<string, unknown> = {}
        try {
          body = await c.req.json()
        } catch {
          // no body — run with no input
        }
        const principal = principalOrLocalCli(c.get('identity')?.principal)

        c.header('Content-Type', 'text/event-stream')
        c.header('Cache-Control', 'no-cache')
        c.header('Connection', 'keep-alive')

        return streamRun(
          c,
          (signal) =>
            bread.runPipeline(pipelineId, (body as { input?: unknown }).input ?? {}, {
              signal,
              principal,
            }),
          cancelRegistry,
          principal,
        )
      })

      honoApp.post('/resume/:checkpointId', async (c) => {
        const checkpointId = c.req.param('checkpointId')
        // Loaded even for an unscoped caller: its principal owns the resumed run's cancel.
        const checkpoint = await bread.store.getCheckpoint(checkpointId)
        if (!(await resumeVisible(bread.store, checkpoint, c.get('identity')?.principal, checkpoint ? cancelRegistry.get(checkpoint.runId) : undefined))) {
          return c.json({ error: 'Checkpoint not found' }, 404)
        }
        let body: Record<string, unknown> = {}
        try {
          body = await c.req.json()
        } catch {
          // no body — resume with an undefined response
        }

        c.header('Content-Type', 'text/event-stream')
        c.header('Cache-Control', 'no-cache')
        c.header('Connection', 'keep-alive')

        return streamRun(
          c,
          (signal) => bread.resume(checkpointId, (body as { response?: unknown }).response, { signal }),
          cancelRegistry,
          checkpoint?.principal,
        )
      })

      // Explicit cancel — the only thing that stops a run server-side. Gated
      // by the same authorizeStream hook as the passive tail below: it's now
      // protecting a mutating action, not just a read.
      honoApp.post('/runs/:runId/cancel', async (c) => {
        const runId = c.req.param('runId')

        // A run the caller does not own answers like an unknown run, so the
        // status does not reveal which run ids exist.
        const entry = cancelRegistry.get(runId)
        if (!entry || !(await runVisible(bread.store, runId, c.get('identity')?.principal, entry))) {
          return c.json({ error: 'Run not found or not cancelable' }, 404)
        }

        if (opts.authorizeStream) {
          const identity = c.get('identity')
          if (!(await opts.authorizeStream(identity, runId))) {
            return c.json({ error: 'Forbidden' }, 403)
          }
        }

        entry.controller.abort()
        cancelRegistry.delete(runId)
        return c.json({ ok: true })
      })

      // Passive run stream — tails a run without initiating it, from any
      // replica sharing this store + transport. Relocated verbatim from
      // server.ts (see its own comment for the full catch-up/dedup rationale).
      honoApp.get('/runs/:runId/stream', async (c) => {
        const runId = c.req.param('runId')
        const rawAfter = c.req.header('Last-Event-ID') ?? c.req.query('after') ?? '0'
        const after = Number(rawAfter)
        if (!Number.isFinite(after) || after < 0) {
          return c.json({ error: `Invalid Last-Event-ID / after: "${rawAfter}"` }, 400)
        }

        // Checked before any header is sent. Not found and not yours are one answer.
        const caller = c.get('identity')?.principal
        if (!(await runVisible(bread.store, runId, caller, cancelRegistry.get(runId)))) {
          return c.json({ error: 'Run not found' }, 404)
        }

        if (opts.authorizeStream) {
          const identity = c.get('identity')
          if (!(await opts.authorizeStream(identity, runId))) {
            return c.json({ error: 'Forbidden' }, 403)
          }
        }

        c.header('Content-Type', 'text/event-stream')
        c.header('Cache-Control', 'no-cache')
        c.header('Connection', 'keep-alive')

        const isTerminal = (type: string) => type === 'agent:run:end' || type === 'agent:error'

        return honoStream(c, async (s) => {
          const pending: BusFrame[] = []
          let wake: (() => void) | null = null
          const unsub =
            bread.transport.subscribe?.(runId, Number.MAX_SAFE_INTEGER, (frame) => {
              pending.push(frame)
              wake?.()
              wake = null
            }) ?? (() => {})
          s.onAbort(() => {
            wake?.()
            wake = null
          })

          try {
            await s.write('retry: 3000\n\n')

            let replayedMax = after
            let terminal = !bread.transport.subscribe

            if (bread.store.getCrumbs) {
              for (const entry of await bread.store.getCrumbs(runId, { afterSeq: after })) {
                const crumb = fromWireCrumb(entry.crumb as BreadCrumb)
                if (bread.crumbFilter && !bread.crumbFilter(crumb)) continue
                await writeSseEvent(s, toSseEvent({ ...crumb, seq: entry.seq }))
                replayedMax = Math.max(replayedMax, entry.seq)
                if (isTerminal(entry.type)) terminal = true
              }
            }

            while (!terminal && !s.aborted) {
              while (pending.length > 0) {
                const frame = pending.shift()!
                const isDelta = frame.crumb.type === 'text:delta' || frame.crumb.type === 'reasoning:delta'
                if (isDelta ? frame.seq < replayedMax : frame.seq <= replayedMax) continue
                if (!isDelta) replayedMax = frame.seq
                await writeSseEvent(s, toSseEvent(fromWireCrumb(frame.crumb)))
                if (isTerminal(frame.crumb.type)) {
                  terminal = true
                  break
                }
              }
              if (terminal || s.aborted) break

              const gotFrame = await new Promise<boolean>((resolve) => {
                const timer = setTimeout(() => {
                  wake = null
                  resolve(false)
                }, HEARTBEAT_MS)
                timer.unref?.()
                wake = () => {
                  clearTimeout(timer)
                  resolve(true)
                }
              })
              if (!gotFrame && !s.aborted) await s.write(': ping\n\n')
            }
          } finally {
            unsub()
          }
        })
      })
    },
  }
}
