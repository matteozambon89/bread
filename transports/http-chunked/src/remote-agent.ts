import type { BreadCrumb, BreadSigner, RemoteAgent, RunOptions } from '@breadai/core'
import { BreadError, decodeFrame } from '@breadai/core'

export interface HttpChunkedRemoteAgentOptions {
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

// Signal-aware, like @breadai/core's retry.ts sleep — duplicated rather than
// imported, since this package deliberately has no runtime deps beyond
// @breadai/core (see sse.ts's identical rationale for not importing a sibling
// transport package for a few lines).
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

// RemoteAgent over HTTP (NDJSON chunked) — connects to another bread
// instance's mount()-ed /agents/:id/run and relays its crumb stream. Register
// directly in bread.config.ts:
//   remoteAgents: { researcher: remoteAgent({ url: 'http://remote:3000' }) }
export function remoteAgent(opts: HttpChunkedRemoteAgentOptions): RemoteAgent {
  const doFetch = opts.fetch ?? fetch
  const baseUrl = opts.url.replace(/\/$/, '')
  const maxRetries = opts.maxRetries ?? 5
  const retryDelayMs = opts.retryDelayMs ?? 500

  // One connection attempt: fetch + decode NDJSON lines into crumb frames.
  // A non-ok status or empty body is a definitive rejection (thrown as-is,
  // never retried); anything else that goes wrong (a thrown network/read
  // error, or the stream just ending) is left for the caller to detect via
  // the absence of a terminal frame — that's what makes it a "drop" and not
  // a normal finish.
  async function* streamAttempt(
    url: string,
    init: RequestInit,
  ): AsyncGenerator<{ runId: string; seq: number; crumb: BreadCrumb }> {
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

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue // heartbeat line
          try {
            const frame = decodeFrame(trimmed)
            if (frame.type === 'crumb') yield { runId: frame.runId, seq: frame.seq, crumb: frame.crumb }
          } catch {
            // malformed NDJSON line — skip
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

      // Tell the server explicitly to stop the run — a dropped connection
      // alone no longer cancels anything server-side (see transport.ts's
      // cancelRegistry). Best-effort and fire-and-forget: the local throw
      // below never waits on it. If the signal fires before any runId is
      // known yet, there's nothing to target — a narrow, inherent gap.
      runOpts?.signal?.addEventListener(
        'abort',
        () => {
          if (!runId) return
          void (async () => {
            try {
              const headers = new Headers(opts.headers)
              await opts.signer?.sign(headers)
              await doFetch(`${baseUrl}/runs/${runId}/cancel`, { method: 'POST', headers })
            } catch {
              // best-effort
            }
          })()
        },
        { once: true },
      )

      while (true) {
        const url = runId ? `${baseUrl}/runs/${runId}/stream` : `${baseUrl}/agents/${agentId}/run`
        const headers = new Headers({ Accept: 'application/x-ndjson', ...opts.headers })
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
          for await (const frame of streamAttempt(url, init)) {
            runId = frame.runId
            lastSeq = frame.seq
            yield frame.crumb
            if (isTerminalCrumb(frame.crumb)) {
              sawTerminal = true
              break
            }
          }
        } catch (err) {
          if (err instanceof BreadError && err.code === 'REMOTE_AGENT_ERROR') throw err
          // A deliberate caller-initiated cancel must propagate immediately,
          // never fall through to the reconnect/retry path below — an
          // aborted fetch throws too, and without this check it would look
          // just like a dropped connection and get silently retried.
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
