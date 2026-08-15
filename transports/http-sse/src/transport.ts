import type { Hono } from 'hono'
import { stream as honoStream } from 'hono/streaming'
import type { AuthIdentity, BreadCrumb, BreadInstance, BreadTransport, BusFrame } from '@breadai/core'
import { fromWireCrumb, streamTransport } from '@breadai/core'
import { type SseEvent, toClientError, toSseEvent, writeSseEvent } from './sse.js'

export interface TransportOptions {
  // Opt-in authorization for the passive GET /runs/:runId/stream route only —
  // absent, the route behaves exactly as before (see SEC-03 audit). Identity
  // comes from whatever authMiddleware/authPlugin stashed via c.set('identity').
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

function streamRun(
  c: { header(k: string, v: string): void },
  makeGen: (signal: AbortSignal) => AsyncIterable<BreadCrumb>,
) {
  return honoStream(c as never, async (s) => {
    // Ties a client disconnect (or the client's own explicit cancel, relayed
    // the same way) to the underlying bread.run()/runPipeline()/resume()
    // call — without this, the agent keeps computing after the client is gone.
    const controller = new AbortController()
    s.onAbort(() => controller.abort())
    for await (const event of runToSseEvents(() => makeGen(controller.signal))) {
      await writeSseEvent(s, event)
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
      const honoApp = app as Hono

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

        c.header('Content-Type', 'text/event-stream')
        c.header('Cache-Control', 'no-cache')
        c.header('Connection', 'keep-alive')

        return streamRun(
          c,
          (signal) =>
            bread.run(id, input ?? {}, {
              ...(session ? { session } : {}),
              ...(skill ? { skill } : {}),
              signal,
            }) as AsyncIterable<BreadCrumb>,
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

        c.header('Content-Type', 'text/event-stream')
        c.header('Cache-Control', 'no-cache')
        c.header('Connection', 'keep-alive')

        return streamRun(c, (signal) =>
          bread.runPipeline(pipelineId, (body as { input?: unknown }).input ?? {}, { signal }),
        )
      })

      honoApp.post('/resume/:checkpointId', async (c) => {
        const checkpointId = c.req.param('checkpointId')
        let body: Record<string, unknown> = {}
        try {
          body = await c.req.json()
        } catch {
          // no body — resume with an undefined response
        }

        c.header('Content-Type', 'text/event-stream')
        c.header('Cache-Control', 'no-cache')
        c.header('Connection', 'keep-alive')

        return streamRun(c, (signal) => bread.resume(checkpointId, (body as { response?: unknown }).response, { signal }))
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

        if (opts.authorizeStream) {
          const identity = c.get('identity' as never) as AuthIdentity | undefined
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
