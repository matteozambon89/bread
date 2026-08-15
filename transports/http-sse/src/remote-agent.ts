import type { BreadCrumb, BreadSigner, RemoteAgent, RunOptions } from '@bread/core'
import { BreadError, fromWireCrumb } from '@bread/core'

export interface HttpSseRemoteAgentOptions {
  url: string
  headers?: Record<string, string>
  signer?: BreadSigner
  /** Override for testing — defaults to the global fetch. */
  fetch?: typeof fetch
  /** Bounded reconnect attempts after an abnormal drop. Default 5. */
  maxRetries?: number
  /** Backoff before the first retry, doubling each attempt. Default 500ms. */
  retryDelayMs?: number
}

function isTerminalCrumb(crumb: BreadCrumb): boolean {
  return crumb.type === 'agent:run:end' || crumb.type === 'agent:error'
}

// Signal-aware, like @bread/core's retry.ts sleep — duplicated rather than
// imported, since this package deliberately has no runtime deps beyond
// @bread/core.
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

// RemoteAgent over HTTP (SSE) — connects to another bread instance's
// mount()-ed /agents/:id/run and relays its crumb stream. Register directly
// in bread.config.ts:
//   remoteAgents: { researcher: remoteAgent({ url: 'http://remote:3000' }) }
export function remoteAgent(opts: HttpSseRemoteAgentOptions): RemoteAgent {
  const doFetch = opts.fetch ?? fetch
  const baseUrl = opts.url.replace(/\/$/, '')
  const maxRetries = opts.maxRetries ?? 5
  const retryDelayMs = opts.retryDelayMs ?? 500

  // One connection attempt: fetch + decode SSE `data:` lines into crumbs. A
  // non-ok status or empty body is a definitive rejection (thrown as-is,
  // never retried). So is the synthetic `type: 'error'` sidecar event
  // (transport.ts's runToSseEvents yields this when the run fails before —
  // or without ever — emitting a crumb, e.g. an unknown agent id; a run that
  // fails *after* emitting crumbs already gets a proper agent:error crumb,
  // which the caller's terminal-crumb check below handles before this
  // sidecar is ever reached) — reconstructed into a real BreadError and
  // thrown, since it's a deterministic server-side rejection, not a drop.
  // Anything else that goes wrong (a thrown network/read error, or the
  // stream just ending) is left for the caller to detect via the absence of
  // a terminal crumb — that's what makes it a "drop" and not a normal finish.
  async function* streamAttempt(url: string, init: RequestInit): AsyncGenerator<BreadCrumb> {
    const res = await doFetch(url, init)

    if (!res.ok) {
      throw new BreadError(
        `Remote agent request failed: ${res.status} ${res.statusText}`,
        'REMOTE_AGENT_ERROR',
        { url, status: res.status },
      )
    }
    if (!res.body) {
      throw new BreadError('Remote agent returned empty body', 'REMOTE_AGENT_ERROR', { url })
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        // Only data: lines carry crumbs; id:/retry:/comment lines are the
        // remote's SSE bookkeeping and are skipped (crumbs carry their own seq).
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const json = line.slice(6).trim()
          if (!json) continue
          try {
            const event = JSON.parse(json) as { type: string; payload: unknown }
            if (event.type === 'error') {
              const { code, message } = event.payload as { code: string; message: string }
              throw new BreadError(message, code, { url })
            }
            // sse.ts's toSseEvent sanitizes error crumbs to a plain
            // { code, message } — fromWireCrumb reconstructs a real
            // BreadError from that same shape, so instanceof checks behave
            // the same here as for a local bread.on('crumb') listener.
            yield fromWireCrumb(event.payload as BreadCrumb)
          } catch (err) {
            if (err instanceof BreadError) throw err // the reconstructed sidecar — a definitive signal
            // malformed SSE line — skip
          }
        }
      }
    } finally {
      reader.releaseLock()
    }
  }

  return {
    async *run(agentId: string, input: unknown, runOpts?: RunOptions): AsyncIterable<BreadCrumb> {
      let runId: string | undefined
      let lastSeq = 0
      let attempt = 0
      let delay = retryDelayMs

      while (true) {
        const url = runId ? `${baseUrl}/runs/${runId}/stream` : `${baseUrl}/agents/${agentId}/run`
        const headers = new Headers({ Accept: 'text/event-stream', ...opts.headers })
        if (runId) headers.set('Last-Event-ID', String(lastSeq))
        else headers.set('Content-Type', 'application/json')
        await opts.signer?.sign(headers)

        const signalInit = runOpts?.signal ? { signal: runOpts.signal } : {}
        const init: RequestInit = runId
          ? { method: 'GET', headers, ...signalInit }
          : {
              method: 'POST',
              headers,
              body: JSON.stringify({ input, session: runOpts?.session, skill: runOpts?.skill }),
              ...signalInit,
            }

        let sawTerminal = false
        try {
          for await (const crumb of streamAttempt(url, init)) {
            runId = crumb.runId
            if (crumb.seq !== undefined) lastSeq = crumb.seq
            yield crumb
            if (isTerminalCrumb(crumb)) {
              sawTerminal = true
              break
            }
          }
        } catch (err) {
          if (err instanceof BreadError) throw err
          // A deliberate caller-initiated cancel must propagate immediately,
          // never fall through to the reconnect/retry path below — an
          // aborted fetch throws a plain AbortError (not a BreadError), so
          // without this check it would look just like a dropped connection
          // and get silently retried.
          if (runOpts?.signal?.aborted) {
            throw new BreadError('remote agent run cancelled', 'RUN_CANCELLED', { url: baseUrl, agentId, runId })
          }
          // network/read error mid-stream — treated as an abnormal drop below
        }

        if (sawTerminal) return

        attempt++
        if (attempt > maxRetries) {
          throw new BreadError(
            'Remote agent stream interrupted; reconnect attempts exhausted',
            'REMOTE_AGENT_RECONNECT_FAILED',
            { url: baseUrl, agentId, runId, lastSeq, attempts: attempt - 1 },
          )
        }
        await sleep(delay, runOpts?.signal)
        if (runOpts?.signal?.aborted) {
          throw new BreadError('remote agent run cancelled', 'RUN_CANCELLED', { url: baseUrl, agentId, runId })
        }
        delay *= 2
      }
    },
  }
}
