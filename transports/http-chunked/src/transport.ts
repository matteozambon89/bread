import type { Hono } from 'hono'
import { stream as honoStream } from 'hono/streaming'
import type { AgentErrorCrumb, AuthIdentity, BreadCrumb, BreadInstance, BreadTransport, BusFrame } from '@bread/core'
import { BreadError, fromWireCrumb, streamTransport } from '@bread/core'
import { crumbFrameLine } from './protocol-io.js'

export interface TransportOptions {
  // Opt-in authorization for the passive GET /runs/:runId/stream route only —
  // absent, the route behaves exactly as before (see SEC-03 audit). Identity
  // comes from whatever authMiddleware/authPlugin stashed via c.set('identity').
  authorizeStream?(identity: AuthIdentity | undefined, runId: string): Promise<boolean> | boolean
}

// Keep-alive interval for the passive run stream — comfortably under common
// LB/proxy idle timeouts (30-60s). A blank NDJSON line is a harmless no-op
// for any reader that skips empty lines (see remote-agent.ts's parser).
const HEARTBEAT_MS = 15_000

// What an HTTP client may see of an error: code + message only. Stack, cause,
// and context stay server-side.
function toClientError(err: unknown): BreadError {
  if (err instanceof BreadError) return err
  return new BreadError('Internal server error', 'INTERNAL_ERROR')
}

// Streams one crumb generator as NDJSON, same shape for the run/resume/
// pipeline-run routes. `makeGen` is called *inside* the try block: some
// BreadInstance calls (e.g. runPipeline's PIPELINE_NOT_FOUND) throw
// synchronously rather than lazily on first iteration, and mount() has no
// private config access to pre-validate like server.ts's SSE routes do (no
// `bread.pipelines` getter) — so both eager and lazy failures land the same
// way: a synthetic agent:error crumb in the stream (HTTP status stays 200),
// never a torn-down connection.
async function streamCrumbs(
  s: { write(chunk: string): Promise<unknown>; onAbort(cb: () => void): void },
  makeGen: (signal: AbortSignal) => AsyncIterable<BreadCrumb>,
  fallbackAgentId: string,
): Promise<void> {
  // Ties a client disconnect (or the client's own explicit cancel, relayed
  // the same way) to the underlying bread.run()/runPipeline()/resume() call —
  // without this, the agent keeps computing after every client is gone.
  const controller = new AbortController()
  s.onAbort(() => controller.abort())

  let lastAgentId = fallbackAgentId
  let lastRunId: string | undefined
  try {
    for await (const crumb of makeGen(controller.signal)) {
      lastAgentId = crumb.agentId
      if (crumb.runId) lastRunId = crumb.runId
      await s.write(crumbFrameLine(crumb.runId ?? lastRunId ?? '', crumb.seq ?? 0, crumb))
    }
  } catch (err) {
    console.error('[bread] transport-http-chunked: run failed:', err)
    const errorCrumb: AgentErrorCrumb = {
      type: 'agent:error',
      agentId: lastAgentId,
      ...(lastRunId ? { runId: lastRunId } : {}),
      error: toClientError(err),
      timestamp: Date.now(),
    }
    await s.write(crumbFrameLine(lastRunId ?? '', 0, errorCrumb))
  }
}

// In-memory pub/sub + bounded replay (same shape as the embedded
// streamTransport()) plus mount(): the four routes server.ts used to
// hand-roll, reimplemented generically against the public BreadInstance
// surface (run/resume/runPipeline/store.getCrumbs/transport.subscribe) and
// wire-encoded via the Bread protocol's NDJSON CrumbFrame instead of SSE.
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

        c.header('Content-Type', 'application/x-ndjson')
        return honoStream(c, (s) =>
          streamCrumbs(
            s,
            (signal) =>
              bread.run(id, input ?? {}, {
                ...(session ? { session } : {}),
                ...(skill ? { skill } : {}),
                signal,
              }) as AsyncIterable<BreadCrumb>,
            id,
          ),
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

        c.header('Content-Type', 'application/x-ndjson')
        return honoStream(c, (s) =>
          streamCrumbs(
            s,
            (signal) => bread.runPipeline(pipelineId, (body as { input?: unknown }).input ?? {}, { signal }),
            pipelineId,
          ),
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

        c.header('Content-Type', 'application/x-ndjson')
        return honoStream(c, (s) =>
          streamCrumbs(
            s,
            (signal) => bread.resume(checkpointId, (body as { response?: unknown }).response, { signal }),
            checkpointId,
          ),
        )
      })

      // Passive run stream — tails a run without initiating it, from any
      // replica sharing this store + transport. Mechanically the same
      // replay-then-live logic as server.ts's SSE version, re-encoded as
      // NDJSON. See server.ts's own comment for the full rationale.
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

        c.header('Content-Type', 'application/x-ndjson')

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
            let replayedMax = after
            let terminal = !bread.transport.subscribe

            if (bread.store.getCrumbs) {
              for (const entry of await bread.store.getCrumbs(runId, { afterSeq: after })) {
                const crumb = fromWireCrumb(entry.crumb as BreadCrumb)
                if (bread.crumbFilter && !bread.crumbFilter(crumb)) continue
                await s.write(crumbFrameLine(runId, entry.seq, crumb))
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
                await s.write(crumbFrameLine(runId, frame.seq, fromWireCrumb(frame.crumb)))
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
              if (!gotFrame && !s.aborted) await s.write('\n')
            }
          } finally {
            unsub()
          }
        })
      })
    },
  }
}
